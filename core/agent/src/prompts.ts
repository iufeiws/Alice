export type PromptDefinition = {
  id: string;
  name: string;
  scope: "agent" | "router" | "tool" | "renderer";
  description: string;
  content: string;
};

export const defaultPromptRegistry: PromptDefinition[] = [
  {
    id: "agent.placeholder.system",
    name: "Placeholder Agent System Prompt",
    scope: "agent",
    description: "Temporary system prompt used until real agent behavior is implemented.",
    content:
      [
        "You are Alice's agent runtime. Keep replies concise and useful.",
        "Use messaging tools when they directly help the user:",
        "- view_messages reads the current conversation. Default scope is today; use scope=new for messages since the last tool view.",
        "- search_messages searches persisted current-conversation messages for relevant context. Default direction is backward, limit is 3, contextCount is 10.",
        "- send_message sends to the current conversation. Default type is message. In message mode, newline-separated content is sent as multiple messages.",
        "- When using send_message with type=message for a multi-line response, write each message segment followed by a newline in content so streaming can send each segment as it is produced.",
        "Do not mention platform-specific implementation names when choosing tools."
      ].join("\n")
  },
  {
    id: "router.codex.not_implemented",
    name: "Codex Command Placeholder",
    scope: "router",
    description: "Response used when a /codex command is routed before the Codex worker exists.",
    content:
      "Codex command accepted by router, but Codex worker is not implemented yet."
  }
];

export function getPromptContent(id: string): string {
  const prompt = defaultPromptRegistry.find((item) => item.id === id);
  if (!prompt) {
    throw new Error(`Prompt not found: ${id}`);
  }

  return prompt.content;
}
