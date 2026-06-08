# Core Policy 说明

`core/policy` 定义平台无关的策略接口。

## 公共接口

```ts
type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

interface PolicyEngine {
  check(event: AgentEvent): Promise<PolicyDecision>;
}
```

## 当前实现

```ts
createAllowAllPolicy(): PolicyEngine
```

AgentCore 当前使用 allow-all policy。飞书特定访问控制，包括绑定和群聊 mention 要求，位于 `plugins/feishu`。
