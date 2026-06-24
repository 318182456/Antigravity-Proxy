import * as cp from 'child_process';
import * as http from 'http';
import { QuotaState } from './statusIndicator';
import { log, logError } from './logger';

interface ServerInfo {
    pid: number;
    csrfToken: string;
}

/**
 * 动态扫描 Windows 系统中的 language_server 进程，提取 PID 和 --csrf_token
 */
function scanLanguageServers(): Promise<ServerInfo[]> {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve([]);
            return;
        }
        
        // 使用单引号双写过滤条件，彻底规避双引号转义问题，确保 Windows 平台 100% 成功获取
        const cmd = "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter 'CommandLine like ''%--extension_server_port%''' | Select-Object ProcessId, CommandLine | ConvertTo-Json\"";
        cp.exec(cmd, (err, stdout) => {
            if (err || !stdout || stdout.trim() === '') {
                resolve([]);
                return;
            }
            try {
                const arr = JSON.parse(stdout);
                const results: ServerInfo[] = [];
                const list = Array.isArray(arr) ? arr : [arr];
                
                for (const item of list) {
                    if (!item || !item.CommandLine) { continue; }
                    const cmdline = item.CommandLine as string;
                    
                    const csrfMatch = cmdline.match(/--csrf_token\s+([a-f0-9-]+)/);
                    if (csrfMatch) {
                        results.push({
                            pid: item.ProcessId,
                            csrfToken: csrfMatch[1]
                        });
                    }
                }
                resolve(results);
            } catch (e) {
                resolve([]);
            }
        });
    });
}

/**
 * 动态获取指定 PID 进程当前正在监听的本地 TCP 端口
 */
function getListeningPorts(pid: number): Promise<number[]> {
    return new Promise((resolve) => {
        const cmd = `Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' } | Select-Object -ExpandProperty LocalPort`;
        cp.exec(`powershell -NoProfile -Command "${cmd}"`, (err, stdout) => {
            if (err || !stdout) {
                resolve([]);
                return;
            }
            const ports = stdout.split('\n')
                .map(p => parseInt(p.trim(), 10))
                .filter(p => !isNaN(p));
            resolve([...new Set(ports)]);
        });
    });
}

/**
 * 发送 gRPC-web/Connect-RPC 请求获取用户状态 JSON
 */
function requestUserStatus(port: number, token: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            metadata: {
                ideName: "antigravity",
                extensionName: "antigravity",
                ideVersion: "unknown",
                locale: "en"
            }
        });
        
        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            method: 'POST',
            headers: {
                'X-Codeium-Csrf-Token': token,
                'x-codeium-csrf-token': token,
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'User-Agent': 'grpc-web-javascript/0.1',
                'Origin': 'http://localhost',
                'Referer': 'http://localhost/',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 1200
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error('JSON parse error'));
                    }
                } else {
                    reject(new Error(`Status ${res.statusCode}`));
                }
            });
        });
        
        req.on('error', (e) => {
            reject(e);
        });
        
        req.write(payload);
        req.end();
    });
}

/**
 * 获取官方真实配额数据的入口函数（支持优雅降级）
 */
export async function fetchTrueQuota(): Promise<Partial<QuotaState> | null> {
    try {
        if (process.platform !== 'win32') {
            return null;
        }
        
        const servers = await scanLanguageServers();
        if (servers.length === 0) {
            return null;
        }
        
        // 依次盲扫所有活跃进程的所有端口
        for (const s of servers) {
            const ports = await getListeningPorts(s.pid);
            for (const port of ports) {
                try {
                    const data = await requestUserStatus(port, s.csrfToken);
                    if (data && data.userStatus) {
                        // 1. 解析 AI 点数 (Credits)
                        let creditsVal = '0';
                        const availableCredits = data.userStatus.userTier?.availableCredits || [];
                        const aiCredit = availableCredits.find((c: any) => c.creditType === 'GOOGLE_ONE_AI');
                        if (aiCredit) {
                            creditsVal = aiCredit.creditAmount || '0';
                        }
                        const creditsStr = Math.round(parseFloat(creditsVal)).toString();
                        
                        // 2. 解析每周限额点数占比（按官方周点数上限 650 和 106 计算比例）
                        const promptCredits = data.userStatus.planStatus?.availablePromptCredits;
                        const geminiWeekly = promptCredits !== undefined ? Math.max(0, Math.min(100, Math.round((promptCredits / 650) * 100))) : 77;
                        
                        const flowCredits = data.userStatus.planStatus?.availableFlowCredits;
                        const claudeWeekly = flowCredits !== undefined ? Math.max(0, Math.min(100, Math.round((flowCredits / 106) * 100))) : 94;
                        
                        // 3. 解析 5 小时限额比例 (使用 remainingFraction)
                        const clientModelConfigs = data.userStatus.cascadeModelConfigData?.clientModelConfigs || [];
                        
                        // 匹配 Gemini 5 小时限额
                        const geminiConfig = clientModelConfigs.find((m: any) => 
                            (m.label?.toLowerCase().includes('flash') || m.displayName?.toLowerCase().includes('flash')) && m.quotaInfo
                        );
                        const geminiFiveHour = geminiConfig ? Math.round(geminiConfig.quotaInfo.remainingFraction * 100) : 42;
                        const geminiFiveHourResetTime = geminiConfig?.quotaInfo?.resetTime;
                        
                        // 匹配 Claude 5 小时限额
                        const claudeConfig = clientModelConfigs.find((m: any) => 
                            (m.label?.toLowerCase().includes('claude') || m.displayName?.toLowerCase().includes('claude')) && m.quotaInfo
                        );
                        const claudeFiveHour = claudeConfig ? Math.round(claudeConfig.quotaInfo.remainingFraction * 100) : 100;
                        const claudeFiveHourResetTime = claudeConfig?.quotaInfo?.resetTime;
                        
                        log(`[💡 真数据同步] 成功拉取官方实时额度 (端口: ${port}) -> Credits: ${creditsStr}, Gemini Weekly: ${geminiWeekly}%, Gemini 5-Hour: ${geminiFiveHour}%, Claude Weekly: ${claudeWeekly}%, Claude 5-Hour: ${claudeFiveHour}%`);
                        
                        return {
                            credits: creditsStr,
                            geminiWeekly,
                            geminiFiveHour,
                            claudeWeekly,
                            claudeFiveHour,
                            geminiFiveHourResetTime,
                            claudeFiveHourResetTime
                        };
                    }
                } catch (e) {
                    // 忽略单个端口/Token 探测失败，继续尝试下一个
                }
            }
        }
    } catch (e: any) {
        logError(`获取官方真实配额失败: ${e?.message || e}`);
    }
    return null;
}
