import type { AgentEvent, AgentOutput, ChannelPlugin } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import { createCurrentTimeProvider } from "../../../core/time/src/index.js";
import { createWeChatILinkClient } from "./client.js";
import type { WeChatConfig, WeChatPluginDeps, WeChatTextMessage } from "./types.js";

export function createWeChatPlugin(config: WeChatConfig, deps: WeChatPluginDeps): ChannelPlugin & {
  ingestTextMessage(raw: WeChatTextMessage): Promise<void>;
  setTyping(input: { userId?: string; sessionId?: string; typing: boolean }): Promise<void>;
} {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const sleep = deps.sleep ?? delay;
  const client = createWeChatILinkClient(config, { fetch: deps.fetch });
  const typingTickets = new Map<string, { ticket: string; expiresAtMs: number }>();
  let stopped = true;
  let pollLoop: Promise<void> | undefined;

  const plugin = {
    id: "wechat",
    async start() {
      if (!config.enabled || !config.botToken) {
        deps.log?.("warn", "[wechat] disabled or not logged in");
        return;
      }
      if (!stopped) return;
      stopped = false;
      pollLoop = runPollLoop();
    },
    async stop() {
      stopped = true;
      await pollLoop;
      pollLoop = undefined;
    },
    async send(output: AgentOutput) {
      const toUserId = output.target.userId ?? output.target.channelId;
      if (!toUserId) throw new Error("missing WeChat user id");
      const contact = deps.stateStore.getContact(toUserId);
      if (!contact?.contextToken) throw new Error(`missing WeChat context_token for ${toUserId}`);
      if (output.content.kind === "text") {
        return client.sendText({
          toUserId,
          text: output.content.text,
          contextToken: contact.contextToken
        });
      }
      if (output.content.kind === "image") {
        return client.sendImage({
          toUserId,
          assetId: output.content.assetId,
          contextToken: contact.contextToken
        });
      }
      if (output.content.kind === "audio") {
        return client.sendAudio({
          toUserId,
          assetId: output.content.assetId,
          contextToken: contact.contextToken,
          transcript: output.content.transcript
        });
      }
      throw new Error(`WeChat iLink send only supports text, image, and audio for now: ${output.content.kind}`);
    },
    async setTyping(input: { userId?: string; sessionId?: string; typing: boolean }) {
      const contact = resolveContact(input);
      if (!contact?.contextToken) throw new Error("missing WeChat context_token for typing");
      const ticket = input.typing ? await getTypingTicket(contact.userId, contact.contextToken) : typingTickets.get(contact.userId)?.ticket;
      if (!ticket) return;
      await client.sendTyping({
        userId: contact.userId,
        typingTicket: ticket,
        status: input.typing ? 1 : 2
      });
      deps.log?.("info", `[wechat] typing ${input.typing ? "started" : "stopped"}: ${contact.sessionId}`);
    },
    async ingestTextMessage(raw: WeChatTextMessage) {
      await receiveTextMessage(raw);
    }
  };

  async function runPollLoop(): Promise<void> {
    deps.log?.("info", "[wechat] iLink poll loop started");
    while (!stopped) {
      try {
        const state = deps.stateStore.load();
        const updates = await client.getUpdates(state.getUpdatesBuf);
        if (updates.nextCursor !== undefined) {
          deps.stateStore.save({ ...state, getUpdatesBuf: updates.nextCursor });
        }
        for (const message of updates.messages) {
          await receiveTextMessage(message);
        }
      } catch (error) {
        deps.log?.("error", `[wechat] poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(5000);
      }
    }
    deps.log?.("info", "[wechat] iLink poll loop stopped");
  }

  async function receiveTextMessage(message: WeChatTextMessage): Promise<void> {
    const event = textMessageToAgentEvent(message);
    deps.stateStore.noteInbound(event, message.contextToken);
    deps.log?.("info", `[wechat] normalized message ${message.id}: text`);
    await deps.onEvent(event);
  }

  function textMessageToAgentEvent(message: WeChatTextMessage): AgentEvent {
    const receivedAt = normalizeReceivedAt(message.createdAt);
    return {
      id: createId("evt"),
      source: {
        plugin: "wechat",
        accountId: "main",
        channelId: message.fromUserId,
        userId: message.fromUserId,
        rawMessageId: message.id
      },
      session: {
        scope: "dm",
        sessionId: `wechat:dm:${message.fromUserId}`
      },
      type: "message.text",
      payload: {
        kind: "text",
        text: message.text
      },
      meta: {
        receivedAt,
        replyTo: message.id,
        raw: message.raw
      }
    };
  }

  function resolveContact(input: { userId?: string; sessionId?: string }) {
    if (input.userId) return deps.stateStore.getContact(input.userId);
    if (!input.sessionId) return undefined;
    return deps.stateStore.listContacts().find((contact) => contact.sessionId === input.sessionId);
  }

  async function getTypingTicket(userId: string, contextToken: string): Promise<string> {
    const cached = typingTickets.get(userId);
    if (cached && cached.expiresAtMs > Date.now()) return cached.ticket;
    const result = await client.getTypingTicket({ userId, contextToken });
    typingTickets.set(userId, {
      ticket: result.typingTicket,
      expiresAtMs: Date.now() + 23 * 60 * 60 * 1000
    });
    return result.typingTicket;
  }

  function normalizeReceivedAt(value: string | undefined): string {
    if (!value) return time.now().iso;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      const milliseconds = asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
      return time.addMs(0, new Date(milliseconds)).iso;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? time.now().iso : time.addMs(0, date).iso;
  }

  return plugin;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { createWeChatStateStore } from "./state.js";
export type { WeChatConfig, WeChatTextMessage } from "./types.js";
