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

## 后续问题

- plugin 固定的 `apiPresetName` 和 `prompt` 应该放在哪个常量或插件定义中？
- send chat voice 的模型加载路由如何标识“启用翻译 plugin”？
- send chat voice 的音频缓存是否需要区分翻译前文本和翻译后文本？
- 是否允许用户在 UI 上看到“正在翻译后朗读”的轻量状态？
