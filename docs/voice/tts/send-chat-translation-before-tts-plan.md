# Send Chat Voice 翻译后 TTS 功能计划

本文档记录一个新的 send chat voice 局部功能计划：开启功能时，send chat voice 的 TTS 模型加载改走一个写死的日语 voice 翻译 plugin 路由。该 plugin 在进入 TTS 之前，先将待朗读内容通过 Flash LLM 翻译为日语，再将翻译结果交给 TTS。TTS 完成后继续走现有 send chat voice 流程。翻译结果只用于本次语音生成，不写入 message log。

## 目标

- 支持在 send chat voice 路径中，通过写死的 plugin 把待播报文本翻译为日语。
- 使用 Flash LLM 执行低延迟翻译，减少 TTS 前置等待。
- 开启功能时，TTS 模型加载改走 plugin 路由，由 plugin 负责翻译前置处理。
- TTS 使用翻译后的文本生成语音，然后回到正常 send chat voice 后续流程。
- message log 仍然只记录原始 send chat 内容，不记录翻译结果。
- 翻译链路对现有聊天语义保持透明，不改变已发送消息的正文、语言和历史记录。
- 功能覆盖边界仅限 send chat voice，不影响其他 TTS 调用路径。

## 非目标

- 不将翻译结果展示为新的聊天消息。
- 不把翻译结果作为 assistant 或 user message 写入 message log。
- 不改变 send chat 的原始存储格式。
- 不在本阶段实现多版本翻译缓存、人工编辑翻译或逐句对照显示。
- 不提供运行时可配置的目标模型、目标语言或 prompt。
- 不改造非 send chat voice 的 TTS 调用流程。
- 不改变 TTS 完成后的 send chat voice 既有处理逻辑。

## 用户场景

- 用户希望 Alice 用目标语言朗读 send chat 内容，例如把中文回复翻译成日语后再 TTS。
- 用户的聊天记录仍保持原语言，避免日志中混入仅为朗读服务的中间文本。
- 用户开启该 send chat voice 翻译插件后，语音输出使用 plugin 写死的目标语言，不回写历史消息。

## Plugin 固定变量

本功能整体概念是一个写死的 plugin，但仍然以两个变量表达其核心配置。后台配置只保存 API preset 引用，不保存 API key：

- `apiPresetName`: 用于执行翻译的 Flash LLM API preset 名称。目标模型、endpoint、认证和其他调用参数来自后台统一 API preset 存储。
- `prompt`: 翻译提示词模板。日语目标语言、翻译风格和输出格式都写死在该 prompt 中。

配置文件存放在 plugin 文件夹内：

```text
plugins/japanese-voice/config.json
```

当前配置保留 `enabled` 开关。后续后台管理可以直接围绕这个配置文件创建设置入口；运行时每次 send chat voice 合成前读取开关，便于后台修改后生效。

后台 Plugin 页补充规则：

- Voice Model 上传目录时拆掉原始目录层级，文件直接写入 `assets/plugin/japanese-voice/model/`。
- Reference Audio 使用文件上传，保存为 `voice.referenceAudio` 资源路径。
- Reference Text 使用文字输入框，直接保存到 `plugins/japanese-voice/config.json` 的 `voice.referenceText`。
- Text Split 使用开关保存到 `plugins/japanese-voice/config.json` 的 `voice.splitText`，表示是否让 Genie 对一次 TTS 文本做内部分段合成；默认设为 `false`（否）。
- 日语 voice 的 Genie-TTS 参数通过本次 synthesize 请求传入：`language: "jp"`、model dir、reference audio、reference text；不改全局 TTS 配置，也不生成额外配置文件。
- 配置页提供测试框：输入原文，输出翻译文本、语音播放和 translation/TTS/total 计时。
- 翻译调用复用统一 LLM request sender，便于进入现有 LLM request 记录和重试链路。

原始待朗读文本不作为独立 message 写入，也不生成新的日志消息。调用 Flash LLM 时，将原始文本直接 append 到 `lastMessage` 末尾，让 plugin 的固定 prompt 和最后一条消息共同形成翻译请求。

是否启用该功能由 send chat voice 的模型加载路由决定：未开启时加载正常 TTS 模型；开启时加载 `plugins/japanese-voice` 路由，由 plugin 使用固定的 `apiPresetName` 和 `prompt` 完成翻译后再进入 TTS。

## 流程

```text
send chat voice content
  -> message log 写入原始内容
  -> 判断 send chat voice 是否启用翻译 plugin
  -> 未开启：加载正常 TTS 模型并走原流程
  -> 已开启：TTS 模型加载改走 plugin 路由
  -> plugin 将原始文本 append 到 lastMessage 末尾
  -> plugin 使用固定 apiPresetName 解析出的 API preset 和 prompt 调用 Flash LLM 翻译
  -> TTS 使用翻译结果
  -> 回到正常 send chat voice 流程
```

关键边界：

- message log 写入发生在原始 send chat 内容层。
- plugin 路由只改变 send chat voice 的 TTS 模型加载入口，不改变 TTS 后续流程。
- 原始文本 append 到 `lastMessage` 只发生在翻译请求上下文中，不写入 message log。
- Flash LLM 翻译结果属于 send chat voice plugin 的 TTS 前置临时产物。
- TTS 之后的播放、返回音频、状态更新或事件派发继续复用现有 send chat voice 流程。
- 本功能不覆盖独立 TTS、系统提示音、非 send chat voice 的语音生成或其他调用入口。
- 翻译结果可以进入运行时 trace、debug log 或 telemetry，但默认不进入用户可见的 message log。
- 如果需要记录调试信息，应避免默认保存完整翻译文本，优先记录状态、耗时、目标语言和错误码。

## 流式入口设计

当前 `japanese-voice` plugin 只有非流式 `VoiceSynthesizer(input) -> VoiceSynthesisResult` 包装入口：先等整段文本翻译完成，再等整段 TTS 合成完成，最后返回单个音频资产。为了降低首包延迟，新增一个 send chat voice 专用的流式入口，不替换现有非流式入口：

```ts
type VoiceStreamInput = {
  text: AsyncIterable<string> | Iterable<string> | string;
  time: CurrentTimeProvider;
  source: "send_chat.voice";
  streamId?: string;
};

type VoiceStreamChunk =
  | { type: "translation_started"; sequence: number; sourceChars: number }
  | { type: "translation_done"; sequence: number; translatedChars: number }
  | { type: "audio"; sequence: number; chunk: Uint8Array; contentType: "audio/L16; rate=32000; channels=1" }
  | { type: "part_done"; sequence: number }
  | { type: "done" };

type StreamingVoiceSynthesizer = VoiceSynthesizer & {
  stream?(input: VoiceStreamInput): AsyncIterable<VoiceStreamChunk>;
};
```

入口挂载在 plugin 的 `voiceSynthesizer.stream` 上，只在 `source === "send_chat.voice"` 且 plugin enabled 时启用。未启用、非 send chat voice、或底层 TTS 不支持流式时，调用方继续使用当前非流式 `voiceSynthesizer(input)`。

### 缓冲分句队列

流式入口接收上游逐步产生的文本 chunk 后，不逐字翻译，也不等待整段结束。它维护一个内存缓冲队列，沿用 Genie 当前“根据数量分句”的模式，把文本累计到一定数量后先切出一个可朗读 part：

```text
incoming text chunk
  -> append 到 pendingText
  -> 按标点/换行优先找自然边界
  -> 如果没有自然边界，但 pendingText 达到 minFlushChars，则按字符数切分
  -> 生成 source part，进入 translationQueue
  -> stream 结束时 flush 剩余 pendingText
```

建议默认阈值：

- `minFlushChars`: 10，和 Genie `split_text_for_tts(text, max_chars = 10)` 的当前粒度保持一致。
- `maxFlushChars`: 40，防止没有标点的长句一直不发送。
- `softBoundaryChars`: 20，达到该长度后如果遇到 `。！？.!?\n` 就立即 flush。
- `maxBufferedParts`: 4，限制未翻译队列长度，触发背压。

分句只决定“先翻译哪一段”。进入 Genie 时每个已翻译 part 使用 `splitText: false`，避免 TypeScript 侧和 Genie 侧重复分句；如果后续希望继续让 Genie 内部分句，可以改为仅在整段非流式路径保留 `voice.splitText`。

### 翻译到 Genie 的流水线

每个 source part 都分配递增 `sequence`，进入翻译队列：

```text
source part #n
  -> Flash LLM 翻译
  -> translated part #n
  -> Genie /stream
  -> audio chunks #n
  -> 返回给调用方
```

为了保持语音顺序，返回端按 `sequence` 串行输出。实现上可以允许翻译预取 1 个后续 part：

- 当前 part 正在 Genie streaming 时，下一 part 可以并行执行 Flash LLM 翻译。
- 不允许后续 part 的音频越过前序 part 返回。
- 如果翻译失败，当前 part 使用原文进入 Genie，并发送 warn log，不中断整个 stream。
- 如果 Genie 当前 part 失败，结束该 stream 并走 send chat voice 既有失败处理；已经发送出的音频不回滚。

### Genie 流式接入

Python Genie 服务已有 `/stream` 风格能力，返回 `audio/L16; rate=32000; channels=1` 的 chunked PCM。TypeScript 侧需要补一个底层能力：

```ts
type VoiceAudioStreamInput = VoiceSynthesisInput;

type VoiceAudioStreamSynthesizer = VoiceSynthesizer & {
  streamAudio?(input: VoiceAudioStreamInput): AsyncIterable<Uint8Array>;
};
```

`createGenieTtsVoiceSynthesizer` 增加 `streamAudio`：

```text
ensureGenieService()
POST /stream { text, ...genieRequestOverrides({ ...overrides, splitText: false }) }
for await response.body -> yield Uint8Array
```

`createConfiguredVoiceSynthesizer` 只在实际使用 Genie 且没有切到 MOSS fallback 时暴露 `streamAudio`。MOSS fallback 暂不实现流式；如果已经 fallback 到 MOSS，plugin 的 `stream` 入口返回不可用，让调用方退回非流式路径。

### 调用方返回模式

send chat voice 调用方消费 `voiceSynthesizer.stream(...)` 时，按 chunk 直接返回或播放：

```text
for await (event of plugin.voiceSynthesizer.stream(input)):
  translation_started / translation_done -> 只用于 trace/status
  audio -> 立即写给客户端或播放轨道
  part_done -> 可更新状态
  done -> 关闭响应
```

如果目标平台只能发送完整音频文件而不能发送 PCM chunk，则不要使用该流式入口，继续走现有非流式 send voice；这个入口主要服务 WebRTC、浏览器播放、或未来支持 chunked audio 的客户端。

### 背压与取消

- 调用方停止消费 stream 时，plugin 需要停止读取上游文本、取消待翻译请求，并 abort 当前 Genie `/stream` 请求。
- `translationQueue` 超过 `maxBufferedParts` 时暂停读取上游 `text`。
- 每个 stream 只保留内存态 part、翻译文本和少量状态，不写入 message log。
- 日志默认只记录 `streamId`、`sequence`、字符数、耗时和错误类型，不记录完整原文或译文。

### 流式错误策略

- 翻译失败：当前 part 使用原文进入 Genie，继续 stream。
- 翻译返回空文本：视为翻译失败，当前 part 使用原文。
- Genie `/stream` 不可用：整个流式入口报告 `stream_unavailable`，调用方回退非流式。
- 当前 part 的 Genie stream 中途失败：终止本次 stream，调用方按 voice TTS 失败处理。
- 上游文本为空：返回 `done`，不调用翻译和 Genie。

## 翻译提示词要求

plugin 写死的 prompt 应保持短、稳定、可控：

```text
Translate the following text into Japanese.
Preserve meaning, tone, names, numbers, punctuation intent, and formatting where reasonable.
Return only the translated text. Do not add explanations.

Text:
{content appended to lastMessage}
```

约束：

- 只输出翻译文本，不输出解释。
- 保留称呼、专有名词、数字、代码片段和必要格式。
- 对无法自然翻译的内容尽量保留原文。
- 不执行内容扩写、改写、总结或安全替换。
- `apiPresetName` 和 `prompt` 由 plugin 固定，不从用户输入或 message log 动态读取配置。
- 目标模型来自后台统一 API preset，目标语言来自 `prompt`。
- 原始文本直接 append 在 `lastMessage` 末尾，避免引入新的 message 记录。

## 错误处理

- Flash LLM 超时：按调用方默认策略使用原文 TTS 或跳过 TTS。
- Flash LLM 返回空文本：视为翻译失败。
- plugin 路由加载失败：回退到正常 send chat voice TTS 模型加载，或按现有失败策略终止语音生成。
- TTS 失败：回到现有 send chat voice 的 TTS 失败流程处理，不回写 message log。

建议默认策略：

- 翻译失败时使用原文继续 TTS。
- 在 debug log 中记录 `translation_failed`、目标语言、耗时和错误类型。
- 不记录完整翻译结果，除非显式开启调试模式。

## 数据与隐私边界

- 原始 send chat 内容按现有逻辑写入 message log。
- 翻译结果不写入 message log。
- append 到 `lastMessage` 的原始文本只存在于本次 Flash LLM 请求上下文中。
- 翻译结果只在本次 send chat voice 的 TTS 请求上下文中短暂存在。
- 如果 send chat voice 已有音频缓存，缓存 key 可以包含原文 hash、目标语言和 voice 配置，但不应要求 message log 存储翻译文本。
- 如果需要审计，应审计翻译请求是否发生，而不是把翻译内容当作聊天消息保存。

## 验收标准

- 启用功能后，send chat voice 内容会先翻译为目标语言，再交给 TTS。
- 启用功能后，send chat voice 的 TTS 模型加载会走写死的 plugin 路由。
- plugin 使用固定的 `apiPresetName` 和 `prompt`；目标模型由后台统一 API preset 固定，目标语言由 `prompt` 固定。
- 原始文本会直接 append 到 `lastMessage` 末尾参与翻译请求，不新增 message log 记录。
- TTS 完成后继续走正常 send chat voice 后续流程。
- 非 send chat voice 的 TTS 调用不受影响。
- message log 中只能看到原始 send chat 内容，看不到翻译文本。
- Flash LLM 失败时，系统按调用方默认策略回退到原文 TTS 或跳过 TTS。
- 调试日志不会在默认配置下保存完整翻译文本。
- 新增流式入口启用后，收到文本达到缓冲阈值或自然边界时，会先发送该 part 的翻译请求，不等待完整 send chat 内容结束。
- 每个翻译完成的 part 会立即进入 Genie `/stream`，并以音频 chunk 逐个返回。
- 流式返回必须保持原文 part 顺序，即使后续 part 已提前翻译完成，也不能越过前序音频。
- 流式路径不新增 message log 记录，不保存完整翻译文本。
- Genie 流式不可用或目标平台不支持音频 chunk 时，调用方可以回退到现有非流式路径。

## 后续问题

- plugin 固定的 `apiPresetName` 和 `prompt` 应该放在哪个常量或插件定义中？
- send chat voice 的模型加载路由如何标识“启用翻译 plugin”？
- send chat voice 的音频缓存是否需要区分翻译前文本和翻译后文本？
- 是否允许用户在 UI 上看到“正在翻译后朗读”的轻量状态？
- `minFlushChars`、`maxFlushChars`、`softBoundaryChars` 是否写死在 plugin，还是作为隐藏配置保留在 `plugins/japanese-voice/config.json`？
- 流式 PCM chunk 的客户端封装格式是否统一成 SSE/WebSocket 事件，还是由具体 send chat voice 调用方自行决定？
