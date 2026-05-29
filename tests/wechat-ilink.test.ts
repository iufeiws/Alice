import { test } from "node:test";
import assert from "node:assert/strict";
import { createWeChatILinkClient } from "../plugins/wechat/src/client.js";
import { createWeChatPlugin, createWeChatStateStore } from "../plugins/wechat/src/index.js";
import type { WeChatTextMessage } from "../plugins/wechat/src/types.js";
import { createMessageRuntime } from "../apps/api/src/message-runtime.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";
import { createMessagingTools } from "../plugins/messaging/src/index.js";
import type { AgentEvent } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("wechat iLink client supports QR login primitives", async () => {
  const urls: string[] = [];
  const statusHeaders: string[] = [];
  const client = createWeChatILinkClient({
    enabled: true,
    baseURL: "https://ilink.example.test/ilink/bot",
    pollTimeoutMs: 35_000
  }, {
    fetch: async (url, init) => {
      urls.push(String(url));
      if (String(url).includes("get_bot_qrcode")) {
        return new Response(JSON.stringify({
          ret: 0,
          qrcode: "qr-1",
          qrcode_img_content: "https://liteapp.weixin.qq.com/q/qr-1"
        }), { status: 200 });
      }
      statusHeaders.push(String((init?.headers as Record<string, string>)["iLink-App-ClientVersion"]));
      return new Response(JSON.stringify({
        ret: 0,
        status: "confirmed",
        bot_token: "token-1",
        baseurl: "https://ilink-account.example.test/ilink/bot/"
      }), { status: 200 });
    }
  });

  const qr = await client.getLoginQRCode();
  const status = await client.getQRCodeStatus(qr.qrcode);

  assert.equal(urls[0], "https://ilink.example.test/ilink/bot/get_bot_qrcode?bot_type=3");
  assert.equal(urls[1], "https://ilink.example.test/ilink/bot/get_qrcode_status?qrcode=qr-1");
  assert.equal(qr.qrcode, "qr-1");
  assert.equal(qr.qrcodeUrl, "https://liteapp.weixin.qq.com/q/qr-1");
  assert.equal(qr.qrcodeContent, "https://liteapp.weixin.qq.com/q/qr-1");
  assert.equal(statusHeaders[0], "1");
  assert.equal(status.status, "confirmed");
  assert.equal(status.botToken, "token-1");
  assert.equal(status.baseURL, "https://ilink-account.example.test/ilink/bot");
});

test("wechat iLink client expands bare host to ilink bot API path", async () => {
  const urls: string[] = [];
  const client = createWeChatILinkClient({
    enabled: true,
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ret: 0, qrcode: "qr-1" }), { status: 200 });
    }
  });

  await client.getLoginQRCode();

  assert.equal(urls[0], "https://ilink.example.test/ilink/bot/get_bot_qrcode?bot_type=3");
});

test("wechat iLink client sends required long-poll headers and parses messages", async () => {
  let requestUrl = "";
  let requestBody: any;
  let auth = "";
  const client = createWeChatILinkClient({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test/ilink/bot",
    pollTimeoutMs: 35_000
  }, {
    fetch: async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      auth = String((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "cursor-2",
        messages: [{
          message_id: "msg-1",
          from_user_id: "wx-user",
          context_token: "ctx-1",
          content: JSON.stringify({ text: "hello" })
        }]
      }), { status: 200 });
    }
  });

  const updates = await client.getUpdates("cursor-1");

  assert.equal(requestUrl, "https://ilink.example.test/ilink/bot/getupdates");
  assert.equal(requestBody.get_updates_buf, "cursor-1");
  assert.equal(requestBody.longpolling_timeout_ms, 35_000);
  assert.equal(requestBody.base_info.channel_version, "1.0.3");
  assert.equal(auth, "Bearer token-1");
  assert.equal(updates.nextCursor, "cursor-2");
  assert.equal(updates.messages[0].fromUserId, "wx-user");
  assert.equal(updates.messages[0].text, "hello");
  assert.equal(updates.messages[0].contextToken, "ctx-1");
});

test("wechat iLink client parses iLink msg item_list text payloads", async () => {
  const client = createWeChatILinkClient({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test/ilink/bot",
    pollTimeoutMs: 35_000
  }, {
    fetch: async () => new Response(JSON.stringify({
      ret: 0,
      get_updates_buf: "cursor-2",
      msgs: [{
        msg_id: "msg-1",
        from_user_id: "wx-user",
        context_token: "ctx-1",
        item_list: [
          { type: 1, text_item: { text: "hello from item_list" } }
        ]
      }]
    }), { status: 200 })
  });

  const updates = await client.getUpdates("cursor-1");

  assert.equal(updates.messages.length, 1);
  assert.equal(updates.messages[0].id, "msg-1");
  assert.equal(updates.messages[0].fromUserId, "wx-user");
  assert.equal(updates.messages[0].contextToken, "ctx-1");
  assert.equal(updates.messages[0].text, "hello from item_list");
});

test("wechat iLink client accepts getupdates payloads without ret code", async () => {
  const client = createWeChatILinkClient({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test/ilink/bot",
    pollTimeoutMs: 35_000
  }, {
    fetch: async () => new Response(JSON.stringify({
      get_updates_buf: "cursor-2",
      msgs: [{
        msg_id: "msg-1",
        from_user_id: "wx-user",
        context_token: "ctx-1",
        item_list: [
          { type: 1, text_item: { text: "hello without ret" } }
        ]
      }]
    }), { status: 200 })
  });

  const updates = await client.getUpdates("cursor-1");

  assert.equal(updates.nextCursor, "cursor-2");
  assert.equal(updates.messages.length, 1);
  assert.equal(updates.messages[0].text, "hello without ret");
});

test("wechat iLink client parses quoted text messages", async () => {
  const client = createWeChatILinkClient({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test/ilink/bot",
    pollTimeoutMs: 35_000
  }, {
    fetch: async () => new Response(JSON.stringify({
      ret: 0,
      get_updates_buf: "cursor-2",
      messages: [{
        message_id: "msg-2",
        from_user_id: "wx-user",
        context_token: "ctx-2",
        content: JSON.stringify({
          text: "replying to this",
          quote_message: {
            message_id: "msg-1",
            from_user_id: "friend",
            content: JSON.stringify({ text: "quoted hello" })
          }
        })
      }]
    }), { status: 200 })
  });

  const updates = await client.getUpdates("cursor-1");

  assert.equal(updates.messages[0].id, "msg-2");
  assert.equal(updates.messages[0].text, "replying to this");
  assert.deepEqual(updates.messages[0].quotedMessage, {
    id: "msg-1",
    fromUserId: "friend",
    text: "quoted hello"
  });
});

test("wechat plugin forwards quoted message metadata", async () => {
  const dir = path.join("/tmp", `alice-wechat-quote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const events: AgentEvent[] = [];
  const plugin = createWeChatPlugin({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    stateStore,
    async onEvent(event) {
      events.push(event);
    },
    fetch: async () => new Response(JSON.stringify({ ret: 0, message_id: "unused" }), { status: 200 })
  });

  await plugin.ingestTextMessage({
    ...rawWechatText("msg-2", "wx-user", "ctx-2", "replying to this"),
    quotedMessage: { id: "msg-1", fromUserId: "friend", text: "quoted hello" }
  });

  assert.deepEqual(events[0].meta.quotedMessage, {
    rawMessageId: "msg-1",
    senderId: "friend",
    text: "quoted hello"
  });
});

test("wechat plugin writes inbound context and sends text with cached context_token", async () => {
  const dir = path.join("/tmp", `alice-wechat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const events: string[] = [];
  let sendBody: any;
  const plugin = createWeChatPlugin({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    stateStore,
    async onEvent(event) {
      events.push(`${event.source.plugin}:${event.source.userId}:${event.payload.kind === "text" ? event.payload.text : ""}`);
    },
    fetch: async (_url, init) => {
      sendBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ret: 0, message_id: "out-1" }), { status: 200 });
    }
  });

  await plugin.ingestTextMessage(rawWechatText("msg-1", "wx-user", "ctx-1", "hello"));
  const result = await plugin.send({
    id: "out",
    target: {
      plugin: "wechat",
      accountId: "main",
      channelId: "wx-user",
      userId: "wx-user",
      sessionId: "wechat:dm:wx-user"
    },
    content: {
      kind: "text",
      text: "reply"
    },
    meta: {
      createdAt: "2026-05-28T00:00:00.000Z",
      urgency: "normal"
    }
  }) as { messageId?: string };

  assert.deepEqual(events, ["wechat:wx-user:hello"]);
  assert.equal(stateStore.getContact("wx-user")?.contextToken, "ctx-1");
  assert.equal(sendBody.base_info.channel_version, "1.0.3");
  assert.equal(sendBody.msg.from_user_id, "");
  assert.equal(sendBody.msg.to_user_id, "wx-user");
  assert.match(sendBody.msg.client_id, /^alice-wechat:/);
  assert.equal(sendBody.msg.message_type, 2);
  assert.equal(sendBody.msg.message_state, 2);
  assert.equal(sendBody.msg.context_token, "ctx-1");
  assert.deepEqual(sendBody.msg.item_list, [{ type: 1, text_item: { text: "reply" } }]);
  assert.equal(result.messageId, "out-1");
});

test("wechat plugin uploads and sends image with cached context_token", async () => {
  const dir = path.join("/tmp", `alice-wechat-image-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const projectAssetPath = path.join(process.cwd(), "assets", "test.png");
  const imageSize = fs.statSync(projectAssetPath).size;
  const encryptedImageSize = Math.ceil((imageSize + 1) / 16) * 16;
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const urls: string[] = [];
  let uploadBodyLength = 0;
  let uploadRequestBody: any;
  let sendBody: any;
  const plugin = createWeChatPlugin({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    stateStore,
    async onEvent() {},
    fetch: async (url, init) => {
      urls.push(String(url));
      if (String(url).includes("/getuploadurl")) {
        uploadRequestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ret: 0, upload_param: "upload-param-1" }), { status: 200 });
      }
      if (String(url).includes("novac2c.cdn.weixin.qq.com/c2c/upload")) {
        uploadBodyLength = (init?.body as Uint8Array).byteLength;
        return new Response("", {
          status: 200,
          headers: { "x-encrypted-param": "download-param-1" }
        });
      }
      sendBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ret: 0, message_id: "image-out-1" }), { status: 200 });
    }
  });

  await plugin.ingestTextMessage(rawWechatText("msg-1", "wx-user", "ctx-1", "hello"));
  const result = await plugin.send({
    id: "out",
    target: {
      plugin: "wechat",
      accountId: "main",
      channelId: "wx-user",
      userId: "wx-user",
      sessionId: "wechat:dm:wx-user"
    },
    content: {
      kind: "image",
      assetId: path.relative(path.join(process.cwd(), "assets"), projectAssetPath)
    },
    meta: {
      createdAt: "2026-05-28T00:00:00.000Z",
      urgency: "normal"
    }
  }) as { messageId?: string };

  assert.equal(urls[0], "https://ilink.example.test/ilink/bot/getuploadurl");
  assert.match(urls[1], /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?encrypted_query_param=upload-param-1&filekey=/);
  assert.equal(urls[2], "https://ilink.example.test/ilink/bot/sendmessage");
  assert.equal(uploadRequestBody.media_type, 1);
  assert.equal(uploadRequestBody.to_user_id, "wx-user");
  assert.equal(uploadRequestBody.rawsize, imageSize);
  assert.equal(uploadRequestBody.filesize, encryptedImageSize);
  assert.equal(uploadBodyLength, encryptedImageSize);
  assert.equal(sendBody.msg.context_token, "ctx-1");
  assert.equal(sendBody.msg.item_list[0].type, 2);
  assert.equal(sendBody.msg.item_list[0].image_item.media.encrypt_query_param, "download-param-1");
  assert.equal(sendBody.msg.item_list[0].image_item.media.encrypt_type, 1);
  assert.equal(typeof sendBody.msg.item_list[0].image_item.media.aes_key, "string");
  assert.equal(Buffer.from(sendBody.msg.item_list[0].image_item.media.aes_key, "base64").toString("utf8").length, 32);
  assert.equal(typeof sendBody.msg.item_list[0].image_item.aeskey, "string");
  assert.equal(sendBody.msg.item_list[0].image_item.mid_size, encryptedImageSize);
  assert.equal(result.messageId, "image-out-1");
});

test("wechat plugin uploads and sends audio with cached context_token", async () => {
  const dir = path.join("/tmp", `alice-wechat-audio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const projectAssetPath = path.join(process.cwd(), "assets", "generated", "test-wechat-audio.wav");
  writeSilentWav(projectAssetPath);
  const audioSize = fs.statSync(projectAssetPath).size;
  const encryptedAudioSize = Math.ceil((audioSize + 1) / 16) * 16;
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const urls: string[] = [];
  let uploadBodyLength = 0;
  let uploadRequestBody: any;
  let sendBody: any;
  const plugin = createWeChatPlugin({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    stateStore,
    async onEvent() {},
    fetch: async (url, init) => {
      urls.push(String(url));
      if (String(url).includes("/getuploadurl")) {
        uploadRequestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ret: 0, upload_param: "upload-param-audio" }), { status: 200 });
      }
      if (String(url).includes("novac2c.cdn.weixin.qq.com/c2c/upload")) {
        uploadBodyLength = (init?.body as Uint8Array).byteLength;
        return new Response("", {
          status: 200,
          headers: { "x-encrypted-param": "download-param-audio" }
        });
      }
      sendBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ret: 0, message_id: "audio-out-1" }), { status: 200 });
    }
  });

  await plugin.ingestTextMessage(rawWechatText("msg-1", "wx-user", "ctx-1", "hello"));
  const result = await plugin.send({
    id: "out",
    target: {
      plugin: "wechat",
      accountId: "main",
      channelId: "wx-user",
      userId: "wx-user",
      sessionId: "wechat:dm:wx-user"
    },
    content: {
      kind: "audio",
      assetId: path.relative(path.join(process.cwd(), "assets"), projectAssetPath),
      transcript: "voice transcript"
    },
    meta: {
      createdAt: "2026-05-28T00:00:00.000Z",
      urgency: "normal"
    }
  }) as { messageId?: string };

  assert.equal(urls[0], "https://ilink.example.test/ilink/bot/getuploadurl");
  assert.match(urls[1], /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?encrypted_query_param=upload-param-audio&filekey=/);
  assert.equal(urls[2], "https://ilink.example.test/ilink/bot/sendmessage");
  assert.equal(uploadRequestBody.media_type, 4);
  assert.equal(uploadRequestBody.to_user_id, "wx-user");
  assert.ok(uploadRequestBody.rawsize > 0);
  assert.ok(uploadRequestBody.filesize >= uploadRequestBody.rawsize);
  assert.equal(uploadBodyLength, uploadRequestBody.filesize);
  assert.equal(sendBody.msg.context_token, "ctx-1");
  assert.equal(sendBody.msg.item_list[0].type, 3);
  assert.equal(sendBody.msg.item_list[0].voice_item.media.encrypt_query_param, "download-param-audio");
  assert.equal(sendBody.msg.item_list[0].voice_item.media.encrypt_type, 1);
  assert.equal(typeof sendBody.msg.item_list[0].voice_item.media.aes_key, "string");
  assert.equal(sendBody.msg.item_list[0].voice_item.encode_type, 6);
  assert.ok(sendBody.msg.item_list[0].voice_item.playtime > 0);
  assert.equal(sendBody.msg.item_list[0].voice_item.sample_rate, 24000);
  assert.equal(sendBody.msg.item_list[0].voice_item.bits_per_sample, 16);
  assert.equal(sendBody.msg.item_list[0].voice_item.text, "voice transcript");
  assert.equal(result.messageId, "audio-out-1");
  fs.rmSync(projectAssetPath, { force: true });
});

test("wechat plugin starts and stops typing with cached ticket", async () => {
  const dir = path.join("/tmp", `alice-wechat-typing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const urls: string[] = [];
  const bodies: any[] = [];
  const plugin = createWeChatPlugin({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    stateStore,
    async onEvent() {},
    fetch: async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      if (String(url).includes("/getconfig")) {
        return new Response(JSON.stringify({ ret: 0, typing_ticket: "typing-ticket-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    }
  });

  await plugin.ingestTextMessage(rawWechatText("msg-1", "wx-user", "ctx-1", "hello"));
  await plugin.setTyping({ userId: "wx-user", sessionId: "wechat:dm:wx-user", typing: true });
  await plugin.setTyping({ userId: "wx-user", sessionId: "wechat:dm:wx-user", typing: true });
  await plugin.setTyping({ userId: "wx-user", sessionId: "wechat:dm:wx-user", typing: false });

  assert.deepEqual(urls, [
    "https://ilink.example.test/ilink/bot/getconfig",
    "https://ilink.example.test/ilink/bot/sendtyping",
    "https://ilink.example.test/ilink/bot/sendtyping",
    "https://ilink.example.test/ilink/bot/sendtyping"
  ]);
  assert.equal(bodies[0].ilink_user_id, "wx-user");
  assert.equal(bodies[0].context_token, "ctx-1");
  assert.equal(bodies[1].typing_ticket, "typing-ticket-1");
  assert.equal(bodies[1].status, 1);
  assert.equal(bodies[2].status, 1);
  assert.equal(bodies[3].status, 2);
});

test("wechat inbound messages are persisted through message runtime logs", async () => {
  const dir = path.join("/tmp", `alice-wechat-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 60_000,
    store,
    core: {
      async handleEvent() {
        return [];
      }
    },
    outputRouter: {
      async sendAll() {
        return [];
      }
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({
        time: new Date("2026-05-28T00:00:00.000Z").toISOString(),
        ...input
      });
    }
  });
  const plugin = createWeChatPlugin({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    stateStore,
    async onEvent(event) {
      runtime.ingestEvent(event);
    },
    fetch: async () => new Response(JSON.stringify({ ret: 0, message_id: "unused" }), { status: 200 })
  });

  await plugin.ingestTextMessage(rawWechatText("msg-1", "wx-user", "ctx-1", "hello log"));
  const messages = store.listMessages(10);
  const logs = store.listMessageLogs(10);
  await runtime.flushAll();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].plugin, "wechat");
  assert.equal(messages[0].conversationId, "wechat:dm:wx-user");
  assert.equal(messages[0].contentText, "hello log");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].plugin, "wechat");
  assert.equal(logs[0].summary, "hello log");
  assert.equal(logs[0].rawMessageId, "msg-1");
});

test("wechat quoted inbound messages are visible in persisted chat context", async () => {
  const dir = path.join("/tmp", `alice-wechat-runtime-quote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 60_000,
    store,
    core: {
      async handleEvent() {
        return [];
      }
    },
    outputRouter: {
      async sendAll() {
        return [];
      }
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({
        time: new Date("2026-05-28T00:00:00.000Z").toISOString(),
        ...input
      });
    }
  });
  const plugin = createWeChatPlugin({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    stateStore,
    async onEvent(event) {
      runtime.ingestEvent(event);
    },
    fetch: async () => new Response(JSON.stringify({ ret: 0, message_id: "unused" }), { status: 200 })
  });

  await plugin.ingestTextMessage({
    ...rawWechatText("msg-2", "wx-user", "ctx-2", "replying to this"),
    quotedMessage: { id: "msg-1", fromUserId: "friend", text: "quoted hello" }
  });
  await runtime.flushAll();

  const messages = store.listMessages(10);
  assert.equal(messages[0].contentText, "-引用:from friend #msg-1 quoted hello-\nreplying to this");

  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", channelId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });
  const result = await tools.execute({ id: "call_quote_context", toolName: "check_chat", input: {} });
  assert.match(String(result.output), /user:-引用:from friend #msg-1 quoted hello-\nreplying to this/);
});

test("send_chat messaging tool routes outbound text to wechat channel", async () => {
  const dir = path.join("/tmp", `alice-wechat-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const sent: Array<{ plugin: string; text: string }> = [];
  const tools = createMessagingTools({
    store,
    outputRouter: {
      async send(output) {
        sent.push({
          plugin: output.target.plugin,
          text: output.content.kind === "text" ? output.content.text : output.content.kind
        });
        return { messageId: "wechat-out-1" };
      }
    },
    sleep: async () => {},
    getDefaultTarget() {
      return {
        plugin: "wechat",
        accountId: "main",
        channelId: "wx-user",
        userId: "wx-user",
        sessionId: "wechat:dm:wx-user"
      };
    }
  });

  const result = await tools.execute({
    id: "call-1",
    toolName: "send_chat",
    input: {
      type: "message",
      content: "hello outbound"
    }
  });
  const messages = store.listMessages(10);

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ plugin: "wechat", text: "hello outbound" }]);
  assert.equal(messages[0].plugin, "wechat");
  assert.equal(messages[0].direction, "outbound");
  assert.equal(messages[0].contentText, "hello outbound");
  assert.equal(messages[0].externalMessageId, "wechat-out-1");
});

function rawWechatText(id: string, fromUserId: string, contextToken: string, text: string): WeChatTextMessage {
  return {
    id,
    fromUserId,
    contextToken,
    text,
    createdAt: "1770000000000",
    raw: { id, fromUserId, contextToken, text }
  };
}

function writeSilentWav(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sampleRate = 24_000;
  const samples = sampleRate;
  const dataSize = samples * 2;
  const buffer = new Uint8Array(44 + dataSize);
  const view = new DataView(buffer.buffer);
  writeAscii(buffer, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(buffer, 8, "WAVE");
  writeAscii(buffer, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(buffer, 36, "data");
  view.setUint32(40, dataSize, true);
  fs.writeFileSync(filePath, buffer);
}

function writeAscii(buffer: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    buffer[offset + index] = text.charCodeAt(index);
  }
}
