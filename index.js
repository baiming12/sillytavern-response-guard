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
    rewriteInstruction: '',
    rewriteResult: '',
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
        rewriteInstruction: typeof profile.rewriteInstruction === 'string' ? profile.rewriteInstruction : '',
        rewriteResult: typeof profile.rewriteResult === 'string' ? profile.rewriteResult : '',
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


function buildRewritePrompt({ reply, instruction }) {
    return `你是 SillyTavern 最新回复的局部改写助手。

你的任务：
根据“修改要求”，对“最新回复”进行局部修改，输出修改后的完整最新回复。

强制要求：
1. 只修改用户明确不满意或要求调整的部分，例如内心戏语气、某段写法、某个动作描写、某处措辞、某个模块内容。
2. 未被要求修改的正文、标签、结构、变量块、总结、选项、换行和顺序应尽量原样保留。
3. 如果修改要求只针对中间一段，也必须输出“完整回复”，不能只输出片段或差异说明。
4. 不要新建消息，不要续写后续剧情，不要添加解释、前言、后记、Markdown 代码块或“修改如下”。
5. 不要把回复改成摘要，不要删掉格式模块；除非修改要求明确要求删除或重排某个模块。
6. 如果最新回复中存在 XML/HTML 风格标签，例如 <content>、<details>、<choice>、<UpdateVariable>，必须保持标签成对、嵌套正确，不能让标签误包住正文。
7. 输出必须只有修改后的完整回复正文。

修改要求：
<<<INSTRUCTION
${instruction}
INSTRUCTION>>>

最新回复：
<<<REPLY
${reply}
REPLY>>>`;
}

function stripCodeFence(text) {
    return String(text ?? '')
        .trim()
        .replace(/^```[\w-]*\s*/i, '')
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

function getChoiceText(choice) {
    const messageContent = choice?.message?.content;
    if (typeof messageContent === 'string') {
        return messageContent;
    }

    if (Array.isArray(messageContent)) {
        return messageContent
            .map((part) => typeof part === 'string' ? part : part?.text || '')
            .join('');
    }

    if (typeof choice?.text === 'string') {
        return choice.text;
    }

    return '';
}

function isLengthLimited(choice) {
    const finishReason = String(choice?.finish_reason || choice?.finishReason || '').toLowerCase();
    return finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'content_filter_length';
}

function focusTextareaStart(textarea) {
    if (!textarea) {
        return;
    }

    try {
        textarea.setSelectionRange(0, 0);
    } catch (_) {
        // Some mobile WebViews can throw if the element is not focusable yet.
    }

    textarea.scrollTop = 0;
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

async function generateWithCustomApi(prompt, profile, options = {}) {
    if (!profile.customBaseUrl.trim()) {
        throw new Error('请先填写自定义 API 地址。');
    }

    if (!profile.customModel.trim()) {
        throw new Error('请先填写模型名。');
    }

    const payload = {
        model: profile.customModel.trim(),
        temperature: Number(profile.temperature) || DEFAULT_PROFILE.temperature,
        stream: false,
        messages: [
            {
                role: 'user',
                content: prompt,
            },
        ],
    };

    if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
        payload.max_tokens = Math.floor(options.maxTokens);
    }

    const response = await fetch(normalizeChatCompletionsUrl(profile.customBaseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(profile.customApiKey.trim()
                ? { Authorization: `Bearer ${profile.customApiKey.trim()}` }
                : {}),
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`自定义 API 请求失败：${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const text = getChoiceText(choice);

    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('自定义 API 没有返回可用文本。');
    }

    if (isLengthLimited(choice)) {
        const actionName = options.actionName || '模型输出';
        const lengthTip = options.lengthTip || '请缩短输入，或换用输出上限更高的模型。';
        throw new Error(`${actionName}达到长度上限，结果可能被截断。${lengthTip}`);
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
        ? await generateWithCustomApi(prompt, profile, { maxTokens: 1024 })
        : await generateWithCurrentApi(prompt);

    return parseJudgeResult(rawText);
}


async function runInduction({ exampleReply, moduleRequirement }) {
    const profile = getActiveProfile();
    const prompt = buildInductionPrompt({ exampleReply, moduleRequirement });
    const rawText = profile.apiMode === 'custom'
        ? await generateWithCustomApi(prompt, profile, {
            maxTokens: 4096,
            actionName: '归纳结果',
            lengthTip: '请缩短“正确回复样例”，或把样例里无关剧情删掉后再生成。',
        })
        : await generateWithCurrentApi(prompt);
    const result = stripCodeFence(rawText);

    if (!result.trim()) {
        throw new Error('归纳模块没有返回可用文本。');
    }

    return result.trim();
}


async function runRewrite({ reply, instruction }) {
    const profile = getActiveProfile();
    const prompt = buildRewritePrompt({ reply, instruction });
    const rawText = profile.apiMode === 'custom'
        ? await generateWithCustomApi(prompt, profile, {
            maxTokens: 8192,
            actionName: '局部修改结果',
            lengthTip: '请缩短最新回复或修改要求，或改用输出上限更高的模型。',
        })
        : await generateWithCurrentApi(prompt);
    const result = stripCodeFence(rawText);

    if (!result.trim()) {
        throw new Error('局部修改模块没有返回可用文本。');
    }

    return result.trim();
}

async function replaceMessageText(index, message, nextText) {
    const {
        chat,
        eventSource,
        eventTypes,
        saveChat,
        updateMessageBlock,
    } = getContext();

    const cleanText = String(nextText || '').trim();
    if (!cleanText) {
        throw new Error('没有可写入的回复内容。');
    }

    message.mes = cleanText;

    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
        message.swipes[message.swipe_id] = cleanText;
    }

    if (message.extra?.display_text) {
        delete message.extra.display_text;
    }

    await eventSource.emit(eventTypes.MESSAGE_EDITED, index);
    await saveChat();
    updateMessageBlock(index, chat[index] ?? message);
    await eventSource.emit(eventTypes.MESSAGE_UPDATED, index);
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
            focusTextareaStart(resultEl);
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


async function generateRewritePreview() {
    const profile = getActiveProfile();
    const latest = getLatestAssistantMessage();
    const instructionEl = document.querySelector('#response_guard_rewrite_instruction');
    const resultEl = document.querySelector('#response_guard_rewrite_result');
    const buttonEl = document.querySelector('#response_guard_generate_rewrite');

    if (!latest) {
        toastr.warning('没有找到可修改的最新 AI 回复。');
        return;
    }

    const instruction = String(instructionEl?.value || '').trim();
    if (!instruction) {
        toastr.warning('请先填写你想修改哪里、怎么修改。');
        return;
    }

    buttonEl?.setAttribute('disabled', 'disabled');

    try {
        toastr.info(`正在用「${profile.name}」生成局部修改预览…`);
        const rewritten = await runRewrite({ reply: latest.message.mes, instruction });
        profile.rewriteInstruction = instruction;
        profile.rewriteResult = rewritten;

        if (resultEl) {
            resultEl.value = rewritten;
            focusTextareaStart(resultEl);
        }

        saveSettings();
        toastr.success('已生成修改预览，确认满意后再应用到最新回复。');
    } catch (error) {
        console.error('[Response Guard] Rewrite failed:', error);
        toastr.error(error?.message || '局部修改失败。');
    } finally {
        buttonEl?.removeAttribute('disabled');
    }
}

async function applyRewriteResult() {
    const profile = getActiveProfile();
    const latest = getLatestAssistantMessage();
    const resultEl = document.querySelector('#response_guard_rewrite_result');
    const rewritten = String(resultEl?.value || profile.rewriteResult || '').trim();

    if (!latest) {
        toastr.warning('没有找到可覆盖的最新 AI 回复。');
        return;
    }

    if (!rewritten) {
        toastr.warning('还没有可应用的修改结果。请先生成修改预览。');
        return;
    }

    const confirmed = confirm('确定用“修改结果预览”覆盖最新一条 AI 回复吗？这个操作会直接改写当前 swipe 的内容。');
    if (!confirmed) {
        return;
    }

    try {
        await replaceMessageText(latest.index, latest.message, rewritten);
        profile.rewriteResult = rewritten;
        saveSettings();
        toastr.success('已将修改结果应用到最新回复。');
    } catch (error) {
        console.error('[Response Guard] Apply rewrite failed:', error);
        toastr.error(error?.message || '应用修改失败。');
    }
}

async function copyRewriteResult() {
    const profile = getActiveProfile();
    const resultEl = document.querySelector('#response_guard_rewrite_result');
    const rewritten = String(resultEl?.value || profile.rewriteResult || '').trim();

    if (!rewritten) {
        toastr.warning('还没有可复制的修改结果。');
        return;
    }

    try {
        await copyTextToClipboard(rewritten);
        toastr.success('已复制修改结果。');
    } catch (error) {
        console.error('[Response Guard] Copy rewrite failed:', error);
        toastr.error('复制失败，请手动选中结果复制。');
    }
}


function ensureRewriteQuickDialog() {
    let dialog = document.querySelector('#response_guard_quick_rewrite_dialog');

    if (dialog) {
        return dialog;
    }

    dialog = document.createElement('div');
    dialog.id = 'response_guard_quick_rewrite_dialog';
    dialog.className = 'response-guard-modal hidden';
    dialog.innerHTML = `
      <div class="response-guard-modal-backdrop" data-response-guard-close="1"></div>
      <div class="response-guard-modal-card" role="dialog" aria-modal="true" aria-labelledby="response_guard_quick_rewrite_title">
        <div class="response-guard-modal-header">
          <div>
            <div id="response_guard_quick_rewrite_title" class="response-guard-modal-title">局部修改最新回复</div>
            <div class="response-guard-modal-subtitle">输入你不满意的地方，先生成完整预览，确认后再覆盖当前 swipe。</div>
          </div>
          <button id="response_guard_quick_rewrite_close" class="menu_button response-guard-btn" type="button" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <label for="response_guard_quick_rewrite_instruction">
          <span>修改要求</span>
        </label>
        <textarea
          id="response_guard_quick_rewrite_instruction"
          class="text_pole textarea_compact"
          rows="5"
          placeholder="例如：把内心戏写得更克制一点；第三段动作描写太硬，改得自然一点；保留标签和结尾模块，只修改正文中间那段。"
        ></textarea>

        <div class="response-guard-actions compact">
          <button id="response_guard_quick_generate_rewrite" class="menu_button response-guard-primary" type="button">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            生成修改预览
          </button>
          <button id="response_guard_quick_apply_rewrite" class="menu_button response-guard-btn" type="button">
            应用到最新回复
          </button>
          <button id="response_guard_quick_copy_rewrite" class="menu_button response-guard-btn" type="button">
            复制预览
          </button>
        </div>

        <label for="response_guard_quick_rewrite_result">
          <span>修改结果预览</span>
        </label>
        <textarea
          id="response_guard_quick_rewrite_result"
          class="text_pole textarea_compact"
          rows="12"
          placeholder="这里会显示修改后的完整最新回复。"
        ></textarea>
      </div>
    `;

    document.body.appendChild(dialog);

    const close = () => closeRewriteQuickDialog();
    dialog.querySelector('#response_guard_quick_rewrite_close')?.addEventListener('click', close);
    dialog.querySelector('.response-guard-modal-backdrop')?.addEventListener('click', close);
    dialog.querySelector('#response_guard_quick_generate_rewrite')?.addEventListener('click', () => generateRewriteQuickPreview());
    dialog.querySelector('#response_guard_quick_apply_rewrite')?.addEventListener('click', () => applyRewriteQuickResult());
    dialog.querySelector('#response_guard_quick_copy_rewrite')?.addEventListener('click', () => copyRewriteQuickResult());

    dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeRewriteQuickDialog();
        }
    });

    return dialog;
}

function isSmallTouchScreen() {
    return window.matchMedia?.('(max-width: 700px), (hover: none) and (pointer: coarse)')?.matches || false;
}

function openRewriteQuickDialog() {
    const profile = getActiveProfile();
    const latest = getLatestAssistantMessage();

    if (!latest) {
        toastr.warning('没有找到可修改的最新 AI 回复。');
        return;
    }

    const dialog = ensureRewriteQuickDialog();
    const cardEl = dialog.querySelector('.response-guard-modal-card');
    const instructionEl = dialog.querySelector('#response_guard_quick_rewrite_instruction');
    const resultEl = dialog.querySelector('#response_guard_quick_rewrite_result');

    if (instructionEl) {
        instructionEl.value = profile.rewriteInstruction || '';
    }

    if (resultEl) {
        resultEl.value = profile.rewriteResult || '';
        focusTextareaStart(resultEl);
    }

    dialog.classList.remove('hidden');
    document.body.classList.add('response-guard-modal-open');

    // 手机 WebView 里自动 focus 会弹出键盘，并把 fixed 弹窗挤到页面最上方/压得很矮。
    // 因此移动端只打开弹窗，不主动聚焦；桌面端保留聚焦体验。
    requestAnimationFrame(() => {
        if (cardEl) {
            cardEl.scrollTop = 0;
        }

        if (!isSmallTouchScreen()) {
            instructionEl?.focus();
        }
    });
}

function closeRewriteQuickDialog() {
    const dialog = document.querySelector('#response_guard_quick_rewrite_dialog');
    dialog?.classList.add('hidden');
    document.body.classList.remove('response-guard-modal-open');
}

async function rewriteLatestWithInstruction(instruction, { apply = false } = {}) {
    const latest = getLatestAssistantMessage();

    if (!latest) {
        throw new Error('没有找到可修改的最新 AI 回复。');
    }

    const cleanInstruction = String(instruction || '').trim();
    if (!cleanInstruction) {
        throw new Error('请先填写你想修改哪里、怎么修改。');
    }

    const rewritten = await runRewrite({ reply: latest.message.mes, instruction: cleanInstruction });

    const profile = getActiveProfile();
    profile.rewriteInstruction = cleanInstruction;
    profile.rewriteResult = rewritten;
    saveSettings();

    if (apply) {
        await replaceMessageText(latest.index, latest.message, rewritten);
    }

    return rewritten;
}

async function generateRewriteQuickPreview() {
    const dialog = ensureRewriteQuickDialog();
    const instructionEl = dialog.querySelector('#response_guard_quick_rewrite_instruction');
    const resultEl = dialog.querySelector('#response_guard_quick_rewrite_result');
    const buttonEl = dialog.querySelector('#response_guard_quick_generate_rewrite');
    const instruction = String(instructionEl?.value || '').trim();

    if (!instruction) {
        toastr.warning('请先填写你想修改哪里、怎么修改。');
        return;
    }

    buttonEl?.setAttribute('disabled', 'disabled');

    try {
        toastr.info(`正在用「${getActiveProfile().name}」生成局部修改预览…`);
        const rewritten = await rewriteLatestWithInstruction(instruction, { apply: false });

        if (resultEl) {
            resultEl.value = rewritten;
            focusTextareaStart(resultEl);
        }

        const settingsResultEl = document.querySelector('#response_guard_rewrite_result');
        const settingsInstructionEl = document.querySelector('#response_guard_rewrite_instruction');
        if (settingsInstructionEl) settingsInstructionEl.value = instruction;
        if (settingsResultEl) {
            settingsResultEl.value = rewritten;
            focusTextareaStart(settingsResultEl);
        }

        toastr.success('已生成修改预览，确认满意后再应用到最新回复。');
    } catch (error) {
        console.error('[Response Guard] Quick rewrite failed:', error);
        toastr.error(error?.message || '局部修改失败。');
    } finally {
        buttonEl?.removeAttribute('disabled');
    }
}

async function applyRewriteQuickResult() {
    const dialog = ensureRewriteQuickDialog();
    const resultEl = dialog.querySelector('#response_guard_quick_rewrite_result');
    const rewritten = String(resultEl?.value || '').trim();
    const latest = getLatestAssistantMessage();

    if (!latest) {
        toastr.warning('没有找到可覆盖的最新 AI 回复。');
        return;
    }

    if (!rewritten) {
        toastr.warning('还没有可应用的修改结果。请先生成修改预览。');
        return;
    }

    const confirmed = confirm('确定用“修改结果预览”覆盖最新一条 AI 回复吗？这个操作会直接改写当前 swipe 的内容。');
    if (!confirmed) {
        return;
    }

    try {
        await replaceMessageText(latest.index, latest.message, rewritten);
        getActiveProfile().rewriteResult = rewritten;
        saveSettings();
        toastr.success('已将修改结果应用到最新回复。');
        closeRewriteQuickDialog();
    } catch (error) {
        console.error('[Response Guard] Quick apply rewrite failed:', error);
        toastr.error(error?.message || '应用修改失败。');
    }
}

async function copyRewriteQuickResult() {
    const dialog = ensureRewriteQuickDialog();
    const resultEl = dialog.querySelector('#response_guard_quick_rewrite_result');
    const rewritten = String(resultEl?.value || '').trim();

    if (!rewritten) {
        toastr.warning('还没有可复制的修改结果。');
        return;
    }

    try {
        await copyTextToClipboard(rewritten);
        toastr.success('已复制修改结果。');
    } catch (error) {
        console.error('[Response Guard] Copy quick rewrite failed:', error);
        toastr.error('复制失败，请手动选中结果复制。');
    }
}

function ensureMagicMenuItems(retryCount = 0) {
    const extensionsMenu = document.getElementById('extensionsMenu');

    if (!extensionsMenu) {
        if (retryCount < 20) {
            setTimeout(() => ensureMagicMenuItems(retryCount + 1), 250);
        }
        return;
    }

    if (document.getElementById('response_guard_magic_fix')) {
        return;
    }

    const fixItem = document.createElement('div');
    fixItem.id = 'response_guard_magic_fix_container';
    fixItem.className = 'extension_container interactable';
    fixItem.tabIndex = 0;
    fixItem.innerHTML = `
      <div id="response_guard_magic_fix" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="检查最新回复并把缺失格式追加到末尾">
        <div class="fa-fw fa-solid fa-shield-halved extensionsMenuExtensionButton"></div>
        <span>Response Guard：补齐格式</span>
      </div>
    `;

    const rewriteItem = document.createElement('div');
    rewriteItem.id = 'response_guard_magic_rewrite_container';
    rewriteItem.className = 'extension_container interactable';
    rewriteItem.tabIndex = 0;
    rewriteItem.innerHTML = `
      <div id="response_guard_magic_rewrite" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="打开局部修改窗口，修改最新回复中间内容">
        <div class="fa-fw fa-solid fa-pen-to-square extensionsMenuExtensionButton"></div>
        <span>Response Guard：局部修改</span>
      </div>
    `;

    extensionsMenu.appendChild(fixItem);
    extensionsMenu.appendChild(rewriteItem);
}

function bindMagicMenuEvents() {
    if (bindMagicMenuEvents.bound) {
        return;
    }

    bindMagicMenuEvents.bound = true;

    document.addEventListener('click', (event) => {
        if (event.target.closest('#response_guard_magic_fix')) {
            event.preventDefault();
            event.stopPropagation();
            checkLatestMessage({ repair: true });
            return;
        }

        if (event.target.closest('#response_guard_magic_rewrite')) {
            event.preventDefault();
            event.stopPropagation();
            openRewriteQuickDialog();
        }
    });
}

function exposeGlobalApi() {
    window.ResponseGuard = {
        checkOnly: () => checkLatestMessage({ repair: false }),
        checkAndFix: () => checkLatestMessage({ repair: true }),
        fixLatest: () => checkLatestMessage({ repair: true }),
        openRewriteDialog: () => openRewriteQuickDialog(),
        rewriteLatest: (instruction, options = {}) => rewriteLatestWithInstruction(instruction, options),
        getActiveProfile: () => clone(getActiveProfile()),
    };
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
    const rewriteInstructionEl = document.querySelector('#response_guard_rewrite_instruction');
    const rewriteResultEl = document.querySelector('#response_guard_rewrite_result');

    if (profileNameEl) profileNameEl.value = profile.name;
    if (rulesEl) rulesEl.value = profile.rules;
    if (apiModeEl) apiModeEl.value = profile.apiMode;
    if (temperatureEl) temperatureEl.value = String(profile.temperature);
    if (baseUrlEl) baseUrlEl.value = profile.customBaseUrl;
    if (modelEl) modelEl.value = profile.customModel;
    if (apiKeyEl) apiKeyEl.value = profile.customApiKey;
    if (inductionExampleEl) inductionExampleEl.value = profile.inductionExample;
    if (inductionRequirementEl) inductionRequirementEl.value = profile.inductionRequirement;
    if (inductionResultEl) {
        inductionResultEl.value = profile.inductionResult;
        focusTextareaStart(inductionResultEl);
    }
    if (rewriteInstructionEl) rewriteInstructionEl.value = profile.rewriteInstruction;
    if (rewriteResultEl) {
        rewriteResultEl.value = profile.rewriteResult;
        focusTextareaStart(rewriteResultEl);
    }

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
    const rewriteInstructionEl = document.querySelector('#response_guard_rewrite_instruction');
    const rewriteResultEl = document.querySelector('#response_guard_rewrite_result');
    const generateRewriteEl = document.querySelector('#response_guard_generate_rewrite');
    const applyRewriteEl = document.querySelector('#response_guard_apply_rewrite');
    const copyRewriteEl = document.querySelector('#response_guard_copy_rewrite_result');

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
        || !rewriteInstructionEl
        || !rewriteResultEl
        || !generateRewriteEl
        || !applyRewriteEl
        || !copyRewriteEl
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

    rewriteInstructionEl.addEventListener('input', () => {
        getActiveProfile().rewriteInstruction = rewriteInstructionEl.value;
        saveSettings();
    });

    rewriteResultEl.addEventListener('input', () => {
        getActiveProfile().rewriteResult = rewriteResultEl.value;
        saveSettings();
    });

    generateRewriteEl.addEventListener('click', () => generateRewritePreview());
    applyRewriteEl.addEventListener('click', () => applyRewriteResult());
    copyRewriteEl.addEventListener('click', () => copyRewriteResult());

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
    ensureMagicMenuItems();
    bindMagicMenuEvents();
    exposeGlobalApi();

    console.log('[Response Guard] Extension loaded');
}

getContext().eventSource.on(getContext().eventTypes.APP_READY, init);
