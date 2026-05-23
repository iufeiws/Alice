export type LLMRole = "system" | "user" | "assistant" | "tool";

export type LLMMessage = {
  role: LLMRole;
  content: string;
  name?: string;
};

export type LLMToolSpec = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type LLMChatInput = {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  tools?: LLMToolSpec[];
  maxTokens?: number;
};

export type LLMUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type LLMChatResult = {
  id?: string;
  model?: string;
  message: LLMMessage;
  finishReason?: string;
  usage?: LLMUsage;
  raw?: unknown;
};

export type LLMModel = {
  id: string;
  ownedBy?: string;
  raw?: unknown;
};

export interface LLMClient {
  chat(input: LLMChatInput): Promise<LLMChatResult>;
  listModels?(): Promise<LLMModel[]>;
}

export type MutableLLMClient = LLMClient & {
  setClient(client: LLMClient): void;
  getClient(): LLMClient;
};

export type OpenAICompatibleConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
};

type OpenAIChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export function createOpenAICompatibleClient(config: OpenAICompatibleConfig): LLMClient {
  const baseURL = config.baseURL.replace(/\/+$/, "");

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000);

    try {
      const response = await fetch(`${baseURL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
          ...(init.headers ?? {})
        }
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM request failed: ${response.status} ${response.statusText} ${body}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async chat(input) {
      const body = {
        model: input.model ?? config.model,
        messages: input.messages,
        temperature: input.temperature ?? config.temperature ?? 0.2,
        tools: input.tools,
        max_tokens: input.maxTokens
      };

      const json = await request<OpenAIChatCompletionResponse>("/chat/completions", {
        method: "POST",
        body: JSON.stringify(body)
      });

      const choice = json.choices?.[0];
      return {
        id: json.id,
        model: json.model,
        message: {
          role: "assistant",
          content: choice?.message?.content ?? ""
        },
        finishReason: choice?.finish_reason,
        usage: json.usage
          ? {
              inputTokens: json.usage.prompt_tokens,
              outputTokens: json.usage.completion_tokens,
              totalTokens: json.usage.total_tokens
            }
          : undefined,
        raw: json
      };
    },
    async listModels() {
      const json = await request<{ data?: Array<{ id: string; owned_by?: string }> }>("/models", {
        method: "GET"
      });

      return (json.data ?? []).map((model) => ({
        id: model.id,
        ownedBy: model.owned_by,
        raw: model
      }));
    }
  };
}

export function createMutableLLMClient(initialClient: LLMClient): MutableLLMClient {
  let currentClient = initialClient;
  return {
    setClient(client) {
      currentClient = client;
    },
    getClient() {
      return currentClient;
    },
    chat(input) {
      return currentClient.chat(input);
    },
    listModels() {
      return currentClient.listModels ? currentClient.listModels() : Promise.resolve([]);
    }
  };
}

export function createStubLLMClient(): LLMClient {
  return {
    async chat(input) {
      const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");

      return {
        model: "stub",
        message: {
          role: "assistant",
          content: lastUserMessage?.content
            ? `Stub LLM response: ${lastUserMessage.content}`
            : "Stub LLM response."
        },
        finishReason: "stop"
      };
    },
    async listModels() {
      return [{ id: "stub" }];
    }
  };
}
