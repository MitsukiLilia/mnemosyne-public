// 关键词召回旧记录:折叠后胶囊保留正文,日后剧情重新提到那一段时,把原始记录带回注入。
// 纯本地匹配,不调模型、不用向量:
//   · 索引 = 已折叠且有正文的胶囊的候选词(cap.keys + 它 points 的 key 别名);按数据变化缓存,数据不变不重建;
//   · 太常见的词(出现在超过 25% 的已折叠胶囊里,且这类胶囊不少于 8 个)整体丢掉,防止主要人物名每轮都命中;
//   · 匹配只看「最近几楼文本」(与锚点筛选共用同一次取文本),命中词按单层楼缓存。

import { keysOf } from './memory.js';

export const recallStats = { builds: 0 };

const MIN_WORD = 2;          // 单字词几乎每轮都出现,不收
const COMMON_RATIO = 0.25;
const COMMON_MIN_CAPS = 8;
const RARE_SHARE = 3;        // 只被 1～3 个胶囊共享的词算 2 分
const MIN_SCORE = 2;

const cache = new WeakMap();

/** 索引:{ entries: [{ cap, words }], df: Map<词, 共享它的胶囊数>, words: [词...] }。 */
export function buildRecallIndex(data) {
    const caps = data.capsules;
    let folded = 0, firstF = '', lastF = '';
    for (const c of caps) if (c.folded) { if (!folded) firstF = c.id; lastF = c.id; folded++; }
    const sig = `${caps.length}|${folded}|${firstF}|${lastF}`;
    const hit = cache.get(data);
    if (hit && hit.sig === sig) return hit.idx;

    recallStats.builds++;
    const base = [];
    for (const cap of caps) {
        if (!cap.folded || !cap.text) continue;
        const words = new Set();
        for (const k of Array.isArray(cap.keys) ? cap.keys : []) { const w = String(k || '').trim(); if (w.length >= MIN_WORD) words.add(w); }
        for (const p of cap.points || []) for (const w of keysOf(p)) if (w.length >= MIN_WORD) words.add(w);
        base.push({ cap, words: [...words] });
    }
    const df = new Map();
    for (const e of base) for (const w of e.words) df.set(w, (df.get(w) || 0) + 1);
    if (base.length >= COMMON_MIN_CAPS) {
        const limit = base.length * COMMON_RATIO;
        for (const [w, n] of df) if (n > limit) df.delete(w);
    }
    const entries = base.map(e => ({ cap: e.cap, words: e.words.filter(w => df.has(w)) })).filter(e => e.words.length);
    const idx = { entries, df, words: [...df.keys()] };
    cache.set(data, { sig, idx });
    return idx;
}

// 命中词按「索引 + 单层楼文本」缓存:每条消息事件只有新出现的那一层要扫描,其余层直接取缓存。
// 词里没有换行,所以逐层匹配与拼起来匹配结果相同。
const PART_CACHE_MAX = 64;
let partMemo = { idx: null, map: new Map() };
function hitsOfPart(idx, text) {
    if (partMemo.idx !== idx) partMemo = { idx, map: new Map() };
    let hit = partMemo.map.get(text);
    if (!hit) {
        hit = [];
        for (const w of idx.words) if (text.includes(w)) hit.push(w);
        if (partMemo.map.size >= PART_CACHE_MAX) partMemo.map.clear();
        partMemo.map.set(text, hit);
    }
    return hit;
}

/**
 * 选出要召回的旧记录:[{ cap, score, hits: [命中的词] }],得分高的在前,同分更早的在前,最多 max 条。
 * 得分 = 命中的不同词数,只被 1～3 个胶囊共享的词算 2 分;得分 ≥ 2 才入选。
 * getParts 返回最近几层楼的文本数组(与锚点筛选共用同一次取文本)。
 */
export function selectRecall(data, max, getParts) {
    const n = Math.floor(Number(max) || 0);
    if (n <= 0 || !data?.capsules?.length) return [];
    const idx = buildRecallIndex(data);
    if (!idx.entries.length) return [];
    const hits = new Set();
    for (const text of getParts()) if (text) for (const w of hitsOfPart(idx, text)) hits.add(w);
    if (!hits.size) return [];
    const out = [];
    idx.entries.forEach((e, order) => {
        let score = 0;
        const matched = [];
        for (const w of e.words) {
            if (!hits.has(w)) continue;
            matched.push(w);
            score += idx.df.get(w) <= RARE_SHARE ? 2 : 1;
        }
        if (score >= MIN_SCORE) out.push({ cap: e.cap, score, hits: matched, order });
    });
    out.sort((a, b) => b.score - a.score || a.order - b.order);
    return out.slice(0, n);
}
