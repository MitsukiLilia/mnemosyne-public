// 注入:长期记忆分节 + 筛选后的锚点 + 未折叠胶囊,经 setExtensionPrompt 放进提示词(或由 {{mnemosyne}} 宏输出)。
// 拼装顺序:前情 / 人物与关系 / 当前状态 / 时间线 / 未结事项 / 锚点 / 近期记录。
// 锚点筛选:伏笔、约定没了结就始终注入;其余类别只在 key 出现于最近几层正文时注入;key 为空的只在锚点总数不多时注入。
// 预算超了先丢最旧的胶囊,再丢最旧的非伏笔锚点;分节不裁。
// 每条消息事件都会重算一次,代价只与「最近 N 楼文本 + 锚点数」有关。

import { peekData, maxContextSize, isStory, estimateTokens } from './state.js';
import { getSettings, effectiveDepth } from './settings.js';
import { MEMORY_HEADER, POINT_KINDS, SECTION_KEYS, SECTION_TITLES, ANCHOR_TITLE } from './prompts.js';
import { activeAnchors, anchorLine, asText, sectionsFromText } from './memory.js';

export const INJECT_KEY = 'mnemosyne_memory';
export const MACRO_NAME = 'mnemosyne';
export const injectStats = { applied: 0 };

// 锚点行文本与 token 估值按 point 对象缓存(每次收发消息都会重算注入,不重复估算)
const lineCache = new WeakMap();
function lineOf(a) {
    let hit = lineCache.get(a.p);
    if (!hit || hit.t !== a.t || hit.k !== a.k) {
        const line = anchorLine(a);
        hit = { k: a.k, t: a.t, line, tok: estimateTokens(line) + 1 };
        lineCache.set(a.p, hit);
    }
    return hit;
}

/** key 为空的锚点,总数不超过这个值才注入。 */
const KEYLESS_LIMIT = 30;
const ALWAYS_KINDS = new Set(['伏笔', '约定']);

// 分节注入文本按 memory 对象缓存(memory 只整体替换,不原地改分节)
const secCache = new WeakMap();
function sectionBlock(mem) {
    const sections = mem.sections || sectionsFromText(mem.text);
    const hit = secCache.get(mem);
    if (hit && hit.sections === sections) return hit;
    const parts = [];
    SECTION_KEYS.forEach((k, i) => {
        const v = asText(sections[k]);
        if (v) parts.push(`## ${SECTION_TITLES[i]}\n${v}`);
    });
    const text = parts.join('\n\n');
    const out = { sections, text, tokens: text ? estimateTokens(text) : 0 };
    secCache.set(mem, out);
    return out;
}

/** 最近 n 层正文楼的原文拼成一个字符串(只算一次)。 */
function recentText(ctx, n) {
    const chat = ctx.chat || [];
    let left = Math.max(0, Math.floor(n));
    const parts = [];
    for (let i = chat.length - 1; i >= 0 && left > 0; i--) {
        const m = chat[i];
        if (!isStory(ctx, m)) continue;
        parts.push(typeof m.mes === 'string' ? m.mes : '');
        left--;
    }
    return parts.join('\n');
}

/** 锚点筛选:返回要注入的锚点(保持来源顺序)。 */
export function selectAnchors(ctx, data, settings) {
    const all = activeAnchors(data);
    if (!all.length) return all;
    const keyless = all.length <= KEYLESS_LIMIT;
    let recent = null;
    const memo = new Map();
    return all.filter(a => {
        if (ALWAYS_KINDS.has(a.k)) return true;
        if (!a.key) return keyless;
        let hit = memo.get(a.key);
        if (hit === undefined) {
            if (recent === null) recent = recentText(ctx, Number(settings.anchorRecentFloors) || 8);
            hit = recent.includes(a.key);
            memo.set(a.key, hit);
        }
        return hit;
    });
}

export function buildInjection(ctx, settings) {
    const data = peekData(ctx);
    if (!data) return '';
    const mem = data.memory;
    const sec = mem ? sectionBlock(mem) : null;
    let caps = data.capsules.filter(c => !c.folded && c.text);
    let anchors = mem ? selectAnchors(ctx, data, settings) : [];
    if (!sec?.text && !anchors.length && !caps.length) return '';

    const budget = Math.floor(maxContextSize(ctx) * Math.max(0.01, Number(settings.injectBudgetRatio) || 0.25));
    const aTok = anchors.map(a => lineOf(a).tok);
    let used = (sec?.tokens || 0) + caps.reduce((a, c) => a + (c.tokens || 0), 0) + aTok.reduce((a, b) => a + b, 0);
    let drop = 0;
    while (drop < caps.length && used > budget) { used -= (caps[drop].tokens || 0); drop++; }
    if (drop) caps = caps.slice(drop);
    if (used > budget) { // 再丢最旧的非伏笔锚点
        const keepIdx = [];
        for (let i = 0; i < anchors.length; i++) {
            if (used > budget && anchors[i].k !== '伏笔') { used -= aTok[i]; continue; }
            keepIdx.push(i);
        }
        anchors = keepIdx.map(i => anchors[i]);
    }

    const parts = [`<mnemosyne_memory>`, MEMORY_HEADER];
    if (sec?.text) parts.push('', sec.text);
    if (anchors.length) {
        const lines = [];
        for (const k of POINT_KINDS) for (const a of anchors) if (a.k === k) lines.push(lineOf(a).line);
        parts.push('', `## ${ANCHOR_TITLE}`, ...lines);
    }
    if (caps.length) {
        parts.push('', '## 近期记录');
        for (const c of caps) parts.push(`· ${c.title ? c.title + ':' : ''}${c.text}`);
    }
    parts.push('</mnemosyne_memory>');
    return parts.join('\n');
}

/** 宏的输出:与自动注入同一份文本;插件关闭时为空。 */
export function macroText(ctx) {
    const s = getSettings(ctx);
    return s.enabled ? buildInjection(ctx, s) : '';
}

/** 重算并交给酒馆。injectMode='macro' 时传空串,只靠宏。返回实际交给酒馆的文本。 */
export function refreshInject(ctx) {
    const s = getSettings(ctx);
    const value = s.enabled && s.injectMode !== 'macro' ? buildInjection(ctx, s) : '';
    injectStats.applied++;
    ctx.setExtensionPrompt?.(INJECT_KEY, value, Number(s.injectPosition), effectiveDepth(s), false, Number(s.injectRole));
    return value;
}

/**
 * 注册 {{mnemosyne}} 宏。优先新宏引擎的 macros.register(name, { handler, description }),
 * 退回旧的 registerMacro,都没有就跳过。返回用了哪条路径('macros.register' | 'registerMacro' | null)。
 */
export function registerMacro(ctx, getCtx) {
    const handler = () => { try { return macroText(getCtx()); } catch { return ''; } };
    const description = '输出 Mnemosyne 的长期记忆(分节、锚点、近期记录)。在设置里把注入方式切到「宏」后,由预设自己决定放在哪里。';
    try {
        if (typeof ctx.macros?.register === 'function') {
            ctx.macros.register(MACRO_NAME, { handler, description });
            return 'macros.register';
        }
        if (typeof ctx.registerMacro === 'function') {
            ctx.registerMacro(MACRO_NAME, handler, description);
            return 'registerMacro';
        }
    } catch (err) {
        console.warn('[Mnemosyne] 宏注册失败', err);
    }
    return null;
}
