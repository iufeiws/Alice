import * as crypto from "node:crypto";
import type { AsrPluginDeps, AsrProvider } from "./types.js";

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asrProviderValue(value: unknown): AsrProvider | undefined {
  return value === "tencent" || value === "openai_compatible" || value === "multimodal_llm" ? value : undefined;
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function numberValue(value: unknown, fallback: number): number;
export function numberValue(value: unknown, fallback: undefined): number | undefined;
export function numberValue(value: unknown, fallback: number | undefined): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function hashToInt(value: string): number {
  const hash = crypto.createHash("sha1").update(value).digest();
  return ((hash[0] ?? 0) << 24) + ((hash[1] ?? 0) << 16) + ((hash[2] ?? 0) << 8) + (hash[3] ?? 0);
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(key: string | Uint8Array, value: string): any {
  return crypto.createHmac("sha256", key).update(value).digest();
}

export function hmacSha256Hex(key: string | Uint8Array, value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

export function hmacSha1Base64(key: string, value: string): string {
  return crypto.createHmac("sha1", key).update(value).digest("base64");
}

export function bufferToArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

export function base64FromBytes(bytes: Uint8Array): string {
  return (Buffer as any).from(bytes).toString("base64");
}

export function retryOptions(
  config: { retryCount?: number; retryBackoffMs?: number },
  deps: AsrPluginDeps
): { count: number; backoffMs: number; sleep: (ms: number) => Promise<void> } {
  return {
    count: config.retryCount ?? 1,
    backoffMs: config.retryBackoffMs ?? 500,
    sleep: deps.sleep ?? sleep
  };
}

export async function retryAsync<T>(
  run: () => Promise<T>,
  options: { count: number; backoffMs: number; sleep: (ms: number) => Promise<void> }
): Promise<T> {
  let latestError: unknown;
  for (let attempt = 0; attempt <= options.count; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      latestError = error;
      if (attempt >= options.count || !isRetryableAsrError(error)) break;
      await options.sleep(options.backoffMs * Math.max(1, attempt + 1));
    }
  }
  throw latestError;
}

function isRetryableAsrError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "timeout" || /timeout|network|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|5\d\d/i.test(message);
}

export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number | undefined): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) return fetchImpl(url, init);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
