export function extractSentMessageId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "messageId" in value) {
    const messageId = (value as { messageId?: unknown }).messageId;
    return typeof messageId === "string" ? messageId : undefined;
  }
  return undefined;
}

export function extractSentMessageCreatedAtUtc(value: unknown): string | undefined {
  if (value && typeof value === "object" && "createdAtUtc" in value) {
    const createdAtUtc = (value as { createdAtUtc?: unknown }).createdAtUtc;
    return typeof createdAtUtc === "string" ? createdAtUtc : undefined;
  }
  return undefined;
}

