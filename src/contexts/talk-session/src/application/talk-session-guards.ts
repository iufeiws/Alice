import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { TalkStore } from "../adapters/sqlite-talk-session-store.js";
import type { TalkAudioInputPayload } from "./talk-session-types.js";

export function current(time: CurrentTimeProvider): { occurredAt: string; occurredAtUtc: string } {
  const now = time.now();
  return {
    occurredAt: now.iso,
    occurredAtUtc: now.date.toISOString()
  };
}

export function utcTimestamp(timeUtc: string): number {
  const timestamp = Date.parse(timeUtc);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid talk session time: ${timeUtc}`);
  return timestamp;
}

export function assertNumericSessionId(sessionId: unknown): asserts sessionId is number {
  if (typeof sessionId !== "number" || !Number.isFinite(sessionId)) throw new Error(`invalid talk session id: ${sessionId}`);
}

export function assertSessionExists(store: TalkStore, sessionId: number): void {
  if (!store.getSession(sessionId)) throw new Error(`talk session not found: ${sessionId}`);
}

export function assertOpenSession(store: TalkStore, sessionId: number): void {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`talk session not found: ${sessionId}`);
  if (session.status !== "open") throw new Error(`talk session is not open: ${sessionId}`);
}

export function assertOutputSession(outputSessionId: number, expectedSessionId: number, outputId: string): void {
  if (outputSessionId !== expectedSessionId) {
    throw new Error(`talk output session mismatch: output=${outputId} session=${outputSessionId} expected=${expectedSessionId}`);
  }
}

export function payloadText(payload: unknown): string | undefined {
  return payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string"
    ? (payload as { text: string }).text
    : undefined;
}

export function audioPayload(payload: unknown): TalkAudioInputPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  if (value.kind !== "audio" || typeof value.data !== "string" || typeof value.format !== "string") return undefined;
  return {
    kind: "audio",
    data: value.data,
    format: value.format,
    mimeType: stringValue(value.mimeType),
    sampleRateHz: numberValue(value.sampleRateHz),
    channels: numberValue(value.channels),
    encoding: stringValue(value.encoding),
    bytes: numberValue(value.bytes),
    durationMs: numberValue(value.durationMs)
  };
}

export function interruptReason(payload: unknown): string {
  return payload && typeof payload === "object" && typeof (payload as { reason?: unknown }).reason === "string"
    ? (payload as { reason: string }).reason
    : "unknown";
}

export function segmentId(kind: string, eventId: number): string {
  return `${kind}:${eventId}`;
}

export function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
