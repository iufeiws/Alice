import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCoreProfileStore, type CoreProfileStore, type CoreProfile } from "../../../src/contexts/agent-profile/src/adapters/json-core-profile-store.js";

export const emptyCoreProfile: CoreProfile = {
  appearanceDescription: "",
  librarySetting: ""
};

export function coreProfileFixture(name: string): {
  filePath: string;
  store: CoreProfileStore;
} {
  fs.mkdirSync(path.join(os.tmpdir(), "alice-tests"), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-tests", `core-profile-${name}-`));
  const filePath = path.join(root, "core-profile.json");
  return {
    filePath,
    store: createCoreProfileStore(filePath)
  };
}
