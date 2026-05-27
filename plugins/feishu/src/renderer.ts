import type { AgentOutput } from "../../../packages/types/src/index.js";
import type { FeishuSendPlan } from "./types.js";

export function renderForFeishu(output: AgentOutput): FeishuSendPlan {
  const channelId = normalizeFeishuChatId(output.target.channelId);
  const userId = channelId ? undefined : normalizeFeishuOpenId(output.target.userId ?? output.target.channelId);
  const receiveId = channelId ?? userId;
  if (!receiveId) {
    throw new Error("Feishu output target requires channelId or userId");
  }

  const receiveIdType = channelId ? "chat_id" : "open_id";

  if (output.content.kind === "text") {
    return {
      kind: "text",
      receiveIdType,
      receiveId,
      text: output.content.text,
      replyTo: output.target.replyTo
    };
  }

  if (output.content.kind === "markdown") {
    return {
      kind: "markdown",
      receiveIdType,
      receiveId,
      markdown: output.content.markdown,
      replyTo: output.target.replyTo
    };
  }

  if (output.content.kind === "card") {
    return {
      kind: "markdown",
      receiveIdType,
      receiveId,
      markdown: renderCardAsMarkdown(output.content.card),
      replyTo: output.target.replyTo
    };
  }

  if (output.content.kind === "image") {
    return {
      kind: "image",
      receiveIdType,
      receiveId,
      assetId: output.content.assetId,
      replyTo: output.target.replyTo
    };
  }

  if (output.content.kind === "audio") {
    return {
      kind: "audio",
      receiveIdType,
      receiveId,
      assetId: output.content.assetId,
      replyTo: output.target.replyTo
    };
  }

  if (output.content.kind === "file") {
    return {
      kind: "file",
      receiveIdType,
      receiveId,
      assetId: output.content.assetId,
      filename: output.content.filename,
      replyTo: output.target.replyTo
    };
  }

  throw new Error(`Feishu renderer does not support ${output.content.kind} yet`);
}

function renderCardAsMarkdown(card: { title: string; body?: string; fields?: Array<{ label: string; value: string }> }): string {
  const lines = [`## ${card.title}`];
  if (card.body) lines.push("", card.body);
  for (const field of card.fields ?? []) {
    lines.push("", `**${field.label}:** ${field.value}`);
  }
  return lines.join("\n");
}

function normalizeFeishuChatId(value: string | undefined): string | undefined {
  const unwrapped = unwrapFeishuInternalId(value);
  if (!unwrapped) return undefined;
  return unwrapped.prefixed && !unwrapped.id.startsWith("oc_") ? undefined : unwrapped.id;
}

function normalizeFeishuOpenId(value: string | undefined): string | undefined {
  const unwrapped = unwrapFeishuInternalId(value);
  if (!unwrapped) return undefined;
  return unwrapped.prefixed && unwrapped.id.startsWith("oc_") ? undefined : unwrapped.id;
}

function unwrapFeishuInternalId(value: string | undefined): { id: string; prefixed: boolean } | undefined {
  if (!value) return undefined;
  const match = /^feishu:(?:dm|group):(.+)$/.exec(value);
  return match ? { id: match[1], prefixed: true } : { id: value, prefixed: false };
}
