import { test } from "node:test";
import assert from "node:assert/strict";
import { createWeChatPlugin, createWeChatStateStore } from "../../../src/channels/wechat/src/index.js";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createMessagingTools } from "../../../src/capabilities/tools/messaging/src/index.js";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { makeWechatTestDir, rawWechatText, writeSilentWav } from "./wechat-ilink-helpers.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("wechat plugin forwards quoted message metadata", async () => {
  const dir = makeWechatTestDir("alice-wechat-quote");
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
  const dir = makeWechatTestDir("alice-wechat");
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  let sendUrl = "";
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
      sendUrl = String(url);
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

  assert.equal(sendUrl, "https://ilink.example.test/ilink/bot/sendmessage");
  assert.equal(sendBody.msg.to_user_id, "wx-user");
  assert.equal(sendBody.msg.context_token, "ctx-1");
  assert.equal(sendBody.msg.item_list[0].text_item.text, "reply");
  assert.equal(result.messageId, "out-1");
});

test("wechat plugin uploads and sends image with cached context_token", async () => {
  const dir = makeWechatTestDir("alice-wechat-image");
  const previousCwd = process.cwd();
  process.chdir(dir);
  const assetRoot = path.join(dir, "assets");
  const projectAssetPath = path.join(assetRoot, "test.png");
  fs.mkdirSync(path.dirname(projectAssetPath), { recursive: true });
  fs.writeFileSync(projectAssetPath, Buffer.from([1, 2, 3, 4]));
  const imageSize = fs.statSync(projectAssetPath).size;
  const encryptedImageSize = Math.ceil((imageSize + 1) / 16) * 16;
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
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

  try {
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
      assetId: path.relative(assetRoot, projectAssetPath)
    },
    meta: {
      createdAt: "2026-05-28T00:00:00.000Z",
      urgency: "normal"
    }
    }) as { messageId?: string };

    assert.equal(uploadRequestBody.media_type, 1);
    assert.equal(uploadRequestBody.to_user_id, "wx-user");
    assert.equal(uploadBodyLength, encryptedImageSize);
    assert.equal(sendBody.msg.context_token, "ctx-1");
    assert.equal(sendBody.msg.item_list[0].type, 2);
    assert.equal(sendBody.msg.item_list[0].image_item.media.encrypt_query_param, "download-param-1");
    assert.equal(result.messageId, "image-out-1");
  } finally {
    process.chdir(previousCwd);
  }
});

test("wechat plugin uploads and sends audio with cached context_token", async () => {
  const dir = makeWechatTestDir("alice-wechat-audio");
  const previousCwd = process.cwd();
  process.chdir(dir);
  const assetRoot = path.join(dir, "assets");
  const projectAssetPath = path.join(assetRoot, "generated", "test-wechat-audio.wav");
  writeSilentWav(projectAssetPath);
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
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

  try {
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
      assetId: path.relative(assetRoot, projectAssetPath),
      transcript: "voice transcript"
    },
    meta: {
      createdAt: "2026-05-28T00:00:00.000Z",
      urgency: "normal"
    }
    }) as { messageId?: string };

    assert.equal(uploadRequestBody.media_type, 4);
    assert.equal(uploadRequestBody.to_user_id, "wx-user");
    assert.equal(uploadBodyLength, uploadRequestBody.filesize);
    assert.equal(sendBody.msg.context_token, "ctx-1");
    assert.equal(sendBody.msg.item_list[0].type, 3);
    assert.equal(sendBody.msg.item_list[0].voice_item.media.encrypt_query_param, "download-param-audio");
    assert.equal(sendBody.msg.item_list[0].voice_item.text, "voice transcript");
    assert.equal(result.messageId, "audio-out-1");
  } finally {
    process.chdir(previousCwd);
  }
});

test("wechat plugin starts and stops typing with cached ticket", async () => {
  const dir = makeWechatTestDir("alice-wechat-typing");
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const requests: Array<{ url: string; body: any }> = [];
  const plugin = createWeChatPlugin({
    enabled: true,
    botToken: "token-1",
    baseURL: "https://ilink.example.test",
    pollTimeoutMs: 35_000
  }, {
    stateStore,
    async onEvent() {},
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
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

  const configRequests = requests.filter((request) => request.url.endsWith("/getconfig"));
  const typingRequests = requests.filter((request) => request.url.endsWith("/sendtyping"));
  assert.equal(configRequests.length, 1);
  assert.equal(configRequests[0].body.ilink_user_id, "wx-user");
  assert.equal(configRequests[0].body.context_token, "ctx-1");
  assert.deepEqual(typingRequests.map((request) => request.body.status), [1, 1, 2]);
  assert.ok(typingRequests.every((request) => request.body.typing_ticket === "typing-ticket-1"));
});

test("wechat inbound messages are persisted through message runtime logs", async () => {
  const dir = makeWechatTestDir("alice-wechat-runtime");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 60_000,
    store,
    chatAgent: {
      async prepareEventRun() {
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
  const dir = makeWechatTestDir("alice-wechat-runtime-quote");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const stateStore = createWeChatStateStore(path.join(dir, "state.json"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 60_000,
    store,
    chatAgent: {
      async prepareEventRun() {
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
  const result = await tools.execute({ id: "call_quote_context", toolName: "Chat", input: { action: "poll",  scope: "recent" } });
  assert.match(String(result.output), /\{\{user\}\}:\n-引用:from friend #msg-1 quoted hello-\nreplying to this/);
});

test("send_chat messaging tool routes outbound text to wechat channel", async () => {
  const dir = makeWechatTestDir("alice-wechat-tool");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "wechat",
    externalMessageId: "seed-user-reply",
    conversationId: "wechat:dm:wx-user",
    senderId: "wx-user",
    senderRole: "user",
    contentType: "text",
    contentText: "user reply",
    createdAt: "2026-05-26T00:00:00.000Z"
  });
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
    toolName: "Chat", input: { action: "send",
      type: "message",
      content: "hello outbound"
    }
  });
  const messages = store.listMessages(10).filter((message) => message.direction === "outbound");

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ plugin: "wechat", text: "hello outbound" }]);
  assert.equal(messages[0].plugin, "wechat");
  assert.equal(messages[0].direction, "outbound");
  assert.equal(messages[0].contentText, "hello outbound");
  assert.equal(messages[0].externalMessageId, "wechat-out-1");
});
