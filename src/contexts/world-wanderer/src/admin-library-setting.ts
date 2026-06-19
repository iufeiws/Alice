import { defaultWorldWandererPluginConfigPath, readWorldWandererConfig } from "./index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";

export function resolveLibrarySetting(context: AdminRoutesContext): string {
  const configPath = context.pluginConfigs?.worldWanderer?.configPath ?? defaultWorldWandererPluginConfigPath;
  const worldWanderer = readWorldWandererConfig(configPath);
  return worldWanderer.enabled ? worldWanderer.libraryPrompt : context.coreProfileStore.get().librarySetting;
}
