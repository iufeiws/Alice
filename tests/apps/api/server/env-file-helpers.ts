const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

export function createEnvFile(name: string, content: string): string {
  const file = envFilePath(name);
  fs.writeFileSync(file, content);
  return file;
}

export function envFilePath(name: string): string {
  const file = path.join(os.tmpdir(), "alice-tests", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`, ".env");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

export function readEnvFile(file: string): string {
  return fs.readFileSync(file, "utf8");
}
