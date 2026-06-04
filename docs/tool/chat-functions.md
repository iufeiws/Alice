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

### `search_messages`

Searches persisted chat messages and returns contextual message blocks.

Current LLM exposure: not listed by the default messaging tool plugin.

When exposed intentionally, keep it separate from `check_chat`: `search_messages` is an explicit search interface, while `check_chat` is the session-context reader with no LLM-visible parameters.

## Boundary Rule

`check_chat` is a zero-argument LLM function. Any scoped or cursor-based read is an internal AgentCore/admin/runtime operation, not an LLM contract.
