// 面板:Shadow DOM 隔离,手机优先(宽 ≤ 480 全屏,桌面居中浮窗)。四页:首页 / 胶囊 / 长期记忆 / 设置。
// 面板关着时不渲染、不订阅 DOM、不跑任何更新;状态变化通过 bus 订阅,开着才重绘(rAF 合并)。

import { beginEvent, peekData, resolveCapsule, scheduleSave, summary } from '../core/state.js';
import { activeAnchors, anchorLine, retiredAnchors, sectionsFromText } from '../core/memory.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../core/settings.js';
import { pushNotice, status, subscribe } from '../core/bus.js';
import { clearSkipped, countPending, foldNowExclusive, kick, rewriteCapsule, skippedList, startBackfill, stopBackfill } from '../core/recorder.js';
import { editableMemoryText, restoreAnchor, retireAnchor, saveMemoryText, undoFold, unfoldedTokens } from '../core/fold.js';
import { reconcile, restoreAll } from '../core/hide.js';
import { refreshInject } from '../core/inject.js';
import { fetchCustomApiModels } from '../core/llm.js';
import { textPurificationDegraded } from '../core/purify.js';
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

const TABS = [
    { id: 'home', label: '首页', icon: I.ICON_HOME },
    { id: 'capsules', label: '胶囊', icon: I.ICON_CAPSULE },
    { id: 'memory', label: '长期记忆', icon: I.ICON_BOOK },
    { id: 'settings', label: '设置', icon: I.ICON_GEAR },
];

export function createPanel({ getCtx, onSettingsChanged }) {
    let host = null, shadow = null, root = null, body = null, mql = null, unsub = null;
    let page = 'home';
    let raf = 0;
    const ui = {
        expanded: new Set(), editingCap: null, editingMem: false, confirmDel: null, confirmRestore: false,
        capLimit: 30, anchorLimit: 40, retiredOpen: false, models: { loading: false, list: [], error: '' }, toast: '',
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
            <div class="mn-head-ribbon">${I.DECO_RIBBON}</div>
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
        return `<section class="mn-card mn-card-main mn-stats">
            <div class="mn-stat"><div class="mn-stat-num">${sm.coveredTo >= 0 ? sm.coveredTo + 1 : 0}</div><div class="mn-stat-label">已记录到第几楼</div></div>
            <div class="mn-stat"><div class="mn-stat-num">${sm.capsules}</div><div class="mn-stat-label">胶囊数</div></div>
            <div class="mn-stat"><div class="mn-stat-num">${fmtNum(sm.memoryChars)}</div><div class="mn-stat-label">长期记忆字数</div></div>
            <div class="mn-stat"><div class="mn-stat-num">${sm.hidden}</div><div class="mn-stat-label">已隐藏楼层</div></div>
            <span class="mn-stats-spark">${I.DECO_SPARK}</span>
        </section>`;
    }

    function switchHtml(action, on, label) {
        return `<button class="mn-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-action="${action}"><span></span></button>`;
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
        const progText = bf.running
            ? `第 ${bf.batch} / ${bf.batches} 批,已覆盖到第 ${Math.max(0, bf.coveredTo + 1)} 楼`
            : (pending > 0 ? `还有 ${pending} 轮未记录` : '所有已移出保留区的楼层都已记录');

        let notes = '';
        if (status.error) {
            notes += `<section class="mn-card mn-note mn-note-err"><span class="mn-note-ico">${I.ICON_WARN}</span><div><b>最近一次失败</b><p>${esc(status.error.msg)}</p><small>${fmtTime(status.error.ts)} · 修好连接后点「${failed ? '继续补建' : '补建历史'}」或等下一条消息再试</small></div></section>`;
        }
        const skipped = skippedList(c);
        if (skipped.length) {
            const ranges = skipped.slice(0, 6).map(it => it.fi === it.ti ? `第 ${it.fi + 1} 楼` : `第 ${it.fi + 1}–${it.ti + 1} 楼`).join('、') + (skipped.length > 6 ? ` 等 ${skipped.length} 处` : '');
            notes += `<section class="mn-card mn-note mn-note-err"><span class="mn-note-ico">${I.ICON_WARN}</span><div><b>有 ${skipped.length} 轮被模型拒绝,没有记录</b><p>${esc(ranges)}。这些楼不会被隐藏,主模型仍能看到原文;可以手动写进长期记忆,或换个模型后重试。</p><small>${esc(skipped[skipped.length - 1].reason)}</small><div class="mn-links"><button class="mn-link" data-action="retry-skipped">${I.ICON_REFRESH}<span>清除标记并重试</span></button></div></div></section>`;
        }
        if (status.backlog > 0 && !bf.running) {
            notes += `<section class="mn-card mn-note"><span class="mn-note-ico">${I.ICON_BOOK}</span><div><p>有 ${status.backlog} 轮旧对话还没有记录,自动记录不会一次处理这么多,请用下面的「补建历史」。</p></div></section>`;
        }
        if (textPurificationDegraded) {
            notes += `<section class="mn-card mn-note"><span class="mn-note-ico">${I.ICON_WARN}</span><div><p>正文提纯已降级:预设正则没有生效。可在设置里用「额外剔除的标签」兜底。</p></div></section>`;
        }
        for (const n of status.notices.slice(0, 3)) {
            notes += `<section class="mn-card mn-note"><span class="mn-note-ico">${I.ICON_CHECK}</span><div><p>${esc(n.msg)}</p><small>${fmtTime(n.ts)}</small></div></section>`;
        }

        return `${statCard(c)}
        <section class="mn-card mn-row"><div class="mn-row-text"><div class="mn-row-title">自动记录</div><div class="mn-row-sub">新的一轮移出最近 ${s.reserve} 层后,自动写成记录</div></div>${switchHtml('toggle-auto', s.autoRecord, '自动记录')}</section>
        <button class="mn-big${bf.running ? ' running' : ''}" data-action="${bigAction}" ${status.busy && !bf.running ? 'disabled' : ''}><span class="mn-big-ico">${bigIcon}</span><span>${bigLabel}</span></button>
        <div class="mn-progress"><div class="mn-progress-track"><div class="mn-progress-fill" style="width:${pct}%"></div></div><span class="mn-progress-text">${esc(progText)}</span></div>
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
        let html = `<div class="mn-page-head"><h2>胶囊</h2><span class="mn-page-sub">${live.length} 个未折叠${folded ? ` · ${folded} 个已并入长期记忆` : ''}</span></div>`;
        if (!live.length) {
            html += `<section class="mn-card mn-empty"><p>还没有胶囊。聊下去会自动记录,长聊天可以在首页点「补建历史」。</p></section>`;
            return html;
        }
        const list = live.slice().reverse().slice(0, ui.capLimit);
        for (const cap of list) {
            const open = ui.expanded.has(cap.id);
            const editing = ui.editingCap === cap.id;
            html += `<section class="mn-card mn-cap${open ? ' open' : ''}" data-cap="${esc(cap.id)}">
                <button class="mn-cap-head" data-action="toggle-cap" data-id="${esc(cap.id)}" aria-expanded="${open}">
                    <span class="mn-cap-thumb">${I.ICON_CAPSULE}</span>
                    <span class="mn-cap-main"><span class="mn-cap-title">${esc(cap.title || '(无标题)')}</span>
                    <span class="mn-cap-meta">${esc(capRange(c, cap))} · ${fmtTime(cap.ts)} · ${cap.tokens || 0} tokens</span>
                    ${open ? '' : `<span class="mn-cap-preview">${esc(cap.text)}</span>`}</span>
                    <span class="mn-chev${open ? ' down' : ''}">${I.ICON_CHEVRON}</span>
                </button>`;
            if (open) {
                if (editing) {
                    html += `<div class="mn-cap-body"><input class="mn-input" data-edit="title" value="${esc(cap.title)}" placeholder="标题">
                        <textarea class="mn-textarea" data-edit="text" rows="7">${esc(cap.text)}</textarea>
                        <div class="mn-btn-row"><button class="mn-btn mn-btn-primary" data-action="save-cap" data-id="${esc(cap.id)}">保存</button><button class="mn-btn" data-action="cancel-edit">取消</button></div></div>`;
                } else {
                    const delArmed = ui.confirmDel === cap.id;
                    html += `<div class="mn-cap-body"><p class="mn-cap-text">${nl2br(cap.text)}</p>
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

    function anchorsBlock(c, data) {
        const list = activeAnchors(data);
        const gone = retiredAnchors(data);
        if (!list.length && !gone.length) return '';
        const sorted = [];
        for (const k of POINT_KINDS) for (const a of list) if (a.k === k) sorted.push(a);
        const shown = sorted.slice(0, ui.anchorLimit);
        let html = `<section class="mn-card mn-anchors"><h3>锚点<span class="mn-page-sub">${list.length} 条生效</span></h3>
            <p class="mn-hint">折叠时由胶囊的必留点汇成,润色改不动它们。伏笔、约定始终注入,其余类别在相关词出现于最近几层时才注入。</p>`;
        if (!list.length) html += '<p class="mn-dim">(暂无生效的锚点)</p>';
        for (const a of shown) {
            html += `<div class="mn-anchor"><span class="mn-tag" data-kind="${esc(a.k)}">${esc(a.k)}</span>
                <span class="mn-anchor-main"><span class="mn-anchor-text">${esc(a.t)}</span><span class="mn-anchor-meta">${esc(anchorRange(c, a.cap))}${a.key ? ` · ${esc(a.key)}` : ''}</span></span>
                <button class="mn-btn mn-btn-sm" data-action="retire-anchor" data-id="${esc(a.id)}">撤下</button></div>`;
        }
        if (sorted.length > shown.length) html += `<button class="mn-btn mn-btn-wide" data-action="more-anchors">再显示 ${Math.min(40, sorted.length - shown.length)} 条(还剩 ${sorted.length - shown.length})</button>`;
        if (gone.length) {
            html += `<button class="mn-link" data-action="toggle-retired" aria-expanded="${ui.retiredOpen}"><span>已撤下 ${gone.length} 条</span><span class="mn-chev${ui.retiredOpen ? ' down' : ''}">${I.ICON_CHEVRON}</span></button>`;
            if (ui.retiredOpen) {
                for (const a of gone.slice(0, 80)) {
                    html += `<div class="mn-anchor mn-anchor-off"><span class="mn-tag" data-kind="${esc(a.k)}">${esc(a.k)}</span>
                        <span class="mn-anchor-main"><span class="mn-anchor-text">${esc(a.t)}</span><span class="mn-anchor-meta">${esc(a.result)}</span></span>
                        <button class="mn-btn mn-btn-sm" data-action="restore-anchor" data-id="${esc(a.id)}">恢复</button></div>`;
                }
            }
        }
        return html + '</section>';
    }

    function memoryPage(c, s) {
        const data = peekData(c);
        const mem = data?.memory;
        const un = data ? unfoldedTokens(data) : 0;
        const busy = !!status.busy;
        const nv = data?.versions?.length || 0;
        let html = `<div class="mn-page-head"><h2>长期记忆</h2><span class="mn-page-sub">${mem ? `${mem.text.length} 字 · ${fmtTime(mem.ts)}` : '尚未生成'}</span></div>
        <section class="mn-card mn-row"><div class="mn-row-text"><div class="mn-row-title">未折叠的胶囊</div><div class="mn-row-sub">${un} / ${s.foldThreshold} tokens,超过后会自动折叠最早的一半 · 可撤销 ${nv} 次</div></div></section>`;
        if (status.lastFold && !status.lastFold.polished && mem) {
            html += `<section class="mn-card mn-note"><span class="mn-note-ico">${I.ICON_WARN}</span><div><p>本次用了草稿${status.lastFold.reason ? `:${esc(status.lastFold.reason)}` : ''}</p><small>${fmtTime(status.lastFold.ts)} · 前情没有经过润色,事实和锚点完整</small></div></section>`;
        }
        if (ui.editingMem) {
            html += `<section class="mn-card"><textarea class="mn-textarea mn-textarea-tall" data-edit="mem" rows="16">${esc(mem ? editableMemoryText(mem) : SECTION_TITLES.map(t => `## ${t}\n`).join('\n'))}</textarea>
                <p class="mn-hint">保持五个「## 标题」不变,分节显示才会正常。锚点不在这里改,请在保存后用下方列表撤下或恢复。</p>
                <div class="mn-btn-row"><button class="mn-btn mn-btn-primary" data-action="save-mem">保存</button><button class="mn-btn" data-action="cancel-edit">取消</button></div></section>`;
        } else if (mem) {
            const sec = mem.sections || sectionsFromText(mem.text);
            SECTION_KEYS.forEach((k, i) => {
                html += `<section class="mn-card mn-mem-sec"><h3>${esc(SECTION_TITLES[i])}</h3><p>${sec[k] ? nl2br(sec[k]) : '<span class="mn-dim">(暂无)</span>'}</p></section>`;
            });
            html += anchorsBlock(c, data);
        } else {
            html += `<section class="mn-card mn-empty"><p>长期记忆还是空的。未折叠的胶囊超过阈值后会自动生成,也可以点下面的「立即折叠」。</p></section>`;
        }
        if (!ui.editingMem) {
            html += `<div class="mn-btn-row mn-btn-row-wrap">
                <button class="mn-btn" data-action="edit-mem">${I.ICON_PEN}<span>编辑</span></button>
                <button class="mn-btn" data-action="undo-fold" ${nv ? '' : 'disabled'}>${I.ICON_UNDO}<span>撤销上一次折叠${nv ? `(${nv})` : ''}</span></button>
                <button class="mn-btn mn-btn-primary" data-action="fold-now" ${busy || !(data && data.capsules.some(x => !x.folded)) ? 'disabled' : ''}>${I.ICON_FOLD}<span>立即折叠</span></button></div>`;
        }
        return html;
    }

    function selectHtml(key, value, options) {
        return `<select class="mn-input" data-set="${key}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    }
    function numField(key, label, value, { min = 0, max = 1e9, step = 1, hint = '', placeholder = '' } = {}) {
        return `<label class="mn-field"><span class="mn-field-label">${label}</span><input class="mn-input" type="number" inputmode="numeric" data-set="${key}" data-num="1" min="${min}" max="${max}" step="${step}" value="${value ?? ''}" placeholder="${esc(placeholder)}">${hint ? `<span class="mn-hint">${hint}</span>` : ''}</label>`;
    }

    function settingsPage(c, s) {
        const profiles = c.ConnectionManagerRequestService?.getSupportedProfiles?.() || [];
        const ca = s.customApi;
        const models = ui.models;
        return `<div class="mn-page-head"><h2>设置</h2><span class="mn-page-sub">Mnemosyne ${esc(globalThis.__MNEMO_VERSION || '')}</span></div>
        <section class="mn-card mn-group">
            <div class="mn-row"><div class="mn-row-text"><div class="mn-row-title">启用</div><div class="mn-row-sub">关闭后不记录、不注入</div></div>${switchHtml('set-enabled', s.enabled, '启用')}</div>
            <div class="mn-row"><div class="mn-row-text"><div class="mn-row-title">悬浮球</div><div class="mn-row-sub">可拖动的入口</div></div>${switchHtml('set-fab', s.showFab, '悬浮球')}</div>
            <label class="mn-field"><span class="mn-field-label">主题</span>${selectHtml('theme', s.theme, [['auto', '跟随系统'], ['day', '日间'], ['night', '夜间']])}</label>
        </section>
        <section class="mn-card mn-group"><h3>记录</h3>
            ${numField('reserve', '保留楼层数', s.reserve, { min: 0, max: 50, hint: '最近这几层始终保留原文,不记录、不隐藏' })}
            ${numField('foldThreshold', '折叠阈值(tokens)', s.foldThreshold, { min: 500, step: 100, hint: '未折叠胶囊合计超过它就折叠最早的一半' })}
            ${numField('batchMaxRounds', '补建每批轮数上限', s.batchMaxRounds, { min: 1, max: 40 })}
            ${numField('maxPoints', '每个胶囊的必留点上限', s.maxPoints, { min: 0, max: 10, hint: '台词、物品、数字、称呼、约定、伏笔;0 = 不收' })}
            ${numField('memoryVersions', '折叠版本保留数', s.memoryVersions, { min: 1, max: 10, hint: '可连续撤销的次数;链里的胶囊保留正文,挤出后才清空' })}
            <div class="mn-row"><div class="mn-row-text"><div class="mn-row-title">折叠后保留胶囊正文</div><div class="mn-row-sub">默认只留覆盖范围,省存档</div></div>${switchHtml('set-keepfolded', s.keepFoldedText, '折叠后保留胶囊正文')}</div>
            <label class="mn-field"><span class="mn-field-label">额外剔除的标签</span><input class="mn-input" type="text" data-set="excludeTags" value="${esc(s.excludeTags)}" placeholder="逗号分隔,如 status, panel" spellcheck="false"><span class="mn-hint">状态栏、面板这类块不进总结;整块连内容一起删</span></label>
        </section>
        <section class="mn-card mn-group"><h3>注入</h3>
            <label class="mn-field"><span class="mn-field-label">位置</span>${selectHtml('injectPosition', s.injectPosition, [[1, '聊天内'], [0, '主提示词之后'], [2, '主提示词之前']])}</label>
            ${numField('injectDepth', '深度', s.injectDepth ?? '', { min: 0, max: 200, placeholder: `跟随保留楼层数(${s.reserve})`, hint: '仅「聊天内」有效;留空 = 等于保留楼层数' })}
            <label class="mn-field"><span class="mn-field-label">角色</span>${selectHtml('injectRole', s.injectRole, [[0, 'system'], [1, 'user'], [2, 'assistant']])}</label>
            <label class="mn-field"><span class="mn-field-label">注入方式</span>${selectHtml('injectMode', s.injectMode, [['auto', '自动'], ['macro', '宏']])}${s.injectMode === 'macro' ? '<span class="mn-hint">已不再自动注入。把 <code>{{mnemosyne}}</code> 写进预设或角色卡里想放的位置,生成时会替换成长期记忆全文。</span>' : '<span class="mn-hint">自动 = 按下面的位置/深度/角色注入</span>'}</label>
            ${numField('anchorRecentFloors', '锚点参考的最近楼层数', s.anchorRecentFloors, { min: 1, max: 50, hint: '物品、数字、称呼、台词类锚点,相关词出现在这几层正文里才注入' })}
            ${numField('injectBudgetPct', '预算(占上下文 %)', Math.round(s.injectBudgetRatio * 100), { min: 1, max: 80, hint: '超了先丢最旧的胶囊,再丢最旧的非伏笔锚点;分节不裁' })}
        </section>
        <section class="mn-card mn-group"><h3>生成模型</h3>
            <label class="mn-field"><span class="mn-field-label">连接</span>${selectHtml('profileId', s.profileId, [['', '跟随酒馆当前连接'], ...profiles.map(p => [p.id, p.name])])}<span class="mn-hint">指定 Connection Profile 后,记录和折叠不占用主连接</span></label>
            <div class="mn-row"><div class="mn-row-text"><div class="mn-row-title">独立 API</div><div class="mn-row-sub">OpenAI 兼容端点,优先于上面的连接</div></div>${switchHtml('set-capi', ca.enabled, '独立 API')}</div>
            <label class="mn-field"><span class="mn-field-label">Base URL</span><input class="mn-input" type="text" data-capi="baseUrl" value="${esc(ca.baseUrl)}" placeholder="https://…/v1" spellcheck="false"></label>
            <label class="mn-field"><span class="mn-field-label">API Key</span><input class="mn-input" type="password" data-capi="apiKey" value="${esc(ca.apiKey)}" autocomplete="off"></label>
            <label class="mn-field"><span class="mn-field-label">模型名</span><input class="mn-input" type="text" data-capi="model" value="${esc(ca.model)}" placeholder="模型 id" spellcheck="false"></label>
            <div class="mn-btn-row"><button class="mn-btn" data-action="fetch-models" ${models.loading ? 'disabled' : ''}>${I.ICON_REFRESH}<span>${models.loading ? '拉取中……' : '拉取模型列表'}</span></button></div>
            ${models.error ? `<p class="mn-hint mn-hint-err">${esc(models.error)}</p>` : ''}
            ${models.list.length ? `<div class="mn-models">${models.list.map(m => `<button class="mn-model${m === ca.model ? ' on' : ''}" data-action="pick-model" data-model="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}
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
        if (!c.chatMetadata) content = `<section class="mn-card mn-empty"><p>请先打开一个聊天。</p></section>`;
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
            case 'toggle-retired': ui.retiredOpen = !ui.retiredOpen; render(); return;
            case 'more-anchors': ui.anchorLimit += 40; render(); return;
            case 'fold-now': {
                toast('折叠中……');
                try { const r = await foldNowExclusive(c); toast(r?.folded ? `已折叠 ${r.folded} 个胶囊${r.polished ? '' : '(本次用了草稿)'}` : '没有折叠'); }
                catch (err) { toast('折叠失败:' + (err?.message || err)); }
                render(); return;
            }
            case 'set-enabled': s.enabled = !s.enabled; saveSettings(c); onSettingsChanged?.(); render(); return;
            case 'set-fab': s.showFab = !s.showFab; saveSettings(c); onSettingsChanged?.(); render(); return;
            case 'set-keepfolded': s.keepFoldedText = !s.keepFoldedText; saveSettings(c); render(); return;
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
            redraw = key === 'theme' || key === 'injectMode';
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
