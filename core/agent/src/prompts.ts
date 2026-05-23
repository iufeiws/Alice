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
      "You are Alice's placeholder agent runtime. Keep replies brief until real agent logic is implemented."
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
