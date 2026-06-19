# Google Street View Channel

`google-streetview` is a pure channel plugin for fetching Google Static Street View images by coordinates or by random coordinates sampled from configured regions.

It is intended as reusable infrastructure for future street-view check-in selfie features. It does not expose an agent tool and does not add prompt text.

## Config

Default config path:

```text
config/plugin/google-streetview/config.json
```

Supported fields:

```json
{
  "enabled": true,
  "apiKey": "",
  "imageSize": "640x640",
  "heading": 0,
  "pitch": 0,
  "fov": 90,
  "initialRadiusMeters": 50,
  "radiusExpansionFactor": 2,
  "maxRadiusMeters": 1000,
  "randomAttempts": 8,
  "coordinatePrecision": 5,
  "outputDir": "assets/plugin/google-streetview",
  "regions": [
    {
      "id": "tokyo",
      "label": "Tokyo",
      "bounds": {
        "north": 35.817,
        "south": 35.52,
        "east": 139.92,
        "west": 139.56
      }
    }
  ]
}
```

`apiKey` can also be provided with `GOOGLE_STREETVIEW_API_KEY`. Public config responses expose only `apiKeySet`.

## API

```ts
const plugin = createGoogleStreetViewPlugin({ configPath });

await plugin.getStreetViewByCoordinates({
  lat: 35.681236,
  lng: 139.767125,
  regionId: "tokyo",
  reuseStoredForLocation: true
});

await plugin.getRandomStreetView({
  regionId: "tokyo",
  reuseStoredForLocation: true
});
```

When `reuseStoredForLocation` is enabled, the plugin checks existing metadata for the rounded coordinate bucket. If one or more stored assets match, it randomly returns one local result with `reused: true` and `source: "stored"` without calling Google.

## Storage

Images are stored under:

```text
assets/plugin/google-streetview/<yyyy-mm>/
```

Each pano has one JSON metadata file. Images use the same basename with `.jpg`. The configured output directory must stay under `assets/plugin/google-streetview`; `assets/generated` is rejected because these are plugin-owned assets, not generated selfie outputs.
