import type { FeishuConfig } from "../../../packages/config/src/index.js";
const fs = await import("node:fs");
const path = await import("node:path");

export type FeishuClient = {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; text: string }): Promise<void>;
  sendMarkdown(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; markdown: string }): Promise<void>;
  sendImage(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; assetId: string }): Promise<void>;
  sendAudio(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; assetId: string; duration?: number; filename?: string }): Promise<void>;
  sendFile(input: { receiveIdType: "chat_id" | "open_id"; receiveId: string; assetId: string; filename: string }): Promise<void>;
};

export type FeishuClientDeps = {
  onMessage(data: unknown): Promise<void>;
  log?(level: "info" | "warn" | "error", message: string): void;
};

type LarkModule = {
  Client: new (config: Record<string, unknown>) => any;
  WSClient: new (config: Record<string, unknown>) => any;
  EventDispatcher: new (config: Record<string, unknown>) => { register(handlers: Record<string, (data: any) => Promise<void>>): unknown };
  LoggerLevel?: Record<string, unknown>;
  Domain?: Record<string, unknown>;
};

export function createFeishuClient(config: FeishuConfig, deps: FeishuClientDeps): FeishuClient {
  let client: any;
  let wsClient: any;
  let lark: LarkModule | undefined;
  let started = false;

  return {
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
          await deps.onMessage(wrapLarkMessageEvent(data));
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
      await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "text",
        content: { text: input.text }
      });
      deps.log?.("info", `[feishu] sent text to ${input.receiveIdType}:${input.receiveId}`);
    },
    async sendMarkdown(input) {
      await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "interactive",
        content: buildMarkdownCard(input.markdown)
      });
      deps.log?.("info", `[feishu] sent markdown card to ${input.receiveIdType}:${input.receiveId}`);
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

      await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "image",
        content: { image_key: imageKey }
      });
      deps.log?.("info", `[feishu] sent image ${path.basename(imagePath)} to ${input.receiveIdType}:${input.receiveId}`);
    },
    async sendAudio(input) {
      const audioPath = resolveAssetPath(input.assetId);
      const uploaded = await uploadFile(client, {
        filePath: audioPath,
        fileType: "opus",
        fileName: input.filename ?? path.basename(audioPath),
        duration: input.duration
      });

      await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "audio",
        content: { file_key: uploaded }
      });
      deps.log?.("info", `[feishu] sent audio ${path.basename(audioPath)} to ${input.receiveIdType}:${input.receiveId}`);
    },
    async sendFile(input) {
      const filePath = resolveAssetPath(input.assetId);
      const uploaded = await uploadFile(client, {
        filePath,
        fileType: "stream",
        fileName: input.filename
      });

      await sendMessage(client, {
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        msgType: "file",
        content: { file_key: uploaded }
      });
      deps.log?.("info", `[feishu] sent file ${input.filename} to ${input.receiveIdType}:${input.receiveId}`);
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
  }
): Promise<void> {
  assertStarted(client);
  await client.im.v1.message.create({
    params: {
      receive_id_type: input.receiveIdType
    },
    data: {
      receive_id: input.receiveId,
      content: JSON.stringify(input.content),
      msg_type: input.msgType
    }
  });
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

function wrapLarkMessageEvent(data: any): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: data?.event_id,
      create_time: data?.message?.create_time ?? Date.now().toString()
    },
    event: {
      message: {
        message_id: data?.message?.message_id,
        chat_id: data?.message?.chat_id,
        chat_type: data?.message?.chat_type,
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
