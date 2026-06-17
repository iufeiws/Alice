import type { GoogleStreetViewPanoGraphResult } from "../../../channels/google-streetview/src/index.js";
import { readWorldWandererConfig } from "./config.js";
import { distanceMeters, normalizeHeading } from "./geo.js";
import { chooseNextLink } from "./policy.js";
import {
  appendRecentPanoId,
  pushPathStack,
  readWorldWandererState,
  stateFromPano,
  writeWorldWandererState
} from "./state.js";
import type {
  WorldWandererConfig,
  WorldWandererDeps,
  WorldWandererRuntime,
  WorldWandererState
} from "./types.js";

export function createWorldWandererRuntime(deps: WorldWandererDeps): WorldWandererRuntime {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());

  return {
    async runIdleTransition(input) {
      const config = readWorldWandererConfig(deps.configPath);
      if (!config.enabled) return undefined;

      const previous = readWorldWandererState(deps.statePath, config, now);
      const updatedAt = now().toISOString();

      try {
        let currentPano = await resolveCurrentPano(previous, config);
        let recentPanoIds = appendRecentPanoId(previous.recentPanoIds, currentPano.panoId, config.recentHistoryLimit);
        let pathStack = previous.pathStack;
        let lastHeading = previous.lastHeading;
        let lastRoadText = previous.lastRoadText;
        let accumulatedMeters = 0;
        let movedPanos = 0;
        const targetMeters = Math.max(0, input.delayMs) / 1000 * config.speedMetersPerSecond;

        while (movedPanos < config.maxPanosPerIdle && (movedPanos === 0 || accumulatedMeters < targetMeters)) {
          const decision = chooseNextLink({
            currentPano,
            state: {
              lastHeading,
              lastRoadText,
              recentPanoIds,
              pathStack
            },
            config,
            random
          });
          if (!decision) break;

          const nextPano = await deps.googleStreetView.getPanoGraphByPanoId({ panoId: decision.link.panoId });
          accumulatedMeters += distanceMeters(currentPano.location, nextPano.location);
          movedPanos += 1;
          recentPanoIds = appendRecentPanoId(recentPanoIds, nextPano.panoId, config.recentHistoryLimit);
          pathStack = decision.backtrack
            ? pathStack.slice(0, -1)
            : pushPathStack(pathStack, currentPano, config.recentHistoryLimit);
          lastHeading = normalizeHeading(decision.link.heading);
          lastRoadText = decision.link.text;
          currentPano = nextPano;
        }

        const next = stateFromPano({
          pano: currentPano,
          lastHeading,
          lastRoadText,
          recentPanoIds,
          pathStack,
          updatedAt
        });
        writeWorldWandererState(deps.statePath, next);
        deps.appendLog?.(
          "info",
          `world wanderer moved: pano=${next.panoId ?? "unknown"} steps=${movedPanos} distance=${accumulatedMeters.toFixed(1)}m heading=${lastHeading.toFixed(1)}`
        );
        return next;
      } catch (error) {
        const lastFailure = {
          message: error instanceof Error ? error.message : String(error),
          at: updatedAt
        };
        const next = {
          ...previous,
          lastFailure,
          updatedAt
        };
        writeWorldWandererState(deps.statePath, next);
        deps.appendLog?.("warn", `world wanderer pano graph failed: ${lastFailure.message}`);
        return next;
      }
    },
    getState() {
      return readWorldWandererState(deps.statePath, readWorldWandererConfig(deps.configPath), now);
    }
  };

  async function resolveCurrentPano(state: WorldWandererState, config: WorldWandererConfig): Promise<GoogleStreetViewPanoGraphResult> {
    if (state.panoId) {
      try {
        return await deps.googleStreetView.getPanoGraphByPanoId({ panoId: state.panoId });
      } catch {
        return deps.googleStreetView.getPanoGraphByCoordinates(state.location);
      }
    }
    return deps.googleStreetView.getPanoGraphByCoordinates(config.initialLocation);
  }
}
