import type { WebRtcVoiceDeps, WebRtcVoicePlugin } from "./types.js";
import { WebRtcVoiceError } from "./errors.js";
import { renderCallPage } from "./call-page.js";
import { createCallState } from "./call-runtime.js";

export function createWebRtcVoicePlugin(deps: WebRtcVoiceDeps): WebRtcVoicePlugin {
  return {
    id: "webrtc_voice",
    config: deps.config,
    renderCallPage() {
      return renderCallPage(deps.config);
    },
    async createCall(input) {
      if (!deps.config.enabled) throw new WebRtcVoiceError("plugin_disabled");
      if (deps.testAsr) {
        deps.emitStatus?.({ state: "asr.preflight.started", detail: "checking" });
        const result = await deps.testAsr();
        if (!result.ok) {
          deps.emitStatus?.({ state: "asr.preflight.failed", detail: result.message ?? result.error });
          throw new WebRtcVoiceError("asr_preflight_failed", result.message ?? result.error);
        }
        deps.emitStatus?.({ state: "asr.preflight.ready", detail: "connected" });
      }
      deps.emitStatus?.({ state: "tts.prepare.started", detail: "connecting" });
      await deps.voiceSynthesizer.prepare?.();
      deps.emitStatus?.({ state: "tts.prepare.ready", detail: "connected" });
      const peer = await deps.createPeer({
        callId: input.callId,
        userId: input.userId,
        iceServers: deps.config.iceServers,
        onLocalIceCandidate: input.onLocalIceCandidate
      });
      const outboundTrack = await peer.createOutboundAudioTrack({
        sampleRateHz: deps.config.outboundAudio.sampleRateHz,
        channels: deps.config.outboundAudio.channels,
        frameMs: deps.config.outboundAudio.frameMs
      });
      if (!outboundTrack) throw new WebRtcVoiceError("outbound_track_failed", "server WebRTC outbound audio track is required");

      let answerSdp: string;
      try {
        answerSdp = await peer.createAnswer(input.offerSdp);
      } catch (error) {
        throw new WebRtcVoiceError("webrtc_negotiation_failed", error instanceof Error ? error.message : String(error));
      }

      return await createCallState(input, answerSdp, peer, outboundTrack, deps);
    }
  };
}
