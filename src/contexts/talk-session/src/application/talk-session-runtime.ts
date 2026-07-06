import type { LLMMessage } from "../../../../contexts/llm-gateway/src/index.js";
import type { TalkOutputInterrupt } from "../adapters/sqlite-talk-session-store.js";
import {
  assertNumericSessionId,
  assertOpenSession,
  assertOutputSession,
  assertSessionExists,
  audioPayload,
  current,
  interruptReason,
  parseJsonObject,
  payloadText,
  segmentId,
  stringValue,
  utcTimestamp
} from "./talk-session-guards.js";
import {
  charLength,
  clampIndex,
  ratio,
  sliceChars,
  speechDeltaForOutput,
  splitIndexFromContext
} from "./talk-session-text.js";
import {
  isHangupText,
  recordTranscriptEnd,
  recordTranscriptEntry
} from "./talk-session-transcript.js";
import type { TalkRuntime, TalkRuntimeDeps } from "./talk-session-types.js";

export type {
  StableInputBatch,
  StableInputItem,
  TalkAudioInputPayload,
  TalkLoopMessagePatch,
  TalkRuntime,
  TalkRuntimeDeps,
  TalkSessionOpenInput,
  TalkSessionOpenResult
} from "./talk-session-types.js";

export const defaultTalkOutputReadyChars = 20;
const noSpeechUserMessage = " (没有说话)";

export function createTalkRuntime(deps: TalkRuntimeDeps): TalkRuntime {
  const breakMarker = deps.breakMarker ?? "...";
  const readyAgentLoopSessions = new Map<number, number>();
  const foregroundPlaybackPendingSessions = new Set<number>();
  const agentLoopInterruptedSessions = new Map<number, number>();
  const loopPrefixMessageCounts = new Map<number, number>();

  const runtime: TalkRuntime = {
    store: deps.store,
    openSession(input) {
      const now = current(deps.time);
      const occurredAt = input.occurredAt ?? now.occurredAt;
      const occurredAtUtc = input.occurredAtUtc ?? now.occurredAtUtc;
      const sessionId = deps.createLLMSession?.({
        occurredAt,
        occurredAtUtc,
        source: input.source,
        metadata: input.metadata
      }) ?? input.sessionId ?? utcTimestamp(occurredAtUtc);
      assertNumericSessionId(sessionId);
      deps.store.openSession({
        sessionId,
        source: input.source,
        occurredAt,
        occurredAtUtc,
        metadata: input.metadata
      });
      loopPrefixMessageCounts.set(sessionId, 0);
      deps.store.insertEvent({
        kind: "session.started",
        sessionId,
        source: input.source,
        sequence: 0,
        occurredAt,
        occurredAtUtc,
        payload: { kind: "session", ...(typeof input.metadata === "object" && input.metadata ? input.metadata : {}) }
      });
      recordTranscriptEntry(deps.store, {
        sessionId,
        entryId: "system:start",
        role: "system",
        contentText: "开始",
        occurredAt,
        occurredAtUtc,
        sourceKind: "session.started",
        sourceId: "system:start"
      });
      deps.onSessionOpened?.(sessionId);
      return { sessionId };
    },
    closeSession(input) {
      assertSessionExists(deps.store, input.sessionId);
      readyAgentLoopSessions.delete(input.sessionId);
      agentLoopInterruptedSessions.delete(input.sessionId);
      const now = current(deps.time);
      deps.store.closeSession({
        sessionId: input.sessionId,
        occurredAt: input.occurredAt ?? now.occurredAt,
        occurredAtUtc: input.occurredAtUtc ?? now.occurredAtUtc
      });
      foregroundPlaybackPendingSessions.delete(input.sessionId);
      loopPrefixMessageCounts.delete(input.sessionId);
      recordTranscriptEnd(deps.store, {
        sessionId: input.sessionId,
        occurredAt: input.occurredAt ?? now.occurredAt,
        occurredAtUtc: input.occurredAtUtc ?? now.occurredAtUtc,
        sourceKind: "session.ended",
        sourceId: "system:end"
      });
      deps.onSessionClosed?.(input.sessionId);
    },
    markAgentLoopReady(sessionId) {
      assertOpenSession(deps.store, sessionId);
      markAgentLoopReady(sessionId);
    },
    claimReadyAgentLoopSession() {
      const nowMs = deps.time.now().epochMs;
      for (const [sessionId, readyAtMs] of readyAgentLoopSessions) {
        if (nowMs < readyAtMs) continue;
        readyAgentLoopSessions.delete(sessionId);
        if (deps.store.getSession(sessionId)?.status !== "open") continue;
        if (agentLoopInterruptedSessions.has(sessionId)) continue;
        if (deps.store.latestUnresolvedInterrupt(sessionId)) continue;
        if (!isAgentLoopOutputReady(sessionId)) continue;
        return sessionId;
      }
      return undefined;
    },
    prepareReadyAgentLoopSession(sessionId, options) {
      assertOpenSession(deps.store, sessionId);
      if (agentLoopInterruptedSessions.has(sessionId)) return;
      if (deps.store.latestUnresolvedInterrupt(sessionId)) return;
      if (!isAgentLoopOutputReady(sessionId)) return;
      return deps.prepareAgentLoop?.(sessionId, options);
    },
    ingestInput(event) {
      assertOpenSession(deps.store, event.sessionId);
      const inserted = deps.store.insertEvent(event);
      if (!inserted.inserted) return;
      if (event.kind === "audio.input.final" || event.kind === "audio.transcript.final" || event.kind === "text.final") {
        agentLoopInterruptedSessions.delete(event.sessionId);
        const audio = audioPayload(event.payload);
        const text = payloadText(event.payload) ?? (audio ? "[语音]" : undefined);
        if (!text) return;
        const segment = deps.store.insertSegment({
          sessionId: event.sessionId,
          eventId: inserted.id,
          segmentId: segmentId(event.kind, inserted.id),
          role: "user",
          kind: event.kind === "text.final" ? "text" : event.kind === "audio.input.final" ? "audio" : "transcript",
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
        recordTranscriptEntry(deps.store, {
          sessionId: event.sessionId,
          entryId: `user:${segment.segmentId ?? segment.id}`,
          role: "user",
          contentText: text,
          occurredAt: event.occurredAt,
          occurredAtUtc: event.occurredAtUtc,
          sourceKind: event.kind,
          sourceId: segment.segmentId ?? String(segment.id)
        });
        markAgentLoopReady(event.sessionId);
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
      let shouldRunAgentLoop = false;
      const commit = () => {
        const blockedEpoch = agentLoopInterruptedSessions.get(batch.sessionId);
        if (blockedEpoch === undefined || batch.interruptEpoch >= blockedEpoch) {
          agentLoopInterruptedSessions.delete(batch.sessionId);
        }
        const ordered = [...batch.inputs].sort((a, b) => a.sequence - b.sequence);
        for (const item of ordered) {
          const event = deps.store.insertEvent({
            kind: item.reason === "manual" ? "text.final" : item.audio ? "audio.input.final" : "audio.transcript.final",
            sessionId: batch.sessionId,
            source: { plugin: "webrtc_voice" },
            sequence: item.sequence,
            occurredAt: item.occurredAt,
            occurredAtUtc: item.occurredAtUtc,
            payload: {
              kind: item.reason === "manual" ? "text" : item.audio ? "audio" : "transcript",
              text: item.text,
              ...(item.audio ?? {}),
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
          if (item.reason === "call_close" && isHangupText(item.text)) {
            recordTranscriptEnd(deps.store, {
              sessionId: batch.sessionId,
              occurredAt: item.occurredAt,
              occurredAtUtc: item.occurredAtUtc,
              sourceKind: "call_close",
              sourceId: item.interruptId
            });
            deps.store.resolveInterrupt({
              interruptId: item.interruptId,
              finalUserSegmentId: `system:call_close:${batch.batchId}:${item.sequence}`,
              now: item.occurredAt,
              nowUtc: item.occurredAtUtc
            });
            continue;
          }
          shouldRunAgentLoop = true;
          const segment = deps.store.insertSegment({
            sessionId: batch.sessionId,
            eventId: event.id,
            segmentId: `stable:${batch.batchId}:${item.interruptId}`,
            role: "user",
            kind: item.reason === "manual" ? "text" : item.audio ? "audio" : "transcript",
            contentText: item.text,
            contentJson: {
              ...(item.audio ?? {}),
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
          recordTranscriptEntry(deps.store, {
            sessionId: batch.sessionId,
            entryId: `user:${segment.segmentId ?? segment.id}`,
            role: "user",
            contentText: item.text,
            occurredAt: item.occurredAt,
            occurredAtUtc: item.occurredAtUtc,
            sourceKind: item.reason === "manual" ? "text.final" : item.audio ? "audio.input.final" : "audio.transcript.final",
            sourceId: segment.segmentId ?? String(segment.id)
          });
        }
      };
      if (deps.store.transaction) deps.store.transaction(commit);
      else commit();
      if (shouldRunAgentLoop) markAgentLoopReady(batch.sessionId);
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

      const fullText = output.fullText + input.delta;
      const visibleText = fullText;
      const speechDelta = speechDeltaForOutput(input.delta, output.fullText);
      const bufferText = output.bufferText + speechDelta;
      if (speechDelta.trim()) foregroundPlaybackPendingSessions.add(input.sessionId);

      output = deps.store.updateOutput({
        outputId: input.outputId,
        fullText,
        visibleText,
        bufferText
      });
      void output;
    },
    finishAssistantOutput(input) {
      assertOpenSession(deps.store, input.sessionId);
      const now = current(deps.time);
      const output = deps.store.getOutput(input.outputId);
      if (!output || output.status === "interrupted" || output.status === "cancelled") return;
      assertOutputSession(output.sessionId, input.sessionId, input.outputId);
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
        bufferText: output.bufferText.endsWith("\n") ? output.bufferText : `${output.bufferText}\n`,
        pendingChunkText: "",
        nextChunkSequence: output.nextChunkSequence
      });
      recordTranscriptEntry(deps.store, {
        sessionId: input.sessionId,
        entryId: `assistant:${input.outputId}`,
        role: "assistant",
        contentText: output.fullText,
        occurredAt: output.startedAt,
        occurredAtUtc: output.startedAtUtc,
        sourceKind: "assistant.output",
        sourceId: input.outputId
      });
    },
    claimBufferedOutputText(sessionId) {
      assertOpenSession(deps.store, sessionId);
      return deps.store.claimBufferedOutputText(sessionId);
    },
    claimReadyOutputChunk(sessionId) {
      assertOpenSession(deps.store, sessionId);
      const now = current(deps.time);
      return deps.store.claimReadyOutputChunk(sessionId, now.occurredAt, now.occurredAtUtc);
    },
    isSessionOutputIdle(sessionId) {
      assertOpenSession(deps.store, sessionId);
      return deps.store.isSessionOutputIdle(sessionId);
    },
    isForegroundPlaybackIdle(sessionId) {
      assertOpenSession(deps.store, sessionId);
      return !foregroundPlaybackPendingSessions.has(sessionId);
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
    markForegroundPlaybackIdle(input) {
      assertOpenSession(deps.store, input.sessionId);
      foregroundPlaybackPendingSessions.delete(input.sessionId);
      markAgentLoopReady(input.sessionId);
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
    interruptAgentLoop(sessionId, input) {
      assertOpenSession(deps.store, sessionId);
      const interruptEpoch = typeof input?.interruptEpoch === "number" ? input.interruptEpoch : Number.MAX_SAFE_INTEGER;
      const currentEpoch = agentLoopInterruptedSessions.get(sessionId);
      agentLoopInterruptedSessions.set(sessionId, Math.max(currentEpoch ?? 0, interruptEpoch));
      readyAgentLoopSessions.delete(sessionId);
      deps.interruptAgentLoop?.(sessionId, "");
    },
    interruptOutput(input) {
      assertOpenSession(deps.store, input.sessionId);
      foregroundPlaybackPendingSessions.delete(input.sessionId);
      const now = current(deps.time);
      const output = deps.store.getOutput(input.outputId);
      if (!output) throw new Error(`talk output not found: ${input.outputId}`);
      assertOutputSession(output.sessionId, input.sessionId, input.outputId);
      const originalText = output.fullText;
      const originalLength = charLength(originalText);
      const contextSplitIndex = splitIndexFromContext(originalText, input.breakpointContext);
      const playedRatio = contextSplitIndex === undefined ? ratio(input.elapsedMs, input.totalMs) : undefined;
      const splitIndex = clampIndex(
        contextSplitIndex ?? Math.floor(originalLength * (playedRatio ?? 0)),
        originalLength
      );
      const visibleText = sliceChars(originalText, 0, splitIndex);
      const discardedText = sliceChars(originalText, splitIndex);
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
        contentJson: { interruptId, outputId: input.outputId, discardId, breakMarker: marker, breakpointContext: input.breakpointContext, omitAssistantMessage: input.omitAssistantMessage === true },
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
      if (assistantSegment) {
        recordTranscriptEntry(deps.store, {
          sessionId: input.sessionId,
          entryId: `assistant:${input.outputId}`,
          role: "assistant",
          contentText: `${visibleText}${marker}`,
          occurredAt: output.startedAt,
          occurredAtUtc: output.startedAtUtc,
          sourceKind: "assistant.output.interrupted",
          sourceId: input.outputId
        });
      }
      void deps.interruptAgentLoop?.(input.sessionId, input.outputId);
      return interrupt;
    },
    setLoopPrefixMessageCount(sessionId, count) {
      assertSessionExists(deps.store, sessionId);
      loopPrefixMessageCounts.set(sessionId, Math.max(0, count));
    },
    buildNextLoopMessagePatch(sessionId, options) {
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
        const audio = options?.supportsAudio ? audioPayload(parseJsonObject(segment.contentJson)) : undefined;
        messages.push(audio
          ? { role: segment.role, content: [{ type: "input_audio", input_audio: { data: audio.data, format: audio.format } }] }
          : { role: segment.role, content: segment.contentText });
      }
      if (shouldAppendNoSpeechUserMessage(sessionId, latestInterrupt, messages)) {
        messages.push({ role: "user", content: noSpeechUserMessage });
      }
      return {
        replaceFrom: loopPrefixMessageCounts.get(sessionId) ?? 0,
        messages
      };
    }
  };

  return runtime;

  function markAgentLoopReady(sessionId: number, delayMs = 0): void {
    if (agentLoopInterruptedSessions.has(sessionId)) return;
    readyAgentLoopSessions.set(sessionId, deps.time.now().epochMs + delayMs);
  }

  function isAgentLoopOutputReady(sessionId: number): boolean {
    return deps.store.isSessionOutputIdle(sessionId) && !foregroundPlaybackPendingSessions.has(sessionId);
  }

  function shouldAppendNoSpeechUserMessage(sessionId: number, latestInterrupt: TalkOutputInterrupt | undefined, messages: LLMMessage[]): boolean {
    if (latestInterrupt) return false;
    if (agentLoopInterruptedSessions.has(sessionId)) return false;
    const lastMessage = messages[messages.length - 1];
    return lastMessage?.role === "assistant";
  }
}

let syntheticSequence = 1_000_000;

function nextSyntheticSequence(): number {
  syntheticSequence += 1;
  return syntheticSequence;
}
