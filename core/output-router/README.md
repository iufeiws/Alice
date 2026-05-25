# Output Router

`core/output-router` owns channel plugin registration and routes `AgentOutput` to the correct channel plugin.

## Public Interface

```ts
interface OutputRouter {
  register(plugin: ChannelPlugin): void;
  send(output: AgentOutput): Promise<unknown>;
  sendAll(outputs: AgentOutput[]): Promise<unknown[]>;
  listChannels(): string[];
}
```

## Factory

```ts
createOutputRouter(): OutputRouter
```

## Behavior

The target plugin is read from `output.target.plugin`. If no matching channel is registered, `send()` throws. Channel send results are returned to the caller so the message runtime can persist platform ids after successful sends.
