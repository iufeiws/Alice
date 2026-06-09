const crypto = await import("node:crypto");
const nodeBuffer: any = (await import("node:buffer")).Buffer;

import type { WebRtcVoiceCall, WebRtcVoicePlugin } from "./types.js";
import { defaultTestSpeakText } from "./call-page.js";

export function attachWebRtcVoiceSignalingServer(input: {
  server: { on(event: "upgrade", listener: (request: any, socket: any, head: any) => void): unknown };
  plugin: WebRtcVoicePlugin;
  path?: string;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  onCallCreated?(call: WebRtcVoiceCall): void;
  onClientConnected?(client: { send(message: unknown): void }): void | (() => void);
}): void {
  const signalingPath = input.path ?? input.plugin.config.signalingPath;
  input.server.on("upgrade", (request: any, socket: any) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== signalingPath) return;
    try {
      acceptWebSocket(request, socket);
      const callId = url.searchParams.get("callId") || `browser-${Date.now()}`;
      const userId = url.searchParams.get("userId") || "browser";
      let call: WebRtcVoiceCall | undefined;
      let wsBuffer = nodeBuffer.alloc(0);
      const send = (message: unknown) => sendWebSocketFrame(socket, JSON.stringify(message));
      const cleanupClient = input.onClientConnected?.({ send });
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cleanupClient?.();
      };
      socket.on("close", cleanup);
      socket.on("end", cleanup);
      socket.on("error", cleanup);
      socket.on("data", async (chunk: any) => {
        try {
          const decoded = readWebSocketTextFrames(nodeBuffer.concat([wsBuffer, chunk]));
          wsBuffer = decoded.rest;
          for (const text of decoded.messages) {
            const message = JSON.parse(text) as { type?: string; sdp?: string; candidate?: unknown; reason?: string; text?: unknown };
            if (message.type === "offer" && message.sdp) {
              let answerSent = false;
              const pendingCandidates: unknown[] = [];
              call = await input.plugin.createCall({
                callId,
                userId,
                offerSdp: message.sdp,
                onLocalIceCandidate(candidate) {
                  if (answerSent) send({ type: "ice", candidate });
                  else pendingCandidates.push(candidate);
                }
              });
              input.onCallCreated?.(call);
              send({ type: "answer", sdp: call.answerSdp });
              answerSent = true;
              for (const candidate of pendingCandidates) send({ type: "ice", candidate });
              send({ type: "status", state: "webrtc.answer.created" });
            } else if (message.type === "ice") {
              await call?.acceptIceCandidate(message.candidate);
            } else if (message.type === "speech-state") {
              await call?.setSpeechActive(Boolean((message as { active?: unknown }).active));
            } else if (message.type === "hold-to-talk") {
              await call?.setSpeechActive(Boolean((message as { active?: unknown }).active));
            } else if (message.type === "text-input") {
              if (typeof message.text === "string") await call?.acceptTextInput?.(message.text);
            } else if (message.type === "audio-chunk") {
              const data = (message as { data?: unknown }).data;
              if (typeof data === "string") {
                await call?.acceptInboundAudioChunk(new Uint8Array(nodeBuffer.from(data, "base64")));
              }
            } else if (message.type === "speak-test") {
              try {
                const testText = typeof message.text === "string" && message.text.trim() ? message.text.trim() : defaultTestSpeakText;
                await call?.playReplyText(testText, "manual-test");
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                input.appendLog?.("error", `webrtc voice tts failed: ${message}`);
                send({ type: "status", state: "tts.failed", detail: message });
              }
            } else if (message.type === "interrupt") {
              await call?.interrupt("manual");
            } else if (message.type === "hangup") {
              await call?.close(message.reason);
              socket.end();
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.appendLog?.("error", `webrtc voice signaling message failed: ${message}`);
          send({ type: "error", error: "signaling_message_failed", message });
        }
      });
      socket.on("close", () => {
        void call?.close("socket_closed");
      });
    } catch (error) {
      input.appendLog?.("error", `webrtc voice signaling failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    }
  });
}

function acceptWebSocket(request: any, socket: any): void {
  const key = request.headers["sec-websocket-key"];
  if (!key) throw new Error("missing websocket key");
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
}

function sendWebSocketFrame(socket: any, text: string): void {
  const payload = nodeBuffer.from(text);
  const header = payload.length < 126
    ? nodeBuffer.from([0x81, payload.length])
    : payload.length <= 0xffff
      ? nodeBuffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : undefined;
  if (!header) throw new Error("websocket frame too large");
  socket.write(nodeBuffer.concat([header, payload]));
}

function readWebSocketTextFrames(buffer: any): { messages: string[]; rest: any } {
  const messages: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const frameStart = offset;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > buffer.length) return { messages, rest: buffer.subarray(frameStart) };
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      throw new Error("large websocket frames are not supported");
    }
    let mask: Buffer | undefined;
    if (masked) {
      if (offset + 4 > buffer.length) return { messages, rest: buffer.subarray(frameStart) };
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.length) return { messages, rest: buffer.subarray(frameStart) };
    const payload = nodeBuffer.from(buffer.subarray(offset, offset + length));
    offset += length;
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    if (opcode === 0x8) break;
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
  }
  return { messages, rest: buffer.subarray(offset) };
}
