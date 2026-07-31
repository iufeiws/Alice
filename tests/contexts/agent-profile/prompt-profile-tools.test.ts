import { test } from "node:test";
import assert from "node:assert/strict";
import { getAdminToolPlugins, getVisiblePromptTools } from "../../../src/contexts/agent-profile/src/application/admin-prompt-memory-runtime.js";
import { defaultPromptProfile } from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createRestartTools } from "../../../src/capabilities/tools/restart/src/index.js";

test("Talk prompt tool preview excludes restart while Chat prompt preview includes it", () => {
  const emptyPlugin = { id: "empty", listTools: () => [], async execute(call: any) { return { callId: call.id, ok: true }; } };
  const restartTools = createRestartTools({ async restart() {} });
  const context = {
    messagingTools: emptyPlugin,
    finishAndWaitTools: emptyPlugin,
    restartTools,
    photoTools: emptyPlugin,
    wardrobeTools: emptyPlugin,
    sleepCocoonTools: emptyPlugin,
    calendarTools: emptyPlugin,
    promptProfileStore: { get: defaultPromptProfile }
  } as any;

  assert.deepEqual(getVisiblePromptTools(context).map((tool) => tool.name), ["restart"]);
  assert.deepEqual(getVisiblePromptTools(context, context.promptProfileStore, ["restart"]), []);
  assert.equal(getAdminToolPlugins(context).includes(restartTools), false);
});
