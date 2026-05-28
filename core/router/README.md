# Intent Router 说明

`core/router` 把规范化后的 `AgentEvent` 映射为简单内部 intent。

## 公共接口

```ts
type Intent =
  | { kind: "chat"; text: string }
  | { kind: "codex"; command: string; prompt: string }
  | { kind: "unsupported"; reason: string };

interface IntentRouter {
  route(event: AgentEvent): Intent;
}
```

## 工厂函数

```ts
createIntentRouter(): IntentRouter
```

## 当前规则

- 非文本 payload 返回 `unsupported`。
- 以 `/codex` 开头的文本返回 `codex`。
- 其他文本返回 `chat`。

Codex 路径目前只是占位；还没有实现 Codex worker。
