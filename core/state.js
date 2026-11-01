// 状态层:chatMetadata 读写、楼层 id、指纹缓存、胶囊校验。
// 性能约束全部落在这里:
//   ① 每条消息的指纹只算一次(WeakMap 缓存,mes 字符串变了才重算);
//   ② 校验只做受影响的那一部分(编辑 → 覆盖该楼的胶囊;删除 → 删除点之后的胶囊;换聊天 → 整本一次);
//   ③ 所有写入走 scheduleSave(),同一个 tick 内的多次改动合并成一次 saveMetadataDebounced;
//   ④ 平时只读,不做整份深拷贝。

export const MNEMO_KEY = 'mnemosyne';
export const DATA_VERSION = 1;

/** 测试台读取的计数器:证明「只核对该核对的」。 */
export const stats = { capsuleChecks: 0, idMapRebuilds: 0, fullVerifies: 0, fingerprintComputes: 0, saves: 0 };

// ── 数据 ──

export function newData() {
    return { v: DATA_VERSION, capsules: [], memory: null, memoryPrev: null, hiddenIds: [], backfill: null };
}

/** 只读:没有就返回 null,不往没用过的聊天里写东西。 */
export function peekData(ctx) {
    const d = ctx.chatMetadata?.[MNEMO_KEY];
    return d && d.v === DATA_VERSION ? d : null;
}

/** 写前调用:没有就建。 */
export function ensureData(ctx) {
    const meta = ctx.chatMetadata;
    if (!meta) throw new Error('chatMetadata 不可用');
    if (!meta[MNEMO_KEY] || meta[MNEMO_KEY].v !== DATA_VERSION) meta[MNEMO_KEY] = newData();
    return meta[MNEMO_KEY];
}

// ── 保存合并 ──
// 酒馆的保存元数据等于整本聊天写一遍,所以只走 saveMetadataDebounced;
// 同一个 tick 里不论调用多少次 scheduleSave,只向酒馆排一次。

let savePending = false;
export function scheduleSave(ctx) {
    if (savePending) return;
    savePending = true;
    queueMicrotask(() => {
        savePending = false;
        stats.saves++;
        try { ctx.saveMetadataDebounced?.(); } catch (err) { console.warn('[Mnemosyne] 保存排队失败', err); }
    });
}

// ── 运行时缓存(按 chatMetadata 对象身份绑定,换聊天自动作废) ──

// 每个 chatMetadata 对象一份运行时缓存(WeakMap):换聊天后旧缓存自然作废,
// 异步任务里拿着旧聊天的 ctx 也不会冲掉新聊天的缓存。
const rtMap = new WeakMap();
function runtime(ctx) {
    const meta = ctx.chatMetadata;
    let r = rtMap.get(meta);
    if (!r) {
        r = {
            refs: null,          // 上次已知的 chat 数组快照(消息对象引用),用于推算删除点
            idMap: new Map(),    // 楼层 id → 下标,取用时自我校验
            idFresh: false,
            hiddenSet: null,     // data.hiddenIds 的 Set 视图
        };
        rtMap.set(meta, r);
    }
    return r;
}
export function resetRuntime(ctx) { if (ctx?.chatMetadata) rtMap.delete(ctx.chatMetadata); }
/** 异步任务返回后判断「还是不是发起请求时的那个聊天」:取酒馆当前的 chatMetadata 做身份比较。 */
export function liveMeta(ctx) {
    try { return globalThis.SillyTavern?.getContext?.().chatMetadata ?? ctx.chatMetadata; } catch { return ctx.chatMetadata; }
}

// ── 指纹 ──

export function fnv1a(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const fpCache = new WeakMap();

/** 单楼指纹。缓存条目里持有 mes 字符串本身:同一对象直接指针相等,字符串被替换(编辑/swipe)才重算。 */
export function fingerprint(msg) {
    const s = typeof msg?.mes === 'string' ? msg.mes : '';
    const hit = fpCache.get(msg);
    if (hit && hit.mes === s) return hit.h;
    const h = fnv1a(s);
    stats.fingerprintComputes++;
    fpCache.set(msg, { mes: s, h });
    return h;
}

// ── 楼层 id ──

export function floorId(msg) { return msg?.extra?.mnemo_id || null; }

function randomId() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

/** 给第 index 层写入稳定 id(已有则原样返回),同步登记到 id 映射。 */
export function assignFloorId(ctx, index) {
    const msg = ctx.chat[index];
    if (!msg) return null;
    const r = runtime(ctx);
    let id = floorId(msg);
    if (!id) {
        do { id = randomId(); } while (r.idMap.has(id));
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
        msg.extra.mnemo_id = id;
    }
    r.idMap.set(id, index);
    return id;
}

function rebuildIdMap(ctx) {
    const r = runtime(ctx);
    const chat = ctx.chat;
    r.idMap.clear();
    for (let i = 0; i < chat.length; i++) {
        const id = chat[i]?.extra?.mnemo_id;
        if (id) r.idMap.set(id, i);
    }
    r.idFresh = true;
    stats.idMapRebuilds++;
}

/** 每个事件开头调一次:本次事件内,id 映射最多整本重建一次。 */
export function beginEvent(ctx) { runtime(ctx).idFresh = false; }

/** id → 下标;映射条目自我校验,失效才重建(本事件内最多一次),找不到返回 -1。 */
export function idIndex(ctx, id) {
    const r = runtime(ctx);
    const i = r.idMap.get(id);
    if (i !== undefined && ctx.chat[i]?.extra?.mnemo_id === id) return i;
    if (!r.idFresh) {
        rebuildIdMap(ctx);
        const j = r.idMap.get(id);
        if (j !== undefined) return j;
    }
    return -1;
}

// ── 本插件隐藏的楼层登记 ──

function hiddenSetOf(ctx) {
    const r = runtime(ctx);
    if (!r.hiddenSet) r.hiddenSet = new Set(peekData(ctx)?.hiddenIds || []);
    return r.hiddenSet;
}
export function isHiddenByUs(ctx, id) { return !!id && hiddenSetOf(ctx).has(id); }
export function markHidden(ctx, id) {
    const set = hiddenSetOf(ctx);
    if (set.has(id)) return false;
    set.add(id);
    ensureData(ctx).hiddenIds.push(id);
    return true;
}
export function unmarkHidden(ctx, id) {
    const set = hiddenSetOf(ctx);
    if (!set.delete(id)) return false;
    const d = ensureData(ctx);
    const k = d.hiddenIds.indexOf(id);
    if (k >= 0) d.hiddenIds.splice(k, 1);
    return true;
}
/** 批量替换登记(整理用),避免逐个 indexOf。 */
export function setHiddenIds(ctx, ids) {
    const d = ensureData(ctx);
    d.hiddenIds = ids;
    runtime(ctx).hiddenSet = new Set(ids);
}

/** 正文楼:不是系统消息,或者是被本插件隐藏的楼。原生系统消息、用户自己 /hide 的楼不算。 */
export function isStory(ctx, msg) {
    if (!msg) return false;
    if (!msg.is_system) return true;
    const id = msg.extra?.mnemo_id;
    return !!id && hiddenSetOf(ctx).has(id);
}

// ── 范围指纹 ──

export function rangeHash(ctx, fromIdx, toIdx) {
    const chat = ctx.chat;
    let h = 2166136261;
    for (let i = fromIdx; i <= toIdx; i++) {
        const m = chat[i];
        if (!isStory(ctx, m)) continue;
        h = Math.imul(h ^ fingerprint(m), 16777619) >>> 0;
    }
    return h.toString(36);
}

// ── chat 快照(推算删除点) ──

export function syncRefs(ctx) {
    runtime(ctx).refs = ctx.chat.slice();
}
/** 追加类事件:只把新增的尾部补进快照,不整本拷贝。 */
export function noteAppend(ctx) {
    const r = runtime(ctx);
    const chat = ctx.chat;
    if (!r.refs || r.refs.length > chat.length) { r.refs = chat.slice(); return; }
    for (let i = r.refs.length; i < chat.length; i++) r.refs.push(chat[i]);
}
/** 删除事件:找出第一处与快照不一致的下标 = 删除点,同时刷新快照。 */
export function consumeDeletePoint(ctx) {
    const r = runtime(ctx);
    const chat = ctx.chat;
    let p = 0;
    if (r.refs) {
        const n = Math.min(r.refs.length, chat.length);
        while (p < n && r.refs[p] === chat[p]) p++;
    }
    r.refs = chat.slice();
    return p;
}

// ── 胶囊解析与查找 ──

export function resolveCapsule(ctx, cap) {
    return { fi: idIndex(ctx, cap.fromId), ti: idIndex(ctx, cap.toId) };
}

/** 当前所有胶囊的范围(按存储顺序),解析不到的 fi/ti 为 -1。 */
export function coverage(ctx, data = peekData(ctx)) {
    if (!data) return [];
    return data.capsules.map(cap => {
        const { fi, ti } = resolveCapsule(ctx, cap);
        return { cap, fi, ti };
    });
}

/** 把胶囊按楼层顺序插入。胶囊几乎总是追加到末尾,从尾部往前找位置。 */
export function insertCapsule(ctx, data, cap) {
    const fi = idIndex(ctx, cap.fromId);
    let k = data.capsules.length;
    while (k > 0 && idIndex(ctx, data.capsules[k - 1].fromId) > fi) k--;
    data.capsules.splice(k, 0, cap);
}

/** 覆盖第 index 层的胶囊(二分,按 fromId 的下标有序)。找不到返回 null。 */
export function findCapsuleCovering(ctx, data, index) {
    const caps = data.capsules;
    let lo = 0, hi = caps.length - 1, best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const fi = idIndex(ctx, caps[mid].fromId);
        if (fi < 0) { // 有缺失的端点:退回线性找,不在坏数据上二分
            for (const c of caps) {
                const r = resolveCapsule(ctx, c);
                if (r.fi >= 0 && r.fi <= index && r.ti >= index) return { cap: c, fi: r.fi, ti: r.ti };
            }
            return null;
        }
        if (fi <= index) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return null;
    const cap = caps[best];
    const { fi, ti } = resolveCapsule(ctx, cap);
    return (fi >= 0 && ti >= index) ? { cap, fi, ti } : null;
}

// ── 校验 ──

function checkCapsule(ctx, cap) {
    const { fi, ti } = resolveCapsule(ctx, cap);
    if (fi < 0 || ti < 0 || ti < fi) return { cap, status: 'gone', fi, ti };
    stats.capsuleChecks++;
    return { cap, status: rangeHash(ctx, fi, ti) === cap.rangeHash ? 'ok' : 'changed', fi, ti };
}

/** 事件后的统一处理入口。返回 { invalidated, foldedTouched, notices },调用方负责取消隐藏、重算注入。 */
function applyChecks(ctx, results, point) {
    const data = peekData(ctx);
    const out = { invalidated: [], foldedTouched: [], notices: [], changed: false };
    if (!data) return out;
    for (const res of results) {
        if (res.status === 'ok') continue;
        const cap = res.cap;
        const k = data.capsules.indexOf(cap);
        if (k < 0) continue;
        if (cap.folded) {
            if (res.status === 'changed') {
                cap.rangeHash = rangeHash(ctx, res.fi, res.ti); // 已折叠的不回滚,只提示
                out.foldedTouched.push(res.fi >= 0 ? res.fi : point);
            } else if (repairFolded(ctx, cap, res, point)) {
                out.foldedTouched.push(point);
            } else {
                data.capsules.splice(k, 1);
                out.foldedTouched.push(point);
            }
            out.changed = true;
            continue;
        }
        data.capsules.splice(k, 1);
        out.invalidated.push(cap);
        out.changed = true;
    }
    return out;
}

/** 已折叠胶囊的端点被删:能修就修(收缩到幸存的楼),修不了返回 false 交调用方移除。 */
function repairFolded(ctx, cap, res, point) {
    const chat = ctx.chat;
    let { fi, ti } = res;
    if (fi < 0 && ti < 0) return false;
    if (fi < 0) { // 起点被删:新起点 = 删除点处的第一个正文楼
        fi = point;
        while (fi < chat.length && !isStory(ctx, chat[fi])) fi++;
    }
    if (ti < 0) { // 终点被删:新终点 = 删除点之前最后一个正文楼
        ti = point - 1;
        while (ti >= 0 && !isStory(ctx, chat[ti])) ti--;
    }
    if (fi < 0 || ti < 0 || fi > ti || fi >= chat.length) return false;
    const a = assignFloorId(ctx, fi), b = assignFloorId(ctx, ti);
    cap.fromId = a; cap.toId = b;
    cap.rangeHash = rangeHash(ctx, fi, ti);
    return true;
}

/** 编辑/swipe 第 index 层:只核对覆盖这一层的那个胶囊。 */
export function verifyFloor(ctx, index) {
    const data = peekData(ctx);
    const msg = ctx.chat[index];
    if (!data || !data.capsules.length || !floorId(msg)) return applyChecks(ctx, [], index);
    const hit = findCapsuleCovering(ctx, data, index);
    if (!hit) return applyChecks(ctx, [], index);
    return applyChecks(ctx, [checkCapsule(ctx, hit.cap)], index);
}

/** 删除:point 之后的胶囊才需要核对;端点缺失的直接判失效。 */
export function verifyAfter(ctx, point) {
    const data = peekData(ctx);
    if (!data || !data.capsules.length) return applyChecks(ctx, [], point);
    const results = [];
    for (const cap of data.capsules.slice()) {
        const { fi, ti } = resolveCapsule(ctx, cap);
        if (fi < 0 || ti < 0 || ti < fi) { results.push({ cap, status: 'gone', fi, ti }); continue; }
        if (ti < point) continue;               // 整段在删除点之前:不受影响
        results.push(checkCapsule(ctx, cap));
    }
    return applyChecks(ctx, results, point);
}

/** 换聊天:整本核对一次。 */
export function verifyAll(ctx) {
    stats.fullVerifies++;
    const data = peekData(ctx);
    if (!data || !data.capsules.length) return applyChecks(ctx, [], 0);
    return applyChecks(ctx, data.capsules.slice().map(cap => checkCapsule(ctx, cap)), 0);
}

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

export async function countTokens(ctx, text) {
    try {
        if (typeof ctx.getTokenCountAsync === 'function') {
            const n = await ctx.getTokenCountAsync(String(text || ''));
            if (Number.isFinite(n)) return n;
        }
    } catch { /* 退回估算 */ }
    return estimateTokens(text);
}

export function maxContextSize(ctx) {
    if (ctx.mainApi === 'openai') {
        const cc = ctx.chatCompletionSettings || {};
        const size = Number(cc.openai_max_context) - Number(cc.openai_max_tokens || 0);
        if (Number.isFinite(size) && size > 0) return size;
    }
    return Number(ctx.maxContext) > 0 ? Number(ctx.maxContext) : 8192;
}

// ── 楼层辅助 ──

/** 保留区起点:从末尾数第 reserve 个正文楼的下标;chat 里的正文楼不足 reserve 个时为 0。 */
export function reserveBoundary(ctx, reserve) {
    const chat = ctx.chat;
    let left = Math.max(0, Math.floor(reserve));
    if (left === 0) return chat.length;
    let i = chat.length - 1;
    for (; i >= 0; i--) {
        if (isStory(ctx, chat[i])) { left--; if (left === 0) break; }
    }
    return Math.max(0, i);
}

export function summary(ctx) {
    const data = peekData(ctx);
    if (!data) return { capsules: 0, unfolded: 0, memoryChars: 0, hidden: 0, coveredTo: -1 };
    const caps = data.capsules;
    let coveredTo = -1;
    if (caps.length) coveredTo = idIndex(ctx, caps[caps.length - 1].toId);
    return {
        capsules: caps.length,
        unfolded: caps.filter(c => !c.folded).length,
        memoryChars: (data.memory?.text || '').length,
        hidden: data.hiddenIds.length,
        coveredTo,
    };
}
