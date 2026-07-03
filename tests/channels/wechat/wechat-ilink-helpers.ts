import type { WeChatTextMessage } from "../../../src/channels/wechat/src/types.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

export function makeWechatTestDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rawWechatText(id: string, fromUserId: string, contextToken: string, text: string): WeChatTextMessage {
  return {
    id,
    fromUserId,
    contextToken,
    text,
    createdAt: "1770000000000",
    raw: { id, fromUserId, contextToken, text }
  };
}

export function writeSilentWav(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sampleRate = 24_000;
  const samples = sampleRate;
  const dataSize = samples * 2;
  const buffer = new Uint8Array(44 + dataSize);
  const view = new DataView(buffer.buffer);
  writeAscii(buffer, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(buffer, 8, "WAVE");
  writeAscii(buffer, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(buffer, 36, "data");
  view.setUint32(40, dataSize, true);
  fs.writeFileSync(filePath, buffer);
}

function writeAscii(buffer: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    buffer[offset + index] = text.charCodeAt(index);
  }
}
