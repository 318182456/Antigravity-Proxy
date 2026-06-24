import * as vscode from 'vscode';
import {
    initProxyManager,
    initGlobalState,
    isProxyManuallyDisabled,
    start,
    stop,
    recoverStatus,
    stopStatusPoller,
    preparePrivilegedEnvironment,
    cleanupPrivilegedEnvironment,
    syncIndicatorToProcessState,
    restoreStockBehavior,
} from './proxyManager';
import { createRuntimeIndicator, setRuntimeIndicator } from './statusIndicator';
import { getConfig, isConfigComplete } from './configManager';
import { openConfigWebview } from './configWebview';
import { openDiagnosticsPanel } from './diagnosticsPanel';
import { showLog, log, dispose as disposeLogger } from './logger';
import { validateProxyConnection, validateSocks5Handshake } from './validator';
import { needsPrepareEnvironmentSetup } from './diagnostics';

/** 完全停用扩展对网络与 Antigravity 的改动（恢复 hosts 并停止中继） */
async function runRestoreNoProxyFlow(
    runAfterConfirm: (fn: () => void | Promise<void>, onErr?: (e: unknown) => void) => void
): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
        [
            '将完全停用本扩展的代理能力：退出 Antigravity，清理 hosts 记录并停止内置中继服务。',
            '',
            '完成后建议：',
            '· 避免在已带代理环境变量（如 HTTP_PROXY 等）的命令终端中启动应用。',
            '· 若自行开启过 Windows 系统代理，请在系统设置中手动关闭。',
            '· 若网络仍解析异常，请在命令提示符/PowerShell 中执行 ipconfig /flushdns 刷新缓存。',
        ].join('\n'),
        { modal: true },
        '确定'
    );
    if (pick !== '确定') {
        return;
    }
    runAfterConfirm(
        () => restoreStockBehavior(),
        e => log(`恢复默认异常: ${e instanceof Error ? e.message : String(e)}`)
    );
}

/** 状态栏点按会在宿主同步路径上执行命令；推迟到下一轮事件循环再创建终端/Webview，降低崩溃概率 */
function runAfterUiYield(run: () => void | Promise<void>, onError?: (e: unknown) => void): void {
    setTimeout(() => {
        void Promise.resolve(run()).catch(e => {
            if (onError) {
                onError(e);
            } else {
                log(`命令异常: ${e instanceof Error ? e.message : String(e)}`);
            }
        });
    }, 0);
}

export function activate(context: vscode.ExtensionContext) {
    initProxyManager(context.extensionPath);
    initGlobalState(context.globalState);
    log('Antigravity Proxy 扩展已激活');

    context.subscriptions.push(createRuntimeIndicator(context));

    const config = getConfig();

    async function runUpstreamTest(): Promise<void> {
        const cfg = getConfig();
        if (!isConfigComplete(cfg)) {
            vscode.window.showWarningMessage('请先配置代理主机与端口');
            return;
        }
        const timeout = Math.min(Math.max(cfg.timeout || 5000, 1000), 30000);
        showLog();
        log('🔍 正在检测上游代理…');
        const tcp = await validateProxyConnection(cfg.host, cfg.port, timeout);
        if (!tcp.valid) {
            vscode.window.showErrorMessage(tcp.message.replace(/^❌\s*/, ''));
            return;
        }
        if (cfg.type === 'socks5') {
            const s = await validateSocks5Handshake(cfg.host, cfg.port, timeout);
            const text = s.message.replace(/^[✅❌]\s*/, '');
            if (s.valid) {
                vscode.window.showInformationMessage(text);
            } else {
                vscode.window.showErrorMessage(text);
            }
        } else {
            vscode.window.showInformationMessage(
                `${tcp.message.replace(/^[✅❌]\s*/, '')}（HTTP 类型：中继仍按 SOCKS5 连接该端口，请确认上游协议）`
            );
        }
    }

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-proxy.start', () => {
            runAfterUiYield(
                () => start(),
                e => {
                    const msg = e instanceof Error ? e.message : String(e);
                    log(`启动异常: ${msg}`);
                    void vscode.window.showErrorMessage(`启动异常: ${msg}`);
                }
            );
        }),
        vscode.commands.registerCommand('antigravity-proxy.stop', () => {
            runAfterUiYield(
                () => stop(),
                e => {
                    const msg = e instanceof Error ? e.message : String(e);
                    log(`停止异常: ${msg}`);
                    void vscode.window.showErrorMessage(`停止代理失败: ${msg}`);
                }
            );
        }),
        vscode.commands.registerCommand('antigravity-proxy.showLog', () => showLog()),
        vscode.commands.registerCommand('antigravity-proxy.openSettings', () => {
            runAfterUiYield(() => openConfigWebview(context));
        }),
        vscode.commands.registerCommand('antigravity-proxy.openDiagnostics', () => {
            runAfterUiYield(() => openDiagnosticsPanel(context));
        }),
        vscode.commands.registerCommand('antigravity-proxy.testUpstreamProxy', () => runUpstreamTest()),
        vscode.commands.registerCommand('antigravity-proxy.prepareEnvironment', () => {
            runAfterUiYield(() => preparePrivilegedEnvironment());
        }),
        vscode.commands.registerCommand('antigravity-proxy.cleanupEnvironment', async () => {
            const pick = await vscode.window.showWarningMessage(
                '将移除扩展写入的 hosts 行并停止 SNI 中继，不退出 Antigravity。',
                { modal: true },
                '确定'
            );
            if (pick !== '确定') {
                return;
            }
            try {
                await cleanupPrivilegedEnvironment();
                vscode.window.showInformationMessage('已清理 hosts 与中继');
            } catch {
                vscode.window.showErrorMessage('清理失败，请查看输出日志');
            }
        }),
        vscode.commands.registerCommand('antigravity-proxy.restoreNoProxy', () =>
            void runRestoreNoProxyFlow(runAfterUiYield)
        )
    );

    // 监听配置变更
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-proxy')) {
                const newConfig = getConfig();
                if (isConfigComplete(newConfig)) {
                    log('配置已变更');
                    void syncIndicatorToProcessState();
                } else {
                    setRuntimeIndicator('bad');
                }
            }
        })
    );

    if (!isConfigComplete(config)) {
        setRuntimeIndicator('bad');
    } else if (config.autoStart) {
        log('自动启动已开启，正在启动代理...');
        void syncIndicatorToProcessState();
        void start().catch(e => {
            const msg = e instanceof Error ? e.message : String(e);
            log(`自动启动失败: ${msg}`);
            void vscode.window.showErrorMessage(`自动启动失败: ${msg}`);
        });
    } else {
        void recoverStatus();
    }

    /** 激活后自动执行环境准备（可关：antigravity-proxy.autoPrepareHostsRelay） */
    if (config.autoPrepareHostsRelay && isConfigComplete(config) && !config.autoStart) {
        if (isProxyManuallyDisabled()) {
            log('检测到「完全停用代理」全局标志已置位，跳过自动准备 hosts/中继（如需重新启用，请点「重新启动」或「一键启动」）');
        } else {
            let cancelled = false;
            const timer = setTimeout(() => {
                if (cancelled) { return; }
                void (async () => {
                    try {
                        if (!(await needsPrepareEnvironmentSetup())) {
                            return;
                        }
                        log('自动准备 hosts/中继：检测到未就绪，正在静默/提权执行环境准备…');
                        await preparePrivilegedEnvironment(getConfig());
                    } catch (e) {
                        log(`自动准备环境未执行: ${e instanceof Error ? e.message : String(e)}`);
                    }
                })();
            }, 2000);
            context.subscriptions.push({ dispose: () => { cancelled = true; clearTimeout(timer); } });
        }
    }
}

export function deactivate() {
    log('Antigravity Proxy 扩展已停用');
    stopStatusPoller();
    disposeLogger();
}
