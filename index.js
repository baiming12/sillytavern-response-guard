const MODULE_NAME = 'response_guard';
const EXTENSION_FOLDER_NAME = decodeURIComponent(
    new URL('.', import.meta.url).pathname
        .split('/')
        .filter(Boolean)
        .at(-1),
);
const EXTENSION_TEMPLATE_PATH = `third-party/${EXTENSION_FOLDER_NAME}`;

const DEFAULT_PROFILE = Object.freeze({
    name: '默认方案',
    rules: `每条回复末尾必须包含：
1. 【本回合摘要】1-3 句，概括最新剧情推进
2. 【下一步建议】仅当剧情出现明显分岔时给出 2-4 个选项；若当前不适用，则明确写出“本回合暂无需要选择的分岔”

检查时只判断“最新回复”是否满足这些要求，不要要求重写正文。`,
    apiMode: 'current',
    customBaseUrl: '',
    customModel: '',
    customApiKey: '',
    temperature: 0.2,
    inductionExample: '',
    inductionRequirement: '',
    inductionResult: '',
});

const DEFAULT_SETTINGS = Object.freeze({
    profiles: [{ id: 'default', ...DEFAULT_PROFILE }],
    activeProfileId: 'default',
    characterBindings: {},
});

function getContext() {
    return SillyTavern.getContext();
}

function clone(value) {
    return structuredClone(value);
}

function makeProfileId() {
    return `profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeProfile(profile = {}) {
    return {
        id: typeof profile.id === 'string' && profile.id.trim() ? profile.id : makeProfileId(),
        name: typeof profile.name === 'string' && profile.name.trim() ? profile.name : '未命名方案',
        rules: typeof profile.rules === 'string' ? profile.rules : DEFAULT_PROFILE.rules,
        apiMode: profile.apiMode === 'custom' ? 'custom' : 'current',
        customBaseUrl: typeof profile.customBaseUrl === 'string' ? profile.customBaseUrl : '',
        customModel: typeof profile.customModel === 'string' ? profile.customModel : '',
        customApiKey: typeof profile.customApiKey === 'string' ? profile.customApiKey : '',
        temperature: Number.isFinite(Number(profile.temperature)) ? Number(profile.temperature) : DEFAULT_PROFILE.temperature,
        inductionExample: typeof profile.inductionExample === 'string' ? profile.inductionExample : '',
        inductionRequirement: typeof profile.inductionRequirement === 'string' ? profile.inductionRequirement : '',
        inductionResult: typeof profile.inductionResult === 'string' ? profile.inductionResult : '',
    };
}

function getSettings() {
    const { extensionSettings } = getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
    }

    const settings = extensionSettings[MODULE_NAME];

    // 兼容 0.1.x：把旧版单套设置自动迁移成“默认方案”
    if (!Array.isArray(settings.profiles)) {
        settings.profiles = [normalizeProfile({
            id: 'default',
            name: '默认方案',
            rules: settings.rules,
            apiMode: settings.apiMode,
            customBaseUrl: settings.customBaseUrl,
            customModel: settings.customModel,
            customApiKey: settings.customApiKey,
            temperature: settings.temperature,
        })];
    }

    settings.profiles = settings.profiles.map(normalizeProfile);

    if (!settings.profiles.length) {
        settings.profiles.push({ id: 'default', ...clone(DEFAULT_PROFILE) });
    }

    if (!settings.profiles.some((profile) => profile.id === settings.activeProfileId)) {
        settings.activeProfileId = settings.profiles[0].id;
    }

    if (!settings.characterBindings || typeof settings.characterBindings !== 'object' || Array.isArray(settings.characterBindings)) {
        settings.characterBindings = {};
    }

    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function getCurrentCharacterKey() {
    const context = getContext();
    const rawKey = context.characterId
        ?? context.this_chid
        ?? context.chid
        ?? context.name2
        ?? context.chatId
        ?? '';

    return String(rawKey);
}

function getCurrentCharacterName() {
    const context = getContext();
    return String(context.name2 || context.character?.name || '当前角色卡');
}

function getProfileById(profileId) {
    const settings = getSettings();
    return settings.profiles.find((profile) => profile.id === profileId) || settings.profiles[0];
}

function getActiveProfile() {
    const settings = getSettings();
    const boundProfileId = settings.characterBindings[getCurrentCharacterKey()];
    return getProfileById(boundProfileId || settings.activeProfileId);
}

function setActiveProfileId(profileId) {
    const settings = getSettings();
    if (!settings.profiles.some((profile) => profile.id === profileId)) {
        return;
    }

    settings.activeProfileId = profileId;
}

function getLatestAssistantMessage() {
    const { chat } = getContext();

    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];

        if (
            !message
            || message.is_user
            || message.is_system
            || typeof message.mes !== 'string'
            || !message.mes.trim()
        ) {
            continue;
        }

        return { index, message };
    }

    return null;
}

function buildJudgePrompt({ rules, reply }) {
    return `你是一个严格但克制的回复质检器。

任务：
1. 根据“格式规范”，检查“最新回复”是否缺少必须附带的内容。
2. 如果完整，返回 complete=true，append_text 为空字符串。
3. 如果不完整，只生成“缺失的那一小段”，不要重写已有正文，不要复述已有内容。
4. append_text 必须可以直接追加到原回复末尾。
5. missing 数组中只写缺失项的简短名称。
6. 只输出 JSON，不要输出 Markdown，不要解释。

输出 JSON 结构：
{
  "complete": true,
  "missing": [],
  "append_text": "",
  "reason": "一句话说明"
}

格式规范：
${rules}

最新回复：
<<<REPLY
${reply}
REPLY>>>`;
}


function buildInductionPrompt({ exampleReply, moduleRequirement }) {
    return `你是 SillyTavern 回复格式修复规则的归纳助手。

你的任务：
根据用户提供的“某次正确回复样例”和“对某个模块的要求”，归纳出一段可直接粘贴到 Response Guard「格式规范 / 检查规则」里的格式修复指导。

归纳要求：
1. 不要续写剧情，不要评价样例内容。
2. 不要照抄样例里的具体剧情、角色动作、台词或变量值，只抽取格式结构、标签顺序、字段要求和缺失时的补齐规则。
3. 输出必须是一段“独立可用”的格式修复指导：另一个 AI 只看到这段指导、完全看不到样例和用户要求时，也能知道应该检查什么、缺什么、怎么补。
4. 禁止在输出中引用外部资料或输入来源，不要写“根据样例”“参考上文”“用户要求中提到”“你给的正确回复”“上述资料”等依赖上下文的说法。
5. 必须把从样例和模块要求中归纳出的规则完整写出来，包括模块名称、出现位置、完整格式骨架、标签顺序、字段含义、可空项、必填项、缺失判断和补齐方式。
6. 指导语要让另一个 AI 能检查“最新回复”是否缺少这个模块，并在缺失时只生成可追加的缺失部分。
7. 需要写清楚：模块何时必须出现、内部字段/标签顺序、哪些内容可以为空、哪些内容不能省略、补齐时不要重写已有正文。
8. 如果用户的模块要求和样例冲突，以用户的模块要求为准，并把冲突处理结果写成明确规则；不要说“与样例冲突”。
9. 只输出格式修复指导正文，不要输出 JSON，不要 Markdown 代码块，不要解释你如何分析。

推荐输出结构：
【模块名称】
【必须出现的位置】
【格式骨架】
【检查规则】
【补齐规则】
【注意事项】

某次正确回复样例：
<<<CORRECT_REPLY
${exampleReply}
CORRECT_REPLY>>>

用户对这个模块的要求：
<<<MODULE_REQUIREMENT
${moduleRequirement}
MODULE_REQUIREMENT>>>`;
}

function stripCodeFence(text) {
    return String(text ?? '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function parseJudgeResult(rawText) {
    const cleaned = stripCodeFence(rawText);
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const candidate = firstBrace >= 0 && lastBrace > firstBrace
        ? cleaned.slice(firstBrace, lastBrace + 1)
        : cleaned;

    try {
        const parsed = JSON.parse(candidate);

        return {
            complete: Boolean(parsed.complete),
            missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : [],
            appendText: typeof parsed.append_text === 'string' ? parsed.append_text.trim() : '',
            reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
        };
    } catch (error) {
        console.warn('[Response Guard] Failed to parse JSON response:', rawText, error);
        throw new Error('检查结果不是有效 JSON。请再点一次，或把规则写得更明确。');
    }
}

async function generateWithCurrentApi(prompt) {
    const { generateRaw } = getContext();

    return generateRaw({
        prompt,
    });
}

function normalizeChatCompletionsUrl(baseUrl) {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');

    if (trimmed.endsWith('/chat/completions')) {
        return trimmed;
    }

    return `${trimmed}/chat/completions`;
}

function normalizeModelsUrl(baseUrl) {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');

    if (trimmed.endsWith('/chat/completions')) {
        return `${trimmed.slice(0, -'/chat/completions'.length)}/models`;
    }

    return `${trimmed}/models`;
}

async function generateWithCustomApi(prompt, profile) {
    if (!profile.customBaseUrl.trim()) {
        throw new Error('请先填写自定义 API 地址。');
    }

    if (!profile.customModel.trim()) {
        throw new Error('请先填写模型名。');
    }

    const response = await fetch(normalizeChatCompletionsUrl(profile.customBaseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(profile.customApiKey.trim()
                ? { Authorization: `Bearer ${profile.customApiKey.trim()}` }
                : {}),
        },
        body: JSON.stringify({
            model: profile.customModel.trim(),
            temperature: Number(profile.temperature) || DEFAULT_PROFILE.temperature,
            messages: [
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`自定义 API 请求失败：${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;

    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('自定义 API 没有返回可用文本。');
    }

    return text;
}

async function fetchCustomModels(profile) {
    if (!profile.customBaseUrl.trim()) {
        throw new Error('请先填写自定义 API 地址。');
    }

    const response = await fetch(normalizeModelsUrl(profile.customBaseUrl), {
        method: 'GET',
        headers: {
            ...(profile.customApiKey.trim()
                ? { Authorization: `Bearer ${profile.customApiKey.trim()}` }
                : {}),
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`获取模型失败：${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
    }

    const data = await response.json();
    const models = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
            ? data
            : [];

    return models
        .map((model) => typeof model === 'string' ? model : model?.id)
        .filter((modelId) => typeof modelId === 'string' && modelId.trim())
        .sort((a, b) => a.localeCompare(b));
}

async function runJudge(reply) {
    const profile = getActiveProfile();
    const prompt = buildJudgePrompt({
        rules: profile.rules,
        reply,
    });

    const rawText = profile.apiMode === 'custom'
        ? await generateWithCustomApi(prompt, profile)
        : await generateWithCurrentApi(prompt);

    return parseJudgeResult(rawText);
}


async function runInduction({ exampleReply, moduleRequirement }) {
    const profile = getActiveProfile();
    const prompt = buildInductionPrompt({ exampleReply, moduleRequirement });
    const rawText = profile.apiMode === 'custom'
        ? await generateWithCustomApi(prompt, profile)
        : await generateWithCurrentApi(prompt);
    const result = stripCodeFence(rawText);

    if (!result.trim()) {
        throw new Error('归纳模块没有返回可用文本。');
    }

    return result.trim();
}

async function appendMissingText(index, message, appendText) {
    const {
        chat,
        eventSource,
        eventTypes,
        saveChat,
        updateMessageBlock,
    } = getContext();
    const separator = message.mes.endsWith('\n') ? '\n' : '\n\n';
    const nextText = `${message.mes.trimEnd()}${separator}${appendText.trim()}`;

    message.mes = nextText;

    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
        message.swipes[message.swipe_id] = nextText;
    }

    if (message.extra?.display_text) {
        delete message.extra.display_text;
    }

    await eventSource.emit(eventTypes.MESSAGE_EDITED, index);
    await saveChat();
    updateMessageBlock(index, chat[index] ?? message);
    await eventSource.emit(eventTypes.MESSAGE_UPDATED, index);
}

function describeMissing(result) {
    if (!result.missing.length) {
        return '模型判定为不完整，但没有给出缺失项名称。';
    }

    return `缺失：${result.missing.join('、')}`;
}

async function checkLatestMessage({ repair }) {
    const latest = getLatestAssistantMessage();

    if (!latest) {
        toastr.warning('没有找到可检查的最新 AI 回复。');
        return;
    }

    const buttons = [
        document.querySelector('#response_guard_check_only'),
        document.querySelector('#response_guard_check_and_fix'),
    ];

    buttons.forEach((button) => button?.setAttribute('disabled', 'disabled'));

    try {
        toastr.info(`正在用「${getActiveProfile().name}」检查最新回复…`);
        const result = await runJudge(latest.message.mes);

        if (result.complete) {
            toastr.success('最新回复已满足格式规范。');
            return;
        }

        if (!repair) {
            toastr.warning(describeMissing(result));
            return;
        }

        if (!result.appendText) {
            toastr.warning(`${describeMissing(result)} 但模型没有给出可追加文本。`);
            return;
        }

        await appendMissingText(latest.index, latest.message, result.appendText);
        toastr.success(`已补齐最新回复。${describeMissing(result)}`);
    } catch (error) {
        console.error('[Response Guard] Check failed:', error);
        toastr.error(error?.message || '检查失败。');
    } finally {
        buttons.forEach((button) => button?.removeAttribute('disabled'));
    }
}


async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

async function induceFormatGuidance() {
    const profile = getActiveProfile();
    const exampleEl = document.querySelector('#response_guard_induction_example');
    const requirementEl = document.querySelector('#response_guard_induction_requirement');
    const resultEl = document.querySelector('#response_guard_induction_result');
    const buttonEl = document.querySelector('#response_guard_induce_rules');

    const exampleReply = String(exampleEl?.value || '').trim();
    const moduleRequirement = String(requirementEl?.value || '').trim();

    if (!exampleReply) {
        toastr.warning('请先粘贴一次正确回复样例。');
        return;
    }

    if (!moduleRequirement) {
        toastr.warning('请先填写你对这个模块的要求。');
        return;
    }

    buttonEl?.setAttribute('disabled', 'disabled');

    try {
        toastr.info(`正在用「${profile.name}」归纳格式修复指导…`);
        const guidance = await runInduction({ exampleReply, moduleRequirement });
        profile.inductionExample = exampleReply;
        profile.inductionRequirement = moduleRequirement;
        profile.inductionResult = guidance;

        if (resultEl) {
            resultEl.value = guidance;
        }

        saveSettings();
        toastr.success('已生成格式修复指导。');
    } catch (error) {
        console.error('[Response Guard] Induction failed:', error);
        toastr.error(error?.message || '归纳失败。');
    } finally {
        buttonEl?.removeAttribute('disabled');
    }
}

function appendInductionResultToRules() {
    const profile = getActiveProfile();
    const rulesEl = document.querySelector('#response_guard_rules');
    const resultEl = document.querySelector('#response_guard_induction_result');
    const guidance = String(resultEl?.value || profile.inductionResult || '').trim();

    if (!guidance) {
        toastr.warning('还没有可追加的格式修复指导。');
        return;
    }

    const currentRules = String(rulesEl?.value || profile.rules || '').trimEnd();
    const nextRules = currentRules
        ? `${currentRules}\n\n${guidance}`
        : guidance;

    profile.rules = nextRules;

    if (rulesEl) {
        rulesEl.value = nextRules;
    }

    saveSettings();
    toastr.success('已追加到当前方案的格式规范。');
}

async function copyInductionResult() {
    const profile = getActiveProfile();
    const resultEl = document.querySelector('#response_guard_induction_result');
    const guidance = String(resultEl?.value || profile.inductionResult || '').trim();

    if (!guidance) {
        toastr.warning('还没有可复制的归纳结果。');
        return;
    }

    try {
        await copyTextToClipboard(guidance);
        toastr.success('已复制归纳结果。');
    } catch (error) {
        console.error('[Response Guard] Copy failed:', error);
        toastr.error('复制失败，请手动选中结果复制。');
    }
}

function syncCustomApiVisibility() {
    const profile = getActiveProfile();
    const root = document.querySelector('#response_guard_custom_api_fields');
    root?.classList.toggle('hidden', profile.apiMode !== 'custom');
}

function populateProfilePicker() {
    const settings = getSettings();
    const picker = document.querySelector('#response_guard_profile_picker');

    if (!picker) {
        return;
    }

    const activeProfile = getActiveProfile();
    picker.innerHTML = '';

    for (const profile of settings.profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        picker.appendChild(option);
    }

    picker.value = activeProfile.id;
}

function populateModelPicker(models) {
    const picker = document.querySelector('#response_guard_model_picker');

    if (!picker) {
        return;
    }

    picker.innerHTML = '<option value="">选择已获取的模型</option>';

    for (const model of models) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        picker.appendChild(option);
    }

    picker.classList.toggle('hidden', models.length === 0);
}

function syncCharacterBindingText() {
    const settings = getSettings();
    const characterKey = getCurrentCharacterKey();
    const boundProfileId = settings.characterBindings[characterKey];
    const boundProfile = boundProfileId ? getProfileById(boundProfileId) : null;
    const text = document.querySelector('#response_guard_binding_text');

    if (!text) {
        return;
    }

    if (!characterKey) {
        text.textContent = '未识别到当前角色卡；仍可手动选择方案。';
        return;
    }

    text.textContent = boundProfile
        ? `当前角色卡「${getCurrentCharacterName()}」已绑定：${boundProfile.name}`
        : `当前角色卡「${getCurrentCharacterName()}」未绑定；使用上方当前方案。`;
}

function syncFieldsFromActiveProfile() {
    const profile = getActiveProfile();

    const profileNameEl = document.querySelector('#response_guard_profile_name');
    const rulesEl = document.querySelector('#response_guard_rules');
    const apiModeEl = document.querySelector('#response_guard_api_mode');
    const temperatureEl = document.querySelector('#response_guard_temperature');
    const baseUrlEl = document.querySelector('#response_guard_custom_base_url');
    const modelEl = document.querySelector('#response_guard_custom_model');
    const apiKeyEl = document.querySelector('#response_guard_custom_api_key');
    const inductionExampleEl = document.querySelector('#response_guard_induction_example');
    const inductionRequirementEl = document.querySelector('#response_guard_induction_requirement');
    const inductionResultEl = document.querySelector('#response_guard_induction_result');

    if (profileNameEl) profileNameEl.value = profile.name;
    if (rulesEl) rulesEl.value = profile.rules;
    if (apiModeEl) apiModeEl.value = profile.apiMode;
    if (temperatureEl) temperatureEl.value = String(profile.temperature);
    if (baseUrlEl) baseUrlEl.value = profile.customBaseUrl;
    if (modelEl) modelEl.value = profile.customModel;
    if (apiKeyEl) apiKeyEl.value = profile.customApiKey;
    if (inductionExampleEl) inductionExampleEl.value = profile.inductionExample;
    if (inductionRequirementEl) inductionRequirementEl.value = profile.inductionRequirement;
    if (inductionResultEl) inductionResultEl.value = profile.inductionResult;

    populateProfilePicker();
    populateModelPicker([]);
    syncCustomApiVisibility();
    syncCharacterBindingText();
}

function bindSettingsEvents() {
    const settings = getSettings();

    const profilePickerEl = document.querySelector('#response_guard_profile_picker');
    const profileNameEl = document.querySelector('#response_guard_profile_name');
    const newProfileEl = document.querySelector('#response_guard_new_profile');
    const duplicateProfileEl = document.querySelector('#response_guard_duplicate_profile');
    const deleteProfileEl = document.querySelector('#response_guard_delete_profile');
    const bindProfileEl = document.querySelector('#response_guard_bind_profile');
    const unbindProfileEl = document.querySelector('#response_guard_unbind_profile');

    const rulesEl = document.querySelector('#response_guard_rules');
    const apiModeEl = document.querySelector('#response_guard_api_mode');
    const temperatureEl = document.querySelector('#response_guard_temperature');
    const baseUrlEl = document.querySelector('#response_guard_custom_base_url');
    const modelEl = document.querySelector('#response_guard_custom_model');
    const apiKeyEl = document.querySelector('#response_guard_custom_api_key');
    const modelPickerEl = document.querySelector('#response_guard_model_picker');
    const fetchModelsEl = document.querySelector('#response_guard_fetch_models');
    const inductionExampleEl = document.querySelector('#response_guard_induction_example');
    const inductionRequirementEl = document.querySelector('#response_guard_induction_requirement');
    const inductionResultEl = document.querySelector('#response_guard_induction_result');
    const induceRulesEl = document.querySelector('#response_guard_induce_rules');
    const appendInductionEl = document.querySelector('#response_guard_append_induction_to_rules');
    const copyInductionEl = document.querySelector('#response_guard_copy_induction_result');

    if (
        !profilePickerEl
        || !profileNameEl
        || !newProfileEl
        || !duplicateProfileEl
        || !deleteProfileEl
        || !bindProfileEl
        || !unbindProfileEl
        || !rulesEl
        || !apiModeEl
        || !temperatureEl
        || !baseUrlEl
        || !modelEl
        || !apiKeyEl
        || !modelPickerEl
        || !fetchModelsEl
        || !inductionExampleEl
        || !inductionRequirementEl
        || !inductionResultEl
        || !induceRulesEl
        || !appendInductionEl
        || !copyInductionEl
    ) {
        console.error('[Response Guard] Settings UI failed to initialize.');
        return;
    }

    syncFieldsFromActiveProfile();

    profilePickerEl.addEventListener('change', () => {
        setActiveProfileId(profilePickerEl.value);
        syncFieldsFromActiveProfile();
        saveSettings();
    });

    profileNameEl.addEventListener('input', () => {
        const profile = getActiveProfile();
        profile.name = profileNameEl.value.trim() || '未命名方案';
        populateProfilePicker();
        saveSettings();
    });

    newProfileEl.addEventListener('click', () => {
        const profile = normalizeProfile({
            ...clone(DEFAULT_PROFILE),
            id: makeProfileId(),
            name: `新方案 ${settings.profiles.length + 1}`,
        });
        settings.profiles.push(profile);
        settings.activeProfileId = profile.id;
        syncFieldsFromActiveProfile();
        saveSettings();
    });

    duplicateProfileEl.addEventListener('click', () => {
        const source = getActiveProfile();
        const profile = normalizeProfile({
            ...clone(source),
            id: makeProfileId(),
            name: `${source.name} 副本`,
        });
        settings.profiles.push(profile);
        settings.activeProfileId = profile.id;
        syncFieldsFromActiveProfile();
        saveSettings();
    });

    deleteProfileEl.addEventListener('click', () => {
        if (settings.profiles.length <= 1) {
            toastr.warning('至少保留一个方案。');
            return;
        }

        const profile = getActiveProfile();
        const confirmed = confirm(`确定删除方案「${profile.name}」吗？已经绑定到角色卡的关系也会清除。`);
        if (!confirmed) {
            return;
        }

        settings.profiles = settings.profiles.filter((item) => item.id !== profile.id);

        for (const [characterKey, profileId] of Object.entries(settings.characterBindings)) {
            if (profileId === profile.id) {
                delete settings.characterBindings[characterKey];
            }
        }

        settings.activeProfileId = settings.profiles[0].id;
        syncFieldsFromActiveProfile();
        saveSettings();
    });

    bindProfileEl.addEventListener('click', () => {
        const characterKey = getCurrentCharacterKey();
        if (!characterKey) {
            toastr.warning('未识别到当前角色卡，暂时无法绑定。');
            return;
        }

        settings.characterBindings[characterKey] = getActiveProfile().id;
        syncCharacterBindingText();
        saveSettings();
        toastr.success(`已将当前角色卡绑定到「${getActiveProfile().name}」。`);
    });

    unbindProfileEl.addEventListener('click', () => {
        const characterKey = getCurrentCharacterKey();
        if (!characterKey || !settings.characterBindings[characterKey]) {
            toastr.info('当前角色卡没有绑定方案。');
            return;
        }

        delete settings.characterBindings[characterKey];
        syncCharacterBindingText();
        saveSettings();
        toastr.success('已解除当前角色卡绑定。');
    });

    rulesEl.addEventListener('input', () => {
        getActiveProfile().rules = rulesEl.value;
        saveSettings();
    });

    apiModeEl.addEventListener('change', () => {
        getActiveProfile().apiMode = apiModeEl.value;
        syncCustomApiVisibility();
        saveSettings();
    });

    temperatureEl.addEventListener('change', () => {
        getActiveProfile().temperature = Number(temperatureEl.value) || DEFAULT_PROFILE.temperature;
        saveSettings();
    });

    baseUrlEl.addEventListener('input', () => {
        getActiveProfile().customBaseUrl = baseUrlEl.value;
        saveSettings();
    });

    modelEl.addEventListener('input', () => {
        getActiveProfile().customModel = modelEl.value;
        saveSettings();
    });

    apiKeyEl.addEventListener('input', () => {
        getActiveProfile().customApiKey = apiKeyEl.value;
        saveSettings();
    });

    inductionExampleEl.addEventListener('input', () => {
        getActiveProfile().inductionExample = inductionExampleEl.value;
        saveSettings();
    });

    inductionRequirementEl.addEventListener('input', () => {
        getActiveProfile().inductionRequirement = inductionRequirementEl.value;
        saveSettings();
    });

    inductionResultEl.addEventListener('input', () => {
        getActiveProfile().inductionResult = inductionResultEl.value;
        saveSettings();
    });

    induceRulesEl.addEventListener('click', () => induceFormatGuidance());
    appendInductionEl.addEventListener('click', () => appendInductionResultToRules());
    copyInductionEl.addEventListener('click', () => copyInductionResult());

    modelPickerEl.addEventListener('change', () => {
        if (!modelPickerEl.value) {
            return;
        }

        getActiveProfile().customModel = modelPickerEl.value;
        modelEl.value = modelPickerEl.value;
        saveSettings();
    });

    fetchModelsEl.addEventListener('click', async () => {
        fetchModelsEl.setAttribute('disabled', 'disabled');

        try {
            toastr.info('正在获取模型列表…');
            const models = await fetchCustomModels(getActiveProfile());

            if (!models.length) {
                populateModelPicker([]);
                toastr.warning('接口返回了空模型列表。');
                return;
            }

            populateModelPicker(models);
            toastr.success(`已获取 ${models.length} 个模型。`);
        } catch (error) {
            console.error('[Response Guard] Failed to fetch models:', error);
            toastr.error(error?.message || '获取模型失败。');
        } finally {
            fetchModelsEl.removeAttribute('disabled');
        }
    });

    document.querySelector('#response_guard_check_only')
        ?.addEventListener('click', () => checkLatestMessage({ repair: false }));

    document.querySelector('#response_guard_check_and_fix')
        ?.addEventListener('click', () => checkLatestMessage({ repair: true }));

    // 切换角色卡 / 聊天时尽量刷新显示；不同 ST 版本事件名可能不同，所以做成可选监听。
    const { eventSource, eventTypes } = getContext();
    const refreshEvents = [
        eventTypes.CHARACTER_SELECTED,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_LOADED,
    ].filter(Boolean);

    for (const eventName of refreshEvents) {
        eventSource.on(eventName, () => syncFieldsFromActiveProfile());
    }
}

async function init() {
    const { renderExtensionTemplateAsync } = getContext();
    const html = await renderExtensionTemplateAsync(EXTENSION_TEMPLATE_PATH, 'settings');

    document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();

    console.log('[Response Guard] Extension loaded');
}

getContext().eventSource.on(getContext().eventTypes.APP_READY, init);
