import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve("infra/start-agent-tmux.sh");

test("stop cleans up the configured sandbox when the tmux session is absent", () => {
  const fixture = createFixture({ tmuxRunning: false, containerRunning: true });
  fs.writeFileSync(path.join(fixture.workdir, ".env"), "BASH_SANDBOX_CONTAINER_NAME='alice-test-sandbox'\n");

  const result = fixture.run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tmux session is not running/);
  assert.match(result.stdout, /stopped sandbox container: alice-test-sandbox/);
  assert.deepEqual(fixture.calls(), [
    "tmux has-session -t alice-agent",
    "docker inspect -f {{.State.Running}} alice-test-sandbox",
    "docker stop alice-test-sandbox"
  ]);
});

test("stop is idempotent when the configured sandbox is already stopped", () => {
  const fixture = createFixture({ tmuxRunning: true, containerRunning: false });

  const result = fixture.run({ BASH_SANDBOX_CONTAINER_NAME: "alice-env-sandbox" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stopped tmux session/);
  assert.match(result.stdout, /sandbox container is not running: alice-env-sandbox/);
  assert.deepEqual(fixture.calls(), [
    "tmux has-session -t alice-agent",
    "tmux kill-session -t alice-agent",
    "docker inspect -f {{.State.Running}} alice-env-sandbox"
  ]);
});

function createFixture(input: { tmuxRunning: boolean; containerRunning: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-service-stop-"));
  const bin = path.join(root, "bin");
  const workdir = path.join(root, "workspace");
  const log = path.join(root, "calls.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  writeExecutable(path.join(bin, "tmux"), `#!/bin/sh
echo "tmux $*" >> "${log}"
if [ "$1" = "has-session" ]; then exit ${input.tmuxRunning ? 0 : 1}; fi
exit 0
`);
  writeExecutable(path.join(bin, "docker"), `#!/bin/sh
echo "docker $*" >> "${log}"
if [ "$1" = "inspect" ]; then printf '%s\\n' '${input.containerRunning ? "true" : "false"}'; fi
exit 0
`);

  return {
    workdir,
    run(extraEnv: NodeJS.ProcessEnv = {}) {
      return childProcess.spawnSync("bash", [script, "stop"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          ALICE_WORKDIR: workdir,
          ...extraEnv
        }
      });
    },
    calls() {
      return fs.readFileSync(log, "utf8").trim().split(/\r?\n/);
    }
  };
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}
