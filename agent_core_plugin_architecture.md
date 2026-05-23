# AgentCore / Plugin 解耦架构方案

## 0. 目标

构建一个可扩展的个人 agent 系统，核心运行在 WSL2 中，飞书作为第一阶段 IM 入口，Codex CLI 作为代码代理能力，后续可扩展桌宠客户端。

整体拆成四类：

```text
AgentCore
  - Agent logic
  - LLM call
  - Web 后台
  - 调度 / 会话 / 事件总线

Plugin
  - Feishu connect
  - Codex connect
  - DesktopPet connect，暂不实现

MemoryFiles
  - 用户长期记忆
  - 会话摘要
  - 话题池
  - 文件化上下文
  - artifact 索引

Skills
  - 可调用技能
  - 工具定义
  - prompt 模板
  - 能力包
```

核心原则：

```text
1. AgentCore 不直接依赖飞书、Codex、桌宠。
2. 飞书、Codex、桌宠都作为 Plugin 接入。
3. Plugin 只负责连接、协议适配、输入输出转换。
4. AgentCore 只处理标准化事件、会话、记忆、任务和响应。
5. MemoryFiles 和 Skills 作为可插拔资源，不绑定具体平台。
```

一句话：

> 飞书是一个 Channel Plugin，Codex 是一个 Tool/Worker Plugin，桌宠未来是另一个 Channel Plugin；它们都通过统一事件协议接入 AgentCore。

---

# 1. 总体结构

```text
WSL2 Ubuntu Runtime

companion-agent/
├─ apps/
│  ├─ api/                    # AgentCore API + Web 后台 API
│  ├─ admin/                  # Web 管理后台
│  └─ desktop-pet/            # 未来桌宠客户端，暂不实现
│
├─ core/
│  ├─ agent/                  # Agent logic
│  ├─ llm/                    # LLM call adapter
│  ├─ session/                # 会话管理
│  ├─ event-bus/              # 内部事件总线
│  ├─ scheduler/              # 心跳 / 定时 / 主动入口
│  ├─ router/                 # 消息路由
│  ├─ renderer/               # 内部输出对象
│  └─ policy/                 # 权限、频率、主动性边界
│
├─ plugins/
│  ├─ feishu/                 # 飞书长连接 channel plugin
│  ├─ codex/                  # Codex CLI worker plugin
│  └─ desktop-pet/            # 未来桌宠 channel plugin，占位
│
├─ memory-files/
│  ├─ users/
│  ├─ sessions/
│  ├─ topics/
│  ├─ artifacts/
│  └─ indexes/
│
├─ skills/
│  ├─ builtin/
│  ├─ codex/
│  ├─ media/
│  ├─ web/
│  └─ custom/
│
├─ workers/
│  ├─ agent-worker/
│  ├─ codex-worker/
│  ├─ media-worker/
│  └─ scheduler-worker/
│
├─ infra/
│  ├─ docker-compose.yml
│  ├─ systemd/
│  └─ scripts/
│
└─ packages/
   ├─ types/
   ├─ config/
   ├─ storage/
   └─ utils/
```

---

# 2. 模块边界

## 2.1 AgentCore

AgentCore 是系统中心，但它不直接知道飞书 API、Codex CLI、桌宠协议。

AgentCore 负责：

```text
1. 接收标准化 AgentEvent
2. 维护用户、会话、话题、任务状态
3. 决定是否调用 LLM
4. 决定是否调用 Skill / Plugin Tool
5. 管理 MemoryFiles
6. 生成标准化 AgentOutput
7. 把 AgentOutput 交给对应 Plugin 渲染和发送
8. Web 后台展示系统状态与任务状态
```

AgentCore 不负责：

```text
1. 飞书 token、WSClient、消息格式
2. Codex CLI 具体命令
3. 桌宠窗口、动画、Live2D
4. 第三方平台协议细节
```

## 2.2 Plugin

Plugin 负责把外部世界接入 AgentCore。

Plugin 类型分两种：

```text
Channel Plugin:
  外部通信入口/出口。
  例如 Feishu、DesktopPet、未来微信/Telegram/WebChat。

Tool Plugin:
  Agent 可调用能力。
  例如 Codex、网页抓取、ASR、TTS、图片理解。
```

飞书属于 Channel Plugin。

Codex 属于 Tool Plugin + Worker Plugin。

桌宠未来属于 Channel Plugin + Presentation Plugin。

## 2.3 MemoryFiles

MemoryFiles 是文件化记忆层，用于让系统长期可迁移、可审计、可被 LLM 直接读取。

它不是数据库替代品，而是数据库之外的一层语义文件系统。

数据库存结构化状态：

```text
users
sessions
messages
jobs
topics
plugin_accounts
artifacts
```

MemoryFiles 存可读上下文：

```text
用户长期摘要
会话摘要
话题历史
偏好文件
项目上下文
Codex artifact 索引
技能说明
```

## 2.4 Skills

Skills 是 AgentCore 可调用的能力包。

每个 Skill 至少包含：

```text
skill.yaml       # 元数据、输入输出 schema、权限
prompt.md        # 调用时提示
handler.ts       # 可选：实际执行逻辑
README.md        # 人类可读说明
```

Codex 可以作为一个 Skill 暴露给 Agent，也可以作为独立 Plugin 被任务系统调用。

---

# 3. 内部事件协议

所有 Channel Plugin 输入都转换成统一的 `AgentEvent`。

```ts
type AgentEvent = {
  id: string;
  source: {
    plugin: "feishu" | "desktop-pet" | "web-admin" | string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    rawMessageId?: string;
  };
  session: {
    scope: "dm" | "group" | "topic" | "admin" | "desktop";
    sessionId: string;
    threadId?: string;
  };
  type:
    | "message.text"
    | "message.markdown"
    | "message.image"
    | "message.audio"
    | "message.file"
    | "message.link"
    | "message.card_action"
    | "system.heartbeat"
    | "job.completed"
    | "job.failed";
  payload: AgentPayload;
  meta: {
    receivedAt: string;
    locale?: string;
    timezone?: string;
    mentionsBot?: boolean;
    replyTo?: string;
    raw?: unknown;
  };
};
```

Payload 示例：

```ts
type AgentPayload =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "image"; assetId: string; alt?: string }
  | { kind: "audio"; assetId: string; transcript?: string }
  | { kind: "file"; assetId: string; filename: string; mime?: string }
  | { kind: "link"; url: string; title?: string; description?: string }
  | { kind: "card_action"; actionId: string; values: Record<string, unknown> };
```

所有输出统一成 `AgentOutput`。

```ts
type AgentOutput = {
  id: string;
  target: {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
    replyTo?: string;
  };
  content:
    | { kind: "text"; text: string }
    | { kind: "markdown"; markdown: string }
    | { kind: "html"; htmlAssetId: string; fallbackMarkdown?: string }
    | { kind: "card"; card: InternalCard }
    | { kind: "image"; assetId: string }
    | { kind: "audio"; assetId: string; transcript?: string }
    | { kind: "file"; assetId: string; filename: string };
  meta: {
    createdAt: string;
    urgency: "silent" | "normal" | "important";
    allowStreaming?: boolean;
  };
};
```

Plugin 只需要实现：

```ts
interface ChannelPlugin {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(output: AgentOutput): Promise<void>;
}
```

Tool Plugin 需要实现：

```ts
interface ToolPlugin {
  id: string;
  listTools(): ToolDefinition[];
  execute(call: ToolCall): Promise<ToolResult>;
}
```

---

# 4. 飞书 Plugin：采用 OpenClaw 式长连接方案

## 4.1 选择长连接而不是公网 Webhook

飞书 Plugin 默认采用长连接 WebSocket 事件订阅。

理由：

```text
1. WSL2 本地运行，不需要公网 HTTPS 回调。
2. 不需要 ngrok / cloudflared 才能接收飞书消息。
3. 系统主动连出飞书，网络部署更简单。
4. 更适合个人本地 agent。
```

飞书 webhook 模式作为备用。

```text
connectionMode:
  websocket   # 默认
  webhook     # 可选，部署到公网服务时使用
```

## 4.2 飞书 Plugin 内部结构

```text
plugins/feishu/
├─ index.ts
├─ config.ts
├─ client.ts
├─ monitor.ts
├─ event-dispatcher.ts
├─ handlers/
│  ├─ message.ts
│  ├─ card-action.ts
│  ├─ reaction.ts
│  └─ bot-menu.ts
├─ policy.ts
├─ pairing.ts
├─ media.ts
├─ renderer.ts
├─ outbound.ts
├─ bindings.ts
└─ types.ts
```

### client.ts

职责：

```text
1. 创建飞书 HTTP Client
2. 创建飞书 WSClient
3. 创建事件分发器
4. 管理 tenant token 缓存
5. 支持飞书 / Lark domain 配置
```

### monitor.ts

职责：

```text
1. 启动 WS 长连接
2. 注册消息事件 handler
3. 注册卡片 action handler
4. 注册 reaction / bot menu 等事件
5. 断线重连
6. 事件去重
```

### handlers/message.ts

职责：

```text
1. 解析飞书 message event
2. 判断私聊 / 群聊 / thread
3. 判断是否 @bot
4. 去掉 mention
5. 下载图片、语音、文件资源
6. 把飞书消息转成 AgentEvent
7. 投递到 AgentCore event bus
```

### media.ts

职责：

```text
1. 下载飞书图片 / 音频 / 文件
2. 上传图片 / 音频 / 文件
3. 生成 internal assetId
4. 把 assetId 交给 AgentCore
```

### renderer.ts

职责：

```text
1. AgentOutput text → 飞书 text
2. AgentOutput markdown → 飞书 card / post
3. AgentOutput card → 飞书 interactive card
4. AgentOutput image → 飞书 image_key
5. AgentOutput audio → 飞书 audio/file
6. AgentOutput file → 飞书 file
```

### outbound.ts

职责：

```text
1. send message
2. reply message
3. update card
4. send streaming card update
5. split long message
6. rate limit
```

### bindings.ts

职责：

```text
1. 飞书 user/chat/thread 到 AgentCore session 的映射
2. 群 topic 到 session 的映射
3. 某个飞书会话绑定到某个 agent profile
4. 某个飞书会话绑定到 Codex session
```

---

## 4.3 飞书权限策略

默认策略保守。

```ts
type FeishuPluginConfig = {
  enabled: boolean;
  connectionMode: "websocket" | "webhook";

  accounts: Record<string, {
    appId: string;
    appSecret: string;
    name?: string;
  }>;

  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  dmAllowFrom?: string[];

  groupPolicy: "allowlist" | "open" | "disabled";
  groupAllowFrom?: string[];
  requireMention: boolean;

  codexPolicy: {
    enabled: boolean;
    requireAllowlist: boolean;
    allowedUsers: string[];
    allowedChats: string[];
    requireExplicitCommand: boolean;
  };
};
```

推荐默认：

```ts
const defaultFeishuConfig = {
  connectionMode: "websocket",
  dmPolicy: "pairing",
  groupPolicy: "allowlist",
  requireMention: true,
  codexPolicy: {
    enabled: true,
    requireAllowlist: true,
    allowedUsers: [],
    allowedChats: [],
    requireExplicitCommand: true,
  },
};
```

策略说明：

```text
1. 未配对用户不能直接私聊 agent。
2. 群聊默认必须在 allowlist。
3. 群聊默认必须 @bot 才处理。
4. Codex 必须显式命令触发，不能从普通闲聊自动进入。
5. Codex 触发用户和群必须在 allowlist。
```

---

## 4.4 飞书消息到 AgentEvent 的转换

飞书输入：

```text
Feishu WS event
  ↓
parse message event
  ↓
normalize mentions / chat / sender / thread
  ↓
download media if needed
  ↓
create AgentEvent
  ↓
AgentCore event bus
```

示例：

```ts
const event: AgentEvent = {
  id: internalId,
  source: {
    plugin: "feishu",
    accountId: "main",
    channelId: feishuChatId,
    userId: feishuOpenId,
    rawMessageId: feishuMessageId,
  },
  session: {
    scope: chatType === "p2p" ? "dm" : "group",
    sessionId: sessionIdFromBinding,
    threadId: feishuThreadId,
  },
  type: "message.text",
  payload: {
    kind: "text",
    text: normalizedText,
  },
  meta: {
    receivedAt: new Date().toISOString(),
    mentionsBot,
    replyTo: feishuMessageId,
    raw: rawEvent,
  },
};
```

---

# 5. Codex Plugin

Codex Plugin 不直接作为飞书插件的一部分，而是一个独立 Tool/Worker Plugin。

## 5.1 目标

```text
1. 在 WSL2 中调用 Codex CLI。
2. 支持从飞书、Web 后台、未来桌宠触发。
3. 支持长任务、进度、日志、artifact。
4. 支持结果回推到原始 Channel。
5. 不把 Codex 直接暴露给任意用户。
```

## 5.2 Codex Plugin 结构

```text
plugins/codex/
├─ index.ts
├─ config.ts
├─ runner.ts
├─ session-manager.ts
├─ workspace.ts
├─ job-store.ts
├─ result-parser.ts
├─ artifact.ts
├─ renderer.ts
└─ tools.ts
```

## 5.3 Codex Job 流程

```text
AgentCore / Web Admin / Feishu command
  ↓
create CodexJob
  ↓
queue: codex_jobs
  ↓
codex-worker pickup
  ↓
prepare workspace
  ↓
spawn codex CLI
  ↓
capture stdout / stderr / JSONL / diff
  ↓
store logs + artifacts
  ↓
build AgentOutput
  ↓
return to target Channel Plugin
```

## 5.4 Codex Job Schema

```ts
type CodexJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";

  requester: {
    plugin: "feishu" | "web-admin" | "desktop-pet";
    userId: string;
    sessionId: string;
    replyTo?: string;
  };

  repo: {
    repoId: string;
    path: string;
    branch?: string;
    workspacePath?: string;
  };

  prompt: string;
  mode: "inspect" | "edit" | "test" | "review" | "custom";

  safety: {
    allowWrite: boolean;
    allowNetwork: boolean;
    timeoutMs: number;
    requireApproval?: boolean;
  };

  result?: {
    summaryMarkdown?: string;
    diffPatchAssetId?: string;
    logAssetId?: string;
    htmlReportAssetId?: string;
    changedFiles?: string[];
    exitCode?: number;
  };

  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};
```

## 5.5 Codex CLI 调用层

Codex Plugin 只封装命令调用，不在飞书 handler 中直接执行。

```ts
interface CodexRunner {
  run(job: CodexJob): Promise<CodexResult>;
  cancel(jobId: string): Promise<void>;
}
```

伪代码：

```ts
async function runCodexJob(job: CodexJob): Promise<CodexResult> {
  const workspace = await prepareWorkspace(job);

  const child = spawn("codex", ["exec", job.prompt], {
    cwd: workspace.path,
    env: buildSafeEnv(job),
  });

  streamLogs(job.id, child.stdout, "stdout");
  streamLogs(job.id, child.stderr, "stderr");

  const exitCode = await waitForExit(child, job.safety.timeoutMs);
  const diff = await collectGitDiff(workspace.path);
  const artifacts = await collectArtifacts(job, diff);

  return parseCodexResult({ exitCode, diff, artifacts });
}
```

## 5.6 Codex 输出渲染

Codex 输出先转成标准 `AgentOutput`，再由飞书/网页/桌宠各自渲染。

```text
CodexResult
  ↓
AgentOutput markdown/card/html/file
  ↓
Feishu Renderer / Web Renderer / Desktop Renderer
```

飞书推荐渲染：

```text
短结果：飞书 interactive card
长结果：摘要卡片 + Markdown 文件
HTML：摘要卡片 + HTML artifact 链接
Diff：摘要卡片 + patch 文件
Log：错误片段 + 完整 log 文件
```

Codex 长任务推荐：

```text
1. 任务创建：发送 “queued” 卡片
2. 开始运行：更新为 “running”
3. 关键阶段：更新摘要，不刷屏
4. 完成：更新为结果卡片
5. 失败：更新为错误卡片 + log artifact
```

---

# 6. AgentCore 内部流程

## 6.1 输入处理

```text
Plugin Event
  ↓
AgentEvent
  ↓
Policy Check
  ↓
Session Resolve
  ↓
Memory Load
  ↓
Intent Router
  ↓
Agent Logic / Skill Call / Tool Plugin
  ↓
AgentOutput
  ↓
Output Router
  ↓
Target Plugin.send()
```

## 6.2 Intent Router

Intent Router 不做复杂人格判断，先判断事件类型。

```text
message.text
  - 普通对话
  - 命令
  - Codex 请求
  - 分享内容
  - 任务创建

message.image
  - 图片理解
  - OCR/视觉描述
  - 图片保存

message.audio
  - ASR
  - 转文本后进入 message.text

message.link
  - 链接解析
  - 保存分享
  - 生成卡片

card_action
  - 任务操作
  - Codex approve/cancel/retry
  - 配置修改
```

## 6.3 命令与普通对话分离

Codex 触发必须走显式命令或卡片按钮。

示例命令：

```text
/codex inspect repo-name: 看一下测试失败
/codex review repo-name branch-name
/codex run repo-name: npm test 后分析错误
/codex edit repo-name: 修改 xxx
```

普通聊天不能自动触发 Codex 写文件。

---

# 7. MemoryFiles 设计

## 7.1 目录结构

```text
memory-files/
├─ users/
│  └─ user_xxx/
│     ├─ profile.md
│     ├─ preferences.md
│     ├─ interaction_style.md
│     ├─ allowed_context.md
│     └─ index.json
│
├─ sessions/
│  └─ session_xxx/
│     ├─ summary.md
│     ├─ recent.md
│     ├─ open_loops.md
│     └─ index.json
│
├─ topics/
│  └─ topic_xxx.md
│
├─ projects/
│  └─ repo_xxx/
│     ├─ context.md
│     ├─ codex_notes.md
│     ├─ decisions.md
│     └─ index.json
│
├─ artifacts/
│  └─ job_xxx/
│     ├─ result.md
│     ├─ diff.patch
│     ├─ log.txt
│     └─ report.html
│
└─ indexes/
   ├─ users.json
   ├─ sessions.json
   ├─ topics.json
   └─ artifacts.json
```

## 7.2 Memory 类型

```text
Profile Memory:
  用户长期信息、偏好、交互边界。

Session Memory:
  当前会话摘要、最近上下文。

Topic Memory:
  可延续话题、未闭合事项、分享内容。

Project Memory:
  代码项目上下文、架构决策、Codex 历史。

Artifact Memory:
  Codex 输出、日志、diff、HTML 报告。
```

## 7.3 MemoryFiles 与数据库关系

数据库负责查询和状态：

```text
memory_file_id
path
owner
scope
status
created_at
updated_at
embedding_id
```

文件负责给 LLM 读取：

```text
Markdown / JSON / patch / log / html
```

---

# 8. Skills 设计

## 8.1 Skill 目录

```text
skills/
├─ builtin/
│  ├─ summarize/
│  ├─ extract-todo/
│  ├─ make-card/
│  └─ schedule-followup/
│
├─ codex/
│  ├─ inspect-repo/
│  ├─ review-diff/
│  ├─ run-tests/
│  └─ apply-change/
│
├─ media/
│  ├─ image-understand/
│  ├─ audio-transcribe/
│  └─ tts/
│
├─ web/
│  ├─ parse-link/
│  ├─ fetch-metadata/
│  └─ make-share-card/
│
└─ custom/
```

## 8.2 Skill Schema

```yaml
id: codex.inspect_repo
name: Inspect Repo
kind: tool
version: 0.1.0
permissions:
  - codex:read
  - filesystem:workspace
input_schema:
  type: object
  properties:
    repoId:
      type: string
    prompt:
      type: string
output_schema:
  type: object
  properties:
    markdown:
      type: string
handler: ./handler.ts
```

## 8.3 Skill 调用

AgentCore 调用 Skill，不直接调用插件实现。

```text
AgentCore
  ↓
Skill Registry
  ↓
Skill Handler
  ↓
Tool Plugin / Worker
  ↓
ToolResult
```

Codex Skill 的 handler 内部创建 CodexJob，而不是同步阻塞等待。

---

# 9. Web 后台

Web 后台属于 AgentCore，不属于 Plugin。

## 9.1 主要功能

```text
Dashboard:
  - AgentCore 状态
  - Plugin 状态
  - Worker 状态
  - Queue 状态

Feishu:
  - 账号配置
  - WS 连接状态
  - 用户配对
  - 群 allowlist
  - session binding
  - 消息事件日志

Codex:
  - repo 白名单
  - job 列表
  - 当前运行任务
  - 日志
  - artifacts
  - approve/cancel/retry

MemoryFiles:
  - 用户记忆文件
  - 会话摘要
  - 话题池
  - 项目上下文

Skills:
  - 已安装 skills
  - 权限
  - prompt 模板
  - 测试调用

Renderer Debug:
  - AgentOutput 预览
  - 飞书卡片预览
  - Markdown/HTML 转换结果
```

## 9.2 Web 后台与 API

```text
apps/admin   Next.js / React
apps/api     Fastify / NestJS API
```

后台通过 API 读写：

```text
/users
/sessions
/plugins
/plugins/feishu/status
/plugins/feishu/pairing
/plugins/codex/jobs
/memory-files
/skills
/events
```

---

# 10. 数据库与运行时基础设施

## 10.1 推荐技术栈

```text
Language: TypeScript
Package Manager: pnpm
API: Fastify
Admin: Next.js + React
Queue: BullMQ
Cache: Redis
DB: PostgreSQL
ORM: Prisma 或 Drizzle
Storage: MinIO，本地；生产可换 S3/R2/OSS
Process: PM2 / systemd / Docker Compose
```

## 10.2 数据表草案

```text
users
plugin_accounts
plugin_identities
sessions
session_bindings
messages
events
topics
memory_files
skills
jobs
codex_jobs
artifacts
permissions
```

关键表：`session_bindings`

```sql
session_bindings
- id
- plugin              feishu / desktop-pet / web-admin
- external_scope      dm / group / topic
- external_id         feishu chat_id / thread_id / user_id
- agent_session_id
- agent_profile_id
- tool_profile_id     optional, e.g. codex
- created_at
- updated_at
```

关键表：`codex_jobs`

```sql
codex_jobs
- id
- requester_plugin
- requester_user_id
- requester_session_id
- source_message_id
- repo_id
- workspace_path
- prompt
- mode
- status
- result_markdown
- diff_artifact_id
- log_artifact_id
- html_artifact_id
- created_at
- started_at
- finished_at
```

---

# 11. 飞书 + Codex 端到端流程

## 11.1 普通飞书消息

```text
User in Feishu
  ↓
Feishu WS event
  ↓
Feishu Plugin monitor
  ↓
Message handler
  ↓
AgentEvent
  ↓
AgentCore Router
  ↓
Agent logic + LLM
  ↓
AgentOutput
  ↓
Feishu Renderer
  ↓
Feishu send message/card
```

## 11.2 飞书触发 Codex

```text
User: /codex inspect project-a 测试为什么失败
  ↓
Feishu Plugin → AgentEvent
  ↓
AgentCore detects codex command
  ↓
Policy check:
    user allowlist?
    chat allowlist?
    repo allowlist?
    write allowed?
  ↓
Create CodexJob
  ↓
Codex Worker runs CLI
  ↓
Progress event → AgentOutput card update
  ↓
Codex result → artifact + summary
  ↓
Feishu Plugin sends final card
```

## 11.3 Codex 长任务更新

```text
queued card
  ↓ update
running card
  ↓ update
summary card
  ↓ update
completed card with links
```

不要频繁刷屏。

---

# 12. Markdown / HTML 处理

内部统一支持：

```text
text
markdown
html artifact
card
file
image
audio
```

飞书渲染策略：

```text
text:
  直接发送 text

markdown:
  短内容 → 飞书卡片 rich text
  长内容 → 摘要卡片 + md 文件

html:
  不直接发 HTML
  存 artifact
  发摘要卡片 + 链接

code block / diff:
  小片段放卡片
  完整内容放 artifact

image:
  上传飞书 image_key 后发送

audio:
  生成音频文件后发送
```

Renderer 应该做长度判断、分块和降级。

```ts
function renderForFeishu(output: AgentOutput): FeishuSendPlan {
  switch (output.content.kind) {
    case "text":
      return renderText(output);
    case "markdown":
      return outputTooLong(output)
        ? renderMarkdownAsFileWithSummary(output)
        : renderMarkdownCard(output);
    case "html":
      return renderHtmlArtifactCard(output);
    case "card":
      return renderInteractiveCard(output);
  }
}
```

---

# 13. 桌宠预留方案

桌宠暂不实现，但要提前解耦。

未来桌宠是 Channel Plugin。

```text
plugins/desktop-pet/
├─ index.ts
├─ websocket.ts
├─ renderer.ts
├─ actions.ts
└─ types.ts
```

桌宠通过 WebSocket 连接 AgentCore。

```text
DesktopPet Client
  ↔ WebSocket
AgentCore
```

桌宠输出对象不使用飞书卡片，而是：

```ts
type DesktopPetOutput =
  | { type: "say"; text: string }
  | { type: "emotion"; emotion: "idle" | "thinking" | "happy" | "tired" }
  | { type: "action"; name: string }
  | { type: "bubble"; title?: string; body: string }
  | { type: "card"; title: string; body: string; actions?: Action[] };
```

桌宠技术栈建议：

```text
Tauri + React
或 Electron + React
Live2D 可作为后续表现层
```

---

# 14. 配置文件示例

```ts
export default {
  core: {
    timezone: "Asia/Singapore",
    defaultAgentProfile: "main",
  },

  plugins: {
    feishu: {
      enabled: true,
      connectionMode: "websocket",
      accounts: {
        main: {
          appId: process.env.FEISHU_APP_ID,
          appSecret: process.env.FEISHU_APP_SECRET,
          name: "Agent",
        },
      },
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      requireMention: true,
      codexPolicy: {
        enabled: true,
        requireAllowlist: true,
        allowedUsers: [],
        allowedChats: [],
        requireExplicitCommand: true,
      },
    },

    codex: {
      enabled: true,
      cliPath: "codex",
      workspaceRoot: "/home/user/agent-workspaces",
      allowedRepos: [
        {
          id: "main-project",
          path: "/home/user/projects/main-project",
          allowWrite: false,
        },
      ],
      defaultTimeoutMs: 1000 * 60 * 20,
      maxConcurrentJobs: 1,
    },

    desktopPet: {
      enabled: false,
    },
  },

  memoryFiles: {
    root: "/home/user/companion-agent/memory-files",
  },

  skills: {
    root: "/home/user/companion-agent/skills",
  },
};
```

---

# 15. 安全边界

## 15.1 飞书安全

```text
1. 私聊默认 pairing。
2. 群聊默认 allowlist。
3. 群聊默认 requireMention。
4. 事件必须去重。
5. 所有原始事件落库，方便审计。
6. 卡片 action 必须校验来源用户。
```

## 15.2 Codex 安全

```text
1. repo 白名单。
2. workspace 隔离。
3. 不允许任意 shell 命令。
4. 默认 read-only inspect。
5. 写文件需要显式 mode 或后台批准。
6. 超时终止。
7. 并发限制。
8. 环境变量白名单。
9. artifact 审计。
10. 高风险操作需要 Web 后台 approve。
```

## 15.3 MemoryFiles 安全

```text
1. 不把 secret 写入 MemoryFiles。
2. MemoryFiles 与 .env 分离。
3. 用户记忆可在后台查看、编辑、删除。
4. 敏感话题默认不主动 resurfacing。
```

---

# 16. MVP 阶段

## Phase 0：基础骨架

```text
- pnpm monorepo
- Fastify API
- Postgres / Redis / MinIO
- Web Admin 空壳
- EventBus
- AgentEvent / AgentOutput 类型
```

## Phase 1：飞书长连接

```text
- 创建飞书自建应用
- 开启机器人能力
- 配置 WebSocket 事件订阅
- 实现 Feishu WSClient
- 接收文本消息
- 回复文本消息
- 支持 DM pairing
- 支持 group allowlist + requireMention
```

## Phase 2：飞书多模态基础

```text
- 接收图片
- 接收文件
- 接收语音并保存 asset
- 发送图片
- 发送文件
- 飞书卡片 renderer
- Markdown 转卡片
```

## Phase 3：Codex 接入

```text
- WSL2 安装 Codex CLI
- Codex Plugin
- Codex Worker
- repo 白名单
- /codex inspect 命令
- Codex 结果摘要回推飞书
- artifact 保存
```

## Phase 4：Web 后台完善

```text
- Plugin 状态页
- Feishu pairing 管理
- 群 allowlist 管理
- Codex job 管理
- artifact 查看
- MemoryFiles 查看
- Renderer debug
```

## Phase 5：MemoryFiles + Skills

```text
- MemoryFiles loader
- 会话摘要
- 话题池
- Skill registry
- Codex skill 化
- media skill 化
```

## Phase 6：桌宠预留实现

```text
- WebSocket channel plugin
- Tauri 客户端原型
- AgentOutput → DesktopPetOutput renderer
- 表情 / 气泡 / 简单动作
```

---

# 17. 第一版实现顺序

推荐具体顺序：

```text
1. 搭 monorepo 和基础数据库。
2. 定义 AgentEvent / AgentOutput。
3. 实现 Feishu Plugin 的 WebSocket 接入。
4. 飞书消息进 AgentCore，AgentCore 回 echo。
5. 加入 pairing / allowlist / requireMention。
6. 实现飞书 Markdown card renderer。
7. 实现 Codex Plugin 和 codex-worker。
8. 飞书命令触发 Codex inspect。
9. Codex 结果以飞书卡片返回。
10. Web 后台显示 event / session / codex job。
11. 再扩展图片、语音、网页分享。
```

---

# 18. 最终架构定义

最终系统应当长这样：

```text
Feishu Plugin
  - long connection
  - message/media/card action handling
  - policy + pairing
  - renderer + outbound

Codex Plugin
  - job creation
  - CLI runner
  - workspace isolation
  - artifact collection
  - markdown/html result generation

AgentCore
  - event bus
  - session router
  - agent logic
  - LLM call
  - memory loader
  - skill registry
  - web admin API

MemoryFiles
  - user/session/topic/project/artifact context

Skills
  - reusable capability packages

DesktopPet Plugin
  - not implemented yet
  - reserved as another channel adapter
```

核心思想：

> AgentCore 只处理标准事件和标准输出；Plugin 负责外部协议；MemoryFiles 负责可读长期上下文；Skills 负责可调用能力。飞书采用 OpenClaw 风格的长连接 Channel Plugin，Codex 采用独立 Worker Plugin，通过 session binding 与飞书会话解耦连接。

