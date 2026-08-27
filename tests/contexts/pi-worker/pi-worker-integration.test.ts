import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiLLMRelay } from "../../../src/contexts/llm-gateway/src/pi-llm-relay.js";

// pi-coding-agent (undici 8.5) requires Node >= 22.19; the worker container
// ships a matching runtime. On older hosts point PI_WORKER_NODE_BIN at a
// compatible binary (e.g. `npx -y node@22`) or run this file under Node 22.
const workerNodeBin = process.env.PI_WORKER_NODE_BIN || process.execPath;
const workerNodePath = process.env.PI_WORKER_NODE_PATH || process.env.NODE_PATH;
const workerDir = path.resolve("src/contexts/pi-worker/runtime");
const workerEntry = path.join(workerDir, "worker.mjs");
const workerToken = "test-worker-token";
const relayToken = "test-relay-token";

const time = {
  timeZone: "Asia/Singapore",
  now: () => ({ iso: "2026-08-05T12:00:00.000", date: new Date("2026-08-05T04:00:00.000Z"), epochMs: 1785916800000 })
} as any;

const preset = {
  name: "model-a",
  baseURL: "http://127.0.0.1:1/v1",
  apiKey: "upstream-secret",
  model: "model-a",
  temperature: 0.2,
  maxTokens: 256,
  timeoutMs: 30_000,
  stream: true,
  useProxy: false,
  supportsImage: false,
  extraParams: {}
};

function ssePayload(text: string): string {
  const chunks = [
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    "[DONE]"
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
}

function startWorker(sessionRoot: string, relayPort: number): { child: ChildProcess; ready: Promise<number> } {
  const child = spawn(workerNodeBin, [workerEntry], {
    cwd: workerDir,
    env: {
      ...process.env,
      ...(workerNodePath ? { NODE_PATH: workerNodePath } : {}),
      PI_WORKER_PORT: "0",
      PI_WORKER_TOKEN: workerToken,
      PI_SESSION_ROOT: sessionRoot,
      HOME: sessionRoot,
      PI_MAX_CONCURRENCY: "1",
      PI_TASK_TIMEOUT_SECONDS: "60",
      PI_AGENT_TIMEZONE: "Asia/Singapore"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const ready = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`worker not ready; stderr:\n${stderr}`)), 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const match = /listening on port=(\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`worker exited early code=${code}; stderr:\n${stderr}`));
    });
  });
  return { child, ready };
}

test("real Pi worker: start/send/fork/auth/persistent sessions", { skip: Number(process.version.slice(1).split(".")[0]) < 22 ? "pi-coding-agent requires Node >= 22.19" : !workerNodePath ? "set PI_WORKER_NODE_PATH to a Node module path containing Pi" : false }, async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-integration-"));
  let requestCount = 0;
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async (_url, init) => {
      requestCount += 1;
      const text = `hello-${requestCount}`;
      const stalled = requestCount === 3; // third upstream request stalls until aborted
      if (JSON.parse(String(init?.body) ?? "{}").stream === true) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
            if (stalled) return; // never produces a chunk: exercises the cancel path
            controller.enqueue(encoder.encode(ssePayload(text)));
            controller.close();
          }
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-test", token: relayToken, preset });

  let worker: ChildProcess | undefined;
  let workerPort = 0;
  try {
    const { port, close } = await relay.start();
    try {
      const first = startWorker(sessionRoot, port);
      worker = first.child;
      workerPort = await first.ready;
      const base = () => `http://127.0.0.1:${workerPort}`;
      const headers = { authorization: `Bearer ${workerToken}`, "content-type": "application/json" };

      // Auth: every interface except /health requires the worker token.
      const noToken = await fetch(`${base()}/sessions`);
      assert.equal(noToken.status, 401);
      const wrongToken = await fetch(`${base()}/sessions`, { headers: { authorization: "Bearer wrong" } });
      assert.equal(wrongToken.status, 401);

      const post = (pathname: string, body?: unknown) => fetch(`${base()}${pathname}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then((response) => response.json() as Promise<any>);

      const get = (pathname: string) => fetch(`${base()}${pathname}`, { headers }).then((response) => response.json() as Promise<any>);

      // Runtime relay configuration updates the existing worker process without rebuilding its container.
      const nextRelayToken = "test-relay-token-2";
      relay.createCapability({ sandboxId: "sandbox-test", token: nextRelayToken, preset });
      const configured = await post("/config", {
        relayUrl: `http://127.0.0.1:${port}/v1`,
        relayToken: nextRelayToken
      });
      assert.deepEqual(configured, { ok: true });
      const configuredInvocation = await post("/invocations", { message: "Reply with exactly configured", model: "model-a", maxTokens: 128 });
      const configuredStatus = await waitForIdle(base, configuredInvocation.nickname, headers);
      const configuredCompletion = configuredStatus.terminalCompletions.find((entry: any) => entry.invocationId === configuredInvocation.invocationId);
      assert.equal(configuredCompletion?.text, "hello-1");

      // Start an invocation and wait for its completion.
      const started = await post("/invocations", { message: "Reply with exactly hello", model: "model-a", maxTokens: 128 });
      assert.ok(started.status === "running" || started.status === "queued");
      assert.equal(typeof started.sessionId, "string");
      assert.equal(typeof started.nickname, "string");
      const sessionId = started.sessionId;
      const nickname = started.nickname;
      const inv1 = started.invocationId;

      const status1 = await waitForIdle(base, nickname, headers);
      const completion1 = status1.terminalCompletions.find((entry: any) => entry.invocationId === inv1);
      assert.ok(completion1, "first invocation completed");
      assert.equal(completion1.status, "completed");
      assert.equal(completion1.text, "hello-1");

      // Second invocation on the same session; both completions stay distinct.
      const sent = await post(`/sessions/${encodeURIComponent(nickname)}/send`, { message: "Reply with exactly bye", model: "model-a", maxTokens: 128 });
      const inv2 = sent.invocationId;
      assert.notEqual(inv2, inv1);
      const status2 = await waitForIdle(base, nickname, headers);
      const completions = status2.terminalCompletions as Array<{ invocationId: string; text: string; status: string }>;
      const byInvocation = new Map<string, { invocationId: string; text: string; status: string }>(completions.map((entry) => [entry.invocationId, entry]));
      assert.equal(byInvocation.get(inv1)?.text, "hello-1");
      assert.equal(byInvocation.get(inv2)?.text, "hello-2");

      // Session messages contain both user prompts and both assistant replies.
      const read = await get(`/sessions/${encodeURIComponent(nickname)}/messages?access=:`);
      const texts = JSON.stringify(read);
      assert.ok(texts.includes("Reply with exactly hello"), "first user message persisted");
      assert.ok(texts.includes("hello-1"), "first assistant reply persisted");
      assert.ok(texts.includes("Reply with exactly bye"), "second user message persisted");
      assert.ok(texts.includes("hello-2"), "second assistant reply persisted");

      // Cancel a running invocation: the stalled upstream request is aborted
      // and the invocation ends as aborted; the session stays reusable.
      const cancelled = await post(`/sessions/${encodeURIComponent(nickname)}/send`, { message: "stall forever", model: "model-a", maxTokens: 128 });
      const inv3 = cancelled.invocationId;
      const cancelledStatus = await post(`/sessions/${encodeURIComponent(nickname)}/cancel`);
      assert.equal(cancelledStatus, "cancelled");
      const status3 = await waitForIdle(base, nickname, headers);
      const completion3 = status3.terminalCompletions.find((entry: any) => entry.invocationId === inv3);
      assert.equal(completion3?.status, "aborted");
      assert.equal(completion3?.text, "pi_session_aborted");
      const afterCancel = await post(`/sessions/${encodeURIComponent(nickname)}/send`, { message: "Reply with exactly done", model: "model-a", maxTokens: 128 });
      assert.ok(afterCancel.invocationId);
      const status4 = await waitForIdle(base, nickname, headers);
      const completion4 = status4.terminalCompletions.find((entry: any) => entry.invocationId === afterCancel.invocationId);
      assert.equal(completion4?.status, "completed");
      assert.equal(completion4?.text, "hello-4");

      // Fork creates a new persistent session.
      const forked = await post(`/sessions/${encodeURIComponent(nickname)}/fork`);
      assert.equal(typeof forked.sessionId, "string");
      assert.notEqual(forked.sessionId, sessionId);
      assert.equal(typeof forked.nickname, "string");
      const sessions = await get("/sessions");
      assert.ok(Array.isArray(sessions) && sessions.length >= 2);

      // Worker restart: the persisted JSONL rebuilds every invocation with its own text.
      worker.kill("SIGTERM");
      await new Promise<void>((resolve) => worker!.once("exit", () => resolve()));
      worker = undefined;
      const second = startWorker(sessionRoot, port);
      worker = second.child;
      workerPort = await second.ready;
      const rebuilt = await waitForIdle(base, nickname, headers);
      const rebuiltByInvocation = new Map((rebuilt.terminalCompletions as Array<{ invocationId: string; text: string; status: string }>).map((entry) => [entry.invocationId, entry]));
      assert.equal(rebuiltByInvocation.get(inv1)?.status, "completed");
      assert.equal(rebuiltByInvocation.get(inv1)?.text, "hello-1");
      assert.equal(rebuiltByInvocation.get(inv2)?.status, "completed");
      assert.equal(rebuiltByInvocation.get(inv2)?.text, "hello-2");
    } finally {
      await close();
    }
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill("SIGTERM");
      await new Promise<void>((resolve) => worker!.once("exit", () => resolve()));
    }
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test("real Pi worker: reasoning relay uses the system role", { skip: Number(process.version.slice(1).split(".")[0]) < 22 ? "pi-coding-agent requires Node >= 22.19" : !workerNodePath ? "set PI_WORKER_NODE_PATH to a Node module path containing Pi" : false }, async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-role-"));
  let requestBody: Record<string, unknown> | undefined;
  const relay = createPiLLMRelay({
    time,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body) ?? "{}") as Record<string, unknown>;
      return new Response(ssePayload("ok"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  relay.createCapability({ sandboxId: "sandbox-role", token: relayToken, preset });

  let worker: ChildProcess | undefined;
  try {
    const { port, close } = await relay.start();
    try {
      const started = startWorker(sessionRoot, port);
      worker = started.child;
      const workerPort = await started.ready;
      const base = `http://127.0.0.1:${workerPort}`;
      const headers = { authorization: `Bearer ${workerToken}`, "content-type": "application/json" };
      const post = (pathname: string, body?: unknown) => fetch(`${base}${pathname}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then((response) => response.json() as Promise<any>);

      await post("/config", { relayUrl: `http://127.0.0.1:${port}/v1`, relayToken });
      const invocation = await post("/invocations", { message: "Reply with exactly ok", model: "model-a", maxTokens: 128, reasoning: true });
      const status = await waitForIdle(() => base, invocation.nickname, headers);
      assert.equal(status.terminalCompletions[0]?.status, "completed");
      assert.equal((requestBody?.messages as Array<{ role?: string }>)[0]?.role, "system");
    } finally {
      await close();
    }
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill("SIGTERM");
      await new Promise<void>((resolve) => worker!.once("exit", () => resolve()));
    }
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

async function waitForIdle(base: () => string, nickname: string, headers: Record<string, string>, timeoutMs = 90_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await fetch(`${base()}/sessions/${encodeURIComponent(nickname)}/snapshot`, { headers }).then((response) => response.json());
    if (last.idle && last.terminalCompletions?.length) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`session never became idle: ${JSON.stringify(last)}`);
}
