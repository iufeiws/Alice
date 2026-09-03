import type { CredentialStore } from "./credential-store.js";
import { createApiKeyAuthorization, createCredentialAuthorization, type OAuthTokenRefresher, type RequestAuthorization } from "./request-authorization.js";

let activeCredentialRuntime: CredentialRuntime | undefined;

export type CredentialRuntime = ReturnType<typeof createCredentialRuntime>;

export function createCredentialRuntime(input: { store: CredentialStore; refreshOAuthToken: OAuthTokenRefresher }) {
  return {
    store: input.store,
    resolveAuthorization(credentialId: string): RequestAuthorization {
      const record = input.store.get(credentialId);
      if (!record) throw new Error("credential_not_found");
      if (record.kind === "api_key") {
        const payload = input.store.readPayload(credentialId) as { apiKey?: string };
        return createApiKeyAuthorization(payload.apiKey ?? "");
      }
      return createCredentialAuthorization({
        store: input.store,
        credentialId,
        refreshOAuthToken: input.refreshOAuthToken
      });
    }
  };
}

export function setActiveCredentialRuntime(runtime: CredentialRuntime | undefined): void {
  activeCredentialRuntime = runtime;
}

export function resolveCredentialAuthorization(credentialId: string): RequestAuthorization {
  if (!activeCredentialRuntime) throw new Error("credential_runtime_not_initialized");
  return activeCredentialRuntime.resolveAuthorization(credentialId);
}
