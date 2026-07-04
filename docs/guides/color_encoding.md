Color encoding in strings (README)

Overview
--------
This project supports embedding inline color switches inside text using Unicode private-use characters as markers. Those markers let the text layout/shaping pipeline split and recolor subsequent text sections without changing the style layer paint values.

Markers and rules
-----------------
- Named-color markers
  - The code generates a mapping from named CSS colors (from the style-spec) to private-use characters starting at U+E001.
  - The mapping follows the standard HTML/CSS named colors (the same list used by the style-spec). Specifically, U+E001 maps to "aliceblue" (the first named color) and the named-color sequence continues through U+E094 which maps to "yellowgreen". Do not add additional markers inside this range.
  - Each named color maps to a single private-use character. For example:
    - U+E079 -> `red` (Color created from namedColors['red'])
    - U+E039 -> `green`
    - etc.
  - These markers are treated as "split points": the marker itself is included at the end of the previous substring, and the color mapped from that marker is applied to the following substring.

- Hex color markers (added behavior)
  - Two explicit private-use markers are used for inline hex colors:
    - U+E100 (RGB_MARKER): must be followed by a 6-digit hex color: `#RRGGBB`.
    - U+E101 (RGBA_MARKER): must be followed by an 8-digit hex color: `#RRGGBBAA` (alpha included).
  - Behavior:
    - U+E100#rrggbb will parse the six hex digits and set the following text color to the opaque RGB color; any characters after those six hex digits remain visible text.
    - U+E101#rrggbbaa will parse the eight hex digits and set the following text color to the RGBA color (alpha normalized to 0..1). The 8-digit form is required for the RGBA marker.

Examples
--------
- Named color markers (conceptual):
  - "Hello\uE001World" — the marker U+E001 switches the color for "World" to the color mapped to the first named color (U+E001).

- Hex marker examples:
  - "\uE100#ff0000test" -> The RGB marker consumes `#ff0000`, the following visible text is `test` colored opaque red. (If you inserted `\uE100#ff000055test`, `55` would be visible text because RGB marker only accepts 6 hex digits.)
  - "\uE101#ff000055test" -> The RGBA marker consumes the 8-digit color `#ff000055` and applies semi-transparent red (alpha 0x55≈0.333) to `test`.

Relevant code locations
-----------------------
- Main parsing and split logic:
  - `src/data/bucket/symbol_bucket.ts`
    - generateSplitChars(namedColors) — builds the `Map<string, Color>` mapping from private-use characters (starting at U+E001) to Color objects based on the style-spec `namedColors` table.
    - applyColorSplit(formattedText) — parses formatted text sections, finds named-color markers and the hex markers (U+E100 and U+E101), splits sections accordingly, and assigns `textColor` to each resulting section.
    - parseHexColor(hex) — utility that parses `#RRGGBB` and `#RRGGBBAA` into a Color instance (alpha normalized to 0..1 for 8-digit hex).
