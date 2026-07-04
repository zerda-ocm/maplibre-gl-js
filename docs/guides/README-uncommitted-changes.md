# Symbol hitboxes for special glyphs

## Summary

This change improves symbol interactivity by giving special glyphs their own collision/query hit area. In practice, this means labels that use special characters such as hiking-sign symbols can now be hovered or queried more reliably, allowing the underlying feature to be identified and shown in a popup or tooltip.

## What changed

- Added support for special glyphs to participate in collision-circle generation.
- Encoded wider hitbox behavior for certain glyphs so they behave like a larger interactive area than a normal character.
- Propagated glyph hit metadata through symbol query results so hover-based feature lookup can resolve the correct symbol feature.
- Exposed the extra metadata in feature conversion and query handling for downstream consumers.
- Updated the debug collision rendering path so these hit areas can be inspected visually.

## Why this matters

Some map labels use custom or special characters that should be interactive even when the visible text is narrow. By treating these glyphs as a hitbox, the map can better support hover interactions for signs, markers, and other symbol-based information.

## Key areas

- Collision placement and symbol hit detection
- Rendered symbol querying and feature lookup
- Debug visualization of collision circles
- Unit coverage for glyph hit metadata

## Example

A hiking sign label that uses a special glyph can now expose a larger interactive area on hover, making it easier to surface additional information about the feature.

## How to add more special characters

To support additional special characters with custom hitbox widths, update the special-glyph configuration in the collision logic:

1. Open [src/symbol/collision_index.ts](src/symbol/collision_index.ts).
2. Add the new character code to the SPECIAL_GLYPH_CODES set if it should be treated as a special glyph.
3. Add its width multiplier to the SPECIAL_GLYPH_WIDTHS map. The value is a multiplier relative to a square.
   - Example: a value of 2 makes the hitbox twice as wide.
