import { test } from "node:test";
import assert from "node:assert/strict";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { projectClosedTalkSessionToConversationHub } from "../../../src/contexts/talk-session/src/runtime/talk-session-runtime.js";
import {
  createCurrentTimeProvider,
  createTalkRuntime,
  createTalkStore,
  createTestRuntime,
  makeTempDir,
  path,
  sessionInput
} from "./talk-runtime-helpers.js";

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
