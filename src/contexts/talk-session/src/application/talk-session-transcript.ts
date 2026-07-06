import type { TalkStore } from "../adapters/sqlite-talk-session-store.js";

export function recordTranscriptEntry(store: TalkStore, input: {
  sessionId: number;
  entryId: string;
  role: "system" | "assistant" | "user";
  contentText: string;
  occurredAt: string;
  occurredAtUtc?: string;
  sourceKind: string;
  sourceId: string;
}): void {
  store.upsertTranscriptEntry(input);
}

export function recordTranscriptEnd(store: TalkStore, input: {
  sessionId: number;
  occurredAt: string;
  occurredAtUtc?: string;
  sourceKind: string;
  sourceId: string;
}): void {
  if (store.listTranscriptEntries(input.sessionId).some((entry) => entry.entryId === "system:end")) return;
  store.upsertTranscriptEntry({
    sessionId: input.sessionId,
    entryId: "system:end",
    role: "system",
    contentText: "结束",
    occurredAt: input.occurredAt,
    occurredAtUtc: input.occurredAtUtc,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId
  });
}

export function isHangupText(text: string): boolean {
  return text.trim() === "已挂断" || text.trim() === "-已挂断-";
}
