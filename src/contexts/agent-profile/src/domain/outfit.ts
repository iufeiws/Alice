import type { ShellOption } from "./shell.js";

export function pickOutfit(outfits: ShellOption[]): ShellOption {
  return outfits[Math.floor(Math.random() * outfits.length)] ?? outfits[0];
}

export function findOutfit(outfits: ShellOption[], id: string): ShellOption | undefined {
  return outfits.find((outfit) => outfit.id === id);
}

export function filterOutfits(outfits: ShellOption[], query: string): ShellOption[] {
  const normalizedQuery = normalizeSearchText(query);
  return outfits.filter((outfit) => outfitSearchText(outfit).includes(normalizedQuery));
}

export function resolveOutfitByName(outfits: ShellOption[], name: string):
  | { kind: "one"; outfit: ShellOption }
  | { kind: "ambiguous"; outfits: ShellOption[] }
  | { kind: "none" } {
  const normalizedName = normalizeSearchText(name);
  const exact = outfits.filter((outfit) => normalizeSearchText(outfit.name) === normalizedName);
  if (exact.length === 1) return { kind: "one", outfit: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", outfits: exact };

  const matches = filterOutfits(outfits, name);
  if (matches.length === 1) return { kind: "one", outfit: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", outfits: matches };
  return { kind: "none" };
}

export function shouldAttemptOnBodyGeneration(outfit: ShellOption): boolean {
  return outfit.outfitImageGenerated !== true && outfit.onBodyGenerationAttempted !== true;
}

function outfitSearchText(outfit: ShellOption): string {
  return normalizeSearchText([
    outfit.name,
    outfit.id,
    outfit.group ?? "",
    outfit.content
  ].join("\n"));
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}
