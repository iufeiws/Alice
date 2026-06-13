#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");

if (process.argv[2] !== "--tool-input" || !process.argv[3]) {
  console.error("usage: run-alice-selfie-fast.mjs --tool-input <config.json>");
  process.exit(64);
}

const input = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const workDir = requireString(input.workDir, "workDir");
const codexWorkDir = stringValue(input.codexWorkDir) || workDir;
const fileName = requireString(input.fileName, "fileName");
const prompt = requireString(input.prompt, "prompt");
const referenceImages = requireStringArray(input.referenceImages, "referenceImages");
const referenceImagePrompt = requireString(input.referenceImagePrompt, "referenceImagePrompt");
const aspectRatio = requireString(input.aspectRatio, "aspectRatio");
const codexCommand = stringValue(input.codexCommand) || process.env.SELFIE_CODEX_COMMAND || "codex";
const timeoutMs = positiveNumber(input.timeoutMs, 60_000);
const outputPath = path.join(workDir, fileName);
const skillInstructions = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
const codexReferenceImages = copyReferenceImagesToCodexWorkDir(referenceImages, codexWorkDir);
const imageArgs = codexReferenceImages.map((image) => `--image=${image}`);
const beforeImages = snapshotGeneratedImages();

const codexPrompt = [
  "Apply these skill instructions exactly:",
  "```markdown",
  skillInstructions,
  "```",
  "",
  "Task prompt:",
  "```text",
  prompt,
  "```",
  "",
  "Task metadata:",
  `Aspect ratio: ${aspectRatio}`,
  referenceImagePrompt,
  "",
  "The image files are attached with --image in the same order as the task metadata."
].join("\n");

const started = Date.now();
const result = await execFile(codexCommand, [
  "exec",
  "-C",
  codexWorkDir,
  "--ephemeral",
  "--ignore-user-config",
  "--disable",
  "plugins",
  "--disable",
  "apps",
  "-m",
  "gpt-5.4-mini",
  "-c",
  "model_reasoning_effort=\"low\"",
  "--sandbox",
  "workspace-write",
  "--json",
  ...imageArgs,
  codexPrompt
], timeoutMs, sanitizedEnv());

const generatedPath = findNewGeneratedImage(beforeImages, started);
if (!generatedPath) {
  throw new Error("codex selfie generation did not create a new generated image");
}
copyGeneratedImage(generatedPath, outputPath);
console.error(`alice-selfie-fast completed in ${Date.now() - started}ms; source=${generatedPath}; file=${fileName}`);
if (result.stdout.trim()) process.stdout.write(result.stdout);

function execFile(command, args, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error([
        `selfie generation timed out after ${timeoutMs}ms`,
        Buffer.concat(stderrChunks).toString("utf8").trim(),
        Buffer.concat(stdoutChunks).toString("utf8").trim()
      ].filter(Boolean).join("\n")));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error([`codex exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`, stderr.trim(), stdout.trim()].filter(Boolean).join("\n")));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function copyGeneratedImage(sourcePath, targetPath) {
  if (!path.isAbsolute(sourcePath)) throw new Error(`generated image path is not absolute: ${sourcePath}`);
  const ext = path.extname(sourcePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) throw new Error(`generated image extension is not allowed: ${sourcePath}`);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error(`generated image path is not a file: ${sourcePath}`);
  fs.copyFileSync(sourcePath, targetPath);
}

function copyReferenceImagesToCodexWorkDir(images, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  return images.map((image, index) => {
    const ext = path.extname(image).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) throw new Error(`reference image extension is not allowed: ${image}`);
    const sourceStat = fs.statSync(image);
    if (!sourceStat.isFile()) throw new Error(`reference image path is not a file: ${image}`);
    const targetPath = path.join(targetDir, `reference-${index + 1}${ext}`);
    fs.copyFileSync(image, targetPath);
    return targetPath;
  });
}

function findNewGeneratedImage(beforeImages, startedAtMs) {
  let newest;
  for (const image of listGeneratedImages()) {
    const previousMtime = beforeImages.get(image.filePath);
    if (previousMtime !== undefined && previousMtime === image.mtimeMs) continue;
    if (image.mtimeMs < startedAtMs - 5_000) continue;
    if (!newest || image.mtimeMs > newest.mtimeMs) newest = image;
  }
  return newest?.filePath;
}

function snapshotGeneratedImages() {
  const snapshot = new Map();
  for (const image of listGeneratedImages()) snapshot.set(image.filePath, image.mtimeMs);
  return snapshot;
}

function listGeneratedImages() {
  const generatedRoot = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex"), "generated_images");
  const images = [];
  if (!fs.existsSync(generatedRoot)) return images;
  for (const filePath of walkFiles(generatedRoot)) {
    const ext = path.extname(filePath).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) continue;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    images.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  return images;
}

function* walkFiles(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(filePath);
    } else if (entry.isFile()) {
      yield filePath;
    }
  }
}

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "OPENAI_API_KEY" || key === "OPENAI_BASE_URL" || key.startsWith("SELFIE_IMAGE_API_")) {
      delete env[key];
    }
  }
  return env;
}

function requireString(value, name) {
  const text = stringValue(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
