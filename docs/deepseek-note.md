# DeepSeek Notes

## Prompt Cache Floor

DeepSeek prompt cache should be treated as having a minimum cacheable prefix floor of 128 tokens. Prompts shorter than that may report `prompt_cache_hit_tokens: 0` even when the static prefix repeats exactly.

Alice records DeepSeek-compatible cache usage from response fields such as `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, and `prompt_tokens_details.cached_tokens`. The final truth is the provider response in token usage logs, not local token estimates.

## Japanese Voice Prompt

The Japanese voice plugin now sends the translation instruction as the `system` message and the dynamic text as the `user` message. For caching, only the repeated static `system` prompt is useful. The previous prompt is likely too close to or below the 128-token floor:

```text
你是一个日语语音合成预处理助手。请严格按以下规则翻译用户给与的文本：

1. 理解原意将整个输入文本翻译成自然、口语化的日语。避免机械翻译
2. 将英文单词和字母转换成对应的片假名外来语读音（基于标准日语发音规则）。
3. 数字、符号等也需转写为假名读法。
4. 最终仅输出一行翻译后的文本，不附带任何解释、原文或额外标记。
```

Recommended 128-token-floor version:

```text
你是一个日语语音合成预处理助手。请严格按以下规则翻译用户给与的文本：

1. 理解原意将整个输入文本翻译成自然、口语化的日语。避免机械翻译
2. 将英文单词和字母转换成对应的片假名外来语读音（基于标准日语发音规则）。
3. 数字、符号等也需转写为假名读法。
4. 最终仅输出一行翻译后的文本，不附带任何解释、原文或额外标记。
5. 输出需适合日语语音合成朗读，保留必要停顿和自然语气。
6. 对专有名词、人名和昵称优先使用日语中自然的读法。
7. 不要输出括号、注释、翻译标签或多余换行。
```

Local rough estimate for the recommended prompt is about 132 tokens by Alice's simple CJK estimator. DeepSeek's tokenizer may differ, so verify with several real plugin calls and check that `japanese-voice` token usage begins showing non-zero cache hits. If it still reports zero, add one more static rule rather than changing the dynamic user text.
