import type { WebRtcVoiceConfig } from "./types.js";

const defaultWebRtcInboundPcmAudio = {
  sampleRateHz: 16_000,
  channels: 1,
  encoding: "pcm_s16le",
  chunkMs: 100
} as const;

export function defaultWebRtcVoiceConfig(): WebRtcVoiceConfig {
  return {
    enabled: true,
    callPath: "/plugins/webrtc-voice/call",
    signalingPath: "/plugins/webrtc-voice/signaling",
    accountId: "main",
    language: "ja",
    inboundAudio: { ...defaultWebRtcInboundPcmAudio },
    outboundAudio: {
      sampleRateHz: 48000,
      channels: 1,
      frameMs: 20
    },
    iceServers: [],
    bargeIn: {
      enabled: true,
      minSpeechMs: 500
    },
    timeouts: {
      signalingIdleMs: 30_000,
      peerConnectionMs: 10_000,
      ttsPlaybackStartMs: 10_000,
      asrFinalMs: 8_000
    },
    ttsTextFilter: {
      stripParenthesized: true
    }
  };
}
