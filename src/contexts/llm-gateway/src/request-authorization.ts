import type { CredentialStore, OAuthCredentialPayload } from "./credential-store.js";

export interface RequestAuthorization {
  authorization(target: URL): Promise<string>;
  retryAfterUnauthorized(input: { target: URL; rejectedAuthorization: string }): Promise<string | undefined>;
}

export function createApiKeyAuthorization(apiKey: string): RequestAuthorization {
  if (!apiKey) throw new Error("credential_api_key_missing");
  const value = `Bearer ${apiKey}`;
  return {
    async authorization() { return value; },
    async retryAfterUnauthorized() { return undefined; }
  };
}

export type OAuthTokenRefresher = (refreshToken: string) => Promise<{
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAtMs?: number;
}>;

const credentialRefreshes = new WeakMap<CredentialStore, Map<string, Promise<string>>>();

export function createCredentialAuthorization(input: {
  store: CredentialStore;
  credentialId: string;
  refreshOAuthToken: OAuthTokenRefresher;
  nowMs?: () => number;
}): RequestAuthorization {
  const nowMs = input.nowMs ?? Date.now;

  const refresh = async (rejectedAuthorization?: string): Promise<string> => {
    let storeRefreshes = credentialRefreshes.get(input.store);
    if (!storeRefreshes) {
      storeRefreshes = new Map();
      credentialRefreshes.set(input.store, storeRefreshes);
    }
    const existingRefresh = storeRefreshes.get(input.credentialId);
    if (existingRefresh) return existingRefresh;
    const refreshPromise = (async () => {
      const record = input.store.get(input.credentialId);
      if (!record) throw new Error("credential_not_found");
      if (record.kind !== "oauth") throw new Error("credential_kind_mismatch");
      if (record.provider !== "xai") throw new Error("oauth_provider_unsupported");
      const current = input.store.readPayload(input.credentialId) as OAuthCredentialPayload;
      const currentAuthorization = `Bearer ${current.accessToken}`;
      if (rejectedAuthorization && rejectedAuthorization !== currentAuthorization) return currentAuthorization;
      if (!current.refreshToken) {
        input.store.markReconnectRequired(input.credentialId, { ...current, accessToken: "", refreshToken: undefined }, nowMs());
        throw new Error("credential_reconnect_required");
      }
      let refreshed: Awaited<ReturnType<OAuthTokenRefresher>>;
      try {
        refreshed = await input.refreshOAuthToken(current.refreshToken);
      } catch (error) {
        if (isReconnectRequiredError(error)) {
          input.store.markReconnectRequired(input.credentialId, { ...current, accessToken: "", refreshToken: undefined }, nowMs());
          throw new Error("credential_reconnect_required");
        }
        throw error;
      }
      const payload: OAuthCredentialPayload = {
        ...current,
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? current.refreshToken
      };
      input.store.upsert({ ...record, status: "connected", payload, nowMs: nowMs() });
      return `Bearer ${payload.accessToken}`;
    })();
    storeRefreshes.set(input.credentialId, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      if (storeRefreshes.get(input.credentialId) === refreshPromise) storeRefreshes.delete(input.credentialId);
    }
  };

  const validateTarget = (target: URL) => {
    if (target.origin !== "https://api.x.ai") throw new Error("oauth_target_not_allowed");
  };

  return {
    async authorization(target) {
      const record = input.store.get(input.credentialId);
      if (!record) throw new Error("credential_not_found");
      if (record.status !== "connected") throw new Error("credential_reconnect_required");
      if (record.kind === "api_key") {
        const payload = input.store.readPayload(input.credentialId) as { apiKey?: string };
        if (!payload.apiKey) throw new Error("credential_api_key_missing");
        return `Bearer ${payload.apiKey}`;
      }
      validateTarget(target);
      const payload = input.store.readPayload(input.credentialId) as OAuthCredentialPayload;
      if (payload.expiresAtMs !== undefined && payload.expiresAtMs <= nowMs() + 120_000) return refresh();
      if (!payload.accessToken) throw new Error("oauth_access_token_missing");
      return `Bearer ${payload.accessToken}`;
    },
    async retryAfterUnauthorized({ target, rejectedAuthorization }) {
      const record = input.store.get(input.credentialId);
      if (!record || record.kind !== "oauth") return undefined;
      validateTarget(target);
      return refresh(rejectedAuthorization);
    }
  };
}

function isReconnectRequiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; error?: unknown; message?: unknown; status?: unknown };
  if (value.code === "invalid_grant" || value.error === "invalid_grant" || (typeof value.message === "string" && value.message.includes("invalid_grant"))) return true;
  return typeof value.status === "number" && value.status >= 400 && value.status < 500 && value.status !== 408 && value.status !== 429;
}
