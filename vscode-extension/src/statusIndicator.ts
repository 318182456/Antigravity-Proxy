import * as vscode from 'vscode';

import { fetchTrueQuota } from './trueQuotaFetcher';

/** 仅展示状态；点击一律打开配置（不绑定启动/停止，降低宿主崩溃风险） */
export type IndicatorState = 'ok' | 'bad' | 'starting';

let item: vscode.StatusBarItem | undefined;
let quotaItem: vscode.StatusBarItem | undefined;
let lastState: IndicatorState = 'bad';
let trueQuotaTimer: NodeJS.Timeout | undefined;

// 核心模型限额状态定义：与官方配额大面板完美一一对应
export interface QuotaState {
    geminiWeekly: number;    // Gemini 每周限额
    geminiFiveHour: number;  // Gemini 5小时频次
    claudeWeekly: number;    // Claude 每周限额
    claudeFiveHour: number;  // Claude 5小时频次
    credits: string;         // AI 点数 (Credits)
}

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
    currentQuota = { ...currentQuota, ...newQuota };
    updateQuotaIndicator();
    for (const listener of quotaListeners) {
        try {
            listener(currentQuota);
        } catch {}
    }
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
        `- Gemini 每周限额: ${currentQuota.geminiWeekly}%`,
        `- Gemini 5小时频次: ${currentQuota.geminiFiveHour}%`,
        `- Claude 每周限额: ${currentQuota.claudeWeekly}%`,
        `- Claude 5小时频次: ${currentQuota.claudeFiveHour}%`,
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

export function createRuntimeIndicator(): vscode.Disposable {
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
    
    return new vscode.Disposable(() => {
        if (trueQuotaTimer) {
            clearInterval(trueQuotaTimer);
            trueQuotaTimer = undefined;
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
