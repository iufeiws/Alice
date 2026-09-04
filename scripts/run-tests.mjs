import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function findTestFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTestFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) {
    return { ok: true };
  }

  const failedTarget = args.at(-1);
  process.stderr.write(`\n测试失败：${path.relative(repositoryRoot, failedTarget)}\n`);
  process.stderr.write(output);
  if (!output) {
    process.stderr.write(`测试进程未输出诊断（退出码：${result.status ?? "未知"}，信号：${result.signal ?? "无"}）\n`);
  }
  process.exitCode = result.status ?? 1;
  return { ok: false };
}

const testFiles = findTestFiles(path.join(repositoryRoot, "tests")).sort();
let failed = false;
let passedCount = 0;
let totalCount = 0;

for (const testFile of testFiles) {
  totalCount += 1;
  const result = run(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", testFile]);
  passedCount += result.ok ? 1 : 0;
  if (!result.ok) {
    failed = true;
    break;
  }
}

if (!failed) {
  totalCount += 1;
  const result = run("python3", ["-B", "-m", "unittest", "tests/scripts/genie_tts/genie_tts_service_test.py"]);
  passedCount += result.ok ? 1 : 0;
}

process.stdout.write(`通过 ${passedCount} / 总数 ${totalCount}\n`);
