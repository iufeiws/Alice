export function replaceSkillPlaceholders(input: string, values: Record<string, string>): string {
  return input.replace(/\$\{\{([A-Za-z0-9_.-]+)\}\}/g, (match, key) => values[key] ?? match);
}
