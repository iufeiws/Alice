export type ScheduledTask = {
  id: string;
  hour: number;
  minute: number;
  run(): Promise<void> | void;
};

export type Scheduler = {
  start(): void;
  stop(): void;
};

export function createDailyScheduler(tasks: ScheduledTask[], now = () => new Date()): Scheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function schedule(task: ScheduledTask): void {
    const delay = delayUntilNext(task.hour, task.minute, now());
    const timer = setTimeout(async () => {
      try {
        await task.run();
      } finally {
        schedule(task);
      }
    }, delay);
    timers.set(task.id, timer);
  }

  return {
    start() {
      for (const task of tasks) schedule(task);
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
  };
}

export function delayUntilNext(hour: number, minute: number, from: Date): number {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next <= from) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - from.getTime();
}
