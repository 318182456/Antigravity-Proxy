import * as os from 'os';
import * as path from 'path';

const isWin = process.platform === 'win32';

/** SNI 中继可执行文件名，与 Makefile `RELAY=bin/antigravity-relay` 一致 */
export const RELAY_EXECUTABLE = isWin ? 'antigravity-relay.exe' : 'antigravity-relay';
export const RELAY_PID_PATH = isWin ? path.join(os.tmpdir(), 'antigravity-relay.pid') : '/tmp/antigravity-relay.pid';
export const RELAY_LOG_PATH = isWin ? path.join(os.tmpdir(), 'antigravity-relay.log') : '/tmp/antigravity-relay.log';

