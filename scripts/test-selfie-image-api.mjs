#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

loadDotEnv(path.join(repoRoot, ".env"));
installProxyAgent();

const apiKey = process.env.OPENAI_API_KEY;
const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const model = process.env.SELFIE_IMAGE_API_MODEL ?? "gpt-image-2";
const size = process.env.SELFIE_IMAGE_API_SIZE ?? "768x1024";
const quality = process.env.SELFIE_IMAGE_API_QUALITY ?? "low";
const outputFormat = process.env.SELFIE_IMAGE_API_OUTPUT_FORMAT ?? "jpeg";
const outputCompression = process.env.SELFIE_IMAGE_API_OUTPUT_COMPRESSION ?? "45";
const action = process.argv.slice(2).join(" ").trim() || "lean close to the camera, tilt her head slightly, with a shy expression";

if (!apiKey) {
  console.error("OPENAI_API_KEY is required. Put it in /home/wyf98/Alice/.env or export it in the shell.");
  process.exit(2);
}

const referencesDir = path.join(repoRoot, "assets", "selfie", "references");
const outputDir = path.join(repoRoot, "assets", "generated", "selfies", "api-tests");
const outputName = `selfie_api_${formatDateTime(new Date())}.${outputFormat === "jpeg" ? "jpg" : outputFormat}`;
const outputPath = path.join(outputDir, outputName);
const prompt = buildPrompt(action);
const imagePaths = [
  path.join(referencesDir, "alice-character-reference.png"),
  resolveOutfitImage(),
  path.join(referencesDir, "magic-library-reference.png")
];

for (const imagePath of imagePaths) {
  if (!fs.existsSync(imagePath)) throw new Error(`Missing reference image: ${imagePath}`);
}

fs.mkdirSync(outputDir, { recursive: true });

const form = new FormData();
form.append("model", model);
form.append("prompt", prompt);
form.append("n", "1");
form.append("size", size);
form.append("quality", quality);
form.append("output_format", outputFormat);
form.append("output_compression", outputCompression);
for (const imagePath of imagePaths) {
  form.append("image[]", await fileBlob(imagePath), path.basename(imagePath));
}

console.error(`Calling Image API edit: model=${model} size=${size} quality=${quality} format=${outputFormat} compression=${outputCompression}`);
console.error(`References: ${imagePaths.map((value) => path.relative(repoRoot, value)).join(", ")}`);
console.error(`Output: ${path.relative(repoRoot, outputPath)}`);

const started = performance.now();
const response = await fetch(`${baseUrl}/images/edits`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`
  },
  body: form
});
const elapsedSeconds = (performance.now() - started) / 1000;
const bodyText = await response.text();

if (!response.ok) {
  console.error(`Image API failed after ${elapsedSeconds.toFixed(1)}s: HTTP ${response.status}`);
  console.error(bodyText.slice(0, 4000));
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(bodyText);
} catch {
  console.error(`Image API returned non-JSON after ${elapsedSeconds.toFixed(1)}s`);
  console.error(bodyText.slice(0, 4000));
  process.exit(1);
}

const b64 = payload?.data?.[0]?.b64_json;
if (typeof b64 !== "string" || !b64) {
  console.error(`Image API returned no b64_json after ${elapsedSeconds.toFixed(1)}s`);
  console.error(JSON.stringify(payload, null, 2).slice(0, 4000));
  process.exit(1);
}

fs.writeFileSync(outputPath, Buffer.from(b64, "base64"));
const stat = fs.statSync(outputPath);
console.error(`Completed in ${elapsedSeconds.toFixed(1)}s, wrote ${outputPath} (${Math.round(stat.size / 1024)} KiB)`);

function buildPrompt(actionText) {
  const template = fs.readFileSync(path.join(referencesDir, "selfie-prompt.txt"), "utf8");
  const profile = JSON.parse(fs.readFileSync(path.join(repoRoot, "memory-files", "config", "prompt-profile.json"), "utf8"));
  const shell = JSON.parse(fs.readFileSync(path.join(repoRoot, "memory-files", "shell", "daily-shell.json"), "utf8"));
  const outfit = readShellPart("outfits", shell.outfitId);
  const personality = readShellPart("personalities", shell.personalityId);
  return [
    template
      .replaceAll("{{action}}", actionText)
      .replaceAll("{{char}}", extractCharacterFeatures(renderProfilePrompt(profile)))
      .replaceAll("{{persenality}}", formatNamedBlock(personality.name, personality.content))
      .replaceAll("{{personality}}", formatNamedBlock(personality.name, personality.content))
      .replaceAll("{{dress}}", formatNamedBlock(outfit.name, outfit.content)),
    "",
    "API test constraints:",
    `- Generate one fast low-quality draft at ${size}.`,
    "- Keep the image small; avoid high detail and avoid multiple variations.",
    "- Use the three input images in order: character reference, outfit reference, library scene reference."
  ].join("\n");
}

function renderProfilePrompt(profile) {
  return (profile.layers ?? [])
    .filter((layer) => layer && layer.enabled !== false && typeof layer.content === "string")
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .map((layer) => layer.content)
    .join("\n\n");
}

function extractCharacterFeatures(mainPrompt) {
  const match = /外貌特征:\s*([\s\S]*?)(?:\n\s*\n|你与\s*<user>|你的默认语言特征|$)/.exec(mainPrompt);
  if (match?.[1]?.trim()) return `外貌特征:\n${match[1].trim()}`;
  return [
    "外貌特征:",
    "发色: 低饱和浅金色",
    "发型: 长发及腰，发尾有自然的卷曲，额前留着整齐的刘海",
    "耳朵: 尖长的精灵耳",
    "眼睛: 浅金色",
    "体型: 少女体型，身体尚未完全长开",
    "身高: 155cm"
  ].join("\n");
}

function readShellPart(kind, id) {
  const filePath = path.join(repoRoot, "memory-files", "shell", kind, `${safeFilePart(id)}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveOutfitImage() {
  const shell = JSON.parse(fs.readFileSync(path.join(repoRoot, "memory-files", "shell", "daily-shell.json"), "utf8"));
  const outfit = readShellPart("outfits", shell.outfitId);
  const imageUrl = typeof outfit.imageUrl === "string" && outfit.imageUrl.trim()
    ? outfit.imageUrl.trim()
    : path.join("memory-files", "shell", "outfits", `${safeFilePart(shell.outfitId)}.jpg`);
  return path.resolve(repoRoot, imageUrl);
}

function formatNamedBlock(name, content) {
  return [name, content].map((part) => String(part ?? "").trim()).filter(Boolean).join("\n");
}

function safeFilePart(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function fileBlob(filePath) {
  const bytes = fs.readFileSync(filePath);
  return new Blob([bytes], { type: contentType(filePath) });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function formatDateTime(date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: process.env.AGENT_TIMEZONE ?? "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(trimmed.slice(eq + 1).trim());
  }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function installProxyAgent() {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return;
  const { setGlobalDispatcher, ProxyAgent } = loadUndici();
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.error(`Using proxy: ${redactProxy(proxy)}`);
}

function loadUndici() {
  try {
    return require("undici");
  } catch {
    return require("/usr/share/nodejs/undici");
  }
}

function redactProxy(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? "<user>" : "";
      url.password = url.password ? "<password>" : "";
    }
    return url.toString();
  } catch {
    return "<invalid proxy url>";
  }
}
