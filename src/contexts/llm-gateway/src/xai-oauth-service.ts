import * as oidc from "openid-client";
import type { CredentialStore, OAuthCredentialPayload } from "./credential-store.js";

const xaiIssuer = new URL("https://auth.x.ai");
const xaiClientId = "b1a00492-073a-47ea-816f-4c329264a828";
const xaiScopes = ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"];

export type XaiDeviceSession = {
  id: string;
  credentialId: string;
  status: "pending" | "connected" | "expired" | "failed";
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAtMs: number;
  error?: string;
};

export function createXaiOAuthService(input: { store: CredentialStore; nowMs?: () => number }) {
  const nowMs = input.nowMs ?? Date.now;
  const sessions = new Map<string, XaiDeviceSession>();
  let configuration: Promise<oidc.Configuration> | undefined;

  const getConfiguration = async () => {
    configuration ??= oidc.discovery(xaiIssuer, xaiClientId, {
      client_id: xaiClientId,
      token_endpoint_auth_method: "none"
    }).then((config) => {
      validateDiscovery(config.serverMetadata());
      return config;
    });
    return configuration;
  };

  const refreshOAuthToken = async (refreshToken: string) => {
    const config = await getConfiguration();
    const tokens = await oidc.refreshTokenGrant(config, refreshToken);
    if (!tokens.access_token) throw new Error("oauth_access_token_missing");
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
      scope: tokens.scope,
      expiresAtMs: tokens.expires_in === undefined ? undefined : nowMs() + tokens.expires_in * 1000
    };
  };

  return {
    refreshOAuthToken,
    listSessions(): XaiDeviceSession[] {
      expireSessions();
      return [...sessions.values()].map((session) => ({ ...session }));
    },
    getSession(id: string): XaiDeviceSession | undefined {
      expireSessions();
      const session = sessions.get(id);
      return session ? { ...session } : undefined;
    },
    async startDeviceLogin(value: { credentialId: string; label: string }): Promise<XaiDeviceSession> {
      if (!value.credentialId.trim() || !value.label.trim()) throw new Error("invalid_oauth_credential");
      const config = await getConfiguration();
      const response = await oidc.initiateDeviceAuthorization(config, { scope: xaiScopes.join(" ") });
      const id = crypto.randomUUID();
      const session: XaiDeviceSession = {
        id,
        credentialId: value.credentialId,
        status: "pending",
        userCode: response.user_code,
        verificationUri: response.verification_uri,
        verificationUriComplete: response.verification_uri_complete,
        expiresAtMs: nowMs() + response.expires_in * 1000
      };
      sessions.set(id, session);
      void poll(config, response, session, value.label);
      return { ...session };
    },
    async disconnect(credentialId: string): Promise<void> {
      const record = input.store.get(credentialId);
      if (!record) throw new Error("credential_not_found");
      if (record.kind !== "oauth" || record.provider !== "xai") throw new Error("credential_kind_mismatch");
      const payload = input.store.readPayload(credentialId) as OAuthCredentialPayload;
      const token = payload.refreshToken ?? payload.accessToken;
      if (token) await oidc.tokenRevocation(await getConfiguration(), token);
      input.store.delete(credentialId);
    }
  };

  async function poll(
    config: oidc.Configuration,
    response: Awaited<ReturnType<typeof oidc.initiateDeviceAuthorization>>,
    session: XaiDeviceSession,
    label: string
  ): Promise<void> {
    try {
      const tokens = await oidc.pollDeviceAuthorizationGrant(config, response);
      if (!tokens.access_token) throw new Error("oauth_access_token_missing");
      let accountLabel: string | undefined;
      let subject: string | undefined;
      try {
        const user = await oidc.fetchUserInfo(config, tokens.access_token, oidc.skipSubjectCheck);
        subject = typeof user.sub === "string" ? user.sub : undefined;
        accountLabel = typeof user.email === "string"
          ? user.email
          : typeof user.name === "string" ? user.name : subject;
      } catch {
        // Userinfo is optional metadata and does not invalidate an otherwise valid token set.
      }
      input.store.upsert({
        id: session.credentialId,
        label,
        kind: "oauth",
        provider: "xai",
        status: "connected",
        accountLabel,
        payload: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenType: tokens.token_type,
          scope: tokens.scope,
          expiresAtMs: tokens.expires_in === undefined ? undefined : nowMs() + tokens.expires_in * 1000,
          subject
        },
        nowMs: nowMs()
      });
      session.status = "connected";
    } catch (error) {
      session.status = nowMs() >= session.expiresAtMs ? "expired" : "failed";
      session.error = safeOAuthError(error);
    }
  }

  function expireSessions(): void {
    for (const session of sessions.values()) {
      if (session.status === "pending" && nowMs() >= session.expiresAtMs) session.status = "expired";
    }
  }
}

function validateDiscovery(metadata: Readonly<oidc.ServerMetadata>): void {
  if (!metadata.device_authorization_endpoint) throw new Error("xai_oauth_device_grant_unsupported");
  const grants = metadata.grant_types_supported ?? [];
  if (!grants.includes("urn:ietf:params:oauth:grant-type:device_code")) throw new Error("xai_oauth_device_grant_unsupported");
  if (!grants.includes("refresh_token")) throw new Error("xai_oauth_refresh_grant_unsupported");
  const scopes = metadata.scopes_supported ?? [];
  for (const scope of xaiScopes) {
    if (!scopes.includes(scope)) throw new Error(`xai_oauth_scope_unsupported:${scope}`);
  }
}

function safeOAuthError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
  return "oauth_device_login_failed";
}
