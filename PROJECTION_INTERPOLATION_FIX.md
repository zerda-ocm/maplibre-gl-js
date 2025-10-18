# Fix for Label and Collision Box Misalignment During Projection Interpolation

## Problem Description

When using projection interpolation with a configuration like:
```json
"projection": {
  "type": ["interpolate", ["linear"], ["zoom"], 10, "vertical-perspective", 12, "mercator"]
}
```

Between zoom levels 10 and 12, labels and their collision boxes/circles do not align correctly. This creates a visual mismatch where the text appears in one location but its collision detection happens at a different location.

## Root Cause

The issue occurs because of a mismatch between:

1. **GPU-side rendering (shader)**: Uses `u_projection_transition` to smoothly interpolate positions between the two projections
2. **CPU-side collision detection**: Uses only one projection (either vertical-perspective OR mercator) without interpolation

### Technical Details

The problem was in `/src/geo/projection/globe_transform.ts`:

```typescript
// OLD CODE - Problem
public projectTileCoordinates(x: number, y: number, unwrappedTileID: UnwrappedTileID, getElevation: (x: number, y: number) => number): PointProjection {
    return this.currentTransform.projectTileCoordinates(x, y, unwrappedTileID, getElevation);
}
```

The `currentTransform` property switches abruptly from one projection to another based on the `_globeness` value, without interpolating the projected coordinates during the transition.

Meanwhile, in the shader (`_projection_globe.vertex.glsl`), positions are interpolated:

```glsl
vec4 interpolateProjection(vec2 posInTile, vec3 spherePos, float elevation) {
    vec3 elevatedPos = spherePos * (1.0 + elevation / GLOBE_RADIUS);
    vec4 globePosition = u_projection_matrix * vec4(elevatedPos, 1.0);
    // ...
    if (u_projection_transition > 0.999) {
        return globePosition;
    }
    vec4 flatPosition = u_projection_fallback_matrix * vec4(posInTile, elevation, 1.0);
    // ...
    result.xyw = mix(flatPosition.xyw, globePosition.xyw, u_projection_transition);
    // ...
}
```

## Solution

Modified `GlobeTransform.projectTileCoordinates()` to interpolate projected positions when transitioning between projections (when `0 < _globeness < 1`):

```typescript
public projectTileCoordinates(x: number, y: number, unwrappedTileID: UnwrappedTileID, getElevation: (x: number, y: number) => number): PointProjection {
    // When transitioning between projections, we need to interpolate the projected positions
    // to match what the shader does with u_projection_transition. Otherwise collision boxes
    // and labels will not align during the transition.
    if (this._globeness > 0 && this._globeness < 1) {
        const mercatorProjected = this._mercatorTransform.projectTileCoordinates(x, y, unwrappedTileID, getElevation);
        const verticalProjected = this._verticalPerspectiveTransform.projectTileCoordinates(x, y, unwrappedTileID, getElevation);

        return {
            point: new Point(
                lerp(mercatorProjected.point.x, verticalProjected.point.x, this._globeness),
                lerp(mercatorProjected.point.y, verticalProjected.point.y, this._globeness)
            ),
            signedDistanceFromCamera: lerp(mercatorProjected.signedDistanceFromCamera, verticalProjected.signedDistanceFromCamera, this._globeness),
            isOccluded: verticalProjected.isOccluded // Use globe occlusion during transition
        };
    }
    return this.currentTransform.projectTileCoordinates(x, y, unwrappedTileID, getElevation);
}
```

## Changes Made

1. **Modified** `/src/geo/projection/globe_transform.ts`:
   - Changed `Point` import from `import type` to regular `import` (needed to construct Point objects)
   - Updated `projectTileCoordinates()` to interpolate positions during projection transitions

## How It Works

1. During projection transition (`0 < _globeness < 1`):
   - Projects the same coordinate using both mercator and vertical-perspective transforms
   - Linearly interpolates the resulting positions based on `_globeness` value
   - Also interpolates `signedDistanceFromCamera` for correct perspective ratio calculation
   - Uses vertical-perspective's occlusion flag (conservative approach)

2. When not transitioning (`_globeness === 0` or `_globeness === 1`):
   - Falls back to the original behavior using only the current transform
   - No performance impact when not transitioning

## Impact

- **Fixes**: Label and collision box alignment during projection interpolation
- **Performance**: Minimal - only affects transitions, adds one extra projection calculation during interpolation
- **Compatibility**: No breaking changes, only fixes existing broken behavior

## Testing

To test the fix:
1. Build the project: `npm run build-dev`
2. Open the test file: `test-projection-interpolation.html`
3. Zoom between levels 10-12 and observe that labels and collision boxes remain aligned
4. Enable collision box visualization: `map.showCollisionBoxes = true`

## Related Code

The fix ensures CPU-side collision detection (`CollisionIndex.projectAndGetPerspectiveRatio`) receives interpolated positions that match what the GPU renders, preventing the visual misalignment.

This is similar to how `getPitchedTextCorrection()` already interpolates between the two projections:

```typescript
public getPitchedTextCorrection(textAnchorX: number, textAnchorY: number, tileID: UnwrappedTileID): number {
    const mercatorCorrection = this._mercatorTransform.getPitchedTextCorrection(textAnchorX, textAnchorY, tileID);
    const verticalCorrection = this._verticalPerspectiveTransform.getPitchedTextCorrection(textAnchorX, textAnchorY, tileID);
    return lerp(mercatorCorrection, verticalCorrection, this._globeness);
}
```
