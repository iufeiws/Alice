export function copyUint8Array(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

export function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}

export function normalizeTypedInputText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F\u200B-\u200D\u2060\uFEFF\uFFFC]/g, "")
    .trim();
}

export function splitTtsPseudoStreamParts(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const matches = normalized.match(/[^。！？.!?\n]+[。！？.!?]?|\n+/g) ?? [normalized];
  const parts = matches
    .map((part) => part.trim())
    .filter((part) => part && !/^\n+$/.test(part));
  return parts.length ? parts : [normalized];
}

export function stripParenthesizedText(text: string): string {
  let depth = 0;
  let output = "";
  for (const char of Array.from(text)) {
    if (char === "(" || char === "（") {
      depth += 1;
      continue;
    }
    if ((char === ")" || char === "）") && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) output += char;
  }
  return output
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？、,.!?])/g, "$1")
    .trim();
}

export function createAsyncQueue<T>() {
  const items: T[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let error: unknown;
  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  return {
    get length() {
      return items.length;
    },
    get closed() {
      return closed;
    },
    push(item: T) {
      if (closed) return;
      items.push(item);
      notify();
    },
    shift() {
      if (error) throw error;
      return items.shift();
    },
    shiftWhere(predicate: (item: T) => boolean) {
      if (error) throw error;
      const index = items.findIndex(predicate);
      if (index < 0) return undefined;
      return items.splice(index, 1)[0];
    },
    removeWhere(predicate: (item: T) => boolean) {
      let removed = 0;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (!predicate(items[index]!)) continue;
        items.splice(index, 1);
        removed += 1;
      }
      return removed;
    },
    close() {
      closed = true;
      notify();
    },
    fail(cause: unknown) {
      error = cause;
      closed = true;
      notify();
    },
    async waitFor(predicate: () => boolean) {
      while (!predicate()) {
        if (error) throw error;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      if (error) throw error;
    }
  };
}

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "operation_aborted");
}

export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

export async function* abortableAsyncIterable<T>(iterable: AsyncIterable<T>, signal: AbortSignal): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      let result: IteratorResult<T>;
      try {
        result = await raceWithAbort(iterator.next(), signal);
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }
      if (result.done) break;
      yield result.value;
    }
  } finally {
    if (signal.aborted) {
      try {
        await iterator.return?.();
      } catch {
        // Best-effort cancellation for provider-side async generators.
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
