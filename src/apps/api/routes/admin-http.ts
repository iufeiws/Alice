import { HttpJsonError } from "../middleware/http-utils.js";
import { AssetValidationError } from "../../../platform/storage/src/admin-asset-utils.js";

type AdminHttpLogContext = {
  appendLog(level: "error", message: string): void;
};

export function handleHttpError(context: AdminHttpLogContext, response: any, error: unknown): void {
  if (error instanceof HttpJsonError) return writeJson(response, error.statusCode, { ok: false, error: error.code });
  if (error instanceof AssetValidationError) return writeJson(response, 400, { ok: false, error: error.code });
  context.appendLog("error", `http request failed: ${error instanceof Error ? error.message : String(error)}`);
  writeJson(response, 500, { ok: false, error: "internal_error" });
}

export function writeJson(response: any, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function writeHtml(response: any, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}
