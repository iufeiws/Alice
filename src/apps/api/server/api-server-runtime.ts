import type { AppConfig } from "../../../packages/config/src/index.js";
import { createHttpShutdownController } from "./http-shutdown.js";
import { voiceCallRoutes } from "../routes/voice-call-contract.js";
import { createApiHttpsOptions, localLanAddress } from "./api-https.js";

const http = await import("node:http");
const https = await import("node:https");

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createApiServerRuntime(input: {
  config: AppConfig;
  requestHandler: any;
  appendLog: AppendLog;
  attachVoiceSignaling(servers: unknown[], routes: typeof voiceCallRoutes): void;
  onShutdown(): Promise<void>;
  releaseLock(): void;
}) {
  const server = http.createServer(input.requestHandler);
  const httpsServer = input.config.api.httpsEnabled
    ? https.createServer(createApiHttpsOptions({ memoryRoot: input.config.memoryFiles.root, appendLog: input.appendLog }), input.requestHandler)
    : undefined;
  const httpShutdown = createHttpShutdownController(server);
  (server as any).on?.("connection", (socket: any) => {
    httpShutdown.trackConnection(socket);
  });
  const httpsShutdown = httpsServer ? createHttpShutdownController(httpsServer) : undefined;
  httpsServer?.on?.("connection", (socket: any) => {
    httpsShutdown?.trackConnection(socket);
  });
  input.attachVoiceSignaling([server, httpsServer], voiceCallRoutes);

  return {
    listen,
    registerShutdownHandlers
  };

  function listen(): void {
    server.listen(input.config.api.port, input.config.api.host, () => {
      console.log(`[api] listening on http://${input.config.api.host}:${input.config.api.port}`);
    });
    httpsServer?.listen(input.config.api.httpsPort, input.config.api.httpsHost, () => {
      console.log(`[api] listening on https://${input.config.api.httpsHost}:${input.config.api.httpsPort}`);
      console.log(`[api] voicecall LAN URL: https://${localLanAddress(input.appendLog) ?? input.config.api.httpsHost}:${input.config.api.httpsPort}${voiceCallRoutes.page}`);
    });
  }

  function registerShutdownHandlers(): void {
    let shutdownStarted = false;
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, async () => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        input.appendLog("info", `shutdown requested: ${signal}`);
        try {
          await input.onShutdown();
        } finally {
          input.releaseLock();
          const [httpResult, httpsResult] = await Promise.all([
            httpShutdown.close({ forceAfterMs: 2_000 }),
            httpsShutdown?.close({ forceAfterMs: 2_000 })
          ]);
          if (httpResult.forced) input.appendLog("warn", `http shutdown forced: remaining_connections=${httpResult.remainingConnections}`);
          if (httpsResult?.forced) input.appendLog("warn", `https shutdown forced: remaining_connections=${httpsResult.remainingConnections}`);
          process.exit(0);
        }
      });
    }

    process.on("beforeExit", () => {
      input.releaseLock();
    });
  }
}
