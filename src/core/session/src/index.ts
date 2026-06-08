import type { AgentEvent } from "../../../packages/types/src/index.js";

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
