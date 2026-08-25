export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const lines = [error.stack || `${error.name}: ${error.message}`];
    const details = Object.entries(error as Error & Record<string, unknown>)
      .filter(([key]) => !["name", "message", "stack", "cause"].includes(key))
      .map(([key, value]) => `${key}=${formatErrorValue(value)}`);
    if (details.length > 0) lines.push(`details: ${details.join(" ")}`);
    if ("cause" in error && error.cause !== undefined) lines.push(`cause: ${describeError(error.cause)}`);
    return lines.join("\n");
  }
  if (error && typeof error === "object") {
    return Object.entries(error as Record<string, unknown>)
      .map(([key, value]) => `${key}=${formatErrorValue(value)}`)
      .join(" ");
  }
  return String(error);
}

export function formatErrorNotice(error: unknown): string {
  if (error instanceof Error) {
    const messages = [formatErrorMessage(error.message)];
    let cause: unknown = "cause" in error ? error.cause : undefined;
    while (cause !== undefined) {
      messages.push(formatErrorValueForNotice(cause));
      cause = cause instanceof Error && "cause" in cause ? cause.cause : undefined;
    }
    return `${error.name}: ${messages.join(" | ")}`;
  }
  return formatErrorValueForNotice(error);
}

function formatErrorValue(value: unknown): string {
  if (value instanceof Error) return describeError(value);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}:${String(entry)}`)
      .join(",");
  }
  return String(value);
}

function formatErrorValueForNotice(value: unknown): string {
  if (value instanceof Error) return formatErrorMessage(value.message);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return formatErrorMessage(record.message);
    return String(value);
  }
  return String(value);
}

function formatErrorMessage(message: string): string {
  const text = message.trim();
  const match = /^(.*?)\s+(\{[\s\S]*\})$/.exec(text);
  if (!match) return text;

  let body: unknown;
  try {
    body = JSON.parse(match[2]);
  } catch {
    return text;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return text;
  const nestedError = (body as Record<string, unknown>).error;
  if (!nestedError || typeof nestedError !== "object" || Array.isArray(nestedError)) return text;
  const nestedMessage = (nestedError as Record<string, unknown>).message;
  return typeof nestedMessage === "string" && nestedMessage.trim()
    ? `${match[1].trim()} | ${nestedMessage.trim()}`
    : text;
}
