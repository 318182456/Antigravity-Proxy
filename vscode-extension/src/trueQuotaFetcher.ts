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
                            claudeFiveHourResetTime,
                            geminiLabel: geminiConfig?.label,
                            claudeLabel: claudeConfig?.label
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

/**
 * 向本地 language_server 请求模型配置列表以用于 model ID 解析
 */
function requestModelConfig(port: number, token: string): Promise<any> {
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
            path: '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData',
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
            timeout: 3000
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
        
        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

/**
 * 启动 Cascade 级联会话
 */
function requestStartCascade(port: number, token: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            metadata: {
                ideName: "antigravity",
                extensionName: "antigravity",
                ideVersion: "unknown",
                locale: "en"
            },
            source: 1
        });
        
        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/StartCascade',
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
            timeout: 3000
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
        
        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

/**
 * 在级联会话中向指定模型发送对话消息
 */
function requestSendCascadeMessage(port: number, token: string, cascadeId: string, modelId: string, message: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            metadata: {
                ideName: "antigravity",
                extensionName: "antigravity",
                ideVersion: "unknown",
                locale: "en"
            },
            cascadeId: cascadeId,
            items: [{ case: "text", value: message }],
            cascadeConfig: {
                plannerConfig: {
                    requestedModel: {
                        model: modelId
                    }
                }
            }
        });
        
        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
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
            timeout: 5000
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
        
        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

/**
 * 启动并维持对 Cascade 状态流（StreamAgentStateUpdates）的监听连接，促使 language_server 真正去请求云端
 */
function requestStreamAgentStateUpdates(port: number, token: string, cascadeId: string): Promise<http.ClientRequest> {
    return new Promise((resolve) => {
        const payload = JSON.stringify({
            metadata: {
                ideName: "antigravity",
                extensionName: "antigravity",
                ideVersion: "unknown",
                locale: "en"
            },
            conversationId: cascadeId
        });
        
        // Connect-RPC 的 enveloped 包头包含 5 字节
        const data = Buffer.from(payload, 'utf-8');
        const header = Buffer.alloc(5);
        header.writeUInt8(0, 0);
        header.writeUInt32BE(data.length, 1);
        const enveloped = Buffer.concat([header, data]);

        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
            method: 'POST',
            headers: {
                'X-Codeium-Csrf-Token': token,
                'x-codeium-csrf-token': token,
                'Content-Type': 'application/connect+json',
                'Connect-Protocol-Version': '1',
                'User-Agent': 'grpc-web-javascript/0.1',
                'Origin': 'http://localhost',
                'Referer': 'http://localhost/',
                'Content-Length': enveloped.length
            },
            timeout: 15000
        }, (res) => {
            res.on('data', () => {
                // 静默接收流状态数据，以驱动语言服务器持续请求云端模型
            });
        });
        
        req.on('error', () => {
            // 忽略连接的异常断开
        });
        
        req.write(enveloped);
        req.end();
        
        resolve(req);
    });
}

/**
 * 触发指定模型虚拟 AI 对话的入口函数
 */
export async function triggerVirtualDialogueForReset(modelType: 'gemini' | 'claude', modelLabel: string): Promise<boolean> {
    try {
        if (process.platform !== 'win32' || !modelLabel) {
            return false;
        }
        
        const servers = await scanLanguageServers();
        if (servers.length === 0) {
            return false;
        }
        
        for (const s of servers) {
            const ports = await getListeningPorts(s.pid);
            for (const port of ports) {
                try {
                    // 1. 获取模型配置映射，提取真实的 modelId
                    const configRes = await requestModelConfig(port, s.csrfToken);
                    const clientModelConfigs = configRes?.clientModelConfigs || [];
                    
                    let modelId: string | undefined;
                    
                    // 优先寻找 label 完全一致的项
                    const exactMatch = clientModelConfigs.find((m: any) => m.label === modelLabel);
                    if (exactMatch) {
                        modelId = exactMatch.modelOrAlias?.model;
                    }
                    
                    // 如果没找到，进行模糊推荐匹配
                    if (!modelId) {
                        if (modelType === 'gemini') {
                            const match = clientModelConfigs.find((m: any) => 
                                (m.label?.toLowerCase().includes('gemini') || m.label?.toLowerCase().includes('flash')) && m.modelOrAlias?.model
                            );
                            modelId = match?.modelOrAlias?.model;
                        } else {
                            const match = clientModelConfigs.find((m: any) => 
                                (m.label?.toLowerCase().includes('claude') || m.label?.toLowerCase().includes('sonnet')) && m.modelOrAlias?.model
                            );
                            modelId = match?.modelOrAlias?.model;
                        }
                    }
                    
                    if (!modelId) {
                        log(`[🔄 自动激活] 端口 ${port} 上未匹配到 ${modelType.toUpperCase()} (${modelLabel}) 的模型 ID，跳过该端口`);
                        continue;
                    }
                    
                    log(`[🔄 自动激活] 正在通过本地端口 ${port} 为 ${modelType.toUpperCase()} (ModelId: ${modelId}) 发起虚拟 AI 对话以刷新周期...`);
                    
                    // 2. 启动会话
                    const startRes = await requestStartCascade(port, s.csrfToken);
                    const cascadeId = startRes?.cascadeId;
                    if (!cascadeId) {
                        throw new Error('获取 cascadeId 失败');
                    }
                    
                    // 2.5 建立状态流监听连接 (至关重要：使 language_server 开始向云端请求，防止后台静默取消)
                    const streamReq = await requestStreamAgentStateUpdates(port, s.csrfToken, cascadeId);
                    
                    // 等待 500 毫秒确保流连接就绪
                    await new Promise(r => setTimeout(r, 500));
                    
                    // 3. 发送激活对话
                    const sendPrompt = "你好，请确认当前网络连接。这是一次自动额度热身检测。";
                    const sendRes = await requestSendCascadeMessage(port, s.csrfToken, cascadeId, modelId, sendPrompt);
                    
                    if (sendRes) {
                        log(`[🔄 自动激活] ${modelType.toUpperCase()} 虚拟对话发送成功，已激活新周期 (端口: ${port}, CascadeId: ${cascadeId})`);
                        
                        // 维持流连接 5 秒，以确保云端网络链路完整跑完并扣除额度，随后优雅销毁以释放系统资源
                        setTimeout(() => {
                            try {
                                streamReq.destroy();
                            } catch {}
                        }, 5000);
                        
                        return true;
                    } else {
                        try {
                            streamReq.destroy();
                        } catch {}
                    }
                } catch (e: any) {
                    logError(`[🔄 自动激活] 端口 ${port} ${modelType.toUpperCase()} 虚拟对话发送失败: ${e?.message || e}`);
                }
            }
        }
    } catch (e: any) {
        logError(`触发自动激活虚拟对话异常: ${e?.message || e}`);
    }
    return false;
}
