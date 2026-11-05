// 从楼层原文提取摘要(不调用模型):规则 = 标签 或 折叠块;另有「扫最新一楼列出全部标签」的候选检测。
// 纯字符串逻辑,不碰酒馆;一律从原始 mes 里取(不经提纯,提纯可能把这些标签删掉)。

import { isStory } from './state.js';

export const EXTRACT_MAX = 1500;
export const TITLE_MAX = 24;
const NAME = '[\\p{L}_][\\p{L}\\p{N}_-]*';
const NAME_RE = new RegExp(`^${NAME}$`, 'u');
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 每个聊天的来源设置,缺了就按默认(自己写)。 */
export function normalizeSource(raw) {
    const out = { mode: 'llm', rule: { type: 'tag', tag: 'abstract' }, foreshadowTag: '' };
    if (!raw || typeof raw !== 'object') return out;
    if (raw.mode === 'extract') out.mode = 'extract';
    const r = raw.rule;
    if (r && r.type === 'details' && typeof r.title === 'string' && r.title.trim()) out.rule = { type: 'details', title: r.title.trim() };
    else if (r && r.type === 'tag' && NAME_RE.test(String(r.tag || '').trim())) out.rule = { type: 'tag', tag: String(r.tag).trim() };
    const f = String(raw.foreshadowTag || '').trim();
    out.foreshadowTag = NAME_RE.test(f) ? f : '';
    return out;
}
export const sourceOf = (data) => normalizeSource(data?.source);
export const isNameOk = (s) => NAME_RE.test(String(s || '').trim());
export function sourceLabel(src) {
    if (src.mode !== 'extract') return '自己写';
    return `从楼层提取:${src.rule.type === 'details' ? '折叠块「' + src.rule.title + '」' : src.rule.tag}`;
}

/** 内部标签壳去掉、空白合并、截断。换行保留(标题和伏笔按行取)。 */
export function cleanContent(raw, max = EXTRACT_MAX) {
    const s = String(raw || '')
        .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ');
    const lines = s.split('\n').map(l => l.replace(/[ \t　]+/g, ' ').trim()).filter(Boolean);
    return lines.join('\n').slice(0, max);
}

/** 最后一个 <tag>…</tag> 的内容(未清理);没有返回 null。 */
export function lastTagContent(mes, tag) {
    if (!isNameOk(tag)) return null;
    const t = escRe(tag);
    const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}\\s*>`, 'giu');
    let last = null;
    for (const m of String(mes || '').matchAll(re)) last = m[1];
    return last;
}

/** 扫出所有成对的折叠块(处理嵌套):[{ title, content, pos }],title 已去空白。 */
export function scanDetails(mes) {
    const src = String(mes || '');
    const out = [];
    const stack = [];
    for (const m of src.matchAll(/<details\b[^>]*>|<\/details\s*>/gi)) {
        if (m[0][1] !== '/') { stack.push({ pos: m.index, end: m.index + m[0].length }); continue; }
        const o = stack.pop();
        if (!o) continue;
        const inner = src.slice(o.end, m.index);
        const sm = inner.match(/^\s*<summary[^>]*>([\s\S]*?)<\/summary\s*>/i);
        if (!sm) continue;
        out.push({ title: sm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ''), content: inner.slice(sm[0].length), pos: o.pos });
    }
    return out.sort((a, b) => a.pos - b.pos);
}

/** 按规则从一条消息取摘要(已清理);取不到返回 ''。 */
export function extractFromMes(mes, rule) {
    if (!rule) return '';
    if (rule.type === 'details') {
        const want = String(rule.title || '').replace(/\s+/g, '');
        if (!want) return '';
        let hit = null;
        for (const d of scanDetails(mes)) if (d.title === want) hit = d;
        return hit ? cleanContent(hit.content) : '';
    }
    const raw = lastTagContent(mes, rule.tag);
    return raw == null ? '' : cleanContent(raw);
}

/** 伏笔标签的内容 → 按行拆开,去掉行首的列表符号。 */
export function foreshadowLines(mes, tag, max = 5) {
    if (!tag) return [];
    const raw = lastTagContent(mes, tag);
    if (raw == null) return [];
    const out = [];
    for (const l of cleanContent(raw).split('\n')) {
        const t = l.replace(/^[-*·•・]\s*/, '').trim();
        if (t && !out.includes(t)) out.push(t);
        if (out.length >= max) break;
    }
    return out;
}

/** 标题:第一行去掉行首「单字或双字 + ｜」的前缀后的前 24 字。 */
export function titleFromText(text) {
    const first = String(text || '').split('\n')[0].trim();
    const t = first.replace(/^[^\s｜|]{1,2}[｜|]\s*/, '').trim() || first;
    return t.slice(0, TITLE_MAX);
}

/**
 * 一轮 → 提取结果。只看这一轮的 AI 楼。取不到摘要返回 null。
 * 返回 { text, title, points: [{k,t,key}] }(points 只来自伏笔标签)。
 */
export function extractRound(ctx, round, source, maxPoints = 5) {
    const parts = [];
    const fore = [];
    for (const i of round.idxs) {
        const m = ctx.chat[i];
        if (!m || m.is_user) continue;
        const t = extractFromMes(m.mes, source.rule);
        if (t) parts.push(t);
        for (const l of foreshadowLines(m.mes, source.foreshadowTag, maxPoints)) if (!fore.includes(l)) fore.push(l);
    }
    if (!parts.length) return null;
    const text = parts.join('\n');
    const points = fore.slice(0, Math.max(0, maxPoints)).map(t => ({ k: '伏笔', t: t.slice(0, 120), key: '' }));
    return { text, title: titleFromText(text), points };
}

// ── 候选检测:只扫最新一个 AI 正文楼,把里面的标签全部列出(点击时才跑,不放进事件处理) ──

const PREVIEW = 60;

/** 返回 { floor, tags: [{ tag, preview }], details: [{ title, preview }] };没有 AI 楼返回 floor=-1。 */
export function detectCandidates(ctx) {
    const chat = ctx.chat || [];
    let k = chat.length - 1;
    while (k >= 0 && !(isStory(ctx, chat[k]) && !chat[k].is_user)) k--;
    if (k < 0) return { floor: -1, tags: [], details: [] };
    const mes = String(chat[k].mes || '');
    const names = [];
    const re = new RegExp(`<(${NAME})(?=[\\s>/])`, 'gu');
    for (const m of mes.matchAll(re)) {
        const n = m[1];
        if (/^(details|summary)$/i.test(n) || names.includes(n)) continue;
        names.push(n);
    }
    const tags = names.map(tag => ({ tag, preview: cleanContent(lastTagContent(mes, tag) ?? '', PREVIEW).replace(/\n/g, ' ').slice(0, PREVIEW) }));
    const seen = new Set();
    const details = [];
    for (const d of scanDetails(mes)) {
        if (seen.has(d.title)) { details[details.findIndex(x => x.title === d.title)].preview = cleanContent(d.content, PREVIEW).replace(/\n/g, ' ').slice(0, PREVIEW); continue; }
        seen.add(d.title);
        details.push({ title: d.title, preview: cleanContent(d.content, PREVIEW).replace(/\n/g, ' ').slice(0, PREVIEW) });
    }
    return { floor: k, tags, details };
}
