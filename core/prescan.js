// 本地预扫(纯正则,零成本):从提纯后的批次原文里挑出「概括时最容易丢」的短句,附在请求末尾当线索。
// 三类:引号里的台词(中日文引号与英文引号)、数字加单位、状态变化词所在的句子。每条截到 CLUE_MAX 字,总数不超过 limit。

export const CLUE_MAX = 80;
export const CLUE_TITLE = '【易漏线索(仅供参考,不是清单)】';

const QUOTE_RE = /「[^」\n]{2,200}」|『[^』\n]{2,200}』|“[^”\n]{2,200}”|"[^"\n]{2,200}"/g;
const NUMBER_RE = /\d+(?:[.,:]\d+)?\s*(?:元|円|块|日元|美元|英镑|欧元|岁|歳|年|个月|ヶ月|か月|月|天|日|号|点|時|时|分|秒|小时|時間|週|周|次|回|个|個|件|本|枚|人|米|公里|千米|km|cm|kg|mm|%|％|度|楼|階|倍|万|千|百)/;
const CHANGE_RE = /交给|交給|给了|給了|收下|收到|拿走|拿起|带走|送给|送給|递给|遞給|借给|借給|还给|還給|丢了|弄丢|遗失|失去|答应|應允|承诺|承諾|发誓|發誓|约好|約好|约定|約定|保证|保證|改口|改叫|改称|改稱|叫我|从此|從此|渡す|渡した|あげる|あげた|もらった|受け取|預け|失くし|なくし|無くし|約束|誓う|誓った|改めて|と呼|呼び方|返す|返した|贈|プレゼント/;

const SENT_SPLIT = /(?<=[。！？!?…\n])/;

const trim = (s) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > CLUE_MAX ? t.slice(0, CLUE_MAX) + '…' : t;
};

/** 返回线索字符串数组(去重、三类轮流取,不超过 limit)。 */
export function prescanClues(text, limit = 12) {
    const src = String(text || '');
    if (!src) return [];
    const quotes = [];
    const rest = src.replace(QUOTE_RE, (m) => { quotes.push(m); return '\n'; });
    const numbers = [];
    const changes = [];
    for (const raw of rest.split(SENT_SPLIT)) {
        const s = raw.trim();
        if (s.length < 3) continue;
        if (CHANGE_RE.test(s)) changes.push(s);
        else if (NUMBER_RE.test(s)) numbers.push(s);
    }
    // 台词里的数字、约定同样重要,但台词本身已经收了,不重复处理
    const lists = [quotes, changes, numbers].map(l => l.map(trim));
    const out = [];
    const seen = new Set();
    for (let i = 0; out.length < limit; i++) {
        let any = false;
        for (const l of lists) {
            if (i >= l.length) continue;
            any = true;
            if (seen.has(l[i]) || out.length >= limit) continue;
            seen.add(l[i]);
            out.push(l[i]);
        }
        if (!any) break;
    }
    return out;
}

/** 附在用户消息末尾的文本块;没有线索返回空串。 */
export function clueBlock(text, limit = 12) {
    const clues = prescanClues(text, limit);
    return clues.length ? `\n\n${CLUE_TITLE}\n${clues.map(c => `- ${c}`).join('\n')}` : '';
}
