import { normalizePromptLayer, type PromptMessage } from "../../../agent-profile/src/domain/prompt-layer.js";
import type { AgentInitiatedBehaviorPlan } from "../domain/initiated-behavior.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type AgentRandomEventDefinition = {
  meta: {
    id: string;
    enabled: boolean;
    weight: number;
    priority: number;
  };
  messages: PromptMessage[];
};

export type AgentRandomEventStore = {
  root: string;
  list(): AgentRandomEventDefinition[];
  get(id: string): AgentRandomEventDefinition | undefined;
  create(definition: AgentRandomEventDefinition): AgentRandomEventDefinition | undefined;
  save(definition: AgentRandomEventDefinition): AgentRandomEventDefinition;
  delete(id: string): AgentRandomEventDefinition | undefined;
  plan(definition: AgentRandomEventDefinition): AgentInitiatedBehaviorPlan;
};

export function createJsonRandomEventStore(root: string): AgentRandomEventStore {
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  return {
    root: resolvedRoot,
    list() {
      return fs.readdirSync(resolvedRoot, { withFileTypes: true })
        .filter((entry) => entry.name.endsWith(".json"))
        .map((entry) => readDefinition(path.join(resolvedRoot, entry.name), entry.name.slice(0, -5)))
        .sort((left, right) => left.meta.id.localeCompare(right.meta.id));
    },
    get(id) {
      validateId(id);
      const filePath = definitionPath(resolvedRoot, id);
      return fs.existsSync(filePath) ? readDefinition(filePath, id) : undefined;
    },
    create(definition) {
      const normalized = normalizeAgentRandomEventDefinition(definition);
      if (fs.existsSync(definitionPath(resolvedRoot, normalized.meta.id))) return undefined;
      writeDefinition(resolvedRoot, normalized);
      return normalized;
    },
    save(definition) {
      const normalized = normalizeAgentRandomEventDefinition(definition);
      writeDefinition(resolvedRoot, normalized);
      return normalized;
    },
    delete(id) {
      const current = this.get(id);
      if (!current) return undefined;
      fs.unlinkSync(definitionPath(resolvedRoot, id));
      return current;
    },
    plan(definition) {
      const promptProfilePath = definitionPath(resolvedRoot, definition.meta.id);
      return {
        id: definition.meta.id,
        kind: "randomized",
        enabled: definition.meta.enabled,
        weight: definition.meta.weight,
        priority: definition.meta.priority,
        dryRun: false,
        promptProfilePath,
        steps: [{ kind: "llm_instruction", promptProfilePath }]
      };
    }
  };
}

export function normalizeAgentRandomEventDefinition(value: unknown, expectedId?: string): AgentRandomEventDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_random_event");
  const raw = value as Record<string, unknown>;
  if (!raw.meta || typeof raw.meta !== "object" || Array.isArray(raw.meta)) throw new Error("random_event_meta_object_required");
  const meta = raw.meta as Record<string, unknown>;
  if (typeof meta.id !== "string") throw new Error("random_event_id_required");
  validateId(meta.id);
  if (expectedId !== undefined && meta.id !== expectedId) throw new Error("random_event_id_filename_mismatch");
  if (typeof meta.enabled !== "boolean") throw new Error("random_event_enabled_boolean_required");
  if (typeof meta.weight !== "number" || !Number.isFinite(meta.weight)) throw new Error("random_event_weight_number_required");
  if (typeof meta.priority !== "number" || !Number.isFinite(meta.priority)) throw new Error("random_event_priority_number_required");
  if (!Array.isArray(raw.messages)) throw new Error("random_event_messages_array_required");
  validateStoredMessages(raw.messages);
  const layer = normalizePromptLayer(raw);
  return {
    meta: {
      ...layer.meta,
      id: meta.id,
      enabled: meta.enabled,
      weight: meta.weight,
      priority: meta.priority
    },
    messages: layer.messages
  };
}

export function randomEventDefinitionJson(definition: AgentRandomEventDefinition): string {
  return `${JSON.stringify(normalizeAgentRandomEventDefinition(definition), null, 2)}\n`;
}

function readDefinition(filePath: string, expectedId: string): AgentRandomEventDefinition {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid_random_event_file:${expectedId}`);
  return normalizeAgentRandomEventDefinition(JSON.parse(fs.readFileSync(filePath, "utf8")), expectedId);
}

function writeDefinition(root: string, definition: AgentRandomEventDefinition): void {
  const filePath = definitionPath(root, definition.meta.id);
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, randomEventDefinitionJson(definition));
  fs.renameSync(temporaryPath, filePath);
}

function definitionPath(root: string, id: string): string {
  validateId(id);
  return path.join(root, `${id}.json`);
}

function validateId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid_random_event_id");
}

function validateStoredMessages(messages: unknown[]): void {
  for (const value of messages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_random_event_message");
    const message = value as Record<string, unknown>;
    if (!message.meta || typeof message.meta !== "object" || Array.isArray(message.meta)) throw new Error("random_event_message_meta_object_required");
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") {
      throw new Error("invalid_random_event_message_role");
    }
    if (message.toolCalls === undefined) continue;
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) throw new Error("invalid_random_event_tool_calls");
    for (const value of message.toolCalls) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_random_event_tool_call");
      const call = value as Record<string, unknown>;
      const fn = call.function;
      if (typeof call.id !== "string" || !call.id || call.type !== "function" || !fn || typeof fn !== "object" || Array.isArray(fn)) {
        throw new Error("invalid_random_event_tool_call");
      }
      const definition = fn as Record<string, unknown>;
      if (typeof definition.name !== "string" || !definition.name || typeof definition.arguments !== "string") {
        throw new Error("invalid_random_event_tool_call");
      }
    }
  }
}
