// 前情分篇章:memory.chapters = [{ id, fromId, toId, text, gen, ts }],按时间顺序。
// sections.prelude 是派生值(各篇正文用空行拼接),注入、显示、润色核对都继续读它。
// 旧数据没有 chapters 时,读取只在内存里把 prelude 推导成一篇,不写回;下一次写入(折叠、编辑)才落地。

import { idIndex } from './state.js';
import { asText, estimateTokens, sectionsFromText } from './memory.js';

export const LEGACY_CHAPTER_ID = 'ch-legacy';
export const makeChapterId = () => 'ch' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

/** 已折叠札记覆盖的整段楼层(推导旧前情的范围用);没有已折叠札记时两端为 null。 */
function foldedSpan(caps) {
    let first = null, last = null;
    for (const c of caps || []) {
        if (!c.folded) continue;
        if (!first) first = c;
        last = c;
    }
    return { fromId: first?.fromId ?? null, toId: last?.toId ?? null };
}

/** 当前篇章列表(只读,可能是推导出来的);没有长期记忆或没有前情返回空数组。 */
export function chaptersOf(mem, caps) {
    if (!mem) return [];
    if (Array.isArray(mem.chapters) && mem.chapters.length) return mem.chapters;
    const text = asText((mem.sections || sectionsFromText(mem.text)).prelude);
    if (!text) return [];
    return [{ id: LEGACY_CHAPTER_ID, ...foldedSpan(caps), text, gen: 1, ts: mem.ts || 0 }];
}

export const joinChapters = (chs) => chs.map(c => asText(c.text)).filter(Boolean).join('\n\n');

export const chaptersTokens = (chs) => chs.reduce((n, c) => n + estimateTokens(c.text), 0);

/** 篇章覆盖的楼号标签:`#起–止` / `#起`;楼层已不存在时返回空串。 */
export function chapterLabel(ctx, ch) {
    const fi = ch.fromId ? idIndex(ctx, ch.fromId) : -1;
    const ti = ch.toId ? idIndex(ctx, ch.toId) : -1;
    if (fi < 0 && ti < 0) return '';
    const a = (fi < 0 ? ti : fi) + 1, b = (ti < 0 ? fi : ti) + 1;
    return a === b ? `#${a}` : `#${a}–${b}`;
}

/** 编辑框里前情一节的文本:每篇前面一行 `### #起–止`。 */
export function chaptersEditText(ctx, chs) {
    return chs.map(c => `### ${chapterLabel(ctx, c) || '#?'}\n${asText(c.text)}`).join('\n\n');
}

const MARK_RE = /^###\s*(#[\d?]+(?:\s*[–—~-]\s*[\d?]+)?)\s*$/;
const normLabel = (l) => l.replace(/\s+/g, '').replace(/[—~-]/g, '–');

/**
 * 编辑后的前情文本 → 篇章列表。按 `### #a–b` 切开:楼号能对上原篇章的保留它的 id、范围、gen,只换正文;
 * 对不上的段、标记之前的游离文字、完全没有标记的整段,各当一篇 gen = 1,范围取原有第一篇的起点和最后一篇的终点。空段丢掉。
 */
export function chaptersFromEdit(ctx, text, old) {
    const src = String(text || '');
    const first = old[0], last = old[old.length - 1];
    const span = { fromId: first?.fromId ?? null, toId: last?.toId ?? null };
    const chunks = [];
    let cur = { label: null, lines: [] };
    for (const line of src.split('\n')) {
        const m = line.match(MARK_RE);
        if (m) { chunks.push(cur); cur = { label: normLabel(m[1]), lines: [] }; } else cur.lines.push(line);
    }
    chunks.push(cur);
    const used = new Set();
    const out = [];
    for (const ch of chunks) {
        const body = ch.lines.join('\n').trim();
        if (!body) continue;
        let hit = null;
        if (ch.label) {
            hit = old.find(o => !used.has(o.id) && normLabel(chapterLabel(ctx, o) || '#?') === ch.label) || null;
        }
        if (hit) { used.add(hit.id); out.push({ ...hit, text: body }); } else {
            out.push({ id: makeChapterId(), ...span, text: body, gen: 1, ts: Date.now() });
        }
    }
    return out;
}

/** 面板用:篇章 + 各自的楼号标签。 */
export function chapterViews(ctx, mem, caps) {
    return chaptersOf(mem, caps).map(c => ({ ch: c, label: chapterLabel(ctx, c) }));
}

