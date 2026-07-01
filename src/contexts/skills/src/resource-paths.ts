import type { SkillMetadata } from "./registry.js";

const path = await import("node:path");

export function resolveSkillResourcePath(skill: SkillMetadata, relativePath: string): string {
  const clean = relativePath.replace(/^\.?\//, "");
  const hostPath = path.resolve(skill.hostRoot, clean);
  if (hostPath !== skill.hostRoot && !hostPath.startsWith(`${skill.hostRoot}${path.sep}`)) {
    throw new Error(`skill resource escapes skill root: ${relativePath}`);
  }
  return `${skill.containerRoot.replace(/\/+$/, "")}/${clean}`;
}
