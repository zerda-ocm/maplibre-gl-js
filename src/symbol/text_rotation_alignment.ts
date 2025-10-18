export const enum TextRotationAlignmentOverrideValue {
    Inherit = 0,
    Map = 1,
    Viewport = 2,
    ViewportGlyph = 3
}

export type TextRotationAlignmentString = 'map' | 'viewport' | 'viewport-glyph' | 'auto';

const allowedRotationAlignments: ReadonlySet<string> = new Set(['map', 'viewport', 'viewport-glyph', 'auto']);

export function isValidTextRotationAlignment(value: unknown): value is TextRotationAlignmentString {
    return typeof value === 'string' && allowedRotationAlignments.has(value);
}

export function encodeTextRotationAlignment(value: unknown): TextRotationAlignmentOverrideValue {
    if (!isValidTextRotationAlignment(value) || value === 'auto') {
        return TextRotationAlignmentOverrideValue.Inherit;
    }

    switch (value) {
        case 'map':
            return TextRotationAlignmentOverrideValue.Map;
        case 'viewport':
            return TextRotationAlignmentOverrideValue.Viewport;
        case 'viewport-glyph':
            return TextRotationAlignmentOverrideValue.ViewportGlyph;
        default:
            return TextRotationAlignmentOverrideValue.Inherit;
    }
}

export function shouldRotateGlyphToLine(override: TextRotationAlignmentOverrideValue, fallback: boolean): boolean {
    switch (override) {
        case TextRotationAlignmentOverrideValue.Map:
            return true;
        case TextRotationAlignmentOverrideValue.Viewport:
        case TextRotationAlignmentOverrideValue.ViewportGlyph:
            return false;
        default:
            return fallback;
    }
}
