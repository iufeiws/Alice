export function installApiConsoleLogging(input: {
  appendLog(level: "info" | "warn" | "error", message: string): void;
  formatLogArg(value: unknown): string;
}) {
  const originalConsoleLog = console.log.bind(console);
  const originalConsoleError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    input.appendLog("info", args.map(input.formatLogArg).join(" "));
    originalConsoleLog(...args);
  };

  console.error = (...args: unknown[]) => {
    input.appendLog("error", args.map(input.formatLogArg).join(" "));
    originalConsoleError(...args);
  };
}
