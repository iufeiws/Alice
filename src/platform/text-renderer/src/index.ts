export type TemplatePrimitive = string | number | boolean | null | undefined;
export type TemplateValue = TemplatePrimitive | TemplateValue[] | { [key: string]: TemplateValue };
export type TemplateVariables = { [key: string]: TemplateValue };

export function renderTemplateText(content: string, variables: TemplateVariables = {}): string {
  return content.replace(/\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (match, key: string) => {
    const resolved = resolveTemplatePath(variables, key);
    return resolved === undefined || resolved === null || typeof resolved === "object" ? match : String(resolved);
  });
}

export function renderTemplateValue<T>(value: T, variables: TemplateVariables = {}): T {
  return renderTemplateValueInner(value, variables, new WeakSet<object>());
}

export function stringifyTemplateValue(value: unknown, variables: TemplateVariables = {}): string {
  if (typeof value === "string") return renderTemplateText(value, variables);
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(renderTemplateValue(value as TemplateValue, variables));
  } catch {
    return String(value);
  }
}

function renderTemplateValueInner<T>(value: T, variables: TemplateVariables, seen: WeakSet<object>): T {
  if (typeof value === "string") return renderTemplateText(value, variables) as T;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]" as T;
    seen.add(value);
    return value.map((entry) => renderTemplateValueInner(entry, variables, seen)) as T;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]" as T;
    seen.add(value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, renderTemplateValueInner(entry, variables, seen)])) as T;
  }
  return value;
}

function resolveTemplatePath(variables: TemplateVariables, key: string): TemplateValue {
  return key.split(/[/.]/).reduce<TemplateValue>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return current[part];
  }, variables);
}
