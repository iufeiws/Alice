# Output Router 说明

`core/output-router` 负责注册 Channel Plugin，并把 `AgentOutput` 路由到正确的渠道插件。

## 公共接口

```ts
interface OutputRouter {
  register(plugin: ChannelPlugin): void;
  send(output: AgentOutput): Promise<unknown>;
  sendAll(outputs: AgentOutput[]): Promise<unknown[]>;
  listChannels(): string[];
}
```

## 工厂函数

```ts
createOutputRouter(): OutputRouter
```

## 行为

目标插件来自 `output.target.plugin`。如果没有匹配渠道，`send()` 会抛错。渠道发送结果会返回给调用方，方便消息运行时在发送成功后持久化平台消息 id。
