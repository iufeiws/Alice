import type { AgentStateStore } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createMessageRuntimeRuntime } from "../../../src/apps/api/bootstrap/message-runtime-runtime.js";
import type { AgentEvent, AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

export function textEvent(sessionId: string, rawMessageId: string, text: string): AgentEvent {
  return textEventAt(sessionId, rawMessageId, text, "2026-05-24T00:00:00.000Z");
}

export function textEventAt(sessionId: string, rawMessageId: string, text: string, receivedAt: string): AgentEvent {
  return {
    id: `evt_${rawMessageId}`,
    source: {
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      rawMessageId
    },
    externalSession: {
      scope: "dm",
      sessionId
    },
    type: "message.text",
    payload: { kind: "text", text },
    meta: {
      receivedAt,
      replyTo: rawMessageId
    }
  };
}

export function audioEvent(sessionId: string, rawMessageId: string, assetId: string, transcript: string): AgentEvent {
  return {
    id: `evt_${rawMessageId}`,
    source: {
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      rawMessageId
    },
    externalSession: {
      scope: "dm",
      sessionId
    },
    type: "message.audio",
    payload: { kind: "audio", assetId, transcript },
    meta: {
      receivedAt: "2026-05-24T00:00:00.000Z",
      replyTo: rawMessageId
    }
  };
}

export function imageResourceEvent(sessionId: string, rawMessageId: string, resourceId: string, filename?: string): AgentEvent {
  return {
    id: `evt_${rawMessageId}`,
    source: {
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      rawMessageId
    },
    externalSession: {
      scope: "dm",
      sessionId
    },
    type: "message.image",
    payload: {
      kind: "image",
      resource: {
        id: resourceId,
        filename,
        mime: "image/png"
      }
    },
    meta: {
      receivedAt: "2026-05-24T00:00:00.000Z",
      replyTo: rawMessageId
    }
  };
}

export function textOutput(sessionId: string, text: string): AgentOutput {
  return {
    id: "out_1",
    target: {
      plugin: "feishu",
      channelId: "chat",
      sessionId
    },
    content: { kind: "text", text },
    meta: {
      createdAt: "2026-05-24T00:00:00.000Z",
      urgency: "normal"
    }
  };
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function memoryStore(initial?: string): AgentStateStore & { content?: string } {
  return {
    content: initial,
    read() {
      return this.content;
    },
    write(content) {
      this.content = content;
    }
  };
}

export function randomQueue(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

export async function runMessageRuntimeWakeIndicator(trigger: "sleep_cocoon.wake" | "sleep_cocoon.force_wake"): Promise<string[]> {
  const root = makeTempDir(`runtime-wake-indicator-${trigger.replace(/\W/g, "-")}`);
  const store = createAliceStore(path.join(root, "alice.sqlite"));
  const messagingConfigPath = path.join(root, "config", "plugin", "messaging", "config.json");
  fs.mkdirSync(path.dirname(messagingConfigPath), { recursive: true });
  fs.writeFileSync(messagingConfigPath, `${JSON.stringify({
    splitMultilineSendChat: true,
    limitConsecutiveSends: true,
    feishuTypingEmojiEnabled: false,
    mapMarkdownLikeToMarkdown: false
  })}\n`);
  const events: string[] = [];
  let wakeEvent: AgentEvent | undefined = {
    ...textEvent("session-1", `event_${trigger}`, "wake"),
    type: "system.heartbeat",
    meta: {
      receivedAt: "2026-05-24T08:00:00.000Z",
      raw: { agentInitiatedTriggerEvent: trigger }
    }
  };
  const runtime = createMessageRuntimeRuntime({
    config: { core: { inboundDebounceMs: 0, heartbeatPaused: false } },
    time: {
      timeZone: "UTC",
      now: () => ({ iso: "2026-05-26T00:00:00.000Z", date: new Date("2026-05-26T00:00:00.000Z") })
    },
    store,
    chatAgent: {
      clearLLMSession() {},
      async prepareEventRun() {
        events.push("loop");
        return [];
      }
    },
    agentLoopRuntime: undefined,
    talkRuntime: undefined,
    agentState: {
      tick() {
        return { state: "waiting", intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 };
      },
      getSnapshot: () => ({ state: "waiting" }),
      onChange: () => () => {},
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      getInboundDelayMs: () => 0,
      noteInboundMessage() {
        return { state: "waiting", intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 };
      }
    },
    outputRouter: { async sendAll() {} },
    isLLMSessionActive: () => false,
    messagingConfigPath,
    feishu: { async setTyping() {} },
    wechat: { async setTyping() {} },
    agentRunIndicator: {
      async createFreshCard() {
        events.push("fresh");
      },
      async setTyping(input: { typing: boolean }) {
        events.push(`typing:${input.typing}`);
      }
    },
    initiatedBehaviorRunStore: { finalizeExpiredResponses() {}, markRespondedWithin15m: () => 0 },
    getAgentInitiatedBehaviorPlans: () => [],
    getDefaultMessagingTarget: () => undefined,
    getSleepCocoonGoodnightEvent: () => undefined,
    getSleepCocoonWakeEvent: () => {
      const event = wakeEvent;
      wakeEvent = undefined;
      return event;
    },
    getCalendarReminderEvent: () => undefined,
    queueForceWakeEvent() {},
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  await waitFor(() => events.includes("typing:false"));
  await runtime.flushAll();
  return events;
}

export function idleTransitionState(
  getState: () => "idle" | "waiting",
  setState: (state: "idle" | "waiting") => void,
  getNow: () => Date,
  inboundDelayMs = 0
) {
  return {
    canReplyToInbound: () => true,
    canRunHeartbeat: () => true,
    getInboundDelayMs: () => inboundDelayMs,
    getSnapshot() {
      return {
        state: getState(),
        intimacy: 50,
        updatedAt: getNow().toISOString(),
        nextTransitionAt: getNow().toISOString(),
        responseDelayMs: 0
      };
    },
    tick() {
      if (getState() === "idle") {
        setState("waiting");
        return { state: "waiting" as const, intimacy: 50, updatedAt: getNow().toISOString(), responseDelayMs: 0, reason: "idle_timer" };
      }
      return { state: getState(), intimacy: 50, updatedAt: getNow().toISOString(), responseDelayMs: 0 };
    },
    setState(state: any) {
      setState(state as "idle" | "waiting");
      return { state: getState(), intimacy: 50, updatedAt: getNow().toISOString(), responseDelayMs: 0, reason: "randomized_initiated_behavior" };
    },
    onChange: () => () => {},
    noteInboundMessage() {
      return { state: getState(), intimacy: 50, updatedAt: getNow().toISOString(), responseDelayMs: 0 };
    }
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
