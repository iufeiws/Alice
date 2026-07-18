import { isDeepStrictEqual } from "node:util";
import type { ApprovalService } from "../../../approval/src/index.js";
import type { BashRuntimeResult, BashSandboxRuntime } from "../../../bash-sandbox/src/index.js";
import {
  normalizeAgentRandomEventDefinition,
  randomEventDefinitionJson,
  type AgentRandomEventDefinition,
  type AgentRandomEventStore
} from "../adapters/json-random-event-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

export const initiatedBehaviorManagingSubmissionMarker = "ALICE_INITIATED_BEHAVIORS_SUBMIT_V1";
export const initiatedBehaviorManagingSkillName = "initiated-behavior-managing";
export const initiatedBehaviorManagingWorkspacePath = `/skills/${initiatedBehaviorManagingSkillName}/events`;

export type RandomEventSubmissionResult = {
  type: "random_events";
  results: Array<{
    id: string;
    operation: "create" | "update" | "delete";
    status: "approved" | "rejected" | "stale";
    comment?: string;
  }>;
};

export function createRandomEventSandboxRuntime(input: {
  store: AgentRandomEventStore;
  hostWorkspaceRoot: string;
  sandbox: BashSandboxRuntime;
  getApprovalService(): ApprovalService;
}) {
  const workspaceRoot = path.resolve(input.hostWorkspaceRoot, ".skills", initiatedBehaviorManagingSkillName, "events");

  return {
    prepareSkill(skill: { name: string; hostRoot: string; sandboxRoot: string }): void {
      if (skill.name !== initiatedBehaviorManagingSkillName) return;
      resetWorkspace(workspaceRoot, input.store.list());
      input.sandbox.mountSkill({
        id: `${initiatedBehaviorManagingSkillName}-events`,
        hostPath: workspaceRoot,
        containerPath: initiatedBehaviorManagingWorkspacePath,
        readOnly: false
      });
    },
    async handleBashResult(result: BashRuntimeResult): Promise<RandomEventSubmissionResult | undefined> {
      if (result.exitCode !== 0 || result.timedOut || result.denied || result.stdout.trim() !== initiatedBehaviorManagingSubmissionMarker) return undefined;
      return await submitWorkspace({
        workspaceRoot,
        store: input.store,
        approval: input.getApprovalService()
      });
    }
  };
}

async function submitWorkspace(input: {
  workspaceRoot: string;
  store: AgentRandomEventStore;
  approval: ApprovalService;
}): Promise<RandomEventSubmissionResult> {
  const proposed = readWorkspace(input.workspaceRoot);
  const current = new Map(input.store.list().map((definition) => [definition.meta.id, definition]));
  const ids = [...new Set([...current.keys(), ...proposed.keys()])].sort();
  const changes = ids.flatMap((id) => {
    const before = current.get(id);
    const after = proposed.get(id);
    if (before && after && isDeepStrictEqual(before, after)) return [];
    return [{
      id,
      before,
      after,
      operation: before ? after ? "update" as const : "delete" as const : "create" as const
    }];
  });
  const results: RandomEventSubmissionResult["results"] = [];
  for (const change of changes) {
    const decision = await input.approval.request({
      title: `${operationLabel(change.operation)} Random Event：${change.id}`,
      content: approvalContent(change.operation, change.before, change.after)
    });
    if (decision.status === "rejected") {
      results.push({ id: change.id, operation: change.operation, status: "rejected", comment: decision.comment });
      continue;
    }
    const live = input.store.get(change.id);
    if (!isDeepStrictEqual(live, change.before)) {
      results.push({ id: change.id, operation: change.operation, status: "stale" });
      continue;
    }
    if (change.after) input.store.save(change.after);
    else input.store.delete(change.id);
    results.push({ id: change.id, operation: change.operation, status: "approved", comment: decision.comment });
  }
  return { type: "random_events", results };
}

function readWorkspace(root: string): Map<string, AgentRandomEventDefinition> {
  const definitions = new Map<string, AgentRandomEventDefinition>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error(`invalid_random_event_workspace_entry:${entry.name}`);
    const id = entry.name.slice(0, -5);
    const filePath = path.join(root, entry.name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filePath) !== filePath) throw new Error(`invalid_random_event_workspace_file:${entry.name}`);
    definitions.set(id, normalizeAgentRandomEventDefinition(JSON.parse(fs.readFileSync(filePath, "utf8")), id));
  }
  return definitions;
}

function resetWorkspace(root: string, definitions: AgentRandomEventDefinition[]): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const definition of definitions) fs.writeFileSync(path.join(root, `${definition.meta.id}.json`), randomEventDefinitionJson(definition));
}

function approvalContent(
  operation: "create" | "update" | "delete",
  before: AgentRandomEventDefinition | undefined,
  after: AgentRandomEventDefinition | undefined
): string {
  return [
    `操作：${operationLabel(operation)}`,
    before ? `\n修改前：\n\`\`\`json\n${randomEventDefinitionJson(before)}\`\`\`` : "\n修改前：不存在",
    after ? `\n修改后：\n\`\`\`json\n${randomEventDefinitionJson(after)}\`\`\`` : "\n修改后：不存在"
  ].join("\n");
}

function operationLabel(operation: "create" | "update" | "delete"): string {
  if (operation === "create") return "创建";
  if (operation === "update") return "修改";
  return "删除";
}
