#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

if (process.argv[2] === "--tool-input") {
  await runToolMode(process.argv[3]);
  process.exit(0);
}

const action = process.argv.slice(2).join(" ").trim() || "lean close to the camera, tilt her head slightly, with a shy expression";
const hardTimeoutMs = numberValue(process.env.ALICE_SELFIE_FAST_HARD_TIMEOUT_MS, 285_000);

const child = spawn("node", ["scripts/test-selfie-image-api.mjs", action], {
  cwd: repoRoot,
  env: {
    ...process.env,
    SELFIE_IMAGE_API_MODEL: process.env.SELFIE_IMAGE_API_MODEL ?? "gpt-image-2",
    SELFIE_IMAGE_API_SIZE: process.env.SELFIE_IMAGE_API_SIZE ?? "768x1024",
    SELFIE_IMAGE_API_QUALITY: process.env.SELFIE_IMAGE_API_QUALITY ?? "low",
    SELFIE_IMAGE_API_OUTPUT_FORMAT: process.env.SELFIE_IMAGE_API_OUTPUT_FORMAT ?? "jpeg",
    SELFIE_IMAGE_API_OUTPUT_COMPRESSION: process.env.SELFIE_IMAGE_API_OUTPUT_COMPRESSION ?? "45",
    SELFIE_IMAGE_API_TIMEOUT_MS: process.env.SELFIE_IMAGE_API_TIMEOUT_MS ?? "120000"
  },
  stdio: ["ignore", "inherit", "inherit"]
});

const started = Date.now();
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
}, hardTimeoutMs);

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(`alice-selfie-fast runner failed to start: ${error.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  clearTimeout(timer);
  const elapsedMs = Date.now() - started;
  if (signal) {
    console.error(`alice-selfie-fast hard timeout after ${elapsedMs}ms; signal=${signal}`);
    process.exit(124);
  }
  console.error(`alice-selfie-fast totalMs=${elapsedMs}`);
  process.exit(code ?? 1);
});

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runToolMode(configPath) {
  if (!configPath) throw new Error("--tool-input requires a config path");
  const input = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const apiKey = input.apiKey ?? process.env.SELFIE_IMAGE_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("selfie Image API key is not configured; set OPENAI_API_KEY or SELFIE_IMAGE_API_KEY");

  const outputPath = path.join(input.workDir, input.fileName);
  const prompt = [
    input.prompt,
    "",
    `画幅比例: ${input.aspectRatio}`,
    `API生成约束: 生成一张低质量快速草稿，尺寸目标 ${input.apiSize}，不要高清，不要高精细细节，不要多版本探索。`,
    input.referenceImagePrompt ?? "输入图片顺序: 图1为角色参考，图2为今日服装参考，图3为图书馆场景参考。"
  ].join("\n");

  const form = new FormData();
  form.append("model", input.apiModel);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", input.apiSize);
  form.append("quality", input.apiQuality);
  form.append("output_format", input.apiOutputFormat);
  if (input.apiOutputFormat === "jpeg" || input.apiOutputFormat === "webp") {
    form.append("output_compression", String(input.apiOutputCompression));
  }
  for (const image of input.referenceImages) {
    form.append("image[]", fileBlob(image), path.basename(image));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.apiTimeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${input.apiBaseURL}/images/edits`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`
      },
      body: form,
      ...dispatcherInit(input.proxyUrl)
    });
    const elapsedMs = Date.now() - started;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Image API failed after ${elapsedMs}ms: HTTP ${response.status} ${response.statusText} ${body.slice(0, 2000)}`);
    }
    const payload = JSON.parse(body);
    const b64 = payload?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) {
      throw new Error(`Image API returned no image after ${elapsedMs}ms: ${JSON.stringify(payload).slice(0, 2000)}`);
    }
    fs.writeFileSync(outputPath, Buffer.from(b64, "base64"));
    console.error(`Image API completed in ${elapsedMs}ms; file=${input.fileName}`);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Image API selfie generation timed out after ${input.apiTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function fileBlob(filePath) {
  return new Blob([fs.readFileSync(filePath)], { type: contentType(filePath) });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function dispatcherInit(proxyUrl) {
  if (!proxyUrl) return {};
  const { ProxyAgent } = loadUndici();
  return { dispatcher: new ProxyAgent(proxyUrl) };
}

function loadUndici() {
  try {
    return require("undici");
  } catch {
    return require("/usr/share/nodejs/undici");
  }
}
