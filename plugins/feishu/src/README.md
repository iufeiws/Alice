# Feishu Source Modules

This directory contains the Feishu channel plugin implementation.

## Module Map

- `index.ts`: plugin factory and AgentCore bridge.
- `client.ts`: Feishu/Lark SDK wrapper for WebSocket events and outbound messages.
- `monitor.ts`: lifecycle facade over the client.
- `handlers/message.ts`: text message normalization.
- `renderer.ts`: `AgentOutput` to Feishu send plan.
- `policy.ts`: Feishu-specific access policy.
- `pairing.ts`: unique binding store.
- `bindings.ts`: chat/thread/user to session id mapping.
- `config.ts`: Feishu config helpers.
- `outbound.ts`: console outbound test sender.
- `types.ts`: Feishu plugin local types.

## Receive Interfaces

```ts
textMessageEventToAgentEvent(raw, bindings, accountId?): Promise<AgentEvent>
```

Parses Feishu text event content, resolves a session id, strips mention keys, and returns a standard `AgentEvent`.

```ts
createInMemoryFeishuBindingStore(): FeishuBindingStore
```

Creates a process-local session binding store. The current binding key format is:

```text
feishu:{dm|group}:{threadId|chatId|userId}
```

## Outbound Interfaces

```ts
renderForFeishu(output): FeishuSendPlan
```

Supports text, markdown, card, image, audio, and file content.

```ts
createFeishuClient(config, deps): FeishuClient
```

Starts the Feishu WebSocket client and sends Feishu messages through `client.im.v1.message.create`.

Media behavior:

- image: `im.v1.image.create` then `msg_type=image`
- audio: `im.v1.file.create(file_type=opus)` then `msg_type=audio`
- file: `im.v1.file.create(file_type=stream)` then `msg_type=file`

## Pairing

```ts
createFeishuPairingStore(path, io): FeishuPairingStore
```

Only one contact can be bound. `pairFromEvent()` accepts the first contact, refreshes the same contact, and rejects all other contacts.

```ts
isPairingCommand(event, config): boolean
```

Current command is read from `FEISHU_PAIRING_COMMAND` or defaults to `/pair alice`.
