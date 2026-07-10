export type WardrobeItem = {
  id: string;
  name: string;
  content: string;
  group?: string;
  imageUrl?: string;
  onBodyImageUrl?: string;
  outfitImageGenerated?: boolean;
  onBodyGenerationAttempted?: boolean;
};

export function pickWardrobeItem(items: WardrobeItem[]): WardrobeItem {
  return items[Math.floor(Math.random() * items.length)] ?? items[0];
}

export function findWardrobeItem(items: WardrobeItem[], id: string): WardrobeItem | undefined {
  return items.find((item) => item.id === id);
}

export function filterWardrobeItems(items: WardrobeItem[], query: string): WardrobeItem[] {
  const normalizedQuery = normalizeSearchText(query);
  return items.filter((item) => wardrobeSearchText(item).includes(normalizedQuery));
}

export function resolveWardrobeItemByName(items: WardrobeItem[], name: string):
  | { kind: "one"; item: WardrobeItem }
  | { kind: "ambiguous"; items: WardrobeItem[] }
  | { kind: "none" } {
  const normalizedName = normalizeSearchText(name);
  const exact = items.filter((item) => normalizeSearchText(item.name) === normalizedName);
  if (exact.length === 1) return { kind: "one", item: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", items: exact };

  const matches = filterWardrobeItems(items, name);
  if (matches.length === 1) return { kind: "one", item: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", items: matches };
  return { kind: "none" };
}

export function shouldAttemptOnBodyGeneration(item: WardrobeItem): boolean {
  return item.outfitImageGenerated !== true && item.onBodyGenerationAttempted !== true;
}

function wardrobeSearchText(item: WardrobeItem): string {
  return normalizeSearchText([
    item.name,
    item.id,
    item.group ?? "",
    item.content
  ].join("\n"));
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}
