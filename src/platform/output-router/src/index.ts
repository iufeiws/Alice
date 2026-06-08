export type RoutableOutput = {
  target: {
    plugin: string;
  };
};

export interface ChannelSender<TOutput = any, TResult = unknown> {
  id: string;
  send(output: TOutput): Promise<TResult>;
}

export interface OutputRouter<TOutput extends RoutableOutput = any, TResult = unknown> {
  register(plugin: ChannelSender<TOutput, TResult>): void;
  send(output: TOutput): Promise<TResult>;
  sendAll(outputs: TOutput[]): Promise<TResult[]>;
  listChannels(): string[];
}

export function createOutputRouter<TOutput extends RoutableOutput = any, TResult = unknown>(): OutputRouter<TOutput, TResult> {
  const channels = new Map<string, ChannelSender<TOutput, TResult>>();
  const router: OutputRouter<TOutput, TResult> = {
    register(plugin) {
      channels.set(plugin.id, plugin);
    },
    async send(output) {
      const channel = channels.get(output.target.plugin);
      if (!channel) {
        throw new Error(`No channel plugin registered for ${output.target.plugin}`);
      }
      return channel.send(output);
    },
    async sendAll(outputs) {
      return Promise.all(outputs.map((output) => router.send(output)));
    },
    listChannels() {
      return [...channels.keys()];
    }
  };

  return router;
}
