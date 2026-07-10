import type {
  GoogleStreetViewLocation,
  GoogleStreetViewPanoGraphResult
} from "../../../channels/google-streetview/src/index.js";
import { readWorldWandererConfig, writeWorldWandererConfig } from "./config.js";
import { distanceMeters, moveLocation, normalizeHeading } from "./geo.js";
import { chooseNextLink } from "./policy.js";
import {
  appendWorldWandererPathEntries,
  pathEntryFromPano,
  prunePathStack,
  readWorldWandererState,
  stateFromPath,
  writeWorldWandererState
} from "./state.js";
import type {
  WorldWandererConfig,
  WorldWandererDeps,
  WorldWandererRuntime,
  WorldWandererState
} from "./types.js";
import { defaultWorldWandererPluginConfigPath } from "./types.js";

const targetArrivalRadiusMeters = 50;

export function createWorldWandererRuntime(deps: WorldWandererDeps): WorldWandererRuntime {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());

  return {
    isEnabled() {
      return readWorldWandererConfig(deps.configPath).enabled;
    },
    async runIdleTransition(input) {
      let config = readWorldWandererConfig(deps.configPath);
      if (!config.enabled) return undefined;

      const previous = readWorldWandererState(deps.dbPath, config);
      const updatedAt = now().toISOString();

      try {
        let currentPano = await resolveCurrentPano(previous, config);
        let newPathEntries: ReturnType<typeof pathEntryFromPano>[] = [];
        let replacePath = false;
        let pathStack = previous.pathStack;
        if (!pathStack.length) {
          const entry = pathEntryFromPano({ pano: currentPano, lastHeading: previous.lastHeading, time: updatedAt });
          pathStack = [entry];
          newPathEntries = [entry];
        }
        let targetLocation = config.targetLocation;
        if (targetLocation && distanceMeters(currentPano.location, targetLocation) <= targetArrivalRadiusMeters) {
          config = clearTargetLocation(config);
          targetLocation = undefined;
        }
        if (!hasMovableLinks(currentPano)) {
          const nearbyPano = await findNearbyLinkedPano(currentPano.location);
          if (nearbyPano) {
            deps.appendLog?.("info", `world wanderer nearby linked pano selected: from=${currentPano.panoId} pano=${nearbyPano.panoId} links=${nearbyPano.links.length}`);
            currentPano = nearbyPano;
            const entry = pathEntryFromPano({ pano: currentPano, lastHeading: previous.lastHeading, time: updatedAt });
            pathStack = [entry];
            newPathEntries = [entry];
            replacePath = true;
          }
        }
        let lastHeading = previous.lastHeading;
        let accumulatedMeters = 0;
        let movedPanos = 0;
        const targetMeters = Math.max(0, input.delayMs) / 1000 * config.speedMetersPerSecond;

        moveLoop: while (movedPanos < config.maxPanosPerIdle && (movedPanos === 0 || accumulatedMeters < targetMeters)) {
          const failedLinkPanoIds = new Set<string>();
          let decision: ReturnType<typeof chooseNextLink> | undefined;
          let nextPano: GoogleStreetViewPanoGraphResult | undefined;
          while (!nextPano) {
            decision = chooseNextLink({
              currentPano,
              state: {
                lastHeading,
                pathStack
              },
              config,
              targetLocation,
              avoidPanoIds: failedLinkPanoIds,
              random
            });
            if (!decision) {
              if (movedPanos > 0) break moveLoop;
              const nearbyPano = await findNearbyLinkedPano(currentPano.location, new Set(pathStack.map((entry) => entry.panoId)));
              if (!nearbyPano) break moveLoop;
              deps.appendLog?.("info", `world wanderer nearby linked pano selected: from=${currentPano.panoId} pano=${nearbyPano.panoId} links=${nearbyPano.links.length}`);
              currentPano = nearbyPano;
              const entry = pathEntryFromPano({ pano: currentPano, lastHeading, time: updatedAt });
              pathStack = [entry];
              newPathEntries = [entry];
              replacePath = true;
              continue moveLoop;
            }
            try {
              nextPano = await deps.googleStreetView.getPanoGraphByPanoId({ panoId: decision.link.panoId });
            } catch (error) {
              failedLinkPanoIds.add(decision.link.panoId);
              deps.appendLog?.("warn", `world wanderer link pano failed: pano=${decision.link.panoId} error=${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (!decision) break;
          accumulatedMeters += distanceMeters(currentPano.location, nextPano.location);
          movedPanos += 1;
          lastHeading = normalizeHeading(decision.link.heading);
          currentPano = nextPano;
          const entry = pathEntryFromPano({ pano: currentPano, lastHeading, time: updatedAt });
          pathStack = prunePathStack([...pathStack, entry], config.recentHistoryLimit);
          newPathEntries.push(entry);
          if (targetLocation && distanceMeters(currentPano.location, targetLocation) <= targetArrivalRadiusMeters) {
            config = clearTargetLocation(config);
            targetLocation = undefined;
            break;
          }
        }

        const next = stateFromPath(pathStack, config);
        if (replacePath) {
          writeWorldWandererState(deps.dbPath, next, config.recentHistoryLimit);
        } else {
          appendWorldWandererPathEntries(deps.dbPath, newPathEntries, config.recentHistoryLimit);
        }
        if (movedPanos > 0) {
          deps.appendLog?.(
            "info",
            `world wanderer moved: pano=${next.panoId ?? "unknown"} steps=${movedPanos} distance=${accumulatedMeters.toFixed(1)}m heading=${lastHeading.toFixed(1)}`
          );
        } else {
          deps.appendLog?.("warn", `world wanderer stuck: pano=${next.panoId ?? "unknown"} has no linked nearby pano`);
        }
        return next;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const next = {
          ...previous
        };
        deps.appendLog?.("warn", `world wanderer pano graph failed: ${message}`);
        return next;
      }
    },
    getState() {
      return readWorldWandererState(deps.dbPath, readWorldWandererConfig(deps.configPath));
    }
  };

  async function resolveCurrentPano(state: WorldWandererState, config: WorldWandererConfig): Promise<GoogleStreetViewPanoGraphResult> {
    if (state.panoId) {
      return deps.googleStreetView.getPanoGraphByPanoId({ panoId: state.panoId });
    }
    return deps.googleStreetView.getPanoGraphByCoordinates(config.initialLocation);
  }

  function clearTargetLocation(config: WorldWandererConfig): WorldWandererConfig {
    const next = { ...config };
    delete next.targetLocation;
    writeWorldWandererConfig(deps.configPath ?? defaultWorldWandererPluginConfigPath, next);
    deps.appendLog?.("info", "world wanderer target reached and cleared");
    return next;
  }

  async function findNearbyLinkedPano(location: GoogleStreetViewLocation, avoidPanoIds = new Set<string>()): Promise<GoogleStreetViewPanoGraphResult | undefined> {
    for (const distance of [30, 60]) {
      for (const heading of [0, 90, 180, 270]) {
        const candidate = await deps.googleStreetView.getPanoGraphByCoordinates(moveLocation(location, heading, distance));
        if (!avoidPanoIds.has(candidate.panoId) && hasMovableLinks(candidate)) return candidate;
      }
    }
    return undefined;
  }
}

function hasMovableLinks(pano: GoogleStreetViewPanoGraphResult): boolean {
  return pano.links.some((link) => link.panoId !== pano.panoId);
}
