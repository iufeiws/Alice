import type { FeishuConfig } from "../../../packages/config/src/index.js";
import type { AgentOutput, ChannelPlugin } from "../../../packages/types/src/index.js";
import { createInMemoryFeishuBindingStore } from "./bindings.js";
import { isFeishuConfigured } from "./config.js";
import { createFeishuMonitor } from "./monitor.js";
import { checkFeishuEventPolicy } from "./policy.js";
import { renderForFeishu } from "./renderer.js";
import type { FeishuPluginDeps, FeishuTextMessageEvent } from "./types.js";
import { textMessageEventToAgentEvent } from "./handlers/message.js";
import { getPairingCommand, isPairingCommand } from "./pairing.js";
import { createRecentMessageDeduper } from "./dedupe.js";

export function createFeishuPlugin(config: FeishuConfig, deps: FeishuPluginDeps): ChannelPlugin & {
  ingestTextMessage(raw: FeishuTextMessageEvent): Promise<void>;
} {
  const bindings = createInMemoryFeishuBindingStore();
  const deduper = createRecentMessageDeduper();
  const monitor = createFeishuMonitor(config, {
    log: deps.log,
    async onMessage(raw) {
      await receiveTextMessage(raw as FeishuTextMessageEvent);
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
        await deps.outbound.send(plan);
        return;
      }

      if (plan.kind === "text") {
        await monitor.sendText({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          text: plan.text
        });
        return;
      }

      if (plan.kind === "markdown") {
        await monitor.sendMarkdown({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          markdown: plan.markdown
        });
        return;
      }

      if (plan.kind === "image") {
        await monitor.sendImage({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          assetId: plan.assetId
        });
        return;
      }

      if (plan.kind === "audio") {
        await monitor.sendAudio({
          receiveIdType: plan.receiveIdType,
          receiveId: plan.receiveId,
          assetId: plan.assetId,
          duration: plan.duration,
          filename: plan.filename
        });
        return;
      }

      await monitor.sendFile({
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

  async function receiveTextMessage(raw: FeishuTextMessageEvent): Promise<void> {
    try {
      const event = await textMessageEventToAgentEvent(raw, bindings);
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
              createdAt: new Date().toISOString(),
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
            createdAt: new Date().toISOString(),
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

export { renderForFeishu } from "./renderer.js";
export { textMessageEventToAgentEvent } from "./handlers/message.js";
export type { FeishuSendPlan, FeishuTextMessageEvent } from "./types.js";
