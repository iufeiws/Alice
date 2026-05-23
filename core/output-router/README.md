# Output Router

`core/output-router` owns channel plugin registration and routes `AgentOutput` to the correct channel plugin.

## Public Interface

```ts
interface OutputRouter {
  register(plugin: ChannelPlugin): void;
  send(output: AgentOutput): Promise<void>;
  sendAll(outputs: AgentOutput[]): Promise<void>;
  listChannels(): string[];
}
```

## Factory

```ts
createOutputRouter(): OutputRouter
```

## Behavior

The target plugin is read from `output.target.plugin`. If no matching channel is registered, `send()` throws.
