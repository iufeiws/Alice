# Scheduler 说明

`core/scheduler` 包含进程内每日调度器。

## 公共类型

```ts
type ScheduledTask = {
  id: string;
  hour: number;
  minute: number;
  run(): Promise<void> | void;
};

type Scheduler = {
  start(): void;
  stop(): void;
};
```

## 函数

- `createDailyScheduler(tasks, now?)`：为每个任务每天调度一次。
- `delayUntilNext(hour, minute, from)`：返回距离下一次运行的毫秒数。
- `createDailyMaintenanceTasks(deps)`：创建核心每日 04:00 维护任务。
- `cleanupPreviousTtsFiles(outputDirs, nowIso, onWarning?)`：删除前一日及更早的生成 TTS 文件。

## 当前用途

`apps/api` 通过 `createDailyMaintenanceTasks` 注册两个核心维护任务：

```text
每日 04:00 -> 删除超过 7 天的系统日志文件
每日 04:00 -> 删除前一日及更早的生成 TTS 文件
```

调度器不持久化，也不是分布式的。错过的执行不会补跑。
