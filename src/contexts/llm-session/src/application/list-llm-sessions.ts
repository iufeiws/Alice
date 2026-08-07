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
   * 纯文件名列表: 会话文件路径 {agentType}/{date}/{clock}.jsonl 自带时间与 agent 类型,
   * 标题行只展示这两项; 详情在用户展开时按路径按需读取。
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
    const relativePath = `${entry.agentType}/${entry.date}/${entry.clock}.jsonl`;
    return {
      id: relativePath,
      agentId: entry.agentType,
      startedAt: `${entry.date}T${entry.clock}`,
      archiveFilePath: entry.filePath
    };
  }
}
