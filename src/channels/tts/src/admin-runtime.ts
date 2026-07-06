import { decodeHeaderFileName, resolveTtsOutputDir } from "./admin-assets.js";
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
