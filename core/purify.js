// 正文提纯:送去总结的文字跟随酒馆自己的配置,不认识任何具体标签名。
//   ① 正则脚本里「进提示词」那一档(isPrompt:true);
//   ② 思维链按 Reasoning 设置里声明的前后缀摘除;
//   ③ 用户在设置里列出的「额外剔除标签」整块删除;
//   ④ 最后去 HTML 标签壳。

let regexEngine; // undefined = 未加载 / null = 不可用 / 对象 = 可用

/** 引擎是酒馆的非公开模块,引入失败时提纯降级,由界面提示用户用「额外剔除标签」兜底。 */
export let textPurificationDegraded = false;

export async function ensureRegexEngine() {
    if (regexEngine !== undefined) return regexEngine;
    try {
        // 扩展目录为 scripts/extensions/third-party/<name>/core/,这条相对路径指向 scripts/extensions/regex/engine.js
        const eng = await import('../../../regex/engine.js');
        regexEngine = (typeof eng.getRegexedString === 'function' && eng.regex_placement)
            ? { get: eng.getRegexedString, place: eng.regex_placement } : null;
    } catch (err) {
        console.warn('[Mnemosyne] 正则引擎引入失败', err);
        regexEngine = null;
    }
    if (!regexEngine) {
        textPurificationDegraded = true;
        console.warn('[Mnemosyne] 正文提纯已降级:预设正则未生效,请在设置里用「额外剔除的标签」兜底。');
    }
    return regexEngine;
}

// 前缀常被写进 assistant prefill、不出现在消息体里:只要后缀在前半段出现,就把它之前的整段当思维链切掉。
function stripReasoning(ctx, text) {
    const r = ctx.powerUserSettings?.reasoning;
    if (!r?.auto_parse) return text;
    const pre = String(r.prefix || '').trim();
    const suf = String(r.suffix || '').trim();
    if (!suf) return text;
    const end = text.indexOf(suf);
    if (end === -1) return text;
    const start = pre ? text.indexOf(pre) : -1;
    if (start !== -1 && start < end) return text.slice(0, start) + text.slice(end + suf.length);
    if (end < text.length / 2) return text.slice(end + suf.length);
    return text;
}

function dropExcludedTags(text, excludeTags) {
    const tags = String(excludeTags || '').split(/[,，\s]+/).map(t => t.trim().replace(/^<|>$/g, '')).filter(t => /^[A-Za-z_][\w-]*$/.test(t));
    let s = text;
    for (const t of tags) {
        s = s.replace(new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?</${t}>`, 'gi'), '');
    }
    return s;
}

function stripHtml(text) {
    return String(text || '').replace(/<[^>]+>/g, '').trim();
}

/** 一条消息 → 干净正文。depth 同酒馆语义:距末尾的层数(末层 = 0)。 */
export function cleanMessageText(ctx, msg, depth, excludeTags) {
    let s = String(msg?.mes || '');
    if (regexEngine) {
        try {
            s = regexEngine.get(s, msg?.is_user ? regexEngine.place.USER_INPUT : regexEngine.place.AI_OUTPUT,
                { isPrompt: true, depth });
        } catch (err) {
            console.warn('[Mnemosyne] 正则执行失败,本楼跳过正则', err);
        }
    }
    s = stripReasoning(ctx, s);
    s = dropExcludedTags(s, excludeTags);
    return stripHtml(s);
}
