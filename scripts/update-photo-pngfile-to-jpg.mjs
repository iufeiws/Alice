import { execFileSync } from "node:child_process";
import fs from "node:fs";
import moduleApi from "node:module";
import path from "node:path";

const require = moduleApi.createRequire(import.meta.url);
const ffmpegPath = String(require("ffmpeg-static") || "ffmpeg");
const files = [
  ...pngFilesIn("assets/selfie/references"),
  ...pngFilesIn("assets/generated/selfies")
];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const output = file.replace(/\.png$/i, ".jpg");
  execFileSync(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-q:v",
    "1",
    output
  ]);
  fs.rmSync(file);
  console.log(`${file} -> ${output}`);
}

function pngFilesIn(dir) {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .map((name) => path.join(dir, name))
    : [];
}
