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
