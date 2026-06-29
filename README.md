# Alice

Alice 是一个本地优先的个人陪伴型 Agent 框架，当前实现基于 `ChatAgent / Plugin` 架构。目标架构见 [agent_core_plugin_architecture.md](/home/wyf98/Alice/agent_core_plugin_architecture.md)，当前代码实际实现见 [ARCHITECTURE.md](/home/wyf98/Alice/ARCHITECTURE.md)。

## 当前实现

- TypeScript monorepo 骨架，使用 pnpm workspace 元数据。
- ChatAgent 运行时边界：
  - 标准化 `AgentEvent` 与 `AgentOutput`。
  - 会话解析、输出路由、工具调用循环与 LLM 会话归档。
  - 可编辑 prompt profile、附加 prompt 层和每日 shell prompt。
- 内部 OpenAI 兼容 `/v1` LLM 客户端：
  - 支持配置 `LLM_BASE_URL`。
  - 可接入 OpenAI、DeepSeek、opencode 以及类似 `/v1/chat/completions` 的服务。
  - 支持 OpenAI 风格 function tool calls，由 ChatAgent 执行工具。
  - 未配置 API key 或 base URL 时会使用本地 stub 客户端。
- 飞书 Channel Plugin：
  - 通过飞书/Lark SDK 使用 WebSocket 事件订阅。
  - 将文本消息规范化为 `AgentEvent`。
  - 通过 `/pair alice` 绑定唯一用户。
  - 支持发送文本、Markdown、图片、音频与文件。
- 微信 iLink Channel Plugin：
  - 通过 `getupdates` 长轮询接收文本消息。
  - 支持发送文本、图片和音频，支持 typing 状态。
  - 复用 Core 侧 `messages` 与追加式 `message_logs` 存储。
  - 缓存 `context_token`，用于向曾经来信的微信用户主动发送消息。
- Media Tool Plugin：
  - 提供 `selfie` 工具，用 Image API 生成 Alice 自拍照。
  - 默认直接调用 `/v1/images/edits`，使用低质量、小尺寸、单张输出配置。
  - 使用角色、图书馆参考图；如果当前服装参考图存在，会作为第三张参考图，否则降级为文字服装描述。
  - 生成前先发送简短进行中提示。
  - 阻止连续两次调用 `selfie`。
- Tool description 编写规则见 [tool_description_guideline.md](/home/yf/Alice/src/capabilities/tools/tool_description_guideline.md)。
- 本地持久化：
  - SQLite Core 侧消息历史。
  - SQLite 追加式消息事件日志。
  - SQLite FTS5 持久消息搜索。
  - JSONL 活跃 LLM 会话归档。
  - 文件化系统日志，保留 7 天。
- 管理后台：`http://127.0.0.1:3030/admin`。
  - 端口来自 `API_PORT`，默认 `3030`。

## 运行命令

```bash
npm install
npm run typecheck
npm run dev:api
```

仓库保留 pnpm workspace 元数据，但当前脚本也可以用 npm 执行。

`npm run dev:api` 会先构建 TypeScript，再启动编译后的 API 进程。

## 环境配置

复制 `.env.example`，然后按使用的模型服务设置变量：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=...
LLM_MODEL=deepseek-chat
```

如果使用本地 opencode 兼容端点，把 `LLM_BASE_URL` 指向它的 `/v1` base URL。

睡眠 Memorize 使用独立模型配置，不复用 Core 对话模型：

```bash
MEMORY_SUMMARY_ENABLED=true
MEMORY_SUMMARY_BASE_URL=https://api.deepseek.com
MEMORY_SUMMARY_API_KEY=...
MEMORY_SUMMARY_MODEL=deepseek-v4-pro
MEMORY_SUMMARY_TEMPERATURE=0.8
MEMORY_SUMMARY_TIMEOUT_MS=120000
MEMORY_SUMMARY_EXTRA_PARAMS={"thinking":{"type":"enabled"},"reasoning_effort":"high"}
```

也可以只设置 `DEEPSEEK_API_KEY`，或复用 `LLM_BASE_URL` / `LLM_API_KEY` 作为 API 授权与端点；Memorize 不复用 Core 的模型和温度，默认仍是 `deepseek-v4-pro` / `0.8`。长期记忆、agent 日记和 Core 侧消息历史保存在 `memory-files/alice.sqlite`。一次性历史回填命令：

```bash
npm run build
node dist/scripts/backfill-sleep-memory.js
```

自拍图片工具需要 OpenAI Image API key：

```bash
OPENAI_API_KEY=...
```

详细拍照工具配置和独立测速命令见 [tools/photo/README.md](/home/wyf98/Alice/src/tools/photo/README.md)。

## 微信 iLink

微信 iLink 可以和飞书同时启用。基础配置可写入 `.env`，也可在管理后台修改：

```env
WECHAT_ENABLED=true
WECHAT_ILINK_BASE_URL=https://ilinkai.weixin.qq.com
WECHAT_ILINK_POLL_TIMEOUT_MS=35000
```

在管理后台打开 `Channel Settings`，切换到 `WeChat` 标签，点击 `Get Login QR`，用微信扫码并在手机上确认。确认后的 `bot_token` 和账号专属 `baseurl` 会保存到：

```text
memory-files/indexes/wechat-ilink-state.json
```

微信插件会长轮询 `getupdates`，把入站文本写入当前消息日志和运行时，缓存每个发送者最近的 `context_token`，并通过 `sendmessage` 发送出站文本。主动发送需要该微信用户此前发过消息，以便复用缓存的 token。
图片和音频发送会先通过 iLink/CDN 上传本地 `assets/` 内文件，再随 `sendmessage` 发出。

## 重要本地状态

```text
.env
memory-files/alice.sqlite
logs/system/*.log.jsonl
logs/message/message-logs.sqlite
logs/talk/talk.sqlite
memory-files/llm-sessions/core/YYYY-MM-DD/*.jsonl
memory-files/llm-sessions/memorize/YYYY-MM-DD/*.jsonl
memory-files/indexes/feishu-paired-contacts.json
memory-files/indexes/wechat-ilink-state.json
src/core/prompt/prompt-profile.json
src/core/prompt/memorize-prompts.json
src/core/prompt/prompt-api-profile.json
src/core/prompt/shell-prompt-template.txt
memory-files/shell/
```

所有 `logs/` 下的文件都按系统/运行日志处理；清理聊天历史时只清 `memory-files/alice.sqlite` 中的消息表，不要清 `logs/message/message-logs.sqlite` 或 `logs/talk/talk.sqlite`，除非明确是在清系统日志。

`src/core/prompt/` 中的 prompt 文件会随 Git 版本化；`data/`、`logs/`、部分运行时 `memory-files/` 目录、`.env`、`dist/` 和 `node_modules/` 已被 git 忽略。
