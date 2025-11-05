import {Color} from '@maplibre/maplibre-gl-style-spec';
import {namedColors} from '@maplibre/maplibre-gl-style-spec/src/expression/types/parse_css_color';

// Special markers for inline color hex values.
export const RGB_MARKER = String.fromCodePoint(0xE100); // indicates following text contains an #rrggbb color
export const RGBA_MARKER = String.fromCodePoint(0xE101); // indicates following text contains an #rrggbbaa color

const parseHexCache: Map<string, Color> = new Map();

export function parseHexColor(hex: string): Color | undefined {
    if (!hex || hex[0] !== '#') return undefined;
    const cached = parseHexCache.get(hex);
    if (cached) return cached;
    const clean = hex.slice(1);
    let color: Color | undefined;
    if (clean.length === 6) {
        const r = parseInt(clean.slice(0, 2), 16);
        const g = parseInt(clean.slice(2, 4), 16);
        const b = parseInt(clean.slice(4, 6), 16);
        if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return undefined;
        color = new Color(r / 255, g / 255, b / 255, 1);
    } else if (clean.length === 8) {
        const r = parseInt(clean.slice(0, 2), 16);
        const g = parseInt(clean.slice(2, 4), 16);
        const b = parseInt(clean.slice(4, 6), 16);
        const a = parseInt(clean.slice(6, 8), 16) / 255;
        if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) return undefined;
        color = new Color(r / 255, g / 255, b / 255, a);
    }
    if (color) {
        // simple unbounded cache — keys are short and repeated values are expected
        parseHexCache.set(hex, color);
    }
    return color;
}

export function generateSplitChars(namedColors: Record<string, [number, number, number]>): Map<string, Color> {
    const splitChars = new Map<string, Color>();
    let charCode = 0xE001; // Start of the Unicode Private Use Area

    for (const colorName in namedColors) {
        const rgb = namedColors[colorName];
        const color = new Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1);
        splitChars.set(String.fromCodePoint(charCode), color);
        charCode++;
    }

    return splitChars;
}

// Cache a default splitChars created from the spec's named colors so callers
// don't need to recreate it repeatedly. This is cheap to create but called
// frequently from populate; caching avoids repeated Map allocations and work.
export const defaultSplitChars: Map<string, Color> = generateSplitChars(namedColors);

// Cache compiled regexes per splitChars map to avoid rebuilding the RegExp on each call.
// WeakMap is used so the cache doesn't prevent garbage collection of splitChars Maps.
const markerRegexCache: WeakMap<Map<string, Color>, RegExp> = new WeakMap();

function getMarkerRegexFor(splitChars: Map<string, Color>): RegExp {
    let cached = markerRegexCache.get(splitChars);
    if (cached) return cached;

    const RGB = RGB_MARKER;
    const RGBA = RGBA_MARKER;
    const namedKeys = Array.from(splitChars.keys()).map((c) => escapeRegExp(c)).join('');
    const namedClass = namedKeys.length ? `[${namedKeys}]` : '(?:)';
    cached = new RegExp(`(${namedClass})|(${escapeRegExp(RGB)}#[0-9a-fA-F]{6})|(${escapeRegExp(RGBA)}#[0-9a-fA-F]{8})`, 'g');
    markerRegexCache.set(splitChars, cached);
    return cached;
}

// Apply color-splitting to a Formatted-like object.
// The function is intentionally permissive about the input shape — it only
// expects an object with a `sections` array where each section has `text` and optionally `textColor`.
export function applyColorSplit(formattedText: any, splitChars: Map<string, Color>): any {
    if (!formattedText) return formattedText;

    const markerRegex = getMarkerRegexFor(splitChars);
    const RGB = RGB_MARKER;
    const RGBA = RGBA_MARKER;

    const updatedSections: any[] = [];

    for (const originalSection of formattedText.sections) {
        const sectionText: string = originalSection.text || '';
        if (!sectionText) {
            updatedSections.push(originalSection);
            continue;
        }

        let lastIndex = 0;
        let currentColor: Color | undefined = originalSection.textColor;

        // Quick check: if there are no markers, keep original section
        if (!containsColorMarker(sectionText, splitChars)) {
            updatedSections.push(originalSection);
            continue;
        }

        let match: RegExpExecArray | null;
        markerRegex.lastIndex = 0;
        while ((match = markerRegex.exec(sectionText)) !== null) {
            const matchIndex = match.index;

            // push preceding text (may be empty)
            if (lastIndex < matchIndex) {
                updatedSections.push({
                    ...originalSection,
                    text: sectionText.substring(lastIndex, matchIndex),
                    textColor: currentColor
                });
            }

            const named = match[1];
            const rgbMatch = match[2];
            const rgbaMatch = match[3];

            if (named) {
                // include the marker char at the end of the previous substring (mimic prior behavior)
                updatedSections.push({
                    ...originalSection,
                    text: named,
                    textColor: currentColor
                });
                currentColor = splitChars.get(named) as Color;
                lastIndex = markerRegex.lastIndex;
                continue;
            }

            if (rgbMatch) {
                // rgbMatch is like '\uE100#rrggbb'
                const hex = rgbMatch.slice(1); // remove marker char
                const parsed = parseHexColor(hex);
                if (parsed) currentColor = parsed;
                lastIndex = markerRegex.lastIndex;
                continue;
            }

            if (rgbaMatch) {
                const hex = rgbaMatch.slice(1);
                const parsed = parseHexColor(hex);
                if (parsed) currentColor = parsed;
                lastIndex = markerRegex.lastIndex;
                continue;
            }
        }

        if (lastIndex < sectionText.length) {
            updatedSections.push({
                ...originalSection,
                text: sectionText.substring(lastIndex),
                textColor: currentColor
            });
        }
    }

    formattedText.sections = updatedSections;
    return formattedText;
}

function escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasNamedMarker(text: string, splitChars: Map<string, Color>) {
    for (const k of splitChars.keys()) {
        if (text.indexOf(k) !== -1) return true;
    }
    return false;
}

export function containsColorMarker(text: string, splitChars: Map<string, Color> = defaultSplitChars): boolean {
    if (!text) return false;
    if (text.indexOf(RGB_MARKER) !== -1 || text.indexOf(RGBA_MARKER) !== -1) {
        return true;
    }
    return hasNamedMarker(text, splitChars);
}
