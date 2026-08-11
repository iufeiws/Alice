import type { SessionFileEntry } from "./archive-llm-session.js";

export function createLLMSessionListRuntime(input: {
  archive: { listSessionFiles(): SessionFileEntry[] };
}) {
  return {
    getClearedLLMSessions,
    getTalkLLMSessions,
    getMemoryLLMSessions
  };

  /**
   * 会话列表: 条目由 archive.listSessionFiles 从主库总表派生,
   * id 即存储 sessionId(不再是 .jsonl 相对路径), 详情按 id 单次读取。
   */
  function getClearedLLMSessions(): unknown[] {
    return listByAgentType("chat");
  }

  function getTalkLLMSessions(): unknown[] {
    return listByAgentType("talk");
  }

  function getMemoryLLMSessions(): unknown[] {
    return listByAgentType("memorize");
  }

  function listByAgentType(agentType: string): unknown[] {
    return input.archive.listSessionFiles()
      .filter((entry) => entry.agentType === agentType)
      .sort((left, right) => `${left.date}T${left.clock}`.localeCompare(`${right.date}T${right.clock}`))
      .slice(-50)
      .map(sessionFileListItem);
  }

  function sessionFileListItem(entry: SessionFileEntry): unknown {
    return {
      id: entry.filePath,
      agentId: entry.agentType,
      startedAt: `${entry.date}T${entry.clock}`,
      archiveFilePath: entry.filePath
    };
  }
}
