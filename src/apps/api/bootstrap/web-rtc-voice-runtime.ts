import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { createAsrPlugin } from "../../../channels/asr/src/index.js";
import {
  attachWebRtcVoiceSignalingServer,
  createMediaProcessPeer,
  createWebRtcVoicePlugin,
  decodeAudioFileToOpusRtpFrames,
  defaultWebRtcVoiceConfig,
  type WebRtcVoiceCall,
  type WebRtcVoiceTtsArchiveInput,
  type WebRtcVoiceStatusEvent
} from "../../../channels/webrtc-voice/src/index.js";
import type { TalkRuntime } from "../../../contexts/talk-session/src/application/talk-session-runtime.js";
import type { voiceCallRoutes } from "../routes/voice-call-contract.js";
import type { LLMApiPreset } from "../../../contexts/llm-gateway/src/llm-api-profile.js";

type WebRtcVoiceClient = { callId: string; send(message: unknown): void };
type AsrPlugin = ReturnType<typeof createAsrPlugin>;

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createWebRtcVoiceRuntime(input: {
  config?: any;
  time: CurrentTimeProvider;
  asrPlugin: AsrPlugin;
  voiceSynthesizer: unknown;
  talkRuntime: TalkRuntime;
  supportsAudioInput(): boolean;
  readLLMApiPresets(): LLMApiPreset[];
  appendLog: AppendLog;
}) {
  const calls = new Map<string, WebRtcVoiceCall>();
  const clients = new Set<WebRtcVoiceClient>();
  const plugin = createWebRtcVoicePlugin({
    config: defaultWebRtcVoiceConfig(),
    time: input.time,
    async createPeer(peerInput) {
      return createMediaProcessPeer({
        ...peerInput,
        config: defaultWebRtcVoiceConfig(),
        onStatus: (event) => {
          input.appendLog("info", `webrtc voice ${event.state}${event.detail ? `: ${event.detail}` : ""}`);
          broadcastStatus({ ...event, callId: event.callId ?? peerInput.callId });
        }
      });
    },
    createAsrSession(start) {
      return input.asrPlugin.createInboundStreamSession(start);
    },
    voiceSynthesizer: input.voiceSynthesizer as any,
    supportsAudioInput: () => input.asrPlugin.config.directAudioInputEnabled === true && input.supportsAudioInput(),
    decodeAudioFileToFrames(decodeInput) {
      return decodeAudioFileToOpusRtpFrames(decodeInput);
    },
    archiveTtsOutput(archiveInput) {
      return archiveVoiceCallTtsOutput(archiveInput, {
        outputDir: input.config?.tts?.voiceCallTrainingOutputDir ?? "assets/generated/tts-training/voice-call",
        time: input.time
      });
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
    const message = { type: "status", callId: event.callId, state: event.state, detail: event.detail };
    for (const client of clients) {
      if (event.callId && client.callId !== event.callId) continue;
      try {
        client.send(message);
      } catch (error) {
        clients.delete(client);
        input.appendLog("warn", `webrtc voice status broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function archiveVoiceCallTtsOutput(
  input: WebRtcVoiceTtsArchiveInput,
  options: { outputDir: string; time: CurrentTimeProvider }
): Promise<{ filePath: string }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const outputDir = path.resolve(options.outputDir);
  await fs.mkdir(outputDir, { recursive: true });

  const stamp = safePathPart(options.time.now().iso.replace(/[:.]/g, "-"));
  const outputPart = safePathPart(input.outputId ?? "output");
  const chunkPart = input.chunkId ? `-${safePathPart(input.chunkId)}` : "";
  const partSuffix = input.partIndex === undefined ? "" : `-part${input.partIndex + 1}`;
  const baseName = `${stamp}-${safePathPart(input.callId)}-${outputPart}${chunkPart}${partSuffix}`;

  let audioPath: string;
  if (input.audio) {
    audioPath = path.join(outputDir, `${baseName}.wav`);
    await fs.writeFile(audioPath, wrapPcm16AsWav(input.audio.chunks, input.audio.sampleRateHz, input.audio.channels));
  } else if (input.filePath) {
    const extension = path.extname(input.filePath) || ".audio";
    audioPath = path.join(outputDir, `${baseName}${extension}`);
    await fs.copyFile(input.filePath, audioPath);
  } else {
    audioPath = path.join(outputDir, `${baseName}.missing-audio`);
    await fs.writeFile(audioPath, "");
  }

  const metadata = {
    callId: input.callId,
    talkSessionId: input.talkSessionId,
    outputId: input.outputId,
    chunkId: input.chunkId,
    originalText: input.originalText,
    text: input.text,
    speakText: input.speakText,
    createdAt: input.createdAt,
    archivedAt: options.time.now().iso,
    status: input.status,
    source: input.source,
    partIndex: input.partIndex,
    partCount: input.partCount,
    assetId: input.assetId,
    sourceFilePath: input.filePath,
    audioFilePath: audioPath,
    sampleRateHz: input.audio?.sampleRateHz,
    channels: input.audio?.channels,
    encoding: input.audio?.encoding,
    bytes: input.audio?.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  };
  await fs.writeFile(`${audioPath}.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { filePath: audioPath };
}

function wrapPcm16AsWav(chunks: Uint8Array[], sampleRateHz: number, channels: number): Buffer {
  const dataSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, ...chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))]);
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "unknown";
}
