import type { ImageGenerationProviderInput, ImageGenerationProviderResult } from "./gateway.js";

const fs = await import("node:fs");
const moduleApi = await import("node:module");
const path = await import("node:path");
const require = moduleApi.createRequire(import.meta.url);

export async function runOpenAIAPISelfie(input: ImageGenerationProviderInput): Promise<ImageGenerationProviderResult> {
  if (!input.apiKey) throw new Error("selfie Image API key is not configured; set OPENAI_API_KEY or SELFIE_IMAGE_API_KEY");
  const form = new FormData();
  form.append("model", input.apiModel);
  form.append("prompt", input.prompt);
  form.append("n", "1");
  form.append("size", input.apiSize);
  form.append("quality", input.apiQuality);
  if (input.apiEndpoint === "relayEdits") {
    for (const image of input.referenceImages) {
      form.append("image", fileBlob(image), path.basename(image));
    }
  } else {
    form.append("moderation", input.apiModeration);
    form.append("output_format", input.apiOutputFormat);
    if (input.apiOutputFormat === "jpeg" || input.apiOutputFormat === "webp") {
      form.append("output_compression", String(input.apiOutputCompression));
    }
    for (const image of input.referenceImages) {
      form.append("image[]", fileBlob(image), path.basename(image));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.apiTimeoutMs);
  const started = Date.now();
  const requestUrl = `${input.apiBaseURL}/images/edits`;
  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.apiKey}`
      },
      body: form,
      ...dispatcherInit(input.proxyUrl, input.apiTimeoutMs)
    });
    const elapsedMs = Date.now() - started;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Image API ${input.apiEndpoint} failed after ${elapsedMs}ms url=${requestUrl}: HTTP ${response.status} ${response.statusText} ${excerpt(body, 4000)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new Error(`Image API ${input.apiEndpoint} returned non-JSON after ${elapsedMs}ms url=${requestUrl}: ${excerpt(body, 4000)}`);
    }
    const imageB64 = extractImageB64(payload);
    if (!imageB64) {
      throw new Error(`Image API ${input.apiEndpoint} returned no image after ${elapsedMs}ms url=${requestUrl}: ${excerpt(JSON.stringify(payload), 4000)}`);
    }
    fs.writeFileSync(path.join(input.workDir, input.fileName), Buffer.from(imageB64, "base64"));
    return {
      stdout: `Image API completed in ${elapsedMs}ms; file=${input.fileName}`,
      stderr: "",
      lastMessage: `Image API completed in ${elapsedMs}ms`
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Image API ${input.apiEndpoint} request timed out after ${input.apiTimeoutMs}ms url=${requestUrl}`);
    }
    if (error instanceof Error && error.message === "fetch failed") {
      throw new Error(`Image API ${input.apiEndpoint} request failed url=${requestUrl}: ${describeErrorWithCause(error)}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function fileBlob(filePath: string): Blob {
  return new Blob([fs.readFileSync(filePath)], { type: contentType(filePath) });
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function extractImageB64(payload: unknown): string | undefined {
  const record = payload && typeof payload === "object" ? payload as { data?: unknown } : undefined;
  const data = Array.isArray(record?.data) ? record.data : [];
  const first = data[0] && typeof data[0] === "object" ? data[0] as { b64_json?: unknown } : undefined;
  return typeof first?.b64_json === "string" ? first.b64_json : undefined;
}

function describeErrorWithCause(error: Error): string {
  const details = [error.message];
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    details.push(`cause=${cause.name}: ${cause.message}`);
    const causeRecord = cause as Error & { code?: unknown; errno?: unknown; syscall?: unknown; address?: unknown; port?: unknown };
    for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
      if (causeRecord[key] !== undefined) details.push(`${key}=${String(causeRecord[key])}`);
    }
  } else if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    details.push(`cause=${JSON.stringify(Object.fromEntries(Object.entries(causeRecord).filter(([, value]) => typeof value !== "function")))}`);
  } else if (cause !== undefined) {
    details.push(`cause=${String(cause)}`);
  }
  return details.join(" ");
}

function dispatcherInit(proxyUrl: string | undefined, timeoutMs: number): RequestInit {
  const options = { headersTimeout: timeoutMs + 1_000, bodyTimeout: timeoutMs + 1_000 };
  if (!proxyUrl) return { dispatcher: new (loadUndici().Agent)(options) } as unknown as RequestInit;
  const { ProxyAgent } = loadUndici();
  return { dispatcher: new ProxyAgent({ uri: proxyUrl, ...options }) } as unknown as RequestInit;
}

function loadUndici(): { Agent: new (options: { headersTimeout: number; bodyTimeout: number }) => unknown; ProxyAgent: new (options: { uri: string; headersTimeout: number; bodyTimeout: number }) => unknown } {
  try {
    return require("undici") as { Agent: new (options: { headersTimeout: number; bodyTimeout: number }) => unknown; ProxyAgent: new (options: { uri: string; headersTimeout: number; bodyTimeout: number }) => unknown };
  } catch {
    return require("/usr/share/nodejs/undici") as { Agent: new (options: { headersTimeout: number; bodyTimeout: number }) => unknown; ProxyAgent: new (options: { uri: string; headersTimeout: number; bodyTimeout: number }) => unknown };
  }
}

function excerpt(value: string | undefined, maxLength = 500): string {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}
