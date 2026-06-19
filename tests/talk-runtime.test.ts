import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkRuntime } from "../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createTalkStore } from "../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { createAliceStore } from "../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { projectClosedTalkSessionToConversationHub } from "../src/contexts/talk-session/src/runtime/talk-session-runtime.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("talk runtime exposes streaming buffered output without ready chunk splitting, then appends finish newline", () => {
  const runtime = createTestRuntime("chunk");

  runtime.openSession(sessionInput(1780830000001));
  runtime.appendAssistantDelta({ sessionId: 1780830000001, outputId: "output-1", delta: "你好，" });
  assert.equal(runtime.claimBufferedOutputText(1780830000001)?.text, "你好，");

  runtime.appendAssistantDelta({ sessionId: 1780830000001, outputId: "output-1", delta: "今天要不要一起去公园散步，然后喝茶？" });
  const first = runtime.claimBufferedOutputText(1780830000001);
  assert.equal(first?.text, "今天要不要一起去公园散步，然后喝茶？");
  assert.equal(first?.outputId, "output-1");
  assert.equal(runtime.claimBufferedOutputText(1780830000001), undefined);

  runtime.appendAssistantDelta({ sessionId: 1780830000001, outputId: "output-1", delta: "好。" });
  assert.equal(runtime.claimBufferedOutputText(1780830000001)?.text, "好。");

  runtime.finishAssistantOutput({ sessionId: 1780830000001, outputId: "output-1" });
  assert.equal(runtime.claimBufferedOutputText(1780830000001)?.text, "\n");
  assert.equal(runtime.store.listTranscriptEntries(1780830000001).at(-1)?.contentText, "你好，今天要不要一起去公园散步，然后喝茶？好。");
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

test("talk runtime uses created LLM session id and rejects stale session writes", () => {
  const runtime = createTestRuntime("llm-session-id", undefined, undefined, () => 1780830000099);

  const opened = runtime.openSession({
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    occurredAt: "2026-06-07T00:00:00.000",
    occurredAtUtc: "2026-06-06T15:00:00.000Z",
    metadata: { language: "ja", callId: "call-42" }
  });

  assert.equal(opened.sessionId, 1780830000099);
  assert.equal(runtime.store.getSession(1780830000099)?.sessionId, 1780830000099);
  assert.throws(() => runtime.ingestInput({
    kind: "text.final",
    sessionId: 1780830000004,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    sequence: 1,
    occurredAt: "2026-06-07T00:00:01.000",
    occurredAtUtc: "2026-06-06T15:00:01.000Z",
    payload: { kind: "text", text: "stale id" }
  }), /talk session not found: 1780830000004/);

  runtime.ingestInput({
    kind: "text.final",
    sessionId: opened.sessionId,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    sequence: 1,
    occurredAt: "2026-06-07T00:00:01.000",
    occurredAtUtc: "2026-06-06T15:00:01.000Z",
    payload: { kind: "text", text: "fresh id" }
  });
  assert.deepEqual(runtime.buildNextLoopMessagePatch(opened.sessionId).messages, [{ role: "user", content: "fresh id" }]);
});

test("talk runtime keeps parenthesized output in storage but out of TTS chunks across deltas", () => {
  const runtime = createTestRuntime("parenthesized");

  runtime.openSession(sessionInput(1780830000005));
  runtime.appendAssistantDelta({ sessionId: 1780830000005, outputId: "output-parenthesized", delta: "（指先で" });
  runtime.appendAssistantDelta({ sessionId: 1780830000005, outputId: "output-parenthesized", delta: "そっとページの端をなぞるように）\n逆賊の愛卿、" });
  assert.equal(runtime.claimBufferedOutputText(1780830000005)?.text, "\n逆賊の愛卿、");

  runtime.appendAssistantDelta({ sessionId: 1780830000005, outputId: "output-parenthesized", delta: "何か奏上することがあるのか？" });
  const chunk = runtime.claimBufferedOutputText(1780830000005);
  assert.equal(chunk?.text, "何か奏上することがあるのか？");

  const output = runtime.store.getOutput("output-parenthesized");
  assert.equal(output?.fullText, "（指先でそっとページの端をなぞるように）\n逆賊の愛卿、何か奏上することがあるのか？");
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
  assert.equal(output?.fullText, "今晚我们可以先吃");
  assert.equal(output?.visibleText, "今晚我们可以先吃");

  assert.ok(interrupt.discardId);
  const discard = runtime.store.getDiscard(interrupt.discardId);
  assert.equal(discard?.discardedText, "饭，然后去散步。");
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

  assert.equal(runtime.store.getOutput("output-normalized-breakpoint")?.fullText, "——喂喂喂！老板！？\n\n是老板吧！？\n\n这个点打电话过来…");
  assert.equal(runtime.store.getDiscard(interrupt.discardId!)?.discardedText, "…等等现在几点了！？");
  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000009).messages, [
    { role: "assistant", content: "——喂喂喂！老板！？\n\n是老板吧！？\n\n这个点打电话过来…" + "..." }
  ]);
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

test("talk runtime blocks output claim and next loop while waiting for final transcript after interrupt", () => {
  const loops: number[] = [];
  let current = new Date("2026-06-06T15:00:00.000Z");
  const runtime = createTestRuntime("interrupt-gate", (sessionId) => {
    loops.push(sessionId);
  }, undefined, undefined, () => current);

  runtime.openSession(sessionInput(1780830000017));
  runtime.appendAssistantDelta({
    sessionId: 1780830000017,
    outputId: "output-interrupt-gate",
    delta: "那些宫女太监，你说撤就撤了，一个都不给朕留。"
  });
  runtime.finishAssistantOutput({ sessionId: 1780830000017, outputId: "output-interrupt-gate" });
  const chunk = runtime.claimBufferedOutputText(1780830000017);
  assert.ok(chunk);

  runtime.interruptOutput({
    sessionId: 1780830000017,
    outputId: "output-interrupt-gate",
    reason: "barge_in",
    breakpointContext: { beforeText: "那些宫女太监，你说撤就撤了" }
  });

  assert.equal(runtime.claimBufferedOutputText(1780830000017), undefined);
  runtime.markAgentLoopReady(1780830000017);
  assert.deepEqual(loops, []);

  runtime.ingestInput({
    kind: "audio.transcript.final",
    sessionId: 1780830000017,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 2,
    occurredAt: "2026-06-07T00:00:02.000",
    occurredAtUtc: "2026-06-06T15:00:02.000Z",
    payload: { kind: "transcript", text: "Hello,爱丽丝, hello hello hello." }
  });

  assert.deepEqual(loops, []);
  assert.equal(runtime.claimReadyAgentLoopSession(), 1780830000017);
  runtime.prepareReadyAgentLoopSession(1780830000017);
  assert.deepEqual(loops, [1780830000017]);
  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000017).messages.slice(-2), [
    { role: "assistant", content: "那些宫女太监，你说撤就撤了..." },
    { role: "user", content: "Hello,爱丽丝, hello hello hello." }
  ]);
});

test("talk runtime commits stable input batch in interrupt order", () => {
  const loops: number[] = [];
  let current = new Date("2026-06-06T15:00:00.000Z");
  const runtime = createTestRuntime("stable-batch", (sessionId) => {
    loops.push(sessionId);
  }, undefined, undefined, () => current);

  runtime.openSession(sessionInput(1780830000018));
  runtime.appendAssistantDelta({ sessionId: 1780830000018, outputId: "output-a", delta: "第一段被打断。" });
  runtime.finishAssistantOutput({ sessionId: 1780830000018, outputId: "output-a" });
  const first = runtime.interruptOutput({
    sessionId: 1780830000018,
    outputId: "output-a",
    reason: "barge_in",
    breakpointContext: { beforeText: "第一段" }
  });
  runtime.appendAssistantDelta({ sessionId: 1780830000018, outputId: "output-b", delta: "第二段也被打断。" });
  const second = runtime.interruptOutput({
    sessionId: 1780830000018,
    outputId: "output-b",
    reason: "manual",
    breakpointContext: { beforeText: "第二" },
    omitAssistantMessage: true
  });

  runtime.commitStableInputBatch({
    sessionId: 1780830000018,
    batchId: "batch-1",
    interruptEpoch: 2,
    inputs: [
      {
        interruptId: second.interruptId,
        sequence: 3,
        reason: "manual",
        text: "第二次输入",
        occurredAt: "2026-06-07T00:00:03.000",
        occurredAtUtc: "2026-06-06T15:00:03.000Z",
        targetOutputId: "output-b"
      },
      {
        interruptId: first.interruptId,
        sequence: 2,
        reason: "barge_in",
        text: "第一次输入",
        occurredAt: "2026-06-07T00:00:02.000",
        occurredAtUtc: "2026-06-06T15:00:02.000Z",
        targetOutputId: "output-a"
      }
    ]
  });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000018).messages.slice(-3), [
    { role: "assistant", content: "第一段..." },
    { role: "user", content: "第一次输入" },
    { role: "user", content: "第二次输入" }
  ]);
  assert.equal(runtime.store.latestUnresolvedInterrupt(1780830000018), undefined);
  assert.deepEqual(loops, []);
  assert.equal(runtime.claimReadyAgentLoopSession(), 1780830000018);
  runtime.prepareReadyAgentLoopSession(1780830000018);
  assert.deepEqual(loops, [1780830000018]);
});

test("talk runtime keeps agent loop blocked when a stale stable batch commits after a newer interrupt", () => {
  const loops: number[] = [];
  const runtime = createTestRuntime("stale-stable-after-interrupt", (sessionId) => {
    loops.push(sessionId);
  });

  runtime.openSession(sessionInput(1780830000019));
  runtime.interruptAgentLoop(1780830000019, { reason: "barge_in", interruptEpoch: 2 });

  runtime.commitStableInputBatch({
    sessionId: 1780830000019,
    batchId: "batch-old",
    interruptEpoch: 1,
    inputs: [{
      interruptId: "interrupt-old",
      sequence: 1,
      reason: "barge_in",
      text: "上一轮已经结束的输入",
      occurredAt: "2026-06-07T00:00:01.000",
      occurredAtUtc: "2026-06-06T15:00:01.000Z"
    }]
  });

  assert.equal(runtime.claimReadyAgentLoopSession(), undefined);
  runtime.prepareReadyAgentLoopSession(1780830000019);
  assert.deepEqual(loops, []);

  runtime.commitStableInputBatch({
    sessionId: 1780830000019,
    batchId: "batch-new",
    interruptEpoch: 2,
    inputs: [{
      interruptId: "interrupt-new",
      sequence: 2,
      reason: "barge_in",
      text: "新的打断输入",
      occurredAt: "2026-06-07T00:00:02.000",
      occurredAtUtc: "2026-06-06T15:00:02.000Z"
    }]
  });

  assert.equal(runtime.claimReadyAgentLoopSession(), 1780830000019);
  runtime.prepareReadyAgentLoopSession(1780830000019);
  assert.deepEqual(loops, [1780830000019]);
});

test("talk runtime notifies agent loop interrupt when assistant output is interrupted", () => {
  const interrupted: string[] = [];
  const runtime = createTestRuntime("interrupt-agent", undefined, (sessionId, outputId) => {
    interrupted.push(`${sessionId}:${outputId}`);
  });

  runtime.openSession(sessionInput(1780830000020));
  runtime.appendAssistantDelta({ sessionId: 1780830000020, outputId: "output-interrupt-agent", delta: "正在说话。" });
  runtime.interruptOutput({
    sessionId: 1780830000020,
    outputId: "output-interrupt-agent",
    reason: "barge_in",
    breakpointContext: { beforeText: "正在" }
  });

  assert.deepEqual(interrupted, ["1780830000020:output-interrupt-agent"]);
});

test("talk runtime can interrupt the latest streaming output when voice has no chunk target yet", () => {
  const interrupted: string[] = [];
  const runtime = createTestRuntime("interrupt-latest", undefined, (sessionId, outputId) => {
    interrupted.push(`${sessionId}:${outputId}`);
  });

  runtime.openSession(sessionInput(1780830000021));
  runtime.appendAssistantDelta({ sessionId: 1780830000021, outputId: "output-latest", delta: "正在生成但还没有进入播放。" });

  const interrupt = runtime.interruptLatestOutput({
    sessionId: 1780830000021,
    reason: "manual",
    breakpointContext: { beforeText: "正在生成" }
  });

  assert.equal(interrupt?.outputId, "output-latest");
  assert.deepEqual(interrupted, ["1780830000021:output-latest"]);
  assert.equal(runtime.store.getOutput("output-latest")?.fullText, "正在生成");
  assert.equal(runtime.claimBufferedOutputText(1780830000021), undefined);
});

test("talk runtime cancels later assistant outputs when an earlier playback output is interrupted", () => {
  const runtime = createTestRuntime("interrupt-cancels-later");

  runtime.openSession(sessionInput(1780830000022));
  runtime.appendAssistantDelta({ sessionId: 1780830000022, outputId: "output-playback", delta: "第一段正在播放。后面应该截断。" });
  runtime.finishAssistantOutput({ sessionId: 1780830000022, outputId: "output-playback" });
  runtime.appendAssistantDelta({ sessionId: 1780830000022, outputId: "output-later", delta: "第二段已经生成但不该进入上下文。" });
  runtime.finishAssistantOutput({ sessionId: 1780830000022, outputId: "output-later" });

  runtime.interruptOutput({
    sessionId: 1780830000022,
    outputId: "output-playback",
    reason: "barge_in",
    breakpointContext: { beforeText: "第一段正在播放" }
  });

  assert.equal(runtime.store.getOutput("output-later")?.status, "cancelled");
  assert.equal(runtime.store.listChunks("output-later").every((chunk) => chunk.status === "cancelled"), true);
  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000022).messages, [
    { role: "assistant", content: "第一段正在播放..." }
  ]);
  assert.deepEqual(runtime.store.listTranscriptEntries(1780830000022).map((entry) => `${entry.role}:${entry.contentText}`), [
    "system:开始",
    "assistant:第一段正在播放...",
  ]);
});

test("talk runtime timestamps assistant transcript rows by output creation time", () => {
  const store = createTalkStore(path.join(makeTempDir("talk-runtime-transcript-output-start"), "talk.sqlite"));
  let now = new Date("2026-06-06T15:00:00.000Z");
  const runtime = createTalkRuntime({
    store,
    time: createCurrentTimeProvider("Asia/Tokyo", () => now)
  });

  runtime.openSession(sessionInput(1780830000023));
  now = new Date("2026-06-06T15:00:01.000Z");
  runtime.appendAssistantDelta({
    sessionId: 1780830000023,
    outputId: "output-early",
    delta: "第一段正在播放。后面不该保留。"
  });
  now = new Date("2026-06-06T15:00:02.000Z");
  runtime.appendAssistantDelta({
    sessionId: 1780830000023,
    outputId: "output-later",
    delta: "第二段已经生成但应该取消。"
  });
  runtime.finishAssistantOutput({ sessionId: 1780830000023, outputId: "output-later" });
  now = new Date("2026-06-06T15:00:10.000Z");
  runtime.interruptOutput({
    sessionId: 1780830000023,
    outputId: "output-early",
    reason: "barge_in",
    breakpointContext: { beforeText: "第一段" }
  });

  assert.deepEqual(runtime.store.listTranscriptEntries(1780830000023).map((entry) => ({
    role: entry.role,
    contentText: entry.contentText,
    occurredAt: entry.occurredAt
  })), [
    { role: "system", contentText: "开始", occurredAt: "2026-06-07T00:00:00.000" },
    { role: "assistant", contentText: "第一段...", occurredAt: "2026-06-07T00:00:01.000" }
  ]);
});

test("talk runtime omits the queued next assistant output when interrupt happens between playback segments", () => {
  const runtime = createTestRuntime("interrupt-between-segments");

  runtime.openSession(sessionInput(1780830000024));
  runtime.appendAssistantDelta({ sessionId: 1780830000024, outputId: "output-16", delta: "第一段已经完整播放。" });
  runtime.finishAssistantOutput({ sessionId: 1780830000024, outputId: "output-16" });
  runtime.appendAssistantDelta({ sessionId: 1780830000024, outputId: "output-17", delta: "第二段已经生成但还没有开始播放。" });
  runtime.finishAssistantOutput({ sessionId: 1780830000024, outputId: "output-17" });

  const interrupt = runtime.interruptOutput({
    sessionId: 1780830000024,
    outputId: "output-17",
    reason: "barge_in",
    breakpointContext: { beforeText: "完整播放。", afterText: "第二段已经" },
    omitAssistantMessage: true
  });

  assert.equal(runtime.store.getOutput("output-17")?.status, "cancelled");
  assert.equal(runtime.store.getOutput("output-17")?.fullText, "");
  assert.ok(interrupt.discardId);
  assert.equal(runtime.store.getDiscard(interrupt.discardId)?.discardedText, "第二段已经生成但还没有开始播放。");
  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000024).messages, [
    { role: "assistant", content: "第一段已经完整播放。" }
  ]);

  runtime.ingestInput({
    kind: "audio.transcript.final",
    sessionId: 1780830000024,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 2,
    occurredAt: "2026-06-07T00:00:02.000",
    occurredAtUtc: "2026-06-06T15:00:02.000Z",
    payload: { kind: "transcript", text: "只有一半吗？只有" }
  });

  assert.deepEqual(runtime.buildNextLoopMessagePatch(1780830000024).messages.slice(-2), [
    { role: "assistant", content: "第一段已经完整播放。" },
    { role: "user", content: "只有一半吗？只有" }
  ]);
});

test("closed talk session is projected to conversation hub as voicecalltranscript", () => {
  const dir = makeTempDir("talk-runtime-conversation-projection");
  const talkStore = createTalkStore(path.join(dir, "talk.sqlite"));
  const conversationStore = createAliceStore(path.join(dir, "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:00:00.000Z"))
  });
  let now = new Date("2026-06-06T15:00:00.000Z");
  const time = createCurrentTimeProvider("Asia/Tokyo", () => now);
  const runtime = createTalkRuntime({ store: talkStore, time });

  runtime.openSession(sessionInput(1780830000025));
  runtime.ingestInput({
    kind: "audio.transcript.final",
    sessionId: 1780830000025,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 1,
    occurredAt: "2026-06-07T00:00:02.000",
    occurredAtUtc: "2026-06-06T15:00:02.000Z",
    payload: { kind: "transcript", text: "喂，爱丽丝，能听到吗？\n\n我刚到车站，想确认一下今晚的安排。" }
  });
  now = new Date("2026-06-06T15:00:06.000Z");
  runtime.appendAssistantDelta({ sessionId: 1780830000025, outputId: "output-projection-1", delta: "听得到。\n\n今晚先去吃饭，然后回去把明天要用的东西收好。" });
  runtime.finishAssistantOutput({ sessionId: 1780830000025, outputId: "output-projection-1" });
  conversationStore.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_call_chat_1",
    conversationId: "feishu-session-1",
    senderId: "user-1",
    senderRole: "user",
    contentType: "text",
    contentText: "我刚才也发了一条飞书确认。",
    createdAt: "2026-06-07T00:00:08.000",
    createdAtUtc: "2026-06-06T15:00:08.000Z",
    coreProcessedAt: "2026-06-07T00:00:08.000"
  });
  runtime.ingestInput({
    kind: "audio.transcript.final",
    sessionId: 1780830000025,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 2,
    occurredAt: "2026-06-07T00:00:12.000",
    occurredAtUtc: "2026-06-06T15:00:12.000Z",
    payload: { kind: "transcript", text: "好，那我二十分钟后到。你帮我记一下别忘了买水。" }
  });
  now = new Date("2026-06-06T15:00:16.000Z");
  runtime.appendAssistantDelta({ sessionId: 1780830000025, outputId: "output-projection-2", delta: "记下了，路上慢点，到附近再给我发一条消息。" });
  runtime.finishAssistantOutput({ sessionId: 1780830000025, outputId: "output-projection-2" });
  const outboundChat = conversationStore.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "feishu-session-1",
    senderRole: "assistant",
    contentType: "text",
    contentText: "我在飞书里也提醒你买水了。",
    createdAt: "2026-06-07T00:00:18.000",
    createdAtUtc: "2026-06-06T15:00:18.000Z"
  });
  conversationStore.markOutboundMessageSent(outboundChat.id, "om_call_chat_2", "2026-06-06T15:00:18.000Z");
  now = new Date("2026-06-06T15:00:20.000Z");
  runtime.closeSession({
    sessionId: 1780830000025,
    occurredAt: "2026-06-07T00:00:20.000",
    occurredAtUtc: "2026-06-06T15:00:20.000Z"
  });

  projectClosedTalkSessionToConversationHub(1780830000025, talkStore, conversationStore, time);
  projectClosedTalkSessionToConversationHub(1780830000025, talkStore, conversationStore, time);

  const messages = conversationStore.listMessages(20);
  const transcriptMessages = messages.filter((message) => message.contentType === "voicecalltranscript");
  assert.equal(transcriptMessages.length, 6);
  assert.equal(messages.length, 8);
  assert.deepEqual(transcriptMessages.map((message) => message.contentText), [
    "开始",
    "喂，爱丽丝，能听到吗？\n\n我刚到车站，想确认一下今晚的安排。",
    "听得到。\n\n今晚先去吃饭，然后回去把明天要用的东西收好。",
    "好，那我二十分钟后到。你帮我记一下别忘了买水。",
    "记下了，路上慢点，到附近再给我发一条消息。",
    "结束"
  ]);
  assert.deepEqual(transcriptMessages.map((message) => message.externalMessageId), [
    "voicecalltranscript:1780830000025:system:start",
    "voicecalltranscript:1780830000025:user:audio.transcript.final:2",
    "voicecalltranscript:1780830000025:assistant:output-projection-1",
    "voicecalltranscript:1780830000025:user:audio.transcript.final:3",
    "voicecalltranscript:1780830000025:assistant:output-projection-2",
    "voicecalltranscript:1780830000025:system:end"
  ]);
  assert.deepEqual(transcriptMessages.map((message) => message.createdAt), [
    "2026-06-07T00:00:00.000",
    "2026-06-07T00:00:02.000",
    "2026-06-07T00:00:06.000",
    "2026-06-07T00:00:12.000",
    "2026-06-07T00:00:16.000",
    "2026-06-07T00:00:20.000"
  ]);
  for (const message of transcriptMessages) {
    assert.equal(message.senderRole, "system");
    assert.equal(message.conversationId, "call-1");
    assert.doesNotMatch(message.contentText, /-已接通-|-已挂断-|Alice:|\{\{user\}\}:|\[message\]/);
  }
  const payloads = transcriptMessages.map((message) => JSON.parse(message.contentJson ?? "{}"));
  assert.deepEqual(payloads.map((payload) => payload.role), ["system", "user", "assistant", "user", "assistant", "system"]);
  assert.deepEqual(payloads.map((payload) => payload.entryId), [
    "system:start",
    "user:audio.transcript.final:2",
    "assistant:output-projection-1",
    "user:audio.transcript.final:3",
    "assistant:output-projection-2",
    "system:end"
  ]);
  assert.equal(payloads.every((payload) => payload.kind === "voicecalltranscript"), true);
  assert.equal(payloads.every((payload) => payload.talkSessionId === 1780830000025), true);
  assert.equal(payloads.every((payload) => payload.durationMs === 20000), true);
  assert.equal(transcriptMessages.filter((message) => message.externalMessageId === "voicecalltranscript:1780830000025:system:end").length, 1);
});

test("talk runtime records call_close hangup as one system end transcript entry", () => {
  const loops: number[] = [];
  const runtime = createTestRuntime("call-close-transcript", (sessionId) => {
    loops.push(sessionId);
  });

  runtime.openSession(sessionInput(1780830000026));
  runtime.appendAssistantDelta({
    sessionId: 1780830000026,
    outputId: "output-call-close",
    delta: "通話はまだ続いています。"
  });
  const interrupt = runtime.interruptOutput({
    sessionId: 1780830000026,
    outputId: "output-call-close",
    reason: "network",
    omitAssistantMessage: true
  });
  runtime.commitStableInputBatch({
    sessionId: 1780830000026,
    batchId: "batch-close",
    interruptEpoch: 1,
    inputs: [{
      interruptId: interrupt.interruptId,
      sequence: 2,
      reason: "call_close",
      text: "-已挂断-",
      occurredAt: "2026-06-07T00:00:19.000",
      occurredAtUtc: "2026-06-06T15:00:19.000Z"
    }]
  });
  runtime.closeSession({
    sessionId: 1780830000026,
    occurredAt: "2026-06-07T00:00:20.000",
    occurredAtUtc: "2026-06-06T15:00:20.000Z"
  });

  const entries = runtime.store.listTranscriptEntries(1780830000026);
  assert.deepEqual(entries.map((entry) => `${entry.role}:${entry.contentText}`), [
    "system:开始",
    "system:结束"
  ]);
  const endEntries = entries.filter((entry) => entry.entryId === "system:end");
  assert.equal(endEntries.length, 1);
  assert.equal(endEntries[0].occurredAt, "2026-06-07T00:00:19.000");
  assert.equal(endEntries[0].sourceKind, "call_close");
  assert.equal(endEntries[0].sourceId, interrupt.interruptId);
  assert.equal(entries.some((entry) => entry.role === "user" && /已挂断/.test(entry.contentText)), false);
  assert.equal(runtime.store.latestUnresolvedInterrupt(1780830000026), undefined);
  assert.deepEqual(loops, []);
});

function createTestRuntime(
  name: string,
  prepareAgentLoop?: (sessionId: number) => void,
  interruptAgentLoop?: (sessionId: number, outputId: string) => void,
  createLLMSession?: () => number,
  now?: () => Date
): ReturnType<typeof createTalkRuntime> {
  const store = createTalkStore(path.join(makeTempDir(`talk-runtime-${name}`), "talk.sqlite"));
  const time = createCurrentTimeProvider("Asia/Tokyo", now ?? (() => new Date("2026-06-06T15:00:00.000Z")));
  return createTalkRuntime({ store, time, prepareAgentLoop, interruptAgentLoop, createLLMSession });
}

function sessionInput(sessionId: number) {
  return {
    sessionId,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    occurredAt: "2026-06-07T00:00:00.000",
    occurredAtUtc: "2026-06-06T15:00:00.000Z",
    metadata: { language: "ja", callId: "call-1" }
  };
}

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
