import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';
import { detectAntigravityPath } from './validator';

export interface ProxyConfig {
    host: string;
    port: number;
    type: string;
    timeout: number;
    antigravityAppPath: string;
    autoStart: boolean;
    /** 已装免密 helper 时，激活后若 hosts/中继未就绪则自动执行「准备特权环境」 */
    autoPrepareHostsRelay: boolean;
    /** 是否在右下角状态栏显示 AG-Proxy 状态指示 */
    showStatusBar: boolean;
    /** 额度充沛，处于就绪状态时，调用ai 刷新额度 */
    refreshQuotaWhenReady: boolean;
    /** 自动刷新额度周期的开始时间（小时，0-23） */
    refreshStartTime: number;
    /** 自动刷新额度周期的结束时间（小时，1-24） */
    refreshEndTime: number;
}

const CONFIG_SECTION = 'antigravity-proxy';

/**
 * WebView postMessage 在部分环境下会把 number 序列成 string，合并为严格类型，避免写入或校验异常。
 */
export function normalizeProxyConfigFromUI(raw: unknown): ProxyConfig {
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const portNum = Math.trunc(Number(o.port));
    const timeoutNum = Math.trunc(Number(o.timeout));
    return {
        host: String(o.host ?? '').trim(),
        port: Number.isFinite(portNum) ? portNum : 0,
        type: o.type === 'http' ? 'http' : 'socks5',
        timeout: Number.isFinite(timeoutNum) && timeoutNum >= 1000 ? timeoutNum : 5000,
        antigravityAppPath: String(o.antigravityAppPath ?? '').trim(),
        autoStart: o.autoStart === true,
        autoPrepareHostsRelay: o.autoPrepareHostsRelay !== false,
        showStatusBar: o.showStatusBar !== false,
        refreshQuotaWhenReady: o.refreshQuotaWhenReady === true,
        refreshStartTime: Math.trunc(Number(o.refreshStartTime ?? 5)),
        refreshEndTime: Math.trunc(Number(o.refreshEndTime ?? 24)),
    };
}

/**
 * 从 VS Code settings 读取完整配置
 */
export function getConfig(): ProxyConfig {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);

    let appPath = cfg.get<string>('antigravityAppPath', '');
    if (!appPath) {
        appPath = detectAntigravityPath() || '';
    }

    return {
        host: cfg.get<string>('proxyHost', '127.0.0.1'),
        port: cfg.get<number>('proxyPort', 10808),
        type: cfg.get<string>('proxyType', 'socks5'),
        timeout: cfg.get<number>('timeout', 5000),
        antigravityAppPath: appPath,
        autoStart: cfg.get<boolean>('autoStart', false),
        autoPrepareHostsRelay: cfg.get<boolean>('autoPrepareHostsRelay', true),
        showStatusBar: cfg.get<boolean>('showStatusBar', true),
        refreshQuotaWhenReady: cfg.get<boolean>('refreshQuotaWhenReady', true),
        refreshStartTime: cfg.get<number>('refreshStartTime', 5),
        refreshEndTime: cfg.get<number>('refreshEndTime', 24),
    };
}

/**
 * 将若干键写入用户 / 工作区 / 各文件夹，避免 .vscode/settings.json 覆盖 Global 导致「保存不生效」
 */
async function applySettingsToAllScopes(entries: Array<[string, unknown]>): Promise<void> {
    const applyAt = async (target: vscode.ConfigurationTarget) => {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        for (const [key, value] of entries) {
            try {
                await cfg.update(key, value, target);
            } catch (e: any) {
                log(`写入 ${key} @${target} 失败: ${e?.message || e}`);
            }
        }
    };

    await applyAt(vscode.ConfigurationTarget.Global);

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
        await applyAt(vscode.ConfigurationTarget.Workspace);
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const scoped = vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri);
        for (const [key, value] of entries) {
            try {
                await scoped.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
            } catch (e: any) {
                log(`写入 ${key} @文件夹「${folder.name}」失败: ${e?.message || e}`);
            }
        }
    }
}

/**
 * 将配置写回 VS Code settings
 */
export async function updateConfig(config: Partial<ProxyConfig>): Promise<void> {
    if (config.host !== undefined || config.port !== undefined || config.type !== undefined || config.timeout !== undefined) {
        const cur = getConfig();
        const host = (config.host !== undefined ? config.host : cur.host).trim();
        const portRaw = config.port !== undefined ? config.port : cur.port;
        const port = Math.trunc(Number(portRaw));
        const type = config.type !== undefined ? config.type : cur.type;
        const timeoutRaw = config.timeout !== undefined ? config.timeout : cur.timeout;
        const timeout = Math.trunc(Number(timeoutRaw));
        await applySettingsToAllScopes([
            ['proxyHost', host],
            ['proxyPort', Number.isFinite(port) ? port : cur.port],
            ['proxyType', type === 'http' ? 'http' : 'socks5'],
            ['timeout', Number.isFinite(timeout) && timeout >= 1000 ? timeout : cur.timeout],
        ]);
    }

    if (config.antigravityAppPath !== undefined) {
        await applySettingsToAllScopes([['antigravityAppPath', config.antigravityAppPath]]);
    }
    if (config.autoStart !== undefined || config.autoPrepareHostsRelay !== undefined) {
        const cur = getConfig();
        await applyAutoLaunchToAllScopes(
            config.autoStart !== undefined ? config.autoStart : cur.autoStart,
            config.autoPrepareHostsRelay !== undefined ? config.autoPrepareHostsRelay : cur.autoPrepareHostsRelay
        );
    }
    if (config.showStatusBar !== undefined) {
        await applySettingsToAllScopes([['showStatusBar', config.showStatusBar]]);
    }
    if (config.refreshQuotaWhenReady !== undefined) {
        await applySettingsToAllScopes([['refreshQuotaWhenReady', config.refreshQuotaWhenReady]]);
    }
    if (config.refreshStartTime !== undefined) {
        await applySettingsToAllScopes([['refreshStartTime', config.refreshStartTime]]);
    }
    if (config.refreshEndTime !== undefined) {
        await applySettingsToAllScopes([['refreshEndTime', config.refreshEndTime]]);
    }

    log('配置已更新到用户 / 工作区 / 各文件夹作用域');
}

/**
 * 将「自动启动 / 自动准备 hosts」同步到用户、工作区、各文件夹（避免仅写 Global 时被 .vscode/settings.json 覆盖）
 */
export async function applyAutoLaunchToAllScopes(
    autoStart: boolean,
    autoPrepareHostsRelay: boolean
): Promise<void> {
    const applyPairAt = async (target: vscode.ConfigurationTarget) => {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        try {
            await cfg.update('autoStart', autoStart, target);
            await cfg.update('autoPrepareHostsRelay', autoPrepareHostsRelay, target);
        } catch (e: any) {
            log(`applyAutoLaunch: 作用域 ${target} 写入失败: ${e?.message || e}`);
        }
    };

    await applyPairAt(vscode.ConfigurationTarget.Global);

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
        await applyPairAt(vscode.ConfigurationTarget.Workspace);
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            const scoped = vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri);
            await scoped.update('autoStart', autoStart, vscode.ConfigurationTarget.WorkspaceFolder);
            await scoped.update('autoPrepareHostsRelay', autoPrepareHostsRelay, vscode.ConfigurationTarget.WorkspaceFolder);
        } catch (e: any) {
            log(`applyAutoLaunch: 文件夹「${folder.name}」写入失败: ${e?.message || e}`);
        }
    }

    log(
        `已在各作用域同步自动启动/自动准备: autoStart=${autoStart}, autoPrepareHostsRelay=${autoPrepareHostsRelay}`
    );
}

/** 恢复原生时关闭自动拉起代理链 */
export async function disableAutoLaunchInAllConfigScopes(): Promise<void> {
    await applyAutoLaunchToAllScopes(false, false);
}

/**
 * 根据当前配置生成 config.yaml 文件
 */
export function syncConfigYaml(config: ProxyConfig): string {
    const content = `# Antigravity-Proxy Configuration (auto-generated by extension)
proxy:
  host: "${config.host}"
  port: ${config.port}
  type: "${config.type}"
  timeout: ${config.timeout}
  child_injection: true

# FakeIP range
dns:
  fakeip_range: "198.18.0.0/16"
`;

    // 固定路径保证每次启动 Antigravity 读取同一份配置，不因时间戳变化而失效
    const yamlPath = path.join(os.tmpdir(), 'antigravity-config.yaml');

    try {
        fs.writeFileSync(yamlPath, content, 'utf-8');
        log(`config.yaml 已同步到 ${yamlPath}`);
    } catch (e: any) {
        const msg = `写入 config.yaml 失败（${yamlPath}）: ${e?.message || e}`;
        log(`❌ ${msg}`);
        throw new Error(msg);
    }
    return yamlPath;
}

/**
 * 检查配置是否完整可用
 */
export function isConfigComplete(config: ProxyConfig): boolean {
    // 现在不再强制要求 projectPath，因为有内置二进制
    return !!(config.host && config.port);
}
