const fs = await import("node:fs");

export function updateEnvFile(path: string, updates: Record<string, string | undefined>): void {
  const existing = fs.existsSync(path) ? fs.readFileSync(path, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const lines = existing.map((line) => {
    const separator = line.indexOf("=");
    if (separator === -1 || line.trim().startsWith("#")) return line;

    const key = line.slice(0, separator).trim();
    if (!(key in updates)) return line;
    if (updates[key] === undefined) return line;

    seen.add(key);
    return `${key}=${formatEnvValue(updates[key] ?? "")}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key) && value !== undefined) {
      lines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  fs.writeFileSync(path, `${lines.join("\n").replace(/\n+$/, "")}\n`);
}

function formatEnvValue(value: string): string {
  return value.includes("\n") || value.startsWith(" ") || value.endsWith(" ")
    ? JSON.stringify(value)
    : value;
}
