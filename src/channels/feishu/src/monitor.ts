import type { FeishuConfig } from "./types.js";
import { createFeishuClient, type FeishuClientDeps } from "./client.js";

export function createFeishuMonitor(config: FeishuConfig, deps: FeishuClientDeps) {
  const client = createFeishuClient(config, deps);

  return {
    isStarted: client.isStarted,
    start: () => client.start(),
    stop: () => client.stop(),
    sendText: client.sendText,
    sendMarkdown: client.sendMarkdown,
    sendImage: client.sendImage,
    sendAudio: client.sendAudio,
    sendFile: client.sendFile,
    downloadAudioResource: client.downloadAudioResource,
    downloadMessageResource: client.downloadMessageResource,
    addReaction: client.addReaction,
    removeReaction: client.removeReaction,
    createApprovalCard: client.createApprovalCard,
    deleteMessage: client.deleteMessage,
    createAgentRunCard: client.createAgentRunCard,
    updateAgentRunCard: client.updateAgentRunCard,
    setAgentRunCardStreaming: client.setAgentRunCardStreaming,
    resolveAgentRunCardId: client.resolveAgentRunCardId,
    createToolExecutionCard: client.createToolExecutionCard,
    groupToolExecutionCard: client.groupToolExecutionCard,
    updateToolExecutionCard: client.updateToolExecutionCard,
    setToolExecutionCardStreaming: client.setToolExecutionCardStreaming
  };
}
