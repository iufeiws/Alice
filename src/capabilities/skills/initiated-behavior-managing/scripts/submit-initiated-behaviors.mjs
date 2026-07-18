import fs from "node:fs";
import path from "node:path";

const root = "/skills/initiated-behavior-managing/events";

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error(`事件目录只能包含 JSON 文件：${entry.name}`);
  const filePath = path.join(root, entry.name);
  if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`不允许符号链接：${entry.name}`);
  JSON.parse(fs.readFileSync(filePath, "utf8"));
}

process.stdout.write("ALICE_INITIATED_BEHAVIORS_SUBMIT_V1\n");
