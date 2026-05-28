import type { WeChatConfig, WeChatLoginQRCode, WeChatQRCodeStatus, WeChatTextMessage, WeChatUpdates } from "./types.js";

const crypto: any = await import("node:crypto");
const fs: any = await import("node:fs/promises");
const path = await import("node:path");

export type WeChatILinkClient = {
  getLoginQRCode(): Promise<WeChatLoginQRCode>;
  getQRCodeStatus(qrcode: string): Promise<WeChatQRCodeStatus>;
  getUpdates(cursor: string): Promise<WeChatUpdates>;
  sendText(input: { toUserId: string; text: string; contextToken: string }): Promise<{ messageId?: string; raw: unknown }>;
  sendImage(input: { toUserId: string; assetId: string; contextToken: string }): Promise<{ messageId?: string; raw: unknown }>;
  sendAudio(input: { toUserId: string; assetId: string; contextToken: string; transcript?: string }): Promise<{ messageId?: string; raw: unknown }>;
  getTypingTicket(input: { userId: string; contextToken: string }): Promise<{ typingTicket: string; raw: unknown }>;
  sendTyping(input: { userId: string; typingTicket: string; status: 1 | 2 }): Promise<{ raw: unknown }>;
};

const cdnBaseURL = "https://novac2c.cdn.weixin.qq.com/c2c";

export function createWeChatILinkClient(config: WeChatConfig, options: { fetch?: typeof fetch } = {}): WeChatILinkClient {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async getLoginQRCode() {
      const raw = await getJson(fetchImpl, joinIlinkBotUrl(config.baseURL, "/get_bot_qrcode?bot_type=3"));
      assertRetOk(raw, "get_bot_qrcode");
      const qrcode = firstString(raw, ["qrcode", "qrcode_id", "qrcodeId", "uuid"]) ?? "";
      if (!qrcode) throw new Error("WeChat iLink get_bot_qrcode returned no qrcode");
      return {
        qrcode,
        qrcodeUrl: firstString(raw, ["qrcode_img_content", "qrcode_url", "qrcodeUrl", "url"]),
        qrcodeContent: firstString(raw, ["qrcode_img_content", "qrcode_url", "qrcodeUrl", "url"]),
        qrcodeBase64: firstString(raw, ["qrcode_base64", "qrcodeBase64", "image_base64", "imageBase64"]),
        status: firstString(raw, ["status"]),
        raw
      };
    },
    async getQRCodeStatus(qrcode) {
      const raw = await getJson(fetchImpl, `${joinIlinkBotUrl(config.baseURL, "/get_qrcode_status")}?qrcode=${encodeURIComponent(qrcode)}`, {
        "iLink-App-ClientVersion": "1"
      });
      assertRetOk(raw, "get_qrcode_status");
      return {
        status: firstString(raw, ["status", "qrcode_status", "qrcodeStatus"]) ?? "unknown",
        botToken: firstString(raw, ["bot_token", "botToken", "token"]),
        baseURL: firstString(raw, ["baseurl", "base_url", "baseURL"])?.replace(/\/+$/, ""),
        raw
      };
    },
    async getUpdates(cursor) {
      const raw = await postJson(fetchImpl, config, "/getupdates", {
        base_info: { channel_version: "1.0.3" },
        get_updates_buf: cursor,
        longpolling_timeout_ms: config.pollTimeoutMs
      }, config.pollTimeoutMs);
      assertRetOk(raw, "getupdates");
      return {
        nextCursor: firstString(raw, ["get_updates_buf", "next_cursor", "cursor"]),
        messages: extractMessages(raw)
      };
    },
    async sendText(input) {
      const raw = await postJson(fetchImpl, config, "/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: input.toUserId,
          client_id: `alice-wechat:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
          message_type: 2,
          message_state: 2,
          context_token: input.contextToken,
          item_list: [
            {
              type: 1,
              text_item: {
                text: input.text
              }
            }
          ]
        },
        base_info: { channel_version: "1.0.3" }
      });
      assertRetOk(raw, "sendmessage");
      return {
        messageId: firstString(raw, ["message_id", "msg_id", "client_msg_id"]),
        raw
      };
    },
    async sendImage(input) {
      const imagePath = await resolveAssetPath(input.assetId);
      const uploaded = await uploadMedia(fetchImpl, config, {
        toUserId: input.toUserId,
        mediaPath: imagePath,
        mediaType: 1
      });
      const raw = await postJson(fetchImpl, config, "/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: input.toUserId,
          client_id: `alice-wechat:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
          message_type: 2,
          message_state: 2,
          context_token: input.contextToken,
          item_list: [
            {
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: uploaded.downloadParam,
                  aes_key: encodeIlinkMediaAesKey(uploaded.aesKey),
                  encrypt_type: 1
                },
                aeskey: uploaded.aesKey.toString("hex"),
                mid_size: uploaded.encryptedSize
              }
            }
          ]
        },
        base_info: { channel_version: "1.0.3" }
      });
      assertRetOk(raw, "sendmessage");
      return {
        messageId: firstString(raw, ["message_id", "msg_id", "client_msg_id"]),
        raw
      };
    },
    async sendAudio(input) {
      const audioPath = await resolveAssetPath(input.assetId);
      const uploaded = await uploadMedia(fetchImpl, config, {
        toUserId: input.toUserId,
        mediaPath: audioPath,
        mediaType: 4
      });
      const raw = await postJson(fetchImpl, config, "/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: input.toUserId,
          client_id: `alice-wechat:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
          message_type: 2,
          message_state: 2,
          context_token: input.contextToken,
          item_list: [
            {
              type: 3,
              voice_item: {
                media: {
                  encrypt_query_param: uploaded.downloadParam,
                  aes_key: encodeIlinkMediaAesKey(uploaded.aesKey),
                  encrypt_type: 1
                },
                encode_type: 6,
                playtime: 0,
                text: input.transcript
              }
            }
          ]
        },
        base_info: { channel_version: "1.0.3" }
      });
      assertRetOk(raw, "sendmessage");
      return {
        messageId: firstString(raw, ["message_id", "msg_id", "client_msg_id"]),
        raw
      };
    },
    async getTypingTicket(input) {
      const raw = await postJson(fetchImpl, config, "/getconfig", {
        ilink_user_id: input.userId,
        context_token: input.contextToken,
        base_info: { channel_version: "1.0.3" }
      });
      assertRetOk(raw, "getconfig");
      const typingTicket = firstString(raw, ["typing_ticket", "typingTicket"]);
      if (!typingTicket) throw new Error("WeChat iLink getconfig returned no typing_ticket");
      return { typingTicket, raw };
    },
    async sendTyping(input) {
      const raw = await postJson(fetchImpl, config, "/sendtyping", {
        ilink_user_id: input.userId,
        typing_ticket: input.typingTicket,
        status: input.status,
        base_info: { channel_version: "1.0.3" }
      });
      assertRetOk(raw, "sendtyping");
      return { raw };
    }
  };
}

async function uploadMedia(fetchImpl: typeof fetch, config: WeChatConfig, input: {
  toUserId: string;
  mediaPath: string;
  mediaType: 1 | 4;
}): Promise<{
  downloadParam: string;
  aesKey: any;
  encryptedSize: number;
}> {
  const plaintext = await fs.readFile(input.mediaPath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const encryptedSize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const uploadUrlResp = await postJson(fetchImpl, config, "/getuploadurl", {
    filekey,
    media_type: input.mediaType,
    to_user_id: input.toUserId,
    rawsize,
    rawfilemd5,
    filesize: encryptedSize,
    no_need_thumb: true,
    aeskey: aesKey.toString("hex"),
    base_info: { channel_version: "1.0.3" }
  });
  assertRetOk(uploadUrlResp, "getuploadurl");
  const uploadParam = firstString(uploadUrlResp, ["upload_param", "uploadParam"]);
  if (!uploadParam) throw new Error("WeChat iLink getuploadurl returned no upload_param");
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const downloadParam = await uploadEncryptedMedia(fetchImpl, uploadParam, filekey, ciphertext);
  return { downloadParam, aesKey, encryptedSize };
}

async function resolveAssetPath(assetId: string): Promise<string> {
  if (assetId.startsWith("file://")) throw new Error("WeChat asset paths must be local project asset paths");
  const assetRoot = path.resolve("assets");
  const filePath = path.isAbsolute(assetId) ? assetId : path.resolve(assetRoot, assetId);
  const relative = path.relative(assetRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("WeChat asset path is outside assets directory");
  }
  await fs.access(filePath);
  return filePath;
}

async function uploadEncryptedMedia(fetchImpl: typeof fetch, uploadParam: string, filekey: string, ciphertext: Buffer): Promise<string> {
  const url = `${cdnBaseURL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(ciphertext)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WeChat CDN upload HTTP ${response.status}: ${text.slice(0, 200)}`);
  const downloadParam = response.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("WeChat CDN upload response missing x-encrypted-param");
  return downloadParam;
}

function encryptAesEcb(plaintext: any, key: any): any {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function encodeIlinkMediaAesKey(key: any): string {
  return Buffer.from(key.toString("hex")).toString("base64");
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  return fetchImpl(url, { method: "GET", headers }).then(async (response) => {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { text };
    }
    if (!response.ok) throw new Error(`WeChat iLink HTTP ${response.status}: ${text.slice(0, 200)}`);
    return parsed;
  });
}

function postJson(fetchImpl: typeof fetch, config: WeChatConfig, pathname: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  if (!config.botToken) throw new Error("missing WeChat iLink bot token");
  return fetchImpl(joinIlinkBotUrl(config.baseURL, pathname), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorizationtype": "ilink_bot_token",
      "authorization": `Bearer ${config.botToken}`,
      "x-wechat-uin": randomWechatUin()
    },
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    body: JSON.stringify(body)
  }).then(async (response) => {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { text };
    }
    if (!response.ok) throw new Error(`WeChat iLink HTTP ${response.status}: ${text.slice(0, 200)}`);
    return parsed;
  });
}

function assertRetOk(raw: unknown, action: string): void {
  const record = isRecord(raw) ? raw : {};
  const ret = record.ret ?? record.errcode ?? record.code;
  if (ret === undefined || ret === 0 || ret === "0") return;
  if (ret === -14 || ret === "-14") throw new Error(`WeChat iLink session expired during ${action}`);
  const message = firstString(record, ["errmsg", "msg", "message"]) ?? JSON.stringify(raw);
  throw new Error(`WeChat iLink ${action} failed: ${String(ret)} ${message}`);
}

function extractMessages(raw: unknown): WeChatTextMessage[] {
  const candidates = findArray(raw, ["messages", "msgs", "msg_list", "updates", "items", "data"]);
  return candidates.flatMap((item) => normalizeMessage(item));
}

function normalizeMessage(raw: unknown): WeChatTextMessage[] {
  if (!isRecord(raw)) return [];
  const nested = firstRecord(raw, ["message", "msg", "payload"]);
  if (nested) {
    const normalized = normalizeMessage({ ...nested, raw_parent: raw });
    if (normalized.length > 0) return normalized.map((message) => ({ ...message, raw }));
  }

  const id = firstString(raw, ["message_id", "msg_id", "id", "client_msg_id"]);
  const fromUserId = firstString(raw, ["from_user_id", "from_user", "sender_id", "sender", "user_id", "openid", "open_id"]);
  const contextToken = firstString(raw, ["context_token", "contextToken"]);
  const text = extractText(raw);
  if (!id || !fromUserId || !contextToken || text === undefined) return [];
  return [{
    id,
    fromUserId,
    contextToken,
    text,
    createdAt: firstString(raw, ["create_time", "created_at", "timestamp", "time"]),
    quotedMessage: extractQuotedMessage(raw),
    raw
  }];
}

function extractQuotedMessage(raw: Record<string, unknown>): WeChatTextMessage["quotedMessage"] | undefined {
  const direct = firstRecord(raw, [
    "quoted_message",
    "quotedMessage",
    "quote_message",
    "quoteMessage",
    "quoted_msg",
    "quotedMsg",
    "quote_msg",
    "quoteMsg",
    "refer_msg",
    "referMsg",
    "reference_message",
    "referenceMessage",
    "referenced_message",
    "referencedMessage",
    "source_msg",
    "sourceMsg",
    "reply_to",
    "replyTo",
    "quote",
    "refer"
  ]);
  const fromJsonField = firstParsedRecord(raw, [
    "quoted_message",
    "quotedMessage",
    "quote_message",
    "quoteMessage",
    "quoted_msg",
    "quotedMsg",
    "quote_msg",
    "quoteMsg",
    "refer_msg",
    "referMsg",
    "reference_message",
    "referenceMessage",
    "referenced_message",
    "referencedMessage",
    "source_msg",
    "sourceMsg",
    "reply_to",
    "replyTo",
    "quote",
    "refer"
  ]);
  const fromContent = parsedContentRecord(raw);
  const nested = direct ?? fromJsonField ?? (fromContent ? extractQuotedMessageRecord(fromContent) : undefined);
  if (!nested) return undefined;
  const id = firstString(nested, [
    "message_id",
    "messageId",
    "msg_id",
    "msgId",
    "id",
    "client_msg_id",
    "clientMsgId",
    "source_msg_id",
    "sourceMsgId",
    "refer_msg_id",
    "referMsgId",
    "quoted_msg_id",
    "quotedMsgId"
  ]);
  const fromUserId = firstString(nested, ["from_user_id", "fromUserId", "from_user", "sender_id", "senderId", "sender", "user_id", "userId", "openid", "open_id"]);
  const text = extractText(nested);
  if (!id && !fromUserId && !text) return undefined;
  return { id, fromUserId, text };
}

function extractQuotedMessageRecord(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  return firstRecord(raw, [
    "quoted_message",
    "quotedMessage",
    "quote_message",
    "quoteMessage",
    "quoted_msg",
    "quotedMsg",
    "quote_msg",
    "quoteMsg",
    "refer_msg",
    "referMsg",
    "reference_message",
    "referenceMessage",
    "referenced_message",
    "referencedMessage",
    "source_msg",
    "sourceMsg",
    "reply_to",
    "replyTo",
    "quote",
    "refer"
  ]) ?? firstParsedRecord(raw, [
    "quoted_message",
    "quotedMessage",
    "quote_message",
    "quoteMessage",
    "quoted_msg",
    "quotedMsg",
    "quote_msg",
    "quoteMsg",
    "refer_msg",
    "referMsg",
    "reference_message",
    "referenceMessage",
    "referenced_message",
    "referencedMessage",
    "source_msg",
    "sourceMsg",
    "reply_to",
    "replyTo",
    "quote",
    "refer"
  ]);
}

function extractText(raw: Record<string, unknown>): string | undefined {
  const itemList = Array.isArray(raw.item_list) ? raw.item_list : Array.isArray(raw.itemList) ? raw.itemList : undefined;
  if (itemList) {
    const textParts = itemList
      .map((item) => isRecord(item) ? firstNestedString(item, [["text_item", "text"], ["textItem", "text"]]) : undefined)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (textParts.length > 0) return textParts.join("\n");
  }
  const direct = firstString(raw, ["text", "content", "message", "msg_content"]);
  if (direct === undefined) return undefined;
  try {
    const parsed = JSON.parse(direct) as unknown;
    if (isRecord(parsed)) return firstString(parsed, ["text", "content"]) ?? direct;
  } catch {
    return direct;
  }
  return direct;
}

function firstNestedString(value: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const path of paths) {
    let current: unknown = value;
    for (const part of path) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (typeof current === "string" && current) return current;
  }
  return undefined;
}

function findArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    if (isRecord(nested)) {
      const found = findArray(nested, keys);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function firstRecord(value: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    if (isRecord(value[key])) return value[key];
  }
  return undefined;
}

function firstParsedRecord(value: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item !== "string" || !item) continue;
    try {
      const parsed = JSON.parse(item) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

function parsedContentRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ["content", "message", "msg_content"]) {
    const item = value[key];
    if (typeof item !== "string" || !item) continue;
    try {
      const parsed = JSON.parse(item) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

function firstString(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item) return item;
    if (typeof item === "number" && Number.isFinite(item)) return String(item);
  }
  return undefined;
}

function joinUrl(baseURL: string, pathname: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

function joinIlinkBotUrl(baseURL: string, pathname: string): string {
  const parsed = new URL(baseURL);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const effectiveBase = basePath && basePath !== "/" ? parsed.toString().replace(/\/+$/, "") : `${parsed.origin}/ilink/bot`;
  return joinUrl(effectiveBase, pathname);
}

function randomWechatUin(): string {
  const value = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(value)).toString("base64");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
