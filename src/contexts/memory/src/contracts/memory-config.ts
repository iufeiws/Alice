export type MemorySummaryConfig = {
  enabled: boolean;
  manualRunRequiresSleeping?: boolean;
  baseURL: string;
  apiKey?: string;
  model?: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
  stream: boolean;
  extraParams: Record<string, unknown>;
  followupExtraParams: Record<string, unknown>;
};

export type MemoryFilesConfig = {
  memoryFiles: {
    root: string;
  };
};

export type SleepMemoryInductionConfig = MemoryFilesConfig & {
  memorySummary: MemorySummaryConfig;
};
