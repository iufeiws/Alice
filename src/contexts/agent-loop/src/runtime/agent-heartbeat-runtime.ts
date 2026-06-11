export type AgentHeartbeatRuntime = {
  schedule(delayMs?: number): void;
  clear(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  isScheduled(): boolean;
  run(options?: { force?: boolean }): Promise<number>;
  flush(): void;
};

export function createAgentHeartbeatRuntime(input: {
  getIntervalMs(): number;
  startPaused?: boolean;
  run(options?: { force?: boolean }): Promise<number>;
  onPausedChange?(paused: boolean): void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}): AgentHeartbeatRuntime {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = input.startPaused === true;

  return {
    schedule(delayMs = input.getIntervalMs()) {
      if (paused) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void input.run();
      }, Math.max(0, delayMs));
      (timer as { unref?: () => void }).unref?.();
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
      return input.run(options);
    },
    flush() {
      this.clear();
    }
  };

  function persistPaused(): void {
    try {
      input.onPausedChange?.(paused);
    } catch (error) {
      input.appendLog("warn", `agent heartbeat state persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
