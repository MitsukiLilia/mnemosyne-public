// 装配层:取 ctx、绑酒馆事件、建魔杖菜单入口与悬浮球、挂面板。
// 事件处理的原则(性能铁律):每个事件只处理受影响的楼层,不整本重算;所有写入走 scheduleSave 合并。
import {
    beginEvent, consumeDeletePoint, noteAppend, peekData, scheduleSave, stats as stateStats,
    syncRefs, verifyAfter, verifyAll, verifyFloor, ensureData,
} from './core/state.js';
import { getSettings, saveSettings } from './core/settings.js';
import { kick, perf, config as recorderConfig, setGenerating, resetRecorderRuntime, whenIdle } from './core/recorder.js';
import * as recorder from './core/recorder.js';
import * as fold from './core/fold.js';
import * as hide from './core/hide.js';
import * as inject from './core/inject.js';
import { status, emitChange, pushNotice } from './core/bus.js';
import { createPanel } from './ui/panel.js';
import { ICON_MENU } from './ui/icons.js';

// 自报家门:排查「更新了却在跑旧码」时,控制台比对版本号即知真伪。
export const MNEMO_VERSION = '0.4.1';
globalThis.__MNEMO_VERSION = MNEMO_VERSION;
console.info(`[Mnemosyne] v${MNEMO_VERSION} 已加载`);

const getCtx = () => globalThis.SillyTavern.getContext();

function waitForExtensionsMenu(cb) {
    const found = document.getElementById('extensionsMenu');
    if (found) { cb(found); return; }
    const timer = setInterval(() => {
        const el = document.getElementById('extensionsMenu');
        if (el) { clearInterval(timer); cb(el); }
    }, 400);
}

let panel = null;
let fab = null;

// ── 校验结果的统一收尾 ──
// 只做:取消失效胶囊的隐藏、提示、重算注入、排一次保存、催自动记录重新记。
function handleVerify(ctx, res, label) {
    if (!res.changed) { inject.refreshInject(ctx); return; } // 没坏也要重算:锚点筛选依赖最近几楼
    const s = getSettings(ctx);
    beginEvent(ctx);
    hide.reconcile(ctx, s.reserve);
    if (res.invalidated.length) {
        pushNotice(`${label},对应记录已作废,将重新记录`);
    }
    if (res.foldedTouched.length && !res.rolledBack && !res.pointsDropped) {
        const n = res.foldedTouched[0] + 1;
        pushNotice(`第 ${Math.max(1, n)} 楼在长期记忆覆盖范围内被改动,可手动编辑长期记忆`);
    }
    for (const msg of res.notices) pushNotice(msg);
    scheduleSave(ctx);
    inject.refreshInject(ctx);
    kick(ctx);
    emitChange();
}

// ── 事件 ──
function onReceived() {
    const ctx = getCtx();
    if (!getSettings(ctx).enabled) return;
    beginEvent(ctx);
    noteAppend(ctx);
    hide.syncReserve(ctx, getSettings(ctx).reserve);
    inject.refreshInject(ctx);
    kick(ctx);
}
function onSent() {
    const ctx = getCtx();
    if (!getSettings(ctx).enabled) return;
    beginEvent(ctx);
    noteAppend(ctx);
    hide.syncReserve(ctx, getSettings(ctx).reserve);
    inject.refreshInject(ctx);
}
function onFloorChanged(index) {
    const ctx = getCtx();
    if (!getSettings(ctx).enabled || !Number.isInteger(index)) return;
    beginEvent(ctx);
    const res = verifyFloor(ctx, index);
    handleVerify(ctx, res, `第 ${index + 1} 楼变了`);
}
function onDeleted() {
    const ctx = getCtx();
    if (!getSettings(ctx).enabled) return;
    beginEvent(ctx);
    const point = consumeDeletePoint(ctx);
    const res = verifyAfter(ctx, point);
    if (!res.changed) hide.reconcile(ctx, getSettings(ctx).reserve); // 胶囊都没坏也要整理:聊天变短,保留区退回到已隐藏的楼
    handleVerify(ctx, res, `第 ${point + 1} 楼附近有楼层被删除`);
}
function onChatChanged() {
    const ctx = getCtx();
    resetRecorderRuntime();
    if (!ctx.chatMetadata) { inject.refreshInject(ctx); emitChange(); return; }
    beginEvent(ctx);
    syncRefs(ctx);
    const s = getSettings(ctx);
    const data = peekData(ctx);
    if (data?.backfill?.running) { data.backfill.running = false; scheduleSave(ctx); } // 上次中途关页留下的残标记
    if (s.enabled && data) {
        const res = verifyAll(ctx);                       // 整本核对,只此一次
        if (res.changed) handleVerify(ctx, res, '有楼层在别处被改动');
        hide.reconcile(ctx, s.reserve, { withHide: true });
    }
    inject.refreshInject(ctx);
    kick(ctx);
    emitChange();
}
function onGenStart(type, params, dryRun) { if (!dryRun) setGenerating(true); }
function onGenEnd() { setGenerating(false); kick(getCtx()); }

// ── 悬浮球 ──
function ensureFab() {
    const ctx = getCtx();
    const s = getSettings(ctx);
    if (!s.showFab) { fab?.remove(); fab = null; return; }
    if (fab) return;
    fab = document.createElement('div');
    fab.id = 'mnemosyne-fab';
    fab.title = 'Mnemosyne';
    fab.innerHTML = ICON_MENU;
    if (Number.isFinite(s.fabTop)) fab.style.top = s.fabTop + 'px';
    document.body.appendChild(fab);
    let drag = null;
    fab.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, top: fab.offsetTop, moved: false }; fab.setPointerCapture(e.pointerId); });
    fab.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dy = e.clientY - drag.y;
        if (Math.abs(dy) > 6) drag.moved = true;
        if (drag.moved) fab.style.top = Math.min(window.innerHeight - 56, Math.max(8, drag.top + dy)) + 'px';
    });
    fab.addEventListener('pointerup', () => {
        if (!drag) return;
        if (!drag.moved) panel.toggle();
        else { const c = getCtx(); getSettings(c).fabTop = fab.offsetTop; saveSettings(c); }
        drag = null;
    });
    fab.addEventListener('pointercancel', () => { drag = null; });
}

function onSettingsChanged() {
    const ctx = getCtx();
    ensureFab();
    inject.refreshInject(ctx);
    if (getSettings(ctx).enabled) { hide.syncReserve(ctx, getSettings(ctx).reserve); kick(ctx); }
}

function main() {
    panel = createPanel({ getCtx, onSettingsChanged });
    const ctx = getCtx();
    const { eventSource, eventTypes: ev } = ctx;

    eventSource.on(ev.MESSAGE_RECEIVED, onReceived);
    eventSource.on(ev.MESSAGE_SENT, onSent);
    eventSource.on(ev.MESSAGE_EDITED, onFloorChanged);
    if (ev.MESSAGE_UPDATED) eventSource.on(ev.MESSAGE_UPDATED, onFloorChanged);
    eventSource.on(ev.MESSAGE_SWIPED, onFloorChanged);
    eventSource.on(ev.MESSAGE_DELETED, onDeleted);
    eventSource.on(ev.CHAT_CHANGED, onChatChanged);
    if (ev.GENERATION_STARTED) eventSource.on(ev.GENERATION_STARTED, onGenStart);
    if (ev.GENERATION_ENDED) eventSource.on(ev.GENERATION_ENDED, onGenEnd);
    if (ev.GENERATION_STOPPED) eventSource.on(ev.GENERATION_STOPPED, onGenEnd);

    waitForExtensionsMenu((menu) => {
        if (document.getElementById('mnemosyne-menu-item')) return;
        const item = document.createElement('a');
        item.id = 'mnemosyne-menu-item';
        item.className = 'list-group-item';
        item.href = '#';
        item.title = 'Mnemosyne';
        item.innerHTML = `${ICON_MENU}<span>Mnemosyne</span>`;
        item.addEventListener('click', (e) => { e.preventDefault(); panel.toggle(); });
        menu.appendChild(item);
    });
    inject.registerMacro(ctx, getCtx);
    ensureFab();
    // 扩展在聊天已打开之后才加载时,CHAT_CHANGED 早已过去:启动时补跑一次
    if (getCtx().chatMetadata) onChatChanged();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();

/** 测试台入口:不属于对外 API。 */
export const api = {
    get panel() { return panel; },
    recorder, fold, hide, inject, status, perf, recorderConfig, whenIdle, stateStats,
    ensureData, onChatChanged,
    handlers: { onReceived, onSent, onFloorChanged, onDeleted, onChatChanged },
};
