export type PromptContextPrimitive = string | number | boolean | null | undefined;
export type PromptContextValue = PromptContextPrimitive | PromptContextValue[] | { [key: string]: PromptContextValue };
export type PromptContextContentOption = {
  id: string;
  name: string;
  content: string;
  group?: string;
  imageUrl?: string;
  onBodyImageUrl?: string;
  outfitImageGenerated?: boolean;
  onBodyGenerationAttempted?: boolean;
};

export type PromptContextRuntime = {
  renderText(content: string): string;
  getVariable(name: string): PromptContextValue;
  listVariables(): string[];
  withVariables(variables: Readonly<Record<string, PromptContextPrimitive>>): PromptContextRuntime;
};
