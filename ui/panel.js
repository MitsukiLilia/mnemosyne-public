// 面板:Shadow DOM 隔离,手机优先(宽 ≤ 480 全屏,桌面居中浮窗)。四页:首页 / 札记 / 长期记忆 / 设置。
// 面板关着时不渲染、不订阅 DOM、不跑任何更新;状态变化通过 bus 订阅,开着才重绘(rAF 合并)。

import { beginEvent, peekData, resolveCapsule, scheduleSave, summary } from '../core/state.js';
import { activeAnchors, anchorLine, retiredAnchors, sectionsFromText } from '../core/memory.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../core/settings.js';
import { pushNotice, status, subscribe } from '../core/bus.js';
import { clearChatData, clearSkipped, countPending, foldNowExclusive, kick, rewriteCapsule, setSource, skippedList, startBackfill, stopBackfill, tidyAnchorsExclusive } from '../core/recorder.js';
import { editableMemoryText, restoreAnchor, retireAnchor, saveMemoryText, undoFold, unfoldedTokens } from '../core/fold.js';
import { reconcile, restoreAll } from '../core/hide.js';
import { PART_KEYS, injectStats, refreshInject } from '../core/inject.js';
import { detectCandidates, isNameOk, sourceLabel, sourceOf } from '../core/extract.js';
import { parsePeople } from '../core/people.js';
import { chapterViews } from '../core/chapters.js';
import { fetchCustomApiModels } from '../core/llm.js';
import { parseExcludeTags, textPurificationDegraded } from '../core/purify.js';
import { POINT_KINDS, SECTION_KEYS, SECTION_TITLES } from '../core/prompts.js';
import * as I from './icons.js';

const CSS_URL = new URL('./panel.css', import.meta.url).href;

export const panelStats = { renders: 0 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
const fmtTime = (ts) => {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};
const fmtNum = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n));

// 共用装饰件:分隔线(日间双线+蝴蝶结 / 夜间细线+蝴蝶结+四芒星)、节标题(日间居中+叶饰 / 夜间靠左+下划线)、点线
const divider = () => `<div class="mn-div" aria-hidden="true"><i class="mn-div-l"></i><span class="mn-div-mid">${I.DECO_BOW}<span class="mn-div-star">${I.DECO_SPARK}</span></span><i class="mn-div-r"></i></div>`;
const secHead = (t, extra = '') => `<div class="mn-sec-h"><i></i><h3>${esc(t)}</h3><i></i>${extra}</div><div class="mn-sec-rule" aria-hidden="true"><i></i>${I.DECO_SPARK}<i></i></div>`;
const pageHead = (title, sub, extra = '') => `<div class="mn-page-head"><h2>${esc(title)}</h2><span class="mn-page-sub">${sub}</span>${extra}</div>`;
const dots = '<i class="mn-dots" aria-hidden="true"></i>';
const pearl = '<span class="mn-pearl" aria-hidden="true"></span>';

const TABS = [
    { id: 'home', label: '首页', icon: I.ICON_HOME },
    { id: 'capsules', label: '札记', icon: I.ICON_NOTE },
    { id: 'memory', label: '长期记忆', icon: I.ICON_BOOK },
    { id: 'settings', label: '设置', icon: I.ICON_GEAR },
];

export function createPanel({ getCtx, onSettingsChanged }) {
    let host = null, shadow = null, root = null, body = null, mql = null, unsub = null;
    let page = 'home';
    let raf = 0;
    const ui = {
        expanded: new Set(), editingCap: null, editingMem: false, confirmDel: null, confirmRestore: false, confirmClear: false,
        capLimit: 30, memOpen: new Set(), anchorOpen: new Set(), anchorLimits: {}, retiredOpen: false, srcOpen: false, injOpen: false, scan: null, tagScan: null, models: { loading: false, list: [], error: '' }, toast: '',
    };

    const ctx = () => getCtx();

    // ── 主题 ──
    function resolveTheme(s) {
        if (s.theme === 'day' || s.theme === 'night') return s.theme;
        try { return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'day'; } catch { return 'day'; }
    }

    // ── 页面 ──
    function head(c) {
        return `<header class="mn-head">
            <div class="mn-head-ribbon" aria-hidden="true"></div>
            <div class="mn-head-top">
                <span class="mn-head-side">${I.DECO_SPARK}</span>
                <h1 class="mn-title">Mnemosyne</h1>
                <button class="mn-icon-btn" data-action="close" aria-label="关闭">${I.ICON_CLOSE}</button>
            </div>
            <div class="mn-head-orn">${I.DECO_FLOURISH}<span class="mn-bow-wrap">${I.DECO_BOW}</span></div>
            <div class="mn-head-lace">${I.laceEdge()}</div>
        </header>`;
    }

    function statCard(c) {
        const sm = summary(c);
        const lastTok = injectStats.last ? fmtNum(injectStats.last.tokens) : '—';
        return `<section class="mn-stats">
            <div class="mn-stat"><div class="mn-stat-num">${sm.coveredTo >= 0 ? sm.coveredTo + 1 : 0}</div><div class="mn-stat-label">已记录到第几楼</div></div>
            <div class="mn-stat"><div class="mn-stat-num">${sm.capsules}</div><div class="mn-stat-label">札记数</div></div>
            <div class="mn-stat"><div class="mn-stat-num">${lastTok}</div><div class="mn-stat-label">上次注入</div></div>
            <div class="mn-stat"><div class="mn-stat-num">${sm.hidden}</div><div class="mn-stat-label">已隐藏楼层</div></div>
            <span class="mn-stats-spark">${I.DECO_SPARK}</span>
            <i class="mn-corner l" aria-hidden="true"></i><i class="mn-corner r" aria-hidden="true"></i>
        </section>`;
    }

    function switchHtml(action, on, label) {
        return `<button class="mn-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-action="${action}"><span></span></button>`;
    }

    // ── 摘要来源(每个聊天各自的设置) ──
    function candRow(kind, val, label, preview, cur, curFore) {
        const isCur = cur === val;
        return `<div class="mn-cand${isCur ? ' on' : ''}"><div class="mn-cand-main"><span class="mn-cand-name">${esc(label)}</span><span class="mn-cand-pre">${esc(preview || '(无内容)')}</span></div>
            <div class="mn-cand-btns"><button class="mn-btn mn-btn-sm${isCur ? ' mn-btn-primary' : ''}" data-action="pick-sum" data-kind="${kind}" data-val="${esc(val)}">${isCur ? '当前摘要' : '设为摘要'}</button>
            ${kind === 'tag' ? `<button class="mn-btn mn-btn-sm${curFore === val ? ' mn-btn-primary' : ''}" data-action="pick-fore" data-val="${esc(val)}">${curFore === val ? '当前伏笔' : '设为伏笔'}</button>` : ''}</div></div>`;
    }

    function sourceCard(c, src) {
        const extract = src.mode === 'extract';
        let html = `<section class="mn-blk mn-src"><button class="mn-lead mn-src-head" data-action="toggle-src" aria-expanded="${ui.srcOpen}">
            <span class="mn-lead-ico">${I.ICON_PEN}</span>${pearl}<span class="mn-lead-label">摘要来源</span><span class="mn-lead-sep">·</span><span class="mn-lead-val mn-lead-val-l">${esc(sourceLabel(src))}${extract && src.foreshadowTag ? `,伏笔:${esc(src.foreshadowTag)}` : ''}</span>${dots}
            <span class="mn-chev${ui.srcOpen ? ' down' : ''}">${I.ICON_CHEVRON}</span></button>`;
        if (ui.srcOpen) {
            html += `<div class="mn-src-body">
                <div class="mn-models"><button class="mn-model${extract ? '' : ' on'}" data-action="src-mode" data-mode="llm">自己写</button><button class="mn-model${extract ? ' on' : ''}" data-action="src-mode" data-mode="extract">从楼层提取</button></div>
                <p class="mn-hint">${extract ? '每一轮直接取 AI 楼里的摘要,不花 token;取不到的轮仍由模型补记。设置只对这个聊天生效。' : '由模型把每一轮写成记录(默认)。'}</p>`;
            if (extract) {
                html += `<div class="mn-src-form">
                    <select class="mn-input" data-src="ruleType"><option value="tag" ${src.rule.type === 'tag' ? 'selected' : ''}>标签</option><option value="details" ${src.rule.type === 'details' ? 'selected' : ''}>折叠块标题</option></select>
                    <input class="mn-input" type="text" data-src="ruleValue" value="${esc(src.rule.type === 'details' ? src.rule.title : src.rule.tag)}" placeholder="标签名或折叠块标题" spellcheck="false">
                    <input class="mn-input" type="text" data-src="fore" value="${esc(src.foreshadowTag)}" placeholder="伏笔标签(可留空)" spellcheck="false">
                    <button class="mn-btn mn-btn-primary" data-action="src-apply">应用</button></div>`;
            }
            html += `<div class="mn-btn-row"><button class="mn-btn" data-action="src-detect">${I.ICON_REFRESH}<span>检测最新一楼的标签</span></button></div>`;
            const sc = ui.scan;
            if (sc) {
                if (sc.floor < 0) html += '<p class="mn-hint">没有可检测的 AI 楼。</p>';
                else if (!sc.tags.length && !sc.details.length) html += `<p class="mn-hint">第 ${sc.floor + 1} 楼里没有标签。</p>`;
                else {
                    html += `<p class="mn-hint">第 ${sc.floor + 1} 楼里出现的标签:</p><div class="mn-cands">`;
                    const curTag = src.rule.type === 'tag' ? src.rule.tag : null, curDet = src.rule.type === 'details' ? src.rule.title : null;
                    for (const d of sc.details) html += candRow('details', d.title, `折叠块:${d.title}`, d.preview, extract ? curDet : null, '');
                    for (const t of sc.tags) html += candRow('tag', t.tag, `<${t.tag}>`, t.preview, extract ? curTag : null, src.foreshadowTag);
                    html += '</div>';
                }
            }
            html += '</div>';
        }
        return html + '</section>';
    }

    // ── 注入透明:上次注入多少 token、各部分占比、明细 ──
    const PART_LABEL = { prelude: '前情', people: '人物', now: '现状', timeline: '时间线', open: '未结', anchors: '锚点', recall: '旧记录', recent: '近期记录' };
    const WHY_LABEL = { recent: '最近没提到', budget: '预算裁剪', keyless: '没有关键词' };
    function injectCard(c, s) {
        const st = injectStats.last;
        if (!st) return `<section class="mn-blk mn-inj"><div class="mn-lead"><span class="mn-lead-ico">${I.ICON_FOLD}</span>${pearl}<span class="mn-lead-label">注入</span>${dots}<span class="mn-lead-val">还没有注入过</span></div></section>`;
        const warn = st.tokens > Number(s.injectWarnTokens);
        const total = Math.max(1, st.tokens);
        let html = `<section class="mn-blk mn-inj${warn ? ' mn-inj-warn' : ''}"><button class="mn-src-head mn-inj-head" data-action="toggle-inj" aria-expanded="${ui.injOpen}">
            <span class="mn-lead"><span class="mn-lead-ico">${I.ICON_FOLD}</span>${pearl}<span class="mn-lead-label">上次注入</span>${dots}<span class="mn-lead-val">约 ${st.tokens} token</span><span class="mn-chev${ui.injOpen ? ' down' : ''}">${I.ICON_CHEVRON}</span></span>
            <span class="mn-seg-bar">${PART_KEYS.filter(k => st.parts[k] > 0).map(k => `<span class="mn-seg" data-k="${k}" style="width:${(st.parts[k] / total * 100).toFixed(1)}%"></span>`).join('')}</span>
            <span class="mn-seg-legend">${PART_KEYS.filter(k => st.parts[k] > 0).map(k => `<span class="mn-seg-item"><i data-k="${k}"></i>${PART_LABEL[k]} ${Math.round(st.parts[k] / total * 100)}%</span>`).join('')}</span></button>`;
        if (warn) html += `<p class="mn-inj-note">${I.ICON_WARN}<span>注入偏长,模型可能分心;可以撤下不需要的锚点或手动精简长期记忆。</span></p>`;
        if (ui.injOpen) {
            const byId = new Map(activeAnchors(peekData(c)).map(a => [a.id, a]));
            const capById = new Map(peekData(c)?.capsules.map(x => [x.id, x]) || []);
            const recallTitle = (id) => capById.get(id)?.title || '(无标题)';
            const anchorLineOf = (id) => { const a = byId.get(id); return a ? `${a.k}:${a.t}` : id; };
            html += `<div class="mn-src-body"><p class="mn-hint">注入的人物(${st.peopleIn.length}):${st.peopleIn.length ? esc(st.peopleIn.join('、')) : '无'}${st.peopleOut ? `,另有 ${st.peopleOut} 人没提到、未注入` : ''}</p>
                <p class="mn-hint">注入的锚点(${st.anchorsIn.length}):</p>${st.anchorsIn.slice(0, 40).map(id => `<div class="mn-inj-line">${esc(anchorLineOf(id))}</div>`).join('') || '<div class="mn-inj-line">无</div>'}
                ${st.anchorsIn.length > 40 ? `<div class="mn-inj-line">……还有 ${st.anchorsIn.length - 40} 条</div>` : ''}
                <p class="mn-hint">被筛掉的锚点(${st.anchorsOut.length}):</p>${st.anchorsOut.slice(0, 40).map(o => `<div class="mn-inj-line"><b>${WHY_LABEL[o.why] || o.why}</b> ${esc(anchorLineOf(o.id))}</div>`).join('') || '<div class="mn-inj-line">无</div>'}
                ${st.anchorsOut.length > 40 ? `<div class="mn-inj-line">……还有 ${st.anchorsOut.length - 40} 条</div>` : ''}
                <p class="mn-hint">召回的旧记录(${(st.recall || []).length}):</p>${(st.recall || []).map(r => `<div class="mn-inj-line"><b>${esc(r.range || '')}</b> ${esc(recallTitle(r.id))}<span class="mn-anchor-meta mn-inj-why">命中:${esc(r.hits.join('、'))}</span></div>`).join('') || '<div class="mn-inj-line">无</div>'}</div>`;
        }
        return html + '</section>';
    }

    function homePage(c, s) {
        const bf = status.backfill;
        const data = peekData(c);
        const failed = data?.backfill?.failedAt != null && !bf.running && status.error;
        let pending = 0;
        try { pending = countPending(c); } catch { /* 无聊天时忽略 */ }
        let bigLabel = '补建历史', bigIcon = I.ICON_REFRESH, bigAction = 'backfill';
        if (bf.running) { bigLabel = bf.stopRequested ? '正在停止……' : '停止补建'; bigIcon = I.ICON_STOP; bigAction = 'stop'; }
        else if (failed || (bf.done > 0 && !bf.finished && pending > 0)) { bigLabel = '继续补建'; bigIcon = I.ICON_PLAY; }
        const total = Math.max(bf.batches, 1);
        const pct = bf.running || bf.done ? Math.min(100, Math.round(((bf.running ? bf.batch - 1 : bf.done) / total) * 100)) : 0;
        let progText = bf.running
            ? `第 ${bf.batch} / ${bf.batches} 批,已覆盖到第 ${Math.max(0, bf.coveredTo + 1)} 楼`
            : (pending > 0 ? `还有 ${pending} 轮未记录` : '所有已移出保留区的楼层都已记录');

        const src = sourceOf(data);
        if (src.mode === 'extract' && (status.extract.extracted || status.extract.llm)) {
            progText += ` · 本次提取了 ${status.extract.extracted} 轮,用 LLM 补记了 ${status.extract.llm} 轮`;
        }

        const noteRow = (kind, ico, main, small = '', extra = '') => `<div class="mn-note${kind ? ' mn-note-' + kind : ''}"><span class="mn-note-ico">${ico}</span><div class="mn-note-body">${main}${small ? `<small>${small}</small>` : ''}${extra}</div></div>`;
        let notes = '';
        if (status.error) {
            notes += noteRow('err', I.ICON_WARN, `<b>最近一次失败</b><p>${esc(status.error.msg)}</p>`, `${fmtTime(status.error.ts)} · 修好连接后点「${failed ? '继续补建' : '补建历史'}」或等下一条消息再试`);
        }
        const skipped = skippedList(c);
        if (skipped.length) {
            const ranges = skipped.slice(0, 6).map(it => it.fi === it.ti ? `第 ${it.fi + 1} 楼` : `第 ${it.fi + 1}–${it.ti + 1} 楼`).join('、') + (skipped.length > 6 ? ` 等 ${skipped.length} 处` : '');
            notes += noteRow('err', I.ICON_WARN, `<b>有 ${skipped.length} 轮被模型拒绝,没有记录</b><p>${esc(ranges)}。这些楼不会被隐藏,主模型仍能看到原文;可以手动写进长期记忆,或换个模型后重试。</p>`, esc(skipped[skipped.length - 1].reason), `<div class="mn-links"><button class="mn-link" data-action="retry-skipped">${I.ICON_REFRESH}<span>清除标记并重试</span></button></div>`);
        }
        if (status.backlog > 0 && !bf.running) {
            notes += noteRow('', I.ICON_BOOK, `<p>有 ${status.backlog} 轮旧对话还没有记录,自动记录不会一次处理这么多,请用下面的「补建历史」。</p>`);
        }
        if (textPurificationDegraded) {
            notes += noteRow('', I.ICON_WARN, `<p>正文提纯已降级:预设正则没有生效。可在设置里用「额外剔除的标签」兜底。</p>`);
        }
        for (const n of status.notices.slice(0, 3)) {
            notes += noteRow('', I.ICON_CHECK, `<p>${esc(n.msg)}</p>`, fmtTime(n.ts));
        }
        if (notes) notes = `<div class="mn-notes">${notes}</div>`;

        const bigCls = `mn-big${bf.running ? ' running' : ''}`;
        const showTrack = bf.running;
        return `${statCard(c)}
        ${divider()}
        ${sourceCard(c, src)}
        ${divider()}
        ${injectCard(c, s)}
        ${divider()}
        <section class="mn-blk"><div class="mn-lead"><span class="mn-lead-ico">${I.ICON_REFRESH}</span>${pearl}<span class="mn-lead-label">自动记录</span>${dots}${switchHtml('toggle-auto', s.autoRecord, '自动记录')}</div><div class="mn-row-sub">新的一轮移出最近 ${s.reserve} 层后,自动写成记录</div></section>
        ${divider()}
        <div class="mn-big-wrap"><button class="${bigCls}" data-action="${bigAction}" ${status.busy && !bf.running ? 'disabled' : ''}><span class="mn-big-ico">${bigIcon}</span><span>${bigLabel}</span></button></div>
        <div class="mn-progress">${showTrack ? `<div class="mn-progress-track"><div class="mn-progress-fill" style="width:${pct}%"></div></div>` : ''}<span class="mn-progress-text">${esc(progText)}</span></div>
        ${notes}
        <div class="mn-links"><button class="mn-link" data-action="restore-hidden">${I.ICON_EYE}<span>${ui.confirmRestore ? '再点一次确认恢复' : '恢复全部隐藏'}</span></button></div>`;
    }

    function capRange(c, cap) {
        const { fi, ti } = resolveCapsule(c, cap);
        return fi >= 0 ? (fi === ti ? `第 ${fi + 1} 楼` : `第 ${fi + 1}–${ti + 1} 楼`) : '楼层缺失';
    }

    function capsulesPage(c, s) {
        const data = peekData(c);
        beginEvent(c);
        const caps = data ? data.capsules : [];
        const live = caps.filter(x => !x.folded);
        const folded = caps.length - live.length;
        let html = pageHead('札记', `${live.length} 则未折叠${folded ? ` · ${folded} 则已并入长期记忆` : ''}`);
        if (!live.length) {
            html += `<section class="mn-empty"><p>还没有札记。聊下去会自动记录,长聊天可以在首页点「补建历史」。</p></section>`;
            return html;
        }
        const list = live.slice().reverse().slice(0, ui.capLimit);
        for (const cap of list) {
            const open = ui.expanded.has(cap.id);
            const editing = ui.editingCap === cap.id;
            html += `<section class="mn-cap${open ? ' open' : ''}" data-cap="${esc(cap.id)}">
                <button class="mn-cap-head" data-action="toggle-cap" data-id="${esc(cap.id)}" aria-expanded="${open}">
                    <span class="mn-cap-main"><span class="mn-cap-title">${esc(cap.title || '(无标题)')}</span>
                    <span class="mn-cap-meta">${esc(capRange(c, cap))} · ${cap.tokens || 0} tokens · ${fmtTime(cap.ts)}</span></span>
                    <span class="mn-chev${open ? ' down' : ''}">${I.ICON_CHEVRON}</span>
                </button>`;
            if (open) {
                if (editing) {
                    html += `<div class="mn-cap-body"><input class="mn-input" data-edit="title" value="${esc(cap.title)}" placeholder="标题">
                        <textarea class="mn-textarea" data-edit="text" rows="7">${esc(cap.text)}</textarea>
                        <div class="mn-btn-row"><button class="mn-btn mn-btn-primary" data-action="save-cap" data-id="${esc(cap.id)}">保存</button><button class="mn-btn" data-action="cancel-edit">取消</button></div></div>`;
                } else {
                    const delArmed = ui.confirmDel === cap.id;
                    html += `<div class="mn-cap-body"><p class="mn-cap-text">${nl2br(cap.text)}</p>${cap.shifts?.length ? `<p class="mn-hint">人物变化:${esc(cap.shifts.map(x => `${x.who}——${x.t}`).join(';'))}</p>` : ''}${cap.now ? `<p class="mn-hint">现场:${nl2br(cap.now)}</p>` : ''}
                        <div class="mn-btn-row">
                            <button class="mn-btn" data-action="edit-cap" data-id="${esc(cap.id)}">${I.ICON_PEN}<span>编辑</span></button>
                            <button class="mn-btn" data-action="rewrite-cap" data-id="${esc(cap.id)}" ${status.busy ? 'disabled' : ''}>${I.ICON_REFRESH}<span>按原文重写</span></button>
                            <button class="mn-btn mn-btn-danger" data-action="delete-cap" data-id="${esc(cap.id)}">${I.ICON_TRASH}<span>${delArmed ? '确认删除' : '删除'}</span></button>
                        </div>${delArmed ? '<p class="mn-hint">删除后这几楼会取消隐藏,并按设置重新记录。</p>' : ''}</div>`;
                }
            }
            html += `</section>`;
        }
        if (live.length > list.length) html += `<button class="mn-btn mn-btn-wide" data-action="more-caps">再显示 ${Math.min(30, live.length - list.length)} 条(还剩 ${live.length - list.length})</button>`;
        return html;
    }

    function anchorRange(c, cap) {
        const { fi, ti } = resolveCapsule(c, cap);
        if (fi < 0) return '楼层缺失';
        return fi === ti ? `#${fi + 1}` : `#${fi + 1}–${ti + 1}`;
    }

    const ANCHOR_STEP = 30;
    function anchorsBlock(c, data) {
        const list = activeAnchors(data);
        const gone = retiredAnchors(data);
        if (!list.length && !gone.length) return '';
        let html = `<section class="mn-sec mn-anchors">${secHead('锚点')}<p class="mn-sec-sub">${list.length} 条生效</p>
            <p class="mn-hint">折叠时由札记的必留点汇成,润色改不动它们。伏笔、约定、推测始终注入(推测会标「未证实」),其余类别在相关词出现于最近几层时才注入。物品会带上来历和现状,同一件东西会被合并成一条。</p>
            <div class="mn-btn-row"><button class="mn-btn" data-action="tidy-anchors" ${status.busy || !list.length ? 'disabled' : ''}>${I.ICON_RETIRE}<span>${status.busy === 'tidy' ? '整理中……' : '整理锚点'}</span></button></div>
            <p class="mn-hint">点「整理锚点」可以让模型把已经了结的条目撤下,撤错了可以恢复,也可以用「撤销上一次折叠」整体撤回。</p>`;
        if (!list.length) html += '<p class="mn-dim">(暂无生效的锚点)</p>';
        // 按类别分组,每组默认收起;展开后每次显示 ANCHOR_STEP 条
        for (const k of POINT_KINDS) {
            const group = list.filter(a => a.k === k);
            if (!group.length) continue;
            const open = ui.anchorOpen.has(k);
            html += `<button class="mn-agroup" data-action="toggle-akind" data-kind="${esc(k)}" aria-expanded="${open}"><span class="mn-tag" data-kind="${esc(k)}">${esc(k)}</span>${dots}<span class="mn-agroup-n">${group.length} 条</span><span class="mn-chev${open ? ' down' : ''}">${I.ICON_CHEVRON}</span></button>`;
            if (!open) continue;
            const limit = ui.anchorLimits[k] || ANCHOR_STEP;
            html += '<div class="mn-agroup-body">';
            for (const a of group.slice(0, limit)) {
                const itemMeta = a.k === '物品'
                    ? `${a.d ? `<span class="mn-anchor-meta">来历 · ${esc(a.d)}</span>` : ''}${a.now?.t ? `<span class="mn-anchor-meta">现状 · ${esc(a.now.t)}${a.now.at ? ` #${a.now.at}` : ''}</span>` : ''}`
                    : '';
                html += `<div class="mn-anchor">${pearl}
                    <span class="mn-anchor-main"><span class="mn-anchor-text">${esc(a.t)}</span>${itemMeta}<span class="mn-anchor-meta">${esc(anchorRange(c, a.cap))}${a.key ? ` · ${esc(a.key)}` : ''}</span></span>
                    <button class="mn-mini" data-action="retire-anchor" data-id="${esc(a.id)}" aria-label="撤下" title="撤下">${I.ICON_RETIRE}</button></div>`;
            }
            if (group.length > limit) html += `<button class="mn-btn mn-btn-wide" data-action="more-anchors" data-kind="${esc(k)}">再显示 ${Math.min(ANCHOR_STEP, group.length - limit)} 条(还剩 ${group.length - limit})</button>`;
            html += '</div>';
        }
        if (gone.length) {
            html += `<button class="mn-link mn-link-l" data-action="toggle-retired" aria-expanded="${ui.retiredOpen}"><span>已撤下 ${gone.length} 条</span><span class="mn-chev${ui.retiredOpen ? ' down' : ''}">${I.ICON_CHEVRON}</span></button>`;
            if (ui.retiredOpen) {
                for (const a of gone.slice(0, 80)) {
                    html += `<div class="mn-anchor mn-anchor-off">${pearl}<span class="mn-tag" data-kind="${esc(a.k)}">${esc(a.k)}</span>${dots}
                        <span class="mn-anchor-main"><span class="mn-anchor-text">${esc(a.t)}</span><span class="mn-anchor-meta">${esc(a.result)}</span></span>
                        <button class="mn-linkbtn" data-action="restore-anchor" data-id="${esc(a.id)}">恢复</button></div>`;
                }
            }
        }
        return html + '</section>';
    }

    // 长的节(前情、时间线)默认收起,状态只在内存
    const COLLAPSE_LINES = 6;
    const bulletLines = (text) => String(text || '').split('\n').map(x => x.trim().replace(/^[-·•*]\s*/, '')).filter(Boolean);
    const moreLink = (key, open) => `<button class="mn-link mn-link-l" data-action="toggle-sec" data-key="${key}" aria-expanded="${open}"><span>${open ? '收起' : '展开全部'}</span></button>`;

    // 前情按篇章分开:每篇篇首一行小字楼号,篇间用虚线隔开;展开/收起作用于整节
    function preludeHtml(text, views) {
        const paras = bulletLines(text);
        const long = views.length > 1 || paras.length > 2 || text.length > 150;
        const open = ui.memOpen.has('prelude');
        const chap = ({ ch, label }) => `<div class="mn-chap">${label ? `<span class="mn-anchor-meta mn-chap-no">${esc(label)}</span>` : ''}${bulletLines(ch.text).map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
        return `<div class="mn-prose${long && !open ? ' clamp' : ''}">${views.map(chap).join('')}</div>${long ? moreLink('prelude', open) : ''}`;
    }

    function timelineHtml(text) {
        const lines = bulletLines(text);
        const long = lines.length > COLLAPSE_LINES;
        const open = ui.memOpen.has('timeline');
        const shown = long && !open ? lines.slice(0, COLLAPSE_LINES) : lines;
        const rows = shown.map(l => {
            const m = l.match(/^(#\d+(?:\s*[–—~-]\s*#?\d+)?)\s*[:：]?\s*(.*)$/);
            return m ? `<div class="mn-tl">${pearl}<span class="mn-tl-no">${esc(m[1].replace(/\s+/g, ''))}</span>${dots}<span class="mn-tl-t">${esc(m[2])}</span></div>`
                : `<div class="mn-tl mn-tl-raw">${pearl}<span class="mn-tl-t">${esc(l)}</span></div>`;
        }).join('');
        return `<div class="mn-tls">${rows}</div>${long ? moreLink('timeline', open) : ''}`;
    }

    function linesHtml(text) {
        return `<div class="mn-tls">${bulletLines(text).map(l => `<div class="mn-tl mn-tl-raw">${pearl}<span class="mn-tl-t">${esc(l)}</span></div>`).join('')}</div>`;
    }

    function peopleHtml(text) {
        const blocks = parsePeople(text);
        const parsed = blocks.map(b => {
            const lines = b.raw.split('\n');
            if (!/^###\s+/.test(lines[0])) return null;
            const rows = lines.slice(1).map(l => l.match(/^(倾向|当前|来由)\s*[:：]\s*(.*)$/)).filter(Boolean);
            if (!rows.length) return null;
            return { name: lines[0].replace(/^###\s+/, ''), rows };
        });
        if (!blocks.length || parsed.some(x => !x)) return `<p class="mn-raw">${nl2br(text)}</p>`;
        return parsed.map(p => `<div class="mn-person">${pearl}<div class="mn-person-name">${esc(p.name)}</div><div class="mn-person-rows">${p.rows.map(r => `<div class="mn-lead mn-lead-fix"><span class="mn-lead-label">${r[1]}</span>${dots}<span class="mn-lead-val mn-lead-val-l">${esc(r[2])}</span></div>`).join('')}</div></div>`).join('');
    }

    function memoryPage(c, s) {
        const data = peekData(c);
        const mem = data?.memory;
        const un = data ? unfoldedTokens(data) : 0;
        const busy = !!status.busy;
        const nv = data?.versions?.length || 0;
        const editLink = ui.editingMem ? '' : `<button class="mn-linkbtn mn-edit-link" data-action="edit-mem" aria-label="编辑" title="编辑">${I.ICON_PEN}</button>`;
        let html = pageHead('长期记忆', `${mem ? `${mem.text.length} 字 · ${fmtTime(mem.ts)}` : '尚未生成'}`, editLink);
        html += `<p class="mn-sec-sub mn-mem-meta">未折叠的札记 ${un} / ${s.foldThreshold} tokens,超过后会自动折叠最早的一半 · 可撤销 ${nv} 次</p>`;
        if (status.lastFold && !status.lastFold.polished && mem) {
            html += `<div class="mn-notes"><div class="mn-note"><span class="mn-note-ico">${I.ICON_WARN}</span><div class="mn-note-body"><p>本次用了草稿${status.lastFold.reason ? `:${esc(status.lastFold.reason)}` : ''}</p><small>${fmtTime(status.lastFold.ts)} · 前情没有经过润色,事实和锚点完整</small></div></div></div>`;
        }
        if (ui.editingMem) {
            html += `<section class="mn-sec"><textarea class="mn-textarea mn-textarea-tall" data-edit="mem" rows="16">${esc(mem ? editableMemoryText(mem, c) : SECTION_TITLES.map(t => `## ${t}\n`).join('\n'))}</textarea>
                <p class="mn-hint">保持五个「## 标题」不变,分节显示才会正常。前情按篇章分开,每篇以 ### #楼号 开头,请保留这一行。「人物与关系」每人一块:先写一行「### 名字」,下面三行「倾向:……」「当前:……」「来由:#楼层 ……」。锚点不在这里改,请在保存后用下方列表撤下或恢复。</p>
                <div class="mn-btn-row"><button class="mn-btn mn-btn-primary" data-action="save-mem">保存</button><button class="mn-btn" data-action="cancel-edit">取消</button></div></section>`;
        } else if (mem) {
            const sec = mem.sections || sectionsFromText(mem.text);
            SECTION_KEYS.forEach((k, i) => {
                const t = sec[k] || '';
                let body;
                if (!t) body = '<p class="mn-dim">(暂无)</p>';
                else if (k === 'prelude') body = preludeHtml(t, chapterViews(c, mem, data.capsules));
                else if (k === 'people') body = peopleHtml(t);
                else if (k === 'timeline') body = timelineHtml(t);
                else body = linesHtml(t);
                html += `<section class="mn-sec mn-mem-sec" data-sec="${k}">${secHead(SECTION_TITLES[i])}${body}</section>`;
            });
            html += anchorsBlock(c, data);
        } else {
            html += `<section class="mn-empty"><p>长期记忆还是空的。未折叠的札记超过阈值后会自动生成,也可以点下面的「立即折叠」。</p></section>`;
        }
        if (!ui.editingMem) {
            html += `<div class="mn-btn-row mn-btn-row-wrap">
                <button class="mn-btn" data-action="undo-fold" ${nv ? '' : 'disabled'}>${I.ICON_UNDO}<span>撤销上一次折叠${nv ? `(${nv})` : ''}</span></button>
                <button class="mn-btn mn-btn-primary" data-action="fold-now" ${busy || !(data && data.capsules.some(x => !x.folded)) ? 'disabled' : ''}>${I.ICON_FOLD}<span>立即折叠</span></button></div>
            <div class="mn-foot-orn" aria-hidden="true"><i class="mn-shoe l"></i><span class="mn-foot-mid"><i></i>${I.DECO_BOW}<i></i></span><i class="mn-shoe r"></i></div>`;
        }
        return html;
    }

    function selectHtml(key, value, options) {
        return `<select class="mn-input" data-set="${key}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    }
    function numField(key, label, value, { min = 0, max = 1e9, step = 1, hint = '', placeholder = '' } = {}) {
        return `<label class="mn-field"><span class="mn-field-label">${label}</span><input class="mn-input" type="number" inputmode="numeric" data-set="${key}" data-num="1" min="${min}" max="${max}" step="${step}" value="${value ?? ''}" placeholder="${esc(placeholder)}">${hint ? `<span class="mn-hint">${hint}</span>` : ''}</label>`;
    }

    function excludePicker(s) {
        const sc = ui.tagScan;
        if (!sc) return '';
        if (sc.floor < 0) return '<p class="mn-hint">没有可检测的 AI 楼。</p>';
        if (!sc.tags.length) return `<p class="mn-hint">第 ${sc.floor + 1} 楼里没有标签。</p>`;
        const on = new Set(parseExcludeTags(s.excludeTags));
        return `<div class="mn-cands">${sc.tags.map(t => `<label class="mn-cand mn-cand-check"><input type="checkbox" data-excl="${esc(t.tag)}" ${on.has(t.tag) ? 'checked' : ''}><span class="mn-cand-main"><span class="mn-cand-name">&lt;${esc(t.tag)}&gt;</span><span class="mn-cand-pre">${esc(t.preview || '(无内容)')}</span></span></label>`).join('')}</div>`;
    }

    function settingsPage(c, s) {
        const profiles = c.ConnectionManagerRequestService?.getSupportedProfiles?.() || [];
        const ca = s.customApi;
        const models = ui.models;
        return `${pageHead('设置', `Mnemosyne ${esc(globalThis.__MNEMO_VERSION || '')}`)}
        <section class="mn-group">
            <div class="mn-srow"><div class="mn-lead"><span class="mn-lead-label mn-lead-label-s">启用</span>${dots}${switchHtml('set-enabled', s.enabled, '启用')}</div><div class="mn-row-sub">关闭后不记录、不注入</div></div>
            <div class="mn-srow"><div class="mn-lead"><span class="mn-lead-label mn-lead-label-s">悬浮球</span>${dots}${switchHtml('set-fab', s.showFab, '悬浮球')}</div><div class="mn-row-sub">可拖动的入口</div></div>
            <label class="mn-field"><span class="mn-field-label">主题</span>${selectHtml('theme', s.theme, [['auto', '跟随系统'], ['day', '日间'], ['night', '夜间']])}</label>
        </section>
        <section class="mn-group">${secHead('记录')}
            ${numField('reserve', '保留楼层数', s.reserve, { min: 0, max: 50, hint: '最近这几层始终保留原文,不记录、不隐藏' })}
            ${numField('foldThreshold', '折叠阈值(tokens)', s.foldThreshold, { min: 500, step: 100, hint: '未折叠札记合计超过它就折叠最早的一半' })}
            ${numField('preludeBudget', '前情上限(tokens)', s.preludeBudget, { min: 1000, max: 50000, step: 500, hint: '前情超过它时,把最早的两篇合并成一篇;越近的篇章保留越多细节' })}
            ${numField('batchMaxRounds', '补建每批轮数上限', s.batchMaxRounds, { min: 1, max: 40 })}
            ${numField('maxPoints', '每则札记的必留点上限', s.maxPoints, { min: 0, max: 10, hint: '台词、物品、数字、称呼、约定、伏笔;0 = 不收' })}
            ${numField('memoryVersions', '折叠版本保留数', s.memoryVersions, { min: 1, max: 10, hint: '可连续撤销的次数;前情篇章合并、整理锚点也各占一版' })}
            <div class="mn-field"><span class="mn-field-label">额外剔除的标签</span>
                <input class="mn-input" type="text" data-set="excludeTags" value="${esc(s.excludeTags)}" placeholder="逗号分隔,如 status, panel" spellcheck="false">
                <span class="mn-hint">预设和角色卡绑定的正则已经会自动生效(提纯走酒馆正则引擎「发送给模型」的口径,全局、角色、预设三类都算)。这里只做补充:正则没加载成功时兜底,或剔除预设留给主模型、但不想写进摘要的块(如状态栏)。整块连内容一起删。</span>
                <div class="mn-btn-row"><button class="mn-btn" data-action="scan-tags">${I.ICON_REFRESH}<span>从最新一楼勾选</span></button></div>
                ${excludePicker(s)}</div>
        </section>
        <section class="mn-group">${secHead('注入')}
            <label class="mn-field"><span class="mn-field-label">位置</span>${selectHtml('injectPosition', s.injectPosition, [[1, '聊天内'], [0, '主提示词之后'], [2, '主提示词之前']])}</label>
            ${numField('injectDepth', '深度', s.injectDepth ?? '', { min: 0, max: 200, placeholder: `跟随保留楼层数(${s.reserve})`, hint: '仅「聊天内」有效;留空 = 等于保留楼层数' })}
            <label class="mn-field"><span class="mn-field-label">角色</span>${selectHtml('injectRole', s.injectRole, [[0, 'system'], [1, 'user'], [2, 'assistant']])}</label>
            <label class="mn-field"><span class="mn-field-label">注入方式</span>${selectHtml('injectMode', s.injectMode, [['auto', '自动'], ['macro', '宏']])}${s.injectMode === 'macro' ? '<span class="mn-hint">已不再自动注入。把 <code>{{mnemosyne}}</code> 写进预设或角色卡里想放的位置,生成时会替换成长期记忆全文。</span>' : '<span class="mn-hint">自动 = 按下面的位置/深度/角色注入</span>'}</label>
            ${numField('anchorRecentFloors', '锚点参考的最近楼层数', s.anchorRecentFloors, { min: 1, max: 50, hint: '物品、数字、称呼、台词类锚点,相关词出现在这几层正文里才注入' })}
            ${numField('recallMax', '召回旧记录条数', s.recallMax, { min: 0, max: 10, hint: '最近几层提到某段旧记录的关键词时,把那段原始记录带回来;0 = 关闭' })}
            ${numField('timelineInjectLines', '时间线注入条数', s.timelineInjectLines, { min: 0, max: 200, hint: '只注入最近这么多条时间线,更早的交给前情;0 = 全部注入' })}
            ${numField('injectWarnTokens', '注入偏长提醒线(tokens)', s.injectWarnTokens, { min: 1000, max: 200000, step: 500, hint: '上次注入超过它,首页的注入卡片会标黄' })}
            ${numField('injectBudgetPct', '预算(占上下文 %)', Math.round(s.injectBudgetRatio * 100), { min: 1, max: 80, hint: '超了先丢最旧的札记,再丢最旧的非伏笔锚点;分节不裁' })}
        </section>
        <section class="mn-group">${secHead('生成模型')}
            <label class="mn-field"><span class="mn-field-label">连接</span>${selectHtml('profileId', s.profileId, [['', '跟随酒馆当前连接'], ...profiles.map(p => [p.id, p.name])])}<span class="mn-hint">指定 Connection Profile 后,记录和折叠不占用主连接</span></label>
            <div class="mn-srow"><div class="mn-lead"><span class="mn-lead-label mn-lead-label-s">独立 API</span>${dots}${switchHtml('set-capi', ca.enabled, '独立 API')}</div><div class="mn-row-sub">OpenAI 兼容端点,优先于上面的连接</div></div>
            <label class="mn-field"><span class="mn-field-label">Base URL</span><input class="mn-input" type="text" data-capi="baseUrl" value="${esc(ca.baseUrl)}" placeholder="https://…/v1" spellcheck="false"></label>
            <label class="mn-field"><span class="mn-field-label">API Key</span><input class="mn-input" type="password" data-capi="apiKey" value="${esc(ca.apiKey)}" autocomplete="off"></label>
            <label class="mn-field"><span class="mn-field-label">模型名</span><input class="mn-input" type="text" data-capi="model" value="${esc(ca.model)}" placeholder="模型 id" spellcheck="false"></label>
            <div class="mn-btn-row"><button class="mn-btn" data-action="fetch-models" ${models.loading ? 'disabled' : ''}>${I.ICON_REFRESH}<span>${models.loading ? '拉取中……' : '拉取模型列表'}</span></button></div>
            ${models.error ? `<p class="mn-hint mn-hint-err">${esc(models.error)}</p>` : ''}
            ${models.list.length ? `<div class="mn-models">${models.list.map(m => `<button class="mn-model${m === ca.model ? ' on' : ''}" data-action="pick-model" data-model="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}
        </section>
        <section class="mn-group">${secHead('数据')}
            <div class="mn-field"><span class="mn-field-label">清除这个聊天的记忆</span>
                <span class="mn-hint">删掉札记、长期记忆、锚点、折叠版本和补建进度,并恢复插件隐藏的楼层。聊天正文、这个聊天的「摘要来源」和设置页的所有选项(包括独立 API)都不受影响。清除后可以重新补建。</span>
                <div class="mn-btn-row"><button class="mn-btn mn-btn-danger" data-action="clear-data" ${status.busy || !peekData(c) ? 'disabled' : ''}>${I.ICON_TRASH}<span>${ui.confirmClear ? '再点一次确认清除' : '清除数据'}</span></button></div></div>
        </section>`;
    }

    // ── 渲染 ──
    function render() {
        if (!root) return;
        panelStats.renders++;
        const c = ctx();
        const s = getSettings(c);
        root.dataset.theme = resolveTheme(s);
        beginEvent(c);
        let content = '';
        if (!c.chatMetadata) content = `<section class="mn-empty"><p>请先打开一个聊天。</p></section>`;
        else if (page === 'home') content = homePage(c, s);
        else if (page === 'capsules') content = capsulesPage(c, s);
        else if (page === 'memory') content = memoryPage(c, s);
        else content = settingsPage(c, s);
        const scroller = body;
        const top = scroller?.scrollTop || 0;
        root.querySelector('.mn-main').innerHTML = content;
        root.querySelector('.mn-main').scrollTop = top;
        root.querySelector('.mn-tabs').innerHTML = TABS.map(t => `<button class="mn-tab${t.id === page ? ' active' : ''}" data-action="tab" data-page="${t.id}" aria-current="${t.id === page}"><span class="mn-tab-ico">${t.icon}</span><span class="mn-tab-label">${t.label}</span><span class="mn-tab-dot"></span></button>`).join('');
        const toastEl = root.querySelector('.mn-toast');
        toastEl.textContent = ui.toast; toastEl.classList.toggle('show', !!ui.toast);
    }

    function scheduleRender() {
        if (!isOpen() || raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            const a = shadow?.activeElement;
            if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return; // 正在输入,不重绘打断
            render();
        });
    }

    function toast(msg) {
        ui.toast = msg; render();
        setTimeout(() => { if (ui.toast === msg) { ui.toast = ''; if (isOpen()) render(); } }, 2600);
    }

    // ── 动作 ──
    async function doAction(action, el) {
        const c = ctx();
        const s = getSettings(c);
        const id = el?.dataset?.id;
        switch (action) {
            case 'close': close(); return;
            case 'tab': page = el.dataset.page; ui.editingCap = null; ui.editingMem = false; ui.confirmDel = null; render(); return;
            case 'toggle-auto': s.autoRecord = !s.autoRecord; saveSettings(c); if (s.autoRecord) kick(c, 0); render(); return;
            case 'backfill': {
                render(); const r = await startBackfill(c); if (r?.skipped) toast('有任务正在进行'); render(); return;
            }
            case 'stop': stopBackfill(); render(); return;
            case 'retry-skipped': clearSkipped(c); pushNotice('已清除跳过标记,点「补建历史」或等下一条消息重新记录'); render(); return;
            case 'restore-hidden':
                if (!ui.confirmRestore) { ui.confirmRestore = true; render(); setTimeout(() => { ui.confirmRestore = false; if (isOpen()) render(); }, 4000); return; }
                ui.confirmRestore = false;
                { const n = restoreAll(c); toast(n ? `已恢复 ${n} 层` : '没有需要恢复的楼层'); }
                return;
            case 'clear-data': {
                if (!ui.confirmClear) { ui.confirmClear = true; render(); setTimeout(() => { ui.confirmClear = false; if (isOpen()) render(); }, 4000); return; }
                ui.confirmClear = false;
                const r = clearChatData(c);
                ui.expanded.clear(); ui.editingCap = null; ui.editingMem = false; ui.confirmDel = null;
                toast(r?.skipped ? '有任务正在进行,请先停止' : `已清除${r.unhidden ? `,恢复了 ${r.unhidden} 层` : ''}`);
                return;
            }
            case 'toggle-cap': ui.expanded.has(id) ? ui.expanded.delete(id) : ui.expanded.add(id); ui.confirmDel = null; render(); return;
            case 'more-caps': ui.capLimit += 30; render(); return;
            case 'edit-cap': ui.editingCap = id; render(); return;
            case 'cancel-edit': ui.editingCap = null; ui.editingMem = false; render(); return;
            case 'save-cap': {
                const d = peekData(c), cap = d?.capsules.find(x => x.id === id);
                if (cap) {
                    cap.title = root.querySelector('[data-edit="title"]').value.trim();
                    cap.text = root.querySelector('[data-edit="text"]').value.trim();
                    cap.tokens = Math.ceil(cap.text.length * 0.9);
                    scheduleSave(c); refreshInject(c);
                }
                ui.editingCap = null; render(); return;
            }
            case 'delete-cap': {
                if (ui.confirmDel !== id) { ui.confirmDel = id; render(); return; }
                ui.confirmDel = null;
                const d = peekData(c);
                const k = d ? d.capsules.findIndex(x => x.id === id) : -1;
                if (k >= 0) {
                    d.capsules.splice(k, 1);
                    beginEvent(c);
                    reconcile(c, s.reserve);
                    scheduleSave(c); refreshInject(c); kick(c, 0);
                }
                render(); return;
            }
            case 'rewrite-cap': {
                toast('按原文重写中……');
                try { const r = await rewriteCapsule(c, id); toast(r?.ok ? '已重写' : '没有重写(任务繁忙或内容已变)'); }
                catch (err) { toast('重写失败:' + (err?.message || err)); }
                render(); return;
            }
            case 'edit-mem': ui.editingMem = true; render(); return;
            case 'save-mem': await saveMemoryText(c, root.querySelector('[data-edit="mem"]').value); ui.editingMem = false; render(); return;
            case 'undo-fold': {
                const ok = undoFold(c);
                toast(ok ? `已撤销,还可撤销 ${peekData(c)?.versions?.length || 0} 次` : '没有可撤销的折叠');
                return;
            }
            case 'retire-anchor': retireAnchor(c, id); render(); return;
            case 'restore-anchor': restoreAnchor(c, id); render(); return;
            case 'toggle-sec': ui.memOpen.has(el.dataset.key) ? ui.memOpen.delete(el.dataset.key) : ui.memOpen.add(el.dataset.key); render(); return;
            case 'toggle-retired': ui.retiredOpen = !ui.retiredOpen; render(); return;
            case 'more-anchors': { const k = el.dataset.kind; ui.anchorLimits[k] = (ui.anchorLimits[k] || ANCHOR_STEP) + ANCHOR_STEP; render(); return; }
            case 'toggle-akind': { const k = el.dataset.kind; ui.anchorOpen.has(k) ? ui.anchorOpen.delete(k) : ui.anchorOpen.add(k); render(); return; }
            case 'fold-now': {
                toast('折叠中……');
                try { const r = await foldNowExclusive(c); toast(r?.folded ? `已折叠 ${r.folded} 则札记${r.polished ? '' : '(本次用了草稿)'}` : '没有折叠'); }
                catch (err) { toast('折叠失败:' + (err?.message || err)); }
                render(); return;
            }
            case 'tidy-anchors': {
                toast('整理中……');
                try {
                    const r = await tidyAnchorsExclusive(c);
                    if (r?.skipped) toast(r.skipped === 'busy' ? '有任务正在进行' : '聊天已变化,没有整理');
                    else if (r.resolved) { ui.retiredOpen = true; toast(r.partial ? `整理到一半失败,已撤下 ${r.resolved} 条` : `整理完成,撤下 ${r.resolved} 条`); }
                    else toast(r.partial ? '整理失败' : '整理完成,没有需要撤下的条目');
                } catch (err) { toast('整理失败:' + (err?.message || err)); }
                render(); return;
            }
            case 'toggle-src': ui.srcOpen = !ui.srcOpen; render(); return;
            case 'toggle-inj': ui.injOpen = !ui.injOpen; render(); return;
            case 'src-mode': setSource(c, { mode: el.dataset.mode }); render(); return;
            case 'src-detect': ui.scan = detectCandidates(c); render(); return;
            case 'scan-tags': ui.tagScan = detectCandidates(c); render(); return;
            case 'pick-sum': {
                const rule = el.dataset.kind === 'details' ? { type: 'details', title: el.dataset.val } : { type: 'tag', tag: el.dataset.val };
                setSource(c, { mode: 'extract', rule }); render(); return;
            }
            case 'pick-fore': {
                const cur = sourceOf(peekData(c)).foreshadowTag;
                setSource(c, { foreshadowTag: cur === el.dataset.val ? '' : el.dataset.val }); render(); return;
            }
            case 'src-apply': {
                const type = root.querySelector('[data-src="ruleType"]').value;
                const val = root.querySelector('[data-src="ruleValue"]').value.trim();
                const fore = root.querySelector('[data-src="fore"]').value.trim();
                if (!val || (type === 'tag' && !isNameOk(val))) { toast('标签名只能是字母、数字、下划线、连字符或汉字'); return; }
                if (fore && !isNameOk(fore)) { toast('伏笔标签名不合法'); return; }
                setSource(c, { rule: type === 'details' ? { type, title: val } : { type, tag: val }, foreshadowTag: fore });
                toast('已应用'); return;
            }
            case 'set-enabled': s.enabled = !s.enabled; saveSettings(c); onSettingsChanged?.(); render(); return;
            case 'set-fab': s.showFab = !s.showFab; saveSettings(c); onSettingsChanged?.(); render(); return;
            case 'set-capi': s.customApi.enabled = !s.customApi.enabled; saveSettings(c); render(); return;
            case 'fetch-models': {
                ui.models = { loading: true, list: ui.models.list, error: '' }; render();
                try {
                    const list = await fetchCustomApiModels(s.customApi);
                    ui.models = { loading: false, list, error: list.length ? '' : '服务商没有返回任何模型' };
                } catch (err) {
                    ui.models = { loading: false, list: [], error: err instanceof TypeError ? '连不上(可能是网络或跨域限制)' : (err?.message || String(err)) };
                }
                render(); return;
            }
            case 'pick-model': s.customApi.model = el.dataset.model; saveSettings(c); render(); return;
        }
    }

    function onChange(e) {
        const c = ctx();
        const s = getSettings(c);
        const t = e.target;
        if (t.dataset.capi) { s.customApi[t.dataset.capi] = t.value.trim(); saveSettings(c); return; }
        if (t.dataset.excl) { // 勾选 ⇄ 手动输入框同步:都落在 excludeTags 上
            const list = parseExcludeTags(s.excludeTags);
            const k = list.indexOf(t.dataset.excl);
            if (t.checked && k < 0) list.push(t.dataset.excl);
            if (!t.checked && k >= 0) list.splice(k, 1);
            s.excludeTags = list.join(', ');
            saveSettings(c); render(); return;
        }
        const key = t.dataset.set;
        if (!key) return;
        let redraw = false;
        if (key === 'injectBudgetPct') {
            const v = Math.min(80, Math.max(1, Number(t.value) || 25));
            s.injectBudgetRatio = v / 100;
        } else if (key === 'injectDepth') {
            s.injectDepth = t.value === '' ? null : Math.max(0, Math.floor(Number(t.value) || 0));
        } else if (t.dataset.num) {
            const def = DEFAULT_SETTINGS[key];
            let v = Number(t.value);
            if (!Number.isFinite(v)) v = def;
            v = Math.min(Number(t.max) || v, Math.max(Number(t.min) || 0, Math.floor(v)));
            s[key] = v; t.value = v;
        } else if (['injectPosition', 'injectRole'].includes(key)) {
            s[key] = Number(t.value);
        } else {
            s[key] = t.value;
            redraw = key === 'theme' || key === 'injectMode' || key === 'excludeTags';
        }
        saveSettings(c);
        refreshInject(c);
        onSettingsChanged?.();
        if (redraw) render();
    }

    function onClick(e) {
        const el = e.target.closest('[data-action]');
        if (el && !el.disabled) { doAction(el.dataset.action, el).catch(err => console.warn('[Mnemosyne] 操作失败', err)); return; }
        if (e.target.classList?.contains('mn-backdrop')) close();
    }

    // ── 挂载与开合 ──
    function mount() {
        host = document.createElement('div');
        host.id = 'mnemosyne-host';
        host.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;height:100dvh;z-index:2147483000;display:none;'; // 同 panel.css 注释:真酒馆里 inset:0 会算出 0 高
        document.body.appendChild(host);
        shadow = host.attachShadow({ mode: 'open' });
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = CSS_URL;
        shadow.appendChild(link);
        root = document.createElement('div');
        root.className = 'mn-root';
        root.innerHTML = `<div class="mn-backdrop"></div>
            <div class="mn-sheet" role="dialog" aria-label="Mnemosyne">
                ${head()}
                <main class="mn-main"></main>
                <nav class="mn-tabs"></nav>
                <div class="mn-toast" role="status"></div>
            </div>`;
        shadow.appendChild(root);
        body = root.querySelector('.mn-main');
        root.addEventListener('click', onClick);
        root.addEventListener('change', onChange);
    }

    function isOpen() { return !!host && host.style.display !== 'none'; }
    function open(p) {
        if (!host) mount();
        if (p) page = p;
        host.style.display = 'block';
        unsub = unsub || subscribe(scheduleRender);
        try {
            mql = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
            mql?.addEventListener?.('change', scheduleRender);
        } catch { mql = null; }
        render();
    }
    function close() {
        if (!host) return;
        host.style.display = 'none';
        unsub?.(); unsub = null;
        try { mql?.removeEventListener?.('change', scheduleRender); } catch { /* ignore */ }
        mql = null;
        cancelAnimationFrame(raf); raf = 0;
        ui.editingCap = null; ui.editingMem = false; ui.confirmDel = null;
    }
    function toggle() { isOpen() ? close() : open(); }
    function goto(p) { page = p; if (isOpen()) render(); }

    return { open, close, toggle, isOpen, goto, refresh: scheduleRender, renderNow: render };
}
