import type { LoadedSkill } from "../../../../contexts/skills/src/index.js";
import { SkillLoadError } from "../../../../contexts/skills/src/index.js";
import type { ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { skillTool } from "../profile.js";

export function createSkillsTools(input: { loader: { load(name: string, args?: string): LoadedSkill } }): ToolPlugin {
  return {
    id: "skills",
    listTools() {
      return [skillTool];
    },
    async execute(call) {
      if (call.toolName !== "Skill") return { callId: call.id, ok: false, error: `Unknown skills tool: ${call.toolName}` };
      try {
        const skill = input.loader.load(stringValue(call.input.skill), stringValue(call.input.args));
        return {
          callId: call.id,
          ok: true,
          output: formatSkillResult(skill)
        };
      } catch (error) {
        if (error instanceof SkillLoadError) return { callId: call.id, ok: false, error: error.code };
        throw error;
      }
    }
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatSkillResult(skill: LoadedSkill): string {
  return [
    `<${skill.name}>`,
    `<path>${escapeXml(skill.sandboxRoot)}</path>`,
    escapeXml(skill.instructions),
    `</${skill.name}>`
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
