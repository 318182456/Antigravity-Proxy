import * as fs from 'fs';
import * as cp from 'child_process';
import * as path from 'path';
import { ProxyConfig } from './configManager';
import {
    validateHost,
    validatePort,
    validateProxyConnection,
    validateSocks5Handshake,
    validateAntigravityPath,
    detectAntigravityPath,
} from './validator';
import { RELAY_DOMAINS, HOSTS_MARKER } from './relayDomains';
import { RELAY_EXECUTABLE, RELAY_LOG_PATH, RELAY_PID_PATH } from './runtimeConstants';
import { nodeRelayInstance } from './nodeRelay';

export interface DiagnosticItem {
    key: string;
    title: string;
    ok: boolean;
    detail: string;
    hint?: string;
}

function execShort(cmd: string, timeout = 8000): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(cmd, { timeout }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || err.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

async function checkRelayProcess(): Promise<{ ok: boolean; detail: string }> {
    if (process.platform === 'win32') {
        if (nodeRelayInstance.isRunning()) {
            return { ok: true, detail: `内置 Node.js SNI 中继运行中，监听在 127.0.0.2:443` };
        }
        return { ok: false, detail: '内置 Node.js SNI 中继未启动，请点击「重新启动」或「启动代理」' };
    }

    if (!fs.existsSync(RELAY_PID_PATH)) {
        return { ok: false, detail: `未找到 ${RELAY_PID_PATH}（中继可能未启动）` };
    }
    const pid = fs.readFileSync(RELAY_PID_PATH, 'utf-8').trim();
    if (!pid) {
        return { ok: false, detail: 'PID 文件为空' };
    }
    // 严格校验 PID 为纯数字，防止文件内容被篡改时命令注入
    if (!/^\d+$/.test(pid)) {
        return { ok: false, detail: `PID 文件内容非法（${pid}），请点击「重新启动」` };
    }
    try {
        await execShort(`ps -p ${pid} -o pid=`);
        return { ok: true, detail: `SNI 中继进程存活 (PID ${pid})，日志: ${RELAY_LOG_PATH}` };
    } catch {
        return { ok: false, detail: `PID ${pid} 已不存在，请点击「重新启动」` };
    }
}

function readHostsStatus(): { ok: boolean; detail: string; missing: string[] } {
    const isWin = process.platform === 'win32';
    const hostsPath = isWin
        ? path.join(process.env.windir || 'C:\\Windows', 'System32\\drivers\\etc\\hosts')
        : '/etc/hosts';

    let content: string;
    try {
        content = fs.readFileSync(hostsPath, 'utf-8');
    } catch (e: any) {
        return {
            ok: false,
            detail: `无法读取 hosts 文件 (${hostsPath}): ${e.message}`,
            missing: [...RELAY_DOMAINS],
        };
    }
    const lines = content.split('\n');
    const lineOk = (domain: string) =>
        lines.some(line => {
            const t = line.trim();
            return t.includes('127.0.0.2') && t.includes(domain) && t.includes(HOSTS_MARKER);
        });
    const missing: string[] = [];
    for (const domain of RELAY_DOMAINS) {
        if (!lineOk(domain)) {
            missing.push(domain);
        }
    }
    if (missing.length === 0) {
        return {
            ok: true,
            detail: `已写入 ${RELAY_DOMAINS.length} 个域名 → 127.0.0.2（${HOSTS_MARKER}）`,
            missing: [],
        };
    }
    return {
        ok: false,
        detail: `缺少或未完整写入: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`,
        missing,
    };
}

function resolveAntigravityBundleForDiagnostics(config: ProxyConfig): string {
    const manual = (config.antigravityAppPath && config.antigravityAppPath.trim()) || '';
    if (manual && fs.existsSync(manual)) {
        return manual;
    }
    return detectAntigravityPath() || '';
}

/** Antigravity 注入相关的 LSEnvironment 键；只要有其中之一存在就判为异常 */
const ANTIGRAVITY_LSENVIRONMENT_KEYS = [
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'ALL_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ANTIGRAVITY_CONFIG',
    'NO_PROXY',
    'FTP_PROXY',
];

/** 检查主包 Info.plist 是否仍带 Antigravity 相关 LSEnvironment（Makefile 会写入 DYLD / HTTP_PROXY 等；残留则访达启动仍会注入） */
function readLSEnvironmentStatus(appPath: string): DiagnosticItem {
    const title = 'Info.plist · LSEnvironment';
    if (process.platform === 'win32') {
        return {
            key: 'lsenvironment',
            title,
            ok: true,
            detail: 'Windows 系统无需 Info.plist 注入检查',
        };
    }
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) {
        return {
            key: 'lsenvironment',
            title,
            ok: true,
            detail: '未找到 Info.plist，跳过检查',
        };
    }
    const r = cp.spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSEnvironment', plist], {
        encoding: 'utf-8',
    });
    const err = (r.stderr || '').trim();
    if (r.status !== 0 || err.includes('Does Not Exist')) {
        return {
            key: 'lsenvironment',
            title,
            ok: true,
            detail: '未设置 LSEnvironment（从访达启动时不应再带本扩展的 DYLD/代理变量）',
            hint: '若应用仍走 SOCKS/HTTP 上游，请确认是否从终端带 HTTP_PROXY 启动、或存在另一份 Antigravity.app 副本',
        };
    }
    const body = (r.stdout || '').trim();
    if (/^Dict\s*\{\s*\}\s*$/s.test(body)) {
        return {
            key: 'lsenvironment',
            title,
            ok: true,
            detail: 'LSEnvironment 为空字典',
        };
    }
    // 只有当 dict 中包含 Antigravity 注入相关键时才报错；
    // MallocNanoZone 等系统/第三方键不影响代理行为，不应触发警告。
    const hasAntigravityKey = ANTIGRAVITY_LSENVIRONMENT_KEYS.some(k =>
        new RegExp(`\\b${k}\\s*=`).test(body)
    );
    if (!hasAntigravityKey) {
        return {
            key: 'lsenvironment',
            title,
            ok: true,
            detail: `LSEnvironment 存在但不含代理注入键（当前内容：${body.length > 200 ? `${body.slice(0, 200)}…` : body}）`,
            hint: '访达启动时不会带本扩展的 DYLD/代理变量',
        };
    }
    return {
        key: 'lsenvironment',
        title,
        ok: false,
        detail: body.length > 520 ? `${body.slice(0, 520)}…` : body,
        hint: '请执行「恢复原生启动」或命令 antigravity-proxy.restoreStock；升级扩展后请重装免密 helper 再执行 strip',
    };
}

function bundledBin(extensionRoot: string, name: string): { ok: boolean; path: string } {
    const p = path.join(extensionRoot, 'bin', name);
    return { ok: fs.existsSync(p), path: p };
}

/**
 * 检测 macOS 系统代理设置（scutil --proxy）。
 * 若系统代理已启用且指向本地地址，用户在停用 Clash/V2Ray 后会导致全机断网，
 * 这与本扩展的 hosts/relay 无关，但是常见的用户困惑点。
 */
async function checkSystemProxy(): Promise<DiagnosticItem> {
    const title = process.platform === 'win32' ? '系统网络代理（Windows 全局）' : '系统网络代理（macOS 全局）';
    
    if (process.platform === 'win32') {
        try {
            const enableOut = await execShort(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
                3000
            ).catch(() => '');
            const enabled = enableOut.includes('0x1');

            if (!enabled) {
                return {
                    key: 'system_proxy',
                    title,
                    ok: true,
                    detail: '系统代理未启用，全机流量走直连（不受本扩展 hosts/中继影响）',
                };
            }

            const serverOut = await execShort(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
                3000
            ).catch(() => '');
            const match = serverOut.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
            const proxyServer = match ? match[1] : '未知';

            const isLocal = /^(127\.|localhost|0\.0\.0\.0)/i.test(proxyServer);
            return {
                key: 'system_proxy',
                title,
                ok: true, // 本地代理为开发环境标准配置，不报红
                detail: `系统代理已启用：${proxyServer}`,
                hint: isLocal
                    ? '代理指向系统本机地址（本地代理客户端工作正常）。若 Clash / V2Ray 等本地代理客户端未运行，全机网络将无法连接。'
                    : '系统代理指向外部地址，一般无需本扩展干预。',
            };
        } catch (e: any) {
            return {
                key: 'system_proxy',
                title,
                ok: true,
                detail: `无法读取系统代理设置（Windows 注册表查询失败）: ${e?.message ?? e}`,
            };
        }
    }

    try {
        const out = await execShort('scutil --proxy', 5000);
        const enabled: string[] = [];
        const LOCAL_RE = /^(127\.|localhost|0\.0\.0\.0)/i;

        const httpEnabled  = /HTTPEnable\s*:\s*1/.test(out);
        const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(out);
        const socksEnabled = /SOCKSEnable\s*:\s*1/.test(out);

        const httpProxy  = (out.match(/HTTPProxy\s*:\s*(\S+)/)  || [])[1] ?? '';
        const httpsProxy = (out.match(/HTTPSProxy\s*:\s*(\S+)/) || [])[1] ?? '';
        const socksProxy = (out.match(/SOCKSProxy\s*:\s*(\S+)/) || [])[1] ?? '';

        if (httpEnabled)  { enabled.push(`HTTP → ${httpProxy}`); }
        if (httpsEnabled) { enabled.push(`HTTPS → ${httpsProxy}`); }
        if (socksEnabled) { enabled.push(`SOCKS → ${socksProxy}`); }

        if (enabled.length === 0) {
            return {
                key: 'system_proxy',
                title,
                ok: true,
                detail: '系统代理未启用，全机流量走直连（不受本扩展 hosts/relay 影响）',
            };
        }

        const isLocal = (
            (httpEnabled  && LOCAL_RE.test(httpProxy))  ||
            (httpsEnabled && LOCAL_RE.test(httpsProxy)) ||
            (socksEnabled && LOCAL_RE.test(socksProxy))
        );

        return {
            key: 'system_proxy',
            title,
            ok: true, // 本地代理为开发环境标准配置，不报红
            detail: `系统代理已启用：${enabled.join('，')}`,
            hint: isLocal
                ? '代理指向系统本机地址（本地代理客户端工作正常）。若 Clash / V2Ray 未运行，全机网络将无法连接。'
                : '系统代理指向外部地址，一般无需本扩展干预。',
        };
    } catch (e: any) {
        return {
            key: 'system_proxy',
            title,
            ok: true,
            detail: `无法读取系统代理设置（scutil 不可用）: ${e?.message ?? e}`,
        };
    }
}

/**
 * 收集环境诊断（不修改系统）
 */
export async function collectDiagnostics(extensionRoot: string, config: ProxyConfig): Promise<DiagnosticItem[]> {
    const items: DiagnosticItem[] = [];
    const timeout = Math.min(Math.max(config.timeout || 5000, 1000), 30000);

    const h = validateHost(config.host);
    const p = validatePort(config.port);
    if (!h.valid || !p.valid) {
        items.push({
            key: 'upstream',
            title: '上游代理地址',
            ok: false,
            detail: [h.message, p.message].filter(m => m.includes('❌')).join(' '),
            hint: '在配置页修正代理地址与端口',
        });
    } else {
        const tcp = await validateProxyConnection(config.host, config.port, timeout);
        items.push({
            key: 'upstream_tcp',
            title: '上游代理（TCP 连通）',
            ok: tcp.valid,
            detail: tcp.message,
            hint: tcp.valid ? undefined : '请确认 Clash / V2Ray 等本地代理已开启且端口正确',
        });

        if (config.type === 'socks5') {
            const socks = await validateSocks5Handshake(config.host, config.port, timeout);
            items.push({
                key: 'upstream_socks5',
                title: '上游代理（SOCKS5 握手）',
                ok: socks.valid,
                detail: socks.message,
                hint: socks.valid
                    ? undefined
                    : '中继与注入库目前按 SOCKS5 连接上游；HTTP 类型仅部分生效',
            });
        } else {
            items.push({
                key: 'upstream_http',
                title: '上游代理类型',
                ok: true,
                detail: `当前为 HTTP；SNI 中继 (${RELAY_EXECUTABLE}) 仍按 SOCKS5 连接上述端口`,
                hint: '若连接失败，请将本地混合端口改为 SOCKS5 或在配置中选 socks5',
            });
        }
    }

    const ag = validateAntigravityPath(config.antigravityAppPath);
    items.push({
        key: 'antigravity',
        title: 'Antigravity.app',
        ok: ag.valid,
        detail: ag.message,
        hint: ag.valid ? undefined : '安装 Antigravity 或在配置中指定 .app 路径',
    });

    const agBundle = resolveAntigravityBundleForDiagnostics(config);
    const electron = path.join(agBundle, 'Contents', 'MacOS', 'Electron');
    if (agBundle && fs.existsSync(electron)) {
        items.push(readLSEnvironmentStatus(agBundle));
    }

    const dylib = bundledBin(extensionRoot, 'libantigravity.dylib');
    const relay = bundledBin(extensionRoot, RELAY_EXECUTABLE);
    const isWin = process.platform === 'win32';
    
    items.push({
        key: 'bin_dylib',
        title: '内置 libantigravity.dylib',
        ok: isWin ? true : dylib.ok,
        detail: isWin
            ? 'Windows 平台使用内置 child_injection 机制，无需 macOS dylib 依赖'
            : (dylib.ok ? dylib.path : `缺失: ${dylib.path}`),
        hint: isWin ? undefined : (dylib.ok ? undefined : '请使用完整打包的 VSIX 或从源码编译后放入 extension/bin'),
    });
    
    items.push({
        key: 'bin_relay',
        title: `内置 ${RELAY_EXECUTABLE}`,
        ok: isWin ? true : relay.ok,
        detail: isWin
            ? 'Windows 平台使用内置 Node.js SNI 中继服务，无需外部二进制依赖'
            : (relay.ok ? relay.path : `缺失: ${relay.path}`),
        hint: isWin ? undefined : (relay.ok ? undefined : '同上'),
    });

    const prepareWhere =
        '请点「重新启动」或开启设置「自动准备 hosts/中继」以写入 hosts。亦可①配置页②诊断页顶部③命令面板。';

    const hosts = readHostsStatus();
    items.push({
        key: 'hosts',
        title: '/etc/hosts（第 4 步：域名指向本机）',
        ok: hosts.ok,
        detail: hosts.detail,
        hint: hosts.ok
            ? undefined
            : `未写入或未完整：${prepareWhere}。未执行过则不会出现 relay 的 PID 文件。`,
    });

    const relayProc = await checkRelayProcess();
    items.push({
        key: 'relay',
        title: 'SNI 中继（第 4 步：本机 :443）',
        ok: relayProc.ok,
        detail: relayProc.detail,
        hint: relayProc.ok
            ? undefined
            : `无 PID 文件表示中继尚未成功启动：先完成 hosts 并执行「重新启动」或「一键启动」；若已执行仍失败请查看 ${RELAY_LOG_PATH}`,
    });

    items.push({
        key: 'privilege',
        title: '特权 / 签名说明',
        ok: true,
        detail:
            'hosts、监听 443、codesign 需要管理员密码。「重新启动」只写 hosts + 启动/重启 relay；完整一键启动另需注入 Antigravity。',
        hint: prepareWhere + '。relay 起停不会自动出现在配置页，需自行检测或看日志。',
    });

    items.push(await checkSystemProxy());

    return items;
}

/**
 * 仅供「完全停用」后调用：若系统代理指向本地地址则返回警告文案，否则返回 undefined。
 */
export async function checkSystemProxyForWarning(): Promise<string | undefined> {
    try {
        const out = await execShort('scutil --proxy', 5000);
        const LOCAL_RE = /^(127\.|localhost|0\.0\.0\.0)/i;
        const httpEnabled  = /HTTPEnable\s*:\s*1/.test(out);
        const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(out);
        const socksEnabled = /SOCKSEnable\s*:\s*1/.test(out);
        const httpProxy  = (out.match(/HTTPProxy\s*:\s*(\S+)/)  || [])[1] ?? '';
        const httpsProxy = (out.match(/HTTPSProxy\s*:\s*(\S+)/) || [])[1] ?? '';
        const socksProxy = (out.match(/SOCKSProxy\s*:\s*(\S+)/) || [])[1] ?? '';
        const isLocal = (
            (httpEnabled  && LOCAL_RE.test(httpProxy))  ||
            (httpsEnabled && LOCAL_RE.test(httpsProxy)) ||
            (socksEnabled && LOCAL_RE.test(socksProxy))
        );
        if (isLocal) {
            const parts: string[] = [];
            if (httpEnabled)  { parts.push(`HTTP → ${httpProxy}`); }
            if (httpsEnabled) { parts.push(`HTTPS → ${httpsProxy}`); }
            if (socksEnabled) { parts.push(`SOCKS → ${socksProxy}`); }
            return `⚠️ 系统代理仍指向本地：${parts.join('，')}。Clash / V2Ray 停止后全机网络将断开。\n` +
                   `请前往「系统设置 → 网络 → [当前网络] → 详细信息 → 代理」关闭，或由 Clash / V2Ray 管理该项。`;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/** hosts 或 SNI 中继未就绪时需要执行「重新启动」 */
export async function needsPrepareEnvironmentSetup(): Promise<boolean> {
    const hosts = readHostsStatus();
    if (!hosts.ok) {
        return true;
    }
    const relay = await checkRelayProcess();
    if (!relay.ok) {
        return true;
    }
    return false;
}

/**
 * 状态栏「全绿」条件：与诊断面板核心项一致（hosts、relay、Electron、上游连通、SOCKS5 等），任一步失败则为 false。
 */
export async function isProxyFullyHealthy(extensionRoot: string, config: ProxyConfig): Promise<boolean> {
    try {
        if (!config.host || !config.port) {
            return false;
        }
        const ag = validateAntigravityPath(config.antigravityAppPath);
        if (!ag.valid) {
            return false;
        }
        const dylib = bundledBin(extensionRoot, 'libantigravity.dylib');
        const relay = bundledBin(extensionRoot, RELAY_EXECUTABLE);
        const isWin = process.platform === 'win32';
        const dylibOk = isWin ? true : dylib.ok;
        const relayOk = isWin ? true : relay.ok;
        if (!dylibOk || !relayOk) {
            return false;
        }
        const hosts = readHostsStatus();
        if (!hosts.ok) {
            return false;
        }
        const relayProc = await checkRelayProcess();
        if (!relayProc.ok) {
            return false;
        }
        try {
            if (process.platform === 'win32') {
                const exeName = path.basename(config.antigravityAppPath) || 'Antigravity.exe';
                const tasklist = await execShort(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`);
                if (!tasklist.toLowerCase().includes(exeName.toLowerCase())) {
                    return false;
                }
            } else {
                await execShort('pgrep -f "Antigravity.app/Contents/MacOS/Electron"');
            }
        } catch {
            return false;
        }
        const timeout = Math.min(Math.max(config.timeout || 5000, 1000), 30000);
        const tcp = await validateProxyConnection(config.host, config.port, timeout);
        if (!tcp.valid) {
            return false;
        }
        if (config.type === 'socks5') {
            const socks = await validateSocks5Handshake(config.host, config.port, timeout);
            if (!socks.valid) {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}
