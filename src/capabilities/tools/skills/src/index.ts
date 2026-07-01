import type { SkillRegistry, LoadedSkill } from "../../../../contexts/skills/src/index.js";
import type { ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { listSkillsTool, loadSkillTool } from "../profile.js";

export function createSkillsTools(input: { registry: SkillRegistry; loader: { load(idOrName: string): LoadedSkill } }): ToolPlugin {
  return {
    id: "skills",
    listTools() {
      return [listSkillsTool, loadSkillTool];
    },
    async execute(call) {
      if (call.toolName === "list_skills") {
        return {
          callId: call.id,
          ok: true,
          output: JSON.stringify(input.registry.list().map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            containerRoot: skill.containerRoot
          })))
        };
      }
      if (call.toolName === "load_skill") {
        const skill = input.loader.load(stringValue(call.input.skill));
        return {
          callId: call.id,
          ok: true,
          output: JSON.stringify({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            instructions: skill.instructions,
            containerRoot: skill.containerRoot
          })
        };
      }
      return { callId: call.id, ok: false, error: `Unknown skills tool: ${call.toolName}` };
    }
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
