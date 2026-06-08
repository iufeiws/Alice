# Agent Loops

AgentCore has separate loop modules for LLM session policy. Runtime ingress stays outside these modules.

## ChatAgentLoop

`core/agent/src/chat-loop.ts` owns the delayed chat LLM loop:

- uses `agentId: "chat"` when sending LLM requests
- keeps chat session state, rate limits, fixed-prefix append layers, and `wait_chat` resume behavior
- filters tool calls so `send_chat` and `wait_chat` keep their existing control semantics
- streams partial `send_chat` tool arguments when the model and tool sender support it

The chat prompt profile is stored in `src/core/prompt/prompt-profile.json` and is editable from the admin Prompt page under `Chat`.

## TalkAgentLoop

`core/agent/src/talk-loop.ts` is the realtime-dialogue sibling loop. It currently reuses the same LLM/tool-loop control skeleton as ChatAgentLoop, but sends requests with `agentId: "talk"` so logs, request metadata, and future runtime policy can distinguish realtime talk from delayed chat.

The talk prompt profile is stored in `src/core/prompt/talk-prompt-profile.json` and is editable from the admin Prompt page under `Talk`. It was initialized as a copy of the chat prompt profile so Talk starts with the same persona, prompt layers, append layers, and visible-tool switches, then can diverge without changing Chat.

`src/core/prompt/prompt-api-profile.json` binds Talk to its own `talkPresetName`. If unset, Talk has no explicit API preset binding; setting it does not change Chat or Memorize bindings.

## Memorize

Memorize remains a separate memory-induction path rather than an AgentCore chat/talk loop. Its prompts live in `src/core/prompt/memorize-prompts.json`, and its API binding remains `memorizePresetName`.

## Boundary

Loop modules should own LLM session policy and tool-call control only. They should not own channel ingress, TalkRuntime storage, ASR, TTS, or admin form rendering.

TalkRuntime remains the realtime state/runtime layer documented in `docs/core/talk-runtime.md`. A future TalkRuntime integration should feed talk events into TalkAgentLoop and persist realtime truth in the TalkRuntime tables instead of widening the chat message store.
