// 长期记忆的纯数据逻辑(不碰酒馆、不碰异步):分节 ⇄ 文本、锚点派生、版本链回退、旧版迁移。
// 锚点不单独存正文:它是「已折叠胶囊的 points 去掉 retired」得到的派生视图,
// 所以润色改不了它,删胶囊时它也跟着消失。

import { ANCHOR_TITLE, POINT_KINDS, SECTION_KEYS, SECTION_TITLES } from './prompts.js';

// ── token 估算(预算用,同步、O(长度)) ──
// 中日韩字符约 1 token/字,其余约 4 字符/token。精确计数留给写入时的 getTokenCountAsync。

export function estimateTokens(text) {
    const s = String(text || '');
    let cjk = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
    }
    return Math.ceil(cjk + (s.length - cjk) / 4);
}

// ── 分节 ⇄ 文本 ──

const EMPTY_MARK = '(暂无)';
const asText = (v) => (Array.isArray(v) ? v.map(String).join('\n') : String(v ?? '')).trim();
export { asText };

const HEAD_RE = new RegExp(`^##\\s*(${[...SECTION_TITLES, ANCHOR_TITLE].join('|')})\\s*$`, 'gm');

/** 按固定标题切开(兼容旧的四节文本,缺的节给空串)。键是中文标题;锚点节单列在 ANCHOR_TITLE 下。 */
export function parseSections(text) {
    const src = String(text || '');
    const out = Object.fromEntries([...SECTION_TITLES, ANCHOR_TITLE].map(t => [t, '']));
    const marks = [...src.matchAll(HEAD_RE)];
    for (let i = 0; i < marks.length; i++) {
        const start = marks[i].index + marks[i][0].length;
        const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
        out[marks[i][1]] = src.slice(start, end).trim();
    }
    return out;
}

/** 文本 → { prelude, people, now, timeline, open }。标题之前的游离文字并入前情;完全没有标题则整段当前情。 */
export function sectionsFromText(text) {
    const src = String(text || '');
    const raw = parseSections(src);
    const sec = {};
    SECTION_KEYS.forEach((k, i) => { const v = raw[SECTION_TITLES[i]]; sec[k] = v === EMPTY_MARK ? '' : v; });
    const first = src.search(HEAD_RE);
    const pre = (first === -1 ? src : src.slice(0, first)).trim();
    if (pre) sec.prelude = sec.prelude ? `${pre}\n${sec.prelude}` : pre;
    return sec;
}

/** 分节(+ 锚点文本)→ 全文。锚点为空就不出「## 锚点」一节。 */
export function composeMemory(sections, anchorText = '') {
    const parts = SECTION_KEYS.map((key, i) => `## ${SECTION_TITLES[i]}\n${asText(sections?.[key]) || EMPTY_MARK}`);
    if (anchorText) parts.push(`## ${ANCHOR_TITLE}\n${anchorText}`);
    return parts.join('\n\n');
}

export function cloneMemory(mem) {
    return mem ? JSON.parse(JSON.stringify(mem)) : null;
}

// ── 锚点 ──

export const pointId = (cap, i) => `${cap.id}:${i}`;

const POINT_KEY_MAX = 40;
const POINT_TEXT_MAX = 120;
const POINT_ORIGIN_MAX = 120; // 物品的来历 d
const ALIAS_MAX = 3;
export const ITEM_KIND = '物品';
export const ITEM_NOW_MAX = 60;

/** key 可以用「/」写最多 3 个别名;拆分、去空、去重。入参可以是锚点、点或 key 字符串。 */
export function keysOf(a) {
    const raw = typeof a === 'string' ? a : a?.key;
    const out = [];
    for (const part of String(raw ?? '').split('/')) {
        const k = part.trim();
        if (k && !out.includes(k)) out.push(k);
        if (out.length >= ALIAS_MAX) break;
    }
    return out;
}

const CAP_KEYS_MAX = 6;
const CAP_KEY_LEN = 20;
/** 胶囊的召回关键词:去空、去重、每个最长 20 字、最多 6 个;数组或用逗号/顿号/斜杠分隔的字符串都收。 */
export function normalizeKeys(raw) {
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[\/,，、;；\n]/) : []);
    const out = [];
    for (const it of list) {
        const k = String(it ?? '').replace(/\s+/g, ' ').trim().slice(0, CAP_KEY_LEN);
        if (k && !out.includes(k)) out.push(k);
        if (out.length >= CAP_KEYS_MAX) break;
    }
    return out;
}

/** 必留点解析:格式不对、类别不认识的丢掉,永远返回数组(不因为它让整个胶囊失败)。 */
export function normalizePoints(raw, max = 5) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const p of raw) {
        if (out.length >= max) break;
        if (!p || typeof p !== 'object') continue;
        const k = String(p.k ?? '').trim();
        if (!POINT_KINDS.includes(k)) continue;
        const t = String(p.t ?? '').replace(/\s+/g, ' ').trim().slice(0, POINT_TEXT_MAX);
        if (!t || seen.has(k + t)) continue;
        seen.add(k + t);
        const pt = { k, t, key: keysOf(p.key).join('/').slice(0, POINT_KEY_MAX) };
        if (k === ITEM_KIND) { // 来历只属于物品;空串当没有
            const d = String(p.d ?? '').replace(/\s+/g, ' ').trim().slice(0, POINT_ORIGIN_MAX);
            if (d) pt.d = d;
        }
        out.push(pt);
    }
    return out;
}

/** 人物动线条目:[{ who, t }],最多 4 条;格式不对当空。 */
export function normalizeShifts(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const it of raw) {
        if (out.length >= 4) break;
        if (!it || typeof it !== 'object') continue;
        const who = String(it.who ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
        const t = String(it.t ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (who && t) out.push({ who, t });
    }
    return out;
}

/** 现场快照:字符串(数组按行拼);其他类型当空。 */
export function normalizeNow(raw) {
    const s = Array.isArray(raw) ? raw.map(String).join('\n') : (typeof raw === 'string' ? raw : '');
    return s.split('\n').map(l => l.trim()).filter(Boolean).join('\n').slice(0, 400);
}

/**
 * 派生锚点:folded 胶囊(或 extraIds 里的胶囊,折叠提交前预演用)的 points 去掉 retired。
 * 返回 [{ id, k, t, key, at, d, now, cap, p }],顺序 = 胶囊顺序 × 序号。
 * d = 物品的来历(在点上);now = 物品的现状(itemNow[id],可不传)。
 */
export function deriveAnchors(caps, retired, extraIds = null, itemNow = null) {
    const out = [];
    const ret = retired || {};
    for (const cap of caps) {
        if (!cap.folded && !(extraIds && extraIds.has(cap.id))) continue;
        const pts = cap.points;
        if (!Array.isArray(pts)) continue;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const id = p.id || pointId(cap, i);
            if (ret[id] !== undefined) continue;
            out.push({ id, k: p.k, t: p.t, key: p.key || '', at: p.at, d: p.d || '', now: itemNow?.[id] || null, cap, p });
        }
    }
    return out;
}

/** 当前生效的锚点;没有长期记忆就没有锚点。 */
export function activeAnchors(data) {
    return data?.memory ? deriveAnchors(data.capsules, data.memory.retired, null, data.memory.itemNow) : [];
}

/** 已撤下的锚点(含结果),面板底部折叠区用。 */
export function retiredAnchors(data) {
    const ret = data?.memory?.retired;
    if (!ret || !Object.keys(ret).length) return [];
    const out = [];
    for (const cap of data.capsules) {
        if (!cap.folded || !Array.isArray(cap.points)) continue;
        cap.points.forEach((p, i) => {
            const id = p.id || pointId(cap, i);
            if (ret[id] !== undefined) out.push({ id, k: p.k, t: p.t, key: p.key || '', at: p.at, d: p.d || '', cap, result: ret[id] });
        });
    }
    return out;
}

/** 注入与全文用的锚点行;物品多带「来历」和「现状」,空的部分省略。 */
export function anchorLine(a) {
    let s = `[${a.k}] ${a.t}`;
    if (a.k === ITEM_KIND) {
        if (a.d) s += `｜来历:${a.d}`;
        if (a.now?.t) s += `｜现状:${a.now.t}`;
    }
    return s;
}

/** 锚点 → 「[类别] 内容」每行一条,按类别分组(组内保持来源顺序)。 */
export function anchorsText(anchors) {
    const lines = [];
    for (const k of POINT_KINDS) for (const a of anchors) if (a.k === k) lines.push(anchorLine(a));
    return lines.join('\n');
}

/** 同步重算 memory.text(分节 + 全部生效锚点)与 tokens 估值;注入不读这份,它只用于显示、导出和手动编辑。 */
export function rebuildText(data) {
    const mem = data?.memory;
    if (!mem) return;
    mem.text = composeMemory(mem.sections, anchorsText(activeAnchors(data)));
    mem.tokens = estimateTokens(mem.text);
}

// ── 锚点去重(只在折叠时跑,O(锚点数²),平时收发消息不碰) ──
// 不同胶囊常把同一件事各记一条(同一约定被重申、同一数字在物品和数字里各记一次)。
// 判重:内容互相包含,或者用字相似度高,或者(仅约定、称呼)同类别且 key 互相包含;台词只认相同或互相包含。
// 保留较新的一条(代表最新状态);旧的那条完整包含新的,或同一约定旧的写得更长时,保留旧的(信息更全)。
// 两条重复的物品,带来历 d 的优先保留(来历不经模型改写,丢了就补不回来)。

const normT = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
function bigrams(s) {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
}
function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n / (a.size + b.size - n);
}
const NUMERIC_KINDS = new Set(['物品', '数字']); // 这两类常互相重记
const KEY_KINDS = new Set(['约定', '称呼']);

// 数字(阿拉伯数字与中文数字)不同就是不同的事:「两张票」≠「三张票」
const NUM_RE = /\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿半]+/g;
const numsOf = (s) => (s.match(NUM_RE) || []).join(',');

function isDup(a, b) {
    if (a.num !== b.num && a.num && b.num) return false;
    const contains = a.n.length >= 4 && b.n.length >= 4 && (a.n.includes(b.n) || b.n.includes(a.n));
    if (a.n === b.n || contains) return true;
    if (a.k === '台词' || b.k === '台词') return false;
    const sameKind = a.k === b.k || (NUMERIC_KINDS.has(a.k) && NUMERIC_KINDS.has(b.k));
    if (!sameKind) return false;
    // key 重叠只对约定、称呼算重复(同一约定被重申、称呼被更新);物品同名常是不同事件(得到/使用/送出),不能并
    // key 有别名时,任意一对别名互相包含就算重叠
    if (KEY_KINDS.has(a.k) && a.k === b.k && a.keys.some(x => b.keys.some(y => Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))))) return true;
    return jaccard(a.g, b.g) >= 0.6;
}

/**
 * anchors 按来源顺序(旧→新)。返回 { [被合并的 id]: 结果 },调用方并进 retired。
 * keptOf 给了对象就记下 { [被合并的 id]: 保留的那条 id },调用方据此挪现状。
 */
export function dedupeAnchors(anchors, keptOf = null) {
    const items = anchors.map(a => { const n = normT(a.t); return { a, k: a.k, keys: keysOf(a).map(normT).filter(Boolean), n, g: bigrams(n), num: numsOf(n) }; });
    const kept = [];
    const drop = {};
    for (let i = items.length - 1; i >= 0; i--) { // 从新到旧
        const it = items[i];
        if (!it.n) { kept.push(it); continue; }
        const hit = kept.find(k => k.n && isDup(it, k));
        if (!hit) { kept.push(it); continue; }
        const bothItems = it.k === ITEM_KIND && hit.k === ITEM_KIND && !!it.a.d !== !!hit.a.d;
        const fuller = bothItems ? !!it.a.d
            : it.n.length > hit.n.length && (it.n.includes(hit.n) || (it.k === '约定' && hit.k === '约定'));
        if (fuller) { // 旧的包含新的(或同一约定旧的写得更全、旧的物品带来历):换成保留旧的
            drop[hit.a.id] = `与「${it.a.t.slice(0, 30)}」重复,已合并`;
            if (keptOf) keptOf[hit.a.id] = it.a.id;
            kept[kept.indexOf(hit)] = it;
        } else {
            drop[it.a.id] = `与「${hit.a.t.slice(0, 30)}」重复,已合并`;
            if (keptOf) keptOf[it.a.id] = hit.a.id;
        }
    }
    return drop;
}

// ── 物品现状(itemNow) ──

/** 模型的 items → [{ id, now, at, merge }],格式不对的丢掉(id 是否合法由 applyItems 对着锚点判断)。 */
export function normalizeItems(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const it of raw) {
        const id = String(it?.id ?? '').trim();
        if (!id) continue;
        const now = String(it?.now ?? '').replace(/\s+/g, ' ').trim().slice(0, ITEM_NOW_MAX);
        const at = Number.isInteger(Number(it?.at)) && it?.at !== null && it?.at !== '' ? Number(it.at) : null;
        const merge = Array.isArray(it?.merge) ? it.merge.map(x => String(x ?? '').trim()).filter(Boolean) : [];
        out.push({ id, now, at, merge });
    }
    return out;
}

/**
 * 应用模型的 items(纯函数)。anchors = 提交前预演的生效锚点(已去掉 resolved 撤下的),按来源顺序(旧→新)。
 * 只认其中 k === '物品' 的 id;合并时主条优先取最早的、带来历 d 的那条,其余并入 retired 候选。
 * atOk(n) 判断现状楼号是否合法,不合法则 at 置空、现状文字保留。
 * 返回 { itemNow: 新表, merged: { [被并入的 id]: 结果 } }。
 */
export function applyItems(rawItems, anchors, oldItemNow, atOk = () => true) {
    const itemNow = {};
    for (const [id, v] of Object.entries(oldItemNow || {})) if (v && typeof v === 'object') itemNow[id] = { t: String(v.t ?? ''), at: v.at ?? null };
    const merged = {};
    const order = new Map();
    const byId = new Map();
    anchors.forEach((a, i) => { if (a.k === ITEM_KIND) { byId.set(a.id, a); order.set(a.id, i); } });
    for (const it of normalizeItems(rawItems)) {
        if (!byId.has(it.id) || merged[it.id]) continue;
        const group = [it.id];
        for (const m of it.merge) if (byId.has(m) && !merged[m] && !group.includes(m)) group.push(m);
        const withD = group.filter(id => byId.get(id).d).sort((x, y) => order.get(x) - order.get(y));
        const primary = withD.length ? withD[0] : it.id;
        const others = group.filter(id => id !== primary);
        for (const o of others) merged[o] = `并入「${byId.get(primary).t.slice(0, 30)}」`;
        if (it.now) {
            itemNow[primary] = { t: it.now, at: it.at !== null && atOk(it.at) ? it.at : null };
        } else if (!itemNow[primary]) { // 这次没给现状:继承被并入的那条里最新的
            const from = others.filter(o => itemNow[o]).sort((x, y) => order.get(y) - order.get(x))[0];
            if (from) itemNow[primary] = itemNow[from];
        }
        for (const o of others) delete itemNow[o];
    }
    return { itemNow, merged };
}

// ── 版本链 ──

/** 链里第一个吞掉 capId 的版本下标;不在链里返回 -1。 */
export function versionIndexOf(data, capId) {
    const vs = data?.versions || [];
    for (let j = 0; j < vs.length; j++) if (vs[j].foldedIds?.includes(capId)) return j;
    return -1;
}

/** 链里所有版本吞掉的胶囊 id(这些胶囊保留 text,也不参与占位合并)。 */
export function protectedIds(data) {
    const s = new Set();
    for (const v of data?.versions || []) for (const id of v.foldedIds || []) s.add(id);
    return s;
}

/**
 * 回退到第 j 版之前:memory = versions[j].before;j 到最新这几版吞掉的胶囊恢复成未折叠(goneIds 里的直接移除);
 * versions 截到 j 之前。返回 { restored, removed }。
 */
export function rollbackVersions(data, j, goneIds = new Set()) {
    const vs = data.versions;
    const byId = new Map(data.capsules.map(c => [c.id, c]));
    const out = { restored: 0, removed: 0 };
    for (let k = j; k < vs.length; k++) {
        for (const id of vs[k].foldedIds || []) {
            const cap = byId.get(id);
            if (!cap) continue;
            if (goneIds.has(id)) { data.capsules.splice(data.capsules.indexOf(cap), 1); byId.delete(id); out.removed++; continue; }
            if (cap.folded) { cap.folded = false; out.restored++; }
        }
    }
    data.memory = vs[j].before || null;
    vs.length = j;
    if (data.memory) rebuildText(data);
    return out;
}

// ── 旧版迁移 ──

export const DATA_VERSION = 2;

/** v1 → v2 的纯变换(在副本上做,成功后由调用方一次性写回)。 */
function migrateV1(d) {
    // 先严格校验:结构不对就整个放弃(调用方保留原数据),不要「宽容」成空数据
    if (!Array.isArray(d.capsules) || !d.capsules.every(c => c && typeof c === 'object' && typeof c.id === 'string')) throw new Error('capsules 结构异常');
    if (!Array.isArray(d.hiddenIds)) throw new Error('hiddenIds 结构异常');
    const nd = { ...d };
    nd.capsules = d.capsules.map(c => ({ ...c, points: Array.isArray(c.points) ? c.points : [] }));
    const byId = new Map(nd.capsules.map(c => [c.id, c]));
    const toMem = (m) => {
        if (!m || typeof m.text !== 'string' || !m.text.trim()) return null;
        const sections = sectionsFromText(m.text);
        const mem = { sections, retired: {}, text: '', tokens: m.tokens || 0, ts: m.ts || 0 };
        mem.text = composeMemory(sections, '');
        return mem;
    };
    nd.memory = toMem(d.memory);
    nd.versions = [];
    const prev = d.memoryPrev;
    if (prev && typeof prev === 'object') {
        const ids = (prev.undo?.ids || []).filter(id => byId.has(id));
        // v1 折叠时把正文挪进了 undo.texts;新结构要求链里的胶囊保留 text,迁移时放回去
        for (const id of ids) {
            const saved = prev.undo?.texts?.[id];
            const cap = byId.get(id);
            if (saved && cap && !cap.text) { cap.title = saved.title ?? cap.title; cap.text = saved.text || ''; cap.tokens = saved.tokens || 0; }
        }
        nd.versions.push({ ts: prev.ts || Date.now(), before: toMem(prev), foldedIds: ids });
    }
    delete nd.memoryPrev;
    nd.v = 2;
    return nd;
}

const failedMigration = new WeakSet();

/**
 * 把任意旧版数据对象原地升到当前版本。成功返回 true(含已是最新);
 * 失败(变换抛错、结果校验不过、版本比本插件还新)返回 false,原对象一个字节都不动,并在控制台报警。
 */
export function migrateData(d) {
    if (!d || typeof d !== 'object') return false;
    if (d.v === DATA_VERSION) return true;
    if (failedMigration.has(d)) return false;
    try {
        if (!(d.v >= 1 && d.v < DATA_VERSION)) throw new Error(`无法识别的数据版本 ${d.v}(本插件支持到 ${DATA_VERSION})`);
        let nd = JSON.parse(JSON.stringify(d)); // 在副本上做:中途出错原数据完整保留
        if (nd.v === 1) nd = migrateV1(nd);
        if (!Array.isArray(nd.capsules) || !Array.isArray(nd.versions) || !Array.isArray(nd.hiddenIds)) {
            throw new Error('迁移结果结构不完整');
        }
        for (const k of Object.keys(d)) delete d[k];
        Object.assign(d, nd);
        return true;
    } catch (err) {
        failedMigration.add(d);
        console.error('[Mnemosyne] 旧版数据迁移失败,已保留原数据(本聊天暂不记录;请勿清除,联系作者)', err);
        return false;
    }
}
