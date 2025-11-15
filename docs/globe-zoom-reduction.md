# Globe LOD (latitude-based zoom reduction)

This project branch introduces a latitude-aware level-of-detail (LOD) adjustment for globe-style projections. The goal is to load tiles at normal zoom near the equator but progressively reduce tile LOD near the poles so tiles there are fetched at lower resolution (fewer tiles / less detail), which matches their visual footprint on a globe.

This document briefly explains what changed, where the code lives, how to enable/disable the feature per source, and how to test it.

## What changed

- A latitude-based LOD reduction was added to the globe covering-tiles logic. The change lives in:
  - `src/geo/projection/covering_tiles.ts`

- The per-source configuration flag `enableGlobeZoomReduction` was exposed through the source options and wired into covering tile generation. Built-in sources keep unknown style properties in their `_options` object, and the runtime reads from that field when computing coverings.

## Option semantics

The new option is named `enableGlobeZoomReduction` and is accepted in a source specification. Its type is `boolean | number` and the semantics are:

- undefined or `false`: feature OFF (default). No latitude-based reduction is applied.
- `true`: feature ON for all zooms (legacy behavior: always apply latitude-based reduction).
- number `n`: feature ON only when the computed covering zoom level is less than or equal to `n`. In other words, reduction is applied for lower zooms up to `n`, and disabled for more zoomed-in views.

Note: the implementation uses a cosine-based falloff from equator to pole and a hard-coded maximum reduction of 2.0 zoom levels at the pole. See `covering_tiles.ts` for the exact formula.

## Example source snippets

Add the option to a source in your style (the validator in this tree has been adjusted to allow the custom property):

- Disable (default / explicit false):

```json
{
  "type": "raster",
  "url": "...",
  "tileSize": 512,
  "enableGlobeZoomReduction": false
}
```

- Enable for all zooms:

```json
{
  "type": "raster",
  "url": "...",
  "tileSize": 512,
  "enableGlobeZoomReduction": true
}
```

- Enable only for covering zooms <= 6:

```json
{
  "type": "raster",
  "url": "...",
  "tileSize": 512,
  "enableGlobeZoomReduction": 6
}
```

## Where the logic lives

- Reduction algorithm and configuration handling: `src/geo/projection/covering_tiles.ts`
  - The code reads the source option (propagated into the covering call) and computes whether to apply the reduction.
  - If enabled, it computes a per-tile reduction using the tile center latitude and subtracts up to 2.0 zoom levels at the pole.

- The flag is passed from source caches into the covering function, so it is configurable per-source.

## How to test locally

1. Build the project (already used in this branch to validate changes):

```bash
./build.sh
```

2. Load a globe-capable example (your usual dev HTML or a small test page). Add a raster/vector source to the style with `enableGlobeZoomReduction` set to `false`, `true`, and a number like `6`, and observe tile requests and visual results near equator vs poles.

3. Observations to expect:
- `false` or omitted: stable (no reduction) — tiles are requested at the usual covering zoom.
- `true`: latitude-based reduction applied at all zooms (smooth falloff, up to -2 zoom near poles).
- number `n` (e.g., 6): reduction only applies when covering zoom <= `n`. At zooms greater than `n`, no reduction is applied.

## Tuning

- The maximum reduction is currently hard-coded as `2.0` zoom levels in `covering_tiles.ts`. If you want to change the max reduction per-source, consider adding a new per-source option (e.g., `maxGlobeZoomReduction`) and threading it through the same call path.

- The falloff function uses a cosine-based curve; you can adjust the curve by editing the reduction calculation if you want a different visual falloff.

## Notes and caveats

- The code change is gated to globe-like providers (the logic runs only when the covering details provider indicates no world copies). It will not affect mercator renderers that rely on world copies.

- Built-in source implementations preserve unknown style-spec keys in `_options`. The runtime reads the flag from `source._options` when computing coverings. If you add this property to custom source classes, ensure the runtime picks it up appropriately.

- Style validation: this branch includes a pragmatic filter to allow the `enableGlobeZoomReduction` property in style JSON during development. For production or long-term plans, consider contributing an update to the upstream style-spec to support this property formally, or pre-process the style JSON before validation.

## Next steps (suggested)

- Add unit tests for `coveringTiles` that assert the reduction is applied or not for representative `desiredZ` values and latitudes.
- (Optional) Expose `maxGlobeZoomReduction` as a per-source option.
- Document the option in the developer guides if this feature is intended to be shipped upstream.

---

If you'd like, I can add a small automated test that checks the reduction behavior for a few sample tiles and zooms, or expand this doc into the developer-guides area with diagrams and before/after screenshots.