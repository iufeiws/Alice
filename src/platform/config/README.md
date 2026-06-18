# Platform Config

`platform/config` only contains generic environment parsing helpers.

It must not define Alice business config schemas such as LLM, Memory, Feishu, WeChat, Photo, or TTS. Those belong to app/context/plugin contracts.

## Public API

```ts
envBool(value, fallback)
envNumber(value, fallback)
envJsonObject(value)
trimTrailingSlashes(value)
```
