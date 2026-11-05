// 人物动线(「人物与关系」节):每人一块「### 名字 / 倾向 / 当前 / 来由」。解析、楼号校验、按在场/提及筛选。纯字符串逻辑。

export const PEOPLE_LIMIT = 8;
const ALIAS_SPLIT = /[／/()()（）]/;
const namesOf = (s) => String(s).split(ALIAS_SPLIT).map(x => x.trim()).filter(Boolean);

/** 文本 → [{ names, raw }]。有「### 」标题按标题切;否则兼容旧格式(每行「名字:……」一块)。 */
export function parsePeople(text) {
    const src = String(text || '').replace(/\r/g, '');
    const blocks = [];
    if (/^###\s+\S/m.test(src)) {
        let cur = null;
        for (const line of src.split('\n')) {
            const h = line.match(/^###\s+(.+?)\s*$/);
            if (h) { cur = { names: namesOf(h[1]), raw: line.trim() }; blocks.push(cur); }
            else if (cur && line.trim()) cur.raw += '\n' + line.trim();
        }
        return blocks.filter(b => b.names.length);
    }
    for (const line of src.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(/^([^:：]{1,20})[:：]/);
        if (m) blocks.push({ names: namesOf(m[1]), raw: t });
        else if (blocks.length) blocks[blocks.length - 1].raw += '\n' + t;
    }
    return blocks.filter(b => b.names.length);
}

/** 来由行里的 #楼号:不合法的去掉(那条来由保留)。valid(n) 判断 1 起的楼号是否合法。 */
export function sanitizeOrigins(text, valid) {
    return String(text || '').split('\n').map(line => {
        if (!/^\s*来由\s*[:：]/.test(line)) return line;
        return line.replace(/#(\d+)(?:\s*[–—~-]\s*#?(\d+))?[:：]?[ \t]*/g, (m, a, b) => {
            const x = Number(a), y = b === undefined ? x : Number(b);
            return valid(x) && valid(y) ? m : '';
        });
    }).join('\n');
}

/** 「在场」那一行(现场快照里);没有返回空串。 */
export function presentLine(nowText) {
    const m = String(nowText || '').match(/^\s*在场(?:人物|人员)?\s*[:：]\s*(.*)$/m);
    return m ? m[1] : '';
}

/**
 * 筛选要注入的人物:在场的 + 最近文本里提到过的;超过 limit 时在场的优先,其余按最近一次被提到的先后。
 * 返回 { chosen(保持原顺序), outCount }。
 */
export function selectPeople(blocks, present, recent, limit = PEOPLE_LIMIT) {
    const cand = [];
    for (const b of blocks) {
        const isPresent = !!present && b.names.some(n => present.includes(n));
        let last = -1;
        for (const n of b.names) { const p = recent.lastIndexOf(n); if (p > last) last = p; }
        if (isPresent || last >= 0) cand.push({ b, isPresent, last });
    }
    let picked = cand;
    if (cand.length > limit) {
        picked = cand.slice().sort((x, y) => (Number(y.isPresent) - Number(x.isPresent)) || (y.last - x.last)).slice(0, limit);
    }
    const set = new Set(picked.map(c => c.b));
    return { chosen: blocks.filter(b => set.has(b)), outCount: blocks.length - set.size };
}
