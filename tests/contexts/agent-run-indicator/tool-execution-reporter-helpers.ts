import type { FeishuDynamicCardClient } from "../../../src/channels/feishu/src/types.js";

export type FakeToolExecutionCardCall =
  | { kind: "create"; receiveId: string; toolName: string; call: string; result: string }
  | { kind: "append"; cardId: string; toolName: string; call: string; result: string; sequence: number }
  | { kind: "update"; cardId: string; block: "title" | "result"; content: string; sequence: number }
  | { kind: "stream"; cardId: string; enabled: boolean; sequence: number };

export function fakeFeishuCardClient(): FeishuDynamicCardClient & { calls: FakeToolExecutionCardCall[]; contents: string[] } {
  const calls: FakeToolExecutionCardCall[] = [];
  const contents: string[] = [];
  return {
    calls,
    contents,
    isStarted: () => true,
    async createApprovalCard() { throw new Error("unused"); },
    async createAgentRunCard() { throw new Error("unused"); },
    async updateAgentRunCard() { throw new Error("unused"); },
    async setAgentRunCardStreaming() { throw new Error("unused"); },
    async resolveAgentRunCardId() { return {}; },
    async createToolExecutionCard(input) {
      calls.push({ kind: "create", receiveId: input.receiveId, toolName: input.toolName, call: input.call, result: input.result });
      contents.push(input.call, input.result);
      return { messageId: "om_tool", cardId: "card_tool" };
    },
    async appendToolExecutionCardPanel(input) {
      calls.push({ kind: "append", cardId: input.cardId, toolName: input.toolName, call: input.call, result: input.result, sequence: input.sequence });
      contents.push(input.call, input.result);
    },
    async updateToolExecutionCard(input) {
      calls.push({ kind: "update", cardId: input.cardId, block: input.block, content: input.content, sequence: input.sequence });
      contents.push(input.content);
    },
    async setToolExecutionCardStreaming(input) {
      calls.push({ kind: "stream", cardId: input.cardId, enabled: input.enabled, sequence: input.sequence });
    }
  };
}
