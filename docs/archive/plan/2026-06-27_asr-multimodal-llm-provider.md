# ASR Multimodal LLM Provider Plan

## Goal

Add an ASR provider that sends audio to an existing LLM API preset as a one-shot multimodal request. The request forces a dedicated result tool call, parses that tool call, and returns the ASR text without entering the agent tool loop.

## Confirmed Behavior

- Use the existing LLM API preset framework. `present` in the original note means `preset`.
- Add a new ASR provider, tentatively `multimodal_llm`.
- The provider sends audio as `input_audio` content, following the referenced Python script shape.
- The provider uses ASR-owned `extraParams`, separate from main chat request/session extra params.
- The ASR-owned `extraParams` requires the dedicated tool call, using OpenAI-compatible `tool_choice` semantics.
- The dedicated tool is `submit_audio_context`.
- When the model calls `submit_audio_context`, ASR parses the arguments and returns immediately.
- The tool result does not enter another LLM round.
- This request does not use the LLM main session.
- Persist this as the first subagent session type under:

```text
/home/yf/Alice/memory-files/llm-sessions/sub_agent
```

## Result Format

The tool arguments follow the reference script:

```json
{
  "speakText": "string",
  "emotion": "string",
  "description": "string"
}
```

ASR text rendering:

- If `speakText` is non-empty:

```text
[语音][emotion]speakText
```

- If `speakText` is empty:

```text
[语音][description]
```

No translation is added by ASR code.

## Config Shape

Extend ASR config minimally:

```json
{
  "defaultProvider": "multimodal_llm",
  "providers": {
    "multimodalLlm": {
      "apiPresetName": "string",
      "prompt": "string",
      "extraParams": {}
    }
  }
}
```

`apiPresetName` resolves through the same preset list used by existing LLM requests. `extraParams` is ASR-specific and may include templated values, including the forced tool call setting for `submit_audio_context`.
`prompt` is required. The ASR provider does not inject a default prompt in code.

## Extra Params Handling

ASR multimodal config owns its own `extraParams`. It is not copied from the main chat/talk session and it is not written back into the main session.

ASR must not perform template replacement itself. Replacement belongs in the shared LLM request layer, because request-time rendering is a transport concern shared by chat, talk, memory, TTS, and ASR.

Implementation detail:

- Resolve `providers.multimodalLlm.apiPresetName` through the existing LLM preset framework.
- Build the ASR request with the raw configured `extraParams` plus `toolVariables`.
- Extend the shared `llmRequests.send` preparation path to render `input.extraParams` with the same `renderLLMValue` mechanism already used for tool descriptions and schemas.
- The ASR provider only supplies variables such as provider id, filename, MIME type, and metadata; it does not call `renderLLMValue`.
- The existing OpenAI-compatible client spreads `input.extraParams` into the `/chat/completions` body before writing `model`, `messages`, `temperature`, `tools`, and `max_tokens`.
- Therefore ASR `extraParams` can carry provider-specific fields such as:

```json
{
  "tool_choice": {
    "type": "function",
    "function": {
      "name": "submit_audio_context"
    }
  }
}
```

- The actual `tools` schema still comes from ASR request construction, not from `extraParams`.
- If `extraParams` tries to override `model`, `messages`, `temperature`, `tools`, or `max_tokens`, the typed request fields win because the client writes them after spreading `extraParams`.
- No prompt text is hidden inside `extraParams`.

## Request Flow

1. `transcribeWithAsrPlugin` resolves provider.
2. `multimodal_llm` reads audio bytes with the existing ASR audio reader.
3. Convert audio to a data URL using the detected MIME type.
4. Send one `llmRequestSender` request:
   - `agentId`: `asr`
   - `presetName`: configured ASR preset
   - `toolNames`: `["submit_audio_context"]`
   - `stream`: `false`
   - `extraParams`: ASR provider `extraParams`
   - `metadata`: plugin/provider/audio filename
5. Parse `result.message.toolCalls[0].function.arguments`.
6. Validate tool name is exactly `submit_audio_context`.
7. Render ASR text using the confirmed format.
8. Store request/response transcript in the subagent session root.

No fallback to Tencent or OpenAI audio transcription if the multimodal provider fails.

## Tool Call Exit

Initial implementation does not call `runLLMToolLoop`.

The ASR code treats `submit_audio_context` as a structured response contract:

1. Send one non-streaming LLM request.
2. Read `result.message.toolCalls`.
3. Require exactly the expected function name.
4. Parse the JSON arguments.
5. Return the rendered ASR text.

Implementation shape:

```ts
const result = await llmRequestSender({
  agentId: "asr",
  presetName: providerConfig.apiPresetName,
  messages,
  toolNames: ["submit_audio_context"],
  toolVariables,
  extraParams: providerConfig.extraParams ?? {},
  round: 0,
  stream: false,
  metadata: { pluginId: "asr", provider: "multimodal_llm", filename: audio.filename }
});

const call = requireSingleToolCall(result.message.toolCalls, "submit_audio_context");
const args = parseSubmitAudioContextArguments(call.function.arguments);
return {
  text: renderAsrAudioText(args),
  provider: "multimodal_llm",
  model: result.model,
  raw: result.raw
};
```

`requireSingleToolCall` should throw on:

- no tool call;
- more than one tool call;
- wrong function name.

`parseSubmitAudioContextArguments` should throw on invalid JSON or missing string fields. Do not reuse the agent-loop `parseAgentLoopToolArguments` behavior here, because that parser silently turns invalid JSON into `{}` for normal tool execution recovery.

It intentionally does not:

- execute the tool through `agent-loop-tool-executor`;
- append a `tool` role response message;
- send a second LLM request with the tool result;
- continue until `finish_reason` changes.

So for now the forced tool call is the terminal response for ASR, not the start of a normal agent function-call round.

This is a deliberate first step, not a permanent design claim. `runLLMToolLoop` may become necessary later if ASR needs shared loop behavior such as common cancellation semantics, standard response/session hooks, tool-call accounting, or unified terminal-tool handling. Do not hide that migration behind ASR-specific fallback logic; if those requirements appear, move ASR onto a shared loop path explicitly.

`finish_and_wait` has one reusable idea but not a reusable execution path:

- Reusable idea: a tool call can be terminal for a loop.
- Current implementation: `finish_and_wait` returns `meta.yieldReturn = true`; `runLLMToolLoop` sees that and stops with `stopReason: "yield_return"`.
- ASR should not use that path, because entering `runLLMToolLoop` would still treat `submit_audio_context` as an executable agent tool and create loop-specific assistant/tool message handling.
- ASR needs a direct single-request parser instead.

## Session Plan

Current LLM sessions only special-case `chat` and `talk` as main sessions. The subagent path should not reuse those current-session pointers.

Minimal implementation:

- Add a subagent session dictionary/runtime entry keyed by agent id, starting with `asr`.
- Persist subagent JSONL transcript files under `llm-sessions/sub_agent`.
- Log one request and one response for this ASR call.
- Do not mark it as current main chat/talk session.
- No loop retention is needed because ASR sends one request and returns after the tool call.

## Tool Definition

Expose only the schema needed for this ASR request:

- name: `submit_audio_context`
- required args: `speakText`, `emotion`, `description`
- `additionalProperties: false`

This tool is a structured output contract for the ASR provider. It is not an executable agent-loop tool.

## Tests

- Config parser accepts `defaultProvider: "multimodal_llm"`.
- Missing multimodal preset returns `missing_provider_config`.
- Multimodal request sends one LLM request with audio `input_audio`.
- The request includes `submit_audio_context` and ASR-owned `extraParams`.
- A valid tool call renders `[语音][emotion]speakText`.
- Empty `speakText` renders `[语音][description]`.
- Missing or wrong tool call returns provider failure.
- Subagent session writes under `memory-files/llm-sessions/sub_agent`.
- Chat/talk current session pointer is not changed by ASR.

## Implementation Decisions

- Request prompt text is supplied by ASR config as `providers.multimodalLlm.prompt`; code injects no default prompt.
- Provider config field name is `providers.multimodalLlm`.
- `submit_audio_context` is supplied as an inline LLM request tool for the ASR request, not registered as an executable global agent-loop tool.
