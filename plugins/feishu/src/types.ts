import type { AgentOutput, AgentEvent } from "../../../packages/types/src/index.js";
import type { FeishuPairingStore } from "./pairing.js";

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
  send(plan: FeishuSendPlan): Promise<void>;
};

export type FeishuPluginDeps = {
  onEvent(event: AgentEvent): Promise<void>;
  log?(level: "info" | "warn" | "error", message: string): void;
  outbound?: FeishuOutboundClient;
  pairingStore?: FeishuPairingStore;
};

export type RenderFeishuOutput = (output: AgentOutput) => FeishuSendPlan;
