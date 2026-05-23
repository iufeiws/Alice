# Intent Router

`core/router` maps normalized `AgentEvent` objects into simple internal intents.

## Public Interface

```ts
type Intent =
  | { kind: "chat"; text: string }
  | { kind: "codex"; command: string; prompt: string }
  | { kind: "unsupported"; reason: string };

interface IntentRouter {
  route(event: AgentEvent): Intent;
}
```

## Factory

```ts
createIntentRouter(): IntentRouter
```

## Current Rules

- Non-text payloads return `unsupported`.
- Text starting with `/codex` returns `codex`.
- Any other text returns `chat`.

The Codex path is a placeholder; no Codex worker is implemented yet.
