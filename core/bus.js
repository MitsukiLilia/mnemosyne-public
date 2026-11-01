// 运行状态与订阅:任务进度、最近错误、提示信息。界面只订阅这里,不轮询、不挂 DOM 观察器。

export const status = {
    busy: null,            // null | 'auto' | 'backfill' | 'rewrite' | 'fold'
    backfill: { running: false, stopRequested: false, done: 0, batch: 0, batches: 0, coveredTo: -1, finished: false },
    backlog: 0,            // 自动记录发现的未记录轮数(超出自动处理上限时,交给补建)
    error: null,           // { ts, msg }
    notices: [],           // [{ ts, msg }],最多留 5 条
    generating: false,
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emitChange() { for (const fn of subs) { try { fn(); } catch (err) { console.warn('[Mnemosyne] 订阅回调失败', err); } } }

export function setError(err) {
    status.error = err ? { ts: Date.now(), msg: String(err?.message || err) } : null;
    emitChange();
}

export function pushNotice(msg) {
    status.notices.unshift({ ts: Date.now(), msg });
    if (status.notices.length > 5) status.notices.length = 5;
    try { globalThis.toastr?.info?.(msg, 'Mnemosyne'); } catch { /* 无 toastr 时忽略 */ }
    emitChange();
}
