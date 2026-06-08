import type { AgentEvent } from "../../packages/types/src/index.js";

export * from "./active-llm-session-runtime.js";
export * from "./admin-llm-session-runtime.js";
export * from "./api-session-runtime.js";
export * from "./llm-session-archive.js";
export * from "./llm-session-helpers.js";
export * from "./llm-session-list-runtime.js";
export * from "./llm-session-types.js";
export * from "./llm-session-view.js";
export * from "./memory-llm-session-runtime.js";

export interface SessionResolver {
  resolve(event: AgentEvent): Promise<string>;
}

export function createSessionResolver(): SessionResolver {
  return {
    async resolve(event) {
      if (event.session.sessionId) return event.session.sessionId;

      const plugin = event.source.plugin;
      const scope = event.session.scope;
      const externalId =
        event.session.threadId ??
        event.source.channelId ??
        event.source.userId ??
        event.source.rawMessageId ??
        event.id;

      return `${plugin}:${scope}:${externalId}`;
    }
  };
}
