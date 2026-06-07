import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkRuntime } from "../apps/api/src/talk-runtime.js";
import { createTalkStore } from "../packages/storage/src/talk-store.js";
import { createCurrentTimeProvider } from "../core/time/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("talk runtime exposes chunks after punctuation and twelve visible characters, then flushes tail", () => {
  const runtime = createTestRuntime("chunk");

  runtime.openSession(sessionInput("session-chunk"));
  runtime.appendAssistantDelta({ sessionId: "session-chunk", outputId: "output-1", delta: "你好，" });
  assert.equal(runtime.claimReadyOutputChunk("session-chunk"), undefined);

  runtime.appendAssistantDelta({ sessionId: "session-chunk", outputId: "output-1", delta: "今天要不要一起散步？" });
  const first = runtime.claimReadyOutputChunk("session-chunk");
  assert.equal(first?.text, "你好，今天要不要一起散步？");
  assert.equal(first?.outputId, "output-1");
  assert.equal(runtime.claimReadyOutputChunk("session-chunk"), undefined);

  runtime.appendAssistantDelta({ sessionId: "session-chunk", outputId: "output-1", delta: "好。" });
  assert.equal(runtime.claimReadyOutputChunk("session-chunk"), undefined);

  runtime.finishAssistantOutput({ sessionId: "session-chunk", outputId: "output-1" });
  assert.equal(runtime.claimReadyOutputChunk("session-chunk")?.text, "好。");
});

test("talk runtime uses created LLM session id and rejects stale session writes", () => {
  const runtime = createTestRuntime("llm-session-id", undefined, undefined, () => "llm-session-42");

  const opened = runtime.openSession({
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    occurredAt: "2026-06-07T00:00:00.000",
    occurredAtUtc: "2026-06-06T15:00:00.000Z",
    metadata: { language: "ja", callId: "call-42" }
  });

  assert.equal(opened.sessionId, "llm-session-42");
  assert.equal(runtime.store.getSession("llm-session-42")?.sessionId, "llm-session-42");
  assert.throws(() => runtime.ingestInput({
    kind: "text.final",
    sessionId: "webrtc_voice:call-42",
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    sequence: 1,
    occurredAt: "2026-06-07T00:00:01.000",
    occurredAtUtc: "2026-06-06T15:00:01.000Z",
    payload: { kind: "text", text: "stale id" }
  }), /talk session not found: webrtc_voice:call-42/);

  runtime.ingestInput({
    kind: "text.final",
    sessionId: opened.sessionId,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-42", userId: "browser-42" },
    sequence: 1,
    occurredAt: "2026-06-07T00:00:01.000",
    occurredAtUtc: "2026-06-06T15:00:01.000Z",
    payload: { kind: "text", text: "fresh id" }
  });
  assert.deepEqual(runtime.buildNextLoopMessages(opened.sessionId), [{ role: "user", content: "fresh id" }]);
});

test("talk runtime keeps parenthesized output in storage but out of TTS chunks across deltas", () => {
  const runtime = createTestRuntime("parenthesized");

  runtime.openSession(sessionInput("session-parenthesized"));
  runtime.appendAssistantDelta({ sessionId: "session-parenthesized", outputId: "output-parenthesized", delta: "（指先で" });
  runtime.appendAssistantDelta({ sessionId: "session-parenthesized", outputId: "output-parenthesized", delta: "そっとページの端をなぞるように）\n逆賊の愛卿、" });
  assert.equal(runtime.claimReadyOutputChunk("session-parenthesized"), undefined);

  runtime.appendAssistantDelta({ sessionId: "session-parenthesized", outputId: "output-parenthesized", delta: "何か奏上することがあるのか？" });
  const chunk = runtime.claimReadyOutputChunk("session-parenthesized");
  assert.equal(chunk?.text, "\n逆賊の愛卿、何か奏上することがあるのか？");

  const output = runtime.store.getOutput("output-parenthesized");
  assert.equal(output?.fullText, "（指先でそっとページの端をなぞるように）\n逆賊の愛卿、何か奏上することがあるのか？");
});

test("talk runtime removes breakpoint and following text from main output and stores it in discard table", () => {
  const runtime = createTestRuntime("interrupt");

  runtime.openSession(sessionInput("session-interrupt"));
  runtime.appendAssistantDelta({
    sessionId: "session-interrupt",
    outputId: "output-interrupt",
    delta: "今晚我们可以先吃饭，然后去散步。"
  });
  runtime.finishAssistantOutput({ sessionId: "session-interrupt", outputId: "output-interrupt" });

  const interrupt = runtime.interruptOutput({
    sessionId: "session-interrupt",
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
  assert.equal(discard?.breakpointCharIndex, 8);
  assert.equal(discard?.discardedText, "饭，然后去散步。");
  assert.equal(interrupt.breakMarker, "...");

  const cancelled = runtime.store.listChunks("output-interrupt").filter((chunk) => chunk.status === "cancelled");
  assert.ok(cancelled.length >= 1);
});

test("talk runtime uses voice breakpoint context instead of elapsed ratio", () => {
  const runtime = createTestRuntime("explicit-breakpoint");

  runtime.openSession(sessionInput("session-explicit-breakpoint"));
  runtime.appendAssistantDelta({
    sessionId: "session-explicit-breakpoint",
    outputId: "output-explicit-breakpoint",
    delta: "那些宫女太监，你说撤就撤了，一个都不给朕留。"
  });
  runtime.finishAssistantOutput({ sessionId: "session-explicit-breakpoint", outputId: "output-explicit-breakpoint" });

  runtime.interruptOutput({
    sessionId: "session-explicit-breakpoint",
    outputId: "output-explicit-breakpoint",
    reason: "barge_in",
    elapsedMs: 1,
    totalMs: 100,
    breakpointContext: { beforeText: "你说撤就撤了" }
  });

  assert.deepEqual(runtime.buildNextLoopMessages("session-explicit-breakpoint"), [
    { role: "assistant", content: "那些宫女太监，你说撤就撤了..." }
  ]);
});

test("talk runtime resolves breakpoint from playback text context", () => {
  const runtime = createTestRuntime("context-breakpoint");

  runtime.openSession(sessionInput("session-context-breakpoint"));
  runtime.appendAssistantDelta({
    sessionId: "session-context-breakpoint",
    outputId: "output-context-breakpoint",
    delta: "第一段重复内容。第二段重复内容。第三段结束。"
  });
  runtime.finishAssistantOutput({ sessionId: "session-context-breakpoint", outputId: "output-context-breakpoint" });

  const interrupt = runtime.interruptOutput({
    sessionId: "session-context-breakpoint",
    outputId: "output-context-breakpoint",
    reason: "barge_in",
    elapsedMs: 1,
    totalMs: 100,
    breakpointContext: {
      beforeText: "第一段重复内容。第二段重复",
      afterText: "内容。第三段结束。"
    }
  });

  assert.equal(interrupt.breakpointCharIndex, 13);
  assert.deepEqual(runtime.buildNextLoopMessages("session-context-breakpoint"), [
    { role: "assistant", content: "第一段重复内容。第二段重复..." }
  ]);
});

test("talk runtime resolves breakpoint context across omitted parenthesized text", () => {
  const runtime = createTestRuntime("context-parenthesized-breakpoint");

  runtime.openSession(sessionInput("session-context-parenthesized-breakpoint"));
  runtime.appendAssistantDelta({
    sessionId: "session-context-parenthesized-breakpoint",
    outputId: "output-context-parenthesized-breakpoint",
    delta: "你好（动作省略）世界。"
  });
  runtime.finishAssistantOutput({
    sessionId: "session-context-parenthesized-breakpoint",
    outputId: "output-context-parenthesized-breakpoint"
  });

  runtime.interruptOutput({
    sessionId: "session-context-parenthesized-breakpoint",
    outputId: "output-context-parenthesized-breakpoint",
    reason: "barge_in",
    breakpointContext: { beforeText: "你好", afterText: "世界。" }
  });

  assert.deepEqual(runtime.buildNextLoopMessages("session-context-parenthesized-breakpoint"), [
    { role: "assistant", content: "你好..." }
  ]);
});

test("talk runtime builds next loop messages with default break marker, not literal bracket marker", () => {
  const runtime = createTestRuntime("messages");

  runtime.openSession(sessionInput("session-messages"));
  runtime.appendAssistantDelta({
    sessionId: "session-messages",
    outputId: "output-messages",
    delta: "我刚才说到这里会继续说明。"
  });
  runtime.finishAssistantOutput({ sessionId: "session-messages", outputId: "output-messages" });
  runtime.interruptOutput({
    sessionId: "session-messages",
    outputId: "output-messages",
    reason: "barge_in",
    breakpointContext: { beforeText: "我刚才说到" },
    elapsedMs: 900,
    totalMs: 1800
  });
  runtime.ingestInput({
    kind: "audio.transcript.final",
    sessionId: "session-messages",
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 2,
    occurredAt: "2026-06-07T00:00:02.000",
    occurredAtUtc: "2026-06-06T15:00:02.000Z",
    payload: { kind: "transcript", text: "我想先问一个问题" }
  });

  const messages = runtime.buildNextLoopMessages("session-messages");
  assert.deepEqual(messages.slice(-2), [
    { role: "assistant", content: "我刚才说到..." },
    { role: "user", content: "我想先问一个问题" }
  ]);
  assert.doesNotMatch(messages.map((message) => message.content).join("\n"), /\[断点\]/);
});

test("talk runtime starts the next agent loop without waiting for output playback", () => {
  const loops: string[] = [];
  const runtime = createTestRuntime("idle-loop", (sessionId) => {
    loops.push(sessionId);
  });

  runtime.openSession(sessionInput("session-idle"));
  runtime.appendAssistantDelta({ sessionId: "session-idle", outputId: "output-idle", delta: "第一句已经准备好。" });
  runtime.finishAssistantOutput({ sessionId: "session-idle", outputId: "output-idle" });

  runtime.startAgentLoop("session-idle");
  assert.deepEqual(loops, ["session-idle"]);

  const chunk = runtime.claimReadyOutputChunk("session-idle");
  assert.ok(chunk);
  runtime.startAgentLoop("session-idle");
  assert.deepEqual(loops, ["session-idle", "session-idle"]);

  runtime.markOutputChunkPlayed({ sessionId: "session-idle", chunkId: chunk.chunkId });
  runtime.startAgentLoop("session-idle");
  assert.deepEqual(loops, ["session-idle", "session-idle", "session-idle"]);
});

test("talk runtime blocks output claim and next loop while waiting for final transcript after interrupt", () => {
  const loops: string[] = [];
  const runtime = createTestRuntime("interrupt-gate", (sessionId) => {
    loops.push(sessionId);
  });

  runtime.openSession(sessionInput("session-interrupt-gate"));
  runtime.appendAssistantDelta({
    sessionId: "session-interrupt-gate",
    outputId: "output-interrupt-gate",
    delta: "那些宫女太监，你说撤就撤了，一个都不给朕留。"
  });
  runtime.finishAssistantOutput({ sessionId: "session-interrupt-gate", outputId: "output-interrupt-gate" });
  const chunk = runtime.claimReadyOutputChunk("session-interrupt-gate");
  assert.ok(chunk);

  runtime.interruptOutput({
    sessionId: "session-interrupt-gate",
    outputId: "output-interrupt-gate",
    reason: "barge_in",
    breakpointContext: { beforeText: "那些宫女太监，你说撤就撤了" }
  });

  assert.equal(runtime.claimReadyOutputChunk("session-interrupt-gate"), undefined);
  runtime.startAgentLoop("session-interrupt-gate");
  assert.deepEqual(loops, []);

  runtime.ingestInput({
    kind: "audio.transcript.final",
    sessionId: "session-interrupt-gate",
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 2,
    occurredAt: "2026-06-07T00:00:02.000",
    occurredAtUtc: "2026-06-06T15:00:02.000Z",
    payload: { kind: "transcript", text: "Hello,爱丽丝, hello hello hello." }
  });

  assert.deepEqual(loops, ["session-interrupt-gate"]);
  assert.deepEqual(runtime.buildNextLoopMessages("session-interrupt-gate").slice(-2), [
    { role: "assistant", content: "那些宫女太监，你说撤就撤了..." },
    { role: "user", content: "Hello,爱丽丝, hello hello hello." }
  ]);
});

test("talk runtime commits stable input batch in interrupt order", () => {
  const loops: string[] = [];
  const runtime = createTestRuntime("stable-batch", (sessionId) => {
    loops.push(sessionId);
  });

  runtime.openSession(sessionInput("session-stable-batch"));
  runtime.appendAssistantDelta({ sessionId: "session-stable-batch", outputId: "output-a", delta: "第一段被打断。" });
  runtime.finishAssistantOutput({ sessionId: "session-stable-batch", outputId: "output-a" });
  const first = runtime.interruptOutput({
    sessionId: "session-stable-batch",
    outputId: "output-a",
    reason: "barge_in",
    breakpointContext: { beforeText: "第一段" }
  });
  runtime.appendAssistantDelta({ sessionId: "session-stable-batch", outputId: "output-b", delta: "第二段也被打断。" });
  const second = runtime.interruptOutput({
    sessionId: "session-stable-batch",
    outputId: "output-b",
    reason: "manual",
    breakpointContext: { beforeText: "第二" },
    omitAssistantMessage: true
  });

  runtime.commitStableInputBatch({
    sessionId: "session-stable-batch",
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

  assert.deepEqual(runtime.buildNextLoopMessages("session-stable-batch").slice(-3), [
    { role: "assistant", content: "第一段..." },
    { role: "user", content: "第一次输入" },
    { role: "user", content: "第二次输入" }
  ]);
  assert.equal(runtime.store.latestUnresolvedInterrupt("session-stable-batch"), undefined);
  assert.deepEqual(loops, ["session-stable-batch"]);
});

test("talk runtime notifies agent loop interrupt when assistant output is interrupted", () => {
  const interrupted: string[] = [];
  const runtime = createTestRuntime("interrupt-agent", undefined, (sessionId, outputId) => {
    interrupted.push(`${sessionId}:${outputId}`);
  });

  runtime.openSession(sessionInput("session-interrupt-agent"));
  runtime.appendAssistantDelta({ sessionId: "session-interrupt-agent", outputId: "output-interrupt-agent", delta: "正在说话。" });
  runtime.interruptOutput({
    sessionId: "session-interrupt-agent",
    outputId: "output-interrupt-agent",
    reason: "barge_in",
    breakpointContext: { beforeText: "正在" }
  });

  assert.deepEqual(interrupted, ["session-interrupt-agent:output-interrupt-agent"]);
});

test("talk runtime can interrupt the latest streaming output when voice has no chunk target yet", () => {
  const interrupted: string[] = [];
  const runtime = createTestRuntime("interrupt-latest", undefined, (sessionId, outputId) => {
    interrupted.push(`${sessionId}:${outputId}`);
  });

  runtime.openSession(sessionInput("session-interrupt-latest"));
  runtime.appendAssistantDelta({ sessionId: "session-interrupt-latest", outputId: "output-latest", delta: "正在生成但还没有进入播放。" });

  const interrupt = runtime.interruptLatestOutput({
    sessionId: "session-interrupt-latest",
    reason: "manual",
    breakpointContext: { beforeText: "正在生成" }
  });

  assert.equal(interrupt?.outputId, "output-latest");
  assert.deepEqual(interrupted, ["session-interrupt-latest:output-latest"]);
  assert.equal(runtime.store.getOutput("output-latest")?.fullText, "正在生成");
  assert.equal(runtime.claimReadyOutputChunk("session-interrupt-latest"), undefined);
});

test("talk runtime cancels later assistant outputs when an earlier playback output is interrupted", () => {
  const runtime = createTestRuntime("interrupt-cancels-later");

  runtime.openSession(sessionInput("session-cancel-later"));
  runtime.appendAssistantDelta({ sessionId: "session-cancel-later", outputId: "output-playback", delta: "第一段正在播放。后面应该截断。" });
  runtime.finishAssistantOutput({ sessionId: "session-cancel-later", outputId: "output-playback" });
  runtime.appendAssistantDelta({ sessionId: "session-cancel-later", outputId: "output-later", delta: "第二段已经生成但不该进入上下文。" });
  runtime.finishAssistantOutput({ sessionId: "session-cancel-later", outputId: "output-later" });

  runtime.interruptOutput({
    sessionId: "session-cancel-later",
    outputId: "output-playback",
    reason: "barge_in",
    breakpointContext: { beforeText: "第一段正在播放" }
  });

  assert.equal(runtime.store.getOutput("output-later")?.status, "cancelled");
  assert.equal(runtime.store.listChunks("output-later").every((chunk) => chunk.status === "cancelled"), true);
  assert.deepEqual(runtime.buildNextLoopMessages("session-cancel-later"), [
    { role: "assistant", content: "第一段正在播放..." }
  ]);
});

test("talk runtime omits the queued next assistant output when interrupt happens between playback segments", () => {
  const runtime = createTestRuntime("interrupt-between-segments");

  runtime.openSession(sessionInput("session-between-segments"));
  runtime.appendAssistantDelta({ sessionId: "session-between-segments", outputId: "output-16", delta: "第一段已经完整播放。" });
  runtime.finishAssistantOutput({ sessionId: "session-between-segments", outputId: "output-16" });
  runtime.appendAssistantDelta({ sessionId: "session-between-segments", outputId: "output-17", delta: "第二段已经生成但还没有开始播放。" });
  runtime.finishAssistantOutput({ sessionId: "session-between-segments", outputId: "output-17" });

  const interrupt = runtime.interruptOutput({
    sessionId: "session-between-segments",
    outputId: "output-17",
    reason: "barge_in",
    breakpointContext: { beforeText: "完整播放。", afterText: "第二段已经" },
    omitAssistantMessage: true
  });

  assert.equal(runtime.store.getOutput("output-17")?.status, "cancelled");
  assert.equal(runtime.store.getOutput("output-17")?.fullText, "");
  assert.ok(interrupt.discardId);
  assert.equal(runtime.store.getDiscard(interrupt.discardId)?.discardedText, "第二段已经生成但还没有开始播放。");
  assert.deepEqual(runtime.buildNextLoopMessages("session-between-segments"), [
    { role: "assistant", content: "第一段已经完整播放。" }
  ]);

  runtime.ingestInput({
    kind: "audio.transcript.final",
    sessionId: "session-between-segments",
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    sequence: 2,
    occurredAt: "2026-06-07T00:00:02.000",
    occurredAtUtc: "2026-06-06T15:00:02.000Z",
    payload: { kind: "transcript", text: "只有一半吗？只有" }
  });

  assert.deepEqual(runtime.buildNextLoopMessages("session-between-segments").slice(-2), [
    { role: "assistant", content: "第一段已经完整播放。" },
    { role: "user", content: "只有一半吗？只有" }
  ]);
});

function createTestRuntime(
  name: string,
  runAgentLoop?: (sessionId: string) => void,
  interruptAgentLoop?: (sessionId: string, outputId: string) => void,
  createLLMSession?: () => string | number
): ReturnType<typeof createTalkRuntime> {
  const store = createTalkStore(path.join(makeTempDir(`talk-runtime-${name}`), "talk.sqlite"));
  const time = createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:00:00.000Z"));
  return createTalkRuntime({ store, time, runAgentLoop, interruptAgentLoop, createLLMSession });
}

function sessionInput(sessionId: string) {
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
