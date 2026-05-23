# Scheduler

`core/scheduler` contains a process-local daily scheduler.

## Public Types

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

## Functions

- `createDailyScheduler(tasks, now?)`: schedules each task once per day.
- `delayUntilNext(hour, minute, from)`: returns the delay in milliseconds until the next run.

## Current Use

`apps/api` registers one task:

```text
04:00 daily -> delete system log files older than seven days
```

The scheduler is not persisted or distributed. Missed executions are not replayed.
