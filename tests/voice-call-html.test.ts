import assert from "node:assert/strict";
import test from "node:test";

import { renderVoiceCallHtml } from "../src/apps/api/routes/voice-call-html.js";

test("voice-call page waits for first backend audio-ready event before entering call UI", () => {
  const html = renderVoiceCallHtml();

  assert.match(html, /\[data-phase="connected"\] \.dial-screen/);
  assert.doesNotMatch(html, /\[data-phase\]:not\(\[data-phase="idle"\]\) \.dial-screen/);
  assert.match(html, /state === "webrtc\.connection" && detail === "connected"\) setPreConnectedPhase\("connecting"/);
  assert.doesNotMatch(html, /state === "webrtc\.connection" && detail === "connected"\) markConnected\(\)/);
  assert.match(html, /state === "voice_call\.connected"\) markConnected\(\)/);
  assert.match(html, /state === "tts\.queue\.ready"\) setPreConnectedPhase\("connecting"/);
  assert.match(html, /function setPreConnectedPhase\(nextPhase, detail\)/);
  assert.match(html, /if \(phase === "connected" \|\| phase === "reconnecting" \|\| phase === "ended" \|\| phase === "error"\) return;/);
  assert.ok(html.indexOf("await openSignaling") < html.indexOf("await unlockAudio"));
});

test("voice-call text input matches webrtc voice call typed interrupt behavior", () => {
  const html = renderVoiceCallHtml();

  assert.match(html, /if \(event\.key !== "Enter" \|\| event\.isComposing\) return;/);
  assert.doesNotMatch(html, /event\.shiftKey/);
  assert.match(html, /const payloadText = normalizeTypedInputText\(messageInput\.value\) \|\| "-已撤回-";/);
  assert.match(html, /sendSignal\(\{ type: "text-input", text: payloadText \}\);/);
  assert.match(html, /function normalizeTypedInputText\(text\)/);
  assert.match(html, /if \(text\.length <= 1\) \{/);
  assert.doesNotMatch(html, /if \(text\.length <= 3\)/);
});

test("voice-call displays Alice text from playback consumer cache", () => {
  const html = renderVoiceCallHtml();

  assert.match(html, /state === "voice_call\.playback_text_cache" && detail\) aliceTranscript\.textContent = detail;/);
  assert.doesNotMatch(html, /state === "tts\.playback\.consumer" && detail\) aliceTranscript\.textContent = detail;/);
  assert.doesNotMatch(html, /state === "tts\.playing_text" && detail\) aliceTranscript\.textContent = detail;/);
});

test("voice-call hold-to-talk streams microphone PCM chunks to signaling", () => {
  const html = renderVoiceCallHtml();

  assert.match(html, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(html, /const inboundAudio = \{"sampleRateHz":16000,"channels":1,"encoding":"pcm_s16le","chunkMs":100\};/);
  assert.match(html, /await startPcmStreaming\(localStream\);/);
  assert.match(html, /async function startPcmStreaming\(stream\)/);
  assert.match(html, /audioContext\.audioWorklet\.addModule\(pcmWorkletUrl\)/);
  assert.match(html, /new AudioWorkletNode\(audioContext, "alice-pcm16-capture"/);
  assert.match(html, /registerProcessor\("alice-pcm16-capture", AlicePcm16Capture\);/);
  assert.match(html, /sendSignal\(\{ type: "audio-chunk", data: btoa\(binary\), timing \}\);/);
  assert.doesNotMatch(html, /createScriptProcessor/);
  assert.match(html, /#holdTalkButton, #holdTalkButton \*/);
  assert.match(html, /-webkit-touch-callout: none;/);
  assert.match(html, /-webkit-user-select: none;/);
  assert.match(html, /user-select: none;/);
  assert.match(html, /touch-action: none;/);
  assert.match(html, /holdTalkButton\.addEventListener\("contextmenu", \(event\) => event\.preventDefault\(\)\);/);
  assert.match(html, /sendSignal\(\{ type: "hold-to-talk", active: true \}\);/);
  assert.match(html, /sendSignal\(\{ type: "hold-to-talk", active: false \}\);/);
  assert.match(html, /stopPcmStreaming\(\);/);
});
