export type PromptContextPrimitive = string | number | boolean | null | undefined;
export type PromptContextValue = PromptContextPrimitive | PromptContextValue[] | { [key: string]: PromptContextValue };

export type PromptContextRuntime = {
  renderText(content: string): string;
  getVariable(name: string): PromptContextValue;
  listVariables(): string[];
};
