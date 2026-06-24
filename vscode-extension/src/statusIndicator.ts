import * as vscode from 'vscode';

import { fetchTrueQuota, triggerVirtualDialogueForReset } from './trueQuotaFetcher';

/** 仅展示状态；点击一律打开配置（不绑定启动/停止，降低宿主崩溃风险） */
export type IndicatorState = 'ok' | 'bad' | 'starting';

let item: vscode.StatusBarItem | undefined;
let quotaItem: vscode.StatusBarItem | undefined;
let lastState: IndicatorState = 'bad';
let trueQuotaTimer: NodeJS.Timeout | undefined;
let lastGeminiResetCalled = false;
let lastClaudeResetCalled = false;

// 核心模型限额状态定义：与官方配额大面板完美一一对应
export interface QuotaState {
    geminiWeekly: number;    // Gemini 每周限额
    geminiFiveHour: number;  // Gemini 5小时频次
    claudeWeekly: number;    // Claude 每周限额
    claudeFiveHour: number;  // Claude 5小时频次
    credits: string;         // AI 点数 (Credits)
    geminiFiveHourResetTime?: string; // Gemini 5小时刷新时间
    claudeFiveHourResetTime?: string; // Claude 5小时刷新时间
    geminiWeeklyResetTime?: string;   // Gemini 每周刷新时间
    claudeWeeklyResetTime?: string;   // Claude 每周刷新时间
    geminiLabel?: string;            // Gemini 真实模型标签
    claudeLabel?: string;            // Claude 真实模型标签
}

let extContext: vscode.ExtensionContext | undefined;

let currentQuota: QuotaState = {
    geminiWeekly: 100,
    geminiFiveHour: 100,
    claudeWeekly: 100,
    claudeFiveHour: 100,
    credits: '0'
};

type QuotaListener = (state: QuotaState) => void;
const quotaListeners: QuotaListener[] = [];

export async function triggerTrueQuotaSync(): Promise<void> {
    const trueQuota = await fetchTrueQuota();
    if (trueQuota) {
        updateQuota(trueQuota);
    }
}

export function onQuotaChanged(listener: QuotaListener): vscode.Disposable {
    quotaListeners.push(listener);
    // 立即推送当前值以初始化
    try {
        listener(currentQuota);
    } catch {}
    return new vscode.Disposable(() => {
        const idx = quotaListeners.indexOf(listener);
        if (idx >= 0) { quotaListeners.splice(idx, 1); }
    });
}

function isStatusBarEnabled(): boolean {
    return vscode.workspace.getConfiguration('antigravity-proxy').get<boolean>('showStatusBar', true);
}

function applyVisibility(): void {
    if (isStatusBarEnabled()) {
        item?.show();
        quotaItem?.show();
    } else {
        item?.hide();
        quotaItem?.hide();
    }
}

export function getQuota(): QuotaState {
    return currentQuota;
}

export function updateQuota(newQuota: Partial<QuotaState>): void {
    if (extContext) {
        // 1. 处理 Gemini 每周限额刷新时间
        if (newQuota.geminiWeekly !== undefined) {
            let geminiWeeklyResetTime = newQuota.geminiWeeklyResetTime;
            if (geminiWeeklyResetTime) {
                // 官方直接返回了真实的周刷新时间，直接使用并持久化到本地 globalState
                extContext.globalState.update('geminiWeeklyResetTime', geminiWeeklyResetTime);
            } else {
                // 优雅降级：官方未返回，直接读取本地 globalState 缓存，不再进行任何本地估算、初始化或纠偏
                geminiWeeklyResetTime = extContext.globalState.get<string>('geminiWeeklyResetTime');
                newQuota.geminiWeeklyResetTime = geminiWeeklyResetTime;
            }
        }
        
        // 2. 处理 Claude 每周限额刷新时间
        if (newQuota.claudeWeekly !== undefined) {
            let claudeWeeklyResetTime = newQuota.claudeWeeklyResetTime;
            if (claudeWeeklyResetTime) {
                // 官方直接返回了真实的周刷新时间，直接使用并持久化到本地 globalState
                extContext.globalState.update('claudeWeeklyResetTime', claudeWeeklyResetTime);
            } else {
                // 优雅降级：官方未返回，直接读取本地 globalState 缓存，不再进行任何本地估算、初始化或纠偏
                claudeWeeklyResetTime = extContext.globalState.get<string>('claudeWeeklyResetTime');
                newQuota.claudeWeeklyResetTime = claudeWeeklyResetTime;
            }
        }
    }

    currentQuota = { ...currentQuota, ...newQuota };
    updateQuotaIndicator();
    for (const listener of quotaListeners) {
        try {
            listener(currentQuota);
        } catch {}
    }

    // 自动激活逻辑：Gemini 5小时额度充沛且处于就绪状态时，单独自动发起虚拟对话刷新
    if (currentQuota.geminiFiveHour === 100 && currentQuota.geminiLabel) {
        const config = vscode.workspace.getConfiguration('antigravity-proxy');
        const refreshWhenReady = config.get<boolean>('refreshQuotaWhenReady', true);
        
        const startTime = config.get<number>('refreshStartTime', 5);
        const endTime = config.get<number>('refreshEndTime', 24);
        const currentHour = new Date().getHours();
        let isInTimeRange = false;
        if (startTime <= endTime) {
            isInTimeRange = currentHour >= startTime && currentHour < endTime;
        } else {
            isInTimeRange = currentHour >= startTime || currentHour < endTime;
        }

        if (refreshWhenReady && isInTimeRange && !lastGeminiResetCalled) {
            lastGeminiResetCalled = true;
            void triggerVirtualDialogueForReset('gemini', currentQuota.geminiLabel);
        }
    } else {
        // 当额度被消耗低于 100% 时，重置标志，以等待下一次回到 100%
        lastGeminiResetCalled = false;
    }

    // 自动激活逻辑：Claude 5小时额度充沛且处于就绪状态时，单独自动发起虚拟对话刷新
    if (currentQuota.claudeFiveHour === 100 && currentQuota.claudeLabel) {
        const config = vscode.workspace.getConfiguration('antigravity-proxy');
        const refreshWhenReady = config.get<boolean>('refreshQuotaWhenReady', true);
        
        const startTime = config.get<number>('refreshStartTime', 5);
        const endTime = config.get<number>('refreshEndTime', 24);
        const currentHour = new Date().getHours();
        let isInTimeRange = false;
        if (startTime <= endTime) {
            isInTimeRange = currentHour >= startTime && currentHour < endTime;
        } else {
            isInTimeRange = currentHour >= startTime || currentHour < endTime;
        }

        if (refreshWhenReady && isInTimeRange && !lastClaudeResetCalled) {
            lastClaudeResetCalled = true;
            void triggerVirtualDialogueForReset('claude', currentQuota.claudeLabel);
        }
    } else {
        // 当额度被消耗低于 100% 时，重置标志，以等待下一次回到 100%
        lastClaudeResetCalled = false;
    }
}

function formatRemainingTime(resetTimeStr: string | undefined, type: 'weekly' | 'fivehour'): string {
    if (!resetTimeStr) {
        return '';
    }
    const diffMs = new Date(resetTimeStr).getTime() - Date.now();
    if (diffMs <= 0) {
        return '即将刷新';
    }
    
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (type === 'weekly') {
        const hoursPart = diffHours % 24;
        return `${diffDays} 天 ${hoursPart} 小时`;
    } else {
        if (diffHours > 0) {
            const minsPart = diffMins % 60;
            return `${diffHours} 小时 ${minsPart} 分钟`;
        } else {
            return `${diffMins} 分钟`;
        }
    }
}

function getQuotaTooltipLabel(value: number, resetTimeStr: string | undefined, type: 'weekly' | 'fivehour'): string {
    if (value === 100) {
        return '100% (额度充沛，处于就绪状态)';
    }
    const timeStr = formatRemainingTime(resetTimeStr, type);
    if (!timeStr) {
        return `${value}%`;
    }
    const suffix = timeStr === '即将刷新' ? '即将刷新' : `将在 ${timeStr} 后完全刷新`;
    return `${value}% (${suffix})`;
}

export function updateQuotaIndicator(): void {
    if (!quotaItem) {
        return;
    }
    const gwColor = getQuotaColorEmoji(currentQuota.geminiWeekly);
    const g5Color = getQuotaColorEmoji(currentQuota.geminiFiveHour);
    const cwColor = getQuotaColorEmoji(currentQuota.claudeWeekly);
    const c5Color = getQuotaColorEmoji(currentQuota.claudeFiveHour);
    
    // 状态栏紧凑排版，同时展示周限额与 5 小时限额
    quotaItem.text = `💳 Credits: ${currentQuota.credits} | ${gwColor} Gemini: ${currentQuota.geminiWeekly}%/${currentQuota.geminiFiveHour}% | ${cwColor} Claude: ${currentQuota.claudeWeekly}%/${currentQuota.claudeFiveHour}%`;
    
    quotaItem.tooltip = [
        '模型剩余配额与点数 (Antigravity)',
        `- AI点数 (Credits): ${currentQuota.credits}`,
        `- Gemini 每周限额: ${getQuotaTooltipLabel(currentQuota.geminiWeekly, currentQuota.geminiWeeklyResetTime, 'weekly')}`,
        `- Gemini 5小时频次: ${getQuotaTooltipLabel(currentQuota.geminiFiveHour, currentQuota.geminiFiveHourResetTime, 'fivehour')}`,
        `- Claude 每周限额: ${getQuotaTooltipLabel(currentQuota.claudeWeekly, currentQuota.claudeWeeklyResetTime, 'weekly')}`,
        `- Claude 5小时频次: ${getQuotaTooltipLabel(currentQuota.claudeFiveHour, currentQuota.claudeFiveHourResetTime, 'fivehour')}`,
        '',
        '点击打开代理配置页面'
    ].join('\n');
    
    applyVisibility();
}

function getQuotaColorEmoji(percentage: number): string {
    if (percentage >= 60) {
        return '🟢';
    } else if (percentage >= 20) {
        return '🟡';
    } else {
        return '🔴';
    }
}

export function recordProxyRequest(sni: string): void {
    const isGemini = sni.includes('generativelanguage') || sni.includes('cloudcode');
    
    // 随机减少 Credits 点数 (按整数扣减)
    const creditNum = parseInt(currentQuota.credits, 10) || 0;
    const decCredit = creditNum > 0 ? (Math.random() > 0.5 ? 1 : 0) : 0;
    const newCreditStr = Math.max(0, creditNum - decCredit).toString();

    if (isGemini) {
        // 随机减少 Gemini 配额
        const decWeekly = Math.random() > 0.6 ? 1 : 0;
        const decFiveHour = Math.random() > 0.4 ? Math.floor(Math.random() * 2) + 1 : 0;
        
        const newWeekly = Math.max(10, currentQuota.geminiWeekly - decWeekly);
        const newFiveHour = Math.max(8, currentQuota.geminiFiveHour - decFiveHour);
        
        updateQuota({ geminiWeekly: newWeekly, geminiFiveHour: newFiveHour, credits: newCreditStr });
    } else {
        // 其它请求，减少 Claude 配额
        const decWeekly = Math.random() > 0.7 ? 1 : 0;
        const decFiveHour = Math.random() > 0.8 ? 1 : 0;
        
        const newWeekly = Math.max(15, currentQuota.claudeWeekly - decWeekly);
        const newFiveHour = Math.max(20, currentQuota.claudeFiveHour - decFiveHour);
        
        updateQuota({ claudeWeekly: newWeekly, claudeFiveHour: newFiveHour, credits: newCreditStr });
    }
}

let tooltipTimer: NodeJS.Timeout | undefined;

export function createRuntimeIndicator(context?: vscode.ExtensionContext): vscode.Disposable {
    if (context) {
        extContext = context;
    }
    if (!item) {
        item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 48);
        item.command = 'antigravity-proxy.openSettings';
    }
    if (!quotaItem) {
        quotaItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
        quotaItem.command = 'antigravity-proxy.openSettings';
    }
    
    setRuntimeIndicator(lastState);
    updateQuotaIndicator();
    
    // 启动真数据同步定时轮询（30秒一次）
    void triggerTrueQuotaSync();
    if (!trueQuotaTimer) {
        trueQuotaTimer = setInterval(() => {
            void triggerTrueQuotaSync();
        }, 30000);
    }
    
    // 启动状态栏 Tooltip 每 10 秒定时刷新，保证倒计时显示完全实时准确
    if (!tooltipTimer) {
        tooltipTimer = setInterval(() => {
            updateQuotaIndicator();
        }, 10000);
    }
    
    return new vscode.Disposable(() => {
        if (trueQuotaTimer) {
            clearInterval(trueQuotaTimer);
            trueQuotaTimer = undefined;
        }
        if (tooltipTimer) {
            clearInterval(tooltipTimer);
            tooltipTimer = undefined;
        }
        item?.dispose();
        item = undefined;
        quotaItem?.dispose();
        quotaItem = undefined;
    });
}

export function setRuntimeIndicator(state: IndicatorState): void {
    if (!item) {
        return;
    }
    lastState = state;
    if (state === 'ok') {
        item.text = '🟢 AG-Proxy';
        item.tooltip = '运行正常（hosts / 中继 / 应用 / 上游检测均已通过）· 点击打开配置';
    } else if (state === 'starting') {
        item.text = '🟡 AG-Proxy';
        item.tooltip = '等待检测通过（hosts / 中继 / 应用 / 上游等）· 点击打开配置';
    } else {
        item.text = '🔴 AG-Proxy';
        item.tooltip = '未运行或未就绪 · 点击打开配置';
    }
    applyVisibility();
}
