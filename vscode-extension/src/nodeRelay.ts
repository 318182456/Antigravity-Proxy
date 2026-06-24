import * as net from 'net';
import * as cp from 'child_process';
import { log, logError, logSuccess } from './logger';
import { recordProxyRequest } from './statusIndicator';

/**
 * TLS SNI 解析器：从客户端发送的第一个 ClientHello 握手包中提取 Server Name Indication (SNI)
 */
function parseSNI(buf: Buffer): string | null {
    try {
        if (buf.length < 9) return null;
        // Content Type: 0x16 (Handshake)
        if (buf[0] !== 0x16) return null;
        // Handshake Type: 0x01 (ClientHello)
        if (buf[5] !== 0x01) return null;

        let p = 9; // 跳过 Record Header (5 字节) + Handshake Header (4 字节)
        const end = buf.length;

        // 跳过 client_version (2 字节) + random (32 字节)
        if (p + 34 > end) return null;
        p += 34;

        // 跳过 session_id (1 + length 字节)
        if (p >= end) return null;
        const sessionIdLen = buf[p];
        p += 1 + sessionIdLen;

        // 跳过 cipher_suites (2 + length 字节)
        if (p + 2 > end) return null;
        const cipherSuitesLen = (buf[p] << 8) | buf[p + 1];
        p += 2 + cipherSuitesLen;

        // 跳过 compression_methods (1 + length 字节)
        if (p >= end) return null;
        const compressionMethodsLen = buf[p];
        p += 1 + compressionMethodsLen;

        // 进入 extensions 字段 (2 字节长度 + extensions 数据)
        if (p + 2 > end) return null;
        const extensionsLen = (buf[p] << 8) | buf[p + 1];
        p += 2;
        const extensionsEnd = Math.min(p + extensionsLen, end);

        // 遍历所有 extension
        while (p + 4 <= extensionsEnd) {
            const extType = (buf[p] << 8) | buf[p + 1];
            const extLen = (buf[p + 2] << 8) | buf[p + 3];
            p += 4;

            if (extType === 0x0000) {
                // server_name 扩展
                if (p + 5 > extensionsEnd) return null;
                p += 2; // 跳过 server_name_list_length (2 字节)
                if (buf[p] !== 0x00) return null; // NameType 必须为 host_name (0)
                p++;
                const nameLen = (buf[p] << 8) | buf[p + 1];
                p += 2;
                if (p + nameLen > extensionsEnd) return null;
                return buf.slice(p, p + nameLen).toString('utf-8');
            }
            p += extLen;
        }
    } catch (e) {
        logError(`解析 SNI 异常: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
}

/**
 * 与 SOCKS5 上游代理握手并建立到目标主机的连接
 */
function socks5Connect(
    socket: net.Socket,
    proxyHost: string,
    proxyPort: number,
    targetHost: string,
    targetPort: number,
    timeoutMs: number
): Promise<void> {
    return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            socket.removeAllListeners('data');
            socket.removeAllListeners('error');
            socket.removeAllListeners('close');
        };

        const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) reject(err);
            else resolve();
        };

        timer = setTimeout(() => {
            finish(new Error('连接 SOCKS5 代理超时'));
        }, timeoutMs);

        socket.connect(proxyPort, proxyHost, () => {
            // 发送握手请求：Version=5, NMethods=1, Method=0x00 (无身份认证)
            socket.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        let stage = 0; // 0: 等待握手响应, 1: 等待连接建立响应
        socket.on('data', (data) => {
            if (stage === 0) {
                if (data.length >= 2 && data[0] === 0x05 && data[1] === 0x00) {
                    // 握手成功，发送 CONNECT 请求
                    const hostBuf = Buffer.from(targetHost, 'utf-8');
                    const req = Buffer.alloc(5 + hostBuf.length + 2);
                    req[0] = 0x05; // VER
                    req[1] = 0x01; // CMD (CONNECT)
                    req[2] = 0x00; // RSV
                    req[3] = 0x03; // ATYP (DOMAINNAME)
                    req[4] = hostBuf.length;
                    hostBuf.copy(req, 5);
                    req.writeUInt16BE(targetPort, 5 + hostBuf.length);
                    socket.write(req);
                    stage = 1;
                } else {
                    finish(new Error(`SOCKS5 握手失败，不支持的响应: ${data.toString('hex')}`));
                }
            } else if (stage === 1) {
                if (data.length >= 4 && data[0] === 0x05 && data[1] === 0x00) {
                    // 连接建立成功！
                    finish();
                } else {
                    finish(new Error(`SOCKS5 代理连接目标失败，响应码: ${data[1]}`));
                }
            }
        });

        socket.on('error', (err) => finish(err));
        socket.on('close', () => finish(new Error('SOCKS5 连接被代理服务器主动关闭')));
    });
}

/**
 * 与 HTTP 上游代理握手并建立 CONNECT 隧道
 */
function httpConnect(
    socket: net.Socket,
    proxyHost: string,
    proxyPort: number,
    targetHost: string,
    targetPort: number,
    timeoutMs: number
): Promise<void> {
    return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            socket.removeAllListeners('data');
            socket.removeAllListeners('error');
            socket.removeAllListeners('close');
        };

        const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) reject(err);
            else resolve();
        };

        timer = setTimeout(() => {
            finish(new Error('连接 HTTP 代理超时'));
        }, timeoutMs);

        socket.connect(proxyPort, proxyHost, () => {
            // 发送 HTTP CONNECT 请求
            socket.write(
                `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
                `Host: ${targetHost}:${targetPort}\r\n` +
                `Proxy-Connection: Keep-Alive\r\n\r\n`
            );
        });

        socket.on('data', (data) => {
            const resp = data.toString('utf-8');
            if (resp.startsWith('HTTP/1.1 200') || resp.startsWith('HTTP/1.0 200')) {
                finish();
            } else {
                finish(new Error(`HTTP 代理握手失败，非 200 响应: ${resp.split('\r\n')[0]}`));
            }
        });

        socket.on('error', (err) => finish(err));
        socket.on('close', () => finish(new Error('HTTP 连接被代理服务器主动关闭')));
    });
}

/**
 * 诊断 Windows 端口占用进程
 */
function getWinPortOccupant(port: number): Promise<string | null> {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve(null);
            return;
        }
        cp.exec('netstat -ano', (err, stdout) => {
            if (err || !stdout) {
                resolve(null);
                return;
            }
            
            const lines = stdout.split('\n');
            let pid: string | null = null;
            const regex = new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
            
            for (const line of lines) {
                const match = line.match(regex);
                if (match && match[1]) {
                    pid = match[1];
                    break;
                }
            }
            
            if (!pid || pid === '0') {
                resolve(null);
                return;
            }
            
            cp.exec(`tasklist /FI "PID eq ${pid}" /NH`, (err2, stdout2) => {
                if (err2 || !stdout2) {
                    resolve(`PID: ${pid} (未知进程)`);
                    return;
                }
                const line = stdout2.trim();
                const matchName = line.match(/^(\S+)/);
                if (matchName && matchName[1] && !line.includes('无任务') && !line.includes('没有运行')) {
                    resolve(`${matchName[1]} (PID: ${pid})`);
                } else {
                    resolve(`PID: ${pid}`);
                }
            });
        });
    });
}

export class NodeRelayServer {
    private server: net.Server | null = null;

    /**
     * 启动 Node.js 透明代理中继
     */
    public start(
        port: number,
        proxyHost: string,
        proxyPort: number,
        proxyType: string,
        timeoutMs: number = 5000
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.server) {
                resolve();
                return;
            }

            const server = net.createServer((clientSocket) => {
                let proxySocket: net.Socket | null = null;

                clientSocket.on('error', (err) => {
                    log(`客户端连接异常 (fd=${(clientSocket as any)._handle?.fd}): ${err.message}`);
                    clientSocket.destroy();
                    if (proxySocket) proxySocket.destroy();
                });

                // 只读取第一次的 ClientHello 握手数据以解析 SNI
                clientSocket.once('data', async (firstChunk) => {
                    const sni = parseSNI(firstChunk);
                    if (!sni) {
                        log(`[中继] 未检测到有效的 TLS SNI，关闭该连接`);
                        clientSocket.destroy();
                        return;
                    }

                    log(`[中继] 嗅探到目标 SNI: ${sni} -> 转发至上游 ${proxyType}://${proxyHost}:${proxyPort}`);
                    recordProxyRequest(sni);

                    proxySocket = new net.Socket();
                    proxySocket.on('error', (err) => {
                        log(`上游代理连接异常: ${err.message}`);
                        clientSocket.destroy();
                        if (proxySocket) proxySocket.destroy();
                    });

                    try {
                        if (proxyType.toLowerCase() === 'socks5') {
                            await socks5Connect(proxySocket, proxyHost, proxyPort, sni, 443, timeoutMs);
                        } else {
                            await httpConnect(proxySocket, proxyHost, proxyPort, sni, 443, timeoutMs);
                        }

                        // 握手成功，把原始 ClientHello 数据包发送给上游代理
                        proxySocket.write(firstChunk);

                        // 双向管道对接
                        clientSocket.pipe(proxySocket);
                        proxySocket.pipe(clientSocket);
                    } catch (err: any) {
                        logError(`[中继] 与代理建立隧道失败 (${sni}): ${err.message}`);
                        clientSocket.destroy();
                        proxySocket.destroy();
                    }
                });
            });

            server.on('error', async (err: any) => {
                let extraMsg = '';
                if ((err.code === 'EACCES' || err.code === 'EADDRINUSE') && process.platform === 'win32') {
                    try {
                        const occupant = await getWinPortOccupant(port);
                        if (occupant) {
                            extraMsg = `。检测到端口 443 已被进程【${occupant}】占用，请先关闭该程序再重试。`;
                        } else {
                            extraMsg = `。443 端口可能正被本地的 IIS 或者是 Docker 等网络服务独占，请先排查并空闲此端口。`;
                        }
                    } catch {}
                }
                logError(`内置中继服务错误: ${err.message}${extraMsg}`);
                reject(new Error(`${err.message}${extraMsg}`));
            });

            // 监听 loopback 地址的指定端口
            server.listen(port, '127.0.0.2', () => {
                logSuccess(`内置 Node.js SNI 中继服务已启动，监听在 127.0.0.2:${port}`);
                this.server = server;
                resolve();
            });
        });
    }

    /**
     * 停止内置中继服务
     */
    public stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }
            this.server.close((err) => {
                if (err) {
                    logError(`停止内置中继服务异常: ${err.message}`);
                } else {
                    logSuccess(`内置中继服务已成功关闭`);
                }
                this.server = null;
                resolve();
            });
        });
    }

    /**
     * 检查当前是否在运行
     */
    public isRunning(): boolean {
        return this.server !== null && this.server.listening;
    }
}

// 导出单例实例
export const nodeRelayInstance = new NodeRelayServer();
