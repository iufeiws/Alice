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

## 当前用途

`apps/api` 注册了一个任务：

```text
每日 04:00 -> 删除超过 7 天的系统日志文件
```

调度器不持久化，也不是分布式的。错过的执行不会补跑。
