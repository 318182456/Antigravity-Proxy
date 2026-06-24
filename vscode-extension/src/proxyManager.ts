import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import {
    getConfig,
    syncConfigYaml,
    isConfigComplete,
    ProxyConfig,
    disableAutoLaunchInAllConfigScopes,
} from './configManager';
import { log, logError, logSuccess, showLog } from './logger';
import { validateAntigravityPath, detectAntigravityPath } from './validator';
import { RELAY_DOMAINS, HOSTS_MARKER } from './relayDomains';
import { RELAY_EXECUTABLE, RELAY_LOG_PATH, RELAY_PID_PATH } from './runtimeConstants';
import { setRuntimeIndicator } from './statusIndicator';
import { isProxyFullyHealthy } from './diagnostics';
import { nodeRelayInstance } from './nodeRelay';

let statusInterval: NodeJS.Timeout | undefined;
let extensionPathOverride: string | undefined;
let startBusy = false;
let statusPollInFlight = false;
/** 一键启动后若在暖机期内未通过全量检测，保持黄色而非立刻红色 */
let warmUpUntilMs = 0;

/** ExtensionContext.globalState 存储键：用户主动执行「完全停用代理」后置 true，阻止 auto-prepare 跨工作区重建 hosts/relay */
export const GLOBAL_STATE_PROXY_DISABLED = 'proxyManuallyDisabled';
let _globalState: vscode.Memento | undefined;

export function initGlobalState(state: vscode.Memento): void {
    _globalState = state;
}

export function isProxyManuallyDisabled(): boolean {
    return _globalState?.get<boolean>(GLOBAL_STATE_PROXY_DISABLED, false) ?? false;
}

export async function setProxyManuallyDisabled(disabled: boolean): Promise<void> {
    if (_globalState) {
        await _globalState.update(GLOBAL_STATE_PROXY_DISABLED, disabled);
        log(`proxyManuallyDisabled 全局状态已设为: ${disabled}`);
    }
}

type RestoreStockListener = () => void;
const restoreStockListeners: RestoreStockListener[] = [];

/** 注册一个在 restoreStockBehavior 完成时触发的回调 */
export function onRestoreStockDone(listener: RestoreStockListener): { dispose(): void } {
    restoreStockListeners.push(listener);
    return {
        dispose() {
            const idx = restoreStockListeners.indexOf(listener);
            if (idx >= 0) { restoreStockListeners.splice(idx, 1); }
        },
    };
}

function getWinHostsPath(): string {
    return path.join(process.env.windir || 'C:\\Windows', 'System32\\drivers\\etc\\hosts');
}

/**
 * Windows 平台下写入 hosts 并刷新 DNS 的提权操作 (优化为单次整块写入，避开火绒/Defender高频拦截)
 */
function win32WriteHosts(domains: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const hostsPath = getWinHostsPath();
        const marker = '# antigravity-proxy';
        
        const scriptLines = [
            `$hostsPath = "${hostsPath}"`,
            `$marker = "${marker}"`,
            `$domains = @(${domains.map(d => `"${d}"`).join(', ')})`,
            `$content = Get-Content $hostsPath -Raw -ErrorAction SilentlyContinue`,
            `$newLines = @()`,
            `if ($content) {`,
            `    $newLines += $content -split "\`r?\`n" | Where-Object { $_ -notlike "*$marker" }`,
            `}`,
            `foreach ($domain in $domains) {`,
            `    $newLines += "127.0.0.2 $domain $marker"`,
            `}`,
            `$newLines -join "\`r\`n" | Out-File $hostsPath -Encoding utf8 -Force`,
            `ipconfig /flushdns`
        ];
        
        const ps1Path = path.join(os.tmpdir(), `antigravity-hosts-write-${Date.now()}.ps1`);
        try {
            fs.writeFileSync(ps1Path, scriptLines.join('\r\n'), 'utf-8');
        } catch (e: any) {
            return reject(new Error(`写入临时 PowerShell 脚本失败: ${e.message}`));
        }

        log(`[Windows] 正在通过 UAC 弹窗提权执行 hosts 写入脚本...`);
        const cmd = `powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${ps1Path}\\"' -Verb RunAs -Wait -WindowStyle Hidden"`;
        
        cp.exec(cmd, (err, stdout, stderr) => {
            try { fs.unlinkSync(ps1Path); } catch {}
            if (err) {
                logError(`[Windows] 提权写入 hosts 失败: ${stderr || err.message}`);
                reject(err);
            } else {
                logSuccess(`[Windows] 提权写入 hosts 成功，DNS 缓存已刷新`);
                resolve();
            }
        });
    });
}

/**
 * Windows 平台下清理 hosts 并刷新 DNS 的提权操作
 */
function win32CleanupHosts(): Promise<void> {
    return new Promise((resolve, reject) => {
        const hostsPath = getWinHostsPath();
        const marker = '# antigravity-proxy';
        
        const scriptLines = [
            `$hostsPath = "${hostsPath}"`,
            `$marker = "${marker}"`,
            `$content = Get-Content $hostsPath -Raw -ErrorAction SilentlyContinue`,
            `if ($content) {`,
            `    $lines = $content -split "\`r?\`n" | Where-Object { $_ -notlike "*$marker" }`,
            `    $lines -join "\`r\`n" | Out-File $hostsPath -Encoding utf8 -Force`,
            `}`,
            `ipconfig /flushdns`
        ];
        
        const ps1Path = path.join(os.tmpdir(), `antigravity-hosts-clean-${Date.now()}.ps1`);
        try {
            fs.writeFileSync(ps1Path, scriptLines.join('\r\n'), 'utf-8');
        } catch (e: any) {
            return reject(new Error(`写入临时 PowerShell 脚本失败: ${e.message}`));
        }

        log(`[Windows] 正在通过 UAC 弹窗提权执行 hosts 清理脚本...`);
        const cmd = `powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${ps1Path}\\"' -Verb RunAs -Wait -WindowStyle Hidden"`;
        
        cp.exec(cmd, (err, stdout, stderr) => {
            try { fs.unlinkSync(ps1Path); } catch {}
            if (err) {
                logError(`[Windows] 提权清理 hosts 失败: ${stderr || err.message}`);
                reject(err);
            } else {
                logSuccess(`[Windows] 提权清理 hosts 成功，DNS 缓存已刷新`);
                resolve();
            }
        });
    });
}

export function initProxyManager(extensionPath: string): void {
    extensionPathOverride = extensionPath;
}

function getExtensionRoot(): string {
    return extensionPathOverride || '';
}

function runShell(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(cmd, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || err.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

async function checkActualStatus(): Promise<boolean> {
    const config = getConfig();
    if (!isConfigComplete(config)) {
        return false;
    }
    return isProxyFullyHealthy(getExtensionRoot(), config);
}

function applyHealthProbeResult(ok: boolean): void {
    isProxyRunning = ok;
    if (ok) {
        warmUpUntilMs = 0;
        setRuntimeIndicator('ok');
    } else if (Date.now() < warmUpUntilMs) {
        setRuntimeIndicator('starting');
    } else {
        setRuntimeIndicator('bad');
    }
}

export function stopStatusPoller() {
    if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = undefined;
    }
}

export function startStatusPoller() {
    stopStatusPoller();
    statusInterval = setInterval(async () => {
        if (!isConfigComplete(getConfig())) {
            warmUpUntilMs = 0;
            setRuntimeIndicator('bad');
            return;
        }
        if (statusPollInFlight) {
            return;
        }
        statusPollInFlight = true;
        try {
            const actualRunning = await checkActualStatus();
            const prev = isProxyRunning;
            if (prev !== actualRunning && !actualRunning) {
                log('检测到代理链未完全就绪或已中断，内部运行标记已重置');
            }
            applyHealthProbeResult(actualRunning);
        } finally {
            statusPollInFlight = false;
        }
    }, 5000);
}

export async function syncIndicatorToProcessState(): Promise<void> {
    if (!isConfigComplete(getConfig())) {
        warmUpUntilMs = 0;
        setRuntimeIndicator('bad');
        return;
    }
    const ok = await checkActualStatus();
    applyHealthProbeResult(ok);
}

export let isProxyRunning = false;

/**
 * 启动代理流程 (Windows 专享)
 */
export async function start(): Promise<void> {
    const config = getConfig();

    if (!isConfigComplete(config)) {
        setRuntimeIndicator('bad');
        vscode.window.showWarningMessage('请先完成配置', '打开配置').then(choice => {
            if (choice === '打开配置') {
                vscode.commands.executeCommand('antigravity-proxy.openSettings');
            }
        });
        return;
    }

    if (startBusy) {
        return;
    }

    startBusy = true;
    setRuntimeIndicator('starting');
    log('启动流程已开始（日志仅追加到输出通道，不自动弹出）');

    try {
        log('🔑 [Windows] 正在准备 hosts 环境与内置 SNI 中继 (端口 443)...');
        // 1. 提权写入 hosts
        await win32WriteHosts(RELAY_DOMAINS);
        
        // 2. 启动内置 Node.js 中继
        log('[Windows] 正在启动内置 Node.js 中继服务...');
        await nodeRelayInstance.start(443, config.host, config.port, config.type, config.timeout);
        
        // 3. 启动 Antigravity.exe
        log('[Windows] 正在启动 Antigravity.exe (带代理参数)...');
        const envProxyVal = `${config.type}://${config.host}:${config.port}`;
        
        const child = cp.spawn(config.antigravityAppPath, [`--proxy-server=${envProxyVal}`], {
            detached: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                HTTP_PROXY: envProxyVal,
                HTTPS_PROXY: envProxyVal,
                ALL_PROXY: envProxyVal
            }
        });
        child.unref();
        
        logSuccess('[Windows] 启动指令已成功发送，内置中继与主进程已就绪');
        isProxyRunning = true;
        warmUpUntilMs = Date.now() + 10000;
        startStatusPoller();
        setRuntimeIndicator('ok');
    } catch (e: any) {
        logError(`[Windows] 启动失败: ${e.message}`);
        void vscode.window.showErrorMessage(`启动失败: ${e.message}`);
        setRuntimeIndicator('bad');
        isProxyRunning = false;
        warmUpUntilMs = 0;
    } finally {
        startBusy = false;
    }
}

/**
 * 仅清理 hosts + SNI 中继
 */
export async function cleanupPrivilegedEnvironment(): Promise<void> {
    log('🧹 清理 hosts / 中继...');
    try {
        await nodeRelayInstance.stop();
        await win32CleanupHosts();
        logSuccess('特权环境已清理（hosts + relay）');
    } catch (err: any) {
        logError(`清理特权环境失败: ${err.message}`);
        throw err;
    }
}

/**
 * 手动执行：写入 hosts、刷新 DNS、启动 SNI 中继
 */
export async function preparePrivilegedEnvironment(configOverride?: ProxyConfig): Promise<void> {
    const config = configOverride ?? getConfig();
    if (!isConfigComplete(config)) {
        vscode.window.showWarningMessage('请先完成代理配置', '打开配置').then(c => {
            if (c === '打开配置') {
                vscode.commands.executeCommand('antigravity-proxy.openSettings');
            }
        });
        return;
    }

    try {
        log('[Windows] 正在准备特权环境：写入 hosts 并启动内置中继...');
        await win32WriteHosts(RELAY_DOMAINS);
        await nodeRelayInstance.start(443, config.host, config.port, config.type, config.timeout);
        logSuccess('Windows 代理特权环境准备完成');
    } catch (err: any) {
        logError(`准备环境失败: ${err.message}`);
        vscode.window.showErrorMessage(`准备环境失败: ${err.message}`);
    }
}

/**
 * 停止代理
 */
export async function stop(): Promise<void> {
    log('⏹ 正在停止代理...');
    try {
        warmUpUntilMs = 0;
        log('[Windows] 正在结束 Antigravity 进程...');
        const config = getConfig();
        const exeName = path.basename(config.antigravityAppPath) || 'Antigravity.exe';
        await runShell(`taskkill /F /IM "${exeName}"`).catch(() => {});
        await cleanupPrivilegedEnvironment();
        isProxyRunning = false;
        stopStatusPoller();
        setRuntimeIndicator('bad');
        logSuccess('代理已停止');
    } catch (err: any) {
        logError(`停止失败: ${err.message}`);
    }
}

/**
 * 完全停用代理
 */
export async function restoreStockBehavior(): Promise<void> {
    log('🔄 正在关闭代理并恢复默认启动方式…');
    warmUpUntilMs = 0;

    await setProxyManuallyDisabled(true);
    try {
        await disableAutoLaunchInAllConfigScopes();
    } catch (e: any) {
        logError(`写入设置失败（自动启动/自动准备）: ${e?.message || e}`);
    }
    log('[Windows] 正在结束 Antigravity 进程...');
    const cfg = getConfig();
    const exeName = path.basename(cfg.antigravityAppPath) || 'Antigravity.exe';
    await runShell(`taskkill /F /IM "${exeName}"`).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
        await cleanupPrivilegedEnvironment();
    } catch (err: any) {
        logError(`清理环境时出错: ${err.message}`);
    }
    isProxyRunning = false;
    stopStatusPoller();
    setRuntimeIndicator('bad');
    
    void vscode.window.showInformationMessage('完全停用已完成：hosts 已清，本地中继已停止。');
    
    for (const fn of restoreStockListeners) {
        try { fn(); } catch {}
    }
}

/**
 * 恢复运行状态（用于扩展激活时）
 */
export async function recoverStatus(): Promise<void> {
    if (!isConfigComplete(getConfig())) {
        warmUpUntilMs = 0;
        setRuntimeIndicator('bad');
        return;
    }
    startStatusPoller();
    const running = await checkActualStatus();
    if (running) {
        log('正在恢复运行状态（全项检测已通过）…');
    }
    applyHealthProbeResult(running);
}
