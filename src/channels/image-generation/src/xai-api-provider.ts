import type { ImageGenerationProviderInput, ImageGenerationProviderResult } from "./gateway.js";
import { resolveCredentialAuthorization } from "../../../contexts/llm-gateway/src/credential-runtime.js";

const fs = await import("node:fs");
const moduleApi = await import("node:module");
const path = await import("node:path");
const require = moduleApi.createRequire(import.meta.url);

export async function runXaiAPISelfie(input: ImageGenerationProviderInput): Promise<ImageGenerationProviderResult> {
  if (!input.credentialId && !input.apiKey) throw new Error("selfie xAI Image API credential is not configured");
  if (input.referenceImages.length === 0 || input.referenceImages.length > 3) {
    throw new Error(`xAI Image API requires one to three reference images; received ${input.referenceImages.length}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.apiTimeoutMs);
  const started = Date.now();
  const requestUrl = `${input.apiBaseURL}/images/edits`;
  const authorization = input.credentialId ? resolveCredentialAuthorization(input.credentialId) : undefined;
  try {
    const target = new URL(requestUrl);
    let authorizationValue = authorization ? await authorization.authorization(target) : `Bearer ${input.apiKey}`;
    let response = await fetch(requestUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: authorizationValue,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: input.apiModel,
        prompt: input.prompt,
        images: input.referenceImages.map((image) => ({ type: "image_url", url: imageDataUri(image) })),
        response_format: "b64_json",
        aspect_ratio: input.xaiAspectRatio,
        resolution: input.xaiResolution,
        quality: input.apiQuality
      }),
      ...dispatcherInit(input.proxyUrl, input.apiTimeoutMs)
    });
    if (response.status === 401 && authorization) {
      const refreshed = await authorization.retryAfterUnauthorized({ target, rejectedAuthorization: authorizationValue });
      if (refreshed) {
        authorizationValue = refreshed;
        await response.body?.cancel();
        response = await fetch(requestUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { authorization: authorizationValue, "content-type": "application/json" },
          body: JSON.stringify({
            model: input.apiModel,
            prompt: input.prompt,
            images: input.referenceImages.map((image) => ({ type: "image_url", url: imageDataUri(image) })),
            response_format: "b64_json",
            aspect_ratio: input.xaiAspectRatio,
            resolution: input.xaiResolution,
            quality: input.apiQuality
          }),
          ...dispatcherInit(input.proxyUrl, input.apiTimeoutMs)
        });
      }
    }
    const elapsedMs = Date.now() - started;
    const body = await response.text();
    if (!response.ok) throw new Error(`xAI Image API failed after ${elapsedMs}ms url=${requestUrl}: HTTP ${response.status} ${response.statusText} ${excerpt(body, 4000)}`);
    const imageB64s = extractImageB64s(body, elapsedMs, requestUrl);
    for (const [index, imageB64] of imageB64s.entries()) {
      fs.writeFileSync(path.join(input.workDir, outputFileName(input.fileName, index)), Buffer.from(imageB64, "base64"));
    }
    return { stdout: `xAI Image API completed in ${elapsedMs}ms; files=${imageB64s.map((_, index) => outputFileName(input.fileName, index)).join(",")}`, stderr: "", lastMessage: `xAI Image API completed in ${elapsedMs}ms` };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`xAI Image API request timed out after ${input.apiTimeoutMs}ms url=${requestUrl}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function imageDataUri(filePath: string): string {
  return `data:${contentType(filePath)};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function extractImageB64s(body: string, elapsedMs: number, requestUrl: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error(`xAI Image API returned non-JSON after ${elapsedMs}ms url=${requestUrl}: ${excerpt(body, 4000)}`);
  }
  const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
  const imageB64s = data.flatMap((item) => item && typeof item === "object" && typeof (item as { b64_json?: unknown }).b64_json === "string" ? [(item as { b64_json: string }).b64_json] : []);
  if (imageB64s.length === 0) throw new Error(`xAI Image API returned no base64 image after ${elapsedMs}ms url=${requestUrl}: ${excerpt(body, 4000)}`);
  return imageB64s;
}

function outputFileName(fileName: string, index: number): string {
  if (index === 0) return fileName;
  const extension = path.extname(fileName);
  return `${path.basename(fileName, extension)}_${index + 1}${extension}`;
}

function dispatcherInit(proxyUrl: string | undefined, timeoutMs: number): RequestInit {
  const options = { headersTimeout: timeoutMs + 1_000, bodyTimeout: timeoutMs + 1_000 };
  if (!proxyUrl) return { dispatcher: new (loadUndici().Agent)(options) } as unknown as RequestInit;
  return { dispatcher: new (loadUndici().ProxyAgent)({ uri: proxyUrl, ...options }) } as unknown as RequestInit;
}

function loadUndici(): { Agent: new (options: { headersTimeout: number; bodyTimeout: number }) => unknown; ProxyAgent: new (options: { uri: string; headersTimeout: number; bodyTimeout: number }) => unknown } {
  try { return require("undici") as ReturnType<typeof loadUndici>; } catch { return require("/usr/share/nodejs/undici") as ReturnType<typeof loadUndici>; }
}

function excerpt(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}
