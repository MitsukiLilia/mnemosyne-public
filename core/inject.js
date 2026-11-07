// 注入:长期记忆分节 + 筛选后的锚点 + 未折叠胶囊,经 setExtensionPrompt 放进提示词(或由 {{mnemosyne}} 宏输出)。
// 拼装顺序:前情 / 人物与关系 / 当前状态 / 时间线 / 未结事项 / 锚点 / 近期记录。
// 人物与关系只注入在场的和最近提到的;当前状态优先用比长期记忆更新的胶囊快照;每次构建顺带记一份统计(injectStats.last)。
// 锚点筛选:伏笔、约定、推测没了结就始终注入;其余类别(含物品的来历与现状)只在 key(任一别名)出现于最近几层正文时注入;key 为空的只在锚点总数不多时注入。
// 预算超了先丢最旧的胶囊,再丢最旧的非伏笔锚点;分节不裁。
// 每条消息事件都会重算一次,代价只与「最近 N 楼文本 + 锚点数」有关。

import { peekData, maxContextSize, isStory, estimateTokens } from './state.js';
import { getSettings, effectiveDepth } from './settings.js';
import { MEMORY_HEADER, PEOPLE_HEADER, POINT_KINDS, SECTION_KEYS, SECTION_TITLES, ANCHOR_TITLE } from './prompts.js';
import { PEOPLE_LIMIT, parsePeople, presentLine, selectPeople } from './people.js';
import { activeAnchors, anchorLine, asText, keysOf, sectionsFromText } from './memory.js';

export const INJECT_KEY = 'mnemosyne_memory';
export const MACRO_NAME = 'mnemosyne';
/** applied:交给酒馆的次数(测试台用);last:上次构建的统计(只放内存,不存档)。 */
export const injectStats = { applied: 0, last: null };
export const PART_KEYS = ['prelude', 'people', 'now', 'timeline', 'open', 'anchors', 'recent'];

// 锚点行文本与 token 估值按 point 对象缓存(每次收发消息都会重算注入,不重复估算)
const lineCache = new WeakMap();
function lineOf(a) {
    let hit = lineCache.get(a.p);
    const sig = `${a.t}\u0001${a.d || ''}\u0001${a.now?.t || ''}`; // 物品的来历、现状变了也要重算
    if (!hit || hit.sig !== sig || hit.k !== a.k) {
        const line = anchorLine(a) + (a.k === '推测' ? '（未证实）' : '');
        hit = { k: a.k, sig, line, tok: estimateTokens(line) + 1 };
        lineCache.set(a.p, hit);
    }
    return hit;
}

/** key 为空的锚点,总数不超过这个值才注入。 */
const KEYLESS_LIMIT = 30;
const ALWAYS_KINDS = new Set(['伏笔', '约定', '推测']);

// 分节注入文本按 memory 对象缓存(memory 只整体替换,不原地改分节);人物块的解析结果也挂在这里
const secCache = new WeakMap();
// 时间线只注入最近 tl 条:更早的事前情里已经讲过,全量注入会让时间线成为最长的一节。tl ≤ 0 = 全量。
function tailTimeline(v, tl) {
    if (!(tl > 0)) return { text: v, cut: 0 };
    const lines = v.split('\n').filter(l => l.trim());
    if (lines.length <= tl) return { text: v, cut: 0 };
    return { text: lines.slice(-tl).join('\n'), cut: lines.length - tl };
}

function sectionBlock(mem, tl = 0) {
    const sections = mem.sections || sectionsFromText(mem.text);
    const hit = secCache.get(mem);
    if (hit && hit.sections === sections && hit.peopleSrc === sections.people && hit.tl === tl) return hit;
    const texts = {}, toks = {};
    SECTION_KEYS.forEach((k, i) => {
        let v = asText(sections[k]);
        let title = SECTION_TITLES[i];
        if (k === 'timeline' && v) {
            const t = tailTimeline(v, tl);
            if (t.cut) { v = t.text; title += `(最近 ${tl} 条,更早的见前情)`; }
        }
        texts[k] = v ? `## ${title}\n${v}` : '';
        toks[k] = v ? estimateTokens(texts[k]) : 0;
    });
    const out = { sections, peopleSrc: sections.people, tl, texts, toks, blocks: parsePeople(asText(sections.people)) };
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

/**
 * 锚点筛选:返回要注入的锚点(保持来源顺序)。
 * rejected 给了数组就把被筛掉的记进去:{ id, why: 'recent' | 'keyless' };getRecent 可复用外面算好的最近文本。
 */
export function selectAnchors(ctx, data, settings, rejected = null, getRecent = null) {
    const all = activeAnchors(data);
    if (!all.length) return all;
    const keyless = all.length <= KEYLESS_LIMIT;
    let recent = null;
    const memo = new Map();
    const recentOf = getRecent || (() => recentText(ctx, Number(settings.anchorRecentFloors) || 8));
    return all.filter(a => {
        if (ALWAYS_KINDS.has(a.k)) return true;
        const keys = keysOf(a);
        if (!keys.length) { if (!keyless) rejected?.push({ id: a.id, why: 'keyless' }); return keyless; }
        let hit = false;
        for (const key of keys) { // 任意一个别名出现在最近文本里就算命中;memo 按单个别名缓存
            let h = memo.get(key);
            if (h === undefined) {
                if (recent === null) recent = recentOf();
                h = recent.includes(key);
                memo.set(key, h);
            }
            if (h) { hit = true; break; }
        }
        if (!hit) rejected?.push({ id: a.id, why: 'recent' });
        return hit;
    });
}

/** 比长期记忆更新的胶囊(未折叠)里,最新一个带现场快照的。 */
function latestCapNow(data) {
    const caps = data.capsules;
    for (let i = caps.length - 1; i >= 0; i--) {
        if (caps[i].folded) return '';
        if (caps[i].now) return caps[i].now;
    }
    return '';
}

export function buildInjection(ctx, settings) {
    const data = peekData(ctx);
    if (!data) return '';
    const mem = data.memory;
    const sec = mem ? sectionBlock(mem, Math.floor(Number(settings.timelineInjectLines) || 0)) : null;
    const capNow = latestCapNow(data);
    let caps = data.capsules.filter(c => !c.folded && c.text);
    const rejected = [];
    let recentMemo = null;
    const getRecent = () => (recentMemo ??= recentText(ctx, Number(settings.anchorRecentFloors) || 8));
    let anchors = mem ? selectAnchors(ctx, data, settings, rejected, getRecent) : [];

    // 人物动线:只注入在场的和最近提到过的
    const nowRaw = capNow || (sec ? asText(sec.sections.now) : '');
    let peopleText = '', peopleIn = [], peopleOut = 0;
    if (sec && asText(sec.sections.people)) {
        if (!sec.blocks.length) peopleText = sec.texts.people; // 解析不出人物块:整段原样
        else {
            const sel = selectPeople(sec.blocks, presentLine(nowRaw), getRecent(), PEOPLE_LIMIT);
            peopleOut = sel.outCount;
            peopleIn = sel.chosen.map(b => b.names[0]);
            if (sel.chosen.length) peopleText = `## 人物与关系\n${PEOPLE_HEADER}\n${sel.chosen.map(b => b.raw).join('\n')}`;
        }
    }
    const nowText = nowRaw ? `## 当前状态\n${nowRaw}` : '';
    const secParts = {
        prelude: sec?.texts.prelude || '', people: peopleText, now: nowText,
        timeline: sec?.texts.timeline || '', open: sec?.texts.open || '',
    };
    const secTok = {
        prelude: sec?.toks.prelude || 0, people: peopleText ? estimateTokens(peopleText) : 0,
        now: nowText ? estimateTokens(nowText) : 0, timeline: sec?.toks.timeline || 0, open: sec?.toks.open || 0,
    };
    const secSum = Object.values(secTok).reduce((a, b) => a + b, 0);
    if (!secSum && !anchors.length && !caps.length) return '';

    const budget = Math.floor(maxContextSize(ctx) * Math.max(0.01, Number(settings.injectBudgetRatio) || 0.25));
    const aTok = anchors.map(a => lineOf(a).tok);
    let used = secSum + caps.reduce((a, c) => a + (c.tokens || 0), 0) + aTok.reduce((a, b) => a + b, 0);
    let drop = 0;
    while (drop < caps.length && used > budget) { used -= (caps[drop].tokens || 0); drop++; }
    if (drop) caps = caps.slice(drop);
    if (used > budget) { // 再丢最旧的非伏笔锚点
        const keepIdx = [];
        for (let i = 0; i < anchors.length; i++) {
            if (used > budget && anchors[i].k !== '伏笔') { used -= aTok[i]; rejected.push({ id: anchors[i].id, why: 'budget' }); continue; }
            keepIdx.push(i);
        }
        anchors = keepIdx.map(i => anchors[i]);
    }

    const body = [];
    for (const k of SECTION_KEYS) if (secParts[k]) body.push(secParts[k]);
    const parts = [`<mnemosyne_memory>`, MEMORY_HEADER];
    if (body.length) parts.push('', body.join('\n\n'));
    let anchorTok = 0;
    if (anchors.length) {
        const lines = [];
        for (const k of POINT_KINDS) for (const a of anchors) if (a.k === k) lines.push(lineOf(a).line);
        parts.push('', `## ${ANCHOR_TITLE}`, ...lines);
        anchorTok = anchors.reduce((t, a) => t + lineOf(a).tok, 0);
    }
    let recentTok = 0;
    if (caps.length) {
        parts.push('', '## 近期记录');
        for (const c of caps) { parts.push(`· ${c.title ? c.title + ':' : ''}${c.text}`); recentTok += c.tokens || 0; }
    }
    parts.push('</mnemosyne_memory>');

    const stat = { prelude: secTok.prelude, people: secTok.people, now: secTok.now, timeline: secTok.timeline, open: secTok.open, anchors: anchorTok, recent: recentTok };
    injectStats.last = {
        ts: Date.now(), tokens: Object.values(stat).reduce((a, b) => a + b, 0), parts: stat,
        peopleIn, peopleOut, anchorsIn: anchors.map(a => a.id), anchorsOut: rejected,
    };
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
