// 自动记录 + 补建历史。单任务串行:同一时刻只有一个任务在跑(busy),其余请求合并成「待办」标记,
// 当前任务结束时补跑一次,不并发、不排长队。
//
// 术语:
//   正文楼  = isStory(非原生系统消息);
//   一轮    = 连续的用户楼 + 其后的角色楼(连续角色楼并入同一轮);
//   完整轮  = 整轮都在保留区之前,且后面接的是用户楼(或没有后文)。
// 断点不靠游标:每次都从「哪些楼还没被胶囊覆盖」重新推出来,所以中途编辑/删楼不会错位。

import {
    assignFloorId, countTokens, coverage, ensureData, estimateTokens, fingerprint, insertCapsule,
    isStory, maxContextSize, peekData, rangeHash, reserveBoundary, resolveCapsule, scheduleSave,
    beginEvent, summary, liveMeta,
} from './state.js';
import { getSettings } from './settings.js';
import { generateJson, llmOptsFrom } from './llm.js';
import { cleanMessageText, ensureRegexEngine } from './purify.js';
import { PROMPT_CAPSULE } from './prompts.js';
import { status, emitChange, setError } from './bus.js';
import { foldNow, foldWhileNeeded, needsFold } from './fold.js';
import { refreshInject } from './inject.js';
import { hideRange } from './hide.js';

/** 测试台用:规划阶段(不含 LLM 等待)累计耗时。 */
export const perf = { planMs: 0, plans: 0, recordMs: 0 };
export const config = { kickDelay: 300 };

let busy = false;
let autoWanted = false;
let kickTimer = null;
let genStartedAt = 0;
let ctxRef = null;

// ── 生成状态(酒馆正在生成时别抢) ──

export function setGenerating(on) {
    status.generating = !!on;
    genStartedAt = on ? Date.now() : 0;
}
function isGenerating() {
    // 保险:GENERATION_ENDED 万一丢了,3 分钟后不再视为生成中
    if (status.generating && Date.now() - genStartedAt > 180000) status.generating = false;
    return status.generating;
}

// ── 轮的收集 ──

const estCache = new WeakMap();
function floorCost(msg) {
    const s = typeof msg.mes === 'string' ? msg.mes : '';
    const hit = estCache.get(msg);
    if (hit && hit.mes === s) return hit.t;
    const t = estimateTokens(s) + 8;
    estCache.set(msg, { mes: s, t });
    return t;
}

/**
 * 收集 [startIdx, boundary) 内、未被胶囊覆盖的完整轮。max 限制最多收几轮(提前结束,省遍历)。
 * ignoreCoverage=true 时无视现有胶囊(重写单个胶囊用)。
 */
export function collectRounds(ctx, startIdx, boundary, { max = Infinity, ignoreCoverage = false } = {}) {
    const chat = ctx.chat;
    const ranges = ignoreCoverage ? [] : coverage(ctx).filter(r => r.fi >= 0 && r.ti >= r.fi)
        .map(r => [r.fi, r.ti]).sort((a, b) => a[0] - b[0]);
    let ri = 0;
    const rounds = [];
    let cur = null;
    const close = (complete) => {
        if (cur && complete && cur.hasChar) rounds.push({ fi: cur.idxs[0], ti: cur.idxs[cur.idxs.length - 1], idxs: cur.idxs });
        cur = null;
    };
    let i = startIdx;
    for (; i < boundary && rounds.length < max; i++) {
        while (ri < ranges.length && ranges[ri][1] < i) ri++;
        if (ri < ranges.length && ranges[ri][0] <= i) { // 已覆盖:整段跳过,当前轮在此收尾
            close(true);
            i = ranges[ri][1];
            continue;
        }
        const m = chat[i];
        if (!isStory(ctx, m)) continue;
        if (m.is_user) {
            if (cur && cur.hasChar) close(true);
            if (!cur) cur = { idxs: [], hasChar: false };
            cur.idxs.push(i);
        } else {
            if (!cur) cur = { idxs: [], hasChar: false };
            cur.idxs.push(i);
            cur.hasChar = true;
        }
    }
    if (cur && rounds.length < max) {
        // 走到边界:后面紧跟的正文楼若是角色楼,说明这一轮的尾巴在保留区里,不算完整
        let j = i;
        while (j < chat.length && !isStory(ctx, chat[j])) j++;
        const next = chat[j];
        close(!next || next.is_user);
    }
    return rounds;
}

function roundCost(ctx, round) {
    let t = 0;
    for (const i of round.idxs) t += floorCost(ctx.chat[i]);
    return t;
}

/** 把若干轮按 token 预算与轮数上限切成批。 */
export function packRounds(ctx, rounds, settings) {
    const budget = Math.max(500, Math.floor(maxContextSize(ctx) * Math.max(0.05, Number(settings.batchBudgetRatio) || 0.4)));
    const maxRounds = Math.max(1, Math.floor(Number(settings.batchMaxRounds) || 12));
    const packs = [];
    let cur = [], used = 0;
    for (const r of rounds) {
        const c = roundCost(ctx, r);
        if (cur.length && (cur.length >= maxRounds || used + c > budget)) { packs.push(cur); cur = []; used = 0; }
        cur.push(r); used += c;
    }
    if (cur.length) packs.push(cur);
    return packs;
}

/** 供界面显示:当前有多少轮已移出保留区、还没被覆盖。 */
export function countPending(ctx) {
    const s = getSettings(ctx);
    const boundary = reserveBoundary(ctx, s.reserve);
    return collectRounds(ctx, 0, boundary).length;
}

// ── 一批 → 胶囊 ──

function speaker(ctx, msg) { return msg.name || (msg.is_user ? ctx.name1 : ctx.name2) || (msg.is_user ? 'User' : 'Char'); }

function buildBatchText(ctx, rounds, excludeTags) {
    const chat = ctx.chat;
    const depthOf = new Map();
    const minIdx = rounds[0].fi;
    let d = 0;
    for (let i = chat.length - 1; i >= minIdx; i--) {
        if (isStory(ctx, chat[i])) depthOf.set(i, d++);
    }
    return rounds.map((r, k) => {
        const lines = r.idxs.map(i => {
            const t = cleanMessageText(ctx, chat[i], depthOf.get(i) ?? 0, excludeTags);
            return `${speaker(ctx, chat[i])}:${t || '(无正文)'}`;
        });
        return `【第${k + 1}轮】\n${lines.join('\n')}`;
    }).join('\n\n');
}

/** 模型输出 → 规范化的 [{a,b,title,text}](轮号 1 起,闭区间,互不重叠,按轮号排序)。 */
export function normalizeCapsules(parsed, n) {
    const list = Array.isArray(parsed?.capsules) ? parsed.capsules : (Array.isArray(parsed) ? parsed : []);
    const used = new Set();
    const out = [];
    const hasRounds = list.some(it => Array.isArray(it?.rounds) || Number.isInteger(it?.round));
    list.forEach((it, idx) => {
        let rs = [];
        if (Array.isArray(it?.rounds)) rs = it.rounds.map(Number).filter(Number.isInteger);
        else if (Number.isInteger(it?.round)) rs = [it.round];
        else if (!hasRounds && list.length === n) rs = [idx + 1]; // 没带轮号但条数恰好对上:按顺序对应
        if (!rs.length) return;
        const a = Math.min(...rs), b = Math.max(...rs);
        if (a < 1 || b > n || b - a + 1 !== new Set(rs).size) return; // 越界或不连续
        for (let k = a; k <= b; k++) if (used.has(k)) return;
        const text = String(it?.text ?? '').trim();
        if (!text) return;
        for (let k = a; k <= b; k++) used.add(k);
        out.push({ a, b, title: String(it?.title ?? '').trim(), text });
    });
    out.sort((x, y) => x.a - y.a);
    return out;
}

function makeCapId() { return 'c' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

/** 请求 + 提交一批。返回新增胶囊数;抛错表示失败(调用方设错误状态)。 */
async function recordBatch(ctx, rounds) {
    const settings = getSettings(ctx);
    const meta = ctx.chatMetadata;
    const chat = ctx.chat;
    // 请求发出时的快照:返回后逐楼核对,变了就整批作废
    const snap = rounds.map(r => r.idxs.map(i => ({ msg: chat[i], fp: fingerprint(chat[i]) })));

    await ensureRegexEngine();
    const tA = performance.now();
    const user = buildBatchText(ctx, rounds, settings.excludeTags);
    const tB = performance.now();
    const parsed = await generateJson(ctx, PROMPT_CAPSULE, user, llmOptsFrom(settings));
    const tC = performance.now();
    const items = normalizeCapsules(parsed, rounds.length);
    if (!items.length) throw new Error('模型没有返回可用的记录');

    // 先把所有异步的事做完(token 计数),之后的提交全在同一个 tick 内,保存只会排一次
    const tokens = [];
    for (const it of items) tokens.push(await countTokens(ctx, it.title ? `${it.title}:${it.text}` : it.text));

    // 过期核对:聊天换了、或这些楼被改过/删过,放弃这一批
    if (liveMeta(ctx) !== meta) return 0;
    beginEvent(ctx);
    for (let r = 0; r < rounds.length; r++) {
        for (let k = 0; k < rounds[r].idxs.length; k++) {
            const i = rounds[r].idxs[k], s = snap[r][k];
            if (ctx.chat[i] !== s.msg || fingerprint(s.msg) !== s.fp) return 0;
        }
    }

    const data = ensureData(ctx);
    const limit = reserveBoundary(ctx, settings.reserve);
    let added = 0;
    items.forEach((it, k) => {
        const fi = rounds[it.a - 1].fi, ti = rounds[it.b - 1].ti;
        for (let r = it.a - 1; r <= it.b - 1; r++) for (const i of rounds[r].idxs) assignFloorId(ctx, i);
        const cap = {
            id: makeCapId(), fromId: assignFloorId(ctx, fi), toId: assignFloorId(ctx, ti),
            rangeHash: rangeHash(ctx, fi, ti), // 必须在隐藏之前算:隐藏前后的正文楼集合相同,指纹一致
            title: it.title, text: it.text, tokens: tokens[k], folded: false, ts: Date.now(),
        };
        insertCapsule(ctx, data, cap);
        hideRange(ctx, fi, ti, limit);
        status.backfill.coveredTo = Math.max(status.backfill.coveredTo, ti);
        added++;
    });
    scheduleSave(ctx);
    refreshInject(ctx);
    emitChange();
    perf.recordMs += (tB - tA) + (performance.now() - tC); // 不含 LLM 等待
    return added;
}

// ── 互斥执行 ──

async function runExclusive(name, fn) {
    if (busy) return { skipped: 'busy' };
    busy = true;
    status.busy = name;
    emitChange();
    try {
        return await fn();
    } finally {
        busy = false;
        status.busy = null;
        emitChange();
        if (autoWanted) pump(); // 任务期间攒下的待办,补跑一次
    }
}

// ── 自动记录 ──

export function kick(ctx, delay = config.kickDelay) {
    ctxRef = ctx;
    const s = getSettings(ctx);
    if (!s.enabled || !s.autoRecord) return;
    autoWanted = true;
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => { kickTimer = null; pump(); }, delay);
}

async function pump() {
    const ctx = ctxRef;
    if (!ctx || busy || !autoWanted) return;
    const s = getSettings(ctx);
    if (!s.enabled || !s.autoRecord) { autoWanted = false; return; }
    if (status.backfill.running) return;           // 补建期间自动记录暂停,补建结束会补跑
    if (isGenerating()) return;                    // 等 GENERATION_ENDED 再来
    autoWanted = false;
    await runExclusive('auto', async () => {
        try {
            for (let guard = 0; guard < 20; guard++) {
                const t0 = performance.now();
                const boundary = reserveBoundary(ctx, s.reserve);
                const rounds = collectRounds(ctx, 0, boundary, { max: Math.max(1, s.autoMaxRounds) + 1 });
                perf.planMs += performance.now() - t0; perf.plans++;
                if (!rounds.length) { status.backlog = 0; break; }
                if (rounds.length > s.autoMaxRounds) { status.backlog = countPending(ctx); emitChange(); break; } // 积压太多:交给补建
                status.backlog = 0;
                const pack = packRounds(ctx, rounds, s)[0];
                const added = await recordBatch(ctx, pack);
                setError(null);
                if (!added) break;
                if (needsFold(ctx)) await foldWhileNeeded(ctx);
                if (isGenerating()) { autoWanted = true; break; }
            }
        } catch (err) {
            console.warn('[Mnemosyne] 自动记录失败', err);
            setError(err); // 失败不重试轰炸:标记失败,等下一次事件或手动再试
        }
    });
}

function pumpable() {
    return !!ctxRef && !isGenerating() && !status.backfill.running
        && getSettings(ctxRef).enabled && getSettings(ctxRef).autoRecord;
}

/** 测试台:等到没有任务、没有定时器、没有还能跑的待办。 */
export async function whenIdle(timeoutMs = 8000) {
    const t0 = Date.now();
    while (busy || kickTimer || (autoWanted && pumpable())) {
        if (Date.now() - t0 > timeoutMs) throw new Error('whenIdle 超时');
        await new Promise(r => setTimeout(r, 0));
    }
}

export function resetRecorderRuntime() {
    clearTimeout(kickTimer); kickTimer = null; autoWanted = false;
    status.backfill = { running: false, stopRequested: false, done: 0, batch: 0, batches: 0, coveredTo: -1, finished: false };
    status.backlog = 0; status.error = null; status.notices = [];
}

// ── 补建历史 ──

export function stopBackfill() {
    if (status.backfill.running) { status.backfill.stopRequested = true; emitChange(); }
}

export async function startBackfill(ctx) {
    ctxRef = ctx;
    if (busy) return { skipped: 'busy' };
    const s = getSettings(ctx);
    const bf = status.backfill;
    return await runExclusive('backfill', async () => {
        const data = ensureData(ctx);
        if (bf.finished) { bf.done = 0; bf.finished = false; }
        bf.running = true; bf.stopRequested = false;
        bf.coveredTo = summary(ctx).coveredTo;
        data.backfill = { running: true, failedAt: null };
        scheduleSave(ctx);
        setError(null);
        let outcome = 'stopped';
        let failIdx = null;
        try {
            await ensureRegexEngine();
            for (;;) {
                if (bf.stopRequested) break;
                const boundary = reserveBoundary(ctx, s.reserve);
                const rounds = collectRounds(ctx, 0, boundary);
                if (!rounds.length) { outcome = 'finished'; break; }
                const packs = packRounds(ctx, rounds, s);
                bf.batch = bf.done + 1;
                bf.batches = bf.done + packs.length;
                failIdx = packs[0][0].fi;
                emitChange();
                const added = await recordBatch(ctx, packs[0]);
                if (!added) { outcome = 'stale'; break; }
                bf.done++;
                if (needsFold(ctx)) await foldWhileNeeded(ctx); // 攒够阈值就顺手折叠,不让胶囊堆几百个
            }
            if (outcome === 'finished') { bf.finished = true; status.backlog = 0; }
        } catch (err) {
            console.warn('[Mnemosyne] 补建失败', err);
            setError(err);
            outcome = 'failed';
            data.backfill.failedAt = failIdx;
        } finally {
            bf.running = false; bf.stopRequested = false;
            data.backfill.running = false;
            scheduleSave(ctx);
            if (outcome === 'finished' || outcome === 'stopped') autoWanted = true;
            emitChange();
        }
        return { outcome };
    });
}

// ── 按原文重写单个胶囊 ──

export async function rewriteCapsule(ctx, capId) {
    return await runExclusive('rewrite', async () => {
        const settings = getSettings(ctx);
        const data = peekData(ctx);
        const cap = data?.capsules.find(c => c.id === capId);
        if (!cap) throw new Error('找不到这个胶囊');
        if (cap.folded) throw new Error('已折叠的胶囊没有保留文本,无法重写');
        beginEvent(ctx);
        const { fi, ti } = resolveCapsule(ctx, cap);
        if (fi < 0 || ti < fi) throw new Error('原文楼层已不存在');
        const rounds = collectRounds(ctx, fi, ti + 1, { ignoreCoverage: true });
        if (!rounds.length) throw new Error('找不到对应的原文');
        await ensureRegexEngine();
        const parsed = await generateJson(ctx, PROMPT_CAPSULE, buildBatchText(ctx, rounds, settings.excludeTags), llmOptsFrom(settings));
        const items = normalizeCapsules(parsed, rounds.length);
        if (!items.length) throw new Error('模型没有返回可用的记录');
        const text = items.map(i => i.text).join('');
        const title = items[0].title;
        const tokens = await countTokens(ctx, title ? `${title}:${text}` : text);
        if (!data.capsules.includes(cap)) return { skipped: 'stale' };
        cap.text = text; cap.title = title; cap.tokens = tokens; cap.ts = Date.now();
        scheduleSave(ctx);
        refreshInject(ctx);
        return { ok: true };
    });
}

/** 手动立即折叠(长期记忆页的按钮)。 */
export async function foldNowExclusive(ctx) {
    ctxRef = ctx;
    return await runExclusive('fold', async () => {
        return await foldNow(ctx);
    });
}

