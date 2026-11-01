// 模型调用:独立 API > 指定 Connection Profile > 酒馆当前连接(裸调用)。
// 裸调用带防污染卫兵:发送前酒馆会广播 CHAT_COMPLETION_PROMPT_READY,别的扩展可能借它向所有请求
// 注入自家指令。这里在该事件上挂最后一个监听,只认领本次请求的 system/user 两条消息,把外来消息剔掉。

const RESPONSE_BUDGET = 16384;

/** 宽容 JSON 解析:剥代码围栏、剥前后杂文,失败返回 null。 */
export function parseLenientJson(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    const tryParse = (t) => {
        try { const v = JSON.parse(t); return (v && typeof v === 'object') ? v : null; } catch { return null; }
    };
    // 答案通常在最后:围栏从后往前试,每个围栏各试各的,不覆写原文。
    const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (let i = fences.length - 1; i >= 0; i--) {
        const hit = tryParse(fences[i][1].trim());
        if (hit) return hit;
    }
    const whole = tryParse(s);
    if (whole) return whole;
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) return tryParse(s.slice(start, end + 1));
    return null;
}

// ── 独立 API ──

function buildChatEndpoint(baseUrl) {
    const u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) return null;
    if (u.endsWith('/chat/completions')) return u;
    if (/\/v\d+$/.test(u)) return u + '/chat/completions';
    return u + '/v1/chat/completions';
}

function buildModelsEndpoint(baseUrl) {
    let u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) return null;
    u = u.replace(/\/chat\/completions$/, '');
    if (/\/v\d+$/.test(u)) return u + '/models';
    return u + '/v1/models';
}

/** 拉取模型列表(OpenAI 兼容 GET /models),返回去重排序后的 id 数组;失败抛错。 */
export async function fetchCustomApiModels(customApi) {
    const url = buildModelsEndpoint(customApi?.baseUrl);
    if (!url) throw new Error('先填 Base URL');
    const res = await fetch(url, {
        headers: customApi.apiKey ? { Authorization: `Bearer ${customApi.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data?.data || data?.models || []);
    const ids = list.map(m => (typeof m === 'string' ? m : (m?.id || m?.name || ''))).map(x => String(x).replace(/^models\//, '')).filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// 部分网关无视 stream:false 强行回 SSE:收到 SSE 就逐行拼出全文。
function parseSseText(text) {
    let out = '';
    for (const line of text.split('\n')) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (payload === '[DONE]') break;
        try {
            const j = JSON.parse(payload);
            out += j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? '';
        } catch { /* 跳过坏行 */ }
    }
    return out;
}

async function callCustomApi(customApi, systemPrompt, userContent, responseLength) {
    const res = await fetch(buildChatEndpoint(customApi.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(customApi.apiKey ? { Authorization: `Bearer ${customApi.apiKey}` } : {}),
        },
        body: JSON.stringify({
            model: customApi.model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
            max_tokens: responseLength || RESPONSE_BUDGET,
            stream: false,
        }),
    });
    if (!res.ok) throw new Error(`独立 API HTTP ${res.status}`);
    const text = await res.text();
    if (text.trimStart().startsWith('data:')) return parseSseText(text);
    try {
        const data = JSON.parse(text);
        return data?.choices?.[0]?.message?.content ?? '';
    } catch {
        throw new Error('独立 API 返回了无法解析的响应');
    }
}

// ── 裸调用防污染卫兵 ──
// 必须是集合不是单例:两路裸调用可能同时在飞,单例会互相覆盖认领前缀。
const rawGuards = new Set();
function onPromptReady(eventData) {
    if (!rawGuards.size || eventData?.dryRun || !Array.isArray(eventData?.chat)) return;
    const ours = eventData.chat.filter(m => typeof m?.content === 'string'
        && [...rawGuards].some(g => m.content.startsWith(g.sysHead) || m.content.startsWith(g.userHead)));
    if (ours.length >= 2 && ours.length < eventData.chat.length) {
        console.warn('[Mnemosyne] 裸调用被注入了', eventData.chat.length - ours.length, '条外来消息,已剔除');
        eventData.chat.splice(0, eventData.chat.length, ...ours);
    }
}

export async function callLLM(ctx, systemPrompt, userContent, { profileId, customApi, responseLength } = {}) {
    if (customApi?.enabled && customApi.baseUrl && customApi.model) {
        return await callCustomApi(customApi, systemPrompt, userContent, responseLength);
    }
    if (profileId && ctx.ConnectionManagerRequestService) {
        const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }];
        const constructed = ctx.ConnectionManagerRequestService.constructPrompt(messages, profileId);
        const result = await ctx.ConnectionManagerRequestService.sendRequest(profileId, constructed, responseLength || RESPONSE_BUDGET);
        return result?.content ?? '';
    }
    const ev = ctx.eventTypes?.CHAT_COMPLETION_PROMPT_READY ?? ctx.event_types?.CHAT_COMPLETION_PROMPT_READY;
    let guard = null;
    if (ctx.eventSource && ev) {
        ctx.eventSource.makeLast?.(ev, onPromptReady); // 幂等:每次重挂保持排在最后
        guard = { sysHead: systemPrompt.trim().slice(0, 80), userHead: userContent.trim().slice(0, 80) };
        rawGuards.add(guard);
    }
    try {
        return await ctx.generateRaw({ prompt: userContent, systemPrompt, responseLength: responseLength || RESPONSE_BUDGET });
    } finally {
        if (guard) rawGuards.delete(guard); // 只撤自己那把
    }
}

/** 取 JSON:解析失败才重试一次;调用本身失败(网络/鉴权)直接抛,不轰炸。 */
export async function generateJson(ctx, systemPrompt, userContent, opts) {
    for (let i = 0; i < 2; i++) {
        const raw = await callLLM(ctx, systemPrompt, userContent, opts);
        const parsed = parseLenientJson(raw);
        if (parsed) return parsed;
    }
    throw new Error('模型返回的内容无法解析成 JSON');
}

/** 取纯文本(去围栏)。空内容视为失败。 */
export async function generateText(ctx, systemPrompt, userContent, opts) {
    const raw = await callLLM(ctx, systemPrompt, userContent, opts);
    const s = String(raw || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    if (!s) throw new Error('模型返回了空内容');
    return s;
}

/** 从设置里取模型连接选项。 */
export function llmOptsFrom(settings) {
    return { profileId: settings.profileId || null, customApi: settings.customApi };
}
