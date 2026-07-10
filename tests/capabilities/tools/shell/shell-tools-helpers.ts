import { createAliceStore } from "../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createDailyShellStore, type DailyShellStore, type ShellCategory, type ShellOption } from "../../../../src/contexts/agent-profile/src/domain/shell.js";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createWardrobeTools, type WardrobeToolsDeps } from "../../../../src/capabilities/tools/wardrobe/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

export function makeShellStore(name: string, outfits: ShellOption[]): DailyShellStore {
  const root = makeTempDir(name);
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", outfits);
  return store;
}

export function makeShellTools(
  name: string,
  dailyShellStore: DailyShellStore,
  deps: Partial<Omit<WardrobeToolsDeps, "wardrobeRuntime" | "store" | "outputRouter">> & {
    store?: WardrobeToolsDeps["store"];
    outputRouter?: WardrobeToolsDeps["outputRouter"];
  } = {}
) {
  return createWardrobeTools({
    wardrobeRuntime: dailyShellStore,
    store: deps.store ?? createAliceStore(path.join(makeTempDir(`${name}-db`), "alice.sqlite")),
    outputRouter: deps.outputRouter ?? { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z")),
    ...deps
  });
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function replaceShellCategory(root: string, store: DailyShellStore, category: ShellCategory, options: ShellOption[]): void {
  const dir = path.join(root, "shell", category);
  if (fs.existsSync(dir)) {
    for (const fileName of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, fileName));
    }
  }
  for (const option of options) {
    store.saveOption(category, option);
  }
}
