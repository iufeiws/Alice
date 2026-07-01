# Feishu Dynamic Card Agent Run Indicator Plan

## Goal

Add a side-track dynamic Feishu card that displays the agent run state plus streaming `reasoning` and `content` deltas produced by the agent's LLM request.

This is not a message delivery feature. It must not use or modify the existing `send_chat`, outbound message storage, message retry, or voice/talk output paths.

## Context Name

Create a new context:

```text
src/contexts/agent-run-indicator/
```

Reasoning:

- The feature represents transient visibility into an agent run, not a channel message.
- The core concept is not Feishu-specific.
- Feishu is one adapter for this context.
- The name avoids implying that the indicator is part of the chat/message domain.

## Confirmed Behavior

- Use the unique paired Feishu user as the display target.
- Reuse the same dynamic card.
- If the card does not exist, create it.
- Display three fixed-position blocks: state, reasoning, and content.
- While project typing is active, the state block shows `正在输入中...`.
- When the run finishes, the state block shows the current agent state label and the reasoning/content blocks show the final generated text for that run.
- During streaming, the first non-empty delta clears the previous rendered reasoning/content blocks; later updates render the current accumulated text directly.
- Enable only when Feishu is available, not when the active conversation channel is Feishu.
- Do not add any prompt content.
- Do not special-case agent loop or function-call loop tool execution by tool name, requester, or channel.

## Non-Goals

- Do not route this through `send_chat`.
- Do not write side-track card updates as outbound conversation messages.
- Do not integrate with voice/talk streaming.
- Do not show tool calls, round status, errors, model names, or timing in the card in the first version.
- Do not introduce fallback behavior to older message paths.

## Architecture

```text
agent-loop LLM stream
  -> agent-run-indicator port
  -> Feishu adapter
  -> Feishu dynamic card create/update
```

The agent loop should depend only on a generic indicator port. The Feishu-specific runtime decides whether the indicator exists.

## Agent Run Indicator Port

Add a context-owned port with a minimal shape:

```ts
export type AgentRunIndicator = {
  begin(input: AgentRunIndicatorBeginInput): Promise<AgentRunIndicatorSession | undefined>;
};

export type AgentRunIndicatorSession = {
  appendContentDelta(delta: string): Promise<void>;
  finish(): Promise<void>;
  fail(error: unknown): Promise<void>;
};
```

The port must not include Feishu ids, message ids, channel ids, or prompt details.

`begin()` may return `undefined` when no indicator is available. This keeps availability outside the agent loop.

## Availability

Feishu availability is runtime capability, not current channel selection.

First version availability:

- Feishu config is enabled.
- Feishu runtime has a started client capable of sending/updating cards.
- Unique Feishu pairing exists.
- The paired contact can be resolved into a Feishu send target.

If any condition is false, no `AgentRunIndicator` session is created.

## Feishu Adapter

Add a Feishu-backed adapter under the new context or a thin adapter module wired from bootstrap:

```text
src/contexts/agent-run-indicator/src/
  index.ts
  runtime.ts
  ports.ts
  adapters/feishu-dynamic-card-indicator.ts
```

The adapter owns:

- resolving the unique paired Feishu user;
- creating the card when there is no stored card id;
- updating the existing card when a card id exists;
- starting the next run's positional replacement from the previous blocks;
- accumulating deltas;
- throttling update calls.

## Feishu Channel Capability

Extend the Feishu channel with low-level card operations, separate from normal outbound sending:

```ts
type FeishuAgentRunCardBlock = "state" | "reasoning" | "content";
type FeishuAgentRunCardBlocks = Record<FeishuAgentRunCardBlock, string>;

type FeishuDynamicCardClient = {
  createAgentRunCard(input: { receiveIdType: "open_id"; receiveId: string; blocks: FeishuAgentRunCardBlocks }): Promise<{ messageId: string; cardId: string }>;
  updateAgentRunCard(input: { cardId: string; block: FeishuAgentRunCardBlock; content: string; sequence: number }): Promise<void>;
  setAgentRunCardStreaming(input: { cardId: string; enabled: boolean; sequence: number }): Promise<void>;
};
```

These methods are not part of `ChannelPlugin.send()`.

The card body is the accumulated delta text. No hardcoded prompt text is added.

## Feishu Dynamic Card API

Use Feishu CardKit APIs exposed by the installed `@larksuiteoapi/node-sdk`.

Confirmed SDK methods:

- `client.cardkit.v1.card.create`
  - `POST /open-apis/cardkit/v1/cards`
  - Creates a card instance and returns `card_id`.
- `client.im.v1.message.create`
  - Sends an interactive message whose content references the created card instance:

```json
{
  "type": "card",
  "data": {
    "card_id": "card_xxx"
  }
}
```

- `client.cardkit.v1.cardElement.content`
  - `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content`
  - Replaces the markdown element text. Feishu detects the delta and renders a typewriter effect.
  - Requires monotonically increasing `sequence`.
- `client.cardkit.v1.card.settings`
  - `PATCH /open-apis/cardkit/v1/cards/:card_id/settings`
  - Can update `streaming_mode`.
- `client.cardkit.v1.card.idConvert`
  - Converts an existing `message_id` to `card_id` if needed.

The SDK also exposes `LarkChannel.stream()` and a `MarkdownStreamController`, but this plan should not adopt that high-level channel abstraction directly. Existing Feishu code already owns `Client` / `WSClient` lifecycle. Reuse the underlying CardKit method shape instead.

Initial card JSON should be a CardKit card with three markdown elements and two native divider elements:

```json
{
  "schema": "2.0",
  "config": {
    "streaming_mode": true,
    "streaming_config": {
      "print_frequency_ms": { "default": 70 },
      "print_step": { "default": 1 },
      "print_strategy": "fast"
    }
  },
  "body": {
    "elements": [
      {
        "tag": "markdown",
        "element_id": "agent_run_state",
        "content": "正在输入中..."
      },
      {
        "tag": "hr"
      },
      {
        "tag": "markdown",
        "element_id": "agent_run_reasoning",
        "content": " "
      },
      {
        "tag": "hr"
      },
      {
        "tag": "markdown",
        "element_id": "agent_run_content",
        "content": " "
      }
    ]
  }
}
```

`" "` is the empty block placeholder required by Feishu's minimum markdown content length, not prompt content.

## Card Persistence

Persist the reusable card id separately from conversation messages:

```text
memory-files/indexes/feishu-agent-run-indicator-card.json
```

Example shape:

```json
{
  "messageId": "om_xxx",
  "cardId": "card_xxx",
  "nextSequence": 1,
  "updatedAt": "2026-06-29T00:00:00.000Z"
}
```

On startup, the adapter can attempt to reuse this card id. If an older record has only `messageId`, use `client.cardkit.v1.card.idConvert` to resolve `cardId`, then rewrite the indicator record with both ids.

If the stored card layout version is not current, create a new card with the current layout and preserve the saved state/reasoning/content blocks.

If Feishu returns a clear "message/card does not exist or cannot be updated" error, the adapter should delete this indicator card record and create a new card. This is lifecycle recovery for the side-track card itself, not fallback to message sending.

## Stream Integration

Hook into chat LLM stream handling where stream handlers are composed.

For each agent run:

1. At LLM request start, call `indicator.begin()`.
2. On each `reasoning_content` delta, call `session.appendReasoningDelta(delta)`.
3. On each `content` delta, call `session.appendContentDelta(delta)`.
4. On normal completion, call `session.finish()`.
5. On cancellation or error, call `session.fail(error)`.

The hook must preserve any existing stream handler behavior.

## Reuse Semantics

The Feishu adapter uses one card across runs:

- At project typing start, update the state block to `正在输入中...` and render reasoning/content from their previous block positions.
- As deltas arrive, update the same card's reasoning/content blocks with accumulated text.
- Empty blocks are still present in the card.
- On the next run, start a new positional replacement cycle on the same card.
- If no stored reusable card exists, create one.

## Throttling

The adapter should not call Feishu on every token.

Initial policy:

- Accumulate all deltas in memory.
- Flush at most once per 500 ms.
- Always flush once at `finish()`.

The exact throttle can be adjusted after observing Feishu API limits.

## Error Handling

Indicator failures must not be silently swallowed without logging.

Confirmed behavior:

- Side-track failures do not fail the main LLM run.
- Log indicator failures.
- Disable the current indicator session after failure.
- Do not route failures to a message fallback.

## Files Likely Touched

Expected new files:

- `src/contexts/agent-run-indicator/src/index.ts`
- `src/contexts/agent-run-indicator/src/ports.ts`
- `src/contexts/agent-run-indicator/src/runtime.ts`
- `src/contexts/agent-run-indicator/src/adapters/feishu-dynamic-card-indicator.ts`

Expected modified files:

- `src/channels/feishu/src/client.ts`
- `src/channels/feishu/src/monitor.ts`
- `src/channels/feishu/src/index.ts`
- `src/channels/feishu/src/types.ts`
- `src/apps/api/bootstrap/channel-plugin-runtime.ts`
- `src/apps/api/bootstrap/api-agent-runtime.ts`
- `src/apps/api/bootstrap/api-communication-runtime.ts`
- `src/contexts/agent-loop/src/application/chat-agent.ts`
- `src/contexts/agent-loop/src/application/run-chat-loop.ts`

Exact wiring may shift after implementation review, but the design boundary should remain: agent loop sees a generic indicator, Feishu owns card operations.

## Tests

Add focused tests:

- Agent loop with no indicator behaves unchanged.
- Stream `reasoning_content` and `content` deltas are forwarded to an indicator session.
- Existing stream handlers still run when an indicator is present.
- Feishu adapter creates a card when no persisted card id exists.
- Feishu adapter updates the persisted card when a card id exists.
- Feishu adapter uses native `hr` elements between the three fixed-position blocks.
- Feishu adapter renders active typing state as `正在输入中...`.
- Feishu adapter renders current accumulated reasoning/content directly during streaming.
- Feishu adapter flushes final accumulated content on finish.
- Feishu unavailable or no unique paired user means no indicator session.
- Indicator storage is separate from conversation message storage.
