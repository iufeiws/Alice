export type TalkEventKind =
  | "session.started"
  | "audio.input.final"
  | "audio.transcript.final"
  | "text.final"
  | "input.interrupted"
  | "agent.max_continuous_rounds"
  | "session.ended";

export type TalkSource = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
};

export type TalkSession = {
  id: number;
  sessionId: number;
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  status: "open" | "closed" | string;
  startedAt: string;
  startedAtUtc?: string;
  endedAt?: string;
  endedAtUtc?: string;
};

export type TalkEvent = {
  kind: TalkEventKind;
  sessionId: number;
  source: TalkSource;
  sequence: number;
  occurredAt: string;
  occurredAtUtc?: string;
  payload: unknown;
  raw?: unknown;
};

export type TalkSegment = {
  id: number;
  sessionId: number;
  segmentId?: string;
  role: "assistant" | "user";
  kind: string;
  contentText: string;
  contentJson?: string;
  endedAt: string;
  endedAtUtc?: string;
};

export type TalkTranscriptEntry = {
  id: number;
  sessionId: number;
  entryId: string;
  role: "system" | "assistant" | "user";
  contentText: string;
  occurredAt: string;
  occurredAtUtc?: string;
  sourceKind?: string;
  sourceId?: string;
};

export type TalkOutput = {
  outputId: string;
  sessionId: number;
  segmentId?: string;
  status: "streaming" | "finished" | "interrupted" | "cancelled";
  fullText: string;
  visibleText: string;
  bufferText: string;
  pendingChunkText: string;
  pendingChunkStartCharIndex: number;
  nextChunkSequence: number;
  startedAt: string;
  startedAtUtc?: string;
};

export type TalkOutputChunk = {
  chunkId: string;
  outputId: string;
  sessionId: number;
  sequence: number;
  text: string;
  startCharIndex: number;
  endCharIndex: number;
  status: "buffering" | "ready" | "claimed" | "played" | "cancelled";
};

export type TalkBufferedOutputText = {
  outputId: string;
  sessionId: number;
  text: string;
  status: Extract<TalkOutput["status"], "streaming" | "finished">;
};

export type TalkOutputDiscard = {
  discardId: string;
  sessionId: number;
  outputId: string;
  interruptId: string;
  discardedText: string;
  reason: string;
};

export type TalkOutputInterrupt = {
  interruptId: string;
  sessionId: number;
  outputId: string;
  reason: string;
  playedMs?: number;
  totalMs?: number;
  playedRatio?: number;
  visibleText: string;
  discardId?: string;
  breakMarker: string;
  finalUserSegmentId?: string;
};

export type TalkStore = {
  transaction?<T>(fn: () => T): T;
  openSession(input: {
    sessionId: number;
    source: TalkSource;
    occurredAt: string;
    occurredAtUtc?: string;
    metadata?: unknown;
  }): void;
  closeSession(input: { sessionId: number; occurredAt: string; occurredAtUtc?: string }): void;
  getSession(sessionId: number): TalkSession | undefined;
  insertEvent(event: TalkEvent): { id: number; inserted: boolean };
  insertSegment(input: {
    sessionId: number;
    eventId?: number;
    segmentId: string;
    role: TalkSegment["role"];
    kind: string;
    contentText: string;
    contentJson?: unknown;
    endedAt: string;
    endedAtUtc?: string;
  }): TalkSegment;
  listSegments(sessionId: number): TalkSegment[];
  upsertTranscriptEntry(input: {
    sessionId: number;
    entryId: string;
    role: TalkTranscriptEntry["role"];
    contentText: string;
    occurredAt: string;
    occurredAtUtc?: string;
    sourceKind?: string;
    sourceId?: string;
  }): TalkTranscriptEntry;
  listTranscriptEntries(sessionId: number): TalkTranscriptEntry[];
  getOutput(outputId: string): TalkOutput | undefined;
  latestOutput(sessionId: number): TalkOutput | undefined;
  ensureOutput(input: { sessionId: number; outputId: string; now: string; nowUtc?: string }): TalkOutput;
  updateOutput(input: Partial<TalkOutput> & { outputId: string }): TalkOutput;
  insertReadyChunk(input: {
    sessionId: number;
    outputId: string;
    sequence: number;
    text: string;
    startCharIndex: number;
    endCharIndex: number;
    now: string;
    nowUtc?: string;
  }): TalkOutputChunk;
  claimBufferedOutputText(sessionId: number): TalkBufferedOutputText | undefined;
  claimReadyOutputChunk(sessionId: number, now: string, nowUtc?: string): TalkOutputChunk | undefined;
  markChunkPlayed(input: { sessionId: number; chunkId: string; now: string; nowUtc?: string }): void;
  listChunks(outputId: string): TalkOutputChunk[];
  cancelChunks(outputId: string, now: string, nowUtc?: string): void;
  cancelOtherSessionOutputs(sessionId: number, keepOutputId: string, now: string, nowUtc?: string): void;
  isSessionOutputIdle(sessionId: number): boolean;
  pendingVoiceOutputCharCount(sessionId: number): number;
  insertDiscard(input: {
    discardId: string;
    sessionId: number;
    outputId: string;
    interruptId: string;
    discardedText: string;
    reason: string;
    now: string;
    nowUtc?: string;
    metadata?: unknown;
  }): TalkOutputDiscard;
  getDiscard(discardId: string): TalkOutputDiscard | undefined;
  insertInterrupt(input: {
    interruptId: string;
    sessionId: number;
    outputId: string;
    eventId?: number;
    segmentId?: string;
    reason: string;
    playedMs?: number;
    totalMs?: number;
    playedRatio?: number;
    visibleText: string;
    discardId?: string;
    breakMarker: string;
    now: string;
    nowUtc?: string;
    metadata?: unknown;
  }): TalkOutputInterrupt;
  latestUnresolvedInterrupt(sessionId: number): TalkOutputInterrupt | undefined;
  resolveLatestInterrupt(input: { sessionId: number; finalUserSegmentId: string; now: string; nowUtc?: string }): void;
  resolveInterrupt(input: { interruptId: string; finalUserSegmentId: string; now: string; nowUtc?: string }): void;
};
