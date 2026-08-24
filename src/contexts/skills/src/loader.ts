import type { BashSandboxSkillMountConfig } from "../../bash-sandbox/src/index.js";
import type { SkillMetadata, SkillRegistry } from "./registry.js";
import { resolveSkillResourcePath } from "./resource-paths.js";
import { replaceSkillPlaceholders } from "./placeholders.js";
import { parse as parseShellQuote } from "shell-quote";

const fs = await import("node:fs");

export type LoadedSkill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  sandboxRoot: string;
  resolveResource(relativePath: string): string;
};

export class SkillLoadError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SkillLoadError";
  }
}

export function createSkillLoader(
  registry: SkillRegistry,
  sandbox?: { mountSkill(mount: BashSandboxSkillMountConfig): BashSandboxSkillMountConfig },
  onLoad?: (skill: SkillMetadata) => void,
  resolveVariable?: (name: string) => string | undefined
) {
  return {
    load(name: string, args = ""): LoadedSkill {
      const skill = registry.get(name);
      if (!skill) throw new SkillLoadError("SKILL_NOT_FOUND");
      validateLoadable(skill);
      if (!fs.existsSync(skill.instructionPath)) throw new SkillLoadError("SKILL_NOT_FOUND");
      const instructions = renderSkillInstructions(fs.readFileSync(skill.instructionPath, "utf8"), args);
      sandbox?.mountSkill({
        id: skill.name,
        hostPath: skill.hostRoot,
        containerPath: skill.sandboxRoot,
        readOnly: false
      });
      onLoad?.(skill);
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        instructions: expandVariablePlaceholders(instructions, resolveVariable),
        sandboxRoot: skill.sandboxRoot,
        resolveResource(relativePath) {
          return resolveSkillResourcePath(skill, relativePath);
        }
      };
    }
  };
}

function expandVariablePlaceholders(content: string, resolveVariable?: (name: string) => string | undefined): string {
  if (!resolveVariable) return content;
  const keys = [...new Set([...content.matchAll(/\$\{\{([A-Za-z0-9_.-]+)\}\}/g)].map((match) => match[1]))];
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = resolveVariable(key);
    if (value !== undefined) values[key] = value;
  }
  return replaceSkillPlaceholders(content, values);
}

function validateLoadable(skill: SkillMetadata): void {
  if (skill.disabled) throw new SkillLoadError("SKILL_DISABLED");
  if (skill.disableModelInvocation) throw new SkillLoadError("SKILL_NOT_MODEL_INVOCABLE");
  if (skill.unsupported === "fork") throw new SkillLoadError("FORK_NOT_SUPPORTED");
  if (skill.unsupported === "dynamic-context") throw new SkillLoadError("DYNAMIC_CONTEXT_NOT_SUPPORTED");
}

function renderSkillInstructions(content: string, args: string): string {
  if (!args) return content;
  const positional = parseShellQuote(args, (key) => `$${key}`).filter((entry): entry is string => typeof entry === "string");
  return content.replace(/\$ARGUMENTS(?:\[(\d+)])?|\$(\d+)/g, (_match, bracketIndex: string | undefined, dollarIndex: string | undefined) => {
    if (bracketIndex !== undefined) return positional[Number(bracketIndex)] ?? "";
    if (dollarIndex !== undefined) return positional[Number(dollarIndex)] ?? "";
    return args;
  });
}
