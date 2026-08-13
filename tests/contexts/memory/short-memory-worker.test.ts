import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCurrentTimeProvider, formatZonedIso } from "../../../src/platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../src/shared/clock/src/index.js";
import { createShortMemoryStore } from "../../../src/contexts/memory/src/short-memory-store.js";
import type { ShortMemoryStore } from "../../../src/contexts/memory/src/short-memory-store.js";
import {
  createHostShortMemoryFile,
  createShortMemoryWorker
} from "../../../src/contexts/memory/src/short-memory-worker.js";
import type { ShortMemoryFile, ShortMemoryWorker } from "../../../src/contexts/memory/src/short-memory-worker.js";

function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 固定 instant：2026-08-13T06:30:00.000Z，Asia/Singapore 下 wall-clock 为 2026-08-13T14:30:00.000
const FIXED_UTC = "2026-08-13T06:30:00.000Z";

function testTime(): CurrentTimeProvider {
  return createCurrentTimeProvider("Asia/Singapore", () => new Date(FIXED_UTC));
}

function workerWith(file: ShortMemoryFile, store: ShortMemoryStore, time: CurrentTimeProvider = testTime()): ShortMemoryWorker {
  return createShortMemoryWorker({ file, store, time });
}

/** 可注入 read/replace 失败、记录 replace 参数与读取次数的 fake file port */
function makeFakeFile(initial: { exists: boolean; content: string }) {
  let content = initial.content;
  let exists = initial.exists;
  let reads = 0;
  const replaceLog: string[] = [];
  const readFailures: Array<Error | null> = [];
  const replaceFailures: Array<Error | null> = [];
  const file: ShortMemoryFile = {
    async read() {
      reads += 1;
      const failure = readFailures.shift();
      if (failure) throw failure;
      return { exists, content };
    },
    async replace(next: string) {
      const failure = replaceFailures.shift();
      if (failure) throw failure;
      replaceLog.push(next);
      content = next;
      exists = true;
    }
  };
  return {
    file,
    reads: () => reads,
    content: () => content,
    replaceLog,
    failNextRead(error: Error) {
      readFailures.push(error);
    },
    failNextReplace(error: Error) {
      replaceFailures.push(error);
    },
    failReplaceOnAttempt(attempt: number, error: Error) {
      while (replaceFailures.length < attempt - 1) replaceFailures.push(null);
      replaceFailures.push(error);
    }
  };
}

/** 包装真实 SQLite store，注入失败并记录事务事件 */
function controllableStore(real: ShortMemoryStore, hooks: {
  onBeginWrite?: () => void;
  onInsert?: () => void;
  onCommit?: () => void;
  onRollback?: () => void;
  insertError?: Error;
  commitError?: Error;
} = {}): ShortMemoryStore {
  return {
    beginWrite() {
      hooks.onBeginWrite?.();
      const tx = real.beginWrite();
      return {
        insert(input) {
          hooks.onInsert?.();
          if (hooks.insertError) throw hooks.insertError;
          return tx.insert(input);
        },
        commit() {
          hooks.onCommit?.();
          if (hooks.commitError) throw hooks.commitError;
          return tx.commit();
        },
        rollback() {
          hooks.onRollback?.();
          return tx.rollback();
        }
      };
    },
    listLatest(limit) {
      return real.listLatest(limit);
    },
    listByCreatedAtUtcRange(input) {
      return real.listByCreatedAtUtcRange(input);
    }
  };
}

// §12.2-1 文件不存在
test("captureBeforeSessionClear returns missing when the file does not exist and leaves the store empty", async () => {
  const root = makeTempDir("worker-missing");
  const hostWorkspaceDir = path.join(root, "sandbox", "bash", "alice");
  fs.mkdirSync(hostWorkspaceDir, { recursive: true });
  const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const worker = createShortMemoryWorker({
    file: createHostShortMemoryFile({ hostWorkspaceDir }),
    store,
    time: testTime()
  });
  const result = await worker.captureBeforeSessionClear();
  assert.deepEqual(result, { captured: false, reason: "missing" });
  assert.deepEqual(store.listLatest(10), []);
  assert.equal(fs.existsSync(path.join(hostWorkspaceDir, ".short_memory.txt")), false, "不得创建文件");
});

// §12.2-2 空字符串与仅换行（含纯空白）
test("captureBeforeSessionClear treats empty, newline-only and whitespace-only content as empty", async () => {
  for (const content of ["", "\n", "\r\n", "   \n  \t "]) {
    const root = makeTempDir("worker-empty");
    const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
    const fake = makeFakeFile({ exists: true, content });
    const worker = workerWith(fake.file, store);
    const result = await worker.captureBeforeSessionClear();
    assert.deepEqual(result, { captured: false, reason: "empty" }, `content=${JSON.stringify(content)}`);
    assert.deepEqual(store.listLatest(10), [], "空内容不得写入");
    assert.deepEqual(fake.replaceLog, [], "空内容不得重置文件");
    assert.equal(fake.content(), content, "文件内容不得被修改");
  }
});

// §12.2-3 纯 ASCII/中文标点
test("captureBeforeSessionClear skips punctuation-only content without touching the file", async () => {
  for (const content of ["!!!", "？。，！", "...,---", "!?.,;:"]) {
    const root = makeTempDir("worker-punctuation");
    const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
    const fake = makeFakeFile({ exists: true, content });
    const worker = workerWith(fake.file, store);
    const result = await worker.captureBeforeSessionClear();
    assert.deepEqual(result, { captured: false, reason: "symbols_only" }, `content=${JSON.stringify(content)}`);
    assert.deepEqual(store.listLatest(10), [], "纯标点不得写入");
    assert.deepEqual(fake.replaceLog, [], "纯标点不得重置文件");
    assert.equal(fake.content(), content, "纯标点文件内容不得被修改");
  }
});

// §12.2-4 纯 emoji
test("captureBeforeSessionClear skips emoji-only content without touching the file", async () => {
  for (const content of ["😀🎉", "😀  🎉  ", "👍🏻🙏"]) {
    const root = makeTempDir("worker-emoji");
    const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
    const fake = makeFakeFile({ exists: true, content });
    const worker = workerWith(fake.file, store);
    const result = await worker.captureBeforeSessionClear();
    assert.deepEqual(result, { captured: false, reason: "symbols_only" }, `content=${JSON.stringify(content)}`);
    assert.deepEqual(store.listLatest(10), [], "纯 emoji 不得写入");
    assert.deepEqual(fake.replaceLog, [], "纯 emoji 不得重置文件");
  }
});

// §12.2-5 拉丁字母、中文、其他 Unicode 字母、ASCII 与非 ASCII 数字
test("captureBeforeSessionClear captures content containing Unicode letters or numbers", async () => {
  const cases: Array<{ input: string; expected: string }> = [
    { input: "hello world", expected: "hello world" },       // 拉丁字母
    { input: "中文内容", expected: "中文内容" },                // 中文
    { input: "Привет мир", expected: "Привет мир" },         // 西里尔字母
    { input: "café résumé", expected: "café résumé" },       // 带变音符号字母
    { input: "12345", expected: "12345" },                   // ASCII 数字
    { input: "１２３４５", expected: "１２３４５" },            // 全角数字（\p{N}）
    { input: "٣٤٥", expected: "٣٤٥" },                       // 阿拉伯-印度数字（\p{N}）
    { input: "  mixed 中文 123  ", expected: "mixed 中文 123" }
  ];
  for (const item of cases) {
    const root = makeTempDir("worker-unicode");
    const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
    const fake = makeFakeFile({ exists: true, content: item.input });
    const worker = workerWith(fake.file, store);
    const result = await worker.captureBeforeSessionClear();
    assert.equal(result.captured, true, `输入 ${JSON.stringify(item.input)} 必须判定为有效`);
    if (result.captured) {
      assert.equal(result.entry.content, item.expected);
      assert.equal(result.entry.id, 1);
      assert.equal(result.entry.createdAtUtc, FIXED_UTC);
      assert.equal(result.entry.createdAt, "2026-08-13T14:30:00.000");
    }
    assert.deepEqual(store.listLatest(10).map((row) => row.content), [item.expected]);
    assert.deepEqual(fake.replaceLog, ["\n"]);
  }
});

// §12.2-6 trim 后写入
test("captureBeforeSessionClear stores the trimmed content", async () => {
  const root = makeTempDir("worker-trim");
  const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const fake = makeFakeFile({ exists: true, content: "  \n\thello world\n\t  " });
  const worker = workerWith(fake.file, store);
  const result = await worker.captureBeforeSessionClear();
  assert.equal(result.captured, true);
  if (result.captured) assert.equal(result.entry.content, "hello world");
  assert.deepEqual(store.listLatest(10).map((row) => row.content), ["hello world"]);
  assert.deepEqual(fake.replaceLog, ["\n"]);
});

// §12.2-7 写库成功后严格重置为 "\n"（字节严格等于 0x0A）
test("captureBeforeSessionClear resets the file to exactly one newline byte after success", async () => {
  const root = makeTempDir("worker-reset");
  const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const fake = makeFakeFile({ exists: true, content: "  记住我  \n" });
  const worker = workerWith(fake.file, store);
  const result = await worker.captureBeforeSessionClear();
  assert.equal(result.captured, true);
  assert.equal(fake.replaceLog.length, 1);
  assert.ok(
    Buffer.from(fake.replaceLog[0]).equals(Buffer.from([0x0a])),
    "replace 参数必须严格等于单个 0x0A 字节"
  );
  // 真实宿主文件同样只含 0x0A
  const hostRoot = makeTempDir("worker-reset-host");
  const hostWorkspaceDir = path.join(hostRoot, "alice");
  fs.mkdirSync(hostWorkspaceDir, { recursive: true });
  fs.writeFileSync(path.join(hostWorkspaceDir, ".short_memory.txt"), "宿主内容\n", "utf8");
  const store2 = createShortMemoryStore(path.join(hostRoot, "alice.sqlite"));
  const hostWorker = createShortMemoryWorker({
    file: createHostShortMemoryFile({ hostWorkspaceDir }),
    store: store2,
    time: testTime()
  });
  await hostWorker.captureBeforeSessionClear();
  const bytes = fs.readFileSync(path.join(hostWorkspaceDir, ".short_memory.txt"));
  assert.ok(bytes.equals(Buffer.from([0x0a])), "宿主文件字节必须严格等于 0x0A");
});

// §12.2-8 宿主文件 read 失败
test("captureBeforeSessionClear propagates host file read failures", async () => {
  const root = makeTempDir("worker-read-error");
  const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const fake = makeFakeFile({ exists: true, content: "content" });
  fake.failNextRead(new Error("read-boom"));
  const worker = workerWith(fake.file, store);
  await assert.rejects(worker.captureBeforeSessionClear(), /read-boom/);
  assert.deepEqual(store.listLatest(10), [], "read 失败不得写入");
  assert.deepEqual(fake.replaceLog, [], "read 失败不得重置文件");
  // 真实宿主文件：目标路径是目录时读取必须报错并向上传播
  const hostRoot = makeTempDir("worker-read-error-host");
  const hostWorkspaceDir = path.join(hostRoot, "alice");
  fs.mkdirSync(path.join(hostWorkspaceDir, ".short_memory.txt"), { recursive: true });
  const hostWorker = createShortMemoryWorker({
    file: createHostShortMemoryFile({ hostWorkspaceDir }),
    store: createShortMemoryStore(path.join(hostRoot, "alice.sqlite")),
    time: testTime()
  });
  await assert.rejects(hostWorker.captureBeforeSessionClear());
});

// §12.2-9 INSERT 失败
test("captureBeforeSessionClear rolls back and keeps the file when insert fails", async () => {
  const root = makeTempDir("worker-insert-error");
  const realStore = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const events: string[] = [];
  const store = controllableStore(realStore, {
    onBeginWrite: () => events.push("beginWrite"),
    onRollback: () => events.push("rollback"),
    insertError: new Error("insert-boom")
  });
  const fake = makeFakeFile({ exists: true, content: "原始内容" });
  const worker = workerWith(fake.file, store);
  await assert.rejects(worker.captureBeforeSessionClear(), /insert-boom/);
  assert.deepEqual(events, ["beginWrite", "rollback"], "insert 失败必须回滚已开启事务");
  assert.deepEqual(fake.replaceLog, [], "insert 失败不得重置文件");
  assert.equal(fake.content(), "原始内容", "文件必须保持原内容");
  assert.deepEqual(realStore.listLatest(10), [], "不得留下已提交记录");
});

// §12.2-10 reset 失败并回滚
test("captureBeforeSessionClear rolls back when the file reset fails", async () => {
  const root = makeTempDir("worker-reset-error");
  const realStore = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const events: string[] = [];
  const store = controllableStore(realStore, { onRollback: () => events.push("rollback") });
  const fake = makeFakeFile({ exists: true, content: "原始内容" });
  fake.failNextReplace(new Error("replace-boom"));
  const worker = workerWith(fake.file, store);
  await assert.rejects(worker.captureBeforeSessionClear(), /replace-boom/);
  assert.deepEqual(events, ["rollback"], "reset 失败必须回滚事务");
  assert.equal(fake.content(), "原始内容", "文件必须保持旧内容");
  assert.deepEqual(realStore.listLatest(10), [], "reset 失败不得留下已提交记录");
});

// §12.2-11 commit 失败并恢复原内容
test("captureBeforeSessionClear restores the original file content when commit fails", async () => {
  const root = makeTempDir("worker-commit-error");
  const realStore = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const events: string[] = [];
  const store = controllableStore(realStore, {
    onRollback: () => events.push("rollback"),
    commitError: new Error("commit-boom")
  });
  const fake = makeFakeFile({ exists: true, content: "原始内容" });
  const worker = workerWith(fake.file, store);
  await assert.rejects(worker.captureBeforeSessionClear(), /commit-boom/);
  assert.deepEqual(fake.replaceLog, ["\n", "原始内容"], "必须先重置为换行，再补偿恢复原内容");
  assert.equal(fake.content(), "原始内容", "文件最终必须恢复为原内容");
  assert.deepEqual(events, ["rollback"], "commit 失败必须回滚事务");
  assert.deepEqual(realStore.listLatest(10), [], "commit 失败不得留下已提交记录");
});

// §12.2-12 commit 与 restore 同时失败时组合错误可观察
test("captureBeforeSessionClear reports a combined error when commit and restore both fail", async () => {
  const root = makeTempDir("worker-double-error");
  const realStore = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const commitError = new Error("commit-boom");
  const store = controllableStore(realStore, { commitError });
  const fake = makeFakeFile({ exists: true, content: "原始内容" });
  fake.failReplaceOnAttempt(2, new Error("restore-boom")); // 第一次 replace（重置）成功，第二次（恢复）失败
  const worker = workerWith(fake.file, store);
  await assert.rejects(
    worker.captureBeforeSessionClear(),
    (error: unknown) => {
      assert.ok(error instanceof Error, "必须抛出组合错误");
      assert.ok(!(error === commitError), "不得直接抛出原始 commit 错误");
      assert.ok(error.message.includes("commit-boom"), `组合错误必须包含 commit 失败信息，实际: ${error.message}`);
      assert.ok(error.message.includes("restore-boom"), `组合错误必须包含恢复失败信息，实际: ${error.message}`);
      return true;
    }
  );
});

// §12.2-13 两个 capture 并发时严格串行
test("captureBeforeSessionClear runs strictly serially under concurrent requests", async () => {
  const root = makeTempDir("worker-serial");
  const realStore = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const events: string[] = [];
  const store = controllableStore(realStore, {
    onBeginWrite: () => events.push("beginWrite"),
    onInsert: () => events.push("insert"),
    onCommit: () => events.push("commit"),
    onRollback: () => events.push("rollback")
  });
  let content = "第一条记忆";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const file: ShortMemoryFile = {
    async read() {
      events.push("read");
      return { exists: true, content };
    },
    async replace(next: string) {
      events.push("replace");
      await gate;
      content = next;
    }
  };
  const worker = createShortMemoryWorker({ file, store, time: testTime() });
  const first = worker.captureBeforeSessionClear();
  await tick();
  assert.deepEqual(events, ["read", "beginWrite", "insert", "replace"], "第一个 capture 应阻塞在 replace");
  const second = worker.captureBeforeSessionClear();
  await tick();
  assert.deepEqual(events, ["read", "beginWrite", "insert", "replace"], "第二个 capture 必须等待第一个完整结束");
  release();
  const firstResult = await first;
  const secondResult = await second;
  assert.deepEqual(
    events,
    ["read", "beginWrite", "insert", "replace", "commit", "read"],
    "第二个 capture 的读取必须发生在第一个 commit 之后"
  );
  assert.equal(firstResult.captured, true);
  assert.deepEqual(secondResult, { captured: false, reason: "empty" }, "第二个 capture 应读取到已重置的空文件");
});

// §12.2-14 容器路径与宿主 hostWorkspaceDir/.short_memory.txt 指向同一挂载文件
test("host file maps the container path to hostWorkspaceDir and stays inside it", async () => {
  const root = makeTempDir("worker-host-mapping");
  const hostWorkspaceDir = path.join(root, "sandbox", "bash", "alice");
  fs.mkdirSync(hostWorkspaceDir, { recursive: true });
  const workspaceDir = "/home/alice";
  const containerPath = path.posix.join(workspaceDir, ".short_memory.txt");
  assert.equal(containerPath, "/home/alice/.short_memory.txt");
  const hostPath = path.resolve(hostWorkspaceDir, ".short_memory.txt");
  const file = createHostShortMemoryFile({ hostWorkspaceDir });
  await file.replace("memo\n");
  assert.equal(fs.readFileSync(hostPath, "utf8"), "memo\n", "必须写入 hostWorkspaceDir 下的映射路径");
  // 挂载对应：容器路径相对 workspaceDir 的偏移在宿主下解析到同一文件
  const containerRelative = path.posix.relative(workspaceDir, containerPath);
  assert.equal(containerRelative, ".short_memory.txt");
  assert.equal(path.resolve(hostWorkspaceDir, containerRelative), hostPath);
  const read = await file.read();
  assert.deepEqual(read, { exists: true, content: "memo\n" });
  // 校验解析结果仍位于 hostWorkspaceDir 内
  const relative = path.relative(hostWorkspaceDir, hostPath);
  assert.ok(
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
    "解析路径必须位于 hostWorkspaceDir 内"
  );
});

// §12.2-15 本地时间与 UTC 时间只取一次当前 instant，并按配置时区正确转换
// 参照 messages.created_at / created_at_utc 现有双字段约定：
// createdAt = time.now().iso（配置时区 wall-clock，无 Z 无 offset），createdAtUtc = time.now().date.toISOString()（UTC Z）
test("captureBeforeSessionClear takes one instant and stores UTC plus configured-timezone wall clock", async () => {
  const root = makeTempDir("worker-time");
  const store = createShortMemoryStore(path.join(root, "alice.sqlite"));
  const fake = makeFakeFile({ exists: true, content: "时间一致性" });
  const at = new Date("2026-08-13T23:45:00.000Z"); // 跨日 instant：新加坡为 08-14 早上
  let calls = 0;
  const base = createCurrentTimeProvider("Asia/Singapore", () => at);
  const time: CurrentTimeProvider = {
    get timeZone() {
      return base.timeZone;
    },
    now() {
      calls += 1;
      return base.now();
    },
    addMs(ms: number, from?: Date) {
      return base.addMs(ms, from);
    }
  };
  const worker = createShortMemoryWorker({ file: fake.file, store, time });
  const result = await worker.captureBeforeSessionClear();
  assert.equal(calls, 1, "created_at 与 created_at_utc 必须来自同一次 now()");
  assert.equal(result.captured, true);
  if (result.captured) {
    assert.equal(result.entry.createdAtUtc, "2026-08-13T23:45:00.000Z", "created_at_utc 必须是 UTC Z");
    assert.equal(result.entry.createdAt, "2026-08-14T07:45:00.000", "created_at 必须是配置时区 wall-clock（无 Z 无 offset）");
    assert.equal(result.entry.createdAt, formatZonedIso(at, "Asia/Singapore"), "必须与项目时间提供器转换结果一致");
  }
  const stored = store.listLatest(10)[0];
  assert.equal(stored.createdAtUtc, "2026-08-13T23:45:00.000Z");
  assert.equal(stored.createdAt, "2026-08-14T07:45:00.000");
  assert.equal(stored.content, "时间一致性");
});
