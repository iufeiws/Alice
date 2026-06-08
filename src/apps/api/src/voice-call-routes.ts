import fs from "node:fs";
import path from "node:path";

import { defaultVoiceCallConfigResponse, voiceCallRoutes } from "./voice-call-contract.js";
import { renderVoiceCallHtml } from "./voice-call-html.js";

export function handleVoiceCallRoute(request: any, response: any): boolean {
  if (request.method === "GET" && request.url === voiceCallRoutes.page) {
    writeHtml(response, 200, renderVoiceCallHtml());
    return true;
  }

  if (request.method === "GET" && request.url === voiceCallRoutes.config) {
    writeJson(response, 200, defaultVoiceCallConfigResponse());
    return true;
  }

  if (request.method === "GET" && request.url === voiceCallRoutes.portrait) {
    serveVoiceCallPortraitAsset(response);
    return true;
  }

  return false;
}

function serveVoiceCallPortraitAsset(response: any): void {
  const fullPath = path.resolve("docs", "app", "voice_call", "alice-default-portrait.png");
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
  fs.createReadStream(fullPath).pipe(response);
}

function writeJson(response: any, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeHtml(response: any, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}
