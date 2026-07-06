import type { AsrInboundStreamAcceptResult, AsrInboundStreamSession } from "../../asr/src/index.js";
import type { CreateWebRtcVoiceCallInput, WebRtcVoiceDeps } from "./types.js";

export function summarizeAsrFinalResult(result: AsrInboundStreamAcceptResult): string {
  if (!result.ok) return result.error;
  if (result.type === "final") return `final:${result.result.text.length}`;
  return result.type;
}

export async function acceptAsrFrame(
  session: AsrInboundStreamSession,
  frame: Parameters<AsrInboundStreamSession["accept"]>[0],
  deps: WebRtcVoiceDeps
): Promise<AsrInboundStreamAcceptResult> {
  try {
    return await session.accept(frame);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.emitStatus?.({ state: "asr.exception", detail });
    return {
      ok: false,
      type: "error",
      error: "provider_request_failed",
      streamId: frame.streamId,
      message: detail
    };
  }
}

export async function acceptAsrFinalFrame(
  session: AsrInboundStreamSession,
  frame: Parameters<AsrInboundStreamSession["accept"]>[0],
  deps: WebRtcVoiceDeps
): Promise<AsrInboundStreamAcceptResult> {
  const timeoutMs = deps.config.timeouts.asrFinalMs ?? 8_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      acceptAsrFrame(session, frame, deps),
      new Promise<AsrInboundStreamAcceptResult>((resolve) => {
        timer = setTimeout(() => {
          deps.emitStatus?.({ state: "asr.final.timeout", detail: `${frame.streamId}:${timeoutMs}` });
          resolve({
            ok: false,
            type: "error",
            error: "timeout",
            streamId: frame.streamId,
            message: `ASR final timed out after ${timeoutMs}ms`
          });
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isRecoverableAsrError(error: string): boolean {
  return error === "provider_request_failed"
    || error === "timeout"
    || error === "stream_closed"
    || error === "empty_transcription"
    || error === "empty_stream";
}

export function createCallAsrSession(
  input: CreateWebRtcVoiceCallInput,
  talkSessionId: number,
  asrStreamId: string,
  deps: WebRtcVoiceDeps
): AsrInboundStreamSession {
  deps.emitStatus?.({ state: "asr.stream.started", detail: asrStreamId });
  return deps.createAsrSession({
    type: "start",
    streamId: asrStreamId,
    audio: {
      filename: `${input.callId}.pcm`,
      mimeType: deps.config.inboundAudio.encoding === "webm_opus" ? "audio/webm" : "audio/pcm",
      sampleRateHz: deps.config.inboundAudio.sampleRateHz,
      channels: deps.config.inboundAudio.channels,
      encoding: deps.config.inboundAudio.encoding
    },
    language: deps.config.language,
    provider: deps.config.asrProvider,
    metadata: {
      plugin: "webrtc_voice",
      callId: input.callId,
      talkSessionId,
      talkRuntimeIngress: "todo"
    }
  });
}

export function handleAsrResult(result: AsrInboundStreamAcceptResult, deps: WebRtcVoiceDeps): void {
  if (!result.ok) {
    deps.emitStatus?.({ state: "asr.error", detail: result.error });
    return;
  }
  if (result.type === "partial") {
    deps.emitStatus?.({ state: "asr.partial", detail: result.text });
    return;
  }
  if (result.type === "final") {
    deps.emitStatus?.({ state: "talk_runtime.ingress.todo", detail: `audio.transcript.final: ${result.result.text}` });
  }
}
