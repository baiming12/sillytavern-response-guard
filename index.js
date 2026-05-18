const MODULE_NAME = 'response_guard';
const EXTENSION_FOLDER_NAME = decodeURIComponent(
    new URL('.', import.meta.url).pathname
        .split('/')
        .filter(Boolean)
        .at(-1),
);
const EXTENSION_TEMPLATE_PATH = `third-party/${EXTENSION_FOLDER_NAME}`;

const DEFAULT_SETTINGS = Object.freeze({
    rules: `每条回复末尾必须包含：
1. 【本回合摘要】1-3 句，概括最新剧情推进
2. 【下一步建议】仅当剧情出现明显分岔时给出 2-4 个选项；若当前不适用，则明确写出“本回合暂无需要选择的分岔”

检查时只判断“最新回复”是否满足这些要求，不要要求重写正文。`,
    apiMode: 'current',
    customBaseUrl: '',
    customModel: '',
    customApiKey: '',
    temperature: 0.2,
});

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings } = getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = value;
        }
    }

    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    getContext().saveSettingsDebounced();
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

async function generateWithCustomApi(prompt, settings) {
    if (!settings.customBaseUrl.trim()) {
        throw new Error('请先填写自定义 API 地址。');
    }

    if (!settings.customModel.trim()) {
        throw new Error('请先填写模型名。');
    }

    const response = await fetch(normalizeChatCompletionsUrl(settings.customBaseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(settings.customApiKey.trim()
                ? { Authorization: `Bearer ${settings.customApiKey.trim()}` }
                : {}),
        },
        body: JSON.stringify({
            model: settings.customModel.trim(),
            temperature: Number(settings.temperature) || DEFAULT_SETTINGS.temperature,
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

async function fetchCustomModels(settings) {
    if (!settings.customBaseUrl.trim()) {
        throw new Error('请先填写自定义 API 地址。');
    }

    const response = await fetch(normalizeModelsUrl(settings.customBaseUrl), {
        method: 'GET',
        headers: {
            ...(settings.customApiKey.trim()
                ? { Authorization: `Bearer ${settings.customApiKey.trim()}` }
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
    const settings = getSettings();
    const prompt = buildJudgePrompt({
        rules: settings.rules,
        reply,
    });

    const rawText = settings.apiMode === 'custom'
        ? await generateWithCustomApi(prompt, settings)
        : await generateWithCurrentApi(prompt);

    return parseJudgeResult(rawText);
}

async function appendMissingText(index, message, appendText) {
    const { saveChat, updateMessageBlock } = getContext();
    const separator = message.mes.endsWith('\n') ? '\n' : '\n\n';
    const nextText = `${message.mes.trimEnd()}${separator}${appendText.trim()}`;

    message.mes = nextText;

    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
        message.swipes[message.swipe_id] = nextText;
    }

    if (message.extra?.display_text) {
        delete message.extra.display_text;
    }

    await saveChat();
    updateMessageBlock(index, message);
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
        toastr.info('正在检查最新回复…');
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

function syncCustomApiVisibility() {
    const settings = getSettings();
    const root = document.querySelector('#response_guard_custom_api_fields');
    root?.classList.toggle('hidden', settings.apiMode !== 'custom');
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

function bindSettingsEvents() {
    const settings = getSettings();

    const rulesEl = document.querySelector('#response_guard_rules');
    const apiModeEl = document.querySelector('#response_guard_api_mode');
    const temperatureEl = document.querySelector('#response_guard_temperature');
    const baseUrlEl = document.querySelector('#response_guard_custom_base_url');
    const modelEl = document.querySelector('#response_guard_custom_model');
    const apiKeyEl = document.querySelector('#response_guard_custom_api_key');
    const modelPickerEl = document.querySelector('#response_guard_model_picker');
    const fetchModelsEl = document.querySelector('#response_guard_fetch_models');

    if (
        !rulesEl
        || !apiModeEl
        || !temperatureEl
        || !baseUrlEl
        || !modelEl
        || !apiKeyEl
        || !modelPickerEl
        || !fetchModelsEl
    ) {
        console.error('[Response Guard] Settings UI failed to initialize.');
        return;
    }

    rulesEl.value = settings.rules;
    apiModeEl.value = settings.apiMode;
    temperatureEl.value = String(settings.temperature);
    baseUrlEl.value = settings.customBaseUrl;
    modelEl.value = settings.customModel;
    apiKeyEl.value = settings.customApiKey;

    rulesEl.addEventListener('input', () => {
        settings.rules = rulesEl.value;
        saveSettings();
    });

    apiModeEl.addEventListener('change', () => {
        settings.apiMode = apiModeEl.value;
        syncCustomApiVisibility();
        saveSettings();
    });

    temperatureEl.addEventListener('change', () => {
        settings.temperature = Number(temperatureEl.value) || DEFAULT_SETTINGS.temperature;
        saveSettings();
    });

    baseUrlEl.addEventListener('input', () => {
        settings.customBaseUrl = baseUrlEl.value;
        saveSettings();
    });

    modelEl.addEventListener('input', () => {
        settings.customModel = modelEl.value;
        saveSettings();
    });

    apiKeyEl.addEventListener('input', () => {
        settings.customApiKey = apiKeyEl.value;
        saveSettings();
    });

    modelPickerEl.addEventListener('change', () => {
        if (!modelPickerEl.value) {
            return;
        }

        settings.customModel = modelPickerEl.value;
        modelEl.value = modelPickerEl.value;
        saveSettings();
    });

    fetchModelsEl.addEventListener('click', async () => {
        fetchModelsEl.setAttribute('disabled', 'disabled');

        try {
            toastr.info('正在获取模型列表…');
            const models = await fetchCustomModels(settings);

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

    syncCustomApiVisibility();
}

async function init() {
    const { renderExtensionTemplateAsync } = getContext();
    const html = await renderExtensionTemplateAsync(EXTENSION_TEMPLATE_PATH, 'settings');

    document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();

    console.log('[Response Guard] Extension loaded');
}

getContext().eventSource.on(getContext().eventTypes.APP_READY, init);
