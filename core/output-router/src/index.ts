import type { AgentOutput, ChannelPlugin } from "../../../packages/types/src/index.js";

export interface OutputRouter {
  register(plugin: ChannelPlugin): void;
  send(output: AgentOutput): Promise<void>;
  sendAll(outputs: AgentOutput[]): Promise<void>;
  listChannels(): string[];
}

export function createOutputRouter(): OutputRouter {
  const channels = new Map<string, ChannelPlugin>();
  const router: OutputRouter = {
    register(plugin) {
      channels.set(plugin.id, plugin);
    },
    async send(output) {
      const channel = channels.get(output.target.plugin);
      if (!channel) {
        throw new Error(`No channel plugin registered for ${output.target.plugin}`);
      }
      await channel.send(output);
    },
    async sendAll(outputs) {
      await Promise.all(outputs.map((output) => router.send(output)));
    },
    listChannels() {
      return [...channels.keys()];
    }
  };

  return router;
}
