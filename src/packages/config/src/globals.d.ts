declare const process: {
  env: Record<string, string | undefined>;
  on(event: string, handler: () => void | Promise<void>): void;
  exit(code?: number): never;
};

declare const Buffer: {
  from(input: string): any;
  from(input: string, encoding: string): any;
  concat(chunks: any[]): { toString(encoding: "utf8"): string };
};
