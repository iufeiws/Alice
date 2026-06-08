import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import type { createAsrPlugin } from "../../asr/src/index.js";
import {
  attachWebRtcVoiceSignalingServer,
  createWebRtcVoicePlugin,
  createWeriftPeer,
  decodeAudioFileToOpusRtpFrames,
  defaultWebRtcVoiceConfig,
  encodePcmL16StreamToOpusRtpFrames,
  encodePcmL16ToOpusRtpFrames,
  type WebRtcVoiceCall,
  type WebRtcVoiceStatusEvent
} from "./index.js";
import { createAsrInboundStreamSession } from "../../asr/src/index.js";
import type { TalkRuntime } from "../../../core/agent/src/talk-runtime.js";
import type { voiceCallRoutes } from "../../../apps/api/routes/voice-call-contract.js";
import type { LLMApiPreset } from "../../../core/llm/src/llm-api-profile.js";

type WebRtcVoiceClient = { send(message: unknown): void };
type AsrPlugin = ReturnType<typeof createAsrPlugin>;

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createWebRtcVoiceRuntime(input: {
  time: CurrentTimeProvider;
  asrPlugin: AsrPlugin;
  voiceSynthesizer: unknown;
  talkRuntime: TalkRuntime;
  readLLMApiPresets(): LLMApiPreset[];
  appendLog: AppendLog;
}) {
  const calls = new Map<string, WebRtcVoiceCall>();
  const clients = new Set<WebRtcVoiceClient>();
  const plugin = createWebRtcVoicePlugin({
    config: defaultWebRtcVoiceConfig(),
    time: input.time,
    async createPeer(peerInput) {
      return createWeriftPeer({
        ...peerInput,
        onStatus: (event) => input.appendLog("info", `webrtc voice ${event.state}${event.detail ? `: ${event.detail}` : ""}`)
      });
    },
    createAsrSession(start) {
      return createAsrInboundStreamSession(start, input.asrPlugin.config, {
        resolveApiPreset(name) {
          return input.readLLMApiPresets().find((entry) => entry.name === name);
        },
        appendLog: input.appendLog
      });
    },
    voiceSynthesizer: input.voiceSynthesizer as any,
    decodeAudioFileToFrames(decodeInput) {
      return decodeAudioFileToOpusRtpFrames(decodeInput);
    },
    encodePcmL16ToFrames(encodeInput) {
      return encodePcmL16ToOpusRtpFrames(encodeInput);
    },
    encodePcmL16StreamToFrames(encodeInput) {
      return encodePcmL16StreamToOpusRtpFrames(encodeInput);
    },
    talkRuntime: input.talkRuntime,
    async testAsr() {
      const testAudioPath = input.asrPlugin.config.testAudioPath;
      if (!testAudioPath) return { ok: false, error: "missing_asr_test_audio", message: "ASR test audio is not configured" };
      const path = await import("node:path");
      const result = await input.asrPlugin.transcribe({
        audioFile: testAudioPath,
        filename: path.basename(testAudioPath),
        language: plugin.config.language
      });
      return "ok" in result && result.ok === false
        ? { ok: false, error: result.error, message: result.message ?? result.error }
        : { ok: true };
    },
    emitStatus(event) {
      input.appendLog("info", `webrtc voice ${event.state}${event.detail ? `: ${event.detail}` : ""}`);
      broadcastStatus(event);
    }
  });

  return {
    plugin,
    calls,
    attachSignalingServers(servers: unknown[], routes: typeof voiceCallRoutes) {
      for (const server of servers.filter(Boolean)) {
        for (const signalingPath of [routes.signaling, plugin.config.signalingPath]) {
          attachWebRtcVoiceSignalingServer({
            server: server as any,
            plugin,
            path: signalingPath,
            appendLog: input.appendLog,
            onCallCreated(call) {
              calls.set(call.callId, call);
            },
            onClientConnected(client) {
              clients.add(client);
              return () => clients.delete(client);
            }
          });
        }
      }
    }
  };

  function broadcastStatus(event: WebRtcVoiceStatusEvent) {
    const message = { type: "status", state: event.state, detail: event.detail };
    for (const client of clients) {
      try {
        client.send(message);
      } catch (error) {
        clients.delete(client);
        input.appendLog("warn", `webrtc voice status broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
