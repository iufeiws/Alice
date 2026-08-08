import type { AgentOutput, AgentEvent } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { FeishuPairingStore } from "./pairing.js";

export type FeishuConfig = {
  enabled: boolean;
  connectionMode: "websocket" | "webhook";
  accounts: Record<string, { appId: string; appSecret: string; name?: string }>;
  /** 当前账户指针：最后收到消息的账户 id，持久化在账户配置处；无消息历史时为空。 */
  activeAccount?: string;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  dmAllowFrom: string[];
  groupPolicy: "allowlist" | "open" | "disabled";
  groupAllowFrom: string[];
  requireMention: boolean;
  codexPolicy: {
    enabled: boolean;
    requireAllowlist: boolean;
    allowedUsers: string[];
    allowedChats: string[];
    requireExplicitCommand: boolean;
  };
};

export type FeishuTextMessageEvent = {
  schema?: string;
  header?: {
    event_id?: string;
    create_time?: string;
  };
  event: {
    message: {
      message_id: string;
      chat_id: string;
      chat_type: "p2p" | "group" | string;
      message_type?: string;
      msg_type?: string;
      content: string;
      mentions?: Array<{ id?: { open_id?: string }; name?: string; key?: string }>;
      thread_id?: string;
    };
    sender: {
      sender_id: {
        open_id?: string;
        user_id?: string;
      };
    };
  };
};

export type FeishuAudioMessageEvent = {
  schema?: string;
  header?: {
    event_id?: string;
    create_time?: string;
  };
  event: {
    message: {
      message_id: string;
      chat_id: string;
      chat_type: "p2p" | "group" | string;
      message_type?: string;
      msg_type?: string;
      content: string;
      mentions?: Array<{ id?: { open_id?: string }; name?: string; key?: string }>;
      thread_id?: string;
    };
    sender: {
      sender_id: {
        open_id?: string;
        user_id?: string;
      };
    };
  };
};

export type FeishuMessageLifecycleEvent =
  | {
      kind: "reaction.created" | "reaction.deleted";
      externalEventId?: string;
      externalMessageId: string;
      conversationId?: string;
      actorId?: string;
      emoji: string;
      occurredAt: string;
      occurredAtUtc?: string;
      raw?: unknown;
    }
  | {
      kind: "message.read" | "message.recalled";
      externalEventId?: string;
      externalMessageId: string;
      conversationId?: string;
      actorId?: string;
      occurredAt: string;
      occurredAtUtc?: string;
      raw?: unknown;
    };

export type FeishuSendPlan =
  | {
      kind: "text";
      receiveIdType: "chat_id" | "open_id";
      receiveId: string;
      text: string;
      replyTo?: string;
    }
  | {
      kind: "markdown";
      receiveIdType: "chat_id" | "open_id";
      receiveId: string;
      markdown: string;
      replyTo?: string;
    }
  | {
      kind: "image";
      receiveIdType: "chat_id" | "open_id";
      receiveId: string;
      assetId: string;
      replyTo?: string;
    }
  | {
      kind: "audio";
      receiveIdType: "chat_id" | "open_id";
      receiveId: string;
      assetId: string;
      duration?: number;
      filename?: string;
      replyTo?: string;
    }
  | {
      kind: "file";
      receiveIdType: "chat_id" | "open_id";
      receiveId: string;
      assetId: string;
      filename: string;
      replyTo?: string;
    };

export type FeishuOutboundClient = {
  send(plan: FeishuSendPlan): Promise<void | FeishuSendResult>;
};

export type FeishuSendResult = {
  messageId?: string;
  createdAt?: string;
  createdAtUtc?: string;
};

export type FeishuReactionClient = {
  addReaction(input: { messageId: string; emojiType: string }): Promise<{ reactionId?: string }>;
  removeReaction(input: { messageId: string; reactionId: string }): Promise<void>;
};

export type FeishuCardActionEvent = {
  accountId?: string;
  messageId: string;
  chatId?: string;
  operatorOpenId: string;
  value: unknown;
  formValue: Record<string, unknown>;
};

export type FeishuAgentRunCardBlock = "state" | "reasoning" | "content" | "tools";
export type FeishuAgentRunCardBlocks = Record<FeishuAgentRunCardBlock, string>;
export type FeishuToolExecutionCardBlock = "title" | "result";
export type FeishuToolExecutionPanel = {
  toolName: string;
  state: "running" | "finished" | "failed";
  call: string;
  result: string;
  titleElementId: string;
  callElementId: string;
  resultElementId: string;
};

export type FeishuDynamicCardClient = {
  isStarted(): boolean;
  createApprovalCard(input: { accountId?: string; receiveIdType: "open_id"; receiveId: string; requestId: string; title: string; content: string }): Promise<{ messageId: string; cardId: string }>;
  deleteMessage(input: { accountId?: string; messageId: string }): Promise<void>;
  createAgentRunCard(input: { accountId?: string; receiveIdType: "open_id"; receiveId: string; blocks: FeishuAgentRunCardBlocks }): Promise<{ messageId: string; cardId: string }>;
  updateAgentRunCardBlocks(input: { accountId?: string; cardId: string; blocks: Partial<FeishuAgentRunCardBlocks>; sequence: number }): Promise<void>;
  setAgentRunCardStreaming(input: { accountId?: string; cardId: string; enabled: boolean; sequence: number }): Promise<void>;
  resolveAgentRunCardId(input: { accountId?: string; messageId: string }): Promise<{ cardId?: string }>;
  createToolExecutionCard(input: { accountId?: string; receiveIdType: "open_id"; receiveId: string; toolName: string; call: string; result: string; titleElementId?: string; callElementId?: string; resultElementId?: string }): Promise<{ messageId: string; cardId: string }>;
  groupToolExecutionCard(input: { accountId?: string; cardId: string; rootElementId: string; panels: FeishuToolExecutionPanel[]; sequence: number }): Promise<void>;
  updateToolExecutionCard(input: { accountId?: string; cardId: string; block: FeishuToolExecutionCardBlock; elementId: string; content: string; sequence: number }): Promise<void>;
  setToolExecutionCardStreaming(input: { accountId?: string; cardId: string; enabled: boolean; sequence: number }): Promise<void>;
};

export type FeishuStoredAudioAsset = {
  assetId: string;
  filePath: string;
  filename?: string;
  mimeType?: string;
};

export type FeishuInboundResourceType = "image" | "file";

export type FeishuInboundResourceDownloader = (input: {
  messageId: string;
  fileKey: string;
  type: FeishuInboundResourceType;
  filePath: string;
}) => Promise<{ filename?: string; mime?: string } | void>;

export type FeishuAudioAssetStore = (input: {
  fileKey: string;
  messageId: string;
  raw: FeishuAudioMessageEvent;
}) => Promise<FeishuStoredAudioAsset>;

export type FeishuAsrTranscriber = {
  transcribe(input: {
    audioFile: string;
    filename?: string;
    mimeType?: string;
    language?: string;
    provider?: "tencent" | "openai_compatible" | "multimodal_llm";
    prompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<
    | { text: string; provider: "tencent" | "openai_compatible" | "multimodal_llm"; model?: string; language?: string; durationMs?: number; requestId?: string; raw?: unknown }
    | { ok: false; error: string; message?: string; provider?: "tencent" | "openai_compatible" | "multimodal_llm"; requestId?: string }
  >;
};

export type FeishuPluginDeps = {
  onEvent(event: AgentEvent): Promise<void>;
  onLifecycleEvent?(event: FeishuMessageLifecycleEvent): Promise<void>;
  onCardAction?(event: FeishuCardActionEvent): Promise<unknown>;
  /** 当前账户指针变化时回调（消息入站触发），由宿主负责持久化到账户配置处。 */
  onActiveAccountChanged?(accountId: string): void | Promise<void>;
  log?(level: "info" | "warn" | "error", message: string): void;
  outbound?: FeishuOutboundClient;
  reactionClient?: FeishuReactionClient;
  pairingStore?: FeishuPairingStore;
  storeAudioAsset?: FeishuAudioAssetStore;
  asr?: FeishuAsrTranscriber;
  time?: CurrentTimeProvider;
};

export type RenderFeishuOutput = (output: AgentOutput) => FeishuSendPlan;
