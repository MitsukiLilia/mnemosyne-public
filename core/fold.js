// 长期记忆折叠:较早的一半胶囊 + 当前长期记忆 → 新的长期记忆。
// 两步:①事实合并(产出五节 + 要撤下的锚点,前情为忠实草稿);②用原文文风样本润色前情(事实是边界),
// 润色后本地核对,丢了锚点关键词或缩水太多就退回草稿。
// 每次折叠往版本链里压一版 { before: 折叠前的 memory 快照, foldedIds },最多 memoryVersions 版:
//   · 链里的胶囊保留正文,撤销/删楼回退时原样恢复;
//   · 版本被挤出链尾时,那一版吞掉的胶囊才清空正文,之后可被并成只留范围的占位(points 拼起来保留)。

import {
    beginEvent, countTokens, ensureData, isStory, liveMeta, peekData, rangeHash, resolveCapsule, scheduleSave,
} from './state.js';
import { getSettings } from './settings.js';
import { generateJson, generateText, llmOptsFrom } from './llm.js';
import { cleanMessageText, ensureRegexEngine } from './purify.js';
import { PROMPT_FOLD_MERGE, PROMPT_FOLD_POLISH, SECTION_KEYS, SECTION_TITLES } from './prompts.js';
import {
    activeAnchors, anchorLine, anchorsText, asText, cloneMemory, composeMemory, dedupeAnchors, deriveAnchors, parseSections,
    pointId, protectedIds, rebuildText, sectionsFromText,
} from './memory.js';
import { refreshInject } from './inject.js';
import { pushNotice, status } from './bus.js';

export { composeMemory, parseSections };

export function unfoldedTokens(data) {
    let n = 0;
    for (const c of data.capsules) if (!c.folded) n += c.tokens || 0;
    return n;
}

export function needsFold(ctx) {
    const d = peekData(ctx);
    if (!d) return false;
    return d.capsules.some(c => !c.folded) && unfoldedTokens(d) > Number(getSettings(ctx).foldThreshold);
}

// ── 文风样本 ──

async function pickStyleSamples(ctx, capsules, excludeTags) {
    await ensureRegexEngine();
    const chat = ctx.chat;
    const cand = [];
    for (const cap of capsules) {
        const { fi, ti } = resolveCapsule(ctx, cap);
        if (fi < 0 || ti < fi) continue;
        for (let i = fi; i <= ti; i++) {
            const m = chat[i];
            if (isStory(ctx, m) && !m.is_user && typeof m.mes === 'string' && m.mes.length >= 80) cand.push(i);
        }
    }
    if (!cand.length) return [];
    const want = 3;
    const picks = [];
    const step = Math.max(1, Math.floor(cand.length / want));
    for (let k = 0; k < cand.length && picks.length < 12; k += step) picks.push(cand[Math.min(cand.length - 1, k + Math.floor(step / 2))]);
    const samples = [];
    for (const i of picks) {
        if (samples.length >= want) break;
        const text = cleanMessageText(ctx, chat[i], chat.length - 1 - i, excludeTags);
        const paras = text.split(/\n+/).map(s => s.trim()).filter(s => s.length >= 40 && s.length <= 600);
        if (!paras.length) continue;
        paras.sort((a, b) => Math.abs(a.length - 200) - Math.abs(b.length - 200));
        samples.push(paras[0]);
    }
    return samples;
}

// ── 折叠 ──

function ensurePointIds(cap) {
    if (!Array.isArray(cap.points)) { cap.points = []; return; }
    cap.points.forEach((p, i) => { if (!p.id) p.id = pointId(cap, i); });
}

function coalesceOlderFolded(ctx, data, keepIds) {
    const caps = data.capsules;
    const chat = ctx.chat;
    const out = [];
    for (const c of caps) {
        const last = out[out.length - 1];
        if (last && last.folded && c.folded && !keepIds.has(last.id) && !keepIds.has(c.id)) {
            const a = resolveCapsule(ctx, last), b = resolveCapsule(ctx, c);
            if (a.ti >= 0 && b.fi >= 0) {
                let j = a.ti + 1;
                while (j < chat.length && !isStory(ctx, chat[j])) j++;
                if (j === b.fi) { // 紧邻、中间没有空洞才合并
                    ensurePointIds(last); ensurePointIds(c);
                    last.points = last.points.concat(c.points); // points 很小,合并时拼起来(id 和 at 各自保留)
                    last.toId = c.toId;
                    last.rangeHash = rangeHash(ctx, a.fi, b.ti);
                    last.text = ''; last.tokens = 0;
                    continue;
                }
            }
        }
        out.push(c);
    }
    data.capsules = out;
}

/** 版本挤出链尾:那一版吞掉的胶囊清空正文(keepFoldedText 开着则保留)。 */
function trimVersions(data, limit, keepText) {
    const vs = data.versions;
    while (vs.length > limit) {
        const old = vs.shift();
        if (keepText) continue;
        const still = protectedIds(data);
        for (const id of old.foldedIds || []) {
            if (still.has(id)) continue;
            const cap = data.capsules.find(c => c.id === id);
            if (cap && cap.folded) { cap.text = ''; cap.tokens = 0; }
        }
    }
}

const rangeLabel = (ctx, cap) => {
    const { fi, ti } = resolveCapsule(ctx, cap);
    if (fi < 0 || ti < 0) return '';
    return fi === ti ? `#${fi + 1} ` : `#${fi + 1}–${ti + 1} `;
};

const anchorLineWithId = (a) => `[${a.id}] ${anchorLine(a)}`;

/** 合并输出里的 resolved → { id: 结果 };只认上下文里出现过的 id。 */
export function normalizeResolved(raw, validIds) {
    const out = {};
    if (!Array.isArray(raw)) return out;
    for (const it of raw) {
        const id = String(it?.id ?? '').trim();
        if (!id || !validIds.has(id)) continue;
        out[id] = String(it?.result ?? '').trim().slice(0, 120) || '已了结';
    }
    return out;
}

/**
 * 润色后本地核对:草稿里出现过的锚点关键词(及称呼类的原句)润色稿里必须都还在,且不能比草稿短太多。
 * 返回 null = 通过,否则返回原因。
 */
export function checkPolish(draft, polished, anchors) {
    if (polished.length < draft.length * 0.6) return '润色稿比草稿短太多';
    for (const a of anchors) {
        if (a.key && draft.includes(a.key) && !polished.includes(a.key)) return `润色稿丢了「${a.key}」`;
        if (a.k === '称呼' && a.t && draft.includes(a.t) && !polished.includes(a.t)) return `润色稿丢了「${a.t}」`;
    }
    return null;
}

/** 折叠最早的一半未折叠胶囊。返回 { folded, polished, reason } 或 { skipped }。 */
export async function foldNow(ctx) {
    const settings = getSettings(ctx);
    const data = ensureData(ctx);
    const unfolded = data.capsules.filter(c => !c.folded);
    if (!unfolded.length) throw new Error('没有可折叠的胶囊');
    const batch = unfolded.slice(0, Math.max(1, Math.floor(unfolded.length / 2)));
    const batchIds = new Set(batch.map(c => c.id));
    const meta = ctx.chatMetadata;
    const opts = llmOptsFrom(settings);
    beginEvent(ctx);

    const oldMem = data.memory;
    const oldSections = oldMem?.sections || sectionsFromText(oldMem?.text);
    batch.forEach(ensurePointIds);
    const oldAnchors = activeAnchors(data);
    const newAnchors = deriveAnchors(batch, {}, batchIds);
    const validIds = new Set([...oldAnchors, ...newAnchors].map(a => a.id));

    const secText = SECTION_KEYS.map((k, i) => `## ${SECTION_TITLES[i]}\n${asText(oldSections[k]) || '(空)'}`).join('\n\n');
    const user = `【当前分节】\n${secText}\n\n`
        + `【现有锚点】\n${oldAnchors.map(anchorLineWithId).join('\n') || '(无)'}\n\n`
        + `【待合并的剧情记录】\n`
        + batch.map((c, i) => `${i + 1}. ${rangeLabel(ctx, c)}${c.title ? c.title + ':' : ''}${c.text}`).join('\n')
        + `\n\n【这批记录的新锚点】\n${newAnchors.map(anchorLineWithId).join('\n') || '(无)'}`;
    const merged = await generateJson(ctx, PROMPT_FOLD_MERGE, user, opts);
    const draft = asText(merged.prelude);
    const sections = { prelude: draft };
    for (const k of SECTION_KEYS) if (k !== 'prelude') sections[k] = asText(merged[k]);
    if (!SECTION_KEYS.some(k => sections[k])) throw new Error('模型没有返回可用的长期记忆');
    const resolved = normalizeResolved(merged.resolved, validIds);

    // 提交后的生效锚点(预演):旧 retired 去掉已不存在的点,再并入本次撤下的
    const retired = {};
    for (const [id, r] of Object.entries(oldMem?.retired || {})) retired[id] = r;
    Object.assign(retired, resolved);
    Object.assign(retired, dedupeAnchors(deriveAnchors(data.capsules, retired, batchIds))); // 模型漏判的重复,本地再合并一遍
    const finalAnchors = deriveAnchors(data.capsules, retired, batchIds);

    if (liveMeta(ctx) !== meta) return { skipped: 'stale' };
    let polished = false;
    let reason = '';
    if (draft) {
        try {
            const samples = await pickStyleSamples(ctx, batch, settings.excludeTags);
            if (samples.length) {
                const pu = `【文风样本】\n${samples.map((s, i) => `样本${i + 1}:${s}`).join('\n')}\n\n【前情草稿】\n${draft}`;
                const out = await generateText(ctx, PROMPT_FOLD_POLISH, pu, opts);
                reason = checkPolish(draft, out, finalAnchors) || '';
                if (!reason) { sections.prelude = out; polished = true; }
            } else reason = '没有可用的文风样本';
        } catch (err) {
            reason = '润色请求失败';
            console.warn('[Mnemosyne] 润色失败,使用草稿', err);
        }
    }
    const text = composeMemory(sections, anchorsText(finalAnchors));
    const tokens = await countTokens(ctx, text);

    // 等待期间聊天/胶囊可能变了:不再是同一批就放弃,留给下一次
    if (liveMeta(ctx) !== meta || batch.some(c => c.folded || !data.capsules.includes(c)) || data.memory !== oldMem) {
        return { skipped: 'stale' };
    }

    // ── 同步提交 ──
    const live = new Set(finalAnchors.map(a => a.id));
    for (const id of Object.keys(retired)) { // 清掉已没有对应 point 的撤下记录(point 在 retired 里时不在 finalAnchors,要另查)
        if (!live.has(id) && !pointExists(data, id, batchIds)) delete retired[id];
    }
    data.versions.push({ ts: Date.now(), before: cloneMemory(oldMem), foldedIds: batch.map(c => c.id) });
    data.memory = { sections, retired, text, tokens, ts: Date.now() };
    for (const c of batch) c.folded = true; // 正文保留:链里的胶囊要能原样恢复
    trimVersions(data, Math.max(1, Math.floor(Number(settings.memoryVersions) || 5)), settings.keepFoldedText);
    coalesceOlderFolded(ctx, data, protectedIds(data));
    status.lastFold = { ts: Date.now(), polished, reason };
    if (reason && draft) pushNotice(`本次用了草稿:${reason}`);
    scheduleSave(ctx);
    refreshInject(ctx);
    return { folded: batch.length, polished, reason };
}

function pointExists(data, id, batchIds) {
    for (const c of data.capsules) {
        if ((!c.folded && !batchIds.has(c.id)) || !Array.isArray(c.points)) continue;
        if (c.points.some((p, i) => (p.id || pointId(c, i)) === id)) return true;
    }
    return false;
}

/** 折叠到阈值以下(最多 6 轮,防止异常数据下死循环)。 */
export async function foldWhileNeeded(ctx) {
    let n = 0;
    for (let k = 0; k < 6 && needsFold(ctx); k++) {
        const r = await foldNow(ctx);
        if (r.skipped) break;
        n += r.folded;
    }
    return n;
}

/** 撤销最近一次折叠(可连续撤销到链空):长期记忆回到那一版之前,那一版吞掉的胶囊恢复成未折叠。 */
export function undoFold(ctx) {
    const data = peekData(ctx);
    const v = data?.versions?.[data.versions.length - 1];
    if (!v) return false;
    for (const id of v.foldedIds || []) {
        const cap = data.capsules.find(c => c.id === id);
        if (cap) cap.folded = false;
    }
    data.memory = v.before || null;
    data.versions.pop();
    rebuildText(data);
    scheduleSave(ctx);
    refreshInject(ctx);
    return true;
}

/** 用户手动编辑长期记忆全文(分节部分;「## 锚点」一节由系统派生,编辑里写了也会被忽略)。 */
export async function saveMemoryText(ctx, text) {
    const data = ensureData(ctx);
    const t = String(text || '').trim();
    if (!t) data.memory = null;
    else {
        const mem = { sections: sectionsFromText(t), retired: data.memory?.retired || {}, text: '', tokens: 0, ts: Date.now() };
        data.memory = mem;
        rebuildText(data);
        const n = await countTokens(ctx, mem.text);
        if (data.memory === mem) mem.tokens = n;
    }
    scheduleSave(ctx);
    refreshInject(ctx);
}

/** 手动撤下 / 恢复一条锚点。 */
export function retireAnchor(ctx, id, result = '手动撤下') {
    const data = peekData(ctx);
    if (!data?.memory) return false;
    data.memory.retired = data.memory.retired || {};
    data.memory.retired[id] = result;
    rebuildText(data);
    scheduleSave(ctx);
    refreshInject(ctx);
    return true;
}
export function restoreAnchor(ctx, id) {
    const data = peekData(ctx);
    if (!data?.memory?.retired || data.memory.retired[id] === undefined) return false;
    delete data.memory.retired[id];
    rebuildText(data);
    scheduleSave(ctx);
    refreshInject(ctx);
    return true;
}

/** 面板编辑框里用的文本:只含分节,不含锚点。 */
export function editableMemoryText(mem) {
    return mem ? composeMemory(mem.sections || sectionsFromText(mem.text), '') : '';
}
