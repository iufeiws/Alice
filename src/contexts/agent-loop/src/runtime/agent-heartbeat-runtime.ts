import { describeError } from "../../../../shared/errors/src/index.js";

export type AgentHeartbeatRuntime = {
  schedule(delayMs?: number): void;
  clear(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  isScheduled(): boolean;
  run(options?: AgentHeartbeatRunOptions): Promise<number>;
  flush(): void;
};

export type AgentHeartbeatRunOptions = {
  force?: boolean;
};

export type AgentHeartbeatTickResult = { processed?: number; stop?: boolean } | void;
export type AgentHeartbeatTick = (options: AgentHeartbeatRunOptions) => Promise<AgentHeartbeatTickResult> | AgentHeartbeatTickResult;

export function createAgentHeartbeatRuntime(input: {
  getIntervalMs(): number;
  startPaused?: boolean;
  ticks: AgentHeartbeatTick[];
  onPausedChange?(paused: boolean): void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}): AgentHeartbeatRuntime {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = input.startPaused === true;

  return {
    schedule(delayMs = input.getIntervalMs()) {
      scheduleTimer(delayMs);
    },
    clear() {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
    },
    pause() {
      paused = true;
      persistPaused();
      this.clear();
      input.appendLog("info", "agent heartbeat paused");
    },
    resume() {
      paused = false;
      persistPaused();
      input.appendLog("info", "agent heartbeat resumed");
      this.schedule(0);
    },
    isPaused() {
      return paused;
    },
    isScheduled() {
      return Boolean(timer);
    },
    run(options) {
      return run(options);
    },
    flush() {
      this.clear();
    }
  };

  function persistPaused(): void {
    try {
      input.onPausedChange?.(paused);
    } catch (error) {
      input.appendLog("warn", `agent heartbeat state persist failed: ${describeError(error)}`);
    }
  }

  async function run(options: AgentHeartbeatRunOptions = {}): Promise<number> {
    try {
      let processed = 0;
      for (const tick of input.ticks) {
        const result = await tick(options);
        processed += result?.processed ?? 0;
        if (result?.stop) break;
      }
      return processed;
    } finally {
      if (options.force !== true) {
        scheduleTimer(input.getIntervalMs());
      }
    }
  }

  function scheduleTimer(delayMs: number): void {
    if (paused) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run().catch((error) => {
        input.appendLog("error", `agent heartbeat failed: ${describeError(error)}`);
      });
    }, Math.max(0, delayMs));
    (timer as { unref?: () => void }).unref?.();
  }
}
