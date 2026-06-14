export function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function stringValue(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function formatFileDateTime(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
