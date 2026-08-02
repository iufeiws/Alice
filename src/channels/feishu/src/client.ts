import type { FeishuConfig } from "./types.js";
import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { FeishuAgentRunCardBlock, FeishuAgentRunCardBlocks, FeishuCardActionEvent, FeishuDynamicCardClient, FeishuInboundResourceType, FeishuReactionClient, FeishuSendResult, FeishuStoredAudioAsset, FeishuToolExecutionCardBlock, FeishuToolExecutionPanel } from "./types.js";

const FEISHU_CARD_MAX_BYTES = 30 * 1024;

const AGENT_RUN_CARD_ELEMENT_IDS: Record<FeishuAgentRunCardBlock, string> = {
  state: "agent_run_state",
  reasoning: "agent_run_reasoning",
  content: "agent_run_content",
  tools: "agent_run_tools"
};
const TOOL_EXECUTION_CARD_ELEMENT_IDS = {
  title: "tool_execution_title",
  call: "tool_execution_call",
  result: "tool_execution_result"
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
  downloadMessageResource(input: { messageId: string; fileKey: string; type: FeishuInboundResourceType; filePath: string }): Promise<void>;
} & FeishuReactionClient & FeishuDynamicCardClient;

export type FeishuClientDeps = {
  onMessage(data: unknown): Promise<void>;
  onLifecycle?(kind: "reaction.created" | "reaction.deleted" | "message.read" | "message.recalled", data: unknown): Promise<void>;
  onCardAction?(event: FeishuCardActionEvent): Promise<unknown>;
  log?(level: "info" | "warn" | "error", message: string): void;
  time?: CurrentTimeProvider;
};

type LarkModule = {
  Client: new (config: Record<string, unknown>) => any;
  WSClient: new (config: Record<string, unknown>) => any;
  EventDispatcher: new (config: Record<string, unknown>) => { register(handlers: Record<string, (data: any) => Promise<unknown>>): unknown };
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
        },
        "card.action.trigger": async (data: any) => {
          const event = normalizeFeishuCardActionEvent(data);
          deps.log?.("info", `[feishu] received card.action.trigger ${event.messageId}`);
          return await deps.onCardAction?.(event);
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
    async downloadMessageResource(input) {
      assertStarted(client);
      fs.mkdirSync(path.dirname(input.filePath), { recursive: true });
      const resource = await client.im.v1.messageResource.get({
        path: {
          message_id: input.messageId,
          file_key: input.fileKey
        },
        params: {
          type: input.type
        }
      });
      if (!resource?.writeFile) throw new Error(`Feishu ${input.type} resource download did not return writeFile`);
      await resource.writeFile(input.filePath);
      deps.log?.("info", `[feishu] downloaded ${input.type} ${input.messageId} to ${input.filePath}`);
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
    async createApprovalCard(input) {
      assertStarted(client);
      const cardJson = serializeFeishuApprovalCard(input);
      const card = await client.cardkit.v1.card.create({
        data: { type: "card_json", data: cardJson }
      });
      const cardId = requireFeishuCardId(card, "Feishu approval card create");
      const message = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "interactive",
        content: { type: "card", data: { card_id: cardId } }
      }, time);
      if (!message.messageId) throw new Error("Feishu approval card message create did not return message_id");
      deps.log?.("info", `[feishu] created approval card ${cardId} for ${input.receiveIdType}:${input.receiveId}`);
      return { messageId: message.messageId, cardId };
    },
    async deleteMessage(input) {
      assertStarted(client);
      const result = await client.im.v1.message.delete({ path: { message_id: input.messageId } });
      if (result?.code && result.code !== 0) throw new Error(`Feishu message delete failed (code=${result.code} msg=${result.msg ?? "unknown"})`);
      deps.log?.("info", `[feishu] deleted message ${input.messageId}`);
    },
    async createAgentRunCard(input) {
      assertStarted(client);
      const card = await client.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(buildAgentRunCard(input.blocks))
        }
      });
      const cardId = requireFeishuCardId(card, "Feishu cardkit card create");
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
    async updateAgentRunCardBlocks(input) {
      assertStarted(client);
      const actions = (Object.keys(input.blocks) as FeishuAgentRunCardBlock[]).map((block) => ({
        action: "partial_update_element",
        params: {
          element_id: AGENT_RUN_CARD_ELEMENT_IDS[block],
          partial_element: { content: cardMarkdownContent(input.blocks[block] ?? "") }
        }
      }));
      await client.cardkit.v1.card.batchUpdate({
        path: {
          card_id: input.cardId
        },
        data: {
          actions: JSON.stringify(actions),
          sequence: input.sequence,
          uuid: `agent_run_blocks_${input.cardId}_${input.sequence}`
        }
      });
      deps.log?.("info", `[feishu] batch updated agent run card ${input.cardId} blocks=${Object.keys(input.blocks).join(",")} sequence=${input.sequence}`);
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
    async createToolExecutionCard(input) {
      assertStarted(client);
      const card = await client.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(buildToolExecutionCard(input.toolName, input.call, input.result, {
            titleElementId: input.titleElementId ?? TOOL_EXECUTION_CARD_ELEMENT_IDS.title,
            callElementId: input.callElementId ?? TOOL_EXECUTION_CARD_ELEMENT_IDS.call,
            resultElementId: input.resultElementId ?? TOOL_EXECUTION_CARD_ELEMENT_IDS.result
          }))
        }
      });
      const cardId = requireFeishuCardId(card, "Feishu cardkit tool execution card create");
      const message = await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "interactive",
        content: {
          type: "card",
          data: { card_id: cardId }
        }
      }, time);
      if (!message.messageId) throw new Error("Feishu tool execution card message create did not return message_id");
      deps.log?.("info", `[feishu] created tool execution card ${cardId} for ${input.receiveIdType}:${input.receiveId}`);
      return {
        messageId: message.messageId,
        cardId
      };
    },
    async groupToolExecutionCard(input) {
      assertStarted(client);
      await client.cardkit.v1.cardElement.update({
        path: {
          card_id: input.cardId,
          element_id: input.rootElementId
        },
        data: {
          element: JSON.stringify(buildToolExecutionGroup(input.panels, input.rootElementId)),
          sequence: input.sequence,
          uuid: `tool_execution_group_${input.cardId}_${input.sequence}`
        }
      });
      deps.log?.("info", `[feishu] grouped ${input.panels.length} tool execution panels ${input.cardId} sequence=${input.sequence}`);
    },
    async updateToolExecutionCard(input) {
      assertStarted(client);
      if (input.block === "title") {
        await client.cardkit.v1.cardElement.patch({
          path: {
            card_id: input.cardId,
            element_id: input.elementId
          },
          data: {
            partial_element: JSON.stringify({
              header: {
                title: {
                  tag: "plain_text",
                  content: input.content
                }
              }
            }),
            sequence: input.sequence,
            uuid: `tool_execution_${input.block}_${input.cardId}_${input.sequence}`
          }
        });
      } else {
        await client.cardkit.v1.cardElement.content({
          path: {
            card_id: input.cardId,
            element_id: input.elementId
          },
          data: {
            content: cardMarkdownContent(input.content),
            sequence: input.sequence,
            uuid: `tool_execution_${input.block}_${input.cardId}_${input.sequence}`
          }
        });
      }
      deps.log?.("info", `[feishu] updated tool execution card ${input.cardId} block=${input.block} sequence=${input.sequence}`);
    },
    async setToolExecutionCardStreaming(input) {
      assertStarted(client);
      await client.cardkit.v1.card.settings({
        path: {
          card_id: input.cardId
        },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: input.enabled } }),
          sequence: input.sequence,
          uuid: `tool_execution_streaming_${input.cardId}_${input.sequence}`
        }
      });
      deps.log?.("info", `[feishu] set tool execution card ${input.cardId} streaming=${input.enabled} sequence=${input.sequence}`);
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

export function buildFeishuApprovalCard(input: { requestId: string; title: string; content: string }): Record<string, unknown> {
  const button = (decision: "approved" | "rejected", text: string, type: "primary" | "danger") => ({
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    action_type: "form_submit",
    value: { kind: "approval", requestId: input.requestId, decision }
  });
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: input.title },
      template: "blue"
    },
    body: {
      elements: [
        { tag: "markdown", content: cardMarkdownContent(input.content) },
        {
          tag: "form",
          name: "approval_form",
          elements: [
            {
              tag: "input",
              name: "comment",
              input_type: "multiline_text",
              rows: 3,
              max_length: 1000,
              required: false,
              placeholder: { tag: "plain_text", content: "可填写审批意见" }
            },
            {
              tag: "column_set",
              horizontal_spacing: "8px",
              columns: [
                { tag: "column", width: "auto", elements: [button("approved", "同意", "primary")] },
                { tag: "column", width: "auto", elements: [button("rejected", "不同意", "danger")] }
              ]
            }
          ]
        }
      ]
    }
  };
}

export function requireFeishuCardId(card: any, operation: string): string {
  const cardId = card?.data?.card_id ?? card?.card_id;
  if (cardId) return cardId;
  const detail = [card?.code === undefined ? "" : `code=${card.code}`, card?.msg ? `msg=${card.msg}` : ""].filter(Boolean).join(" ");
  throw new Error(`${operation} did not return card_id${detail ? ` (${detail})` : ""}`);
}

export function serializeFeishuApprovalCard(input: { requestId: string; title: string; content: string }): string {
  const cardJson = JSON.stringify(buildFeishuApprovalCard(input));
  if (Buffer.byteLength(cardJson, "utf8") > FEISHU_CARD_MAX_BYTES) throw new Error("Feishu approval card exceeds 30 KB");
  return cardJson;
}

export function normalizeFeishuCardActionEvent(data: any): FeishuCardActionEvent {
  return {
    messageId: String(data?.context?.open_message_id ?? data?.open_message_id ?? ""),
    chatId: stringOrUndefined(data?.context?.open_chat_id ?? data?.open_chat_id),
    operatorOpenId: String(data?.operator?.open_id ?? data?.open_id ?? ""),
    value: data?.action?.value,
    formValue: isRecord(data?.action?.form_value) ? data.action.form_value : {}
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
        },
        {
          tag: "hr"
        },
        {
          tag: "markdown",
          element_id: AGENT_RUN_CARD_ELEMENT_IDS.tools,
          content: cardMarkdownContent(blocks.tools)
        }
      ]
    }
  };
}

export function buildToolExecutionCard(toolName: string, call: string, result: string, ids = {
  titleElementId: TOOL_EXECUTION_CARD_ELEMENT_IDS.title,
  callElementId: TOOL_EXECUTION_CARD_ELEMENT_IDS.call,
  resultElementId: TOOL_EXECUTION_CARD_ELEMENT_IDS.result
}): Record<string, unknown> {
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
        buildToolExecutionPanel(toolName, call, result, ids)
      ]
    }
  };
}

export function buildToolExecutionGroup(panels: FeishuToolExecutionPanel[], rootElementId: string): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    element_id: rootElementId,
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: `Tool Calls [${panels.length}]`
      }
    },
    elements: panels.map((panel) => buildToolExecutionPanel(panel.toolName, panel.call, panel.result, panel, panel.state))
  };
}

function buildToolExecutionPanel(toolName: string, call: string, result: string, ids: { titleElementId: string; callElementId: string; resultElementId: string }, state: "running" | "finished" | "failed" = "running"): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    element_id: ids.titleElementId,
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: `${toolName}: ${state}`
      }
    },
    elements: [
      {
        tag: "markdown",
        element_id: ids.callElementId,
        content: cardMarkdownContent(call)
      },
      {
        tag: "markdown",
        element_id: ids.resultElementId,
        content: cardMarkdownContent(result)
      }
    ]
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
