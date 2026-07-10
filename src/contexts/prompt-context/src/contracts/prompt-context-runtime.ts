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

export type PromptContextRenderOptions = {
  targetWardrobe?: PromptContextContentOption;
};

export type PromptContextRuntime = {
  renderText(content: string, options?: PromptContextRenderOptions): string;
  getVariable(name: string, options?: PromptContextRenderOptions): PromptContextValue;
  listVariables(): string[];
};
