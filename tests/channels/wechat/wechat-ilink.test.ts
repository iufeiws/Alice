import { test } from "node:test";
import assert from "node:assert/strict";
import { createWeChatILinkClient } from "../../../src/channels/wechat/src/client.js";

test("wechat iLink client fetches QR login code", async () => {
  const urls: string[] = [];
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
      throw new Error("status endpoint should not be called");
    }
  });

  const qr = await client.getLoginQRCode();

  assert.equal(urls[0], "https://ilink.example.test/ilink/bot/get_bot_qrcode?bot_type=3");
  assert.equal(qr.qrcode, "qr-1");
  assert.equal(qr.qrcodeUrl, "https://liteapp.weixin.qq.com/q/qr-1");
  assert.equal(qr.qrcodeContent, "https://liteapp.weixin.qq.com/q/qr-1");
});

test("wechat iLink client fetches QR login status", async () => {
  const urls: string[] = [];
  const statusHeaders: string[] = [];
  const client = createWeChatILinkClient({
    enabled: true,
    baseURL: "https://ilink.example.test/ilink/bot",
    pollTimeoutMs: 35_000
  }, {
    fetch: async (url, init) => {
      urls.push(String(url));
      statusHeaders.push(String((init?.headers as Record<string, string>)["iLink-App-ClientVersion"]));
      return new Response(JSON.stringify({
        ret: 0,
        status: "confirmed",
        bot_token: "token-1",
        baseurl: "https://ilink-account.example.test/ilink/bot/"
      }), { status: 200 });
    }
  });

  const status = await client.getQRCodeStatus("qr-1");

  assert.equal(urls[0], "https://ilink.example.test/ilink/bot/get_qrcode_status?qrcode=qr-1");
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

test("wechat iLink client sends required long-poll request", async () => {
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
});

test("wechat iLink client parses long-poll messages", async () => {
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
        message_id: "msg-1",
        from_user_id: "wx-user",
        context_token: "ctx-1",
        content: JSON.stringify({ text: "hello" })
      }]
    }), { status: 200 })
  });

  const updates = await client.getUpdates("cursor-1");

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

test("wechat iLink client parses item ref_msg quotes", async () => {
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
        item_list: [{
          type: 1,
          msg_id: "v1:item",
          ref_msg: {
            message_item: {
              type: 1,
              text_item: { text: "- 雾蓝刺绣汉服——浅蓝纱质，清淡" }
            }
          },
          text_item: { text: "就这个" }
        }]
      }]
    }), { status: 200 })
  });

  const updates = await client.getUpdates("cursor-1");

  assert.equal(updates.messages[0].text, "就这个");
  assert.deepEqual(updates.messages[0].quotedMessage, {
    id: undefined,
    fromUserId: undefined,
    text: "- 雾蓝刺绣汉服——浅蓝纱质，清淡"
  });
});
