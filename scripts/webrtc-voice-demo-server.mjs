import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAsrInboundStreamSession, createAsrPlugin } from "../plugins/asr/src/index.ts";
import { createJapaneseVoicePlugin } from "../plugins/japanese-voice/src/index.ts";
import {
  attachWebRtcVoiceSignalingServer,
  createWebRtcVoicePlugin,
  createWeriftPeer,
  decodeAudioFileToOpusRtpFrames,
  defaultWebRtcVoiceConfig,
  encodePcmL16ToOpusRtpFrames
} from "../plugins/webrtc-voice/src/index.ts";
import { createConfiguredVoiceSynthesizer } from "../plugins/messaging/src/index.ts";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3041);
const geniePort = Number(process.env.GENIE_TTS_PORT || 8768);
const certDir = path.join(os.tmpdir(), "alice-webrtc-voice-demo-cert");
const certPath = path.join(certDir, "cert.pem");
const keyPath = path.join(certDir, "key.pem");

ensureCertificate();

const asr = createAsrPlugin();
const baseVoiceSynthesizer = createConfiguredVoiceSynthesizer({
  backend: "genie-tts",
  geniePort,
  genieIdleShutdownMs: 0
}, {
  appendLog(level, message) {
    console.log(`[tts:${level}] ${message}`);
  }
});
const japaneseVoice = createJapaneseVoicePlugin({
  baseSynthesizer: baseVoiceSynthesizer,
  llmRequestSender: async (input) => ({
    message: {
      role: "assistant",
      content: String(input.messages.at(-1)?.content ?? "")
    }
  })
});

const config = {
  ...defaultWebRtcVoiceConfig(),
  enabled: true,
  callPath: "/plugins/webrtc-voice/call",
  signalingPath: "/plugins/webrtc-voice/signaling",
  language: "ja",
  inboundAudio: {
    sampleRateHz: 16_000,
    channels: 1,
    encoding: "pcm_s16le",
    chunkMs: 100
  },
  bargeIn: {
    enabled: true,
    minSpeechMs: 250
  }
};

const clients = new Set();
const plugin = createWebRtcVoicePlugin({
  config,
  createPeer: (input) => createWeriftPeer({
    ...input,
    onStatus: (event) => broadcastStatus(event)
  }),
  createAsrSession: (start) => createAsrInboundStreamSession(start, asr.config),
  voiceSynthesizer: japaneseVoice.voiceSynthesizer,
  decodeAudioFileToFrames: decodeAudioFileToOpusRtpFrames,
  encodePcmL16ToFrames: encodePcmL16ToOpusRtpFrames,
  emitStatus: (event) => broadcastStatus(event),
  appendLog(level, message) {
    console.log(`[voice:${level}] ${message}`);
  }
});

const server = https.createServer({
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath)
}, (request, response) => {
  const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === config.callPath) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(plugin.renderCallPage());
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "webrtc-voice-demo", port, geniePort }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});

attachWebRtcVoiceSignalingServer({
  server,
  plugin,
  appendLog(level, message) {
    console.log(`[signal:${level}] ${message}`);
  },
  onClientConnected(client) {
    clients.add(client);
  }
});

server.listen(port, host, () => {
  console.log(`WebRTC voice demo listening on https://${host}:${port}${config.callPath}`);
  console.log(`Independent Genie TTS port: ${geniePort}`);
});

function broadcastStatus(event) {
  console.log(`[voice] ${event.state}${event.detail ? ` ${event.detail}` : ""}`);
  for (const client of clients) {
    try {
      client.send({ type: "status", state: event.state, detail: event.detail });
    } catch {
      clients.delete(client);
    }
  }
}

function ensureCertificate() {
  fs.mkdirSync(certDir, { recursive: true });
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "7",
    "-subj",
    "/CN=alice-webrtc-voice-demo"
  ], { stdio: "ignore" });
}
