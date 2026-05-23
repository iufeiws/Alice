export type RecentMessageDeduper = {
  remember(key: string, now?: number): boolean;
};

export function createRecentMessageDeduper(options: { ttlMs?: number; maxEntries?: number } = {}): RecentMessageDeduper {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 1000;
  const seen = new Map<string, number>();

  return {
    remember(key, now = Date.now()) {
      cleanup(now);
      if (seen.has(key)) return false;
      seen.set(key, now);
      if (seen.size > maxEntries) {
        const firstKey = seen.keys().next().value;
        if (firstKey) seen.delete(firstKey);
      }
      return true;
    }
  };

  function cleanup(now: number): void {
    for (const [key, timestamp] of seen) {
      if (now - timestamp > ttlMs) {
        seen.delete(key);
      }
    }
  }
}
