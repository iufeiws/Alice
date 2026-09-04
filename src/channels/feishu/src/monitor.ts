import type { FeishuConfig } from "./types.js";
import { createFeishuClient, type FeishuClientDeps } from "./client.js";

export function createFeishuMonitor(config: FeishuConfig, accountId: string, deps: FeishuClientDeps) {
  const client = createFeishuClient(config, accountId, deps);

  return {
    isStarted: client.isStarted,
    start: () => client.start(),
    stop: () => client.stop(),
    sendText: client.sendText,
    sendMarkdown: client.sendMarkdown,
    sendCoreCard: client.sendCoreCard,
    sendImage: client.sendImage,
    sendAudio: client.sendAudio,
    sendFile: client.sendFile,
    downloadAudioResource: client.downloadAudioResource,
    downloadMessageResource: client.downloadMessageResource,
    addReaction: client.addReaction,
    removeReaction: client.removeReaction,
    createApprovalCard: client.createApprovalCard,
    deleteMessage: client.deleteMessage,
    pinMessage: client.pinMessage,
    unpinMessage: client.unpinMessage,
    createAgentRunCard: client.createAgentRunCard,
    updateAgentRunCardBlocks: client.updateAgentRunCardBlocks,
    setAgentRunCardStreaming: client.setAgentRunCardStreaming,
    resolveAgentRunCardId: client.resolveAgentRunCardId,
    createToolExecutionCard: client.createToolExecutionCard,
    groupToolExecutionCard: client.groupToolExecutionCard,
    updateToolExecutionCard: client.updateToolExecutionCard,
    setToolExecutionCardStreaming: client.setToolExecutionCardStreaming
  };
}
