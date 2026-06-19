import { createConfiguredVoiceSynthesizer } from "./index.js";
import { readJsonBody, readRawBody } from "../../../apps/api/middleware/http-utils.js";
import { writeJson } from "../../../apps/api/routes/admin-http.js";
import { optionalString, requiredString } from "../../../shared/admin-input/src/index.js";
import { convertReferenceAudio, decodeHeaderFileName, ensureTtsReferenceWithinLimit, maxTtsReferenceDurationSeconds, maxTtsReferenceUploadBytes, readMossCodecConfig, resolveTtsAssetPath, resolveTtsOutputDir, ttsAudioUrl } from "./admin-assets.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function serveTtsAsset(context: AdminRoutesContext, rawName: string, response: any): void {
  const normalized = path.normalize(decodeHeaderFileName(rawName));
  const outputDir = resolveTtsOutputDir(context);
  const fullPath = path.resolve(outputDir, normalized);
  const relative = path.relative(outputDir, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("invalid asset path");
    return;
  }
  if (!fs.existsSync(fullPath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const extension = path.extname(fullPath).toLowerCase();
  const contentType = extension === ".opus"
    ? "audio/ogg"
    : extension === ".wav"
      ? "audio/wav"
      : extension === ".mp3"
        ? "audio/mpeg"
        : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  fs.createReadStream(fullPath).pipe(response);
}

export async function uploadTtsReferenceAudio(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readRawBody(request, { maxBytes: maxTtsReferenceUploadBytes });
  if (body.length === 0) {
    writeJson(response, 400, { ok: false, error: "empty_upload" });
    return;
  }
  const referenceText = decodeHeaderFileName(optionalString(request.headers?.["x-reference-text"]) ?? "").trim();
  if (!referenceText) {
    writeJson(response, 400, { ok: false, error: "reference_text_required" });
    return;
  }
  const fileName = decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? "");
  const extension = path.extname(fileName).toLowerCase();
  if (![".wav", ".mp3", ".m4a"].includes(extension)) {
    writeJson(response, 400, { ok: false, error: "unsupported_reference_audio_type" });
    return;
  }
  const referencePath = resolveTtsAssetPath(context, context.config.tts.genieReferenceAudio);
  const mossReferencePath = resolveTtsAssetPath(context, context.config.tts.mossReferenceAudio);
  const referenceTextPath = resolveTtsAssetPath(context, context.config.tts.genieReferenceText);
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.mkdirSync(path.dirname(mossReferencePath), { recursive: true });
  fs.mkdirSync(path.dirname(referenceTextPath), { recursive: true });
  const tempDir = path.join(path.dirname(referencePath), `.alice-tts-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const inputPath = path.join(tempDir, `source${extension}`);
  const convertedPath = path.join(tempDir, "reference.wav");
  try {
    fs.writeFileSync(inputPath, body);
    const codecConfig = readMossCodecConfig(context);
    await convertReferenceAudio(inputPath, convertedPath, context.config.tts.mossFfmpegCommand, codecConfig);
    fs.renameSync(convertedPath, referencePath);
    if (path.resolve(mossReferencePath) !== path.resolve(referencePath)) {
      fs.writeFileSync(mossReferencePath, fs.readFileSync(referencePath));
    }
    fs.writeFileSync(referenceTextPath, Buffer.from(`${referenceText}\n`, "utf8"));
    const stat = fs.statSync(referencePath);
    context.appendLog("info", `tts reference audio converted: ${fileName || "upload"} -> ${referencePath} ${codecConfig.sampleRate}Hz/${codecConfig.channels}ch max=${maxTtsReferenceDurationSeconds}s`);
    writeJson(response, 200, {
      ok: true,
      referenceAudio: context.config.tts.genieReferenceAudio,
      mossReferenceAudio: context.config.tts.mossReferenceAudio,
      referenceText: context.config.tts.genieReferenceText,
      sourceFileName: fileName,
      sourceSize: body.length,
      size: stat.size,
      sampleRate: codecConfig.sampleRate,
      channels: codecConfig.channels,
      format: "pcm_s16le_wav",
      maxDurationSeconds: maxTtsReferenceDurationSeconds
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.appendLog("warn", `tts reference audio convert failed: ${message}`);
    writeJson(response, 400, { ok: false, error: message });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function generateTtsPreview(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const text = requiredString(body.text);
  if (!text) {
    writeJson(response, 400, { ok: false, error: "text_required" });
    return;
  }
  if (Array.from(text).length > 240) {
    writeJson(response, 400, { ok: false, error: "text_too_long" });
    return;
  }
  try {
    await ensureTtsReferenceWithinLimit(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.appendLog("warn", `tts reference audio guard failed: ${message}`);
    writeJson(response, 400, { ok: false, error: message });
    return;
  }
  const synthesizer = createConfiguredVoiceSynthesizer(context.config.tts, {
    appendLog: context.appendLog
  });
  try {
    const result = await synthesizer({ text, time: context.time });
    const audioUrl = ttsAudioUrl(context, result.filePath);
    context.appendLog("info", `tts preview generated: ${result.assetId}`);
    writeJson(response, 200, {
      ok: true,
      text,
      assetId: result.assetId,
      filePath: result.filePath,
      audioUrl
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.appendLog("warn", `tts preview failed: ${message}`);
    writeJson(response, 500, { ok: false, error: message });
  } finally {
    await synthesizer.shutdown?.();
  }
}
