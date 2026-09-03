const fs = await import("node:fs");

export function updateEnvFile(path: string, updates: Record<string, string | undefined | null>): void {
  const existing = fs.existsSync(path) ? fs.readFileSync(path, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const lines = existing.map((line) => {
    const separator = line.indexOf("=");
    if (separator === -1 || line.trim().startsWith("#")) return line;

    const key = line.slice(0, separator).trim();
    if (!(key in updates)) return line;
    if (updates[key] === undefined) return line;
    if (updates[key] === null) {
      seen.add(key);
      return undefined;
    }

    seen.add(key);
    return `${key}=${formatEnvValue(updates[key] ?? "")}`;
  }).filter((line): line is string => line !== undefined);

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key) && value !== undefined && value !== null) {
      lines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  fs.writeFileSync(path, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  fs.chmodSync(path, 0o600);
}

function formatEnvValue(value: string): string {
  return value.includes("\n") || value.startsWith(" ") || value.endsWith(" ")
    ? JSON.stringify(value)
    : value;
}
