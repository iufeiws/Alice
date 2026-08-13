import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseContext,
  createAdminHandler,
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  createRequest,
  createResponse,
  makeTempDir,
  promptStoragePath
} from "./admin-routes-helpers.js";

/**
 * Admin Clear API 测试（§8.2 / §12.4）:
 * - POST /admin/api/llm-chain/clear
 * - POST /admin/api/llm-run/cancel 中实际发生 session clear 的阶段
 * - POST /admin/api/memory/clear-session
 *
 * 成功响应至少包含 { ok: true, cleared: true, shortMemoryCaptured: true };
 * 无当前会话时返回 HTTP 200 { ok: true, cleared: false, shortMemoryCaptured: false };
 * Short Memory 或 clear 失败时返回非 2xx JSON 错误, 禁止返回异常堆栈。
 */

type ClearHandlerContext = Record<string, unknown>;

function makeHandler(overrides: ClearHandlerContext = {}) {
  const root = makeTempDir("admin-clear-api");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  return createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    ...overrides
  });
}

async function post(handler: ReturnType<typeof createAdminHandler>, url: string, body: Record<string, unknown> = {}) {
  const response = createResponse();
  await handler(createRequest("POST", url, body), response);
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    json = undefined;
  }
  return { status: response.statusCode, body: json };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    })
  ]);
}

function assertNoStack(body: unknown): void {
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /at .*\(.*\)/, "错误响应不得包含堆栈");
  assert.doesNotMatch(text, /Error:/, "错误响应不得泄漏异常消息");
}

// ---- POST /admin/api/llm-chain/clear ----

test("llm-chain/clear 成功返回 cleared:true 与 shortMemoryCaptured:true", async () => {
  const handler = makeHandler({
    clearLLMChainCache: async () => ({ cleared: true, shortMemoryCaptured: true })
  });

  const result = await post(handler, "/admin/api/llm-chain/clear");

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, cleared: true, shortMemoryCaptured: true });
});

test("llm-chain/clear 无当前会话返回 200 cleared:false", async () => {
  const handler = makeHandler({
    clearLLMChainCache: async () => ({ cleared: false, shortMemoryCaptured: false })
  });

  const result = await post(handler, "/admin/api/llm-chain/clear");

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, cleared: false, shortMemoryCaptured: false });
});

test("llm-chain/clear 失败返回非 2xx JSON 错误且不含堆栈", async () => {
  const handler = makeHandler({
    clearLLMChainCache() {
      throw new Error("short memory capture boom");
    }
  });

  const result = await post(handler, "/admin/api/llm-chain/clear");

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { ok: false, error: "internal_error" });
  assertNoStack(result.body);
});

test("llm-chain/clear 等待异步 clear 完成后再响应", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = makeHandler({
    clearLLMChainCache: async () => {
      await gate;
      return { cleared: true, shortMemoryCaptured: true };
    }
  });
  const response = createResponse();
  const pending = handler(createRequest("POST", "/admin/api/llm-chain/clear", {}), response);
  await flushMicrotasks();

  assert.equal(response.body, "", "异步 clear 完成前不得写响应");

  release?.();
  await withTimeout(pending);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, cleared: true, shortMemoryCaptured: true });
});

// ---- POST /admin/api/llm-run/cancel ----

test("llm-run/cancel 实际 clear 阶段成功返回 cleared:true", async () => {
  const handler = makeHandler({
    cancelActiveLLMRun: async () => ({
      ok: true,
      hadActiveRequest: true,
      cleared: true,
      shortMemoryCaptured: true
    })
  });

  const result = await post(handler, "/admin/api/llm-run/cancel");

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    hadActiveRequest: true,
    cleared: true,
    shortMemoryCaptured: true
  });
});

test("llm-run/cancel 无会话时 cleared:false", async () => {
  const handler = makeHandler({
    cancelActiveLLMRun: async () => ({
      ok: true,
      hadActiveRequest: false,
      cleared: false,
      shortMemoryCaptured: false
    })
  });

  const result = await post(handler, "/admin/api/llm-run/cancel");

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    hadActiveRequest: false,
    cleared: false,
    shortMemoryCaptured: false
  });
});

test("llm-run/cancel clear 失败返回非 2xx JSON 错误且不含堆栈", async () => {
  const handler = makeHandler({
    cancelActiveLLMRun() {
      throw new Error("cancel clear boom");
    }
  });

  const result = await post(handler, "/admin/api/llm-run/cancel");

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { ok: false, error: "internal_error" });
  assertNoStack(result.body);
});

test("llm-run/cancel 等待异步 clear 完成后再响应", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = makeHandler({
    cancelActiveLLMRun: async () => {
      await gate;
      return { ok: true, hadActiveRequest: true, cleared: true, shortMemoryCaptured: true };
    }
  });
  const response = createResponse();
  const pending = handler(createRequest("POST", "/admin/api/llm-run/cancel", {}), response);
  await flushMicrotasks();

  assert.equal(response.body, "", "异步 clear 完成前不得写响应");

  release?.();
  await withTimeout(pending);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    hadActiveRequest: true,
    cleared: true,
    shortMemoryCaptured: true
  });
});

// ---- POST /admin/api/memory/clear-session ----

test("memory/clear-session 成功返回 cleared:true 与 shortMemoryCaptured:true", async () => {
  const handler = makeHandler({
    clearMemoryInductionSession: async () => ({ cleared: true, shortMemoryCaptured: true })
  });

  const result = await post(handler, "/admin/api/memory/clear-session");

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, cleared: true, shortMemoryCaptured: true });
});

test("memory/clear-session 无 session 返回 200 cleared:false", async () => {
  const handler = makeHandler({
    clearMemoryInductionSession: async () => ({ cleared: false, shortMemoryCaptured: false })
  });

  const result = await post(handler, "/admin/api/memory/clear-session");

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, cleared: false, shortMemoryCaptured: false });
});

test("memory/clear-session 失败返回非 2xx JSON 错误且不含堆栈", async () => {
  const handler = makeHandler({
    clearMemoryInductionSession() {
      throw new Error("memory clear boom");
    }
  });

  const result = await post(handler, "/admin/api/memory/clear-session");

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { ok: false, error: "internal_error" });
  assertNoStack(result.body);
});

test("memory/clear-session 等待异步 clear 完成后再响应", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = makeHandler({
    clearMemoryInductionSession: async () => {
      await gate;
      return { cleared: true, shortMemoryCaptured: true };
    }
  });
  const response = createResponse();
  const pending = handler(createRequest("POST", "/admin/api/memory/clear-session", {}), response);
  await flushMicrotasks();

  assert.equal(response.body, "", "异步 clear 完成前不得写响应");

  release?.();
  await withTimeout(pending);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, cleared: true, shortMemoryCaptured: true });
});
