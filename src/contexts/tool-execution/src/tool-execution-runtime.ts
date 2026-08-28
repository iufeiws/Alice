import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionReporter,
  ToolExecutionReportSession,
  ToolPlugin,
  ToolResult
} from "./contracts.js";

type RegisteredTool = { plugin: ToolPlugin; definition: ToolDefinition };

const toolRegistries = new Map<string, Map<string, RegisteredTool>>();
let toolExecutionReporter: ToolExecutionReporter | undefined;

export function setToolExecutionReporter(reporter: ToolExecutionReporter | undefined): void {
  toolExecutionReporter = reporter;
}

export function registerToolPlugins(name: string, plugins: readonly ToolPlugin[]): () => void {
  const registry = buildToolPluginMap(plugins);
  toolRegistries.set(name, registry);
  return () => {
    if (toolRegistries.get(name) === registry) toolRegistries.delete(name);
  };
}

export function executeRegisteredTool(
  registryName: string,
  call: ToolCall,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const tool = toolRegistries.get(registryName)?.get(call.toolName);
  if (!tool) throw new Error(`llm_tool_unavailable:${call.toolName}`);
  return executeToolPlugin(tool, call, context);
}

export function getRegisteredToolDefinition(registryName: string, toolName: string): ToolDefinition | undefined {
  return toolRegistries.get(registryName)?.get(toolName)?.definition;
}

function buildToolPluginMap(plugins: readonly ToolPlugin[]): Map<string, RegisteredTool> {
  const map = new Map<string, RegisteredTool>();
  for (const plugin of plugins) {
    for (const definition of plugin.listTools()) map.set(definition.name, { plugin, definition });
  }
  return map;
}

async function executeToolPlugin(tool: RegisteredTool, call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
  const normalizedCall = {
    ...call,
    input: omitBlankOptionalToolInputs(call.input, tool.definition.inputSchema)
  };
  // 卡片 reporter 的 begin/finish 涉及飞书网络往返，改为后台执行，避免阻塞 tool 执行
  const reportPromise = tool.definition.suppressExecutionCard
    ? undefined
    : settleExecutionReport(toolExecutionReporter?.begin(normalizedCall));
  const reportProgress = reportPromise
    ? (content: string) => void reportPromise.then((report) => report?.appendProgress(content)).catch(() => undefined)
    : context?.reportProgress;
  try {
    const result = await tool.plugin.execute(normalizedCall, {
      ...context,
      reportProgress
    });
    void reportPromise?.then((report) => report?.finish(result)).catch(() => undefined);
    return result;
  } catch (error) {
    void reportPromise?.then((report) => report?.fail(error)).catch(() => undefined);
    throw error;
  }
}

function omitBlankOptionalToolInputs(
  input: Record<string, unknown>,
  schema: Record<string, unknown>
): Record<string, unknown> {
  const properties = recordValue(schema.properties);
  if (!properties) return input;
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : []);
  let normalized: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(input)) {
    const propertySchema = recordValue(properties[key]);
    if (propertySchema && !required.has(key) && typeof value === "string" && value.trim() === "") {
      normalized ??= { ...input };
      delete normalized[key];
      continue;
    }
    const nextValue = propertySchema ? normalizeNestedToolInput(value, propertySchema) : value;
    if (nextValue !== value) {
      normalized ??= { ...input };
      normalized[key] = nextValue;
    }
  }
  return normalized ?? input;
}

function normalizeNestedToolInput(value: unknown, schema: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    const itemSchema = recordValue(schema.items);
    if (!itemSchema) return value;
    let normalized: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const nextValue = normalizeNestedToolInput(value[index], itemSchema);
      if (nextValue !== value[index]) {
        normalized ??= [...value];
        normalized[index] = nextValue;
      }
    }
    return normalized ?? value;
  }
  if (!value || typeof value !== "object") return value;
  return omitBlankOptionalToolInputs(value as Record<string, unknown>, schema);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function settleExecutionReport(
  value: ToolExecutionReportSession | Promise<ToolExecutionReportSession | undefined> | undefined
): Promise<ToolExecutionReportSession | undefined> | undefined {
  return value === undefined ? undefined : Promise.resolve(value).catch(() => undefined);
}
