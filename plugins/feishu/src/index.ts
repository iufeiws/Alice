import type { FeishuConfig } from "../../../packages/config/src/index.js";
import type { AgentOutput, ChannelPlugin } from "../../../packages/types/src/index.js";
import { createInMemoryFeishuBindingStore, type FeishuBindingStore } from "./bindings.js";
import { isFeishuConfigured } from "./config.js";
import { createFeishuMonitor } from "./monitor.js";
import { checkFeishuEventPolicy } from "./policy.js";
import { renderForFeishu } from "./renderer.js";
import type { FeishuAudioMessageEvent, FeishuMessageLifecycleEvent, FeishuPluginDeps, FeishuTextMessageEvent } from "./types.js";
import { textMessageEventToAgentEvent } from "./handlers/message.js";
import { reactionEventToLifecycleEvent, readEventToLifecycleEvent, recalledEventToLifecycleEvent } from "./handlers/lifecycle.js";
import { getPairingCommand, isPairingCommand } from "./pairing.js";
import { createRecentMessageDeduper } from "./dedupe.js";
import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../../core/time/src/index.js";
import { createId } from "../../../packages/types/src/index.js";

export function createFeishuPlugin(config: FeishuConfig, deps: FeishuPluginDeps): ChannelPlugin & {
  ingestTextMessage(raw: FeishuTextMessageEvent): Promise<void>;
  ingestAudioMessage(raw: FeishuAudioMessageEvent): Promise<void>;
} {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const bindings = createInMemoryFeishuBindingStore();
  const deduper = createRecentMessageDeduper();
  const monitor = createFeishuMonitor(config, {
    log: deps.log,
    time,
    async onMessage(raw) {
      if (isFeishuAudioMessage(raw)) {
        await receiveAudioMessage(raw);
        return;
      }
      await receiveTextMessage(raw as FeishuTextMessageEvent);
    },
    async onLifecycle(kind, raw) {
      await receiveLifecycleEvent(kind, raw);
    }
  });

  const plugin = {
    id: "feishu",
    async start() {
      if (!isFeishuConfigured(config)) {
        deps.log?.("warn", "[feishu] disabled or missing credentials");
        return;
      }
      await monitor.start();
    },
    async stop() {
      await monitor.stop();
    },
    async send(output: AgentOutput) {
      const plan = renderForFeishu(output);
      if (deps.outbound) {
        return deps.outbound.send(plan);
      }

      if (plan.kind === "text") {
        return monitor.sendText({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          text: plan.text
        });
      }

      if (plan.kind === "markdown") {
        return monitor.sendMarkdown({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          markdown: plan.markdown
        });
      }

      if (plan.kind === "image") {
        return monitor.sendImage({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          assetId: plan.assetId
        });
      }

      if (plan.kind === "audio") {
        return monitor.sendAudio({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          assetId: plan.assetId,
          duration: plan.duration,
          filename: plan.filename
        });
      }

      return monitor.sendFile({
        receiveIdType: plan.receiveIdType,
        receiveId: plan.receiveId,
        assetId: plan.assetId,
        filename: plan.filename
      });
    },
    async ingestTextMessage(raw: FeishuTextMessageEvent) {
      await receiveTextMessage(raw);
    },
    async ingestAudioMessage(raw: FeishuAudioMessageEvent) {
      await receiveAudioMessage(raw);
    }
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

  async function receiveTextMessage(raw: FeishuTextMessageEvent): Promise<void> {
    try {
      const event = await textMessageEventToAgentEvent(raw, bindings, "main", time);
      deps.log?.("info", `[feishu] normalized message ${event.source.rawMessageId ?? event.id}: ${event.payload.kind}`);
      const dedupeKey = event.source.rawMessageId ?? event.id;
      if (!deduper.remember(dedupeKey)) {
        deps.log?.("warn", `[feishu] duplicate message ignored: ${dedupeKey}`);
        return;
      }
      queueTextMessage(event);
    } catch (error) {
      deps.log?.("error", `[feishu] failed to receive message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function receiveAudioMessage(raw: FeishuAudioMessageEvent): Promise<void> {
    try {
      const messageId = raw.event.message.message_id;
      if (!deduper.remember(messageId)) {
        deps.log?.("warn", `[feishu] duplicate message ignored: ${messageId}`);
        return;
      }
      queueAudioMessage(raw);
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

  function queueAudioMessage(raw: FeishuAudioMessageEvent): void {
    Promise.resolve()
      .then(() => handleAudioMessage(raw))
      .catch((error) => {
        deps.log?.("error", `[feishu] failed to process audio message ${raw.event.message.message_id}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  async function handleTextMessage(event: Awaited<ReturnType<typeof textMessageEventToAgentEvent>>): Promise<void> {
      if (isPairingCommand(event, config)) {
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
              sessionId: event.session.sessionId,
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
            sessionId: event.session.sessionId,
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
      if (decision.allowed && config.dmPolicy === "pairing" && event.session.scope === "dm" && !deps.pairingStore?.isPaired(event)) {
        deps.log?.("warn", `[feishu] ignored event: pairing required, command=${getPairingCommand(config)}`);
        return;
      }
      if (!decision.allowed) {
        deps.log?.("warn", `[feishu] ignored event: ${decision.reason ?? "policy denied"}`);
        return;
      }
      await deps.onEvent(event);
  }

  async function handleAudioMessage(raw: FeishuAudioMessageEvent): Promise<void> {
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
      : await monitor.downloadAudioResource({
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

    const transcript = asrResult.text.trim();
    if (!transcript) {
      deps.log?.("warn", `[feishu] ignored audio ${raw.event.message.message_id}: asr empty_transcription`);
      return;
    }

    const event = await audioMessageEventToAgentEvent(raw, stored.assetId, transcript, bindings, time);
    const decision = checkFeishuEventPolicy(config, event);
    if (decision.allowed && config.dmPolicy === "pairing" && event.session.scope === "dm" && !deps.pairingStore?.isPaired(event)) {
      deps.log?.("warn", `[feishu] ignored event: pairing required, command=${getPairingCommand(config)}`);
      return;
    }
    if (!decision.allowed) {
      deps.log?.("warn", `[feishu] ignored event: ${decision.reason ?? "policy denied"}`);
      return;
    }
    await deps.onEvent(event);
  }

  return plugin;
}

async function audioMessageEventToAgentEvent(
  raw: FeishuAudioMessageEvent,
  assetId: string,
  transcript: string,
  bindings: FeishuBindingStore,
  time: CurrentTimeProvider
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
      accountId: "main",
      channelId: message.chat_id,
      userId,
      rawMessageId: message.message_id
    },
    session: {
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
