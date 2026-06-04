# TalkRuntime

`TalkRuntime` 是 Core 侧实时对话流的入站入口。它和 `MessageRuntime` 属于同一层级的运行时概念，但处理的交互形态不同：`MessageRuntime` 面向离散聊天消息，允许去抖、pending session 和 heartbeat 批处理；`TalkRuntime` 面向语音优先、低延迟、连续会话的实时对话。

首版只规定入站契约。出站音频流、实时 TTS、文本增量、打断回执和最终落库规则后续再定义。

## 边界

- 实时平台插件：负责平台私有连接、鉴权、音频采集、ASR 或文本流接收，但必须把入站实时事件转换为统一的 `TalkInputEvent`。
- `TalkRuntime`：负责接收实时会话入站事件、按会话保序、去重、更新实时上下文，并把稳定语义输入交给 Core。
- `MessageRuntime`：继续负责聊天平台离散消息，包括消息落库、去抖、pending 恢复、LLM 工具读取和出站发送。
- 两个 Runtime 不互相替代。实时对话产生的最终文字记录可以在后续设计中写入 `messages`，但实时音频帧和转写增量不应直接当作普通聊天消息处理。

## 入站接口草案

待实现：把实时对话入站抽成显式公共接口，例如：

```ts
export type TalkRuntimeIngress = {
  openSession(input: TalkSessionOpenInput): Promise<void> | void;
  ingestInput(event: TalkInputEvent): Promise<void> | void;
  closeSession(input: TalkSessionCloseInput): Promise<void> | void;
};
```

平台插件依赖应统一注入 `talkRuntime: TalkRuntimeIngress`，而不是直接调用 Core 或写入聊天消息表。

## 会话标识

实时对话以 `sessionId` 作为 Core 侧稳定会话 id。同一段实时通话、语音房间或连续对话必须始终使用同一个 `sessionId`。

`sessionId` 不要求等于 `MessageRuntime` 的 `session.sessionId`，但如果实时对话来自已有聊天平台会话，应能通过 `source.plugin`、`source.channelId`、`source.userId` 或后续映射字段追溯到原始平台上下文。

## 入站事件类型

`TalkRuntime` 首版支持以下入站事件语义：

| kind | 含义 | 稳定性 | 触发 Core |
| --- | --- | --- | --- |
| `session.started` | 实时会话开始 | 稳定 | 否 |
| `audio.frame` | 音频帧或音频片段 | 临时输入 | 否，除非后续接入流式模型 |
| `audio.transcript.delta` | ASR 转写增量 | 临时输入 | 否 |
| `audio.transcript.final` | ASR 最终转写片段 | 稳定语义输入 | 是 |
| `text.delta` | 文本输入增量 | 临时输入 | 否 |
| `text.final` | 文本输入最终片段 | 稳定语义输入 | 是 |
| `input.interrupted` | 用户打断当前响应或会话状态 | 稳定控制事件 | 是，按控制事件处理 |
| `session.ended` | 实时会话结束 | 稳定 | 可选，按收尾事件处理 |

## 入站事件字段

每个 `TalkInputEvent` 必须包含：

- `kind`：事件类型。
- `sessionId`：Core 侧实时会话 id。
- `source.plugin`：平台 id，例如 `voice`、`desktop`、`feishu`、`wechat` 或新增实时平台 id。
- `source.accountId`：多账号平台的账号 id；无多账号时可省略或使用 `main`。
- `source.channelId`：平台会话、通话、房间、频道或可追溯目标 id。
- `source.userId`：说话人或输入者 id。
- `sequence`：同一 `sessionId` 内单调递增的入站序号，用于保序和去重。
- `occurredAt`：本地时区时间。
- `occurredAtUtc`：UTC 时间，建议必填。
- `payload`：与 `kind` 对应的输入内容。
- `raw`：原始平台事件或帧 metadata，供调试和后台查看。

字段草案：

```ts
export type TalkInputEvent = {
  kind:
    | "session.started"
    | "audio.frame"
    | "audio.transcript.delta"
    | "audio.transcript.final"
    | "text.delta"
    | "text.final"
    | "input.interrupted"
    | "session.ended";
  sessionId: string;
  source: {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
  };
  sequence: number;
  occurredAt: string;
  occurredAtUtc?: string;
  payload: TalkInputPayload;
  raw?: unknown;
};
```

## Payload 草案

`payload` 必须和 `kind` 匹配：

```ts
export type TalkInputPayload =
  | {
      kind: "session";
      language?: string;
      sampleRate?: number;
      format?: string;
    }
  | {
      kind: "audio";
      chunkId: string;
      encoding: string;
      sampleRate: number;
      durationMs?: number;
      dataRef: string;
    }
  | {
      kind: "transcript";
      text: string;
      language?: string;
      confidence?: number;
      segmentId?: string;
    }
  | {
      kind: "text";
      text: string;
      segmentId?: string;
    }
  | {
      kind: "interrupt";
      reason?: "barge_in" | "manual" | "network" | "unknown";
      targetOutputId?: string;
    };
```

其中：

- `audio.frame` 使用 `payload.kind === "audio"`。
- `audio.transcript.delta` 和 `audio.transcript.final` 使用 `payload.kind === "transcript"`。
- `text.delta` 和 `text.final` 使用 `payload.kind === "text"`。
- `input.interrupted` 使用 `payload.kind === "interrupt"`。
- `session.started` / `session.ended` 使用 `payload.kind === "session"`。

## 入站处理原则

`TalkRuntime.ingestInput()` 必须遵守：

1. 按 `sessionId + sequence` 保序和去重。重复事件不得重复触发 Core。
2. `audio.frame` 是低延迟输入片段，不直接等同于可持久化聊天消息。
3. `audio.transcript.delta` 只用于实时上下文更新，不作为最终历史事实。
4. `audio.transcript.final` 是稳定语义输入，可以触发 Core，并可在后续设计中转为可追溯会话记录。
5. `text.delta` 只用于实时输入预览或上下文补全，不触发普通回复。
6. `text.final` 是稳定语义输入，可以触发 Core。
7. `input.interrupted` 表示用户打断当前响应或会话状态，不能被当作普通文本消息。
8. `session.ended` 表示实时会话结束，可以触发收尾、摘要或资源释放，但不能假设一定有用户文本输入。

## SQLite 存储形式

`TalkRuntime` 使用独立 SQLite 表保存实时会话，不直接复用 `messages` / `message_logs`。实时对话的存储分三层：

- `talk_sessions`：保存每段实时会话的当前状态。
- `talk_events`：保存追加式入站事件日志，用于保序、去重和调试。
- `talk_segments`：保存稳定语义片段，例如最终转写、最终文本和打断控制事件。

### `talk_sessions`

`talk_sessions` 是实时会话索引表：

```sql
CREATE TABLE IF NOT EXISTS talk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  plugin TEXT NOT NULL,
  account_id TEXT,
  channel_id TEXT,
  user_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_at_utc TEXT,
  ended_at TEXT,
  ended_at_utc TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT NOT NULL,
  last_event_at_utc TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS talk_sessions_plugin_channel_idx
  ON talk_sessions(plugin, channel_id);

CREATE INDEX IF NOT EXISTS talk_sessions_status_idx
  ON talk_sessions(status, last_event_at);
```

字段含义：

- `session_id` 对应 `TalkInputEvent.sessionId`。
- `plugin` / `account_id` / `channel_id` / `user_id` 来自 `source`。
- `status` 可为 `open`、`closing`、`closed`、`failed`。
- `last_sequence` 保存已接收的最大入站序号，用于快速判断乱序和重复。
- `metadata_json` 保存语言、采样率、平台房间信息等会话级扩展字段。

### `talk_events`

`talk_events` 是所有实时入站事件的追加式日志：

```sql
CREATE TABLE IF NOT EXISTS talk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  occurred_at_utc TEXT,
  payload_kind TEXT NOT NULL,
  payload_text TEXT,
  payload_json TEXT,
  raw_json TEXT,
  processed_at TEXT,
  error TEXT,
  UNIQUE(session_id, sequence)
);

CREATE INDEX IF NOT EXISTS talk_events_session_id_idx
  ON talk_events(session_id, id);

CREATE INDEX IF NOT EXISTS talk_events_kind_idx
  ON talk_events(kind, occurred_at);
```

写入规则：

- 每次 `ingestInput(event)` 先尝试插入 `talk_events`。
- `UNIQUE(session_id, sequence)` 命中时视为重复事件，不重复触发 Core。
- `payload_json` 保存结构化 payload；`payload_text` 只保存可读文本摘要。
- `audio.frame` 不把音频二进制写入 SQLite，只保存 `dataRef`、编码、采样率、时长等 metadata。
- `processed_at` 表示该事件已完成 Runtime 侧处理，不等同于 Core 已消费。

### `talk_segments`

`talk_segments` 保存可作为事实历史使用的稳定片段：

```sql
CREATE TABLE IF NOT EXISTS talk_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_id INTEGER,
  segment_id TEXT,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_json TEXT,
  started_at TEXT,
  started_at_utc TEXT,
  ended_at TEXT NOT NULL,
  ended_at_utc TEXT,
  core_processed_at TEXT,
  core_batch_id TEXT,
  UNIQUE(session_id, segment_id)
);

CREATE INDEX IF NOT EXISTS talk_segments_session_id_idx
  ON talk_segments(session_id, id);

CREATE INDEX IF NOT EXISTS talk_segments_core_pending_idx
  ON talk_segments(core_processed_at, session_id);
```

写入规则：

- `audio.transcript.final` 写入 `role='user'`、`kind='transcript'`。
- `text.final` 写入 `role='user'`、`kind='text'`。
- `input.interrupted` 可以写入 `role='user'`、`kind='interrupt'`，`content_text` 保存简短原因。
- `audio.transcript.delta`、`text.delta` 和普通 `audio.frame` 不写入 `talk_segments`。
- `core_processed_at` / `core_batch_id` 表示该稳定片段是否已经被 Core 消费。

### 和 `messages` 的关系

`talk_segments` 是实时会话的事实来源；`messages` 仍是聊天消息历史的事实来源。两者不要双写同一条临时输入。

后续如果需要让 `check_chat` 或记忆归纳读取实时对话，只应在稳定时机把 `talk_segments` 转换或投影为聊天历史记录，例如会话结束后生成摘要，或把最终用户发言和最终助手回复写入 `messages`。这一步必须保留 `session_id` / `segment_id` 映射，避免重复归纳和重复展示。

## 与 MessageRuntime 的关系

`TalkRuntime` 不调用 `MessageRuntime.ingestEvent()` 来处理音频帧或转写增量。实时流中的临时输入和普通聊天消息的生命周期不同，不能混用 `messages.coreProcessedAt`、pending set 或 heartbeat 去抖逻辑。

后续如果需要把实时对话写入聊天历史，应只写入稳定片段，例如：

- `audio.transcript.final` 形成的用户发言。
- `text.final` 形成的用户发言。
- `session.ended` 触发的会话摘要。
- 实时出站完成后的最终助手回复。

这些记录是否写入 `messages`、写入哪个 `plugin` / `conversationId`、如何和实时 `sessionId` 映射，属于后续持久化设计。

## 出站待定

首版不定义出站接口。后续需要单独规定：

- 实时 TTS 如何接收 Core 文本或语义输出。
- 音频流出站事件如何表示、分片、确认和取消。
- 文本 delta 如何展示给实时客户端。
- `input.interrupted` 如何取消正在合成或播放的出站内容。
- 最终出站内容如何落库，并如何和实时入站片段关联。

## 新实时平台接入要求

新增实时平台时，平台插件只需要对接入站契约：

1. 为每段实时会话生成稳定 `sessionId`。
2. 调用 `TalkRuntimeIngress.openSession()` 开始会话。
3. 将平台音频帧、ASR 转写、文本流和打断事件转换为 `TalkInputEvent`。
4. 调用 `TalkRuntimeIngress.ingestInput(event)` 传入实时事件。
5. 调用 `TalkRuntimeIngress.closeSession()` 结束会话。
6. 保证同一 `sessionId` 内 `sequence` 单调递增、可用于去重。
7. 不直接写 `messages` / `message_logs`，不绕过 `TalkRuntime` 调用 Core。
