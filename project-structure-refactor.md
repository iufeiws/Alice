# 项目目录结构重构建议

## 1. 最佳实践来源

本建议主要参考以下工程组织原则，而不是单纯按个人偏好重排目录。

### 1.1 DDD / Bounded Context

复杂系统不应把所有业务模型塞进一个全局 `core`，而应按业务边界拆成多个上下文。每个上下文拥有自己的模型、状态、用例和外部依赖接口。

参考：

- Martin Fowler, *Bounded Context*: https://martinfowler.com/bliki/BoundedContext.html

### 1.2 Clean Architecture / Dependency Rule

内层业务规则不应依赖外层实现细节。源码依赖应当指向更稳定、更抽象的内部规则，而不是从领域逻辑直接依赖 HTTP、SQLite、文件系统、第三方 SDK 或具体 runtime。

参考：

- Robert C. Martin, *The Clean Architecture*: https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html

### 1.3 TypeScript Project References

大型 TypeScript 项目适合拆成更小的 project，以改善构建速度、编辑器性能，并强制代码边界。

参考：

- TypeScript Handbook, *Project References*: https://www.typescriptlang.org/docs/handbook/project-references.html

### 1.4 Nx / Enforce Module Boundaries

目录结构只能提示开发者，不能真正阻止乱 import。应使用 ESLint 或 Nx 的 module boundary 规则，限制不同模块之间的依赖关系。

参考：

- Nx, *Enforce Module Boundaries*: https://nx.dev/docs/features/enforce-module-boundaries

### 1.5 模块化 DI / Runtime Composition

复杂 runtime 系统应把 service、repository、client、tool registry、scheduler 等依赖显式装配，而不是在业务代码里直接 new 或直接 import 实现。

参考：

- NestJS, *Providers*: https://docs.nestjs.com/providers

### 1.6 Feature-Sliced Design 的 Public API 和 Isolation 思路

每个模块应通过一个明确的 public API 对外暴露能力。外部模块不应 deep import 内部文件。

参考：

- Feature-Sliced Design: https://feature-sliced.design/

---

## 2. 当前项目的核心问题

当前目录的问题不是“不够细”，而是：

```txt
目录按技术名词分散，但运行时边界没有被强制。
```

因此 Codex 或开发者在修改时看不到清晰的放置规则，会倾向于把新逻辑塞进一个已有文件，形成新的 god file。

重构目标应当是：

```txt
用业务上下文划分 ownership，用 public API 限制访问，用依赖规则约束 import。
```

---

## 3. 模块映射

你的现有模块可以映射为以下 bounded contexts：

| 当前概念 | 建议上下文 |
|---|---|
| 三种 agent loop：chat / talk / memory_organizer | `src/contexts/agent-loop` |
| agent 性格管理 | `src/contexts/agent-profile` |
| 心跳、控制 LLM 响应 chat | `src/contexts/control-plane` |
| 多渠道 chat message 汇总储存器 | `src/contexts/conversation-hub` |
| talk 模式会话管理和储存器 | `src/contexts/talk-session` |
| 记忆文件管理器 | `src/contexts/memory` |
| 大模型会话管理和持久化，内部指针指向文件 | `src/contexts/llm-session` |
| 实际 LLM caller，组装 tool call | `src/contexts/llm-gateway` |
| LLM 主动事件触发器 | `src/contexts/initiative` |

---

## 4. 推荐目录树

```txt
src
├── apps
│   ├── api
│   │   ├── src
│   │   │   ├── main.ts
│   │   │   ├── composition-root
│   │   │   │   ├── api-runtime.ts
│   │   │   │   ├── api-modules.ts
│   │   │   │   └── api-wiring.ts
│   │   │   ├── http
│   │   │   │   ├── admin
│   │   │   │   ├── voice-call
│   │   │   │   ├── middleware
│   │   │   │   └── routes.ts
│   │   │   └── admin-ui
│   │   │       └── shell-order.json
│   │   └── README.md
│   ├── agent-worker
│   ├── scheduler-worker
│   ├── codex-worker
│   └── media-worker
│
├── contexts
│   ├── agent-loop
│   │   ├── src
│   │   │   ├── domain
│   │   │   │   ├── agent-loop-state.ts
│   │   │   │   ├── loop-mode.ts
│   │   │   │   └── agent-events.ts
│   │   │   ├── application
│   │   │   │   ├── run-chat-loop.ts
│   │   │   │   ├── run-talk-loop.ts
│   │   │   │   ├── run-memory-organizer-loop.ts
│   │   │   │   └── agent-loop-coordinator.ts
│   │   │   ├── ports
│   │   │   │   ├── conversation-port.ts
│   │   │   │   ├── talk-session-port.ts
│   │   │   │   ├── memory-port.ts
│   │   │   │   ├── llm-caller-port.ts
│   │   │   │   └── output-port.ts
│   │   │   ├── runtime
│   │   │   │   └── agent-loop-runtime.ts
│   │   │   └── index.ts
│   │   └── README.md
│   │
│   ├── agent-profile
│   │   ├── src
│   │   │   ├── domain
│   │   │   │   ├── persona.ts
│   │   │   │   ├── shell.ts
│   │   │   │   └── prompt-layer.ts
│   │   │   ├── application
│   │   │   │   ├── resolve-agent-profile.ts
│   │   │   │   ├── build-system-prompt.ts
│   │   │   │   └── parse-prompt-layer.ts
│   │   │   ├── adapters
│   │   │   │   ├── json-prompt-profile-store.ts
│   │   │   │   └── file-prompt-storage.ts
│   │   │   ├── runtime
│   │   │   │   └── agent-profile-runtime.ts
│   │   │   └── index.ts
│   │   └── prompts
│   │       ├── prompt-profile.json
│   │       ├── talk-prompt-profile.json
│   │       ├── prompt-api-profile.json
│   │       └── shell-prompt-template.txt
│   │
│   ├── conversation-hub
│   │   ├── src
│   │   │   ├── domain
│   │   │   │   ├── channel-message.ts
│   │   │   │   ├── conversation-thread.ts
│   │   │   │   ├── message-source.ts
│   │   │   │   └── message-timeline.ts
│   │   │   ├── application
│   │   │   │   ├── ingest-channel-message.ts
│   │   │   │   ├── list-conversation-history.ts
│   │   │   │   ├── merge-message-streams.ts
│   │   │   │   └── append-agent-message.ts
│   │   │   ├── ports
│   │   │   │   ├── conversation-store-port.ts
│   │   │   │   └── channel-identity-port.ts
│   │   │   ├── adapters
│   │   │   │   ├── sqlite-conversation-store.ts
│   │   │   │   └── file-log-conversation-store.ts
│   │   │   ├── runtime
│   │   │   │   └── conversation-hub-runtime.ts
│   │   │   └── index.ts
│   │   └── README.md
│   │
│   ├── talk-session
│   │   ├── src
│   │   │   ├── domain
│   │   │   │   ├── talk-session.ts
│   │   │   │   ├── talk-turn.ts
│   │   │   │   └── talk-session-state.ts
│   │   │   ├── application
│   │   │   │   ├── start-talk-session.ts
│   │   │   │   ├── append-talk-turn.ts
│   │   │   │   ├── close-talk-session.ts
│   │   │   │   └── list-talk-history.ts
│   │   │   ├── ports
│   │   │   │   └── talk-session-store-port.ts
│   │   │   ├── adapters
│   │   │   │   ├── sqlite-talk-session-store.ts
│   │   │   │   └── file-talk-session-store.ts
│   │   │   ├── runtime
│   │   │   │   └── talk-session-runtime.ts
│   │   │   └── index.ts
│   │   └── README.md
│   │
│   ├── memory
│   │   ├── src
│   │   │   ├── domain
│   │   │   │   ├── memory-entry.ts
│   │   │   │   ├── memory-file.ts
│   │   │   │   ├── memory-induction.ts
│   │   │   │   └── memory-policy.ts
│   │   │   ├── application
│   │   │   │   ├── read-memory.ts
│   │   │   │   ├── write-memory.ts
│   │   │   │   ├── induce-memory.ts
│   │   │   │   ├── reflect-memory.ts
│   │   │   │   └── organize-memory.ts
│   │   │   ├── ports
│   │   │   │   ├── memory-store-port.ts
│   │   │   │   └── memory-llm-port.ts
│   │   │   ├── adapters
│   │   │   │   ├── file-memory-store.ts
│   │   │   │   └── diary-memory-store.ts
│   │   │   ├── runtime
│   │   │   │   └── memory-runtime.ts
│   │   │   └── index.ts
│   │   └── prompts
│   │       ├── memorize-prompts.json
│   │       └── memory-induction-prompts.json
│   │
│   ├── llm-session
│   │   ├── src
│   │   │   ├── domain
│   │   │   │   ├── llm-session.ts
│   │   │   │   ├── llm-session-pointer.ts
│   │   │   │   ├── llm-session-archive.ts
│   │   │   │   └── llm-session-view.ts
│   │   │   ├── application
│   │   │   │   ├── create-llm-session.ts
│   │   │   │   ├── append-llm-record.ts
│   │   │   │   ├── archive-llm-session.ts
│   │   │   │   └── list-llm-sessions.ts
│   │   │   ├── ports
│   │   │   │   ├── llm-session-index-port.ts
│   │   │   │   └── llm-session-file-port.ts
│   │   │   ├── adapters
│   │   │   │   ├── sqlite-llm-session-index.ts
│   │   │   │   └── file-llm-session-store.ts
│   │   │   ├── runtime
│   │   │   │   └── llm-session-runtime.ts
│   │   │   └── index.ts
│   │   └── README.md
│   │
│   ├── llm-gateway
│   │   ├── src
│   │   │   ├── domain
│   │   │   │   ├── llm-request.ts
│   │   │   │   ├── llm-response.ts
│   │   │   │   ├── llm-tool-call.ts
│   │   │   │   ├── token-usage.ts
│   │   │   │   └── llm-model-profile.ts
│   │   │   ├── application
│   │   │   │   ├── call-llm.ts
│   │   │   │   ├── build-llm-request.ts
│   │   │   │   ├── run-tool-loop.ts
│   │   │   │   ├── preview-llm-request.ts
│   │   │   │   └── diff-llm-request.ts
│   │   │   ├── ports
│   │   │   │   ├── model-client-port.ts
│   │   │   │   ├── tool-registry-port.ts
│   │   │   │   ├── token-usage-store-port.ts
│   │   │   │   └── llm-log-port.ts
│   │   │   ├── adapters
│   │   │   │   ├── openai-model-client.ts
│   │   │   │   ├── file-llm-log.ts
│   │   │   │   └── sqlite-token-usage-store.ts
│   │   │   ├── runtime
│   │   │   │   └── llm-gateway-runtime.ts
│   │   │   └── index.ts
│   │   └── README.md
│   │
│   ├── control-plane
│   │   ├── src
│   │   │   ├── domain
│   │   │   │   ├── heartbeat.ts
│   │   │   │   ├── agent-control-state.ts
│   │   │   │   ├── response-gate.ts
│   │   │   │   └── shutdown-state.ts
│   │   │   ├── application
│   │   │   │   ├── tick-heartbeat.ts
│   │   │   │   ├── pause-agent.ts
│   │   │   │   ├── resume-agent.ts
│   │   │   │   ├── gate-chat-response.ts
│   │   │   │   └── shutdown-runtime.ts
│   │   │   ├── ports
│   │   │   │   ├── runtime-state-port.ts
│   │   │   │   └── lifecycle-port.ts
│   │   │   ├── runtime
│   │   │   │   └── control-plane-runtime.ts
│   │   │   └── index.ts
│   │   └── README.md
│   │
│   └── initiative
│       ├── src
│       │   ├── domain
│       │   │   ├── initiative-event.ts
│       │   │   ├── trigger-rule.ts
│       │   │   ├── initiated-behavior.ts
│       │   │   └── initiative-schedule.ts
│       │   ├── application
│       │   │   ├── evaluate-triggers.ts
│       │   │   ├── enqueue-initiative.ts
│       │   │   ├── run-initiated-behavior.ts
│       │   │   └── suppress-initiative.ts
│       │   ├── ports
│       │   │   ├── scheduler-port.ts
│       │   │   ├── memory-port.ts
│       │   │   ├── conversation-port.ts
│       │   │   └── outbound-notice-port.ts
│       │   ├── adapters
│       │   │   └── json-initiated-behavior-store.ts
│       │   ├── runtime
│       │   │   └── initiative-runtime.ts
│       │   └── index.ts
│       ├── behaviors
│       │   ├── care.json
│       │   ├── idle_check_in.json
│       │   ├── invite.json
│       │   ├── memory_reflection.json
│       │   ├── real_world_suggestion.json
│       │   ├── review.json
│       │   ├── ritual.json
│       │   ├── share.json
│       │   ├── sleep_force_wake.json
│       │   ├── sleep_goodnight.json
│       │   ├── sleep_morning.json
│       │   ├── story.json
│       │   └── topic_followup.json
│       └── README.md
│
├── channels
│   ├── feishu
│   │   ├── src
│   │   │   ├── inbound
│   │   │   ├── outbound
│   │   │   ├── pairing
│   │   │   ├── renderer
│   │   │   ├── runtime
│   │   │   └── index.ts
│   │   └── README.md
│   ├── wechat
│   ├── voice-call
│   ├── webrtc-voice
│   ├── tts
│   └── asr
│
├── capabilities
│   ├── tools
│   │   ├── bookcase
│   │   ├── messaging
│   │   ├── photo
│   │   ├── shell
│   │   └── workspace-files
│   └── skills
│       ├── builtin
│       ├── codex
│       ├── custom
│       ├── external
│       ├── media
│       └── web
│
├── platform
│   ├── config
│   │   ├── src
│   │   │   ├── env.ts
│   │   │   ├── dotenv-loader.ts
│   │   │   ├── token-pricing.ts
│   │   │   └── index.ts
│   ├── storage
│   │   ├── src
│   │   │   ├── sqlite
│   │   │   ├── file-log
│   │   │   ├── stores
│   │   │   └── index.ts
│   ├── event-bus
│   ├── scheduler
│   ├── output-router
│   ├── text-renderer
│   ├── time
│   ├── observability
│   └── http
│
└── shared
    ├── types
    │   └── src
    │       └── index.ts
    ├── result
    ├── errors
    ├── ids
    └── testing
```

---

### 4.1 预迁移规划

以下按 `当前文件位置 -> 迁移后文件位置` 列出，括号中注明是否合并或拆分。

#### 4.1.1 `agent-loop`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/core/agent/src/chat-loop.ts` | `src/contexts/agent-loop/src/application/run-chat-loop.ts` | 拆分为「会话构建 + 工具执行」两个阶段 |
| `src/core/agent/src/talk-loop.ts` | `src/contexts/agent-loop/src/application/run-talk-loop.ts` | 保留文件名语义，拆分状态更新函数到 `domain` |
| `src/core/agent/src/state.ts` | `src/contexts/agent-loop/src/domain/agent-loop-state.ts` | 拆分模型定义 |
| `src/core/agent/src/agent-state-runtime.ts` | `src/contexts/agent-loop/src/runtime/agent-loop-runtime.ts` | 与 `agent-core-runtime.ts` 协同合并 |
| `src/core/agent/src/agent-core-runtime.ts` | `src/contexts/agent-loop/src/runtime/agent-core-runtime.ts` | 与 `agent-state-runtime` 拆分运行时编排边界 |

#### 4.1.2 `agent-profile`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/core/prompt/prompt-profile.json` | `src/contexts/agent-profile/prompts/prompt-profile.json` | 保留并按 context 管理 |
| `src/core/prompt/talk-prompt-profile.json` | `src/contexts/agent-profile/prompts/talk-prompt-profile.json` | 保留 |
| `src/core/prompt/prompt-api-profile.json` | `src/contexts/agent-profile/prompts/prompt-api-profile.json` | 保留 |
| `src/core/prompt/memorize-prompts.json` | `src/contexts/agent-profile/prompts/memorize-prompts.json` | 保留 |
| `src/core/prompt/memory-induction-prompts.json` | `src/contexts/agent-profile/prompts/memory-induction-prompts.json` | 保留 |
| `src/core/prompt/shell-prompt-template.txt` | `src/contexts/agent-profile/prompts/shell-prompt-template.txt` | 保留 |
| `src/core/agent/src/prompts.ts` | `src/contexts/agent-profile/src/application/build-system-prompt.ts` | 拆分为 profile 解析与 prompt 拼装 |
| `src/core/agent/src/prompt-storage.ts` | `src/contexts/agent-profile/src/adapters/json-prompt-profile-store.ts` | 拆分 store 适配层 |
| `src/core/agent/src/prompt-layer-parser.ts` | `src/contexts/agent-profile/src/domain/prompt-layer.ts` | 拆分 parser 与类型定义 |
| `src/core/agent/src/shells.ts` | `src/contexts/agent-profile/src/domain/shell.ts` | 拆分外观与模板模型 |

#### 4.1.3 `control-plane`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/core/agent/src/api-control-runtime.ts` | `src/contexts/control-plane/src/application/admin-control-runtime.ts` | 拆分 pause/resume 和 shutdown 处理 |
| `src/core/agent/src/message-runtime.ts`（心跳部分） | `src/contexts/control-plane/src/application/heartbeat-control.ts` | 从消息聚合逻辑中拆出 heartbeat 管理 |
| `src/apps/api/routes/admin-routes.ts` | `apps/api/routes/admin-routes.ts` | 仅调用控制面 runtime，不移动 endpoint |
| `src/apps/api/server/api-server-runtime.ts` | `apps/api/server/api-lifecycle-runtime.ts` | 拆分关闭/退场流程 |

#### 4.1.4 `conversation-hub`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/packages/storage/src/sqlite-store.ts` | `src/platform/storage/`（现有）或 `src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.ts`（规划） | 按是否先做平台层中间层决定；最终可拆成 ConversationStore + MessageLogStore |
| `src/packages/storage/src/file-log-store.ts` | `src/contexts/conversation-hub/src/adapters/file-log-store.ts` | 合并到 conversation-hub 存储适配 |
| `src/packages/storage/src/api-storage-runtime.ts` | `src/contexts/conversation-hub/src/application/bootstrap-storage.ts` | 拆分 API 组装与存储对象创建 |
| `src/core/agent/src/message-runtime.ts`（消息聚合/会话列表部分） | `src/contexts/conversation-hub/src/application/ingest-channel-message.ts` | 拆分 message-ingest 与 heartbeat |

#### 4.1.5 `talk-session`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/packages/storage/src/talk-store.ts` | `src/contexts/talk-session/src/adapters/sqlite-talk-session-store.ts` | 拆分 `TalkStore` 的查询与更新接口 |
| `src/core/agent/src/talk-runtime.ts` | `src/contexts/talk-session/src/application/talk-session-runtime.ts` | 拆分 domain/application/runtime |
| `src/core/agent/src/talk-runtime-runtime.ts` | `src/contexts/talk-session/src/runtime/talk-session-runtime.ts` | 保留为组装入口 |

#### 4.1.6 `memory`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/core/agent/src/memory.ts` | `src/contexts/memory/src/`（按职责拆分） | 大拆分：domain、application、ports、adapters |
| `src/core/agent/src/memory-console-runtime.ts` | `src/contexts/memory/src/application/manage-memory-console.ts` | 拆分 session 管理接口 |
| `src/core/agent/src/sleep-memory-induction-runtime.ts` | `src/contexts/memory/src/application/induce-memory.ts` | 合并到记忆归纳用例 |
| `src/core/agent/src/sleep-memory-bridge-runtime.ts` | `src/contexts/memory/src/application/sleep-memory-bridge.ts` | 拆分 bridge 到独立应用服务 |
| `src/core/agent/src/profile-memory-runtime.ts` | `src/contexts/memory/src/application/profile-memory.ts` | 拆分 profile 持久化路径 |

#### 4.1.7 `llm-session`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/core/session/active-llm-session-runtime.ts` | `src/contexts/llm-session/src/application/active-llm-session.ts` | 拆分 active 与历史会话 |
| `src/core/session/admin-llm-session-runtime.ts` | `src/contexts/llm-session/src/application/admin-llm-session.ts` | 管理面逻辑保留独立 |
| `src/core/session/api-session-runtime.ts` | `src/contexts/llm-session/src/application/create-llm-session.ts` | 拆分创建与查询流程 |
| `src/core/session/llm-session-archive.ts` | `src/contexts/llm-session/src/application/archive-llm-session.ts` | 拆分存档和文件路径解析 |
| `src/core/session/llm-session-list-runtime.ts` | `src/contexts/llm-session/src/application/list-llm-sessions.ts` | 保留并重命名 |
| `src/core/session/llm-session-view.ts` | `src/contexts/llm-session/src/application/llm-session-view.ts` | 保留 |
| `src/core/session/llm-session-types.ts` | `src/contexts/llm-session/src/domain/llm-session.ts` | 拆分类型与状态机 |
| `src/core/session/memory-llm-session-runtime.ts` | `src/contexts/memory/src/application/manage-memory-llm-session.ts` | 与 memory-console 相关逻辑可合并在同一 context |
| `src/core/session/llm-session-helpers.ts` | `src/contexts/llm-session/src/domain/llm-session-utils.ts` | 拆分工具函数 |

#### 4.1.8 `llm-gateway`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/core/llm/src/api-llm-runtime.ts` | `src/contexts/llm-gateway/src/adapters/openai-model-client.ts` | 拆分 provider client 与请求适配 |
| `src/core/llm/src/llm-api-profile.ts` | `src/contexts/llm-gateway/src/domain/llm-api-profile.ts` | 保留 profile 模型 |
| `src/core/llm/src/llm-config-runtime.ts` | `src/contexts/llm-gateway/src/application/resolve-llm-config.ts` | 拆分配置解析 |
| `src/core/llm/src/llm-request-shape.ts` | `src/contexts/llm-gateway/src/domain/llm-request.ts` | 重命名并拆分 request type |
| `src/core/llm/src/llm-request-diff.ts` | `src/contexts/llm-gateway/src/application/diff-llm-request.ts` | 保留 |
| `src/core/llm/src/llm-request-preview-runtime.ts` | `src/contexts/llm-gateway/src/application/preview-llm-request.ts` | 拆分为预览服务 |
| `src/core/llm/src/llm-observability-runtime.ts` | `src/contexts/llm-gateway/src/runtime/llm-observability.ts` | 拆分 |
| `src/core/llm/src/llm-log-runtime.ts` | `src/contexts/llm-gateway/src/adapters/token-usage-store.ts` | 与 token usage 日志合并 |
| `src/core/llm/src/token-usage-runtime.ts` | `src/contexts/llm-gateway/src/application/track-token-usage.ts` | 拆分 |
| `src/core/agent/src/llm-requests.ts` | `src/contexts/llm-gateway/src/application/build-llm-tools.ts` | 拆分工具构造和发送 |
| `src/core/agent/src/llm-requests-runtime.ts` | `src/contexts/llm-gateway/src/application/call-llm.ts` | 拆分重试与日志策略 |
| `src/core/agent/src/llm-tool-loop.ts` | `src/contexts/llm-gateway/src/application/run-tool-loop.ts` | 拆分循环策略与执行器 |

#### 4.1.9 `initiative`

| 当前文件位置 | 迁移后文件位置 | 合并 / 拆分 |
|---|---|---|
| `src/core/agent/src/initiated-behavior-runtime.ts` | `src/contexts/initiative/src/application/evaluate-triggers.ts` | 拆分 trigger 与执行 |
| `src/core/agent/src/initiated-behavior-config.ts` | `src/contexts/initiative/src/adapters/json-initiated-behavior-store.ts` | 运行时配置与持久化分离 |
| `src/core/agent/src/initiated-behaviors.ts` | `src/contexts/initiative/src/application/run-initiated-behavior.ts` | 拆分规则与运行逻辑 |
| `src/core/agent/src/api-behavior-runtime.ts` | `src/contexts/initiative/src/application/api-initiated-behavior.ts` | 合并 api 行为分支 |
| `src/core/agent/src/initiated-behaviors.ts`（行为运行时 prompt 解析） | `src/contexts/initiative/src/domain/initiated-behavior.ts` | 拆分领域模型 |
| `src/core/prompt/initiated-behaviors/*.json` | `src/contexts/initiative/behaviors/*.json` | 迁移配置目录到 context 内 |

## 5. 一级目录职责

### 5.1 `apps/`

只放启动入口和装配。

允许放：

```txt
HTTP server
routes
middleware
admin page
composition root
runtime wiring
process lifecycle
```

不允许放：

```txt
业务规则
LLM request 拼装
memory 读写策略
conversation merge 逻辑
具体 agent loop 状态机
```

正确定位：

```txt
apps/api 负责把系统启动起来，但不拥有系统业务逻辑。
```

---

### 5.2 `src/contexts/`

系统核心。每个 context 是一个业务边界。

每个 context 内部统一使用：

```txt
src
├── domain
├── application
├── ports
├── adapters
├── runtime
├── contracts
└── index.ts
```

不是所有 context 都必须有所有目录，但目录语义必须稳定。

---

### 5.3 `channels/`

只放外部通道适配器。

例如：

```txt
feishu
wechat
voice-call
webrtc-voice
tts
asr
```

负责：

```txt
第三方 API client
webhook 接收
签名验证
消息格式转换
渠道身份绑定
入站消息转 conversation-hub command
出站消息渲染和发送
```

不应该直接调用：

```txt
llm-gateway
memory
agent-loop 内部文件
```

推荐链路：

```txt
Feishu webhook
  -> channels/feishu
  -> src/contexts/conversation-hub.ingestChannelMessage()
  -> src/contexts/agent-loop.runChatLoop()
  -> src/contexts/llm-gateway.callLlm()
  -> platform/output-router
  -> channels/feishu.outbound
```

---

### 5.4 `capabilities/`

放工具和技能，不放 agent 主流程。

```txt
capabilities/tools
capabilities/skills
```

这些能力通过 `llm-gateway` 的 `ToolRegistryPort` 被调用。

规则：

```txt
工具可以实现能力，但不能控制 agent loop。
技能可以提供 prompt / 外部执行能力，但不能持有主状态。
```

---

### 5.5 `platform/`

放基础设施能力。

```txt
config
storage
event-bus
scheduler
output-router
text-renderer
time
observability
http
```

`platform` 是技术层，不表达业务语义。

例如：

```txt
platform/storage/sqlite
platform/storage/file-log
platform/scheduler
platform/event-bus
```

---

### 5.6 `shared/`

只放真正无业务含义的东西。

允许放：

```txt
Result
AppError
BrandId
Uuid
Clock type
test helpers
通用类型工具
```

不应该放：

```txt
ConversationMessage
MemoryEntry
TalkSession
AgentLoopState
LlmSessionPointer
```

这些属于各自 context。

---

## 6. Context 内部目录约定

### 6.1 `domain/`

放纯模型、状态机、值对象、领域事件。

例如：

```txt
AgentLoopState
ConversationThread
TalkSession
MemoryEntry
LlmSessionPointer
InitiativeTrigger
```

不能放：

```txt
SQLite
HTTP request
OpenAI SDK
Express / Fastify
文件路径
环境变量
```

---

### 6.2 `application/`

放 use case 和业务编排。

例如：

```txt
runChatLoop.ts
runTalkLoop.ts
organizeMemory.ts
callLlm.ts
ingestChannelMessage.ts
appendTalkTurn.ts
evaluateInitiativeTriggers.ts
```

application 可以依赖：

```txt
domain
ports
contracts
```

不应直接依赖：

```txt
adapters
apps
channels
platform 的具体实现
```

---

### 6.3 `ports/`

放接口。接口由 context 定义，实现由 adapter 提供。

示例：

```ts
export interface ConversationStorePort {
  append(message: ChannelMessage): Promise<void>
  listHistory(threadId: ThreadId): Promise<ConversationThread>
}
```

---

### 6.4 `adapters/`

放 ports 的具体实现。

例如：

```txt
sqlite-conversation-store.ts
file-memory-store.ts
openai-model-client.ts
feishu-outbound-adapter.ts
```

adapter 可以依赖：

```txt
SQLite
文件系统
第三方 SDK
HTTP client
环境变量读取结果
```

---

### 6.5 `runtime/`

放依赖装配、生命周期、启动停止。

示例：

```ts
export function createConversationHubRuntime(deps: {
  store: ConversationStorePort
  clock: Clock
  eventBus: EventBus
}) {
  return {
    ingestChannelMessage: makeIngestChannelMessage(deps),
    listConversationHistory: makeListConversationHistory(deps),
  }
}
```

---

### 6.6 `contracts/`

放对其他 context 公开的 command / query / event / DTO。

例如：

```txt
IngestChannelMessageCommand
ConversationHistoryQuery
ConversationMessageDTO
ConversationAppendedEvent
```

注意：

```txt
contracts 是对外契约，不是内部 domain model 的垃圾桶。
```

---

### 6.7 `index.ts`

每个 context 的唯一 public API。

允许：

```ts
import { createConversationHubRuntime } from '@contexts/conversation-hub'
```

禁止：

```ts
import { SqliteConversationStore } from '@contexts/conversation-hub/src/adapters/sqlite-conversation-store'
```

---

## 7. 依赖方向规则

建议使用以下依赖方向：

```txt
apps
  -> contexts
  -> platform
  -> shared

channels
  -> src/contexts/conversation-hub contracts
  -> platform
  -> shared

capabilities/tools
  -> context ports only
  -> platform
  -> shared

contexts/*
  -> own domain/application/ports/contracts
  -> other context public contracts only
  -> shared

platform
  -> shared only

shared
  -> no project dependency
```

重点限制：

```txt
agent-loop 可以依赖 llm-gateway 的 public API
agent-loop 可以依赖 conversation-hub 的 public API
agent-loop 可以依赖 memory 的 public API
agent-loop 不可以依赖 conversation-hub/adapters/sqlite-xxx
agent-loop 不可以依赖 channels/feishu
llm-gateway 不可以依赖 agent-loop
memory 不可以依赖 agent-loop
channels 不可以直接依赖 llm-gateway
```

---

## 8. 防止 Codex 写 god file 的工程约束

### 8.1 每个 context 必须有 README

模板：

```md
# Context Name

## Owns

本模块拥有的状态和职责。

## Does not own

本模块明确不负责的东西。

## Public API

只允许从 `src/index.ts` 导出。

## Dependency rules

允许依赖哪些模块，禁止依赖哪些模块。

## File placement

- `domain/`: 纯模型、值对象、状态机、领域事件
- `application/`: use case、业务编排
- `ports/`: 外部依赖接口
- `adapters/`: 具体实现
- `runtime/`: DI 装配和生命周期
- `contracts/`: 对外 command / query / event / DTO
```

---

### 8.2 禁止 deep import

禁止：

```ts
import { something } from '@contexts/memory/src/application/write-memory'
```

允许：

```ts
import { writeMemory } from '@contexts/memory'
```

---

### 8.3 使用 TypeScript Project References

每个 context 单独建 `tsconfig.json`，根目录用 `tsconfig.build.json` 引用。

示例：

```json
{
  "files": [],
  "references": [
    { "path": "./src/contexts/conversation-hub" },
    { "path": "./src/contexts/llm-gateway" },
    { "path": "./src/contexts/memory" },
    { "path": "./src/contexts/agent-loop" }
  ]
}
```

---

### 8.4 使用 Nx 或 ESLint boundary rule

建议打标签：

```txt
type:app
type:context
type:channel
type:capability
type:platform
type:shared

scope:agent
scope:memory
scope:llm
scope:conversation
scope:talk
scope:initiative
```

约束示例：

```txt
type:context 不能依赖 type:app
type:platform 不能依赖 type:context
type:shared 不能依赖任何内部模块
type:channel 不能依赖 llm-gateway
type:capability 不能依赖 agent-loop
```

---

### 8.5 Codex 指令建议

可以放进项目根目录的 `AGENTS.md` 或类似文件：

```md
# Repository Architecture Rules

When adding or modifying code:

1. Do not create god files.
2. Use existing context boundaries.
3. Pure state, value objects, and rules go to `domain/`.
4. Use cases and orchestration go to `application/`.
5. External SDK, SQLite, fs, HTTP, and third-party integrations go to `adapters/`.
6. Interfaces for external dependencies go to `ports/`.
7. Dependency wiring and lifecycle code go to `runtime/`.
8. Cross-context DTOs, commands, queries, and events go to `contracts/`.
9. Export only through each module's `src/index.ts`.
10. Never deep-import another context's `src/` directory.
11. Channels may ingest and emit messages, but must not call `llm-gateway` directly.
12. `agent-loop` orchestrates. It must not own storage, prompt files, tool implementations, or channel adapters.
13. `llm-gateway` performs LLM calls and tool-call loops. It must not know about Feishu, WeChat, talk UI, or HTTP routes.
14. `memory` owns memory files and memory induction logic. Other modules request memory through its public API or ports.
```

---

## 9. 迁移顺序

不要一次性全搬。建议按风险最低的顺序迁移：

```txt
1. 建 src/contexts/conversation-hub
2. 迁移所有 chat message 汇总、读取、存储逻辑
3. 建 src/contexts/llm-gateway
4. 迁移 LLM call、tool loop、request preview、token usage
5. 建 src/contexts/llm-session
6. 迁移大模型会话指针、归档、查看逻辑
7. 建 src/contexts/memory
8. 迁移 memory 文件、induction、reflection、organizer
9. 建 src/contexts/agent-loop
10. 只保留 chat / talk / memory_organizer 三个 loop 的编排
11. 建 src/contexts/initiative
12. 迁移主动触发行为
13. 最后清理 channels、platform、apps
```

核心原则：

```txt
先迁移数据来源模块
再迁移 LLM 调用模块
最后迁移 agent 编排模块
```

否则 `agent-loop` 会继续膨胀成新的 god module。

---

## 10. 最终判断

推荐结构的核心不是目录命名，而是 ownership：

```txt
conversation-hub owns 多渠道消息汇总

talk-session owns talk 会话状态和历史

memory owns 记忆文件和记忆整理

llm-session owns 大模型会话记录和指针

llm-gateway owns LLM request、tool call、token usage、模型 client

agent-profile owns persona、shell、prompt profile

control-plane owns heartbeat、pause/resume、response gate

initiative owns 主动触发和 initiated behaviors

agent-loop owns 编排，不拥有具体存储和外部通道
```

这能让 Codex 在修改时更容易判断：

```txt
这段代码属于哪个上下文？
是 domain、application、port、adapter，还是 runtime？
是否需要通过 public API 暴露？
是否违反依赖方向？
```

只要这四个问题有明确答案，代码就不容易继续堆进单文件。


## 10. 迁移要求
基于9迁移顺序和4.1预迁移规划, 依次迁移, 迁移过程中使用git mv, 每完成一个context进行一次build和test, 通过后push github, 然后进行下一个context
