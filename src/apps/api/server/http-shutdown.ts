import type net from "node:net";

export type HttpShutdownResult = {
  forced: boolean;
  remainingConnections: number;
};

export type HttpShutdownController = {
  trackConnection(socket: net.Socket): void;
  activeConnectionCount(): number;
  close(options?: { forceAfterMs?: number }): Promise<HttpShutdownResult>;
};

type TrackableHttpServer = {
  close(callback?: () => void): unknown;
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
};

export function createHttpShutdownController(server: TrackableHttpServer): HttpShutdownController {
  const sockets = new Set<net.Socket>();

  return {
    trackConnection(socket) {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
      });
    },
    activeConnectionCount() {
      return sockets.size;
    },
    close({ forceAfterMs = 2_000 } = {}) {
      return new Promise<HttpShutdownResult>((resolve) => {
        let settled = false;
        let forced = false;
        const forceTimer = setTimeout(() => {
          forced = true;
          server.closeAllConnections?.();
          for (const socket of sockets) socket.destroy();
          settle();
        }, forceAfterMs);

        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimer);
          resolve({ forced, remainingConnections: forced ? sockets.size : 0 });
        };

        server.close(() => settle());
        server.closeIdleConnections?.();
        for (const socket of sockets) socket.end();
      });
    }
  };
}
