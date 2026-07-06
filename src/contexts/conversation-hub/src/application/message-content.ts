import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import { sanitizeAudioTranscript, sanitizeMessageText, summarizeAudioText } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { MessageLifecycleEvent } from "./message-runtime-contracts.js";

export function summarizePayload(payload: { kind: string; text?: string; markdown?: string; assetId?: string; url?: string; filename?: string; transcript?: string }): string {
  if (payload.kind === "audio") return summarizeAudioText(payload.transcript, payload.assetId);
  if (payload.kind === "text" && payload.text) return sanitizeMessageText(payload.text);
  return payload.text ?? payload.markdown ?? payload.assetId ?? payload.url ?? payload.filename ?? payload.kind;
}

export function summarizeEventPayload(event: AgentEvent): string {
  const content = summarizePayload(event.payload);
  const quote = event.meta.quotedMessage;
  if (!quote) return content;
  const parts = [
    quote.senderId ? `from ${quote.senderId}` : undefined,
    quote.rawMessageId ? `#${quote.rawMessageId}` : undefined,
    quote.text
  ].filter((part): part is string => Boolean(part));
  return `-引用:${parts.join(" ")}-\n${content}`;
}

export function summarizeOutput(content: { kind: string; text?: string; markdown?: string; assetId?: string; filename?: string; transcript?: string }): string {
  if (content.kind === "audio") return summarizeAudioText(content.transcript, content.assetId);
  if (content.kind === "text" && content.text) return sanitizeMessageText(content.text);
  return content.text ?? content.markdown ?? content.assetId ?? content.filename ?? content.kind;
}

export function normalizeInboundEvent(event: AgentEvent): AgentEvent {
  if (event.payload.kind === "audio") {
    return {
      ...event,
      payload: {
        ...event.payload,
        transcript: sanitizeAudioTranscript(event.payload.transcript)
      }
    };
  }
  if (event.payload.kind === "text") {
    return {
      ...event,
      payload: {
        ...event.payload,
        text: sanitizeMessageText(event.payload.text)
      }
    };
  }
  return event;
}

export function lifecycleSummary(event: MessageLifecycleEvent): string {
  if (event.kind === "reaction.created" || event.kind === "reaction.deleted") {
    return `${event.kind} ${event.emoji} on ${event.externalMessageId}`;
  }
  return `${event.kind} ${event.externalMessageId}`;
}
