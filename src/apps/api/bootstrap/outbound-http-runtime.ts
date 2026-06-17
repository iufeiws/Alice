const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);

export type OutboundHttpProxyRuntimeResult = {
  configured: boolean;
  proxyUrl?: string;
};

export function configureProcessOutboundHttpProxy(
  env: Record<string, string | undefined> = process.env
): OutboundHttpProxyRuntimeResult {
  const proxyUrl = processOutboundProxyUrl(env);
  if (!proxyUrl) return { configured: false };

  const { ProxyAgent, setGlobalDispatcher } = loadUndici();
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  return { configured: true, proxyUrl };
}

export function processOutboundProxyUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return stringEnv(env.HTTPS_PROXY)
    ?? stringEnv(env.https_proxy)
    ?? stringEnv(env.HTTP_PROXY)
    ?? stringEnv(env.http_proxy);
}

function stringEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function loadUndici(): {
  ProxyAgent: new (url: string) => unknown;
  setGlobalDispatcher(dispatcher: unknown): void;
} {
  try {
    return require("undici") as {
      ProxyAgent: new (url: string) => unknown;
      setGlobalDispatcher(dispatcher: unknown): void;
    };
  } catch {
    return require("/usr/share/nodejs/undici") as {
      ProxyAgent: new (url: string) => unknown;
      setGlobalDispatcher(dispatcher: unknown): void;
    };
  }
}
