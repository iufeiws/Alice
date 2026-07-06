import type {
  TalkBufferedOutputText,
  TalkOutput,
  TalkOutputChunk,
  TalkOutputDiscard,
  TalkOutputInterrupt,
  TalkSegment,
  TalkSession,
  TalkTranscriptEntry
} from "./sqlite-talk-session-types.js";

export function normalizeSession(row: unknown): TalkSession | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as TalkSession;
  return {
    id: Number(value.id),
    sessionId: value.sessionId,
    plugin: value.plugin,
    accountId: value.accountId || undefined,
    channelId: value.channelId || undefined,
    userId: value.userId || undefined,
    status: value.status,
    startedAt: value.startedAt,
    startedAtUtc: value.startedAtUtc || undefined,
    endedAt: value.endedAt || undefined,
    endedAtUtc: value.endedAtUtc || undefined
  };
}

export function normalizeSegment(row: unknown): TalkSegment | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as TalkSegment;
  return {
    id: Number(value.id),
    sessionId: value.sessionId,
    segmentId: value.segmentId || undefined,
    role: value.role,
    kind: value.kind,
    contentText: value.contentText,
    contentJson: value.contentJson || undefined,
    endedAt: value.endedAt,
    endedAtUtc: value.endedAtUtc || undefined
  };
}

export function normalizeTranscriptEntry(row: unknown): TalkTranscriptEntry | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as TalkTranscriptEntry;
  return {
    id: Number(value.id),
    sessionId: value.sessionId,
    entryId: value.entryId,
    role: value.role,
    contentText: value.contentText,
    occurredAt: value.occurredAt,
    occurredAtUtc: value.occurredAtUtc || undefined,
    sourceKind: value.sourceKind || undefined,
    sourceId: value.sourceId || undefined
  };
}

export function normalizeOutput(row: unknown): TalkOutput | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as TalkOutput;
  return {
    outputId: value.outputId,
    sessionId: value.sessionId,
    segmentId: value.segmentId || undefined,
    status: value.status,
    fullText: value.fullText,
    visibleText: value.visibleText,
    bufferText: value.bufferText,
    pendingChunkText: value.pendingChunkText,
    pendingChunkStartCharIndex: Number(value.pendingChunkStartCharIndex),
    nextChunkSequence: Number(value.nextChunkSequence),
    startedAt: value.startedAt,
    startedAtUtc: value.startedAtUtc || undefined
  };
}

export function normalizeChunk(row: unknown): TalkOutputChunk | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as TalkOutputChunk;
  return {
    chunkId: value.chunkId,
    outputId: value.outputId,
    sessionId: value.sessionId,
    sequence: Number(value.sequence),
    text: value.text,
    startCharIndex: Number(value.startCharIndex),
    endCharIndex: Number(value.endCharIndex),
    status: value.status
  };
}

export function normalizeBufferedOutputText(row: unknown): TalkBufferedOutputText | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as TalkBufferedOutputText;
  if (typeof value.outputId !== "string" || typeof value.text !== "string") return undefined;
  return {
    outputId: value.outputId,
    sessionId: value.sessionId,
    text: value.text,
    status: value.status as Extract<TalkOutput["status"], "streaming" | "finished">
  };
}

export function normalizeDiscard(row: unknown): TalkOutputDiscard | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as TalkOutputDiscard;
  return {
    discardId: value.discardId,
    sessionId: value.sessionId,
    outputId: value.outputId,
    interruptId: value.interruptId,
    discardedText: value.discardedText,
    reason: value.reason
  };
}

export function normalizeInterrupt(row: unknown): TalkOutputInterrupt | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as TalkOutputInterrupt;
  return {
    interruptId: value.interruptId,
    sessionId: value.sessionId,
    outputId: value.outputId,
    reason: value.reason,
    playedMs: optionalNumber(value.playedMs),
    totalMs: optionalNumber(value.totalMs),
    playedRatio: optionalNumber(value.playedRatio),
    visibleText: value.visibleText,
    discardId: value.discardId || undefined,
    breakMarker: value.breakMarker,
    finalUserSegmentId: value.finalUserSegmentId || undefined
  };
}

export function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

export function payloadKind(payload: unknown): string {
  return payload && typeof payload === "object" && typeof (payload as { kind?: unknown }).kind === "string"
    ? (payload as { kind: string }).kind
    : "unknown";
}

export function payloadText(payload: unknown): string | undefined {
  return payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string"
    ? (payload as { text: string }).text
    : undefined;
}

export function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
