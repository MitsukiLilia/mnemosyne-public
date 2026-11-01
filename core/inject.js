// 注入:长期记忆 + 未折叠胶囊,经 setExtensionPrompt 放进提示词。
// 预算超了先丢最旧的胶囊,长期记忆不裁。任何状态变化后由调用方重算一次;插件关闭时清空。

import { peekData, maxContextSize } from './state.js';
import { getSettings, effectiveDepth } from './settings.js';
import { MEMORY_HEADER } from './prompts.js';

export const INJECT_KEY = 'mnemosyne_memory';
export const injectStats = { applied: 0 };

export function buildInjection(ctx, settings) {
    const data = peekData(ctx);
    if (!data) return '';
    const memText = (data.memory?.text || '').trim();
    const memTokens = memText ? (data.memory.tokens || 0) : 0;
    let caps = data.capsules.filter(c => !c.folded && c.text);
    if (!memText && !caps.length) return '';

    const budget = Math.floor(maxContextSize(ctx) * Math.max(0.01, Number(settings.injectBudgetRatio) || 0.25));
    let used = memTokens + caps.reduce((a, c) => a + (c.tokens || 0), 0);
    let drop = 0;
    while (drop < caps.length && used > budget) { used -= (caps[drop].tokens || 0); drop++; }
    if (drop) caps = caps.slice(drop);

    const parts = [`<mnemosyne_memory>`, MEMORY_HEADER];
    if (memText) parts.push('', memText);
    if (caps.length) {
        parts.push('', '## 近期记录');
        for (const c of caps) parts.push(`· ${c.title ? c.title + ':' : ''}${c.text}`);
    }
    parts.push('</mnemosyne_memory>');
    return parts.join('\n');
}

export function refreshInject(ctx) {
    const s = getSettings(ctx);
    const value = s.enabled ? buildInjection(ctx, s) : '';
    injectStats.applied++;
    ctx.setExtensionPrompt?.(INJECT_KEY, value, Number(s.injectPosition), effectiveDepth(s), false, Number(s.injectRole));
    return value;
}
