# World Wanderer 到达目标主动事件

日期：2026-07-15

## 背景

World Wanderer 已经会在到达目标坐标附近后清除 `targetLocation`，但这个结果只停留在状态更新和日志里。需要在到达目标时触发一次主动事件，让现有 Core 主动行为链路可以感知这次到达。

## 变更内容

- `runIdleTransition` 在本次 idle transition 到达目标时返回 `targetReached: true`。
- idle timer transition hook 支持返回 generated event。
- heartbeat 收到 idle transition event 后立即执行一次 generated session，并结束本轮 heartbeat，避免同轮再叠加随机主动行为。
- API runtime 在 World Wanderer 到达目标时构造 `agentInitiatedTriggerEvent: "world_wanderer.target_reached"` 的系统 heartbeat 事件。

## 兼容性

- 不新增 prompt 文本，也不改变 prompt layer 顺序。
- 不新增调度器或事件队列。
- 没有默认消息目标时只记录 warn 日志，不触发 Core。

## 验证

已执行：

```bash
node --import tsx --test --test-concurrency=1 tests/contexts/world-wanderer/world-wanderer-policy.test.ts
node --import tsx --test --test-concurrency=1 tests/contexts/agent-loop/agent-loop-runtime-heartbeat.test.ts
npm run typecheck
npm test
```

结果：

- World Wanderer 目标到达标记测试通过。
- heartbeat idle transition event 测试通过。
- TypeScript 类型检查通过。
- 完整测试通过。
