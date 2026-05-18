# Response Guard for SillyTavern

一个用于 SillyTavern 的轻量前端扩展：  
当 AI 忘记在回复末尾附带你要求的“小总结”“剧情推荐选项”等结构时，你可以点击按钮，让它只检查并补齐缺失部分，而不是重 roll 整条回复。

补齐结果会直接追加到**最新那条 AI 回复本身**，不会额外新建一条消息。

当前版本：`0.1.1`

## 功能

- 可自由编辑“格式规范 / 检查规则”
- 一键“仅检查”
- 一键“补齐到当前回复”
- 两种调用模式：
  - 使用 SillyTavern 当前已连接 API
  - 使用你自定义的 OpenAI-compatible API
- 自定义 API 支持点击“获取模型”自动请求模型列表，再从下拉框选择
- 只把“最新回复 + 规则”送去检查，不会为了这个动作重发整段聊天

## 安装

### 通过仓库链接安装（推荐）

在 SillyTavern 中打开：

```text
Extensions → Install extension
```

粘贴仓库地址：

```text
https://github.com/baiming12/sillytavern-response-guard
```

安装完成后重启或刷新 SillyTavern，即可在扩展设置中看到 **Response Guard**。

> 仓库根目录必须直接包含 `manifest.json`、`index.js`、`settings.html` 等文件。  
> 如果上传时又多包了一层文件夹，SillyTavern 可能会把扩展显示成 `undefined`。

### 手动本地安装

如果你只想自己本地使用，把整个 `response-guard` 文件夹放到：

```text
SillyTavern/data/<你的用户>/extensions/response-guard
```

然后重启 SillyTavern，在扩展设置里就能看到 **Response Guard**。

> 如果你想“给所有用户安装”或做本地开发，也可以放到 `public/scripts/extensions/third-party/response-guard`。  
> 注意：`third-party/...` 也是扩展在前端被挂载后的访问路径，并不代表当前用户的磁盘目录下一定要手动创建 `third-party` 文件夹。

如果你想通过 SillyTavern 的 **Install extension** 功能一键安装，直接使用本仓库地址即可。

## 使用

1. 在“格式规范 / 检查规则”里写下你当前想让模型遵守的附加结构。
2. 选择调用方式：
   - **使用酒馆当前 API**：最省事，直接复用你当前的连接；
   - **自定义 OpenAI-compatible API**：填写 API 地址、模型名、Key。
3. 当最新回复漏项时：
   - 点 **仅检查**：只告诉你缺了什么；
   - 点 **补齐到当前回复**：自动把缺失段落直接追加到最新 AI 回复末尾（同层修改，不新建消息）。

## 默认规则示例

```text
每条回复末尾必须包含：
1. 【本回合摘要】1-3 句，概括最新剧情推进
2. 【下一步建议】仅当剧情出现明显分岔时给出 2-4 个选项；若当前不适用，则明确写出“本回合暂无需要选择的分岔”

检查时只判断“最新回复”是否满足这些要求，不要要求重写正文。
```

## 注意

- “当前 API”模式最稳，因为它走的是 SillyTavern 自己的生成接口。
- “自定义 API”模式目前按 OpenAI-compatible `chat/completions` 方式直连；如果你的服务端不允许浏览器跨域请求，可能会被 CORS 拦住。
- “获取模型”按钮会按 OpenAI-compatible 约定请求 `/models`；如果你的服务端没有实现这个接口，仍可继续手填模型名。
- 自定义 API Key 会随着扩展设置一起保存；如果你不想额外保存一份密钥，优先用“当前 API”模式。
- 这个版本默认是**手动触发**，没有自动在每次回复后检查；这样更安全，也更符合“别多花 token”的初衷。
- 当前补齐方式更像“可配置的继续补尾巴”，但为了省 token，它不是直接复用整段聊天上下文继续写，而是只针对最新回复做补齐判断。


## 更新记录

### 0.1.1

- 修复通过 GitHub 安装后，因仓库目录名不同导致设置面板模板路径失效的问题
- README 增加 GitHub 上传目录结构提示
