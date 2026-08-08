import { test } from "node:test";
import assert from "node:assert/strict";
import { createMutableLLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import { acquireSingletonLock } from "../../../src/apps/api/server/singleton-lock.js";
import { buildToolFollowupLLMMessages } from "../../../src/contexts/agent-loop/src/application/tool-followup-messages.js";
import { fs, path, makeTempDir, namedClient } from "./llm-and-storage-helpers.js";

test("mutable LLM client delegates to the latest configured client", async () => {
  const first = namedClient("first");
  const second = namedClient("second");
  const client = createMutableLLMClient(first);

  assert.equal((await client.chat({ messages: [] })).message.content, "first");
  client.setClient(second);
  assert.equal((await client.chat({ messages: [] })).message.content, "second");
  assert.deepEqual(await client.listModels?.(), [{ id: "second" }]);
});

test("tool followup helper builds OpenAI-compatible image messages when preset supports images", () => {
  const root = makeTempDir("tool-followup-image");
  const filePath = path.join(root, "dress.jpg");
  fs.writeFileSync(filePath, Buffer.from("fake-image"));

  const result = buildToolFollowupLLMMessages({
    callId: "call_1",
    ok: true,
    output: "ok",
    llmFollowupAttachments: [{ kind: "image", path: filePath }]
  }, { supportsImage: true });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
  assert.equal(Array.isArray(result.messages[0].content), true);
  const content = Array.isArray(result.messages[0].content) ? result.messages[0].content : [];
  assert.equal(content[0]?.type, "image_url");
  assert.equal(content[0]?.type === "image_url" ? content[0].image_url.url : "", `data:image/jpeg;base64,${Buffer.from("fake-image").toString("base64")}`);
});

test("tool followup helper skips image messages when preset does not support images", () => {
  const root = makeTempDir("tool-followup-no-image");
  const filePath = path.join(root, "dress.jpg");
  fs.writeFileSync(filePath, Buffer.from("fake-image"));

  assert.deepEqual(buildToolFollowupLLMMessages({
    callId: "call_1",
    ok: true,
    output: "ok",
    llmFollowupAttachments: [{ kind: "image", path: filePath }]
  }, { supportsImage: false }).messages, []);
});

test("tool followup helper detects png content before declared mime", () => {
  const root = makeTempDir("tool-followup-png");
  const pngPath = path.join(root, "actual-png.jpg");
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00
  ]);
  fs.writeFileSync(pngPath, pngBytes);

  const pngResult = buildToolFollowupLLMMessages({
    callId: "call_2",
    ok: true,
    output: "ok",
    llmFollowupAttachments: [{ kind: "image", path: pngPath, mime: "image/jpeg" }]
  }, { supportsImage: true });
  const pngContent = pngResult.messages[0].content;
  assert.equal(Array.isArray(pngContent), true);
  assert.equal(Array.isArray(pngContent) ? pngContent[0]?.type : "", "image_url");
  assert.equal(
    Array.isArray(pngContent) && pngContent[0]?.type === "image_url" ? pngContent[0].image_url.url : "",
    `data:image/png;base64,${pngBytes.toString("base64")}`
  );
});

test("tool followup helper builds image messages from base64 data directly, without a file", () => {
  const base64 = Buffer.from("inline-image-bytes").toString("base64");
  const result = buildToolFollowupLLMMessages({
    callId: "call_3",
    ok: true,
    output: "ok",
    llmFollowupAttachments: [{ kind: "image", data: base64, mime: "image/webp" }]
  }, { supportsImage: true });

  assert.equal(result.messages.length, 1);
  const content = Array.isArray(result.messages[0].content) ? result.messages[0].content : [];
  assert.equal(content[0]?.type, "image_url");
  assert.equal(
    content[0]?.type === "image_url" ? content[0].image_url.url : "",
    `data:image/webp;base64,${base64}`
  );
});

test("singleton lock rejects another running process in the same memory root", () => {
  const root = makeTempDir("singleton-lock");
  const first = acquireSingletonLock(root, "api");
  try {
    assert.throws(() => acquireSingletonLock(root, "api"), /service_already_running/);
  } finally {
    first.release();
  }
  const second = acquireSingletonLock(root, "api");
  second.release();
});
