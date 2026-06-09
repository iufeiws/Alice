export type WebRtcVoiceErrorCode =
    | "plugin_disabled"
    | "asr_preflight_failed"
    | "outbound_track_failed"
    | "webrtc_negotiation_failed"
    | "asr_stream_failed"
    | "tts_failed";

export class WebRtcVoiceError extends Error {
  constructor(public readonly code: WebRtcVoiceErrorCode, message?: string) {
    message ??= code;
    super(message);
  }
}
