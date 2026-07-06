import type { AsrTranscribeError } from "./types.js";

export class AsrConfigError extends Error {
  constructor(public readonly code: AsrTranscribeError["error"]) {
    super(code);
  }
}
