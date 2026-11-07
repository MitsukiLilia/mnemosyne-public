// 隐藏/恢复旧楼层。机制与官方 /hide 相同(message.is_system + .mes 的 is_system 属性),
// 但不调用斜杠命令:官方实现每次都整本保存一次,这里只改内存,保存交给合并后的 scheduleSave。
// 酒馆自己的系统消息、用户手动隐藏的楼层不归本插件管:只有写进 hiddenIds 的才会被恢复。

import {
    assignFloorId, coverage, findCapsuleCovering, floorId, idIndex, isHiddenByUs, isStory, markHidden, unmarkHidden,
    peekData, reserveBoundary, scheduleSave, setHiddenIds,
} from './state.js';

function setDomHidden(index, hidden) {
    try {
        const el = globalThis.document?.querySelector?.(`#chat .mes[mesid="${index}"]`);
        el?.setAttribute('is_system', String(hidden));
    } catch { /* 无 DOM(测试/无头)时忽略 */ }
}

/** 隐藏第 index 层。已经是系统消息(原生或用户隐藏)的不动。返回是否新隐藏。 */
export function hideIndex(ctx, index) {
    const msg = ctx.chat[index];
    if (!msg || msg.is_system) return false;
    const id = assignFloorId(ctx, index);
    msg.is_system = true;
    markHidden(ctx, id);
    setDomHidden(index, true);
    return true;
}

export function unhideIndex(ctx, index) {
    const msg = ctx.chat[index];
    const id = floorId(msg);
    if (!msg || !id || !isHiddenByUs(ctx, id)) return false;
    msg.is_system = false;
    unmarkHidden(ctx, id);
    setDomHidden(index, false);
    return true;
}

/** 隐藏 [fi, ti] 内、保留区之前的正文楼。返回新隐藏的数量。 */
export function hideRange(ctx, fi, ti, limitIdx) {
    let n = 0;
    const end = Math.min(ti, limitIdx - 1);
    for (let i = fi; i <= end; i++) {
        if (hideIndex(ctx, i)) n++;
    }
    return n;
}

/** 恢复全部:只恢复 hiddenIds 里的,不碰原生系统消息和用户自己隐藏的。返回恢复数量。 */
export function restoreAll(ctx) {
    const data = peekData(ctx);
    if (!data || !data.hiddenIds.length) return 0;
    let n = 0;
    for (const id of data.hiddenIds.slice()) {
        const i = idIndex(ctx, id);
        if (i >= 0 && ctx.chat[i]?.is_system) {
            ctx.chat[i].is_system = false;
            setDomHidden(i, false);
            n++;
        }
    }
    setHiddenIds(ctx, []);
    scheduleSave(ctx);
    return n;
}

/**
 * 保留区同步(双向):
 * ① 删楼让聊天变短后,保留区会退回到已隐藏的楼上 → 把保留区里我们藏的楼放出来;
 * ② 之后继续聊,这些楼重新移出保留区 → 从边界往前补藏,碰到已藏或没被覆盖的正文楼就停。
 * ①只扫保留区那几楼;②只走新移出的几楼。都与聊天总长无关。返回 { unhidden, hidden }。
 */
export function syncReserve(ctx, reserve) {
    const data = peekData(ctx);
    const out = { unhidden: 0, hidden: 0 };
    if (!data) return out;
    const limit = reserveBoundary(ctx, reserve);
    for (let i = limit; i < ctx.chat.length; i++) {
        if (unhideIndex(ctx, i)) out.unhidden++;
    }
    if (data.capsules.length) {
        for (let i = limit - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (!m) break;
            if (m.is_system) {
                if (isHiddenByUs(ctx, floorId(m))) break; // 接上已藏的部分
                continue;                                 // 原生系统消息/用户自己藏的:跳过
            }
            if (!isStory(ctx, m) || !findCapsuleCovering(ctx, data, i)) break;
            if (hideIndex(ctx, i)) out.hidden++;
        }
    }
    if (out.unhidden || out.hidden) scheduleSave(ctx);
    return out;
}

/**
 * 整理:登记在册的隐藏楼若已不在任何札记范围内(札记作废)就取消隐藏、楼已不存在就从登记里去掉;
 * withHide=true 时再把「被覆盖且在保留区之前、还没隐藏」的正文楼补隐藏(换聊天时用)。
 * O(隐藏数 · log 札记数),withHide 时多一遍 O(被覆盖楼层数)。返回 { unhidden, hidden }。
 */
export function reconcile(ctx, reserve, { withHide = false } = {}) {
    const data = peekData(ctx);
    const out = { unhidden: 0, hidden: 0 };
    if (!data) return out;
    const ranges = coverage(ctx, data).filter(r => r.fi >= 0 && r.ti >= r.fi)
        .map(r => [r.fi, r.ti]).sort((a, b) => a[0] - b[0]);
    const covered = (i) => {
        let lo = 0, hi = ranges.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (ranges[mid][0] <= i) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return best >= 0 && ranges[best][1] >= i;
    };
    const keep = [];
    for (const id of data.hiddenIds) {
        const i = idIndex(ctx, id);
        if (i < 0) continue;                       // 楼已被删
        if (!covered(i)) {                         // 札记已作废:取消隐藏
            const m = ctx.chat[i];
            if (m?.is_system) { m.is_system = false; setDomHidden(i, false); out.unhidden++; }
            continue;
        }
        keep.push(id);
    }
    if (keep.length !== data.hiddenIds.length) {
        setHiddenIds(ctx, keep);
        scheduleSave(ctx);
    }
    if (withHide) {
        const limit = reserveBoundary(ctx, reserve);
        for (const [a, b] of ranges) out.hidden += hideRange(ctx, a, b, limit);
        if (out.hidden) scheduleSave(ctx);
    }
    const r = syncReserve(ctx, reserve);
    out.unhidden += r.unhidden; out.hidden += r.hidden;
    return out;
}

export { isStory };
