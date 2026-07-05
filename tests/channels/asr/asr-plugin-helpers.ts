import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AsrPluginConfig } from "../../../src/channels/asr/src/index.js";

const fixtureRoot = path.join(os.tmpdir(), "alice-tests", `alice-asr-plugin-tests-${process.pid}`);

export class FakeWebSocket {
  sent: Array<string | Uint8Array> = [];
  closed = false;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  emitMessage(data: string) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }
}

export function writeAudioFixture(fileName: string, size = 14): string {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const filePath = path.join(fixtureRoot, fileName);
  fs.writeFileSync(filePath, new Uint8Array(size).fill(1));
  return filePath;
}

export function writeAsrConfigFixture(fileName: string, config: AsrPluginConfig): string {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const filePath = path.join(fixtureRoot, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

export function assertAsrSuccess(result: unknown): asserts result is { text: string; provider: string; model?: string; language?: string; durationMs?: number; requestId?: string } {
  assert.equal(typeof result, "object");
  assert.ok(result !== null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "ok"), false);
}

export function assertAsrError(result: unknown): asserts result is { ok: false; error: string; message?: string } {
  assert.equal(typeof result, "object");
  assert.ok(result !== null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "ok"), true);
  assert.equal((result as { ok?: unknown }).ok, false);
}
