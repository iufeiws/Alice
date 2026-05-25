import type { FeishuConfig } from "../../../packages/config/src/index.js";
import type { AgentOutput, ChannelPlugin } from "../../../packages/types/src/index.js";
import { createInMemoryFeishuBindingStore } from "./bindings.js";
import { isFeishuConfigured } from "./config.js";
import { createFeishuMonitor } from "./monitor.js";
import { checkFeishuEventPolicy } from "./policy.js";
import { renderForFeishu } from "./renderer.js";
import type { FeishuMessageLifecycleEvent, FeishuPluginDeps, FeishuTextMessageEvent } from "./types.js";
import { textMessageEventToAgentEvent } from "./handlers/message.js";
import { reactionEventToLifecycleEvent, readEventToLifecycleEvent, recalledEventToLifecycleEvent } from "./handlers/lifecycle.js";
import { getPairingCommand, isPairingCommand } from "./pairing.js";
import { createRecentMessageDeduper } from "./dedupe.js";
import { createCurrentTimeProvider } from "../../../core/time/src/index.js";

export function createFeishuPlugin(config: FeishuConfig, deps: FeishuPluginDeps): ChannelPlugin & {
  ingestTextMessage(raw: FeishuTextMessageEvent): Promise<void>;
} {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const bindings = createInMemoryFeishuBindingStore();
  const deduper = createRecentMessageDeduper();
  const monitor = createFeishuMonitor(config, {
    log: deps.log,
    time,
    async onMessage(raw) {
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

  function queueTextMessage(event: Awaited<ReturnType<typeof textMessageEventToAgentEvent>>): void {
    Promise.resolve()
      .then(() => handleTextMessage(event))
      .catch((error) => {
        deps.log?.("error", `[feishu] failed to process message ${event.source.rawMessageId ?? event.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  async function handleTextMessage(event: Awaited<ReturnType<typeof textMessageEventToAgentEvent>>): Promise<void> {
      if (isPairingCommand(event, config)) {
        const result = deps.pairingStore?.pairFromEvent(event);
        if (result && !result.ok) {
          deps.log?.("warn", `[feishu] pairing rejected: already bound to ${result.contact.id}`);
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
              createdAt: time.now().iso,
              urgency: "normal"
            }
          });
          return;
        }

        deps.log?.("info", `[feishu] paired unique contact ${result?.contact.id ?? event.source.userId ?? "(unknown)"}`);
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
              createdAt: time.now().iso,
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

  return plugin;
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
