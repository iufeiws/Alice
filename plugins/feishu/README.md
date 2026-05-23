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
  -> deps.onEvent(event)
```

Only text normalization is implemented for inbound messages.

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

## Key Functions

- `createFeishuClient(config, deps)`: wraps Feishu SDK `Client` and `WSClient`.
- `createFeishuMonitor(config, deps)`: lifecycle facade around the client.
- `textMessageEventToAgentEvent(raw, bindings, accountId)`: maps Feishu text events into `AgentEvent`.
- `checkFeishuEventPolicy(config, event)`: DM/group policy check.
- `createFeishuPairingStore(path, io)`: unique binding store.
- `renderForFeishu(output)`: outbound plan renderer.
