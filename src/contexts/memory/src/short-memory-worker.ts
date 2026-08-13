import { describeError } from "../../../shared/errors/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { ShortMemoryEntry, ShortMemoryStore, ShortMemoryTransaction } from "./short-memory-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type ShortMemoryFile = {
  read(): Promise<{
    exists: boolean;
    content: string;
  }>;
  replace(content: string): Promise<void>;
};

export type ShortMemoryCaptureResult =
  | { captured: false; reason: "missing" | "empty" | "symbols_only" }
  | { captured: true; entry: ShortMemoryEntry };

export type ShortMemoryWorker = {
  captureBeforeSessionClear(): Promise<ShortMemoryCaptureResult>;
};

const SHORT_MEMORY_FILE_NAME = ".short_memory.txt";
const SHORT_MEMORY_RESET_CONTENT = "\n";
const SHORT_MEMORY_VALID_CONTENT = /[\p{L}\p{N}]/u;

export function createShortMemoryWorker(input: {
  file: ShortMemoryFile;
  store: ShortMemoryStore;
  time: CurrentTimeProvider;
}): ShortMemoryWorker {
  // 单一串行队列：后一个 capture 请求必须等前一个完整结束（成功或失败）才开始。
  let queue: Promise<void> = Promise.resolve();
  return {
    captureBeforeSessionClear(): Promise<ShortMemoryCaptureResult> {
      const run = queue.then(() => captureOnce(input));
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }
  };
}

/**
 * 单次采集（§5.3 固定顺序）：
 * read → 校验 trim → beginWrite → insert（未提交）→ file.replace("\n") → commit。
 * 只在事务回滚与文件补偿所必需的边界捕获错误。
 */
async function captureOnce(input: {
  file: ShortMemoryFile;
  store: ShortMemoryStore;
  time: CurrentTimeProvider;
}): Promise<ShortMemoryCaptureResult> {
  const file = await input.file.read();
  if (!file.exists) return { captured: false, reason: "missing" };
  const content = file.content.trim();
  if (content === "") return { captured: false, reason: "empty" };
  if (!SHORT_MEMORY_VALID_CONTENT.test(content)) return { captured: false, reason: "symbols_only" };

  let tx: ShortMemoryTransaction | undefined;
  let rolledBack = false;
  try {
    tx = input.store.beginWrite();
    // createdAt 与 createdAtUtc 必须来自同一次 now()（§3.4）。
    const now = input.time.now();
    const entry = tx.insert({
      createdAt: now.iso,
      createdAtUtc: now.date.toISOString(),
      content
    });
    try {
      await input.file.replace(SHORT_MEMORY_RESET_CONTENT);
    } catch (error) {
      // replace 失败：回滚事务；同目录原子 rename 保证目标文件仍为旧内容。
      rollbackQuietly(tx);
      rolledBack = true;
      throw error;
    }
    try {
      tx.commit();
    } catch (commitError) {
      // commit 失败：先回滚，再补偿恢复原文件，最后抛出原始提交错误；
      // 恢复也失败时抛出同时包含两个失败信息的组合错误。
      rollbackQuietly(tx);
      rolledBack = true;
      try {
        await input.file.replace(file.content);
      } catch (restoreError) {
        throw new Error(
          `Short Memory 提交失败（${describeError(commitError)}），且原文件恢复失败（${describeError(restoreError)}）`
        );
      }
      throw commitError;
    }
    return { captured: true, entry };
  } catch (error) {
    if (tx && !rolledBack) rollbackQuietly(tx);
    throw error;
  }
}

function rollbackQuietly(tx: ShortMemoryTransaction): void {
  try {
    tx.rollback();
  } catch {
    // 回滚只用于清理未提交事务；回滚失败时以原始错误为准继续传播，不吞掉原始错误。
  }
}

/**
 * 宿主映射文件（§5.2）：容器内 ~/.short_memory.txt 对应宿主 hostWorkspaceDir/.short_memory.txt。
 * 读取、写入、rename 或权限错误均直接抛出；文件不存在返回 { exists: false, content: "" }。
 */
export function createHostShortMemoryFile(input: {
  hostWorkspaceDir: string;
}): ShortMemoryFile {
  const hostDir = path.resolve(input.hostWorkspaceDir);
  const filePath = path.resolve(hostDir, SHORT_MEMORY_FILE_NAME);
  const relative = path.relative(hostDir, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Short Memory 宿主文件路径越界：${filePath} 不在 hostWorkspaceDir（${hostDir}）内`);
  }
  return {
    async read() {
      try {
        const content = await fs.promises.readFile(filePath, "utf8");
        return { exists: true, content };
      } catch (error) {
        if (isNoSuchFileError(error)) return { exists: false, content: "" };
        throw error;
      }
    },
    async replace(content) {
      await fs.promises.mkdir(hostDir, { recursive: true });
      // 同目录临时文件 + rename 原子替换（§5.2）。
      const tempPath = path.join(hostDir, `.${SHORT_MEMORY_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
      await fs.promises.writeFile(tempPath, content, "utf8");
      await fs.promises.rename(tempPath, filePath);
    }
  };
}

function isNoSuchFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
