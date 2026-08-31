import type { FeishuConfig } from "./types.js";
import type { AgentOutput, ChannelPlugin } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { createInMemoryFeishuBindingStore, type FeishuBindingStore } from "./bindings.js";
import { isFeishuConfigured } from "./config.js";
import { createFeishuMonitor } from "./monitor.js";
import { checkFeishuEventPolicy } from "./policy.js";
import { renderForFeishu } from "./renderer.js";
import type { FeishuAudioMessageEvent, FeishuDynamicCardClient, FeishuMessageLifecycleEvent, FeishuPluginDeps, FeishuTextMessageEvent } from "./types.js";
import { textMessageEventToAgentEvent } from "./handlers/message.js";
import { reactionEventToLifecycleEvent, readEventToLifecycleEvent, recalledEventToLifecycleEvent } from "./handlers/lifecycle.js";
import { getPairingCommand, isPairingCommand } from "./pairing.js";
import { createRecentMessageDeduper } from "./dedupe.js";
import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import { createId } from "../../../shared/uuid/src/index.js";
import { sanitizeAudioTranscript } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

const TYPING_EMOJI_TYPE = "Coffee";
const REMOVE_TYPING_REACTION_ATTEMPTS = 3;
const REMOVE_TYPING_REACTION_RETRY_DELAY_MS = 250;

type FeishuTypingSessionState = {
  latestMessageId?: string;
  typingMessageId?: string;
  typingReactionId?: string;
  emojiType: string;
  accountId?: string;
};

type FeishuMonitor = ReturnType<typeof createFeishuMonitor>;

export function createFeishuPlugin(config: FeishuConfig, deps: FeishuPluginDeps): ChannelPlugin & {
  ingestTextMessage(raw: FeishuTextMessageEvent, accountId?: string): Promise<void>;
  ingestAudioMessage(raw: FeishuAudioMessageEvent, accountId?: string): Promise<void>;
  downloadInboundAttachment(input: { event: Awaited<ReturnType<typeof textMessageEventToAgentEvent>>; filePath: string }): Promise<{ filename?: string; mime?: string } | void>;
  setTyping(input: { userId?: string; channelId?: string; sessionId?: string; typing: boolean }): Promise<void>;
  agentRunCardClient: FeishuDynamicCardClient;
  getAccountStatuses(): Array<{ accountId: string; configured: boolean; started: boolean }>;
  getDefaultAccountId(): string | undefined;
} {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const bindings = createInMemoryFeishuBindingStore();
  const deduper = createRecentMessageDeduper();
  const typingSessions = new Map<string, FeishuTypingSessionState>();
  const monitors = new Map<string, FeishuMonitor>();

  function getDefaultAccountId(): string | undefined {
    if (config.activeAccount && config.accounts[config.activeAccount]) return config.activeAccount;
    const ids = Object.keys(config.accounts);
    return ids.includes("main") ? "main" : ids[0];
  }

  // 当前账户指针：最后收到消息的账户。变化时回调宿主持久化到账户配置处。
  function updateActiveAccount(accountId: string): void {
    if (config.activeAccount === accountId) return;
    config.activeAccount = accountId;
    void Promise.resolve(deps.onActiveAccountChanged?.(accountId)).catch((error) => {
      deps.log?.("warn", `[feishu] failed to persist active account: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function ensureMonitor(accountId: string): FeishuMonitor {
    const existing = monitors.get(accountId);
    if (existing) return existing;
    if (!config.accounts[accountId]) {
      throw new Error(`Feishu account "${accountId}" is not configured`);
    }
    const monitor = createFeishuMonitor(config, accountId, {
      log: deps.log,
      time,
      async onMessage(raw) {
        if (isFeishuAudioMessage(raw)) {
          await receiveAudioMessage(raw, accountId);
          return;
        }
        await receiveTextMessage(raw as FeishuTextMessageEvent, accountId);
      },
      async onLifecycle(kind, raw) {
        await receiveLifecycleEvent(kind, raw);
      },
      async onCardAction(event) {
        return await deps.onCardAction?.({ ...event, accountId });
      }
    });
    monitors.set(accountId, monitor);
    return monitor;
  }

  // 出站路由规则：目标 accountId 已配置时使用它；未指定时使用默认账户（main 或第一个账户）；
  // 指定了未配置的账户则显式报错，不做静默回退。
  function resolveMonitorFor(accountId?: string): FeishuMonitor {
    const resolvedId = accountId ?? getDefaultAccountId();
    if (!resolvedId) throw new Error("Feishu has no configured account");
    return ensureMonitor(resolvedId);
  }

  const agentRunCardClient: FeishuDynamicCardClient = {
    isStarted: () => [...monitors.values()].some((monitor) => monitor.isStarted()),
    createApprovalCard: (input) => resolveMonitorFor(input.accountId).createApprovalCard(input),
    deleteMessage: (input) => resolveMonitorFor(input.accountId).deleteMessage(input),
    createAgentRunCard: (input) => resolveMonitorFor(input.accountId).createAgentRunCard(input),
    updateAgentRunCardBlocks: (input) => resolveMonitorFor(input.accountId).updateAgentRunCardBlocks(input),
    setAgentRunCardStreaming: (input) => resolveMonitorFor(input.accountId).setAgentRunCardStreaming(input),
    resolveAgentRunCardId: (input) => resolveMonitorFor(input.accountId).resolveAgentRunCardId(input),
    createToolExecutionCard: (input) => resolveMonitorFor(input.accountId).createToolExecutionCard(input),
    groupToolExecutionCard: (input) => resolveMonitorFor(input.accountId).groupToolExecutionCard(input),
    updateToolExecutionCard: (input) => resolveMonitorFor(input.accountId).updateToolExecutionCard(input),
    setToolExecutionCardStreaming: (input) => resolveMonitorFor(input.accountId).setToolExecutionCardStreaming(input)
  };

  const plugin = {
    id: "feishu",
    async start() {
      if (!isFeishuConfigured(config)) {
        deps.log?.("warn", "[feishu] disabled or missing credentials");
        return;
      }
      for (const [accountId, monitor] of [...monitors.entries()]) {
        if (!config.accounts[accountId]) {
          await monitor.stop();
          monitors.delete(accountId);
        }
      }
      for (const accountId of Object.keys(config.accounts)) {
        await ensureMonitor(accountId).start();
      }
    },
    async stop() {
      await clearTypingIndicators();
      await Promise.all([...monitors.values()].map((monitor) => monitor.stop()));
    },
    async send(output: AgentOutput) {
      const plan = renderForFeishu(output);
      let result: void | { messageId?: string };
      if (deps.outbound) {
        result = await deps.outbound.send(plan);
        noteOutboundMessage(output.target.sessionId, result?.messageId, output.target.accountId);
        return result;
      }

      const monitor = resolveMonitorFor(output.target.accountId);

      if (plan.kind === "text") {
        result = await monitor.sendText({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          text: plan.text
        });
        noteOutboundMessage(output.target.sessionId, result.messageId, output.target.accountId);
        return result;
      }

      if (plan.kind === "markdown") {
        result = await monitor.sendMarkdown({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          markdown: plan.markdown
        });
        noteOutboundMessage(output.target.sessionId, result.messageId, output.target.accountId);
        return result;
      }

      if (plan.kind === "core-card") {
        result = await monitor.sendCoreCard({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          markdown: plan.markdown
        });
        noteOutboundMessage(output.target.sessionId, result.messageId, output.target.accountId);
        return result;
      }

      if (plan.kind === "image") {
        result = await monitor.sendImage({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          assetId: plan.assetId
        });
        noteOutboundMessage(output.target.sessionId, result.messageId, output.target.accountId);
        return result;
      }

      if (plan.kind === "audio") {
        result = await monitor.sendAudio({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          assetId: plan.assetId,
          duration: plan.duration,
          filename: plan.filename
        });
        noteOutboundMessage(output.target.sessionId, result.messageId, output.target.accountId);
        return result;
      }

      result = await monitor.sendFile({
        receiveIdType: plan.receiveIdType,
        receiveId: plan.receiveId,
        assetId: plan.assetId,
        filename: plan.filename
      });
      noteOutboundMessage(output.target.sessionId, result.messageId, output.target.accountId);
      return result;
    },
    async ingestTextMessage(raw: FeishuTextMessageEvent, accountId = getDefaultAccountId()) {
      if (!accountId) return;
      await receiveTextMessage(raw, accountId);
    },
    async ingestAudioMessage(raw: FeishuAudioMessageEvent, accountId = getDefaultAccountId()) {
      if (!accountId) return;
      await receiveAudioMessage(raw, accountId);
    },
    async downloadInboundAttachment(input: { event: Awaited<ReturnType<typeof textMessageEventToAgentEvent>>; filePath: string }) {
      const type = input.event.payload.kind;
      if (type !== "image" && type !== "file") throw new Error("inbound attachment must be image or file");
      const resource = input.event.payload.resource;
      if (!resource?.id) throw new Error("missing inbound attachment resource");
      await resolveMonitorFor(input.event.source.accountId).downloadMessageResource({
        messageId: input.event.source.rawMessageId ?? input.event.id,
        fileKey: resource.id,
        type,
        filePath: input.filePath
      });
      return {
        filename: resource.filename,
        mime: resource.mime
      };
    },
    async setTyping(input: { userId?: string; channelId?: string; sessionId?: string; typing: boolean }) {
      await setTyping(input);
    },
    getAccountStatuses() {
      return Object.keys(config.accounts).map((accountId) => ({
        accountId,
        configured: true,
        started: monitors.get(accountId)?.isStarted() ?? false
      }));
    },
    getDefaultAccountId() {
      return getDefaultAccountId();
    },
    agentRunCardClient
  };

  async function receiveLifecycleEvent(
    kind: "reaction.created" | "reaction.deleted" | "message.read" | "message.recalled",
    raw: unknown
  ): Promise<void> {
    try {
      const event = normalizeLifecycleEvent(kind, raw, time);
      if (!event.externalMessageId) {
        deps.log?.("warn", `[feishu] ignored ${kind}: missing message id`);
        return;
      }
      deps.log?.("info", `[feishu] normalized lifecycle ${kind} ${event.externalMessageId}`);
      await deps.onLifecycleEvent?.(event);
    } catch (error) {
      deps.log?.("error", `[feishu] failed to receive lifecycle event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function receiveTextMessage(raw: FeishuTextMessageEvent, accountId: string): Promise<void> {
    try {
      const event = await textMessageEventToAgentEvent(raw, bindings, accountId, time);
      deps.log?.("info", `[feishu] normalized message ${event.source.rawMessageId ?? event.id}: ${event.payload.kind} (account=${accountId})`);
      const dedupeKey = event.source.rawMessageId ?? event.id;
      if (!deduper.remember(dedupeKey)) {
        deps.log?.("warn", `[feishu] duplicate message ignored: ${dedupeKey}`);
        return;
      }
      updateActiveAccount(accountId);
      noteInboundMessage(event.externalSession.sessionId, event.source.rawMessageId, accountId);
      queueTextMessage(event);
    } catch (error) {
      deps.log?.("error", `[feishu] failed to receive message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function receiveAudioMessage(raw: FeishuAudioMessageEvent, accountId: string): Promise<void> {
    try {
      const messageId = raw.event.message.message_id;
      if (!deduper.remember(messageId)) {
        deps.log?.("warn", `[feishu] duplicate message ignored: ${messageId}`);
        return;
      }
      updateActiveAccount(accountId);
      queueAudioMessage(raw, accountId);
    } catch (error) {
      deps.log?.("error", `[feishu] failed to receive audio message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function queueTextMessage(event: Awaited<ReturnType<typeof textMessageEventToAgentEvent>>): void {
    Promise.resolve()
      .then(() => handleTextMessage(event))
      .catch((error) => {
        deps.log?.("error", `[feishu] failed to process message ${event.source.rawMessageId ?? event.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  function queueAudioMessage(raw: FeishuAudioMessageEvent, accountId: string): void {
    Promise.resolve()
      .then(() => handleAudioMessage(raw, accountId))
      .catch((error) => {
        deps.log?.("error", `[feishu] failed to process audio message ${raw.event.message.message_id}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  async function handleTextMessage(event: Awaited<ReturnType<typeof textMessageEventToAgentEvent>>): Promise<void> {
      if (isPairingCommand(event)) {
        const result = deps.pairingStore?.pairFromEvent(event);
        if (result && !result.ok) {
          deps.log?.("warn", `[feishu] pairing rejected: already bound to ${result.contact.id}`);
          const now = time.now();
          await plugin.send({
            id: `pair_reject_${Date.now()}`,
            target: {
              plugin: "feishu",
              accountId: event.source.accountId,
              channelId: event.source.channelId,
              userId: event.source.userId,
              sessionId: event.externalSession.sessionId,
              replyTo: event.meta.replyTo
            },
            content: {
              kind: "text",
              text: "Pairing rejected. This agent is already bound to one Feishu user."
            },
            meta: {
              createdAt: now.iso,
              createdAtUtc: now.date.toISOString(),
              urgency: "normal"
            }
          });
          return;
        }

        deps.log?.("info", `[feishu] paired unique contact ${result?.contact.id ?? event.source.userId ?? "(unknown)"}`);
        const now = time.now();
        await plugin.send({
          id: `pair_${Date.now()}`,
          target: {
            plugin: "feishu",
            accountId: event.source.accountId,
            channelId: event.source.channelId,
            userId: event.source.userId,
            sessionId: event.externalSession.sessionId,
            replyTo: event.meta.replyTo
          },
          content: {
            kind: "text",
            text: "Paired as the unique Feishu user. I can now reply here and keep this contact for future proactive messages."
          },
          meta: {
            createdAt: now.iso,
            createdAtUtc: now.date.toISOString(),
            urgency: "normal"
          }
        });
        return;
      }

      const decision = checkFeishuEventPolicy(config, event);
      if (decision.allowed && config.dmPolicy === "pairing" && event.externalSession.scope === "dm" && !deps.pairingStore?.isPaired(event)) {
        deps.log?.("warn", `[feishu] ignored event: pairing required, command=${getPairingCommand()}`);
        return;
      }
      if (!decision.allowed) {
        deps.log?.("warn", `[feishu] ignored event: ${decision.reason ?? "policy denied"}`);
        return;
      }
      await deps.onEvent(event);
  }

  async function handleAudioMessage(raw: FeishuAudioMessageEvent, accountId: string): Promise<void> {
    if (!deps.asr) {
      deps.log?.("warn", `[feishu] ignored audio ${raw.event.message.message_id}: asr is not configured`);
      return;
    }

    const content = parseFeishuAudioContent(raw.event.message.content);
    if (!content.fileKey) {
      deps.log?.("warn", `[feishu] ignored audio ${raw.event.message.message_id}: missing file_key`);
      return;
    }

    const stored = deps.storeAudioAsset
      ? await deps.storeAudioAsset({
        fileKey: content.fileKey,
        messageId: raw.event.message.message_id,
        raw
      })
      : await resolveMonitorFor(accountId).downloadAudioResource({
        fileKey: content.fileKey,
        messageId: raw.event.message.message_id
      });
    const asrResult = await deps.asr.transcribe({
      audioFile: stored.filePath,
      filename: stored.filename,
      mimeType: stored.mimeType,
      metadata: {
        plugin: "feishu",
        messageId: raw.event.message.message_id,
        chatId: raw.event.message.chat_id
      }
    });
    if (!("text" in asrResult)) {
      deps.log?.("warn", `[feishu] ignored audio ${raw.event.message.message_id}: asr ${asrResult.error}`);
      return;
    }

    const transcript = sanitizeAudioTranscript(asrResult.text);
    if (!transcript) {
      deps.log?.("warn", `[feishu] ignored audio ${raw.event.message.message_id}: asr empty_transcription`);
      return;
    }

    const event = await audioMessageEventToAgentEvent(raw, stored.assetId, transcript, bindings, time, accountId);
    noteInboundMessage(event.externalSession.sessionId, event.source.rawMessageId, accountId);
    const decision = checkFeishuEventPolicy(config, event);
    if (decision.allowed && config.dmPolicy === "pairing" && event.externalSession.scope === "dm" && !deps.pairingStore?.isPaired(event)) {
      deps.log?.("warn", `[feishu] ignored event: pairing required, command=${getPairingCommand()}`);
      return;
    }
    if (!decision.allowed) {
      deps.log?.("warn", `[feishu] ignored event: ${decision.reason ?? "policy denied"}`);
      return;
    }
    await deps.onEvent(event);
  }

  function getTypingState(sessionId: string): FeishuTypingSessionState {
    const existing = typingSessions.get(sessionId);
    if (existing) return existing;
    const created = { emojiType: TYPING_EMOJI_TYPE };
    typingSessions.set(sessionId, created);
    return created;
  }

  function noteInboundMessage(sessionId: string, messageId: string | undefined, accountId: string): void {
    if (!messageId) return;
    const state = getTypingState(sessionId);
    state.latestMessageId = messageId;
    state.accountId = accountId;
  }

  function noteOutboundMessage(sessionId: string | undefined, messageId: string | undefined, accountId?: string): void {
    if (!sessionId || !messageId) return;
    const state = getTypingState(sessionId);
    state.latestMessageId = messageId;
    if (accountId) state.accountId = accountId;
  }

  async function setTyping(input: { sessionId?: string; typing: boolean }): Promise<void> {
    if (!input.sessionId) {
      deps.log?.("warn", "[feishu] typing ignored: missing session id");
      return;
    }
    const state = getTypingState(input.sessionId);
    if (!input.typing) {
      await clearTypingIndicator(input.sessionId, state);
      return;
    }
    if (!state.latestMessageId) {
      deps.log?.("warn", `[feishu] typing ignored: missing recent message for ${input.sessionId}`);
      return;
    }
    if (state.typingMessageId === state.latestMessageId && state.typingReactionId) {
      return;
    }
    if (state.typingMessageId || state.typingReactionId) {
      await clearTypingIndicator(input.sessionId, state);
    }
    try {
      const result = await reactionClient(state.accountId).addReaction({
        messageId: state.latestMessageId,
        emojiType: state.emojiType
      });
      if (!result.reactionId) {
        deps.log?.("warn", `[feishu] typing start failed: reaction id missing for ${state.latestMessageId}`);
        return;
      }
      state.typingMessageId = state.latestMessageId;
      state.typingReactionId = result.reactionId;
      deps.log?.("info", `[feishu] typing started: ${input.sessionId}`);
    } catch (error) {
      deps.log?.("warn", `[feishu] typing start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function clearTypingIndicators(): Promise<void> {
    await Promise.all([...typingSessions.entries()].map(([sessionId, state]) => clearTypingIndicator(sessionId, state)));
  }

  async function clearTypingIndicator(sessionId: string, state: FeishuTypingSessionState): Promise<void> {
    const messageId = state.typingMessageId;
    const reactionId = state.typingReactionId;
    state.typingMessageId = undefined;
    state.typingReactionId = undefined;
    if (!messageId || !reactionId) return;
    try {
      await removeTypingReactionWithRetry({ messageId, reactionId, accountId: state.accountId });
      deps.log?.("info", `[feishu] typing stopped: ${sessionId}`);
    } catch (error) {
      deps.log?.("warn", `[feishu] typing stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function reactionClient(accountId?: string) {
    return deps.reactionClient ?? resolveMonitorFor(accountId);
  }

  async function removeTypingReactionWithRetry(input: { messageId: string; reactionId: string; accountId?: string }): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= REMOVE_TYPING_REACTION_ATTEMPTS; attempt += 1) {
      try {
        await reactionClient(input.accountId).removeReaction({
          messageId: input.messageId,
          reactionId: input.reactionId
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < REMOVE_TYPING_REACTION_ATTEMPTS) {
          deps.log?.("warn", `[feishu] typing stop retry ${attempt}/${REMOVE_TYPING_REACTION_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`);
          await delay(REMOVE_TYPING_REACTION_RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  }

  return plugin;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function audioMessageEventToAgentEvent(
  raw: FeishuAudioMessageEvent,
  assetId: string,
  transcript: string,
  bindings: FeishuBindingStore,
  time: CurrentTimeProvider,
  accountId: string
) {
  const message = raw.event.message;
  const sender = raw.event.sender.sender_id;
  const userId = sender.open_id ?? sender.user_id;
  const scope = message.chat_type === "p2p" ? "dm" : "group";
  const sessionId = await bindings.resolveSession({
    chatId: message.chat_id,
    chatType: message.chat_type,
    userId,
    threadId: message.thread_id
  });
  const receivedAtUtc = raw.header?.create_time ? new Date(Number(raw.header.create_time)).toISOString() : new Date().toISOString();
  const receivedAt = time.addMs(0, new Date(receivedAtUtc)).iso;
  return {
    id: raw.header?.event_id ?? createId("evt"),
    source: {
      plugin: "feishu",
      accountId,
      channelId: message.chat_id,
      userId,
      rawMessageId: message.message_id
    },
    externalSession: {
      scope,
      sessionId,
      threadId: message.thread_id
    },
    type: "message.audio",
    payload: {
      kind: "audio",
      assetId,
      transcript
    },
    meta: {
      receivedAt,
      receivedAtUtc,
      mentionsBot: Boolean(message.mentions?.length),
      replyTo: message.message_id,
      raw
    }
  } as const;
}

function isFeishuAudioMessage(raw: unknown): raw is FeishuAudioMessageEvent {
  const message = (raw as FeishuAudioMessageEvent | undefined)?.event?.message;
  return message?.message_type === "audio" || message?.msg_type === "audio";
}

function parseFeishuAudioContent(content: string): { fileKey?: string } {
  try {
    const parsed = JSON.parse(content) as { file_key?: unknown; fileKey?: unknown };
    const fileKey = typeof parsed.file_key === "string" ? parsed.file_key : typeof parsed.fileKey === "string" ? parsed.fileKey : undefined;
    return { fileKey };
  } catch {
    return {};
  }
}

function normalizeLifecycleEvent(
  kind: "reaction.created" | "reaction.deleted" | "message.read" | "message.recalled",
  raw: unknown,
  time = createCurrentTimeProvider("UTC")
): FeishuMessageLifecycleEvent {
  if (kind === "reaction.created" || kind === "reaction.deleted") {
    return reactionEventToLifecycleEvent(raw, kind, time);
  }
  if (kind === "message.read") {
    return readEventToLifecycleEvent(raw, time);
  }
  return recalledEventToLifecycleEvent(raw, time);
}

export { renderForFeishu } from "./renderer.js";
export { textMessageEventToAgentEvent } from "./handlers/message.js";
export type { FeishuMessageLifecycleEvent, FeishuSendPlan, FeishuTextMessageEvent } from "./types.js";
