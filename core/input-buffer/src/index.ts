export type SessionDirtyFlagger = {
  markDirty(sessionId: string): void;
  flushAll(): Promise<void>;
};

export function createSessionDirtyFlagger(
  getDelayMs: () => number,
  processSession: (sessionId: string) => Promise<void> | void
): SessionDirtyFlagger {
  const sessions = new Map<string, { dirty: boolean; processing: boolean; timer?: ReturnType<typeof setTimeout> }>();

  function ensure(sessionId: string) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const state = { dirty: false, processing: false, timer: undefined };
    sessions.set(sessionId, state);
    return state;
  }

  function schedule(sessionId: string): void {
    const state = ensure(sessionId);
    if (state.processing) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void flush(sessionId);
    }, getDelayMs());
  }

  async function flush(sessionId: string): Promise<void> {
    const state = sessions.get(sessionId);
    if (!state || state.processing || !state.dirty) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.dirty = false;
    state.processing = true;

    try {
      await processSession(sessionId);
    } finally {
      state.processing = false;
      if (state.dirty) {
        schedule(sessionId);
      } else {
        sessions.delete(sessionId);
      }
    }
  }

  return {
    markDirty(sessionId) {
      const state = ensure(sessionId);
      state.dirty = true;
      schedule(sessionId);
    },
    async flushAll() {
      await Promise.all([...sessions.keys()].map((sessionId) => flush(sessionId)));
    }
  };
}
