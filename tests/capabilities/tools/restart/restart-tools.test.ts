import { test } from "node:test";
import assert from "node:assert/strict";
import { createRestartTools, createSystemdRestartController } from "../../../../src/capabilities/tools/restart/src/index.js";

test("restart tool exposes the confirmed recovery warning", () => {
  const tools = createRestartTools({ async restart() {} });

  assert.equal(tools.listTools()[0].description, "重启 Alice 服务, 能够加载代码更新, 也可能导致无法恢复");
});

test("systemd restart controller restarts the Alice user service", async () => {
  const commands: Array<{ file: string; args: string[] }> = [];
  const controller = createSystemdRestartController({
    async runCommand(file, args) {
      commands.push({ file, args });
    }
  });

  await controller.restart();

  assert.deepEqual(commands, [{
    file: "systemctl",
    args: ["--user", "restart", "alice-agent-tmux.service"]
  }]);
});

test("restart tool waits for the service restart before reporting success", async () => {
  const events: string[] = [];
  const tools = createRestartTools({
    async restart() {
      events.push("restart");
    }
  });

  const result = await tools.execute({ id: "restart_1", toolName: "restart", input: {} }, {
    async prepareProcessRestart() {
      events.push("checkpoint");
    },
    async cancelProcessRestart() {
      events.push("cancel");
    }
  });

  events.push(result.ok ? String(result.output) : String(result.error));
  assert.deepEqual(events, ["checkpoint", "restart", "服务已重启，代码更新已加载"]);
});

test("restart tool rejects arguments without restarting", async () => {
  let restarted = false;
  const tools = createRestartTools({
    async restart() {
      restarted = true;
    }
  });

  const result = await tools.execute({ id: "restart_2", toolName: "restart", input: { delay: 1 } }, {
    async prepareProcessRestart() {},
    async cancelProcessRestart() {}
  });

  assert.deepEqual(result, {
    callId: "restart_2",
    ok: false,
    error: "restart does not accept arguments"
  });
  assert.equal(restarted, false);
});

test("restart tool reports a restart command failure", async () => {
  const events: string[] = [];
  const tools = createRestartTools({
    async restart() {
      events.push("restart");
      throw new Error("systemctl failed");
    }
  });

  const result = await tools.execute({ id: "restart_3", toolName: "restart", input: {} }, {
    async prepareProcessRestart() {
      events.push("checkpoint");
    },
    async cancelProcessRestart() {
      events.push("cancel");
    }
  });

  assert.deepEqual(result, {
    callId: "restart_3",
    ok: false,
    error: "systemctl failed"
  });
  assert.deepEqual(events, ["checkpoint", "restart", "cancel"]);
});
