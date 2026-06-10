export const voiceCallRoutes = {
  page: "/voice-call",
  config: "/voice-call/api/config",
  signaling: "/voice-call/api/signaling",
  portrait: "/voice-call/assets/alice-default-portrait.png"
} as const;

export type VoiceCallPhase =
  | "idle"
  | "preloading"
  | "permission_required"
  | "connecting"
  | "ringing"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

export type VoiceCallInputMode = "hold_to_talk" | "text";

export type VoiceCallAudioChunkTiming = {
  startMs: number;
  endMs: number;
  durationMs: number;
};

export type VoiceCallControlMessage =
  | { type: "hello"; clientId?: string; locale?: string; timezone?: string }
  | { type: "offer"; sdp: string }
  | { type: "ice"; candidate: unknown }
  | { type: "speech-state"; active: boolean }
  | { type: "audio-chunk"; data: string; timing?: VoiceCallAudioChunkTiming }
  | { type: "input-mode"; mode: VoiceCallInputMode }
  | { type: "hold-to-talk"; active: boolean }
  | { type: "mute"; muted: boolean }
  | { type: "wait"; active: boolean }
  | { type: "text-input"; text: string }
  | { type: "interrupt"; reason?: "manual" | "barge_in" }
  | { type: "hold"; reason?: "reload" | "pagehide" | "visibility" }
  | { type: "hangup"; reason?: string };

export type VoiceCallServerMessage =
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: unknown }
  | { type: "status"; state: string; detail?: string }
  | { type: "error"; error: string; message?: string };

export type VoiceCallConfigResponse = {
  routes: typeof voiceCallRoutes;
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  ui: {
    portraitUrl: string;
    maxWidthPx: number;
  };
  inboundAudio: {
    sampleRateHz: number;
    channels: number;
    encoding: "pcm_s16le";
    chunkMs: number;
  };
};

export function defaultVoiceCallConfigResponse(): VoiceCallConfigResponse {
  return {
    routes: voiceCallRoutes,
    iceServers: [],
    ui: {
      portraitUrl: voiceCallRoutes.portrait,
      maxWidthPx: 480
    },
    inboundAudio: {
      sampleRateHz: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      chunkMs: 100
    }
  };
}
