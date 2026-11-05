// 全部图标手绘 SVG:线稿用 currentColor 描边,装饰件的颜色由 CSS 变量决定。禁 emoji、禁渐变。

const S = (inner, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${inner}</svg>`;

export const ICON_MENU = S('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M8 17h11M9.5 8.5h6M9.5 12h4"/>');
export const ICON_CLOSE = S('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke-width="2"');
export const ICON_CHEVRON = S('<path d="M9 5l7 7-7 7"/>');
export const ICON_CHEVRON_DOWN = S('<path d="M5 9l7 7 7-7"/>');
export const ICON_HOME = S('<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9.5h4.5v-5h3v5H18V10"/>');
export const ICON_CAPSULE = S('<rect x="3.5" y="9" width="17" height="6.5" rx="3.25" transform="rotate(-35 12 12.25)"/><path d="m9.2 7.9 6.6 6.4" />');
export const ICON_BOOK = S('<path d="M12 6.5C10 5 7 4.6 4 5v13c3-.4 6 0 8 1.5 2-1.5 5-1.9 8-1.5V5c-3-.4-6 0-8 1.5Z"/><path d="M12 6.5v13"/>');
export const ICON_GEAR = S('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"/>');
export const ICON_PEN = S('<path d="M4 20l1-4.2L16.6 4.2a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L8.2 19 4 20Z"/><path d="m14.5 6.3 3.2 3.2"/>');
export const ICON_UNDO = S('<path d="M8 8H4V4"/><path d="M4 8c1.8-2.6 4.6-4 8-4 4.8 0 8 3.4 8 8s-3.2 8-8 8c-3.2 0-5.8-1.4-7.4-3.6"/>');
export const ICON_TRASH = S('<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12h8.4L17 7"/>');
export const ICON_REFRESH = S('<path d="M20 5v5h-5"/><path d="M19.5 10A8 8 0 1 0 20 13"/>');
export const ICON_STOP = S('<rect x="6" y="6" width="12" height="12" rx="2"/>');
export const ICON_PLAY = S('<path d="M8 5.5v13l10-6.5-10-6.5Z"/>');
export const ICON_EYE = S('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>');
export const ICON_WARN = S('<path d="M12 4 3 19.5h18L12 4Z"/><path d="M12 10v4.5M12 17v.2"/>');
export const ICON_CHECK = S('<path d="M4.5 12.5l5 5L19.5 6.5"/>', 'stroke-width="2"');
export const ICON_RETIRE = S('<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/>');
export const ICON_FOLD = S('<path d="M5 8l7 4 7-4"/><path d="M5 13l7 4 7-4"/><path d="M12 3v5"/>');

// 装饰件(占位线稿,后续会换成烧制素材;class 名是换素材的挂点)
export const DECO_SPARK = '<svg class="mn-spark" viewBox="0 0 24 24"><path d="M12 2c.6 5 2.4 8 8 10-5.6 2-7.4 5-8 10-.6-5-2.4-8-8-10 5.6-2 7.4-5 8-10Z"/></svg>';
export const DECO_BOW = '<svg class="mn-bow" viewBox="0 0 64 34"><path d="M32 16C27 4 12 1 7 9c-3.5 6 6 16 25 7Z"/><path d="M32 16c5-12 20-15 25-7 3.5 6-6 16-25 7Z"/><path d="M30 19 22 31l7-3 2 4 1-12Zm4 0 8 12-7-3-2 4-1-12Z"/><rect x="28.5" y="12.5" width="7" height="7" rx="3"/></svg>';
export const DECO_FLOURISH = '<svg class="mn-flourish" viewBox="0 0 200 16" preserveAspectRatio="none"><path d="M2 8c20 0 30-6 50-6 14 0 20 6 36 6M198 8c-20 0-30-6-50-6-14 0-20 6-36 6"/></svg>';
export const DECO_RIBBON = '<svg class="mn-ribbon" viewBox="0 0 430 40" preserveAspectRatio="none"><path d="M0 14C40 4 80 6 120 18S190 28 215 14 290 2 330 12s70 14 100 4"/><path class="mn-ribbon-edge" d="M0 21C40 11 80 13 120 25S190 35 215 21 290 9 330 19s70 14 100 4"/></svg>';

/** 蕾丝边:一排下垂的小圆弧 + 小孔眼,纯 path/circle 平铺,没有渐变。 */
export function laceEdge(width = 440, step = 22) {
    const n = Math.ceil(width / step);
    let d = `M0 0V3`;
    let holes = '';
    for (let k = 0; k < n; k++) {
        d += `a${step / 2} ${step / 2} 0 0 0 ${step} 0`;
        holes += `<circle cx="${k * step + step / 2}" cy="${5}" r="1.5"/>`;
    }
    d += `V0Z`;
    return `<svg class="mn-lace" viewBox="0 0 ${n * step} ${step / 2 + 3}" preserveAspectRatio="none"><path d="${d}"/>${holes}</svg>`;
}
