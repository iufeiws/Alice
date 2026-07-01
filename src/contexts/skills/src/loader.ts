import type { SkillRegistry } from "./registry.js";
import { resolveSkillResourcePath } from "./resource-paths.js";

const fs = await import("node:fs");

export type LoadedSkill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  containerRoot: string;
  resolveResource(relativePath: string): string;
};

export function createSkillLoader(registry: SkillRegistry) {
  return {
    load(idOrName: string): LoadedSkill {
      const skill = registry.get(idOrName);
      if (!skill) throw new Error(`unknown skill: ${idOrName}`);
      if (!fs.existsSync(skill.instructionPath)) throw new Error(`missing Skill instructions: ${skill.id}`);
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        instructions: fs.readFileSync(skill.instructionPath, "utf8"),
        containerRoot: skill.containerRoot,
        resolveResource(relativePath) {
          return resolveSkillResourcePath(skill, relativePath);
        }
      };
    }
  };
}
