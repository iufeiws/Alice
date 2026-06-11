import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { TtsTokenUsageRecorder } from "./types.js";

export function recordTtsApiUsage(
  deps: { recordTokenUsageEvent?: TtsTokenUsageRecorder; appendLog?(level: "info" | "warn" | "error", message: string): void },
  input: {
    time: CurrentTimeProvider;
    provider: string;
    model?: string;
    text: string;
  }
): void {
  if (!deps.recordTokenUsageEvent) return;
  const chars = Array.from(input.text).length;
  const createdTime = input.time.now();
  const model = `tts:${input.provider}${input.model ? `:${input.model}` : ""}`;
  try {
    deps.recordTokenUsageEvent({
      createdAt: createdTime.iso,
      createdAtUtc: createdTime.date.toISOString(),
      agentId: "tts",
      model,
      result: {
        message: { role: "assistant", content: "" },
        usage: {
          inputTokens: chars,
          outputTokens: 0,
          totalTokens: chars
        },
        raw: {
          usage: {
            type: "tts_api",
            provider: input.provider,
            model: input.model,
            utf_chars: chars
          }
        }
      }
    });
  } catch (error) {
    deps.appendLog?.("warn", `tts api usage persist failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
