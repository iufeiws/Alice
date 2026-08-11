/**
 * LLM 会话 current 指针: memory-files/llm-sessions/current.json。
 *
 * 指针只包含 sessionId/agentType 两个字段, 是指定"当前 chat/talk 会话"的唯一权威来源;
 * 数据库内任何状态都不能替代指针。写入用同目录临时文件 + rename 原子替换。
 */

const fs = await import("node:fs");
const path = await import("node:path");

export type LLMSessionPointer = {
  sessionId: number;
  agentType: string;
};

const POINTER_FILE_NAME = "current.json";

export function pointerFilePath(root: string): string {
  return path.join(root, POINTER_FILE_NAME);
}

/** 读取指针; 文件缺失或内容损坏返回 undefined(不猜测、不推断 current)。 */
export function readLLMSessionPointer(root: string): LLMSessionPointer | undefined {
  const filePath = pointerFilePath(root);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LLMSessionPointer>;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.sessionId !== "number" || !Number.isFinite(parsed.sessionId)) return undefined;
    if (typeof parsed.agentType !== "string" || parsed.agentType.length === 0) return undefined;
    return { sessionId: parsed.sessionId, agentType: parsed.agentType };
  } catch {
    return undefined;
  }
}

/** 原子写入指针: 同目录临时文件 + rename。 */
export function writeLLMSessionPointer(root: string, pointer: LLMSessionPointer): void {
  fs.mkdirSync(root, { recursive: true });
  const filePath = pointerFilePath(root);
  const temporaryPath = path.join(root, `${POINTER_FILE_NAME}.${process.pid}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify({
    sessionId: pointer.sessionId,
    agentType: pointer.agentType
  }, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

/** 删除指针; 清理失败静默忽略(会话数据已在数据库中, 指针丢失只影响 current 恢复)。 */
export function clearLLMSessionPointer(root: string): void {
  try {
    fs.rmSync(pointerFilePath(root), { force: true });
  } catch {
    // 忽略指针清理失败
  }
}
