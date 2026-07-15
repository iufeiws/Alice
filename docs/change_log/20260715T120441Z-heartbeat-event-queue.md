# Heartbeat 主动事件队列与领域 Tick 拆分

日期：2026-07-15

## 背景

heartbeat 原先直接包含 World Wanderer、随机主动行为、Talk、Sleep Cocoon、日历和待处理消息的领域编排，同时部分业务路径会尝试即时调度 heartbeat。这样既让 heartbeat 承担了领域职责，也没有形成统一的主动事件交接方式。

## 变更内容

- heartbeat 仅保留定时、暂停、恢复以及依次发起通用 `AgentHeartbeatTick` 的职责。
- World Wanderer、随机主动行为、Talk、Sleep Cocoon 和日历分别在所属模块暴露 heartbeat tick。
- conversation-hub 仅注册 tick 的执行顺序，并保留自身的待处理消息 tick。
- 新增进程内主动事件 FIFO；领域 tick 只生成并入队事件，消费 tick 每轮最多领取并执行一个事件。
- Sleep Cocoon 的 wake/force-wake 待处理事件由单槽改为 FIFO，连续事件不再互相覆盖。
- 删除消息入站和 Agent 状态变化对 heartbeat 的即时调度；heartbeat 只由启动、正常周期和管理员 resume 发起。
- World Wanderer 与随机主动事件的构造逻辑迁回各自 context。
- 管理端 `processNow` 的手动 session fallback 留在 conversation-hub，不进入 heartbeat 接口。

## 兼容性

- 保留 heartbeat 现有 pause/resume、默认暂停配置和“事务完成后再等待一个周期”的调度语义。
- 主动事件队列仅驻留内存，服务重启时不保留未消费事件。
- 事件领取后执行失败不会自动重新入队。
- 用户消息继续使用 SQLite 未处理记录，Talk 继续使用现有 ready session 状态。
- 未修改任何 prompt 文本、prompt layer 或 LLM 消息顺序。

## 验证

已执行：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

结果：类型检查、完整测试、构建和差异格式检查均通过。
