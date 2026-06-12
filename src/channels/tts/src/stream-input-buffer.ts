export type TtsStreamInputBufferOptions = {
  minChars: number;
  allowCrossNewline: boolean;
  onIdle?(): void | Promise<void>;
};

const TTS_SENTENCE_ENDING_PATTERN = /[。！？.!?．]/u;

export async function* bufferTtsStreamInput(
  text: AsyncIterable<string> | Iterable<string> | string,
  options: TtsStreamInputBufferOptions
): AsyncIterable<string> {
  const state = createTtsStreamInputBuffer(options);
  const notifyIdle = () => {
    if (state.pendingChars() !== 0) return;
    void options.onIdle?.();
  };
  for await (const chunk of iterateTextChunks(text)) {
    const parts = state.push(chunk);
    if (parts.length > 0) notifyIdle();
    for (const part of parts) yield part;
  }
  const parts = state.finish();
  if (parts.length > 0 || state.pendingChars() === 0) notifyIdle();
  for (const part of parts) yield part;
}

export function createTtsStreamInputBuffer(options: TtsStreamInputBufferOptions): {
  push(chunk: string): string[];
  finish(): string[];
  pendingChars(): number;
} {
  const minChars = Math.max(1, Math.floor(options.minChars));
  const ready: string[] = [];
  let pending = "";
  let canMergeShortPendingWithPrevious = false;

  const emitAvailable = (): string[] => {
    const out: string[] = [];
    while (ready.length > 1) out.push(ready.shift()!);
    return out;
  };
  const pushReady = (value: string): void => {
    const normalized = normalizeBufferedPart(value);
    if (!normalized) return;
    if (options.allowCrossNewline && ready.length > 0 && ready[ready.length - 1]!.endsWith("\n")) {
      ready[ready.length - 1] = `${ready[ready.length - 1]}${normalized}`;
      canMergeShortPendingWithPrevious = true;
      return;
    }
    ready.push(normalized);
    canMergeShortPendingWithPrevious = true;
  };
  const finishPending = (allowShortMerge: boolean): void => {
    const normalized = normalizeBufferedPart(pending);
    pending = "";
    if (!normalized) return;
    if (allowShortMerge && canMergeShortPendingWithPrevious && ready.length > 0 && charLength(normalized) < minChars) {
      ready[ready.length - 1] = `${ready[ready.length - 1]}${normalized}`;
      return;
    }
    ready.push(normalized);
    canMergeShortPendingWithPrevious = true;
  };

  return {
    push(chunk) {
      const out: string[] = [];
      for (const char of Array.from(normalizeNewlines(chunk))) {
        if (char === "\n") {
          if (options.allowCrossNewline) {
            if (pending.trim()) pending += "\n";
            else if (ready.length > 0 && !ready[ready.length - 1]!.endsWith("\n")) ready[ready.length - 1] = `${ready[ready.length - 1]}\n`;
            continue;
          }
          finishPending(true);
          canMergeShortPendingWithPrevious = false;
          if (!options.allowCrossNewline) out.push(...emitAvailable());
          continue;
        }
        pending += char;
        if (isSpeechBoundary(char) && charLength(pending) >= minChars) {
          pushReady(pending);
          pending = "";
          out.push(...emitAvailable());
        }
      }
      return out;
    },
    finish() {
      finishPending(options.allowCrossNewline || canMergeShortPendingWithPrevious);
      const out = ready.splice(0, ready.length);
      return out.map((part) => normalizeBufferedPart(part)).filter(Boolean);
    },
    pendingChars() {
      return ready.reduce((sum, part) => sum + charLength(part), 0) + charLength(pending);
    }
  };
}

function normalizeNewlines(value: string): string {
  return String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeBufferedPart(value: string): string {
  return normalizeNewlines(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function isSpeechBoundary(char: string): boolean {
  return TTS_SENTENCE_ENDING_PATTERN.test(char);
}

function charLength(value: string): number {
  return Array.from(value).length;
}

async function* iterateTextChunks(text: AsyncIterable<string> | Iterable<string> | string): AsyncIterable<string> {
  if (typeof text === "string") {
    yield text;
    return;
  }
  for await (const chunk of text as AsyncIterable<string>) {
    if (chunk) yield String(chunk);
  }
}
