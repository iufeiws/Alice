# Chat Functions

This document defines the LLM-facing boundary for chat-related functions.

## LLM-visible functions

### `check_chat`

Reads chat history for the current messaging session.

LLM-visible parameters: none.

The function schema exposed to the LLM must be:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

The LLM must not see or choose any `check_chat` scope. In particular, do not expose `scope`, `from`, `to`, `__scope`, `__preview`, or `__fromPrefixAfterMessageId` in the tool schema or tool description.

Runtime and admin code may still pass internal inputs directly to the messaging tool implementation:

- `scope`: explicit internal read mode, including `today`, `todayold`, `recent`, `new`, `range`, and `from_prefix`.
- `from` / `to`: internal range bounds for `scope=range`.
- `__scope`: internal preview scope used by token-pressure checks.
- `__preview`: internal read-only mode that must not advance read cursors.
- `__fromPrefixAfterMessageId`: internal fixed-prefix cursor injected by AgentCore.

AgentCore owns fixed-prefix use. In `fixed_prefix` mode it injects `check_chat` with `scope=from_prefix` and `__fromPrefixAfterMessageId`; the model should only see a normal `check_chat` tool call with no parameters.

### `send_chat`

Sends output to the current messaging session.

LLM-visible parameters:

- `type`: message output type.
- `content`: text content to send.

`send_chat` is user-facing and may be selected by the LLM when it needs to respond through the messaging channel.

### `wait_chat`

Waits for chat history updates. When new messages arrive, the model will be notified and receive the new messages.

LLM-visible parameters: none.

`wait_chat` belongs to the chat/messaging tool plugin. It must not be implemented as a separate generic wait tool, because its resume behavior is tied to `check_chat`.

When an assistant tool-call batch contains `wait_chat`, AgentCore handles that batch specially:

- outbound tools such as `send_chat` execute immediately and their tool results are appended to the transcript.
- inbound tools such as `check_chat` are deferred until the wait resumes.
- `wait_chat` itself records pending yield metadata and does not immediately append a tool result.
- on heartbeat resume, AgentCore fills the remaining tool results in original tool-call order, including the deferred inbound results and the final `wait_chat` result.

The resume path must not add a new fake `check_chat` assistant/tool pair for the heartbeat. The chat-check output used for wakeup is attached to the pending `wait_chat` tool result instead.

### `search_messages`

Searches persisted chat messages and returns contextual message blocks.

Current LLM exposure: not listed by the default messaging tool plugin.

When exposed intentionally, keep it separate from `check_chat`: `search_messages` is an explicit search interface, while `check_chat` is the session-context reader with no LLM-visible parameters.

## Boundary Rule

`check_chat` is a zero-argument LLM function. Any scoped or cursor-based read is an internal AgentCore/admin/runtime operation, not an LLM contract.

`wait_chat` is a chat-loop control function. Its first execution is control-only metadata, and its LLM-visible result is produced later by the heartbeat resume path.
