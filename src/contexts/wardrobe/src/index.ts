export type Outfit = {
  id: string;
  name: string;
  content: string;
  group?: string;
  imageUrl?: string;
  onBodyImageUrl?: string;
  outfitImageGenerated?: boolean;
  onBodyGenerationAttempted?: boolean;
};

export function pickOutfit(outfits: Outfit[]): Outfit {
  return outfits[Math.floor(Math.random() * outfits.length)] ?? outfits[0];
}

export function findOutfit(outfits: Outfit[], id: string): Outfit | undefined {
  return outfits.find((outfit) => outfit.id === id);
}

export function filterOutfits(outfits: Outfit[], query: string): Outfit[] {
  const normalizedQuery = normalizeSearchText(query);
  return outfits.filter((outfit) => outfitSearchText(outfit).includes(normalizedQuery));
}

export function resolveOutfitByName(outfits: Outfit[], name: string):
  | { kind: "one"; outfit: Outfit }
  | { kind: "ambiguous"; outfits: Outfit[] }
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

export function shouldAttemptOnBodyGeneration(outfit: Outfit): boolean {
  return outfit.outfitImageGenerated !== true && outfit.onBodyGenerationAttempted !== true;
}

function outfitSearchText(outfit: Outfit): string {
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
