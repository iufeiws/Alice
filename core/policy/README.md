# Core Policy

`core/policy` defines the platform-independent policy interface.

## Public Interface

```ts
type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

interface PolicyEngine {
  check(event: AgentEvent): Promise<PolicyDecision>;
}
```

## Current Implementation

```ts
createAllowAllPolicy(): PolicyEngine
```

AgentCore currently uses allow-all policy. Feishu-specific access control, including pairing and group mention requirements, lives in `plugins/feishu`.
