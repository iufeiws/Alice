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

function formatErrorValue(value: unknown): string {
  if (value instanceof Error) return describeError(value);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}:${String(entry)}`)
      .join(",");
  }
  return String(value);
}
