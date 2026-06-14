# Google Static Street View Channel Plugin Plan

## Summary

Add a pure channel plugin under `src/channels/google-streetview` for fetching Google Static Street View images by explicit coordinates or by random coordinates sampled from configured regions. Images are stored as plugin-owned assets under `assets/plugin/google-streetview`, not under `assets/generated`, so future street-view check-in selfie flows can reuse them.

This change does not expose an agent tool, does not integrate with `photo/selfie`, and does not add or concatenate prompt text.

## Key Changes

- Add `google_streetview` channel plugin exports:
  - `createGoogleStreetViewPlugin`
  - `readGoogleStreetViewPluginConfig`
  - `publicGoogleStreetViewPluginConfig`
  - reusable public config/result/input types.
- Provide plugin methods:
  - `getStreetViewByCoordinates({ lat, lng, regionId?, reuseStoredForLocation? })`
  - `getRandomStreetView({ regionId?, reuseStoredForLocation? })`
- Add plugin config at `config/plugin/google-streetview/config.json`:
  - `enabled`, `apiKey`, image request parameters, radius expansion settings, `coordinatePrecision`, `outputDir`, and configured `regions`.
- Support `reuseStoredForLocation`:
  - When enabled, compute a coordinate bucket using configured precision.
  - If one or more saved sidecar metadata files match that bucket, randomly return one stored asset.
  - Return `reused: true` and `source: "stored"` for local hits.
- Save downloaded images and metadata sidecars under `assets/plugin/google-streetview/<yyyy-mm>/`.
- Reject output directories outside `assets/plugin/google-streetview` and reject `assets/generated`.

## Admin / Runtime Integration

- Register the plugin in the Admin plugin registry as a configurable channel plugin.
- Hide API key values in public config responses with `apiKeySet`.
- Read defaults from `GOOGLE_STREETVIEW_API_KEY` where available.
- Do not register this plugin as an output channel and do not add it to `toolPlugins`.

## Tests

- Add `tests/google-streetview-plugin.test.ts`.
- Cover config defaults and API key hiding.
- Cover coordinate fetch, metadata preflight, image saving, and sidecar writing.
- Cover stored result reuse with no Google fetch.
- Cover coordinate bucket isolation.
- Cover radius expansion failure.
- Cover random region sampling and retry.
- Cover output path validation, including rejection of `assets/generated`.

## Assumptions

- "Pure channel plugin" means no LLM tool exposure in this change.
- "API config add to plugin" means plugin-owned config under `config/plugin/google-streetview/config.json`.
- "This location" for reuse means the rounded coordinate bucket, default precision 5.
- "One or more results" means at least one stored asset is enough to reuse.
- Future selfie prompt/template changes require separate user confirmation.
