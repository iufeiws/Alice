import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAsrInboundStreamSession, createAsrPlugin } from "../plugins/asr/src/index.ts";
import {
  createTtsPlugin,
  createTtsRemoteAwareVoiceSynthesizer,
  readTtsPluginConfig
} from "../plugins/tts/src/index.ts";
import {
  attachWebRtcVoiceSignalingServer,
  createWebRtcVoicePlugin,
  createWeriftPeer,
  decodeAudioFileToOpusRtpFrames,
  defaultWebRtcVoiceConfig,
  encodePcmL16StreamToOpusRtpFrames,
  encodePcmL16ToOpusRtpFrames
} from "../plugins/webrtc-voice/src/index.ts";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3041);
const ttsConfigPath = process.env.TTS_CONFIG_PATH || "config/plugin/tts/config.json";
const memoryFilesRoot = process.env.MEMORY_FILES_ROOT || "memory-files";
const certDir = path.join(os.tmpdir(), "alice-webrtc-voice-demo-cert");
const certPath = path.join(certDir, "cert.pem");
const keyPath = path.join(certDir, "key.pem");

ensureCertificate();

const asr = createAsrPlugin();
const ttsPluginConfig = readTtsPluginConfig(ttsConfigPath);
const baseVoiceSynthesizer = createTtsRemoteAwareVoiceSynthesizer({
  ttsConfigPath
}, {
  appendLog(level, message) {
    console.log(`[tts:${level}] ${message}`);
  }
});
const ttsPlugin = createTtsPlugin({
  baseSynthesizer: baseVoiceSynthesizer,
  configPath: ttsConfigPath,
  resolveApiPreset(name) {
    return readLLMApiPresets(memoryFilesRoot).find((entry) => entry.name === name);
  },
  appendLog(level, message) {
    console.log(`[tts:${level}] ${message}`);
  }
});
console.log(`TTS plugin config: ${ttsConfigPath}`);
console.log(`TTS remote Genie: ${ttsPluginConfig.remote?.enabled === false ? "disabled" : ttsPluginConfig.remote?.baseURL ?? "default"}`);

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
  voiceSynthesizer: ttsPlugin.voiceSynthesizer,
  decodeAudioFileToFrames: decodeAudioFileToOpusRtpFrames,
  encodePcmL16ToFrames: encodePcmL16ToOpusRtpFrames,
  encodePcmL16StreamToFrames: encodePcmL16StreamToOpusRtpFrames,
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
    response.end(JSON.stringify({
      ok: true,
      service: "webrtc-voice-demo",
      port,
      ttsConfigPath,
      ttsRemoteBaseURL: ttsPluginConfig.remote?.baseURL,
      ttsRemoteEnabled: ttsPluginConfig.remote?.enabled !== false
    }));
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
  console.log(`Using TTS plugin remote-aware voice flow`);
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
  const altNames = certificateAltNames();
  if (fs.existsSync(certPath) && fs.existsSync(keyPath) && certificateMatchesAltNames(altNames)) return;
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
    "-subj", "/CN=alice-webrtc-voice-demo",
    "-addext", `subjectAltName=${altNames.join(",")}`
  ], { stdio: "ignore" });
}

function certificateAltNames() {
  const names = new Set(["DNS:localhost", "IP:127.0.0.1"]);
  const hostname = os.hostname();
  if (hostname) names.add(`DNS:${hostname}`);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      names.add(`IP:${entry.address}`);
    }
  }
  return [...names];
}

function certificateMatchesAltNames(altNames) {
  try {
    const output = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-ext", "subjectAltName"], { encoding: "utf8" });
    return altNames.every((name) => output.includes(name.replace(/^DNS:/, "DNS:").replace(/^IP:/, "IP Address:")));
  } catch {
    return false;
  }
}

function readLLMApiPresets(root) {
  const filePath = path.join(root, "config", "llm-api-presets.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const presets = Array.isArray(parsed) ? parsed : Array.isArray(parsed.presets) ? parsed.presets : [];
    return presets.map(normalizeLLMApiPreset).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeLLMApiPreset(value) {
  if (!value || typeof value !== "object" || !value.name || !value.model) return undefined;
  return {
    name: String(value.name),
    baseURL: typeof value.baseURL === "string" ? value.baseURL : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : undefined,
    model: String(value.model),
    temperature: Number.isFinite(Number(value.temperature)) ? Number(value.temperature) : 0.2,
    timeoutMs: Number.isFinite(Number(value.timeoutMs)) ? Number(value.timeoutMs) : 60_000,
    extraParams: value.extraParams && typeof value.extraParams === "object" && !Array.isArray(value.extraParams) ? value.extraParams : {}
  };
}
