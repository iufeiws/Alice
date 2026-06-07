import type { LLMMessage } from "../../../core/llm/src/index.js";
import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import type {
  TalkEvent,
  TalkOutputChunk,
  TalkOutputInterrupt,
  TalkSource,
  TalkStore
} from "../../../packages/storage/src/talk-store.js";

export type TalkRuntime = {
  store: TalkStore;
  openSession(input: TalkSessionOpenInput): TalkSessionOpenResult;
  closeSession(input: { sessionId: string; occurredAt?: string; occurredAtUtc?: string }): void;
  startAgentLoop(sessionId: string): void;
  ingestInput(event: TalkEvent): void;
  commitStableInputBatch(batch: StableInputBatch): void;
  appendAssistantDelta(input: { sessionId: string; outputId: string; delta: string }): void;
  finishAssistantOutput(input: { sessionId: string; outputId: string }): void;
  claimReadyOutputChunk(sessionId: string): TalkOutputChunk | undefined;
  markOutputChunkPlayed(input: { sessionId: string; chunkId: string }): void;
  interruptOutput(input: {
    sessionId: string;
    outputId: string;
    reason: "barge_in" | "manual" | "network" | "unknown";
    elapsedMs?: number;
    totalMs?: number;
    breakpointContext?: { beforeText?: string; afterText?: string };
    omitAssistantMessage?: boolean;
    breakMarker?: string;
  }): TalkOutputInterrupt;
  interruptLatestOutput(input: {
    sessionId: string;
    reason: "barge_in" | "manual" | "network" | "unknown";
    elapsedMs?: number;
    totalMs?: number;
    breakpointContext?: { beforeText?: string; afterText?: string };
    omitAssistantMessage?: boolean;
    breakMarker?: string;
  }): TalkOutputInterrupt | undefined;
  buildNextLoopMessages(sessionId: string): LLMMessage[];
};

export type TalkSessionOpenInput = {
  sessionId?: string;
  source: TalkSource;
  occurredAt?: string;
  occurredAtUtc?: string;
  metadata?: unknown;
};

export type TalkSessionOpenResult = {
  sessionId: string;
};

export type StableInputBatch = {
  sessionId: string;
  batchId: string;
  interruptEpoch: number;
  inputs: StableInputItem[];
};

export type StableInputItem = {
  interruptId: string;
  sequence: number;
  reason: "barge_in" | "manual" | "asr_failure" | "call_close";
  asrStreamId?: string;
  text: string;
  occurredAt: string;
  occurredAtUtc?: string;
  targetOutputId?: string;
  targetChunkId?: string;
};

export type TalkRuntimeDeps = {
  store: TalkStore;
  time: CurrentTimeProvider;
  breakMarker?: string;
  readyChars?: number;
  createLLMSession?(input: {
    occurredAt: string;
    occurredAtUtc?: string;
    source: TalkSource;
    metadata?: unknown;
  }): string | number;
  runAgentLoop?(sessionId: string): Promise<void> | void;
  interruptAgentLoop?(sessionId: string, outputId: string): Promise<void> | void;
};

const defaultReadyChars = 12;

export function createTalkRuntime(deps: TalkRuntimeDeps): TalkRuntime {
  const breakMarker = deps.breakMarker ?? "...";
  const readyChars = deps.readyChars ?? defaultReadyChars;

  const runtime: TalkRuntime = {
    store: deps.store,
    openSession(input) {
      const now = current(deps.time);
      const occurredAt = input.occurredAt ?? now.occurredAt;
      const occurredAtUtc = input.occurredAtUtc ?? now.occurredAtUtc;
      const sessionId = String(deps.createLLMSession?.({
        occurredAt,
        occurredAtUtc,
        source: input.source,
        metadata: input.metadata
      }) ?? input.sessionId ?? `talk:${Date.now()}:${Math.random().toString(16).slice(2)}`);
      deps.store.openSession({
        sessionId,
        source: input.source,
        occurredAt,
        occurredAtUtc,
        metadata: input.metadata
      });
      deps.store.insertEvent({
        kind: "session.started",
        sessionId,
        source: input.source,
        sequence: 0,
        occurredAt,
        occurredAtUtc,
        payload: { kind: "session", ...(typeof input.metadata === "object" && input.metadata ? input.metadata : {}) }
      });
      return { sessionId };
    },
    closeSession(input) {
      assertSessionExists(deps.store, input.sessionId);
      const now = current(deps.time);
      deps.store.closeSession({
        sessionId: input.sessionId,
        occurredAt: input.occurredAt ?? now.occurredAt,
        occurredAtUtc: input.occurredAtUtc ?? now.occurredAtUtc
      });
    },
    startAgentLoop(sessionId) {
      assertOpenSession(deps.store, sessionId);
      if (deps.store.latestUnresolvedInterrupt(sessionId)) return;
      void deps.runAgentLoop?.(sessionId);
    },
    ingestInput(event) {
      assertOpenSession(deps.store, event.sessionId);
      const inserted = deps.store.insertEvent(event);
      if (!inserted.inserted) return;
      if (event.kind === "audio.transcript.final" || event.kind === "text.final") {
        const text = payloadText(event.payload);
        if (!text) return;
        const segment = deps.store.insertSegment({
          sessionId: event.sessionId,
          eventId: inserted.id,
          segmentId: segmentId(event.kind, inserted.id),
          role: "user",
          kind: event.kind === "audio.transcript.final" ? "transcript" : "text",
          contentText: text,
          contentJson: event.payload,
          endedAt: event.occurredAt,
          endedAtUtc: event.occurredAtUtc
        });
        deps.store.resolveLatestInterrupt({
          sessionId: event.sessionId,
          finalUserSegmentId: segment.segmentId ?? String(segment.id),
          now: event.occurredAt,
          nowUtc: event.occurredAtUtc
        });
        void deps.runAgentLoop?.(event.sessionId);
      } else if (event.kind === "input.interrupted") {
        deps.store.insertSegment({
          sessionId: event.sessionId,
          eventId: inserted.id,
          segmentId: segmentId(event.kind, inserted.id),
          role: "user",
          kind: "interrupt",
          contentText: interruptReason(event.payload),
          contentJson: event.payload,
          endedAt: event.occurredAt,
          endedAtUtc: event.occurredAtUtc
        });
      }
    },
    commitStableInputBatch(batch) {
      assertOpenSession(deps.store, batch.sessionId);
      if (batch.inputs.length === 0) return;
      const commit = () => {
        const ordered = [...batch.inputs].sort((a, b) => a.sequence - b.sequence);
        for (const item of ordered) {
          const event = deps.store.insertEvent({
            kind: item.reason === "manual" ? "text.final" : "audio.transcript.final",
            sessionId: batch.sessionId,
            source: { plugin: "webrtc_voice" },
            sequence: item.sequence,
            occurredAt: item.occurredAt,
            occurredAtUtc: item.occurredAtUtc,
            payload: {
              kind: item.reason === "manual" ? "text" : "transcript",
              text: item.text,
              interruptId: item.interruptId,
              batchId: batch.batchId,
              interruptEpoch: batch.interruptEpoch,
              reason: item.reason,
              targetOutputId: item.targetOutputId,
              targetChunkId: item.targetChunkId
            },
            raw: { asrStreamId: item.asrStreamId }
          });
          if (!event.inserted) continue;
          const segment = deps.store.insertSegment({
            sessionId: batch.sessionId,
            eventId: event.id,
            segmentId: `stable:${batch.batchId}:${item.interruptId}`,
            role: "user",
            kind: item.reason === "manual" ? "text" : "transcript",
            contentText: item.text,
            contentJson: {
              batchId: batch.batchId,
              interruptId: item.interruptId,
              interruptEpoch: batch.interruptEpoch,
              reason: item.reason,
              asrStreamId: item.asrStreamId,
              targetOutputId: item.targetOutputId,
              targetChunkId: item.targetChunkId
            },
            endedAt: item.occurredAt,
            endedAtUtc: item.occurredAtUtc
          });
          deps.store.resolveInterrupt({
            interruptId: item.interruptId,
            finalUserSegmentId: segment.segmentId ?? String(segment.id),
            now: item.occurredAt,
            nowUtc: item.occurredAtUtc
          });
        }
      };
      if (deps.store.transaction) deps.store.transaction(commit);
      else commit();
      void deps.runAgentLoop?.(batch.sessionId);
    },
    appendAssistantDelta(input) {
      if (!input.delta) return;
      assertOpenSession(deps.store, input.sessionId);
      const now = current(deps.time);
      let output = deps.store.ensureOutput({
        sessionId: input.sessionId,
        outputId: input.outputId,
        now: now.occurredAt,
        nowUtc: now.occurredAtUtc
      });
      if (output.status === "interrupted" || output.status === "cancelled") return;

      const oldFullLength = charLength(output.fullText);
      const fullText = output.fullText + input.delta;
      const visibleText = fullText;
      const speechDelta = speechDeltaForOutput(input.delta, output.fullText);
      let bufferText = output.bufferText + speechDelta;
      let pendingChunkText = output.pendingChunkText;
      let pendingChunkStartCharIndex = output.pendingChunkStartCharIndex;
      let nextChunkSequence = output.nextChunkSequence;
      let bufferStartCharIndex = oldFullLength - charLength(output.bufferText);

      while (true) {
        const boundary = firstBoundaryIndex(bufferText);
        if (boundary < 0) break;
        const chars = Array.from(bufferText);
        const piece = chars.slice(0, boundary + 1).join("");
        const remaining = chars.slice(boundary + 1).join("");
        if (!pendingChunkText) pendingChunkStartCharIndex = bufferStartCharIndex;
        pendingChunkText += piece;
        const pendingEndCharIndex = bufferStartCharIndex + charLength(piece);
        bufferText = remaining;
        bufferStartCharIndex = pendingEndCharIndex;
        if (charLength(pendingChunkText) >= readyChars) {
          deps.store.insertReadyChunk({
            sessionId: input.sessionId,
            outputId: input.outputId,
            sequence: nextChunkSequence,
            text: pendingChunkText,
            startCharIndex: pendingChunkStartCharIndex,
            endCharIndex: pendingEndCharIndex,
            now: now.occurredAt,
            nowUtc: now.occurredAtUtc
          });
          nextChunkSequence += 1;
          pendingChunkText = "";
          pendingChunkStartCharIndex = pendingEndCharIndex;
        }
      }

      output = deps.store.updateOutput({
        outputId: input.outputId,
        fullText,
        visibleText,
        bufferText,
        pendingChunkText,
        pendingChunkStartCharIndex,
        nextChunkSequence
      });
      void output;
    },
    finishAssistantOutput(input) {
      assertOpenSession(deps.store, input.sessionId);
      const now = current(deps.time);
      const output = deps.store.getOutput(input.outputId);
      if (!output || output.status === "interrupted" || output.status === "cancelled") return;
      assertOutputSession(output.sessionId, input.sessionId, input.outputId);
      const tail = output.pendingChunkText + output.bufferText;
      let nextChunkSequence = output.nextChunkSequence;
      if (tail) {
        const tailStart = output.pendingChunkText
          ? output.pendingChunkStartCharIndex
          : charLength(output.fullText) - charLength(output.bufferText);
        deps.store.insertReadyChunk({
          sessionId: input.sessionId,
          outputId: input.outputId,
          sequence: nextChunkSequence,
          text: tail,
          startCharIndex: tailStart,
          endCharIndex: tailStart + charLength(tail),
          now: now.occurredAt,
          nowUtc: now.occurredAtUtc
        });
        nextChunkSequence += 1;
      }
      const segment = deps.store.insertSegment({
        sessionId: input.sessionId,
        segmentId: `assistant:${input.outputId}`,
        role: "assistant",
        kind: "assistant.output",
        contentText: output.fullText,
        contentJson: { outputId: input.outputId, interrupted: false },
        endedAt: now.occurredAt,
        endedAtUtc: now.occurredAtUtc
      });
      deps.store.updateOutput({
        outputId: input.outputId,
        segmentId: segment.segmentId,
        status: "finished",
        visibleText: output.fullText,
        bufferText: "",
        pendingChunkText: "",
        nextChunkSequence
      });
    },
    claimReadyOutputChunk(sessionId) {
      assertOpenSession(deps.store, sessionId);
      const now = current(deps.time);
      return deps.store.claimReadyOutputChunk(sessionId, now.occurredAt, now.occurredAtUtc);
    },
    markOutputChunkPlayed(input) {
      assertOpenSession(deps.store, input.sessionId);
      const now = current(deps.time);
      deps.store.markChunkPlayed({
        sessionId: input.sessionId,
        chunkId: input.chunkId,
        now: now.occurredAt,
        nowUtc: now.occurredAtUtc
      });
    },
    interruptLatestOutput(input) {
      assertOpenSession(deps.store, input.sessionId);
      const output = deps.store.latestOutput(input.sessionId);
      if (!output) return undefined;
      return runtime.interruptOutput({
        ...input,
        outputId: output.outputId
      });
    },
    interruptOutput(input) {
      assertOpenSession(deps.store, input.sessionId);
      const now = current(deps.time);
      const output = deps.store.getOutput(input.outputId);
      if (!output) throw new Error(`talk output not found: ${input.outputId}`);
      assertOutputSession(output.sessionId, input.sessionId, input.outputId);
      const originalText = output.fullText;
      const originalLength = charLength(originalText);
      const contextBreakpointCharIndex = breakpointCharIndexFromContext(originalText, input.breakpointContext);
      const playedRatio = contextBreakpointCharIndex === undefined ? ratio(input.elapsedMs, input.totalMs) : undefined;
      const breakpointCharIndex = clampIndex(
        contextBreakpointCharIndex ?? Math.floor(originalLength * (playedRatio ?? 0)),
        originalLength
      );
      const visibleText = sliceChars(originalText, 0, breakpointCharIndex);
      const discardedText = sliceChars(originalText, breakpointCharIndex);
      const interruptId = `interrupt:${input.outputId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const discardId = `discard:${input.outputId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const marker = input.breakMarker ?? breakMarker;
      deps.store.cancelChunks(input.outputId, now.occurredAt, now.occurredAtUtc);
      deps.store.cancelOtherSessionOutputs(input.sessionId, input.outputId, now.occurredAt, now.occurredAtUtc);
      deps.store.insertDiscard({
        discardId,
        sessionId: input.sessionId,
        outputId: input.outputId,
        interruptId,
        breakpointCharIndex,
        discardedText,
        reason: input.reason,
        now: now.occurredAt,
        nowUtc: now.occurredAtUtc,
        metadata: { elapsedMs: input.elapsedMs, totalMs: input.totalMs, breakpointContext: input.breakpointContext }
      });
      const event = deps.store.insertEvent({
        kind: "input.interrupted",
        sessionId: input.sessionId,
        source: { plugin: "talk_runtime" },
        sequence: nextSyntheticSequence(),
        occurredAt: now.occurredAt,
        occurredAtUtc: now.occurredAtUtc,
        payload: { kind: "interrupt", reason: input.reason, targetOutputId: input.outputId }
      });
      const segment = deps.store.insertSegment({
        sessionId: input.sessionId,
        eventId: event.id,
        segmentId: `interrupt:${interruptId}`,
        role: "user",
        kind: "interrupt",
        contentText: input.reason,
        contentJson: { interruptId, outputId: input.outputId, discardId, breakpointCharIndex, breakMarker: marker, breakpointContext: input.breakpointContext, omitAssistantMessage: input.omitAssistantMessage === true },
        endedAt: now.occurredAt,
        endedAtUtc: now.occurredAtUtc
      });
      const assistantSegment = input.omitAssistantMessage ? undefined : deps.store.insertSegment({
        sessionId: input.sessionId,
        segmentId: `assistant:${input.outputId}`,
        role: "assistant",
        kind: "assistant.output",
        contentText: visibleText,
        contentJson: { outputId: input.outputId, interrupted: true, interruptId, discardId, breakMarker: marker },
        endedAt: now.occurredAt,
        endedAtUtc: now.occurredAtUtc
      });
      deps.store.updateOutput({
        outputId: input.outputId,
        segmentId: assistantSegment?.segmentId,
        status: input.omitAssistantMessage ? "cancelled" : "interrupted",
        fullText: visibleText,
        visibleText,
        bufferText: "",
        pendingChunkText: ""
      });
      const interrupt = deps.store.insertInterrupt({
        interruptId,
        sessionId: input.sessionId,
        outputId: input.outputId,
        eventId: event.id,
        segmentId: segment.segmentId,
        reason: input.reason,
        breakpointCharIndex,
        playedMs: input.elapsedMs,
        totalMs: input.totalMs,
        playedRatio,
        visibleText,
        discardId,
        breakMarker: marker,
        metadata: { breakpointContext: input.breakpointContext, omitAssistantMessage: input.omitAssistantMessage === true },
        now: now.occurredAt,
        nowUtc: now.occurredAtUtc
      });
      void deps.interruptAgentLoop?.(input.sessionId, input.outputId);
      return interrupt;
    },
    buildNextLoopMessages(sessionId) {
      assertSessionExists(deps.store, sessionId);
      const latestInterrupt = deps.store.latestUnresolvedInterrupt(sessionId);
      const segments = deps.store.listSegments(sessionId).filter((segment) => segment.kind !== "interrupt");
      const messages: LLMMessage[] = [];
      for (const segment of segments) {
        if (segment.role === "assistant") {
          const metadata = parseJsonObject(segment.contentJson);
          const outputId = stringValue(metadata.outputId);
          if (outputId && deps.store.getOutput(outputId)?.status === "cancelled") continue;
          if (metadata.interrupted === true) {
            messages.push({ role: "assistant" as const, content: `${segment.contentText}${stringValue(metadata.breakMarker) || breakMarker}` });
            continue;
          }
          if (latestInterrupt && segment.segmentId === `assistant:${latestInterrupt.outputId}`) {
            messages.push({ role: "assistant" as const, content: `${segment.contentText}${latestInterrupt.breakMarker}` });
            continue;
          }
        }
        messages.push({ role: segment.role, content: segment.contentText });
      }
      return messages;
    }
  };

  return runtime;
}

let syntheticSequence = 1_000_000;

function nextSyntheticSequence(): number {
  syntheticSequence += 1;
  return syntheticSequence;
}

function current(time: CurrentTimeProvider): { occurredAt: string; occurredAtUtc: string } {
  const now = time.now();
  return {
    occurredAt: now.iso,
    occurredAtUtc: now.date.toISOString()
  };
}

function assertSessionExists(store: TalkStore, sessionId: string): void {
  if (!store.getSession(sessionId)) throw new Error(`talk session not found: ${sessionId}`);
}

function assertOpenSession(store: TalkStore, sessionId: string): void {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`talk session not found: ${sessionId}`);
  if (session.status !== "open") throw new Error(`talk session is not open: ${sessionId}`);
}

function assertOutputSession(outputSessionId: string, expectedSessionId: string, outputId: string): void {
  if (outputSessionId !== expectedSessionId) {
    throw new Error(`talk output session mismatch: output=${outputId} session=${outputSessionId} expected=${expectedSessionId}`);
  }
}

function payloadText(payload: unknown): string | undefined {
  return payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string"
    ? (payload as { text: string }).text
    : undefined;
}

function interruptReason(payload: unknown): string {
  return payload && typeof payload === "object" && typeof (payload as { reason?: unknown }).reason === "string"
    ? (payload as { reason: string }).reason
    : "unknown";
}

function segmentId(kind: string, eventId: number): string {
  return `${kind}:${eventId}`;
}

function firstBoundaryIndex(text: string): number {
  const chars = Array.from(text);
  for (const [index, char] of chars.entries()) {
    if (/[\p{P}\p{S}\s]/u.test(char)) return index;
  }
  return -1;
}

function speechDeltaForOutput(delta: string, previousFullText: string): string {
  let parenthesisDepth = parenthesisDepthAfter(previousFullText);
  let speech = "";
  for (const char of Array.from(delta)) {
    if (char === "(" || char === "（") {
      parenthesisDepth += 1;
      continue;
    }
    if ((char === ")" || char === "）") && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      continue;
    }
    if (parenthesisDepth > 0) continue;
    speech += char;
  }
  return speech;
}

function parenthesisDepthAfter(text: string): number {
  let depth = 0;
  for (const char of Array.from(text)) {
    if (char === "(" || char === "（") depth += 1;
    else if ((char === ")" || char === "）") && depth > 0) depth -= 1;
  }
  return depth;
}

function charLength(text: string): number {
  return Array.from(text).length;
}

function sliceChars(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join("");
}

function breakpointCharIndexFromContext(originalText: string, context?: { beforeText?: string; afterText?: string }): number | undefined {
  const beforeText = context?.beforeText;
  const afterText = context?.afterText;
  if (!beforeText && !afterText) return undefined;
  const originalChars = Array.from(originalText);
  const beforeChars = beforeText ? Array.from(beforeText) : [];
  const afterChars = afterText ? Array.from(afterText) : [];
  for (let index = 0; index <= originalChars.length; index += 1) {
    if (beforeChars.length > 0 && !charsEndWith(originalChars, index, beforeChars)) continue;
    if (afterChars.length > 0 && !charsStartWith(originalChars, index, afterChars)) continue;
    return index;
  }
  if (beforeChars.length > 0 && afterChars.length > 0) {
    const index = charIndexBetweenContextAcrossOmittedParentheses(originalChars, beforeChars, afterChars);
    if (index !== undefined) return index;
  }
  if (beforeChars.length > 0) {
    const index = lastCharIndexOf(originalChars, beforeChars);
    if (index >= 0) return index + beforeChars.length;
  }
  if (afterChars.length > 0) {
    const index = firstCharIndexOf(originalChars, afterChars);
    if (index >= 0) return index;
  }
  return undefined;
}

function charIndexBetweenContextAcrossOmittedParentheses(chars: string[], before: string[], after: string[]): number | undefined {
  for (let index = 0; index <= chars.length; index += 1) {
    if (!charsEndWith(chars, index, before)) continue;
    const afterIndex = skipParenthesizedAt(chars, index);
    if (afterIndex !== undefined && charsStartWith(chars, afterIndex, after)) return index;
  }
  return undefined;
}

function skipParenthesizedAt(chars: string[], index: number): number | undefined {
  const opener = chars[index];
  const closer = opener === "(" ? ")" : opener === "（" ? "）" : undefined;
  if (!closer) return undefined;
  let depth = 0;
  for (let cursor = index; cursor < chars.length; cursor += 1) {
    const char = chars[cursor];
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return undefined;
}

function charsEndWith(chars: string[], endIndex: number, suffix: string[]): boolean {
  if (suffix.length > endIndex) return false;
  for (let offset = 0; offset < suffix.length; offset += 1) {
    if (chars[endIndex - suffix.length + offset] !== suffix[offset]) return false;
  }
  return true;
}

function charsStartWith(chars: string[], startIndex: number, prefix: string[]): boolean {
  if (startIndex + prefix.length > chars.length) return false;
  for (let offset = 0; offset < prefix.length; offset += 1) {
    if (chars[startIndex + offset] !== prefix[offset]) return false;
  }
  return true;
}

function firstCharIndexOf(chars: string[], needle: string[]): number {
  for (let index = 0; index <= chars.length - needle.length; index += 1) {
    if (charsStartWith(chars, index, needle)) return index;
  }
  return -1;
}

function lastCharIndexOf(chars: string[], needle: string[]): number {
  for (let index = chars.length - needle.length; index >= 0; index -= 1) {
    if (charsStartWith(chars, index, needle)) return index;
  }
  return -1;
}

function ratio(elapsedMs?: number, totalMs?: number): number {
  if (!elapsedMs || !totalMs || totalMs <= 0) return 0;
  return Math.max(0, Math.min(1, elapsedMs / totalMs));
}

function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
