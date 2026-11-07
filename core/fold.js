// 长期记忆折叠:较早的一半胶囊 + 当前长期记忆 → 新的长期记忆。
// 两步:①事实合并(产出五节 + 要撤下的锚点,前情为忠实草稿);②用原文文风样本润色前情(事实是边界),
// 润色后本地核对,丢了锚点关键词或缩水太多就退回草稿。
// 前情分篇章:每次折叠只为这批新记录写一篇,接在已有篇章之后;已写好的篇章不再改写。
// 篇章合计超过 preludeBudget 时,折叠提交后再把最早的两篇合并一次(本地核对不过就原样保留,下次再试)。
// 每次折叠往版本链里压一版 { before: 折叠前的 memory 快照, foldedIds },最多 memoryVersions 版;
// 篇章合并、整理锚点各自再压一版(foldedIds 为空),所以连续撤销先撤它们,再撤折叠。
// 折叠后胶囊保留正文(供关键词召回);只有旧版本留下的、没有正文的占位才会被并在一起(points 拼起来保留)。

import {
    beginEvent, countTokens, coverage, ensureData, isStory, liveMeta, peekData, rangeHash, resolveCapsule, scheduleSave,
} from './state.js';
import { getSettings } from './settings.js';
import { generateJson, generateText, llmOptsFrom } from './llm.js';
import { cleanMessageText, ensureRegexEngine } from './purify.js';
import { PROMPT_ANCHOR_TIDY, PROMPT_CHAPTER_MERGE, PROMPT_FOLD_MERGE, PROMPT_FOLD_POLISH, SECTION_KEYS, SECTION_TITLES } from './prompts.js';
import { sanitizeOrigins } from './people.js';
import {
    activeAnchors, anchorsText, applyItems, asText, cloneMemory, composeMemory, dedupeAnchors, deriveAnchors, keysOf, parseSections,
    ITEM_KIND, normalizePoints, pointId, protectedIds, rebuildText, sectionsFromText,
} from './memory.js';
import {
    chaptersEditText, chaptersFromEdit, chaptersOf, chaptersTokens, joinChapters, makeChapterId,
} from './chapters.js';
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
        if (last && last.folded && c.folded && !last.text && !c.text && !keepIds.has(last.id) && !keepIds.has(c.id)) { // 有正文的留着供召回,只并旧版留下的空占位
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

/** 版本挤出链尾:只是丢掉最旧的版本(胶囊正文一直保留,供关键词召回)。 */
function trimVersions(data, limit) {
    const vs = data.versions;
    while (vs.length > limit) vs.shift();
}

const versionLimit = (settings) => Math.max(1, Math.floor(Number(settings.memoryVersions) || 5));

const rangeLabel = (ctx, cap) => {
    const { fi, ti } = resolveCapsule(ctx, cap);
    if (fi < 0 || ti < 0) return '';
    return fi === ti ? `#${fi + 1} ` : `#${fi + 1}–${ti + 1} `;
};

/** 锚点出处:`(#起–止 记录标题前 20 字)`;胶囊被并成占位、没有标题的只写楼号,楼层解析不到的只写标题。 */
function provenance(ctx, a) {
    const { fi, ti } = a.cap ? resolveCapsule(ctx, a.cap) : { fi: -1, ti: -1 };
    const range = fi >= 0 && ti >= fi ? (fi === ti ? `#${fi + 1}` : `#${fi + 1}–${ti + 1}`) : '';
    const title = String(a.cap?.title || '').slice(0, 20);
    const body = [range, title].filter(Boolean).join(' ');
    return body ? `(${body})` : '';
}

/** 给合并模型看的锚点行:[id] [类别] 内容;物品再带「来历」和「现状(#楼号)」,没有的部分不写;末尾括注出处。 */
function anchorLineWithId(a, ctx) {
    let s = `[${a.id}] [${a.k}] ${a.t}`;
    if (a.k === ITEM_KIND) {
        if (a.d) s += `｜来历:${a.d}`;
        if (a.now?.t) s += `｜现状:${a.now.t}${a.now.at ? `(#${a.now.at})` : ''}`;
    }
    return s + provenance(ctx, a);
}

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
export function checkPolish(draft, polished, anchors, ratio = 0.6) {
    if (polished.length < draft.length * ratio) return '润色稿比草稿短太多';
    for (const a of anchors) {
        for (const k of keysOf(a)) if (draft.includes(k) && !polished.includes(k)) return `润色稿丢了「${k}」`;
        if (a.k === '称呼' && a.t && draft.includes(a.t) && !polished.includes(a.t)) return `润色稿丢了「${a.t}」`;
    }
    return null;
}

const maxPointsOf = (settings) => Math.max(0, Math.min(10, Math.floor(Number(settings.maxPoints) || 0)));

/** 提取模式产生的胶囊:没有必留点、但存了原文线索 —— 折叠时请模型补挑。 */
const needsPoints = (c) => !(c.points?.length) && Array.isArray(c.clues) && c.clues.length > 0;

/**
 * 合并输出里的 newPoints → Map(胶囊 → 规范化的新点)。只认待补的胶囊;
 * 台词必须原样出现在该胶囊的线索里,不在的丢掉;物品的来历 d 至少一半二字组要出现在线索里,否则只丢 d;每个胶囊不超过 maxPoints 条。
 */
// 台词核对只看原话本身:模型常带说话人前缀(「乙:『……』」),线索里只有引号内那段。
// 取引号内的文字(没有引号就去掉「名字:」前缀),去掉空白和标点后,必须是某条线索的子串。
const bare = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
function quoteInClues(t, clues) {
    const q = String(t || '').match(/[「『“"]([^」』”"]{2,})[」』”"]/);
    const core = bare(q ? q[1] : String(t || '').replace(/^[^:：]{1,12}[:：]/, ''));
    if (core.length < 2) return false;
    return clues.some(cl => bare(cl).includes(core));
}

/** 来历 d 核对:去掉标点后,至少一半的二字组出现在线索里。 */
function originInClues(d, clues) {
    const core = bare(d);
    if (core.length < 2) return false;
    const hay = clues.map(bare);
    let hit = 0;
    const total = core.length - 1;
    for (let i = 0; i < total; i++) if (hay.some(h => h.includes(core.slice(i, i + 2)))) hit++;
    return hit * 2 >= total;
}

export function normalizeNewPoints(raw, batch, maxPoints = 5) {
    const out = new Map();
    if (!Array.isArray(raw)) return out;
    const per = new Map();
    for (const it of raw) {
        const cap = batch[Number(it?.cap) - 1];
        if (!cap || !needsPoints(cap)) continue;
        if (!per.has(cap)) per.set(cap, []);
        per.get(cap).push(it);
    }
    for (const [cap, list] of per) {
        const ok = normalizePoints(list, 50).filter(p => p.k !== '台词' || quoteInClues(p.t, cap.clues)).map((p) => {
            if (p.d && !originInClues(p.d, cap.clues)) { const { d, ...rest } = p; return rest; }
            return p;
        });
        if (ok.length) out.set(cap, ok.slice(0, maxPoints));
    }
    return out;
}

/** 楼号是否合法:在聊天长度内,且落在某个胶囊覆盖范围里(来由、物品现状共用)。 */
function floorChecker(ctx, data) {
    const ranges = coverage(ctx, data).filter(r => r.fi >= 0 && r.ti >= r.fi).map(r => [r.fi + 1, r.ti + 1]);
    const len = ctx.chat.length;
    return (n) => n >= 1 && n <= len && ranges.some(([a, b]) => n >= a && n <= b);
}

/** 来由里的 #楼号:超出聊天长度、或不落在任何胶囊覆盖范围内的去掉。 */
function checkOrigins(ctx, data, people) {
    return sanitizeOrigins(people, floorChecker(ctx, data));
}

/** 送给模型的已有前情结尾,最多这么多字。 */
const PRELUDE_TAIL = 800;

/**
 * 篇章合计超过 preludeBudget 时,把最早的两篇合成一篇(每次折叠最多一次,不循环)。
 * 合并稿过本地核对(两篇里出现过的锚点关键词都还在、不短于两篇合计的一半);不过或请求失败,两篇原样保留并提示。
 * 过期(聊天换了、长期记忆在等待期间被改)静默放弃。成功返回 true。
 */
async function mergeOldestChapters(ctx, data, settings, opts, meta) {
    const mem = data.memory;
    const chs = mem?.chapters;
    if (!Array.isArray(chs) || chs.length < 2) return false;
    const budget = Math.max(1000, Number(settings.preludeBudget) || 5000);
    if (chaptersTokens(chs) <= budget) return false;
    const [a, b] = chs;
    let out = '', fail = '';
    try {
        out = await generateText(ctx, PROMPT_CHAPTER_MERGE, `【第一篇】\n${a.text}\n\n【第二篇】\n${b.text}`, opts);
        fail = checkPolish(`${a.text}\n\n${b.text}`, out, activeAnchors(data), 0.5) || '';
    } catch (err) {
        fail = '请求失败';
        console.warn('[Mnemosyne] 前情篇章合并失败', err);
    }
    if (liveMeta(ctx) !== meta || data.memory !== mem) return false;
    if (fail) {
        console.warn('[Mnemosyne] 前情篇章合并未采用:', fail);
        pushNotice('前情较长,本次没有合并成功,下次折叠再试');
        return false;
    }
    data.versions.push({ ts: Date.now(), before: cloneMemory(mem), foldedIds: [] });
    const merged = { id: makeChapterId(), fromId: a.fromId, toId: b.toId, text: out, gen: Math.max(a.gen || 1, b.gen || 1) + 1, ts: Date.now() };
    const chapters = [merged, ...chs.slice(2)];
    data.memory = { ...mem, sections: { ...mem.sections, prelude: joinChapters(chapters) }, chapters, ts: Date.now() };
    rebuildText(data);
    trimVersions(data, versionLimit(settings));
    scheduleSave(ctx);
    refreshInject(ctx);
    return true;
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
    const oldChapters = chaptersOf(oldMem, data.capsules); // 旧数据没有 chapters:内存里把现有前情当一篇
    const newAnchors = deriveAnchors(batch, {}, batchIds);
    const validIds = new Set([...oldAnchors, ...newAnchors].map(a => a.id));

    const shiftText = batch.map((c, i) => c.shifts?.length ? `【序号${i + 1}】${c.shifts.map(x => `${x.who}:${x.t}`).join(';')}` : '').filter(Boolean).join('\n');
    const needy = batch.map((c, i) => ({ c, i })).filter(({ c }) => needsPoints(c));
    // 前情一节只给最后一篇的末尾(已有前情只读,用来衔接);其余四节整份给
    const lastText = oldChapters.length ? asText(oldChapters[oldChapters.length - 1].text) : '';
    const preludeTail = lastText.length > PRELUDE_TAIL ? lastText.slice(-PRELUDE_TAIL) : lastText;
    const secText = SECTION_KEYS.map((k, i) => (k === 'prelude'
        ? `## ${SECTION_TITLES[i]}(已有前情的结尾,只读)\n${preludeTail || '(空)'}`
        : `## ${SECTION_TITLES[i]}\n${asText(oldSections[k]) || '(空)'}`)).join('\n\n');
    const user = `【当前分节】\n${secText}\n\n`
        + `【现有锚点】\n${oldAnchors.map(a => anchorLineWithId(a, ctx)).join('\n') || '(无)'}\n\n`
        + `【待合并的剧情记录】\n`
        + batch.map((c, i) => `${i + 1}. ${rangeLabel(ctx, c)}${c.title ? c.title + ':' : ''}${c.text}`).join('\n')
        + `\n\n【这批记录的人物变化】\n${shiftText || '(无;请从记录正文里自己判断)'}`
        + (needy.length ? `\n\n【需要补必留点的记录线索】\n${needy.map(({ c, i }) => `【序号${i + 1}】\n${c.clues.map(x => `- ${x}`).join('\n')}`).join('\n')}` : '')
        + `\n\n【这批记录的新锚点】\n${newAnchors.map(a => anchorLineWithId(a, ctx)).join('\n') || '(无)'}`;
    const merged = await generateJson(ctx, PROMPT_FOLD_MERGE, user, opts);
    const draft = asText(merged.prelude);
    const sections = { prelude: draft };
    for (const k of SECTION_KEYS) if (k !== 'prelude') sections[k] = asText(merged[k]);
    if (!SECTION_KEYS.some(k => sections[k])) throw new Error('模型没有返回可用的长期记忆');
    sections.people = checkOrigins(ctx, data, sections.people);
    const resolved = normalizeResolved(merged.resolved, validIds);
    // 补挑的必留点:先临时挂到胶囊上,再派生锚点、去重;没提交成功就原样撤回
    const added = normalizeNewPoints(merged.newPoints, batch, maxPointsOf(settings));
    const prevPoints = new Map();
    for (const [cap, pts] of added) {
        prevPoints.set(cap, cap.points);
        cap.points = pts.map((p, i) => ({ id: pointId(cap, i), k: p.k, t: p.t, key: p.key, ...(p.d ? { d: p.d } : {}), at: cap.toId }));
    }
    let committed = false;
    try {
        // 提交后的生效锚点(预演):旧 retired 去掉已不存在的点,再并入本次撤下的
        const retired = {};
        for (const [id, r] of Object.entries(oldMem?.retired || {})) retired[id] = r;
        Object.assign(retired, resolved);
        // 物品现状:模型给的 items 在本地对着预演锚点校验、合并;被并入的条进 retired
        const itemRes = applyItems(merged.items, deriveAnchors(data.capsules, retired, batchIds), oldMem?.itemNow, floorChecker(ctx, data));
        const itemNow = itemRes.itemNow;
        Object.assign(retired, itemRes.merged);
        const keptOf = {};
        const dups = dedupeAnchors(deriveAnchors(data.capsules, retired, batchIds), keptOf); // 模型漏判的重复,本地再合并一遍
        Object.assign(retired, dups);
        for (const id of Object.keys(dups)) { // 被去重撤下的那条有现状而保留的没有:挪过去
            let to = keptOf[id];
            for (let g = 0; to && dups[to] && g < 10; g++) to = keptOf[to];
            if (itemNow[id] && to && !dups[to] && !itemNow[to]) itemNow[to] = itemNow[id];
            delete itemNow[id];
        }
        const finalAnchors = deriveAnchors(data.capsules, retired, batchIds, itemNow);

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
        // 只新增一篇:已写好的篇章原样保留,sections.prelude 是各篇拼起来的派生值
        const chapters = oldChapters.map(c => ({ ...c }));
        if (sections.prelude) {
            chapters.push({ id: makeChapterId(), fromId: batch[0].fromId, toId: batch[batch.length - 1].toId, text: sections.prelude, gen: 1, ts: Date.now() });
        }
        sections.prelude = joinChapters(chapters);
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
        for (const id of Object.keys(itemNow)) if (!live.has(id)) delete itemNow[id]; // 锚点没了,现状一并清掉
        data.memory = { sections, chapters, retired, itemNow, text, tokens, ts: Date.now() };
        committed = true;
        for (const c of batch) c.folded = true; // 正文保留:撤销要能原样恢复,日后也供关键词召回
        trimVersions(data, versionLimit(settings));
        coalesceOlderFolded(ctx, data, protectedIds(data));
        status.lastFold = { ts: Date.now(), polished, reason };
        if (reason && draft) pushNotice(`本次用了草稿:${reason}`);
        scheduleSave(ctx);
        refreshInject(ctx);
        // 篇章超出上限:合并最早的两篇(单独压一版;失败不影响本次折叠)
        let chapterMerged = false;
        try { chapterMerged = await mergeOldestChapters(ctx, data, settings, opts, meta); } catch (err) { console.warn('[Mnemosyne] 前情篇章合并出错', err); }
        return { folded: batch.length, polished, reason, merged: chapterMerged };
    } finally {
        if (!committed) for (const [cap, pts] of prevPoints) cap.points = pts;
    }
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

/** 用户手动编辑长期记忆全文(分节部分;「## 锚点」一节由系统派生,编辑里写了也会被忽略)。前情按 `### #起–止` 切回篇章。 */
export async function saveMemoryText(ctx, text) {
    const data = ensureData(ctx);
    const t = String(text || '').trim();
    if (!t) data.memory = null;
    else {
        const sections = sectionsFromText(t);
        const chapters = chaptersFromEdit(ctx, sections.prelude, chaptersOf(data.memory, data.capsules));
        sections.prelude = joinChapters(chapters);
        const mem = { sections, chapters, retired: data.memory?.retired || {}, itemNow: data.memory?.itemNow || {}, text: '', tokens: 0, ts: Date.now() };
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

/** 面板编辑框里用的文本:只含分节,不含锚点;给了 ctx 时前情每篇前面带一行 `### #起–止`。 */
export function editableMemoryText(mem, ctx = null) {
    if (!mem) return '';
    const sections = { ...(mem.sections || sectionsFromText(mem.text)) };
    if (ctx) {
        const chs = chaptersOf(mem, peekData(ctx)?.capsules);
        if (chs.length) sections.prelude = chaptersEditText(ctx, chs);
    }
    return composeMemory(sections, '');
}

// ── 整理锚点:让模型把已经了结的条目撤下(一次调用,锚点太多时分批) ──

const TIDY_BATCH_OVER = 120; // 超过这么多条才分批
const TIDY_BATCH = 100;

/**
 * 整理锚点。成功返回 { resolved: 撤下条数, batches: 完成批数, partial: 是否中途失败 };第一批就失败则抛错。
 * 撤下前把当前长期记忆压一版进版本链(foldedIds 为空),所以「撤销上一次折叠」能撤回这次整理。
 */
export async function tidyAnchors(ctx) {
    const settings = getSettings(ctx);
    const data = peekData(ctx);
    const oldMem = data?.memory;
    if (!oldMem) throw new Error('还没有长期记忆');
    const meta = ctx.chatMetadata;
    const opts = llmOptsFrom(settings);
    beginEvent(ctx);
    const anchors = activeAnchors(data);
    if (!anchors.length) return { resolved: 0, batches: 0, partial: false };
    const sec = oldMem.sections || sectionsFromText(oldMem.text);
    const head = `【当前状态】\n${asText(sec.now) || '(空)'}\n\n【时间线】\n${asText(sec.timeline) || '(空)'}\n\n【未结事项】\n${asText(sec.open) || '(空)'}`;
    const size = anchors.length > TIDY_BATCH_OVER ? TIDY_BATCH : anchors.length;
    const resolved = {};
    let done = 0, failed = null;
    for (let i = 0; i < anchors.length; i += size) {
        const batch = anchors.slice(i, i + size);
        try {
            const out = await generateJson(ctx, PROMPT_ANCHOR_TIDY, `${head}\n\n【生效中的锚点】\n${batch.map(a => anchorLineWithId(a, ctx)).join('\n')}`, opts);
            Object.assign(resolved, normalizeResolved(out.resolved, new Set(batch.map(a => a.id))));
            done++;
        } catch (err) {
            failed = err;
            break;
        }
        if (liveMeta(ctx) !== meta || data.memory !== oldMem) return { skipped: 'stale' };
    }
    if (failed && !done) throw failed;
    if (liveMeta(ctx) !== meta || data.memory !== oldMem) return { skipped: 'stale' };
    const ids = Object.keys(resolved);
    if (ids.length) {
        data.versions.push({ ts: Date.now(), before: cloneMemory(oldMem), foldedIds: [] });
        const itemNow = { ...(oldMem.itemNow || {}) };
        for (const id of ids) delete itemNow[id]; // 锚点没了,现状一并清掉
        data.memory = { ...oldMem, retired: { ...(oldMem.retired || {}), ...resolved }, itemNow, ts: Date.now() };
        rebuildText(data);
        trimVersions(data, versionLimit(settings));
        scheduleSave(ctx);
        refreshInject(ctx);
    }
    if (failed) {
        console.warn('[Mnemosyne] 整理锚点中途失败', failed);
        pushNotice('整理到一半失败,已完成的批次已生效,可以再点一次继续');
    }
    return { resolved: ids.length, batches: done, partial: !!failed };
}
