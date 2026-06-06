import { runChatAgentLoop, type ChatAgentLoopInput, type ChatAgentLoopResult, type ChatAgentLoopSession } from "./chat-loop.js";

export type TalkAgentLoopSession = ChatAgentLoopSession;
export type TalkAgentLoopInput = Omit<ChatAgentLoopInput, "llmInput"> & {
  llmInput: ChatAgentLoopInput["llmInput"];
};
export type TalkAgentLoopResult = ChatAgentLoopResult;

export async function runTalkAgentLoop(input: TalkAgentLoopInput): Promise<TalkAgentLoopResult> {
  return runChatAgentLoop({
    ...input,
    llmInput: {
      ...input.llmInput,
      agentId: "talk"
    }
  });
}
