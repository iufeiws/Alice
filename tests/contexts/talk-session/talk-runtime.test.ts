import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCurrentTimeProvider,
  createTalkRuntime,
  createTalkStore,
  createTestRuntime,
  makeTempDir,
  path,
  sessionInput
} from "./talk-runtime-helpers.js";

test("talk runtime exposes streaming buffered output without ready chunk splitting, then appends finish newline", () => {
  const runtime = createTestRuntime("chunk");

  runtime.openSession(sessionInput(1780830000001));
  runtime.appendAssistantDelta({ sessionId: 1780830000001, outputId: "output-1", delta: "你好，" });
  assert.equal(runtime.claimBufferedOutputText(1780830000001)?.outputId, "output-1");

  runtime.appendAssistantDelta({ sessionId: 1780830000001, outputId: "output-1", delta: "今天要不要一起去公园散步，然后喝茶？" });
  const first = runtime.claimBufferedOutputText(1780830000001);
  assert.equal(first?.outputId, "output-1");
  assert.equal(runtime.claimBufferedOutputText(1780830000001), undefined);

  runtime.appendAssistantDelta({ sessionId: 1780830000001, outputId: "output-1", delta: "好。" });
  assert.equal(runtime.claimBufferedOutputText(1780830000001)?.outputId, "output-1");

  runtime.finishAssistantOutput({ sessionId: 1780830000001, outputId: "output-1" });
  assert.equal(runtime.claimBufferedOutputText(1780830000001)?.outputId, "output-1");
  assert.ok(runtime.store.listTranscriptEntries(1780830000001).at(-1));
});

test("talk runtime reports pending voice output chars for streaming buffers", () => {
  const runtime = createTestRuntime("pending-voice-output");

  runtime.openSession(sessionInput(1780830000002));
  runtime.appendAssistantDelta({ sessionId: 1780830000002, outputId: "output-pending", delta: "你好，今天要不要一起去公园散步，然后喝茶？" });
  assert.equal(runtime.store.pendingVoiceOutputCharCount(1780830000002), "你好，今天要不要一起去公园散步，然后喝茶？".length);

  runtime.claimBufferedOutputText(1780830000002);
  assert.equal(runtime.store.pendingVoiceOutputCharCount(1780830000002), 0);

  runtime.appendAssistantDelta({ sessionId: 1780830000002, outputId: "output-pending", delta: "好" });
  assert.equal(runtime.store.pendingVoiceOutputCharCount(1780830000002), 1);
});

test("talk runtime notifies agent state callbacks on session open and close", () => {
  const states: string[] = [];
  const store = createTalkStore(path.join(makeTempDir("talk-runtime-agent-state"), "talk.sqlite"));
  const time = createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:00:00.000Z"));
  const runtime = createTalkRuntime({
    store,
    time,
    onSessionOpened: () => states.push("calling"),
    onSessionClosed: () => states.push("waiting")
  });

  runtime.openSession(sessionInput(1780830000003));
  runtime.closeSession({ sessionId: 1780830000003 });

  assert.deepEqual(states, ["calling", "waiting"]);
});

test("talk runtime uses created LLM session id", () => {
  const runtime = createTestRuntime("llm-session-id", undefined, undefined, () => 1780830000099);

  const opened = runtime.openSession({
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    occurredAt: "2026-06-07T00:00:00.000",
    occurredAtUtc: "2026-06-06T15:00:00.000Z",
    metadata: { language: "ja", callId: "call-42" }
  });

  assert.equal(opened.sessionId, 1780830000099);
  assert.equal(runtime.store.getSession(1780830000099)?.sessionId, 1780830000099);
});

test("talk runtime rejects stale session writes", () => {
  const runtime = createTestRuntime("stale-session-id", undefined, undefined, () => 1780830000099);

  runtime.openSession({
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    occurredAt: "2026-06-07T00:00:00.000",
    occurredAtUtc: "2026-06-06T15:00:00.000Z",
    metadata: { language: "ja", callId: "call-42" }
  });

  assert.throws(() => runtime.ingestInput({
    kind: "text.final",
    sessionId: 1780830000004,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    sequence: 1,
    occurredAt: "2026-06-07T00:00:01.000",
    occurredAtUtc: "2026-06-06T15:00:01.000Z",
    payload: { kind: "text", text: "stale id" }
  }), /talk session not found: 1780830000004/);
});

test("talk runtime emits input audio parts when audio is supported", () => {
  const runtime = createTestRuntime("audio-input-message");

  runtime.openSession(sessionInput(1780830000098));
  runtime.ingestInput({
    kind: "audio.input.final",
    sessionId: 1780830000098,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    sequence: 1,
    occurredAt: "2026-06-07T00:00:01.000",
    occurredAtUtc: "2026-06-06T15:00:01.000Z",
    payload: { kind: "audio", text: "[语音]", data: "UklGRg==", format: "wav", mimeType: "audio/wav" }
  });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000098, { supportsAudio: true }).messages, [{
    role: "user",
    content: [{ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } }]
  }]);
});

test("talk runtime falls back to audio text when audio is not supported", () => {
  const runtime = createTestRuntime("audio-input-text");

  runtime.openSession(sessionInput(1780830000097));
  runtime.ingestInput({
    kind: "audio.input.final",
    sessionId: 1780830000097,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    sequence: 1,
    occurredAt: "2026-06-07T00:00:01.000",
    occurredAtUtc: "2026-06-06T15:00:01.000Z",
    payload: { kind: "audio", text: "[语音]", data: "UklGRg==", format: "wav", mimeType: "audio/wav" }
  });

  assert.equal(runtime.buildNextLoopMessagePatch(1780830000097).messages.length, 1);
});

test("talk runtime removes breakpoint and following text from main output and stores it in discard table", () => {
  const runtime = createTestRuntime("interrupt");

  runtime.openSession(sessionInput(1780830000006));
  runtime.appendAssistantDelta({
    sessionId: 1780830000006,
    outputId: "output-interrupt",
    delta: "今晚我们可以先吃饭，然后去散步。"
  });
  runtime.finishAssistantOutput({ sessionId: 1780830000006, outputId: "output-interrupt" });

  const interrupt = runtime.interruptOutput({
    sessionId: 1780830000006,
    outputId: "output-interrupt",
    reason: "barge_in",
    elapsedMs: 1000,
    totalMs: 2000
  });

  const output = runtime.store.getOutput("output-interrupt");
  assert.equal(output?.status, "interrupted");

  assert.ok(interrupt.discardId);
  assert.equal(interrupt.breakMarker, "...");

  assert.equal(output?.bufferText, "");
});

test("talk runtime uses voice breakpoint context instead of elapsed ratio", () => {
  const runtime = createTestRuntime("explicit-breakpoint");

  runtime.openSession(sessionInput(1780830000007));
  runtime.appendAssistantDelta({
    sessionId: 1780830000007,
    outputId: "output-explicit-breakpoint",
    delta: "那些宫女太监，你说撤就撤了，一个都不给朕留。"
  });
  runtime.finishAssistantOutput({ sessionId: 1780830000007, outputId: "output-explicit-breakpoint" });

  runtime.interruptOutput({
    sessionId: 1780830000007,
    outputId: "output-explicit-breakpoint",
    reason: "barge_in",
    elapsedMs: 1,
    totalMs: 100,
    breakpointContext: { beforeText: "你说撤就撤了" }
  });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000007).messages, [
    { role: "assistant", content: "那些宫女太监，你说撤就撤了..." }
  ]);
});

test("talk runtime resolves breakpoint from playback text context", () => {
  const runtime = createTestRuntime("context-breakpoint");

  runtime.openSession(sessionInput(1780830000008));
  runtime.appendAssistantDelta({
    sessionId: 1780830000008,
    outputId: "output-context-breakpoint",
    delta: "第一段重复内容。第二段重复内容。第三段结束。"
  });
  runtime.finishAssistantOutput({ sessionId: 1780830000008, outputId: "output-context-breakpoint" });

  const interrupt = runtime.interruptOutput({
    sessionId: 1780830000008,
    outputId: "output-context-breakpoint",
    reason: "barge_in",
    elapsedMs: 1,
    totalMs: 100,
    breakpointContext: {
      beforeText: "第一段重复内容。第二段重复",
      afterText: "内容。第三段结束。"
    }
  });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000008).messages, [
    { role: "assistant", content: "第一段重复内容。第二段重复..." }
  ]);
});

test("talk runtime resolves logged voice context across whitespace and ellipsis normalization", () => {
  const runtime = createTestRuntime("normalized-breakpoint");

  runtime.openSession(sessionInput(1780830000009));
  runtime.appendAssistantDelta({
    sessionId: 1780830000009,
    outputId: "output-normalized-breakpoint",
    delta: "——喂喂喂！老板！？\n\n是老板吧！？\n\n这个点打电话过来……等等现在几点了！？"
  });
  runtime.finishAssistantOutput({
    sessionId: 1780830000009,
    outputId: "output-normalized-breakpoint"
  });

  const interrupt = runtime.interruptOutput({
    sessionId: 1780830000009,
    outputId: "output-normalized-breakpoint",
    reason: "barge_in",
    elapsedMs: 7480,
    totalMs: 7480,
    breakpointContext: { beforeText: "是老板吧！？ 这个点打电话过来…" }
  });

  assert.equal(runtime.store.getOutput("output-normalized-breakpoint")?.status, "interrupted");
  assert.ok(interrupt.discardId);
  assert.equal(runtime.buildNextLoopMessagePatch(1780830000009).messages.length, 1);
});

test("talk runtime ignores whitespace differences while resolving voice context", () => {
  const runtime = createTestRuntime("whitespace-breakpoint");

  runtime.openSession(sessionInput(1780830000010));
  runtime.appendAssistantDelta({
    sessionId: 1780830000010,
    outputId: "output-whitespace-breakpoint",
    delta: "第一句。\n\n第二句继续说。第三句不该保留。"
  });
  runtime.finishAssistantOutput({
    sessionId: 1780830000010,
    outputId: "output-whitespace-breakpoint"
  });

  runtime.interruptOutput({
    sessionId: 1780830000010,
    outputId: "output-whitespace-breakpoint",
    reason: "barge_in",
    elapsedMs: 1,
    totalMs: 1,
    breakpointContext: { beforeText: "第一句。第二句继续说。" }
  });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000010).messages, [
    { role: "assistant", content: "第一句。\n\n第二句继续说。..." }
  ]);
});

test("talk runtime resolves breakpoint context across omitted parenthesized text", () => {
  const runtime = createTestRuntime("context-parenthesized-breakpoint");

  runtime.openSession(sessionInput(1780830000011));
  runtime.appendAssistantDelta({
    sessionId: 1780830000011,
    outputId: "output-context-parenthesized-breakpoint",
    delta: "你好（动作省略）世界。"
  });
  runtime.finishAssistantOutput({
    sessionId: 1780830000011,
    outputId: "output-context-parenthesized-breakpoint"
  });

  runtime.interruptOutput({
    sessionId: 1780830000011,
    outputId: "output-context-parenthesized-breakpoint",
    reason: "barge_in",
    breakpointContext: { beforeText: "你好", afterText: "世界。" }
  });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000011).messages, [
    { role: "assistant", content: "你好..." }
  ]);
});

test("talk runtime builds next loop messages with default break marker, not literal bracket marker", () => {
  const runtime = createTestRuntime("messages");

  runtime.openSession(sessionInput(1780830000012));
  runtime.appendAssistantDelta({
    sessionId: 1780830000012,
    outputId: "output-messages",
    delta: "我刚才说到这里会继续说明。"
  });
  runtime.finishAssistantOutput({ sessionId: 1780830000012, outputId: "output-messages" });
  runtime.interruptOutput({
    sessionId: 1780830000012,
    outputId: "output-messages",
    reason: "barge_in",
    breakpointContext: { beforeText: "我刚才说到" },
    elapsedMs: 900,
    totalMs: 1800
  });
  runtime.ingestInput({
    kind: "audio.transcript.final",
    sessionId: 1780830000012,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 2,
    occurredAt: "2026-06-07T00:00:02.000",
    occurredAtUtc: "2026-06-06T15:00:02.000Z",
    payload: { kind: "transcript", text: "我想先问一个问题" }
  });

  const messages = runtime.buildNextLoopMessagePatch(1780830000012).messages;
  assert.deepEqual(messages.slice(-2), [
    { role: "assistant", content: "我刚才说到..." },
    { role: "user", content: "我想先问一个问题" }
  ]);
  assert.doesNotMatch(messages.map((message) => message.content).join("\n"), /\[断点\]/);
});

test("talk runtime appends temporary no-speech user message only after assistant output", () => {
  const runtime = createTestRuntime("no-speech-placeholder");

  runtime.openSession(sessionInput(1780830000013));
  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000013).messages, []);

  runtime.appendAssistantDelta({
    sessionId: 1780830000013,
    outputId: "output-no-speech",
    delta: "我说完了。"
  });
  runtime.finishAssistantOutput({ sessionId: 1780830000013, outputId: "output-no-speech" });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000013).messages, [
    { role: "assistant", content: "我说完了。" },
    { role: "user", content: " (没有说话)" }
  ]);
  assert.equal(runtime.store.listSegments(1780830000013).some((segment) => segment.contentText === " (没有说话)"), false);

  runtime.ingestInput({
    kind: "text.final",
    sessionId: 1780830000013,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 2,
    occurredAt: "2026-06-07T00:00:02.000",
    occurredAtUtc: "2026-06-06T15:00:02.000Z",
    payload: { kind: "text", text: "真实输入" }
  });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000013).messages, [
    { role: "assistant", content: "我说完了。" },
    { role: "user", content: "真实输入" }
  ]);
});

test("talk runtime suppresses no-speech user message while waiting for interrupt input", () => {
  const runtime = createTestRuntime("no-speech-interrupt-wait");

  runtime.openSession(sessionInput(1780830000014));
  runtime.appendAssistantDelta({
    sessionId: 1780830000014,
    outputId: "output-no-speech-interrupt-wait",
    delta: "正在等你。"
  });
  runtime.finishAssistantOutput({
    sessionId: 1780830000014,
    outputId: "output-no-speech-interrupt-wait"
  });
  runtime.interruptAgentLoop(1780830000014, { reason: "barge_in", interruptEpoch: 1 });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000014).messages, [
    { role: "assistant", content: "正在等你。" }
  ]);
});

test("talk runtime starts the next agent loop when foreground playback becomes idle", () => {
  const loops: number[] = [];
  let current = new Date("2026-06-06T15:00:00.000Z");
  const runtime = createTestRuntime("idle-loop", (sessionId) => {
    loops.push(sessionId);
  }, undefined, undefined, () => current);

  runtime.openSession(sessionInput(1780830000015));
  runtime.appendAssistantDelta({ sessionId: 1780830000015, outputId: "output-idle", delta: "第一句已经准备好。" });

  const streamingChunk = runtime.claimBufferedOutputText(1780830000015);
  assert.ok(streamingChunk);

  runtime.finishAssistantOutput({ sessionId: 1780830000015, outputId: "output-idle" });

  const chunk = runtime.claimBufferedOutputText(1780830000015);
  assert.ok(chunk);
  assert.equal(runtime.claimReadyAgentLoopSession(), undefined);
  runtime.markForegroundPlaybackIdle({ sessionId: 1780830000015 });
  assert.equal(runtime.claimReadyAgentLoopSession(), 1780830000015);
  runtime.prepareReadyAgentLoopSession(1780830000015);
  assert.deepEqual(loops, [1780830000015]);

  runtime.markForegroundPlaybackIdle({ sessionId: 1780830000015 });
  assert.deepEqual(loops, [1780830000015]);
  assert.equal(runtime.claimReadyAgentLoopSession(), 1780830000015);
  runtime.prepareReadyAgentLoopSession(1780830000015);
  assert.deepEqual(loops, [1780830000015, 1780830000015]);
});

test("talk runtime drops stale ready while foreground playback is still pending", () => {
  const loops: number[] = [];
  let current = new Date("2026-06-06T15:00:00.000Z");
  const runtime = createTestRuntime("stale-ready", (sessionId) => {
    loops.push(sessionId);
  }, undefined, undefined, () => current);

  runtime.openSession(sessionInput(1780830000016));
  runtime.markAgentLoopReady(1780830000016);
  runtime.appendAssistantDelta({ sessionId: 1780830000016, outputId: "output-stale-ready", delta: "第一句。" });
  assert.ok(runtime.claimBufferedOutputText(1780830000016));
  runtime.finishAssistantOutput({ sessionId: 1780830000016, outputId: "output-stale-ready" });
  assert.ok(runtime.claimBufferedOutputText(1780830000016));

  assert.equal(runtime.claimReadyAgentLoopSession(), undefined);
  current = new Date(current.getTime() + 60_000);
  assert.equal(runtime.claimReadyAgentLoopSession(), undefined);

  runtime.markForegroundPlaybackIdle({ sessionId: 1780830000016 });
  assert.equal(runtime.claimReadyAgentLoopSession(), 1780830000016);
  runtime.prepareReadyAgentLoopSession(1780830000016);
  assert.deepEqual(loops, [1780830000016]);
});
