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
    beginEvent, summary, liveMeta, idIndex,
} from './state.js';
import { getSettings } from './settings.js';
import { generateJson, llmOptsFrom } from './llm.js';
import { cleanMessageText, ensureRegexEngine } from './purify.js';
import { capsulePrompt } from './prompts.js';
import { normalizePoints, normalizeShifts, normalizeNow } from './memory.js';
import { extractRound, normalizeSource, sourceOf } from './extract.js';
import { clueBlock, prescanClues } from './prescan.js';
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
        .map(r => [r.fi, r.ti]).concat(skippedRanges(ctx)).sort((a, b) => a[0] - b[0]);
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

export { normalizePoints };

/** 模型输出 → 规范化的 [{a,b,title,text,points,shifts,now}](轮号 1 起,闭区间,互不重叠,按轮号排序)。 */
export function normalizeCapsules(parsed, n, maxPoints = 5) {
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
        out.push({ a, b, title: String(it?.title ?? '').trim(), text, points: normalizePoints(it?.points, maxPoints), shifts: normalizeShifts(it?.shifts), now: normalizeNow(it?.now) });
    });
    out.sort((x, y) => x.a - y.a);
    return out;
}

/** 必留点落库:补 id(`${胶囊id}:${序号}`)和来源楼 at(胶囊终点)。 */
function stampPoints(cap, points) {
    return points.map((p, i) => ({ id: `${cap.id}:${i}`, k: p.k, t: p.t, key: p.key, at: cap.toId }));
}

const maxPointsOf = (settings) => Math.max(0, Math.min(10, Math.floor(Number(settings.maxPoints) || 0)));

function makeCapId() { return 'c' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

/** 请求 + 提交一批。返回新增胶囊数;抛错表示失败(调用方设错误状态)。 */
// ── 失败处理:只有「像是内容被拦」才拆批 ──
// 酒馆对自定义渠道只回传状态文字(如 Bad Request),审查拦截的细节留在服务器日志里,所以靠规则判断:
//   hard  —— 渠道问题(鉴权/限流/5xx/断网/用户中止):直接抛出,不拆批;
//   empty —— 空回复/解析失败:原样重试一次,再失败按 block 处理;
//   block —— 400 或明确的拦截字样:对半拆开重试,拆到单轮仍失败就跳过这一轮。
// 保险:连续 SKIP_STREAK_LIMIT 轮被跳过,更像是渠道或模型设置有问题 → 撤销这几条跳过并停下报错。

export const SKIP_STREAK_LIMIT = 3;
const HARD_FAIL_RE = /\b(401|403|429|5\d\d)\b|unauthori[sz]ed|forbidden|quota|rate.?limit|failed to fetch|network|ECONN|ENOTFOUND|getaddrinfo|timed? ?out|超时|Base URL|abort/i;
const BLOCK_RE = /Bad Request|\b400\b|PROHIBITED|blocked|SAFETY|content.?filter|moderation|审核|拦截/i;
const EMPTY_RE = /No message generated|空内容|无法解析|没有返回可用/i;

export function errText(err) {
    if (typeof err === 'string') return err.slice(0, 300);
    const t = err?.message || err?.error?.message || (err ? JSON.stringify(err) : '');
    return String(t || '未知错误').slice(0, 300);
}
export function classifyError(err) {
    const t = errText(err);
    if (HARD_FAIL_RE.test(t)) return 'hard';
    if (BLOCK_RE.test(t)) return 'block';
    if (EMPTY_RE.test(t)) return 'empty';
    return 'hard';
}

function skippedRanges(ctx) {
    const list = peekData(ctx)?.skipped;
    if (!list?.length) return [];
    const out = [];
    for (const it of list) {
        const fi = idIndex(ctx, it.fromId), ti = idIndex(ctx, it.toId);
        if (fi >= 0 && ti >= fi) out.push([fi, ti]);
    }
    return out;
}

/** 当前仍有效的跳过记录(楼还在),面板用。 */
export function skippedList(ctx) {
    const list = peekData(ctx)?.skipped || [];
    return list.map(it => ({ ...it, fi: idIndex(ctx, it.fromId), ti: idIndex(ctx, it.toId) })).filter(it => it.fi >= 0 && it.ti >= it.fi);
}

export function clearSkipped(ctx) {
    const data = peekData(ctx);
    if (!data?.skipped?.length) return 0;
    const n = data.skipped.length;
    data.skipped = [];
    scheduleSave(ctx);
    emitChange();
    return n;
}

function markSkipped(ctx, round, reason) {
    const data = ensureData(ctx);
    if (!Array.isArray(data.skipped)) data.skipped = [];
    const it = { fromId: assignFloorId(ctx, round.fi), toId: assignFloorId(ctx, round.ti), reason: String(reason).slice(0, 120), ts: Date.now() };
    data.skipped.push(it);
    status.backfill.coveredTo = Math.max(status.backfill.coveredTo, round.ti);
    scheduleSave(ctx);
    return it;
}

/** recordBatch 外面包一层:按上面的规则重试/拆批/跳过。run = { streak, recent } 由调用方在一次补建或一次自动记录内共用。 */
async function recordSafely(ctx, rounds, run) {
    let err = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const n = await recordBatch(ctx, rounds);
            if (n) { run.streak = 0; run.recent = []; }
            return n;
        } catch (e) {
            err = e;
            const kind = classifyError(e);
            if (kind === 'hard') throw e;
            if (kind === 'block') break;
        }
    }
    if (rounds.length > 1) {
        const mid = Math.ceil(rounds.length / 2);
        const a = await recordSafely(ctx, rounds.slice(0, mid), run);
        if (!a) return 0; // 过期:整批放弃
        const b = await recordSafely(ctx, rounds.slice(mid), run);
        return b ? a + b : 0;
    }
    run.streak = (run.streak || 0) + 1;
    if (run.streak >= SKIP_STREAK_LIMIT) {
        const data = peekData(ctx);
        if (data?.skipped && run.recent?.length) data.skipped = data.skipped.filter(it => !run.recent.includes(it));
        run.recent = [];
        throw new Error(`连续 ${run.streak} 轮被模型拒绝或返回空内容,更像是渠道或模型设置的问题,已停止(最后一次:${errText(err)})`);
    }
    const it = markSkipped(ctx, rounds[0], errText(err));
    (run.recent ||= []).push(it);
    console.warn('[Mnemosyne] 这一轮被模型拒绝,已跳过', rounds[0].fi + 1, '–', rounds[0].ti + 1, errText(err));
    return 1;
}

async function recordBatch(ctx, rounds) {
    const settings = getSettings(ctx);
    const meta = ctx.chatMetadata;
    const chat = ctx.chat;
    // 请求发出时的快照:返回后逐楼核对,变了就整批作废
    const snap = rounds.map(r => r.idxs.map(i => ({ msg: chat[i], fp: fingerprint(chat[i]) })));

    await ensureRegexEngine();
    const tA = performance.now();
    const batchText = buildBatchText(ctx, rounds, settings.excludeTags);
    const user = batchText + clueBlock(batchText);
    const tB = performance.now();
    const maxPoints = maxPointsOf(settings);
    const parsed = await generateJson(ctx, capsulePrompt(maxPoints), user, llmOptsFrom(settings));
    const tC = performance.now();
    const items = normalizeCapsules(parsed, rounds.length, maxPoints);
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
            title: it.title, text: it.text, tokens: tokens[k], folded: false, ts: Date.now(), points: [],
        };
        cap.points = stampPoints(cap, it.points);
        if (it.shifts.length) cap.shifts = it.shifts;
        if (it.now) cap.now = it.now;
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

// ── 提取模式:摘要直接取自楼层,不调用模型 ──
// 按时间顺序处理:先取最前面一段连续同类的轮 —— 能提取的成批当场提交,取不到的交给 LLM 补记。

const extractChunk = (settings) => Math.max(12, Math.floor(Number(settings.batchMaxRounds) || 12));

/** rounds 前端的第一段连续同类轮。返回 { kind:'extract', items:[{round,ex}] } 或 { kind:'llm', rounds }。 */
function nextWork(ctx, rounds, settings, source, llmMax) {
    const maxPts = maxPointsOf(settings);
    const chunk = extractChunk(settings);
    const first = extractRound(ctx, rounds[0], source, maxPts);
    if (first) {
        const items = [{ round: rounds[0], ex: first }];
        for (let i = 1; i < rounds.length && items.length < chunk; i++) {
            const ex = extractRound(ctx, rounds[i], source, maxPts);
            if (!ex) break;
            items.push({ round: rounds[i], ex });
        }
        return { kind: 'extract', items };
    }
    const miss = [rounds[0]];
    for (let i = 1; i < rounds.length && miss.length < llmMax; i++) {
        if (extractRound(ctx, rounds[i], source, maxPts)) break;
        miss.push(rounds[i]);
    }
    return { kind: 'llm', rounds: miss };
}

/** 线索:对这一轮提纯后的原文跑预扫,最多 6 条。 */
function roundClues(ctx, round, excludeTags) {
    const text = round.idxs.map(i => cleanMessageText(ctx, ctx.chat[i], 0, excludeTags)).join('\n');
    return prescanClues(text, 6);
}

/** 提交一批提取结果。返回提交的轮数;0 = 过期(楼变了/聊天换了)。 */
async function recordExtracted(ctx, items) {
    const settings = getSettings(ctx);
    const meta = ctx.chatMetadata;
    const chat = ctx.chat;
    const snap = items.map(({ round }) => round.idxs.map(i => ({ msg: chat[i], fp: fingerprint(chat[i]) })));
    await ensureRegexEngine();
    const tA = performance.now();
    const clues = items.map(({ round }) => roundClues(ctx, round, settings.excludeTags));
    const tokens = [];
    for (const { ex } of items) tokens.push(await countTokens(ctx, ex.title ? `${ex.title}:${ex.text}` : ex.text));

    if (liveMeta(ctx) !== meta) return 0;
    beginEvent(ctx);
    for (let r = 0; r < items.length; r++) {
        for (let k = 0; k < items[r].round.idxs.length; k++) {
            const i = items[r].round.idxs[k], sn = snap[r][k];
            if (ctx.chat[i] !== sn.msg || fingerprint(sn.msg) !== sn.fp) return 0;
        }
    }
    const data = ensureData(ctx);
    const limit = reserveBoundary(ctx, settings.reserve);
    items.forEach(({ round, ex }, k) => {
        const { fi, ti } = round;
        for (const i of round.idxs) assignFloorId(ctx, i);
        const cap = {
            id: makeCapId(), fromId: assignFloorId(ctx, fi), toId: assignFloorId(ctx, ti),
            rangeHash: rangeHash(ctx, fi, ti),
            title: ex.title, text: ex.text, tokens: tokens[k], folded: false, ts: Date.now(), points: [],
        };
        cap.points = stampPoints(cap, ex.points);
        if (clues[k].length) cap.clues = clues[k];
        insertCapsule(ctx, data, cap);
        hideRange(ctx, fi, ti, limit);
        status.backfill.coveredTo = Math.max(status.backfill.coveredTo, ti);
    });
    scheduleSave(ctx);
    refreshInject(ctx);
    emitChange();
    perf.recordMs += performance.now() - tA;
    return items.length;
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
        const run = { streak: 0, recent: [] };
        try {
            const extract = sourceOf(peekData(ctx)).mode === 'extract';
            for (let guard = 0; guard < (extract ? 200 : 20); guard++) {
                const t0 = performance.now();
                const boundary = reserveBoundary(ctx, s.reserve);
                // 提取模式:能提取的轮全部当场处理,所以不限轮数;积压上限只管需要 LLM 的轮
                const rounds = collectRounds(ctx, 0, boundary, extract ? {} : { max: Math.max(1, s.autoMaxRounds) + 1 });
                if (!rounds.length) { perf.planMs += performance.now() - t0; perf.plans++; status.backlog = 0; break; }
                let pack;
                if (extract) {
                    const w = nextWork(ctx, rounds, s, sourceOf(peekData(ctx)), s.autoMaxRounds + 1);
                    perf.planMs += performance.now() - t0; perf.plans++;
                    if (w.kind === 'extract') {
                        const n = await recordExtracted(ctx, w.items);
                        setError(null);
                        if (!n) break;
                        status.extract.extracted += n;
                        if (needsFold(ctx)) await foldWhileNeeded(ctx);
                        if (isGenerating()) { autoWanted = true; break; }
                        continue;
                    }
                    if (w.rounds.length > s.autoMaxRounds) { status.backlog = countPending(ctx); emitChange(); break; }
                    pack = packRounds(ctx, w.rounds, s)[0];
                } else {
                    perf.planMs += performance.now() - t0; perf.plans++;
                    if (rounds.length > s.autoMaxRounds) { status.backlog = countPending(ctx); emitChange(); break; } // 积压太多:交给补建
                    pack = packRounds(ctx, rounds, s)[0];
                }
                status.backlog = 0;
                const added = await recordSafely(ctx, pack, run);
                setError(null);
                if (!added) break;
                if (extract) status.extract.llm += pack.length;
                if (needsFold(ctx)) await foldWhileNeeded(ctx);
                if (isGenerating()) { autoWanted = true; break; }
            }
            if (!isGenerating() && needsFold(ctx)) await foldWhileNeeded(ctx); // 删楼回退后阈值又够了:不等新消息,直接重新折叠
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
    status.backlog = 0; status.error = null; status.notices = []; status.extract = { extracted: 0, llm: 0 };
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
        if (bf.done === 0) status.extract = { extracted: 0, llm: 0 };
        bf.running = true; bf.stopRequested = false;
        bf.coveredTo = summary(ctx).coveredTo;
        data.backfill = { running: true, failedAt: null };
        scheduleSave(ctx);
        setError(null);
        let outcome = 'stopped';
        let failIdx = null;
        const run = { streak: 0, recent: [] };
        try {
            await ensureRegexEngine();
            for (;;) {
                if (bf.stopRequested) break;
                const boundary = reserveBoundary(ctx, s.reserve);
                const rounds = collectRounds(ctx, 0, boundary);
                if (!rounds.length) { outcome = 'finished'; break; }
                const src = sourceOf(data);
                let pack;
                bf.batch = bf.done + 1;
                if (src.mode === 'extract') {
                    const w = nextWork(ctx, rounds, s, src, Math.max(1, s.batchMaxRounds));
                    failIdx = rounds[0].fi;
                    bf.batches = bf.done + Math.ceil(rounds.length / extractChunk(s));
                    emitChange();
                    if (w.kind === 'extract') {
                        const n = await recordExtracted(ctx, w.items);
                        if (!n) { outcome = 'stale'; break; }
                        status.extract.extracted += n;
                        bf.done++;
                        if (needsFold(ctx)) await foldWhileNeeded(ctx);
                        continue;
                    }
                    pack = packRounds(ctx, w.rounds, s)[0];
                    bf.batches = Math.max(bf.batches, bf.done + 1);
                } else {
                    const packs = packRounds(ctx, rounds, s);
                    bf.batches = bf.done + packs.length;
                    failIdx = packs[0][0].fi;
                    pack = packs[0];
                    emitChange();
                }
                const added = await recordSafely(ctx, pack, run);
                if (!added) { outcome = 'stale'; break; }
                if (src.mode === 'extract') status.extract.llm += pack.length;
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
        const batchText = buildBatchText(ctx, rounds, settings.excludeTags);
        const maxPoints = maxPointsOf(settings);
        const src = sourceOf(data);
        if (src.mode === 'extract') { // 提取模式:先试着重新提取,取不到才走模型
            const exs = rounds.map(r => extractRound(ctx, r, src, maxPoints));
            if (exs.every(Boolean)) {
                const text = exs.map(e => e.text).join('\n');
                const tokens = await countTokens(ctx, text);
                if (!data.capsules.includes(cap)) return { skipped: 'stale' };
                cap.text = text; cap.title = exs[0].title; cap.tokens = tokens; cap.ts = Date.now();
                cap.points = stampPoints(cap, normalizePoints(exs.flatMap(e => e.points), maxPoints));
                delete cap.shifts; delete cap.now;
                const clues = rounds.flatMap(r => roundClues(ctx, r, settings.excludeTags)).slice(0, 6);
                if (clues.length) cap.clues = clues; else delete cap.clues;
                scheduleSave(ctx);
                refreshInject(ctx);
                return { ok: true };
            }
        }
        const parsed = await generateJson(ctx, capsulePrompt(maxPoints), batchText + clueBlock(batchText), llmOptsFrom(settings));
        const items = normalizeCapsules(parsed, rounds.length, maxPoints);
        if (!items.length) throw new Error('模型没有返回可用的记录');
        const text = items.map(i => i.text).join('');
        const title = items[0].title;
        const tokens = await countTokens(ctx, title ? `${title}:${text}` : text);
        if (!data.capsules.includes(cap)) return { skipped: 'stale' };
        cap.text = text; cap.title = title; cap.tokens = tokens; cap.ts = Date.now();
        cap.points = stampPoints(cap, normalizePoints(items.flatMap(i => i.points), maxPoints));
        const shifts = normalizeShifts(items.flatMap(i => i.shifts));
        if (shifts.length) cap.shifts = shifts; else delete cap.shifts;
        const now = items[items.length - 1].now;
        if (now) cap.now = now; else delete cap.now;
        delete cap.clues;
        scheduleSave(ctx);
        refreshInject(ctx);
        return { ok: true };
    });
}

/** 改本聊天的摘要来源设置(patch 里给哪项改哪项)。 */
export function setSource(ctx, patch) {
    const data = ensureData(ctx);
    data.source = normalizeSource({ ...sourceOf(data), ...patch });
    scheduleSave(ctx);
    if (data.source.mode === 'extract') kick(ctx, 0);
    emitChange();
    return data.source;
}

/** 手动立即折叠(长期记忆页的按钮)。 */
export async function foldNowExclusive(ctx) {
    ctxRef = ctx;
    return await runExclusive('fold', async () => {
        return await foldNow(ctx);
    });
}

