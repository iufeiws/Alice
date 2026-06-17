import type {
  GoogleStreetViewPanoGraphLink,
  GoogleStreetViewPanoGraphResult
} from "../../../channels/google-streetview/src/index.js";
import type {
  WorldWandererConfig,
  WorldWandererPathEntry,
  WorldWandererState
} from "./types.js";
import { headingDelta } from "./geo.js";

export function chooseNextLink(input: {
  currentPano: GoogleStreetViewPanoGraphResult;
  state: Pick<WorldWandererState, "lastHeading" | "lastRoadText" | "recentPanoIds" | "pathStack">;
  config: WorldWandererConfig;
  random: () => number;
}): { link: GoogleStreetViewPanoGraphLink; backtrack: boolean } | undefined {
  const links = input.currentPano.links.filter((link) => link.panoId !== input.currentPano.panoId);
  if (!links.length) return undefined;
  const recentSet = new Set(input.state.recentPanoIds.slice(-input.config.recentHistoryLimit));
  const reverseLink = visibleReverseLink(links, input.state.pathStack);
  if (reverseLink && links.every((link) => recentSet.has(link.panoId))) return { link: reverseLink, backtrack: true };

  const scored = links.map((link) => ({
    link,
    score: scoreLink(link, input.state, recentSet, input.config)
  }));
  const selected = softmaxSelect(scored, input.config.selectionTemperature, input.random);
  if (!selected) return undefined;
  return {
    link: selected.link,
    backtrack: Boolean(reverseLink && selected.link.panoId === reverseLink.panoId)
  };
}

function scoreLink(
  link: GoogleStreetViewPanoGraphLink,
  state: Pick<WorldWandererState, "lastHeading" | "lastRoadText">,
  recentSet: Set<string>,
  config: WorldWandererConfig
): number {
  const delta = headingDelta(link.heading, state.lastHeading);
  let score = recentSet.has(link.panoId) ? -config.loopPenalty : config.noveltyWeight;
  score += config.forwardWeight * (1 - delta / 180);
  if (state.lastRoadText && link.text && state.lastRoadText === link.text) score += config.roadContinuityWeight;
  if (delta >= 135) score -= config.uturnPenalty;
  return score;
}

function softmaxSelect<T extends { score: number }>(items: T[], temperature: number, random: () => number): T | undefined {
  if (!items.length) return undefined;
  const maxScore = Math.max(...items.map((item) => item.score));
  const weights = items.map((item) => Math.exp((item.score - maxScore) / temperature));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = random() * total;
  for (let index = 0; index < items.length; index += 1) {
    const weight = weights[index]!;
    if (cursor < weight) return items[index];
    cursor -= weight;
  }
  return items[items.length - 1];
}

function visibleReverseLink(links: GoogleStreetViewPanoGraphLink[], pathStack: WorldWandererPathEntry[]): GoogleStreetViewPanoGraphLink | undefined {
  const previous = pathStack[pathStack.length - 1];
  return previous ? links.find((link) => link.panoId === previous.panoId) : undefined;
}
