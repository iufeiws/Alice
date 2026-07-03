import type { LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";

export const fs = await import("node:fs");
export const path = await import("node:path");
const os = await import("node:os");

export function namedClient(name: string): LLMClient {
  return {
    async chat() {
      return { message: { role: "assistant", content: name } };
    },
    async listModels() {
      return [{ id: name }];
    }
  };
}

export function fixedTime(iso: string) {
  const date = new Date(iso);
  return {
    timeZone: "UTC",
    now() {
      return {
        date,
        epochMs: date.getTime(),
        iso: date.toISOString().replace(/Z$/, ""),
        timeZone: "UTC"
      };
    },
    addMs(value: number) {
      const next = new Date(date.getTime() + value);
      return {
        date: next,
        epochMs: next.getTime(),
        iso: next.toISOString().replace(/Z$/, ""),
        timeZone: "UTC"
      };
    }
  };
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
