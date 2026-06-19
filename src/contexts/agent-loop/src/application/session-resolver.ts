import type { AgentEvent } from "../contracts/agent-contracts.js";


export interface SessionResolver {
  resolve(event: AgentEvent): Promise<string>;
}

export function createSessionResolver(): SessionResolver {
  return {
    async resolve(event) {
      if (event.externalSession.sessionId) return event.externalSession.sessionId;

      const plugin = event.source.plugin;
      const scope = event.externalSession.scope;
      const externalId =
        event.externalSession.threadId ??
        event.source.channelId ??
        event.source.userId ??
        event.source.rawMessageId ??
        event.id;

      return `${plugin}:${scope}:${externalId}`;
    }
  };
}
