// 长期记忆折叠:较早的一半胶囊 + 当前长期记忆 → 新的长期记忆。
// 两步:①事实合并(产出四节,前情为忠实草稿);②用原文文风样本润色前情(事实是边界)。
// 润色失败用草稿,不阻塞。写入前把当前版存为 memoryPrev(只留一份),并随它存下「这次被折叠的胶囊」
// 的文本,撤销时一并恢复;更早已折叠的胶囊并成一个只留范围的占位,所以存储不随折叠次数增长。

import {
    countTokens, ensureData, isStory, liveMeta, peekData, rangeHash, resolveCapsule, scheduleSave,
} from './state.js';
import { getSettings } from './settings.js';
import { generateJson, generateText, llmOptsFrom } from './llm.js';
import { cleanMessageText, ensureRegexEngine } from './purify.js';
import { PROMPT_FOLD_MERGE, PROMPT_FOLD_POLISH, SECTION_TITLES } from './prompts.js';
import { refreshInject } from './inject.js';

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

// ── 长期记忆文本 ⇄ 分节 ──

const asText = (v) => (Array.isArray(v) ? v.map(String).join('\n') : String(v ?? '')).trim();

export function composeMemory(sections) {
    return SECTION_TITLES.map((t, i) => {
        const key = ['prelude', 'people', 'timeline', 'open'][i];
        return `## ${t}\n${asText(sections[key]) || '(暂无)'}`;
    }).join('\n\n');
}

/** 按固定四节标题切开;缺的节给空串。 */
export function parseSections(text) {
    const out = Object.fromEntries(SECTION_TITLES.map(t => [t, '']));
    const re = /^##\s*(前情|人物与关系|时间线|未结事项)\s*$/gm;
    const marks = [...String(text || '').matchAll(re)];
    for (let i = 0; i < marks.length; i++) {
        const start = marks[i].index + marks[i][0].length;
        const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
        out[marks[i][1]] = text.slice(start, end).trim();
    }
    return out;
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
                    last.toId = c.toId;
                    last.rangeHash = rangeHash(ctx, a.fi, b.ti);
                    continue;
                }
            }
        }
        out.push(c);
    }
    data.capsules = out;
}

/** 折叠最早的一半未折叠胶囊。返回 { folded, polished } 或 { skipped }。 */
export async function foldNow(ctx) {
    const settings = getSettings(ctx);
    const data = ensureData(ctx);
    const unfolded = data.capsules.filter(c => !c.folded);
    if (!unfolded.length) throw new Error('没有可折叠的胶囊');
    const batch = unfolded.slice(0, Math.max(1, Math.floor(unfolded.length / 2)));
    const meta = ctx.chatMetadata;
    const opts = llmOptsFrom(settings);

    const user = `【当前长期记忆】\n${data.memory?.text?.trim() || '(空)'}\n\n【待合并的剧情记录】\n`
        + batch.map((c, i) => `${i + 1}. ${c.title ? c.title + ':' : ''}${c.text}`).join('\n');
    const merged = await generateJson(ctx, PROMPT_FOLD_MERGE, user, opts);
    const draft = asText(merged.prelude);
    const sections = { prelude: draft, people: merged.people, timeline: merged.timeline, open: merged.open };
    if (!draft && !asText(sections.people) && !asText(sections.timeline) && !asText(sections.open)) {
        throw new Error('模型没有返回可用的长期记忆');
    }

    if (liveMeta(ctx) !== meta) return { skipped: 'stale' };
    let polished = false;
    if (draft) {
        try {
            const samples = await pickStyleSamples(ctx, batch, settings.excludeTags);
            if (samples.length) {
                const pu = `【文风样本】\n${samples.map((s, i) => `样本${i + 1}:${s}`).join('\n')}\n\n【前情草稿】\n${draft}`;
                const out = await generateText(ctx, PROMPT_FOLD_POLISH, pu, opts);
                if (out.length >= draft.length * 0.4) { sections.prelude = out; polished = true; }
            }
        } catch (err) {
            console.warn('[Mnemosyne] 润色失败,使用草稿', err);
        }
    }
    const text = composeMemory(sections);
    const tokens = await countTokens(ctx, text);

    // 等待期间聊天/胶囊可能变了:不再是同一批就放弃,留给下一次
    if (liveMeta(ctx) !== meta || batch.some(c => c.folded || !data.capsules.includes(c))) {
        return { skipped: 'stale' };
    }

    // ── 同步提交 ──
    const old = data.memory;
    const undo = { ids: batch.map(c => c.id), texts: {} };
    data.memoryPrev = { text: old?.text || '', tokens: old?.tokens || 0, ts: old?.ts || 0, undo };
    data.memory = { text, tokens, ts: Date.now() };
    for (const c of batch) {
        c.folded = true;
        if (!settings.keepFoldedText) {
            undo.texts[c.id] = { title: c.title, text: c.text, tokens: c.tokens };
            c.text = ''; c.tokens = 0;
        }
    }
    coalesceOlderFolded(ctx, data, new Set(undo.ids));
    scheduleSave(ctx);
    refreshInject(ctx);
    return { folded: batch.length, polished };
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

/** 撤销最近一次折叠:长期记忆回到上一版,被折叠的胶囊恢复原状。 */
export function undoFold(ctx) {
    const data = peekData(ctx);
    const prev = data?.memoryPrev;
    if (!prev) return false;
    for (const id of prev.undo?.ids || []) {
        const cap = data.capsules.find(c => c.id === id);
        if (!cap) continue;
        cap.folded = false;
        const saved = prev.undo.texts?.[id];
        if (saved) { cap.title = saved.title; cap.text = saved.text; cap.tokens = saved.tokens; }
    }
    data.memory = prev.text ? { text: prev.text, tokens: prev.tokens, ts: prev.ts } : null;
    data.memoryPrev = null;
    scheduleSave(ctx);
    refreshInject(ctx);
    return true;
}

/** 用户手动编辑长期记忆全文。 */
export async function saveMemoryText(ctx, text) {
    const data = ensureData(ctx);
    const t = String(text || '').trim();
    data.memory = t ? { text: t, tokens: await countTokens(ctx, t), ts: Date.now() } : null;
    scheduleSave(ctx);
    refreshInject(ctx);
}

