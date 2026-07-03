import assert from "node:assert/strict";
import test from "node:test";

import { renderVoiceCallHtml } from "../../../../../src/apps/api/routes/voice-call-html.js";

function assertContains(html: string, values: string[]): void {
  for (const value of values) {
    assert.ok(html.includes(value), `expected voice-call HTML to include ${value}`);
  }
}

test("voice-call page renders the public call UI contract", () => {
  const html = renderVoiceCallHtml();

  assertContains(html, [
    '<html lang="zh-CN">',
    "<title>Alice Voice Call</title>",
    '<main class="voice-call-app" data-phase="idle">',
    'aria-label="拨打 Alice"',
    'aria-label="通话控制"',
    'aria-label="实时对话"',
    'aria-label="语音活动"',
    "准备通话",
    "点击拨打后开始",
    "Alice 的实时回复会显示在这里",
    "你的实时输入会显示在这里",
    'placeholder="输入文字"',
    '<audio id="remoteAudio" autoplay playsinline></audio>'
  ]);
});

test("voice-call page keeps the signaling protocol contract", () => {
  const html = renderVoiceCallHtml();

  assertContains(html, [
    'searchParams.set("callId", currentCallId)',
    'type: "hello"',
    'type: "offer"',
    'type: "ice"',
    'type: "hangup"',
    'type: "hold"',
    'type: "wait"',
    'type: "input-mode"',
    'type: "ping"',
    'message.type === "pong"',
    "message.callId && message.callId !== currentCallId"
  ]);
});

test("voice-call page enters connected UI only from backend call-ready status", () => {
  const html = renderVoiceCallHtml();

  assertContains(html, [
    'connected: ["通话中", "00:00"]',
    'state === "webrtc.connection"',
    "链路已建立，等待首段音频",
    'state === "tts.queue.ready"',
    "首段音频准备完毕",
    'state === "voice_call.connected"'
  ]);
  assert.doesNotMatch(html, /state === "webrtc\.connection"[\s\S]{0,120}setPhase\("connected"/);
  assert.doesNotMatch(html, /state === "webrtc\.connection"[\s\S]{0,120}markConnected\(\)/);
});

test("voice-call text input keeps typed interrupt behavior", () => {
  const html = renderVoiceCallHtml();

  assertContains(html, [
    'event.key !== "Enter" || event.isComposing',
    'type: "text-draft"',
    'type: "text-input"',
    'type: "interrupt", reason: "manual"',
    '"-已撤回-"'
  ]);
  assert.doesNotMatch(html, /event\.shiftKey/);
});

test("voice-call page keeps transcript and playback acknowledgement protocol", () => {
  const html = renderVoiceCallHtml();

  assertContains(html, [
    'state === "voice_call.playback_text_cache"',
    'state === "voice_call.playback_idle_ack.request"',
    'type: "playback-idle-ack"',
    'state === "asr.partial"',
    'state === "talk_runtime.ingress"',
    'state === "talk_runtime.ingress.todo"',
    "audio.transcript.final:"
  ]);
  assert.doesNotMatch(html, /state === "tts\.playback\.consumer"/);
  assert.doesNotMatch(html, /state === "tts\.playing_text"/);
});

test("voice-call hold-to-talk sends microphone audio through signaling", () => {
  const html = renderVoiceCallHtml();

  assertContains(html, [
    "navigator.mediaDevices.getUserMedia",
    '"sampleRateHz":16000',
    '"channels":1',
    '"encoding":"pcm_s16le"',
    '"chunkMs":100',
    'type: "hold-to-talk", active: true',
    'type: "hold-to-talk", active: false',
    'type: "audio-chunk"'
  ]);
});

test("voice-call page shows TTS hangup as a terminal error", () => {
  const html = renderVoiceCallHtml();

  assertContains(html, [
    'state === "voice_call.hangup"',
    'detail === "tts_failed"',
    "语音生成失败",
    "TTS 服务异常，通话已结束。"
  ]);
});
