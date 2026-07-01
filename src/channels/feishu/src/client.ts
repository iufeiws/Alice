import type { FeishuConfig } from "./types.js";
import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { FeishuAgentRunCardBlock, FeishuAgentRunCardBlocks, FeishuBashRunCardBlock, FeishuDynamicCardClient, FeishuReactionClient, FeishuSendResult, FeishuStoredAudioAsset } from "./types.js";

const AGENT_RUN_CARD_ELEMENT_IDS: Record<FeishuAgentRunCardBlock, string> = {
  state: "agent_run_state",
  reasoning: "agent_run_reasoning",
  content: "agent_run_content"
};
const BASH_RUN_CARD_ELEMENT_IDS: Record<FeishuBashRunCardBlock, string> = {
  content: "bash_run_content"
};
const fs = await import("node:fs");
const path = await import("node:path");

export type FeishuClient = {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; text: string }): Promise<FeishuSendResult>;
  sendMarkdown(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; markdown: string }): Promise<FeishuSendResult>;
  sendImage(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; assetId: string }): Promise<FeishuSendResult>;
  sendAudio(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; assetId: string; duration?: number; filename?: string }): Promise<FeishuSendResult>;
  sendFile(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; assetId: string; filename: string }): Promise<FeishuSendResult>;
  downloadAudioResource(input: { messageId: string; fileKey: string }): Promise<FeishuStoredAudioAsset>;
} & FeishuReactionClient & FeishuDynamicCardClient;

export type FeishuClientDeps = {
  onMessage(data: unknown): Promise<void>;
  onLifecycle?(kind: "reaction.created" | "reaction.deleted" | "message.read" | "message.recalled", data: unknown): Promise<void>;
  log?(level: "info" | "warn" | "error", message: string): void;
  time?: CurrentTimeProvider;
};

type LarkModule = {
  Client: new (config: Record<string, unknown>) => any;
  WSClient: new (config: Record<string, unknown>) => any;
  EventDispatcher: new (config: Record<string, unknown>) => { register(handlers: Record<string, (data: any) => Promise<void>>): unknown };
  LoggerLevel?: Record<string, unknown>;
  Domain?: Record<string, unknown>;
};

export function createFeishuClient(config: FeishuConfig, deps: FeishuClientDeps): FeishuClient {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  let client: any;
  let wsClient: any;
  let lark: LarkModule | undefined;
  let started = false;

  return {
    isStarted() {
      return started && Boolean(client);
    },
    async start() {
      if (!config.enabled) return;
      if (started) {
        deps.log?.("info", "[feishu] websocket client already started");
        return;
      }
      if (config.connectionMode !== "websocket") {
        throw new Error("Only Feishu websocket mode is planned for the first implementation");
      }

      const account = config.accounts.main ?? Object.values(config.accounts)[0];
      if (!account?.appId || !account.appSecret) {
        throw new Error("Feishu appId/appSecret are required");
      }

      lark = await import("@larksuiteoapi/node-sdk") as unknown as LarkModule;
      const baseConfig = {
        appId: account.appId,
        appSecret: account.appSecret
      };

      client = new lark.Client(baseConfig);
      wsClient = new lark.WSClient({
        ...baseConfig,
        loggerLevel: lark.LoggerLevel?.info,
        autoReconnect: true
      });

      const eventDispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          deps.log?.("info", `[feishu] received im.message.receive_v1 ${data?.message?.message_id ?? ""}`);
          await deps.onMessage(wrapLarkMessageEvent(data, time));
        },
        "im.message.reaction.created_v1": async (data: any) => {
          deps.log?.("info", `[feishu] received im.message.reaction.created_v1 ${data?.message_id ?? data?.message?.message_id ?? ""}`);
          await deps.onLifecycle?.("reaction.created", data);
        },
        "im.message.reaction.deleted_v1": async (data: any) => {
          deps.log?.("info", `[feishu] received im.message.reaction.deleted_v1 ${data?.message_id ?? data?.message?.message_id ?? ""}`);
          await deps.onLifecycle?.("reaction.deleted", data);
        },
        "im.message.message_read_v1": async (data: any) => {
          deps.log?.("info", `[feishu] received im.message.message_read_v1 ${data?.message_id ?? data?.message?.message_id ?? ""}`);
          await deps.onLifecycle?.("message.read", data);
        },
        "im.message.recalled_v1": async (data: any) => {
          deps.log?.("info", `[feishu] received im.message.recalled_v1 ${data?.message_id ?? data?.message?.message_id ?? ""}`);
          await deps.onLifecycle?.("message.recalled", data);
        }
      });

      wsClient.start({ eventDispatcher });
      started = true;
      deps.log?.("info", "[feishu] websocket client started");
    },
    async stop() {
      if (!config.enabled) return;
      if (!started) {
        deps.log?.("info", "[feishu] websocket client already stopped");
        return;
      }
      if (wsClient?.close) {
        wsClient.close();
      }
      wsClient = undefined;
      started = false;
      deps.log?.("info", "[feishu] websocket client stopped");
    },
    async sendText(input) {
      const result = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "text",
        content: { text: input.text }
      }, time);
      deps.log?.("info", `[feishu] sent text to ${input.receiveIdType}:${input.receiveId}`);
      return result;
    },
    async sendMarkdown(input) {
      const result = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "interactive",
        content: buildMarkdownCard(input.markdown)
      }, time);
      deps.log?.("info", `[feishu] sent markdown card to ${input.receiveIdType}:${input.receiveId}`);
      return result;
    },
    async sendImage(input) {
      assertStarted(client);
      const imagePath = resolveAssetPath(input.assetId);
      const uploaded = await client.im.v1.image.create({
        data: {
          image_type: "message",
          image: fs.createReadStream(imagePath)
        }
      });
      const imageKey = uploaded?.image_key;
      if (!imageKey) throw new Error("Feishu image upload did not return image_key");

      const result = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "image",
        content: { image_key: imageKey }
      }, time);
      deps.log?.("info", `[feishu] sent image ${path.basename(imagePath)} to ${input.receiveIdType}:${input.receiveId}`);
      return result;
    },
    async sendAudio(input) {
      const audioPath = resolveAssetPath(input.assetId);
      const uploaded = await uploadFile(client, {
        filePath: audioPath,
        fileType: "opus",
        fileName: input.filename ?? path.basename(audioPath),
        duration: input.duration
      });

      const result = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "audio",
        content: { file_key: uploaded }
      }, time);
      deps.log?.("info", `[feishu] sent audio ${path.basename(audioPath)} to ${input.receiveIdType}:${input.receiveId}`);
      return result;
    },
    async sendFile(input) {
      const filePath = resolveAssetPath(input.assetId);
      const uploaded = await uploadFile(client, {
        filePath,
        fileType: "stream",
        fileName: input.filename
      });

      const result = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "file",
        content: { file_key: uploaded }
      }, time);
      deps.log?.("info", `[feishu] sent file ${input.filename} to ${input.receiveIdType}:${input.receiveId}`);
      return result;
    },
    async downloadAudioResource(input) {
      assertStarted(client);
      const filename = `${safeFileName(input.messageId)}.opus`;
      const assetId = path.join("plugin", "feishu", "audio", filename);
      const filePath = resolveWritableAssetPath(assetId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const resource = await client.im.v1.messageResource.get({
        path: {
          message_id: input.messageId,
          file_key: input.fileKey
        },
        params: {
          type: "file"
        }
      });
      if (!resource?.writeFile) throw new Error("Feishu audio resource download did not return writeFile");
      await resource.writeFile(filePath);
      deps.log?.("info", `[feishu] downloaded audio ${input.messageId} to ${assetId}`);
      return {
        assetId,
        filePath,
        filename,
        mimeType: "audio/opus"
      };
    },
    async addReaction(input) {
      assertStarted(client);
      const result = await client.im.v1.messageReaction.create({
        path: {
          message_id: input.messageId
        },
        data: {
          reaction_type: {
            emoji_type: input.emojiType
          }
        }
      });
      const reactionId = result?.reaction_id ?? result?.data?.reaction_id;
      deps.log?.("info", `[feishu] added ${input.emojiType} reaction to ${input.messageId}`);
      return { reactionId };
    },
    async removeReaction(input) {
      assertStarted(client);
      await client.im.v1.messageReaction.delete({
        path: {
          message_id: input.messageId,
          reaction_id: input.reactionId
        }
      });
      deps.log?.("info", `[feishu] removed reaction ${input.reactionId} from ${input.messageId}`);
    },
    async createAgentRunCard(input) {
      assertStarted(client);
      const card = await client.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(buildAgentRunCard(input.blocks))
        }
      });
      const cardId = card?.data?.card_id ?? card?.card_id;
      if (!cardId) throw new Error("Feishu cardkit card create did not return card_id");
      const message = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "interactive",
        content: {
          type: "card",
          data: { card_id: cardId }
        }
      }, time);
      if (!message.messageId) throw new Error("Feishu agent run card message create did not return message_id");
      deps.log?.("info", `[feishu] created agent run card ${cardId} for ${input.receiveIdType}:${input.receiveId}`);
      return {
        messageId: message.messageId,
        cardId
      };
    },
    async updateAgentRunCard(input) {
      assertStarted(client);
      await client.cardkit.v1.cardElement.content({
        path: {
          card_id: input.cardId,
          element_id: AGENT_RUN_CARD_ELEMENT_IDS[input.block]
        },
        data: {
          content: cardMarkdownContent(input.content),
          sequence: input.sequence,
          uuid: `agent_run_${input.block}_${input.cardId}_${input.sequence}`
        }
      });
    },
    async setAgentRunCardStreaming(input) {
      assertStarted(client);
      await client.cardkit.v1.card.settings({
        path: {
          card_id: input.cardId
        },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: input.enabled } }),
          sequence: input.sequence,
          uuid: `agent_run_streaming_${input.cardId}_${input.sequence}`
        }
      });
      deps.log?.("info", `[feishu] set agent run card ${input.cardId} streaming=${input.enabled} sequence=${input.sequence}`);
    },
    async resolveAgentRunCardId(input) {
      assertStarted(client);
      const converted = await client.cardkit.v1.card.idConvert({
        data: {
          message_id: input.messageId
        }
      });
      return {
        cardId: converted?.data?.card_id ?? converted?.card_id
      };
    },
    async createBashRunCard(input) {
      assertStarted(client);
      const card = await client.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(buildBashRunCard(input.command, input.content))
        }
      });
      const cardId = card?.data?.card_id ?? card?.card_id;
      if (!cardId) throw new Error("Feishu cardkit bash card create did not return card_id");
      const message = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "interactive",
        content: {
          type: "card",
          data: { card_id: cardId }
        }
      }, time);
      if (!message.messageId) throw new Error("Feishu bash card message create did not return message_id");
      deps.log?.("info", `[feishu] created bash run card ${cardId} for ${input.receiveIdType}:${input.receiveId}`);
      return {
        messageId: message.messageId,
        cardId
      };
    },
    async updateBashRunCard(input) {
      assertStarted(client);
      await client.cardkit.v1.cardElement.content({
        path: {
          card_id: input.cardId,
          element_id: BASH_RUN_CARD_ELEMENT_IDS[input.block]
        },
        data: {
          content: cardMarkdownContent(input.content),
          sequence: input.sequence,
          uuid: `bash_run_${input.block}_${input.cardId}_${input.sequence}`
        }
      });
      deps.log?.("info", `[feishu] updated bash run card ${input.cardId} block=${input.block} sequence=${input.sequence}`);
    },
    async setBashRunCardStreaming(input) {
      assertStarted(client);
      await client.cardkit.v1.card.settings({
        path: {
          card_id: input.cardId
        },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: input.enabled } }),
          sequence: input.sequence,
          uuid: `bash_run_streaming_${input.cardId}_${input.sequence}`
        }
      });
      deps.log?.("info", `[feishu] set bash run card ${input.cardId} streaming=${input.enabled} sequence=${input.sequence}`);
    }
  };
}

function assertStarted(client: any): void {
  if (!client) {
    throw new Error("Feishu client is not started");
  }
}

async function sendMessage(
  client: any,
  input: {
    receiveIdType: "chat_id" | "open_id";
    receiveId: string;
    msgType: string;
    content: Record<string, unknown>;
  },
  time: CurrentTimeProvider
): Promise<FeishuSendResult> {
  assertStarted(client);
  const result = await client.im.v1.message.create({
    params: {
      receive_id_type: input.receiveIdType
    },
    data: {
      receive_id: input.receiveId,
      content: JSON.stringify(input.content),
      msg_type: input.msgType
    }
  });
  return {
    messageId: result?.message_id ?? result?.data?.message_id,
    createdAt: normalizeFeishuTimestamp(result?.create_time ?? result?.data?.create_time, time),
    createdAtUtc: normalizeFeishuTimestampUtc(result?.create_time ?? result?.data?.create_time)
  };
}

function normalizeFeishuTimestamp(value: unknown, time: CurrentTimeProvider): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  if (!/^\d+$/.test(text)) return undefined;
  return time.addMs(0, new Date(Number(text))).iso;
}

function normalizeFeishuTimestampUtc(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  if (!/^\d+$/.test(text)) return undefined;
  return new Date(Number(text)).toISOString();
}

async function uploadFile(
  client: any,
  input: {
    filePath: string;
    fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
    fileName: string;
    duration?: number;
  }
): Promise<string> {
  assertStarted(client);
  const uploaded = await client.im.v1.file.create({
    data: {
      file_type: input.fileType,
      file_name: input.fileName,
      duration: input.duration,
      file: fs.createReadStream(input.filePath)
    }
  });
  const fileKey = uploaded?.file_key;
  if (!fileKey) throw new Error("Feishu file upload did not return file_key");
  return fileKey;
}

function buildMarkdownCard(markdown: string): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true
    },
    elements: [
      {
        tag: "markdown",
        content: markdown
      }
    ]
  };
}

function buildAgentRunCard(blocks: FeishuAgentRunCardBlocks): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast"
      }
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: AGENT_RUN_CARD_ELEMENT_IDS.state,
          text_align: "center",
          content: cardMarkdownContent(blocks.state)
        },
        {
          tag: "hr"
        },
        {
          tag: "markdown",
          element_id: AGENT_RUN_CARD_ELEMENT_IDS.reasoning,
          content: cardMarkdownContent(blocks.reasoning)
        },
        {
          tag: "hr"
        },
        {
          tag: "markdown",
          element_id: AGENT_RUN_CARD_ELEMENT_IDS.content,
          content: cardMarkdownContent(blocks.content)
        }
      ]
    }
  };
}

export function buildBashRunCard(command: string, content: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast"
      }
    },
    header: {
      title: {
        tag: "plain_text",
        content: command
      }
    },
    body: {
      elements: [
        {
          tag: "hr"
        },
        {
          tag: "collapsible_panel",
          expanded: true,
          header: {
            title: {
              tag: "plain_text",
              content: "output"
            }
          },
          elements: [
            {
              tag: "div",
              style: {
                max_height: "360px",
                overflow: "auto"
              },
              elements: [
                {
                  tag: "markdown",
                  element_id: BASH_RUN_CARD_ELEMENT_IDS.content,
                  content: cardMarkdownContent(content)
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

function cardMarkdownContent(value: string): string {
  return value.length > 0 ? value : " ";
}

function resolveAssetPath(assetId: string): string {
  if (assetId.startsWith("file://")) {
    throw new Error("Feishu asset paths must be local project asset paths");
  }
  const assetRoot = path.resolve("assets");
  const filePath = path.isAbsolute(assetId) ? assetId : path.resolve(assetRoot, assetId);
  const relative = path.relative(assetRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Feishu asset path is outside assets directory");
  }
  return filePath;
}

function resolveWritableAssetPath(assetId: string): string {
  const assetRoot = path.resolve("assets");
  const filePath = path.resolve(assetRoot, assetId);
  const relative = path.relative(assetRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Feishu asset path is outside assets directory");
  }
  return filePath;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "audio";
}

function wrapLarkMessageEvent(data: any, time: CurrentTimeProvider): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: data?.event_id,
      create_time: data?.message?.create_time ?? time.now().epochMs.toString()
    },
    event: {
      message: {
        message_id: data?.message?.message_id,
        chat_id: data?.message?.chat_id,
        chat_type: data?.message?.chat_type,
        message_type: data?.message?.message_type,
        msg_type: data?.message?.msg_type,
        content: data?.message?.content,
        mentions: data?.message?.mentions,
        thread_id: data?.message?.thread_id
      },
      sender: {
        sender_id: data?.sender?.sender_id ?? {}
      }
    }
  };
}
