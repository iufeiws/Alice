const crypto = await import("node:crypto");

import type { WebRtcVoiceConfig } from "./types.js";
import { defaultWebRtcVoiceConfig } from "./config.js";

export const defaultTestSpeakText = [
  "これは疑似ストリーミング音声のテストです。",
  "最初の文が再生されている間に、次の文を順番に合成します。",
  "途中で割り込みボタンを押すと、残りの文は再生されません。",
  "聞こえ方と停止の反応を確認してください。"
].join("");

export function renderWebRtcVoiceCallPage(config: WebRtcVoiceConfig = defaultWebRtcVoiceConfig()): string {
  return renderCallPage(config);
}

export function renderCallPage(config: WebRtcVoiceConfig): string {
  const signalingPath = escapeHtml(config.signalingPath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Alice WebRTC Voice</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; max-width: 760px; }
    button { margin-right: 8px; padding: 8px 12px; }
    textarea { font: inherit; }
    #status, #finalTranscript { margin-top: 16px; white-space: pre-wrap; font-family: ui-monospace, monospace; }
    #partialTranscript { min-height: 28px; margin-top: 12px; padding: 8px; border: 1px solid #bbb; }
    #finalTranscript { min-height: 64px; padding: 8px; border: 1px solid #bbb; }
    #typedInterruptInput { display: block; width: 100%; min-height: 72px; box-sizing: border-box; margin-top: 8px; padding: 8px; }
    .label { margin-top: 12px; font-size: 12px; color: #555; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <main>
    <button id="callButton" type="button">Call</button>
    <button id="talkButton" type="button" disabled>Hold to talk</button>
    <button id="testSpeakButton" type="button">Test voice</button>
    <button id="interruptButton" type="button">Interrupt voice</button>
    <button id="hangupButton" type="button">Hang up</button>
    <div class="label">Typed interrupt input</div>
    <textarea id="typedInterruptInput" rows="3" placeholder="Type more than 1 character to interrupt; press Enter to submit."></textarea>
    <textarea id="testSpeakText" rows="5" style="display:block; width:100%; box-sizing:border-box; margin:12px 0; font-family:ui-monospace, monospace;">${escapeHtml(defaultTestSpeakText)}</textarea>
    <audio id="remoteAudio" autoplay playsinline controls></audio>
    <div id="assistantOutputText" hidden data-event="tts.output_text"></div>
    <div id="userInputText" hidden data-event="audio.transcript.final"></div>
    <div class="label">Current transcript</div>
    <div id="partialTranscript"></div>
    <div class="label">Final transcripts</div>
    <div id="finalTranscript"></div>
    <div id="status"></div>
  </main>
  <script type="module">
    const signalingPath = ${JSON.stringify(signalingPath)};
    const inboundAudio = ${JSON.stringify(config.inboundAudio)};
    const remoteAudio = document.getElementById("remoteAudio");
    remoteAudio.autoplay = true;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    const status = document.getElementById("status");
    const partialTranscript = document.getElementById("partialTranscript");
    const finalTranscript = document.getElementById("finalTranscript");
    const talkButton = document.getElementById("talkButton");
    const testSpeakText = document.getElementById("testSpeakText");
    const typedInterruptInput = document.getElementById("typedInterruptInput");
    let peer;
    let socket;
    let localStream;
    let speechActive = false;
    let pcmSource;
    let pcmProcessor;
    let pendingRemoteIce = [];
    let typedInputInterruptSent = false;
    function log(line, error = false) {
      const prefix = new Date().toLocaleTimeString();
      status.textContent += "[" + prefix + "] " + line + "\\n";
      status.className = error ? "error" : "";
    }
    function updateTranscript(message) {
      if (message.type !== "status") return;
      if (message.state === "tts.playback.consumer") {
        const detail = String(message.detail || "");
        const match = detail.match(/^前文=(.*) 时长=[^ ]+$/);
        const playbackTextCache = (match ? match[1] : detail).trim();
        if (!playbackTextCache) return;
        document.getElementById("assistantOutputText").textContent = playbackTextCache;
        partialTranscript.textContent = playbackTextCache;
        return;
      }
      if (message.state !== "talk_runtime.ingress.todo") return;
      const prefix = "audio.transcript.final: ";
      const detail = String(message.detail || "");
      if (!detail.startsWith(prefix)) return;
      const text = detail.slice(prefix.length).trim();
      if (!text) return;
      const time = new Date().toLocaleTimeString();
      finalTranscript.textContent += "[" + time + "] " + text + "\\n";
    }
    document.getElementById("callButton").addEventListener("click", async () => {
      try {
        log("requesting microphone");
        void remoteAudio.play().catch(() => {
          // The real remote stream is attached after negotiation; this call unlocks autoplay in the Call gesture.
        });
        if (!window.isSecureContext) {
          log("this page is not a secure context; use HTTPS or localhost for microphone access", true);
        }
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        });
        log("microphone ready");
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack?.getSettings) {
          const settings = audioTrack.getSettings();
          log("audio processing requested: noiseSuppression=true echoCancellation=true autoGainControl=true; actual sampleRate=" + (settings.sampleRate || "unknown") + "; asr target=" + inboundAudio.encoding + "/" + inboundAudio.sampleRateHz + "Hz/" + inboundAudio.channels + "ch");
        }
        startPcmStreaming(localStream);
        peer = new RTCPeerConnection({ iceServers: ${JSON.stringify(config.iceServers)} });
        peer.addTransceiver("audio", { direction: "recvonly" });
        peer.addEventListener("connectionstatechange", () => log("peer connection: " + peer.connectionState));
        peer.addEventListener("iceconnectionstatechange", () => log("ice connection: " + peer.iceConnectionState));
        peer.addEventListener("track", (event) => {
          log("remote audio track received");
          remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
          event.track.addEventListener("mute", () => log("remote audio track muted"));
          event.track.addEventListener("unmute", () => log("remote audio track unmuted"));
          void remoteAudio.play().catch((error) => log("audio play failed: " + error.message, true));
        });
        const wsUrl = new URL(signalingPath, window.location.href);
        wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl.searchParams.set("callId", crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
        socket = new WebSocket(wsUrl);
        socket.addEventListener("open", async () => {
          log("signaling connected; creating offer");
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
        });
        socket.addEventListener("message", async (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "answer") {
            await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
            log("answer applied");
            talkButton.disabled = false;
            for (const candidate of pendingRemoteIce.splice(0)) {
              await peer.addIceCandidate(candidate).catch((error) => log("queued ice failed: " + error.message, true));
            }
          }
          if (message.type === "ice") {
            if (peer.remoteDescription) await peer.addIceCandidate(message.candidate).catch((error) => log("ice failed: " + error.message, true));
            else pendingRemoteIce.push(message.candidate);
          }
          if (message.type === "status") {
            updateTranscript(message);
            log(message.state + (message.detail ? ": " + message.detail : ""));
          }
          if (message.type === "error") log(message.error + (message.message ? ": " + message.message : ""), true);
        });
        socket.addEventListener("error", () => log("signaling websocket error", true));
        socket.addEventListener("close", () => {
          stopTalking();
          talkButton.disabled = true;
          log("signaling closed");
        });
        peer.addEventListener("icecandidate", (event) => {
          if (event.candidate) socket?.send(JSON.stringify({ type: "ice", candidate: event.candidate }));
        });
      } catch (error) {
        log(error && error.message ? error.message : String(error), true);
      }
    });
    talkButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      startTalking();
    });
    talkButton.addEventListener("pointerup", (event) => {
      event.preventDefault();
      stopTalking();
    });
    talkButton.addEventListener("pointerleave", () => stopTalking());
    talkButton.addEventListener("pointercancel", () => stopTalking());
    talkButton.addEventListener("keydown", (event) => {
      if (event.code !== "Space" && event.code !== "Enter") return;
      if (event.repeat) return;
      event.preventDefault();
      startTalking();
    });
    talkButton.addEventListener("keyup", (event) => {
      if (event.code !== "Space" && event.code !== "Enter") return;
      event.preventDefault();
      stopTalking();
    });
    document.getElementById("hangupButton").addEventListener("click", () => {
      stopTalking();
      talkButton.disabled = true;
      socket?.send(JSON.stringify({ type: "hangup", reason: "manual" }));
      peer?.close();
      for (const track of localStream?.getTracks?.() || []) track.stop();
    });
    document.getElementById("testSpeakButton").addEventListener("click", () => {
      void remoteAudio.play().catch((error) => log("audio play failed before test voice: " + error.message, true));
      log("test voice requested; socket=" + (socket ? socket.readyState : "none") + " remoteAudio paused=" + remoteAudio.paused + " muted=" + remoteAudio.muted + " readyState=" + remoteAudio.readyState);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        log("test voice not sent; signaling is not open", true);
        return;
      }
      socket.send(JSON.stringify({ type: "speak-test", text: testSpeakText.value }));
    });
    document.getElementById("interruptButton").addEventListener("click", () => {
      log("interrupt requested");
      socket?.send(JSON.stringify({ type: "interrupt" }));
    });
    function commitTypedFinalText(text) {
      const payloadText = normalizeTypedInputText(text) || "-已撤回-";
      socket?.send(JSON.stringify({ type: "text-input", text: payloadText }));
      document.getElementById("userInputText").textContent = payloadText;
      const time = new Date().toLocaleTimeString();
      finalTranscript.textContent += "[" + time + "] " + payloadText + "\\n";
      typedInterruptInput.value = "";
      typedInputInterruptSent = false;
      log("typed final committed");
    }
    function normalizeTypedInputText(text) {
      return String(text || "").replace(/[\\u0000-\\u001F\\u007F\\u200B-\\u200D\\u2060\\uFEFF\\uFFFC]/g, "").trim();
    }
    typedInterruptInput.addEventListener("input", () => {
      const text = normalizeTypedInputText(typedInterruptInput.value);
      if (text.length <= 1) {
        return;
      }
      if (!typedInputInterruptSent) {
        typedInputInterruptSent = true;
        log("typed interrupt requested");
        socket?.send(JSON.stringify({ type: "interrupt", reason: "manual" }));
      }
    });
    typedInterruptInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      commitTypedFinalText(typedInterruptInput.value);
    });
    function startTalking() {
      if (speechActive || !socket || socket.readyState !== WebSocket.OPEN) return;
      speechActive = true;
      talkButton.textContent = "Talking";
      log("talk started");
      socket.send(JSON.stringify({ type: "speech-state", active: true }));
    }
    function stopTalking() {
      if (!speechActive) return;
      speechActive = false;
      talkButton.textContent = "Hold to talk";
      log("talk stopped");
      socket?.send(JSON.stringify({ type: "speech-state", active: false }));
    }
    function startPcmStreaming(stream) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContext();
      pcmSource = audioContext.createMediaStreamSource(stream);
      pcmProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      pcmProcessor.onaudioprocess = (event) => {
        if (!speechActive || !socket || socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = downsampleToPcm16(input, audioContext.sampleRate, inboundAudio.sampleRateHz);
        if (!pcm.byteLength) return;
        let binary = "";
        const bytes = new Uint8Array(pcm.buffer);
        for (const byte of bytes) binary += String.fromCharCode(byte);
        socket.send(JSON.stringify({ type: "audio-chunk", data: btoa(binary) }));
      };
      pcmSource.connect(pcmProcessor);
      pcmProcessor.connect(audioContext.destination);
    }
    function downsampleToPcm16(input, sourceRate, targetRate) {
      const ratio = sourceRate / targetRate;
      const length = Math.floor(input.length / ratio);
      const output = new Int16Array(length);
      for (let index = 0; index < length; index += 1) {
        const sourceIndex = Math.floor(index * ratio);
        const sample = Math.max(-1, Math.min(1, input[sourceIndex] || 0));
        output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      return output;
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
