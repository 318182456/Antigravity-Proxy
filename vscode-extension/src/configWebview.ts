import * as vscode from "vscode";
import {
  getConfig,
  updateConfig,
  syncConfigYaml,
  normalizeProxyConfigFromUI,
  ProxyConfig,
} from "./configManager";
import {
  validateAll,
  ValidationResult,
  detectAntigravityPath,
} from "./validator";
import { collectDiagnostics } from "./diagnostics";
import {
  preparePrivilegedEnvironment,
  onRestoreStockDone,
} from "./proxyManager";
import { log, logSuccess, logError } from "./logger";
import { onQuotaChanged, updateQuota, triggerTrueQuotaSync, getQuota } from "./statusIndicator";

let panel: vscode.WebviewPanel | undefined;

export function openConfigWebview(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "antigravityProxyConfig",
    "⚙️ Antigravity Proxy 配置",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  const config = getConfig();
  panel.webview.html = getWebviewContent(config);

  const quotaSub = onQuotaChanged((state) => {
    panel?.webview.postMessage({ command: "quotaState", state });
  });
  context.subscriptions.push(quotaSub);

  const restoreStockSub = onRestoreStockDone(async () => {
    try {
      const items = await collectDiagnostics(
        context.extensionPath,
        getConfig(),
      );
      panel?.webview.postMessage({ command: "environmentResults", items });
    } catch {}
  });
  context.subscriptions.push(restoreStockSub);

  panel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case "validate": {
          const cfg = normalizeProxyConfigFromUI(message.config);
          log("🔍 执行配置校验...");
          const results = await validateAll(cfg);
          panel?.webview.postMessage({ command: "validationResults", results });
          break;
        }
        case "save": {
          const cfg = normalizeProxyConfigFromUI(message.config);
          log("💾 保存配置...");

          // 先校验
          const results = await validateAll(cfg);
          const failures = results.filter((r: ValidationResult) => !r.valid);

          if (failures.length > 0) {
            panel?.webview.postMessage({
              command: "saveResult",
              success: false,
              message: `校验失败: ${failures.map((f: ValidationResult) => f.message).join("; ")}`,
              results,
            });
            logError("配置校验失败，未保存");
            return;
          }

          // 校验通过，保存
          await updateConfig(cfg);
          syncConfigYaml(cfg);

          const effective = getConfig();
          const hostMismatch = effective.host !== cfg.host;
          const portMismatch = effective.port !== cfg.port;

          panel?.webview.postMessage({
            command: "saveResult",
            success: true,
            banner: hostMismatch || portMismatch ? "warning" : "success",
            message:
              hostMismatch || portMismatch
                ? `已写入设置，但当前窗口读到的代理为 ${effective.host}:${effective.port}（可能被语言/工作区覆盖）。请在设置中搜索 antigravity-proxy 或重载窗口。`
                : "配置已保存成功！",
            results,
          });
          if (hostMismatch || portMismatch) {
            logError(
              `保存后与 getConfig 不一致: 期望 ${cfg.host}:${cfg.port}，实际 ${effective.host}:${effective.port}`,
            );
            void vscode.window.showWarningMessage(
              `代理设置可能被其它作用域覆盖：当前为 ${effective.host}:${effective.port}。请检查各层级 settings 或「开发人员: 重新加载窗口」。`,
            );
          } else {
            logSuccess("配置保存成功");
            void vscode.window.showInformationMessage(
              "✅ 配置已保存。若修改了代理端口，请重新执行「重新启动」或先停止再启动代理，以使中继使用新端口。",
            );
          }
          break;
        }
        case "detectAntigravity": {
          const detected = detectAntigravityPath();
          panel?.webview.postMessage({
            command: "detectedPath",
            field: "antigravityAppPath",
            path: detected || "",
          });
          break;
        }
        case "browseFolder": {
          const field = message.field;
          const options: vscode.OpenDialogOptions = {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "选择 Antigravity 安装目录",
            filters: {},
          };

          const uri = await vscode.window.showOpenDialog(options);
          if (uri && uri[0]) {
            panel?.webview.postMessage({
              command: "browsedPath",
              field,
              path: uri[0].fsPath,
            });
          }
          break;
        }
        case "diagnoseEnvironment": {
          const cfg = normalizeProxyConfigFromUI(message.config);
          log("🔍 配置页：检测 hosts / 中继 / 内置组件…");
          try {
            const items = await collectDiagnostics(context.extensionPath, cfg);
            panel?.webview.postMessage({
              command: "environmentResults",
              items,
            });
          } catch (e: any) {
            logError(`环境检测失败: ${e?.message || e}`);
            panel?.webview.postMessage({
              command: "environmentResults",
              items: [],
              error: e?.message || String(e),
            });
          }
          break;
        }
        case "runPrepareEnvironment": {
          const cfg = normalizeProxyConfigFromUI(message.config);
          await preparePrivilegedEnvironment(cfg);
          break;
        }
        case "restoreStockProxy":
          await vscode.commands.executeCommand(
            "antigravity-proxy.restoreNoProxy",
          );
          break;
        case "startProxy":
          await vscode.commands.executeCommand("antigravity-proxy.start");
          break;
        case "stopProxy":
          await vscode.commands.executeCommand("antigravity-proxy.stop");
          break;
        case "refreshQuota": {
          // 立即主动触发官方真实配额与余额数据的拉取
          await triggerTrueQuotaSync();
          
          panel?.webview.postMessage({
            command: 'saveResult',
            success: true,
            message: '✅ 模型通道配额已成功从官方语言服务器同步（状态栏数据已同步）'
          });
          break;
        }
        case "requestQuotaState": {
          const state = getQuota();
          panel?.webview.postMessage({ command: "quotaState", state });
          break;
        }
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    restoreStockSub.dispose();
    quotaSub.dispose();
    panel = undefined;
  });
}

/** 转义 HTML 属性值，防止含特殊字符的配置项破坏 HTML 结构 */
function escapeAttr(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getWebviewContent(config: ProxyConfig): string {
  // 生成开始时间 options (0 - 23)
  let startOptions = "";
  for (let i = 0; i <= 23; i++) {
    const selected = config.refreshStartTime === i ? "selected" : "";
    startOptions += `<option value="${i}" ${selected}>${i} 点</option>`;
  }

  // 生成结束时间 options (1 - 24)
  let endOptions = "";
  for (let i = 1; i <= 24; i++) {
    const selected = config.refreshEndTime === i ? "selected" : "";
    endOptions += `<option value="${i}" ${selected}>${i} 点</option>`;
  }

  const quota = getQuota();
  const currentGeminiLabel = quota.geminiLabel ? `包括 ${quota.geminiLabel} 等模型` : "正在获取模型信息...";
  const currentClaudeLabel = quota.claudeLabel ? `包括 ${quota.claudeLabel} 等模型` : "正在获取模型信息...";

  const appDefaultHint =
    "Antigravity IDE.exe / Antigravity.exe 的安装路径（留空将自动检测 %LOCALAPPDATA%）";

  // 「完全停用代理」模块
  const restoreSectionHtml = `
    <div class="section">
        <div class="section-title">🔌 完全停用代理</div>
        <p class="hint">结束 Antigravity 进程，恢复 hosts 文件并停止内置中继服务。完成后点提示里的 <strong>查看日志</strong> 可看到完整注意项。</p>
        <p class="hint"><strong>完成后建议</strong></p>
        <ul class="hint hint-list">
            <li>避免在已带代理环境变量（如 HTTP_PROXY 等）的命令终端中启动应用。</li>
            <li>若自行开启过 Windows 系统代理，需要直连时请在系统设置中手动关闭。</li>
            <li>若网络仍解析异常，请在命令提示符/PowerShell 中执行 <code>ipconfig /flushdns</code> 刷新缓存。</li>
        </ul>
        <div class="env-actions" style="margin-top: 12px;">
            <button type="button" class="secondary danger" id="btnRestoreStock" onclick="runRestoreStock()">🔕 完全停用代理</button>
        </div>
    </div>
    `;

  // 「环境与流程状态」模块
  const envSectionHtml = `
    <div class="section">
        <div class="section-title">🖥 环境与流程状态</div>
        <p class="hint">检测使用<strong>当前表单</strong>（与是否点「保存」无关）。仅点「检测」不会启动任何进程。</p>
        <p class="hint">若服务工作异常或更新了代理配置：点 <strong>「重新启动」</strong> 重新写入 hosts 并重启内置 SNI 中继。</p>
        <div class="env-block">
            <div class="env-actions">
                <button class="secondary" id="btnPrepareEnv" onclick="runPrepareEnv()">🔄 重新启动（hosts + relay）</button>
                <button class="secondary" id="btnEnvCheck" onclick="checkEnvironment()">🔎 检测 hosts / 中继与流程</button>
            </div>
            <div id="env-diagnostics-wrap" class="env-diagnostics-wrap">
                <div class="env-diagnostics-toolbar">
                    <button type="button" class="secondary" id="btnToggleEnvResults" onclick="toggleEnvResultsPanel()">▼ 收起检测结果</button>
                    <span id="env-diagnostics-summary" class="env-diagnostics-summary"></span>
                </div>
                <div id="env-results" class="env-results"></div>
            </div>
        </div>
    </div>
    `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Antigravity Proxy 配置</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 24px;
            line-height: 1.6;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-widget-border, #333);
        }
        .header h1 {
            font-size: 20px;
            font-weight: 600;
        }
        .header .subtitle {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }

        /* 状态横幅 */
        .banner {
            padding: 10px 16px;
            border-radius: 6px;
            margin-bottom: 20px;
            font-size: 13px;
            display: none;
            align-items: center;
            gap: 8px;
        }
        .banner.success {
            display: flex;
            background: var(--vscode-testing-iconPassed, #2ea04320);
            border: 1px solid var(--vscode-testing-iconPassed, #2ea043);
            color: var(--vscode-testing-iconPassed, #2ea043);
        }
        .banner.error {
            display: flex;
            background: var(--vscode-testing-iconFailed, #f8514920);
            border: 1px solid var(--vscode-testing-iconFailed, #f85149);
            color: var(--vscode-testing-iconFailed, #f85149);
        }
        .banner.warning {
            display: flex;
            background: var(--vscode-list-warningForeground, #cca70020);
            border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
            color: var(--vscode-editorWarning-foreground, #cca700);
        }

        /* 分组 */
        .section {
            margin-bottom: 24px;
        }
        .section-title {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 12px;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--vscode-widget-border, #333);
            color: var(--vscode-foreground);
        }

        /* 表单行 */
        .form-row {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            margin-bottom: 14px;
        }
        .form-row-checkbox {
            align-items: center;
        }
        .form-label {
            width: 120px;
            flex-shrink: 0;
            font-size: 13px;
            padding-top: 6px;
            color: var(--vscode-foreground);
        }
        .form-row-checkbox .form-label {
            padding-top: 0;
        }
        .form-input-group {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .form-input-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        input, select {
            flex: 1;
            padding: 6px 10px;
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-size: 13px;
            font-family: var(--vscode-editor-font-family, monospace);
            outline: none;
        }
        input:focus, select:focus {
            border-color: var(--vscode-focusBorder);
        }
        input.valid {
            border-color: var(--vscode-testing-iconPassed, #2ea043);
        }
        input.invalid {
            border-color: var(--vscode-testing-iconFailed, #f85149);
        }

        /* 校验状态指示 */
        .validation-status {
            font-size: 12px;
            min-height: 16px;
        }
        .validation-status.success {
            color: var(--vscode-testing-iconPassed, #2ea043);
        }
        .validation-status.error {
            color: var(--vscode-testing-iconFailed, #f85149);
        }

        /* 按钮 */
        button {
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            cursor: pointer;
            white-space: nowrap;
        }
        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        button.secondary.danger {
            border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .button-bar {
            display: flex;
            gap: 10px;
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-widget-border, #333);
        }

        .browse-btn {
            padding: 6px 12px;
            font-size: 12px;
        }

        /* checkbox */
        .checkbox-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .checkbox-row input[type="checkbox"] {
            flex: unset;
            width: 16px;
            height: 16px;
        }

        .hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .hint-list {
            margin: 6px 0 0 0;
            padding-left: 1.2em;
        }
        .hint-list li {
            margin: 4px 0;
        }

        /* 加载动画 */
        .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            vertical-align: middle;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .env-block { margin-top: 8px; }
        .env-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
            margin-bottom: 10px;
        }
        .env-diagnostics-wrap {
            display: none;
            margin-top: 10px;
            border: 1px solid var(--vscode-widget-border, #333);
            border-radius: 6px;
            overflow: hidden;
        }
        .env-diagnostics-toolbar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px 12px;
            padding: 8px 10px;
            background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.12));
            border-bottom: 1px solid var(--vscode-widget-border, #333);
        }
        .env-diagnostics-toolbar button {
            flex-shrink: 0;
        }
        .env-diagnostics-summary {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.4;
        }
        .env-results {
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: 320px;
            overflow-y: auto;
            padding: 10px 10px 12px;
        }
        .env-results.collapsed {
            display: none !important;
        }
        .env-item {
            border: 1px solid var(--vscode-widget-border, #333);
            border-radius: 6px;
            padding: 10px 12px;
            font-size: 12px;
        }
        .env-item.ok { border-left: 3px solid var(--vscode-testing-iconPassed, #3fb950); }
        .env-item.bad { border-left: 3px solid var(--vscode-testing-iconFailed, #f85149); }
        .env-title { font-weight: 600; margin-bottom: 4px; }
        .env-detail { color: var(--vscode-descriptionForeground); }
        .env-hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 6px; }

        /* 模型配额样式 */
        .quota-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 16px;
            margin-top: 12px;
        }
        .quota-card {
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, 0.04));
            border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            border-radius: 8px;
            padding: 16px;
            transition: all 0.25s ease;
        }
        .quota-card:hover {
            border-color: var(--vscode-focusBorder, #007acc);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            background: var(--vscode-editor-selectionBackground, rgba(127, 127, 127, 0.08));
        }
        .quota-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px dashed var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
        }
        .quota-card-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .quota-card-icon {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            cursor: help;
        }
        .quota-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 0;
        }
        .quota-row:not(:last-child) {
            border-bottom: 1px solid rgba(255, 255, 255, 0.03);
        }
        .quota-label-col {
            flex: 1;
            padding-right: 12px;
        }
        .quota-name {
            font-size: 13px;
            color: var(--vscode-foreground);
        }
        .quota-desc {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .quota-chart-col {
            flex-shrink: 0;
            display: flex;
            align-items: center;
        }
        .quota-chart-wrapper {
            position: relative;
            width: 48px;
            height: 48px;
            cursor: pointer;
            transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .quota-chart-wrapper:hover {
            transform: scale(1.08);
        }
        .circular-chart {
            width: 100%;
            height: 100%;
        }
        .circle-bg {
            fill: none;
            stroke: var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            stroke-width: 3.2;
        }
        .circle {
            fill: none;
            stroke-width: 3.2;
            stroke-linecap: round;
            transition: stroke-dasharray 0.6s cubic-bezier(0.4, 0, 0.2, 1);
            animation: fillProgress 1s cubic-bezier(0.4, 0, 0.2, 1) forwards;
        }
        @keyframes fillProgress {
            from { stroke-dasharray: 0, 100; }
        }
        .circular-chart.gemini .circle {
            stroke: url(#gemini-grad);
            filter: drop-shadow(0 0 3px rgba(0, 242, 254, 0.3));
        }
        .circular-chart.claude .circle {
            stroke: url(#claude-grad);
            filter: drop-shadow(0 0 3px rgba(255, 94, 98, 0.3));
        }
        .percentage {
            fill: var(--vscode-foreground);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 9px;
            text-anchor: middle;
            font-weight: 600;
        }
        .quota-chart-wrapper::after {
            content: attr(data-tooltip);
            position: absolute;
            bottom: 120%;
            right: 50%;
            transform: translateX(50%) translateY(8px);
            background: var(--vscode-editorWidget-background, #252526);
            color: var(--vscode-editorWidget-foreground, #cccccc);
            border: 1px solid var(--vscode-widget-border, #3c3c3c);
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 11px;
            line-height: 1.4;
            white-space: pre-wrap;
            opacity: 0;
            pointer-events: none;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            z-index: 100;
            width: max-content;
            max-width: 240px;
            text-align: left;
        }
        .quota-chart-wrapper:hover::after {
            opacity: 1;
            transform: translateX(50%) translateY(0);
        }
    </style>
</head>
<body>
    <!-- SVG 渐变定义 -->
    <svg style="position: absolute; width: 0; height: 0; overflow: hidden;" version="1.1" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="gemini-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#00f2fe" />
                <stop offset="100%" stop-color="#4facfe" />
            </linearGradient>
            <linearGradient id="claude-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#ff9966" />
                <stop offset="100%" stop-color="#ff5e62" />
            </linearGradient>
        </defs>
    </svg>

    <div class="header">
        <div>
            <h1>🛰 Antigravity Proxy 配置</h1>
            <div class="subtitle">配置代理参数，校验后保存即可一键启动</div>
        </div>
    </div>

    <div id="banner" class="banner"></div>

    <!-- 模型配额 -->
    <div class="section">
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
            <span>📊 模型配额 (Model Quota) <span id="quota-credits-badge" style="font-size: 11px; margin-left: 10px; padding: 2px 6px; background: rgba(0, 242, 254, 0.15); border: 1px solid rgba(0, 242, 254, 0.3); border-radius: 4px; color: var(--vscode-textLink-foreground, #00f2fe); font-weight: normal; vertical-align: middle;">Credits: --</span></span>
            <button class="secondary" id="btnRefreshQuota" onclick="refreshQuota()" style="padding: 4px 10px; font-size: 11px; display: flex; align-items: center; gap: 4px; border: 1px solid var(--vscode-widget-border, #3c3c3c); background: var(--vscode-button-secondaryBackground, #2d2d2d);">
                <span class="refresh-icon" style="display: inline-block;">🔄</span> 刷新状态
            </button>
        </div>
        <p class="hint" style="margin-bottom: 12px;">
            显示当前代理通道中 AI 模型的限额状态。配额按 Token 消耗比例计算，较短的任务或高性价比模型将延长额度寿命。
        </p>
        
        <div class="quota-container">
            <!-- Gemini Card -->
            <div class="quota-card">
                <div class="quota-card-header">
                    <span class="quota-card-title">Gemini Models</span>
                    <span class="quota-card-icon" id="gemini-card-icon" title="${currentGeminiLabel}">ⓘ</span>
                </div>
                
                <div class="quota-card-body">
                    <div class="quota-row">
                        <div class="quota-label-col">
                            <div class="quota-name">每周额度 (Weekly Limit)</div>
                            <div class="quota-desc" id="gemini-weekly-desc">将在 3 天 7 小时后完全刷新</div>
                        </div>
                        <div class="quota-chart-col">
                            <div class="quota-chart-wrapper" id="gemini-weekly-wrapper" data-tooltip="已使用 19% | 剩余 81%&#10;将在 3 天 7 小时后刷新">
                                <svg class="circular-chart gemini" viewBox="0 0 36 36">
                                    <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <path class="circle" id="gemini-weekly-circle" stroke-dasharray="81, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <text x="18" y="21" class="percentage" id="gemini-weekly-text">81%</text>
                                </svg>
                            </div>
                        </div>
                    </div>
                    
                    <div class="quota-row">
                        <div class="quota-label-col">
                            <div class="quota-name">5小时频次 (Five Hour Limit)</div>
                            <div class="quota-desc" id="gemini-fivehour-desc">将在 2 小时 53 分钟后完全刷新</div>
                        </div>
                        <div class="quota-chart-col">
                            <div class="quota-chart-wrapper" id="gemini-fivehour-wrapper" data-tooltip="已使用 37% | 剩余 63%&#10;将在 2 小时 53 分钟后刷新">
                                <svg class="circular-chart gemini" viewBox="0 0 36 36">
                                    <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <path class="circle" id="gemini-fivehour-circle" stroke-dasharray="63, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <text x="18" y="21" class="percentage" id="gemini-fivehour-text">63%</text>
                                </svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Claude & GPT Card -->
            <div class="quota-card">
                <div class="quota-card-header">
                    <span class="quota-card-title">Claude & GPT Models</span>
                    <span class="quota-card-icon" id="claude-card-icon" title="${currentClaudeLabel}">ⓘ</span>
                </div>
                
                <div class="quota-card-body">
                    <div class="quota-row">
                        <div class="quota-label-col">
                            <div class="quota-name">每周额度 (Weekly Limit)</div>
                            <div class="quota-desc" id="claude-weekly-desc">将在 5 天 23 小时后完全刷新</div>
                        </div>
                        <div class="quota-chart-col">
                            <div class="quota-chart-wrapper" id="claude-weekly-wrapper" data-tooltip="已使用 6% | 剩余 94%&#10;将在 5 天 23 小时后刷新">
                                <svg class="circular-chart claude" viewBox="0 0 36 36">
                                    <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <path class="circle" id="claude-weekly-circle" stroke-dasharray="94, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <text x="18" y="21" class="percentage" id="claude-weekly-text">94%</text>
                                </svg>
                            </div>
                        </div>
                    </div>
                    
                    <div class="quota-row">
                        <div class="quota-label-col">
                            <div class="quota-name">5小时频次 (Five Hour Limit)</div>
                            <div class="quota-desc" id="claude-fivehour-desc">额度充沛，处于就绪状态</div>
                        </div>
                        <div class="quota-chart-col">
                            <div class="quota-chart-wrapper" id="claude-fivehour-wrapper" data-tooltip="已使用 0% | 剩余 100%&#10;无需刷新">
                                <svg class="circular-chart claude" viewBox="0 0 36 36">
                                    <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <path class="circle" id="claude-fivehour-circle" stroke-dasharray="100, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <text x="18" y="21" class="percentage" id="claude-fivehour-text">100%</text>
                                </svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- 代理设置 -->
    <div class="section">
        <div class="section-title">🌐 代理设置</div>

        <div class="form-row">
            <div class="form-label">代理地址</div>
            <div class="form-input-group">
                <input type="text" id="host" value="${escapeAttr(config.host)}" placeholder="127.0.0.1" />
                <div id="status-host" class="validation-status"></div>
            </div>
        </div>

        <div class="form-row">
            <div class="form-label">代理端口</div>
            <div class="form-input-group">
                <input type="number" id="port" value="${escapeAttr(config.port)}" min="1" max="65535" placeholder="10808" />
                <div id="status-port" class="validation-status"></div>
            </div>
        </div>

        <div class="form-row">
            <div class="form-label">代理类型</div>
            <div class="form-input-group">
                <div class="form-input-row" style="gap: 16px;">
                    <select id="type" style="flex: 1;">
                        <option value="socks5" ${config.type === "socks5" ? "selected" : ""}>SOCKS5</option>
                        <option value="http" ${config.type === "http" ? "selected" : ""}>HTTP</option>
                    </select>
                    <span class="form-label" style="width: auto; padding-top: 0; flex-shrink: 0; color: var(--vscode-foreground);">连接超时</span>
                    <input type="number" id="timeout" value="${escapeAttr(config.timeout)}" min="1000" max="30000" style="flex: 1; min-width: 80px;" />
                    <span class="hint" style="flex-shrink: 0;">毫秒</span>
                </div>
            </div>
        </div>
    </div>

    <!-- 路径设置 -->
    <div class="section">
        <div class="section-title">📁 路径设置</div>

        <div class="form-row">
            <div class="form-label">Antigravity 路径</div>
            <div class="form-input-group">
                <div class="form-input-row">
                    <input type="text" id="antigravityAppPath" value="${escapeAttr(config.antigravityAppPath)}" placeholder="留空自动检测" />
                    <button class="secondary browse-btn" onclick="browse('antigravityAppPath')">浏览...</button>
                    <button class="secondary browse-btn" onclick="detectAntigravity()">自动检测</button>
                </div>
                <div class="hint">${appDefaultHint}</div>
                <div id="status-antigravityAppPath" class="validation-status"></div>
            </div>
        </div>
    </div>

    <!-- 其它设置 -->
    <div class="section">
        <div class="section-title">⚙️ 其它设置</div>

        <div class="form-row form-row-checkbox">
            <div class="form-label">自启动</div>
            <div class="checkbox-row">
                <input type="checkbox" id="autoStart" ${config.autoStart ? "checked" : ""} />
                <span class="hint">编辑器启动后自动开启代理进程</span>
            </div>
        </div>

        <div class="form-row form-row-checkbox">
            <div class="form-label">自动准备环境</div>
            <div class="checkbox-row">
                <input type="checkbox" id="autoPrepareHostsRelay" ${config.autoPrepareHostsRelay ? "checked" : ""} />
                <span class="hint">扩展激活后，若检测到 hosts 劫持或中继未就绪，自动写入 hosts 并启动中继</span>
            </div>
        </div>

        <div class="form-row form-row-checkbox">
            <div class="form-label">状态栏状态</div>
            <div class="checkbox-row">
                <input type="checkbox" id="showStatusBar" ${config.showStatusBar ? "checked" : ""} />
                <span class="hint">在状态栏右侧显示运行状态图标</span>
            </div>
        </div>

        <div class="form-row form-row-checkbox">
            <div class="form-label">就绪时刷新</div>
            <div class="checkbox-row">
                <input type="checkbox" id="refreshQuotaWhenReady" ${config.refreshQuotaWhenReady ? "checked" : ""} />
                <span class="hint">额度充沛，处于就绪状态时，调用ai 刷新额度</span>
            </div>
        </div>

        <div class="form-row" id="timeRangeRow" style="${config.refreshQuotaWhenReady ? '' : 'display: none;'}">
            <div class="form-label">刷新时间段</div>
            <div class="form-input-group">
                <div class="form-input-row">
                    <select id="refreshStartTime" style="width: 100px; flex: none;">
                        ${startOptions}
                    </select>
                    <span style="margin: 0 4px;">至</span>
                    <select id="refreshEndTime" style="width: 100px; flex: none;">
                        ${endOptions}
                    </select>
                    <span class="hint" style="margin-left: 8px;">在此本地时间段内允许自动发起虚拟对话刷新</span>
                </div>
            </div>
        </div>
    </div>

    ${envSectionHtml}

    ${restoreSectionHtml}

    <div class="button-bar">
        <button class="primary" id="btnSave" onclick="save()">💾 保存配置</button>
        <button class="secondary" id="btnValidate" onclick="validate()">🔍 校验配置</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // 联动控制时间段行的显示/隐藏
        const readyCheckbox = document.getElementById('refreshQuotaWhenReady');
        if (readyCheckbox) {
            readyCheckbox.addEventListener('change', function(e) {
                const row = document.getElementById('timeRangeRow');
                if (row) {
                    row.style.display = e.target.checked ? '' : 'none';
                }
            });
        }

        // 刷新模型配额，向插件后台发送刷新指令进行同步
        function refreshQuota() {
            const btn = document.getElementById('btnRefreshQuota');
            const icon = btn.querySelector('.refresh-icon');
            icon.style.transition = 'transform 0.8s ease';
            icon.style.transform = 'rotate(360deg)';
            btn.disabled = true;
            
            vscode.postMessage({ command: 'refreshQuota' });
            
            setTimeout(() => {
                icon.style.transform = 'none';
                btn.disabled = false;
            }, 800);
        }

        let lastQuotaState = null;

        function formatRemainingTime(resetTimeStr, type) {
            if (!resetTimeStr) return '';
            const diffMs = new Date(resetTimeStr).getTime() - Date.now();
            if (diffMs <= 0) return '即将刷新';
            
            const diffSecs = Math.floor(diffMs / 1000);
            const diffMins = Math.floor(diffSecs / 60);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);
            
            if (type === 'weekly') {
                const hoursPart = diffHours % 24;
                return diffDays + " 天 " + hoursPart + " 小时";
            } else {
                if (diffHours > 0) {
                    const minsPart = diffMins % 60;
                    return diffHours + " 小时 " + minsPart + " 分钟";
                } else {
                    return diffMins + " 分钟";
                }
            }
        }

        function refreshQuotaDisplay() {
            if (!lastQuotaState) return;
            
            const cards = [
                { id: 'gemini-weekly', value: lastQuotaState.geminiWeekly, resetTime: lastQuotaState.geminiWeeklyResetTime, type: 'weekly' },
                { id: 'gemini-fivehour', value: lastQuotaState.geminiFiveHour, resetTime: lastQuotaState.geminiFiveHourResetTime, type: 'fivehour' },
                { id: 'claude-weekly', value: lastQuotaState.claudeWeekly, resetTime: lastQuotaState.claudeWeeklyResetTime, type: 'weekly' },
                { id: 'claude-fivehour', value: lastQuotaState.claudeFiveHour, resetTime: lastQuotaState.claudeFiveHourResetTime, type: 'fivehour' }
            ];
            
            cards.forEach(card => {
                const circle = document.getElementById(card.id + '-circle');
                const text = document.getElementById(card.id + '-text');
                const desc = document.getElementById(card.id + '-desc');
                const wrapper = document.getElementById(card.id + '-wrapper');
                
                if (text) text.textContent = card.value + '%';
                if (circle) circle.style.strokeDasharray = card.value + ', 100';
                
                if (card.value === 100) {
                    if (desc) desc.textContent = '额度充沛，处于就绪状态';
                    if (wrapper) wrapper.setAttribute('data-tooltip', '已使用 0% | 剩余 100%\\n无需刷新');
                } else {
                    const timeStr = formatRemainingTime(card.resetTime, card.type);
                    const label = timeStr === '即将刷新' ? '即将刷新' : '将在 ' + timeStr + ' 后完全刷新';
                    if (desc) desc.textContent = label;
                    if (wrapper) {
                        wrapper.setAttribute('data-tooltip', '已使用 ' + (100 - card.value) + '% | 剩余 ' + card.value + '%\\n' + (timeStr === '即将刷新' ? '即将刷新' : '将在 ' + timeStr + ' 后刷新'));
                    }
                }
            });

            // 动态更新 Gemini 和 Claude 卡片真实的提示模型值
            const geminiIcon = document.getElementById('gemini-card-icon');
            if (geminiIcon && lastQuotaState.geminiLabel) {
                geminiIcon.setAttribute('title', '包括 ' + lastQuotaState.geminiLabel + ' 等模型');
            }
            const claudeIcon = document.getElementById('claude-card-icon');
            if (claudeIcon && lastQuotaState.claudeLabel) {
                claudeIcon.setAttribute('title', '包括 ' + lastQuotaState.claudeLabel + ' 等模型');
            }
        }

        function getFormValues() {
            return {
                host: document.getElementById('host').value,
                port: parseInt(document.getElementById('port').value, 10) || 10808,
                type: document.getElementById('type').value,
                timeout: parseInt(document.getElementById('timeout').value, 10) || 5000,

                antigravityAppPath: document.getElementById('antigravityAppPath').value,
                autoStart: document.getElementById('autoStart').checked,
                autoPrepareHostsRelay: document.getElementById('autoPrepareHostsRelay').checked,
                showStatusBar: document.getElementById('showStatusBar').checked,
                refreshQuotaWhenReady: document.getElementById('refreshQuotaWhenReady').checked,
                refreshStartTime: parseInt(document.getElementById('refreshStartTime').value, 10) || 5,
                refreshEndTime: parseInt(document.getElementById('refreshEndTime').value, 10) || 24,
            };
        }

        function validate() {
            const btn = document.getElementById('btnValidate');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 校验中...';
            clearStatuses();
            hideBanner();
            vscode.postMessage({ command: 'validate', config: getFormValues() });
        }

        function save() {
            const btn = document.getElementById('btnSave');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 保存中...';
            clearStatuses();
            hideBanner();
            vscode.postMessage({ command: 'save', config: getFormValues() });
        }

        function browse(field) {
            vscode.postMessage({ command: 'browseFolder', field });
        }

        function detectAntigravity() {
            vscode.postMessage({ command: 'detectAntigravity' });
        }

        function runPrepareEnv() {
            vscode.postMessage({ command: 'runPrepareEnvironment', config: getFormValues() });
        }

        function runRestoreStock() {
            vscode.postMessage({ command: 'restoreStockProxy' });
        }

        function showEnvDiagnosticsShell(expanded) {
            const shell = document.getElementById('env-diagnostics-wrap');
            const font = document.getElementById('env-results');
            const toggle = document.getElementById('btnToggleEnvResults');
            shell.style.display = 'block';
            if (expanded) {
                font.classList.remove('collapsed');
                toggle.textContent = '▼ 收起检测结果';
            } else {
                font.classList.add('collapsed');
                toggle.textContent = '▶ 展开检测结果';
            }
        }

        function toggleEnvResultsPanel() {
            const results = document.getElementById('env-results');
            const toggle = document.getElementById('btnToggleEnvResults');
            const collapsed = results.classList.toggle('collapsed');
            toggle.textContent = collapsed ? '▶ 展开检测结果' : '▼ 收起检测结果';
        }

        function updateEnvDiagnosticsSummary(items, errorText) {
            const el = document.getElementById('env-diagnostics-summary');
            if (errorText) {
                el.textContent = '检测出错';
                return;
            }
            const list = items || [];
            const bad = list.filter(function(i) { return !i.ok; }).length;
            el.textContent = list.length
                ? ('共 ' + list.length + ' 项' + (bad ? '，' + bad + ' 项需关注' : '，均正常'))
                : '';
        }

        function checkEnvironment() {
            const btn = document.getElementById('btnEnvCheck');
            btn.disabled = true;
            btn.textContent = '检测中…';
            showEnvDiagnosticsShell(true);
            const wrap = document.getElementById('env-results');
            wrap.innerHTML = '<span class="hint">正在读取本机状态…</span>';
            document.getElementById('env-diagnostics-summary').textContent = '检测中…';
            vscode.postMessage({ command: 'diagnoseEnvironment', config: getFormValues() });
        }

        function renderEnvResults(items, errorText) {
            const wrap = document.getElementById('env-results');
            wrap.innerHTML = '';
            updateEnvDiagnosticsSummary(items, errorText);
            if (errorText) {
                const err = document.createElement('div');
                err.className = 'env-item bad';
                err.textContent = errorText;
                wrap.appendChild(err);
                showEnvDiagnosticsShell(true);
                return;
            }
            (items || []).forEach(function(it) {
                const div = document.createElement('div');
                div.className = 'env-item ' + (it.ok ? 'ok' : 'bad');
                const t = document.createElement('div');
                t.className = 'env-title';
                t.textContent = it.title + (it.ok ? ' ✓' : ' ✗');
                const d = document.createElement('div');
                d.className = 'env-detail';
                d.textContent = it.detail;
                div.appendChild(t);
                div.appendChild(d);
                if (it.hint) {
                    const h = document.createElement('div');
                    h.className = 'env-hint';
                    h.textContent = it.hint;
                    div.appendChild(h);
                }
                wrap.appendChild(div);
            });
            showEnvDiagnosticsShell(true);
        }

        function showBanner(type, msg) {
            const banner = document.getElementById('banner');
            banner.className = 'banner ' + type;
            banner.textContent = msg;
            banner.style.display = 'flex';
        }

        function hideBanner() {
            document.getElementById('banner').style.display = 'none';
        }

        function clearStatuses() {
            document.querySelectorAll('.validation-status').forEach(el => {
                el.textContent = '';
                el.className = 'validation-status';
            });
            document.querySelectorAll('input').forEach(el => {
                el.classList.remove('valid', 'invalid');
            });
        }

        function applyValidationResults(results) {
            const fieldMap = {
                'host': 'host',
                'port': 'port',
                'antigravityAppPath': 'antigravityAppPath',
                'proxy': 'host',
            };

            results.forEach(r => {
                const field = fieldMap[r.field] || r.field;
                const statusEl = document.getElementById('status-' + field);
                const inputEl = document.getElementById(field);

                if (statusEl) {
                    statusEl.textContent = r.message;
                    statusEl.className = 'validation-status ' + (r.valid ? 'success' : 'error');
                }
                if (inputEl && inputEl.tagName === 'INPUT') {
                    inputEl.classList.remove('valid', 'invalid');
                    inputEl.classList.add(r.valid ? 'valid' : 'invalid');
                }
            });
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'validationResults': {
                    document.getElementById('btnValidate').disabled = false;
                    document.getElementById('btnValidate').textContent = '🔍 校验配置';
                    applyValidationResults(msg.results);
                    const failures = msg.results.filter(r => !r.valid);
                    if (failures.length === 0) {
                        showBanner('success', '✅ 所有配置校验通过！');
                    } else {
                        showBanner('error', '❌ 部分配置校验失败，请检查红色标记项');
                    }
                    break;
                }
                case 'saveResult': {
                    document.getElementById('btnSave').disabled = false;
                    document.getElementById('btnSave').textContent = '💾 保存配置';
                    if (msg.results) {
                        applyValidationResults(msg.results);
                    }
                    const kind = msg.banner || (msg.success ? 'success' : 'error');
                    showBanner(kind, msg.message);
                    break;
                }
                case 'detectedPath': {
                    const input = document.getElementById(msg.field);
                    if (input && msg.path) {
                        input.value = msg.path;
                        showBanner('success', '✅ 已检测到 Antigravity: ' + msg.path);
                    } else {
                        showBanner('error', '❌ 未能自动检测到 Antigravity.exe');
                    }
                    break;
                }
                case 'browsedPath': {
                    const input = document.getElementById(msg.field);
                    if (input && msg.path) {
                        input.value = msg.path;
                    }
                    break;
                }
                case 'environmentResults': {
                    const btn = document.getElementById('btnEnvCheck');
                    btn.disabled = false;
                    btn.textContent = '🔎 检测 hosts / 中继与流程';
                    renderEnvResults(msg.items, msg.error || '');
                    break;
                }
                case 'quotaState': {
                    const state = msg.state;
                    const badge = document.getElementById('quota-credits-badge');
                    if (badge && state.credits !== undefined) {
                        badge.textContent = 'Credits: ' + state.credits;
                    }
                    lastQuotaState = state;
                    refreshQuotaDisplay();
                    break;
                }
            }
        });
        
        // 启动定时器，每 10 秒动态刷新一次倒计时，确保页面显示的刷新时间完全实时准确
        setInterval(refreshQuotaDisplay, 10000);
        
        // 页面加载完成后立即向后台请求最新的模型配额状态数据，防止初始化通道竞争导致首包丢失
        vscode.postMessage({ command: 'requestQuotaState' });
    </script>
</body>
</html>`;
}
