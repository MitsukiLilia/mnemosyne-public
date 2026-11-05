// 全局设置(extensionSettings.mnemosyne)。读取时归一化:缺项补默认值,不整份深拷贝。

export const SETTINGS_KEY = 'mnemosyne';

export const DEFAULT_SETTINGS = {
    enabled: true,
    autoRecord: false,       // 默认关:装上后不会擅自在每个聊天里花 token、隐藏楼层,用户在首页打开
    reserve: 3,              // 保留最近 N 层原文
    foldThreshold: 4000,     // 未折叠胶囊 token 合计超过即折叠
    batchMaxRounds: 12,      // 补建每批轮数上限
    batchBudgetRatio: 0.4,   // 补建每批 token 预算 = maxContext * ratio
    autoMaxRounds: 4,        // 自动记录一次最多处理的积压轮数,更多的交给「补建历史」
    keepFoldedText: false,
    injectPosition: 1,       // 0 = IN_PROMPT, 1 = IN_CHAT, 2 = BEFORE_PROMPT
    injectDepth: null,       // null = 跟随保留楼层数
    injectRole: 0,           // 0 system / 1 user / 2 assistant
    injectBudgetRatio: 0.25,
    injectMode: 'auto',      // 'auto' = setExtensionPrompt 自动注入;'macro' = 不自动注入,只由 {{mnemosyne}} 输出
    maxPoints: 5,            // 每个胶囊的必留点上限
    anchorRecentFloors: 8,   // 非伏笔/约定的锚点,key 出现在最近这几层正文里才注入
    memoryVersions: 5,
    timelineInjectLines: 15, // 时间线只注入最近这么多条(更早的交给前情);0 = 全量       // 折叠版本链保留几版(= 最多可连续撤销几次)
    injectWarnTokens: 12000, // 上次注入超过它,首页的注入卡片标黄
    excludeTags: '',
    profileId: '',
    customApi: { enabled: false, baseUrl: '', apiKey: '', model: '' },
    showFab: true,
    fabTop: null,
    theme: 'auto',           // auto / day / night
};

export function getSettings(ctx) {
    const store = ctx.extensionSettings;
    let cur = store[SETTINGS_KEY];
    if (!cur) cur = store[SETTINGS_KEY] = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (cur[k] === undefined) {
            const d = DEFAULT_SETTINGS[k];
            cur[k] = (d && typeof d === 'object') ? { ...d } : d;
        }
    }
    if (!cur.customApi || typeof cur.customApi !== 'object') cur.customApi = { ...DEFAULT_SETTINGS.customApi };
    for (const k of Object.keys(DEFAULT_SETTINGS.customApi)) {
        if (cur.customApi[k] === undefined) cur.customApi[k] = DEFAULT_SETTINGS.customApi[k];
    }
    return cur;
}

export function saveSettings(ctx) {
    ctx.saveSettingsDebounced?.();
}

export function effectiveDepth(s) {
    return Number.isFinite(Number(s.injectDepth)) && s.injectDepth !== null && s.injectDepth !== ''
        ? Math.max(0, Math.floor(Number(s.injectDepth)))
        : Math.max(0, Math.floor(Number(s.reserve) || 0));
}
