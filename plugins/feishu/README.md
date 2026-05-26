# Feishu Plugin

Channel plugin for Feishu/Lark. It is responsible for Feishu WebSocket connection, message normalization, unique user pairing, Feishu-specific policy, and outbound rendering/sending.

## Public Entry

```ts
createFeishuPlugin(config, deps): ChannelPlugin & {
  ingestTextMessage(raw: FeishuTextMessageEvent): Promise<void>;
}
```

`deps` includes:

- `onEvent(event)`: passes normalized events into AgentCore.
- `onLifecycleEvent(event)`: records message-state updates such as reactions, read receipts, and recalls.
- `log(level, message)`: writes system/debug logs.
- `pairingStore`: stores the unique bound Feishu contact.
- `outbound`: optional test/mocked sender.

## Receive Flow

```text
Feishu WS im.message.receive_v1
  -> createFeishuClient()
  -> createFeishuMonitor()
  -> textMessageEventToAgentEvent()
  -> pairing command or policy check
  -> message event log for debug
  -> messages table for Core context
  -> deps.onEvent(event)
```

Only text normalization is implemented for inbound messages.

The WebSocket client also subscribes to message lifecycle callbacks:

- `im.message.reaction.created_v1`
- `im.message.reaction.deleted_v1`
- `im.message.message_read_v1`
- `im.message.recalled_v1`

These callbacks are not exposed to Core as standalone messages. They update the matching row in the Core-facing `messages` table by Feishu message id:

- reactions update `reactions_json`;
- read receipts update `is_read` and `read_at`;
- recalls update `is_recalled` and `recalled_at`.

Each lifecycle callback is also written to the append-only message event log for debugging.

## Pairing

Command:

```text
/pair alice
```

The first successful pairing becomes the unique bound user/contact. The binding is stored in:

```text
memory-files/indexes/feishu-paired-contacts.json
```

Other users are rejected after a unique binding exists.

## Outbound Support

`renderForFeishu(output)` converts `AgentOutput` to `FeishuSendPlan`.

Supported send kinds:

- `text`: Feishu text message.
- `markdown`: Feishu interactive card with markdown element.
- `image`: upload local path then send image.
- `audio`: upload local opus file then send audio.
- `file`: upload local path then send file.

For media, `assetId` currently means a local file path or `file://` path.

## Agent Messaging Tools

AgentCore exposes platform-neutral tool names to the LLM. Feishu is the current adapter behind those tools:

- `view_messages`
  - args: `scope?: "today" | "new"`; default `today`.
  - legacy typo `scpe` is accepted as an alias.
  - `new` uses a persisted per-conversation cursor.
  - output is a plain string for the LLM; lines use: `[{local time}] user/Alice:{content}[reaction][已撤回]`.
  - no new messages returns `nothing new`.
- `search_messages`
  - args: `content`, `direction?: "backward" | "forward"`, `limit?: number`, `contextCount?: number`.
  - defaults: `direction="backward"`, `limit=3`, `contextCount=10`.
  - Chinese aliases are accepted: `从后到前`, `从前到后`.
  - searches persisted Feishu messages through SQLite FTS5.
  - output is plain context text, not JSON.
- `send_message`
  - args: `type?: "message" | "markdown" | "image"`, `content`.
  - default `type` is `message`.
  - in `message` mode, newline-separated content is split into multiple Feishu text messages.
  - split text messages are sent 500 ms apart.
  - with streaming LLM responses, each decoded newline in `content` is sent immediately instead of waiting for the final JSON tool arguments.
  - `voice` is intentionally unsupported.

## Key Functions

- `createFeishuClient(config, deps)`: wraps Feishu SDK `Client` and `WSClient`.
- `createFeishuMonitor(config, deps)`: lifecycle facade around the client.
- `textMessageEventToAgentEvent(raw, bindings, accountId)`: maps Feishu text events into `AgentEvent`.
- `reactionEventToLifecycleEvent(raw, kind)`: maps Feishu reaction callbacks into message-state updates.
- `readEventToLifecycleEvent(raw)`: maps Feishu read callbacks into message-state updates.
- `recalledEventToLifecycleEvent(raw)`: maps Feishu recall callbacks into message-state updates.
- `checkFeishuEventPolicy(config, event)`: DM/group policy check.
- `createFeishuPairingStore(path, io)`: unique binding store.
- `renderForFeishu(output)`: outbound plan renderer.
