import { loadConfig } from "./app-config-runtime.js";
import { createMutableLLMClient, createStubLLMClient } from "../../../contexts/llm-gateway/src/index.js";
import { acquireSingletonLock } from "../server/singleton-lock.js";
import { loadDotEnv } from "./dotenv-loader.js";
import { createPromptApiPresetStore } from "../../../contexts/llm-gateway/src/llm-api-profile.js";
import { createLLMConfigRuntime } from "../../../contexts/llm-gateway/src/llm-config-runtime.js";
import { createCredentialStore } from "../../../contexts/llm-gateway/src/credential-store.js";
import { createXaiOAuthService } from "../../../contexts/llm-gateway/src/xai-oauth-service.js";
import { createCredentialRuntime, setActiveCredentialRuntime } from "../../../contexts/llm-gateway/src/credential-runtime.js";
const path = await import("node:path");

export function createApiBootstrapRuntime(input: { time: { setTimeZone(timeZone: string): void } }) {
  loadDotEnv(".env");
  const credentialMasterKey = process.env.ALICE_CREDENTIAL_MASTER_KEY;
  if (!credentialMasterKey) throw new Error("ALICE_CREDENTIAL_MASTER_KEY is required");
  const config = loadConfig();
  const credentialStore = createCredentialStore({
    dbPath: path.join(config.memoryFiles.root, "credentials.sqlite"),
    masterKey: credentialMasterKey
  });
  const xaiOAuthService = createXaiOAuthService({ store: credentialStore });
  const credentialRuntime = createCredentialRuntime({ store: credentialStore, refreshOAuthToken: xaiOAuthService.refreshOAuthToken });
  setActiveCredentialRuntime(credentialRuntime);
  const promptApiPresets = createPromptApiPresetStore(config.memoryFiles.root);
  const serviceLock = acquireSingletonLock(config.memoryFiles.root, "api");
  input.time.setTimeZone(config.core.timezone);
  const activeLLM = createMutableLLMClient(createStubLLMClient());
  const llmConfigRuntime = createLLMConfigRuntime({
    fallbackClient: activeLLM,
    resolvePreset: promptApiPresets.resolvePromptApiPreset
  });

  return {
    config,
    credentialStore,
    xaiOAuthService,
    credentialRuntime,
    readLLMApiPresets: promptApiPresets.readLLMApiPresets,
    resolvePromptApiPreset: promptApiPresets.resolvePromptApiPreset,
    serviceLock,
    activeLLM,
    llmConfigRuntime
  };
}
