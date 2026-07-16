# Heartbeat 主动事件队列与领域 Tick 拆分（已取消）

日期：2026-07-15

状态：已取消并完整回退。

## 原计划

原计划将 heartbeat 精简为通用 tick 发起器，并引入进程内主动事件 FIFO，把 World Wanderer、随机主动行为、Talk、Sleep Cocoon、日历和 conversation pending 处理拆成独立 tick。

## 取消原因

- `AgentHeartbeatTick[]` 把主动事件生产、Talk ready session、事件消费和 pending conversation 处理错误地抽象成同一种职责。
- 改动没有保留原有通过 Agent state、Agent loop running、Talk ready/claim 和 conversation pending/processing 状态实现互斥的结构。
- 新增抽象没有降低领域耦合，反而模糊了原有执行语义。

## 回退结果

- 完整恢复变更前的 heartbeat 与 message runtime 实现。
- 删除主动事件 FIFO、领域 tick 和相关测试。
- 不影响后续独立提交的 prompt 配置修改。

## 验证

回退后执行：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```
