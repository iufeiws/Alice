# Talk Loop Demo 实现流程

本文描述首个可运行 Talk Loop demo 的端到端实现方式。目标是先打通实时语音对话闭环：LLM 流式生成内容，TalkRuntime 缓冲并切分为可播放文本，voice call 插件拉取文本送入 TTS 播放；用户打断后，TalkRuntime 记录断点并用最终转录文本启动下一轮 LLM。

## 高层流程

### LLM -> user

```text
点击 Call
  -> voice call 显示/广播等待接通
  -> voice call 调用 TalkRuntime.openSession
  -> TalkRuntime 发起 TalkAgentLoop
  -> TalkAgentLoop 使用 talk prompt profile，并允许首轮工具调用
LLM stream
  -> TalkRuntime output buffer
  -> 按特殊字符切 chunk，保留切分字符
  -> ready buffer 满 12 字符后可被获取
  -> voice call 空闲轮询 claim chunk
  -> TTS
  -> 拿到第一条可播放语音后提示接通
  -> 延迟 1 秒
  -> playback queue
  -> WebRTC outbound audio
```

执行规则：

- 点击 Call 后，voice call 必须先进入等待接通状态，并立即向 TalkRuntime open session。
- TalkRuntime open session 后只在 runtime 空闲时启动 TalkAgentLoop；TalkAgentLoop 调用 LLM 时使用 `agentId: "talk"`。
- TalkAgentLoop 的自动循环触发点是 TalkRuntime 空闲，也就是当前 session 没有 streaming output、未 flush buffer、ready chunk 或 claimed chunk；不是上一轮 LLM 请求结束。
- TalkAgentLoop 使用 `talkPromptProfileStore` 对应的 talk prompt profile，不使用 chat prompt profile。
- TalkAgentLoop 的 LLM request/response 必须像 chat 一样写入 active LLM session，使 admin 的 Active Session 能看到 talk 轮次。
- 首轮 TalkAgentLoop 仍允许执行 profile 中可见工具；工具结果回灌后继续 LLM 轮次，最终 assistant 内容才进入 TalkRuntime 输出缓冲。
- LLM 的 `content delta` 不经过 `send_chat`，而是写入 `TalkRuntime.appendAssistantDelta()`。
- TalkRuntime 维护当前 assistant output 的完整文本、未切分缓冲区和已 ready chunk。
- chunk 切分以标点、符号、空白等特殊字符为边界，边界字符保留在前一个 chunk 内。
- ready buffer 累计达到 12 个字符后，`voice call` 可以通过 `claimReadyOutputChunk()` 获取。
- LLM 输出结束时调用 `finishAssistantOutput()`，剩余不足 12 字符的尾部也要 flush 为可获取 chunk。
- `voice call` 在没有 TTS 处理任务时持续轮询 TalkRuntime，拿到 chunk 后送入 TTS，并把 TTS 结果放入播放队列。
- chunk 被 TTS 播放完成后，voice call 必须回写 chunk `played`；只有所有可播放缓存都清空后，TalkRuntime 才能发起下一轮 TalkAgentLoop。
- voice call 发送 TTS 前可以按配置过滤括号内容。默认开启时，`(xxx)` 和 `（xxx）` 中的内容不发送给 TTS，但 TalkRuntime 中的原始 assistant 文本不被改写。
- voice call 拿到第一条可播放语音后才提示接通；提示接通后延迟 1 秒再开始播放，避免接通瞬间吞音。

### user -> LLM

```text
barge-in signal
  -> voice call 去抖 1 秒
  -> 根据已播放时长 / 总时长估算文本断点
  -> TalkRuntime interruptOutput
  -> 取消当前 LLM 输出和播放队列
  -> 等待 voice call 返回最终 ASR 文本
  -> TalkRuntime 写入 user final segment
  -> TalkAgentLoop 使用 assistant 已保留文本 + 断点语义表示符 + user 文本启动下一轮
```

执行规则：

- voice call 播放每段 TTS 时记录 `outputId`、文本长度、总播放时长和当前已播放时长。
- 打断信号必须持续 1 秒才算真正打断；短于 1 秒的语音活动只作为噪声或误触处理。
- 打断确认后，voice call 使用 `floor(elapsedMs / totalMs * outputText.length)` 估算断点字符位置。
- TalkRuntime 收到打断后，立即标记当前 assistant output 为 interrupted；主内容只保留断点前文本，断点及之后的内容从内容表移除并写入断点舍弃表。
- TalkRuntime 通知或取消当前 TalkAgentLoop 输出；voice call 清空当前播放队列并停止继续播放已废弃 chunk。
- TalkRuntime 等待 voice call 返回最终 ASR 文本。
- 最终转录到达后，TalkRuntime 写入稳定 user segment，并构造下一轮上下文。断点不是字面文本 `"[断点]"`，而是运行时断点语义；当需要投喂给当前 LLM message schema 时，默认渲染为 `...`：

```text
assistant.content: xxxx...
user: xxxxx
```

其中 `...` 是默认断点语义表示符，可配置；它表示“这里发生过用户打断”，不是 assistant 原始输出文本的一部分，也不能写入断点前真实内容。

## 模块边界

### TalkRuntime

TalkRuntime 是实时对话的事实来源，负责：

- SQLite 会话、事件和稳定片段写入。
- assistant 流式输出的完整文本、缓冲区、ready chunk 和 claimed chunk 状态。
- `sessionId + sequence` 的入站去重和保序。
- 打断事件处理、断点保存、断点及之后内容从主内容移除并转存舍弃表。
- 最终用户转录写入后，组装下一轮 TalkAgentLoop messages。
- 关闭会话时释放未完成输出，并保存可审计的 session 状态。

TalkRuntime 不负责：

- WebRTC 连接。
- ASR 供应商协议。
- TTS 合成。
- 音频播放进度采样。
- 写入 `messages` 或调用 MessageRuntime。

### TalkAgentLoop

TalkAgentLoop 负责实时对话的 LLM 循环策略：

- 使用独立 talk prompt profile 和 `agentId: "talk"`。
- 从 TalkRuntime 读取当前会话的稳定上下文。
- 发起 LLM 流式请求。
- 将 LLM 文本 delta 写入 TalkRuntime。
- 在输出完成、被打断、会话关闭或取消时结束当前 turn。
- 如果没有打断且会话仍打开，可以继续下一轮 LLM 访问，直到运行时策略要求停止。

TalkAgentLoop 不通过 `send_chat` 输出实时语音内容。`send_chat` 保持聊天消息工具语义，不承担 TalkRuntime 的实时出站职责。

### webrtc_voice

`webrtc_voice` 负责平台和音频侧行为：

- 创建 call 时打开 TalkRuntime session。
- 创建 call 前先执行 ASR preflight。preflight 使用配置中的测试音频确认 ASR provider 可用；失败时不建立 WebRTC call，不 open TalkRuntime session。
- 将 ASR final result 转换为 `audio.transcript.final` 输入事件。
- 在 TTS 空闲时轮询 TalkRuntime 的 ready chunk。
- 把 chunk 送入现有 TTS 流程，并把音频帧放入播放队列。
- 播放时记录总时长、已播放时长、当前 outputId 和 outputText。
- 对用户语音活动做 1 秒 barge-in 去抖。
- 打断确认后估算断点，并调用 TalkRuntime 的打断接口。
- hangup 时关闭 TalkRuntime session。
- 点击挂断后，voice call 必须向 TalkRuntime 发起 close session；关闭后的 session 不再 claim chunk 或播放新 TTS。

### MessageRuntime 和 messages

TalkRuntime demo 不把实时语音事实写入 `messages`，也不调用 `MessageRuntime.ingestEvent()`。实时语音的事实来源是 TalkRuntime 的 SQLite 表。后续如果要让聊天历史或记忆归纳读取实时对话，应在稳定边界做投影或摘要，不能把流式临时输入直接当普通聊天消息。

## SQLite 落地

首版 demo 直接使用 SQLite，不做内存版过渡。

基础表沿用 TalkRuntime 设计：

- `talk_sessions`：会话索引和当前状态。
- `talk_events`：append-only 入站事件日志，使用 `UNIQUE(session_id, sequence)` 去重。
- `talk_segments`：稳定语义片段，包括最终用户转录、文本输入、打断事件和最终 assistant 输出。

demo 还需要补充 assistant output、chunk 和断点舍弃状态。首版建议新增独立表，避免把临时输出状态塞进 `talk_segments.content_json` 后难以 claim 或取消。

### `talk_outputs`

`talk_outputs` 保存一轮 assistant 输出的完整文本和生命周期：

```sql
CREATE TABLE IF NOT EXISTS talk_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  output_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  segment_id TEXT,
  status TEXT NOT NULL,
  full_text TEXT NOT NULL DEFAULT '',
  visible_text TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  started_at_utc TEXT,
  finished_at TEXT,
  finished_at_utc TEXT,
  interrupted_at TEXT,
  interrupted_at_utc TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS talk_outputs_session_idx
  ON talk_outputs(session_id, id);
```

字段规则：

- 未打断时，`full_text` 是 LLM 已生成的完整 assistant 文本。
- 打断后，`full_text` 和 `visible_text` 都必须收缩为断点前文本；断点及之后的内容从 `talk_outputs` 移除，写入 `talk_output_discards`。
- `visible_text` 是用户已经听到或应该进入下一轮上下文的文本。
- `status` 可为 `streaming`、`finished`、`interrupted`、`cancelled`。
- `segment_id` 可指向 `talk_segments.segment_id`，用于把最终 assistant segment 和 output 关联。

### `talk_output_chunks`

`talk_output_chunks` 保存可被 voice call 领取的播放 chunk：

```sql
CREATE TABLE IF NOT EXISTS talk_output_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE,
  output_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_char_index INTEGER NOT NULL,
  end_char_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  ready_at TEXT,
  ready_at_utc TEXT,
  claimed_at TEXT,
  claimed_at_utc TEXT,
  cancelled_at TEXT,
  cancelled_at_utc TEXT,
  playback_started_at TEXT,
  playback_started_at_utc TEXT,
  playback_finished_at TEXT,
  playback_finished_at_utc TEXT,
  metadata_json TEXT,
  UNIQUE(output_id, sequence)
);

CREATE INDEX IF NOT EXISTS talk_output_chunks_claim_idx
  ON talk_output_chunks(session_id, status, id);
```

字段规则：

- `status` 可为 `buffering`、`ready`、`claimed`、`played`、`cancelled`。
- 未打断时，`start_char_index` / `end_char_index` 指向当前 `talk_outputs.full_text` 的字符范围。
- 打断后，超过断点的 chunk 必须取消；它们的字符范围只作为审计信息保留，不能再被当作当前主内容范围。
- `claimReadyOutputChunk()` 只领取 `status='ready'` 的最早 chunk，并原子更新为 `claimed`。
- 打断后，所有未播放的 `ready` 或 `claimed` chunk 都要置为 `cancelled`，防止 TTS 继续播放断点后的内容。

### `talk_output_discards`

`talk_output_discards` 是断点舍弃表，保存被打断位置及之后从主内容表移除的文本。

```sql
CREATE TABLE IF NOT EXISTS talk_output_discards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discard_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  output_id TEXT NOT NULL,
  interrupt_id TEXT NOT NULL,
  breakpoint_char_index INTEGER NOT NULL,
  discarded_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_utc TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS talk_output_discards_session_idx
  ON talk_output_discards(session_id, id);
```

字段规则：

- `breakpoint_char_index` 是相对于原始 output 文本的断点位置。
- `discarded_text` 保存从断点开始到 output 末尾的内容，包括断点位置上的字符及之后全部内容。
- 写入舍弃表后，`talk_outputs.full_text`、`talk_outputs.visible_text` 和 assistant segment 的 `content_text` 都只能保存断点前文本。
- `discarded_text` 不进入下一轮普通 assistant content，也不能被 TTS 继续领取。
- `metadata_json` 保存 voice call 侧的播放 chunk、TTS asset、估算来源等调试信息。

### `talk_output_interrupts`

`talk_output_interrupts` 是断点的事实表。断点不是文本标记，而是指向某个 output 字符位置的结构化指针。

```sql
CREATE TABLE IF NOT EXISTS talk_output_interrupts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interrupt_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  output_id TEXT NOT NULL,
  event_id INTEGER,
  segment_id TEXT,
  reason TEXT NOT NULL,
  breakpoint_char_index INTEGER NOT NULL,
  played_ms INTEGER,
  total_ms INTEGER,
  played_ratio REAL,
  visible_text TEXT NOT NULL,
  discard_id TEXT,
  break_marker TEXT NOT NULL DEFAULT '...',
  created_at TEXT NOT NULL,
  created_at_utc TEXT,
  final_user_segment_id TEXT,
  resolved_at TEXT,
  resolved_at_utc TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS talk_output_interrupts_session_idx
  ON talk_output_interrupts(session_id, id);
```

字段规则：

- `breakpoint_char_index` 是断点指针，表示原始 output 文本中断开的字符位置。
- `visible_text` 等于原始文本的 `slice(0, breakpoint_char_index)`。
- `discard_id` 指向 `talk_output_discards.discard_id`。
- `break_marker` 是给 LLM 上下文使用的断点语义表示符，默认 `...`；它不是 assistant 原始文本。
- `event_id` 指向 `talk_events` 中的 `input.interrupted` 事件。
- `segment_id` 指向 `talk_segments` 中的 interrupt control segment。
- `final_user_segment_id` 在 ASR final 到达后回填，表示这个打断已经被用户最终文本接续。
- `metadata_json` 保存打断估算和运行时调试信息。

`talk_segments` 仍保存稳定语义事实，但断点细节不要只存在 `talk_segments.content_text` 里。建议：

- assistant final segment 的 `content_text` 保存 `visible_text`，即断点前文本。
- assistant final segment 的 `content_json` 保存 `{ outputId, interrupted: true, interruptId, discardId, breakMarker: "..." }`。
- interrupt segment 的 `content_text` 保存简短原因，例如 `barge_in`。
- interrupt segment 的 `content_json` 保存 `{ interruptId, outputId, discardId, breakpointCharIndex, breakMarker }`。

这些表必须满足以下能力：

- 保存当前 assistant output 的完整文本。
- 保存 output 状态：`streaming`、`finished`、`interrupted`、`cancelled`。
- 保存 ready chunk 的 claim 状态，避免同一段文本被多个 TTS 任务重复领取。
- 保存 chunk 与 outputId 的关联，方便打断时定位当前播放文本。
- 保存 interrupted breakpoint、playedMs、totalMs、discarded_text 和默认断点语义表示符 `...`。

临时音频帧不写入 SQLite blob。音频相关数据只保存可追溯 metadata 或 `dataRef`。

## 接口草案

以下接口是 demo 需要新增或补齐的行为级接口。实现时可以根据现有 TypeScript 模块拆成 runtime、store 和 plugin deps，但语义必须保持一致。

### `TalkRuntime.openSession`

打开实时会话，创建或恢复 `talk_sessions` 行，并写入 `session.started` 事件。

关键输入：

- `sessionId`
- `source.plugin`
- `source.accountId`
- `source.channelId`
- `source.userId`
- `occurredAt`
- `occurredAtUtc`
- 会话 metadata，例如语言、采样率、callId

### `TalkRuntime.ingestInput`

接收入站事件，写入 `talk_events`，并按稳定性更新 `talk_segments`。

首版必须支持：

- `audio.transcript.final`
- `text.final`
- `input.interrupted`
- `session.ended`

重复 `sessionId + sequence` 事件不得重复触发下一轮 LLM。

### `TalkRuntime.appendAssistantDelta`

接收 LLM 文本 delta，追加到当前 assistant output：

- 更新完整 output text。
- 更新未切分 buffer。
- 按特殊字符产生 chunk。
- 当 ready buffer 达到 12 字符后标记为可 claim。
- 如果会话已经被打断或关闭，拒绝继续追加。

### `TalkRuntime.finishAssistantOutput`

标记当前 assistant output 完成：

- flush 剩余不足 12 字符的文本。
- 写入或更新 `talk_segments` 中的 assistant final segment。
- 将 output 状态从 `streaming` 置为 `finished`。

### `TalkRuntime.claimReadyOutputChunk`

供 voice call/TTS 轮询：

- 只返回当前 session 最早的未 claimed ready chunk。
- 返回后立即标记 claimed，避免重复播放。
- 返回内容包含 `sessionId`、`outputId`、`chunkId`、`text`、`outputTextLength` 和可用于播放追踪的 metadata。
- 没有可播放内容时返回 `undefined`。

### `TalkRuntime.interruptOutput`

处理已确认打断：

- 根据 `outputId` 找到当前 assistant output。
- 保存 `elapsedMs`、`totalMs`、`breakpointCharIndex`。
- 将断点前内容作为已保留 assistant 文本，并更新主内容表。
- 将断点及之后内容从主内容表删除，写入 `talk_output_discards.discarded_text`。
- 记录 `break_marker`，默认值为 `...`。
- 把 output 状态置为 `interrupted`。
- 取消未播放或未 claim 的 chunk。
- 写入 `input.interrupted` 事件和稳定 interrupt segment。

### `TalkRuntime.buildNextLoopMessages`

构造下一轮 TalkAgentLoop messages：

- 读取稳定历史 segment。
- 如果上一条 assistant output 被打断，assistant message 的 `content` 使用 `visible_text + break_marker`，默认表现为 `xxxx...`。
- 等待并读取打断后的最终 user transcript。
- 输出顺序必须形成：

```text
assistant.content: xxxx...
user: xxxxx
```

如果需要让 LLM 明确知道 `...` 的语义，TalkRuntime 可以在构造 prompt 时插入一条内部 system/control message，例如：

```text
system: 上一条 assistant 输出在 outputId=... 的 breakpointCharIndex=... 处被用户打断；assistant.content 末尾的 ... 是断点语义表示符，不是 assistant 原文；舍弃内容已移入 talk_output_discards，不能假设用户听到。
```

这个 control message 是运行时提示，不是用户或 assistant 的真实对话文本，不能写回 `content_text` 当作 assistant 发言。

## 测试验收

### TalkRuntime chunk

- LLM delta 拼接后按特殊字符切 chunk。
- 切分字符保留在前一个 chunk。
- ready buffer 不满 12 字符时不可获取。
- ready buffer 满 12 字符后可被 `claimReadyOutputChunk()` 获取。
- `finishAssistantOutput()` 会 flush 不足 12 字符的尾部。

### TalkRuntime 打断

- `interruptOutput()` 能按播放比例计算出的断点保存 breakpoint。
- 断点及之后文本会从主内容表移除，并写入 `talk_output_discards.discarded_text`。
- 断点以 `talk_output_interrupts.breakpoint_char_index` 和 `interrupt_id` 保存，不以字面量 `[断点]` 拼进 assistant 文本。
- 下一轮 LLM 上下文默认使用 `...` 表达断点语义。
- 未播放 chunk 被取消，不能再被 claim。
- 已打断 output 不再接受新的 assistant delta。

### TalkRuntime 入站

- `sessionId + sequence` 重复事件不会重复写入稳定 segment。
- `audio.transcript.final` 写入 user transcript segment。
- `input.interrupted` 写入 interrupt segment，但不作为普通用户文本。
- `session.ended` 会关闭 session。

### webrtc_voice

- 创建 call 会调用 `openSession()`。
- ASR final 会调用 `ingestInput(audio.transcript.final)`。
- TTS 空闲时会轮询并 claim ready chunk。
- 打断信号持续不足 1 秒不会触发 `interruptOutput()`。
- 打断信号持续 1 秒会触发 `interruptOutput()`，并清空播放队列。
- hangup 会调用 `closeSession()`。

### TalkAgentLoop

- LLM content delta 会写入 `appendAssistantDelta()`。
- LLM 完成后会调用 `finishAssistantOutput()`。
- 打断后当前 LLM turn 会停止。
- 最终用户转录回来后，下一轮 messages 包含 `assistant.content: xxxx...` 和 `user: xxxxx`，其中 `...` 是断点语义表示符。
- Talk 输出不调用 `send_chat`。

## 实施顺序

1. 实现 SQLite TalkStore，覆盖 `talk_sessions`、`talk_events`、`talk_segments` 和 assistant output/chunk 状态。
2. 实现 TalkRuntime 的会话、入站、输出缓冲、chunk claim 和打断接口。
3. 改造 `webrtc_voice` 依赖注入，让现有 `talk_runtime.*.todo` 状态点变成真实 TalkRuntime 调用。
4. 实现 voice call 的 TTS polling pump 和 1 秒 barge-in debounce。
5. 改造 TalkAgentLoop，让 LLM content stream 直接写入 TalkRuntime。
6. 串起 API 入口，创建真实 TalkRuntime 实例并注入 voice call 插件。
7. 补齐单元测试和一个 fake LLM + fake voice call 的集成式测试。

## 非目标

- 不把实时语音输出复用到 `send_chat`。
- 不把临时实时数据写入 `messages`。
- 不在首版做精确音素/字级 forced alignment。
- 不要求首版把实时对话投影到聊天历史或记忆归纳。
- 不在首版重新设计 voice call 页面视觉。
