import {Color} from '@maplibre/maplibre-gl-style-spec';
import {namedColors} from '@maplibre/maplibre-gl-style-spec/src/expression/types/parse_css_color';

// Special markers for inline color hex values.
export const RGB_MARKER: string = String.fromCodePoint(0xE100); // indicates following text contains an #rrggbb color
export const RGBA_MARKER: string = String.fromCodePoint(0xE101); // indicates following text contains an #rrggbbaa color

const parseHexCache: Map<string, Color> = new Map();

// Fast ASCII lookup array for hex character decoding.
const HEX_VALUES = new Int8Array(123); // 'z' is 122
HEX_VALUES.fill(-1);
for (let i = 0; i < 10; i++) HEX_VALUES[48 + i] = i;       // '0'-'9'
for (let i = 0; i < 6; i++) {
    HEX_VALUES[65 + i] = 10 + i;  // 'A'-'F'
    HEX_VALUES[97 + i] = 10 + i;  // 'a'-'f'
}

export function parseHexColor(hex: string): Color | undefined {
    if (!hex || hex.charCodeAt(0) !== 35) return undefined; // '#' is 35
    const cached = parseHexCache.get(hex);
    if (cached) return cached;

    const len = hex.length;
    if (len !== 7 && len !== 9) return undefined;

    const r1 = HEX_VALUES[hex.charCodeAt(1)] ?? -1;
    const r2 = HEX_VALUES[hex.charCodeAt(2)] ?? -1;
    const g1 = HEX_VALUES[hex.charCodeAt(3)] ?? -1;
    const g2 = HEX_VALUES[hex.charCodeAt(4)] ?? -1;
    const b1 = HEX_VALUES[hex.charCodeAt(5)] ?? -1;
    const b2 = HEX_VALUES[hex.charCodeAt(6)] ?? -1;

    if (r1 === -1 || r2 === -1 || g1 === -1 || g2 === -1 || b1 === -1 || b2 === -1) {
        return undefined;
    }

    const r = (r1 << 4) | r2;
    const g = (g1 << 4) | g2;
    const b = (b1 << 4) | b2;

    let color: Color;
    if (len === 7) {
        color = new Color(r / 255, g / 255, b / 255, 1);
    } else {
        const a1 = HEX_VALUES[hex.charCodeAt(7)] ?? -1;
        const a2 = HEX_VALUES[hex.charCodeAt(8)] ?? -1;
        if (a1 === -1 || a2 === -1) return undefined;
        const a = ((a1 << 4) | a2) / 255;
        color = new Color(r / 255, g / 255, b / 255, a);
    }

    // Simple unbounded cache
    parseHexCache.set(hex, color);
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

export const defaultSplitChars: Map<string, Color> = generateSplitChars(namedColors);

// Cache compiled regexes per splitChars map
const markerRegexCache: WeakMap<Map<string, Color>, RegExp> = new WeakMap();

function getMarkerRegexFor(splitChars: Map<string, Color>): RegExp {
    let cached = markerRegexCache.get(splitChars);
    if (cached) return cached;

    const RGB = RGB_MARKER;
    const RGBA = RGBA_MARKER;
    const namedKeys = Array.from(splitChars.keys()).map((c) => escapeRegExp(c)).join('');

    const parts: string[] = [];
    if (namedKeys.length) {
        parts.push(`[${namedKeys}]`);
    }
    parts.push(`${escapeRegExp(RGB)}#[0-9a-fA-F]{6}`);
    parts.push(`${escapeRegExp(RGBA)}#[0-9a-fA-F]{8}`);

    cached = new RegExp(parts.join('|'), 'g');
    markerRegexCache.set(splitChars, cached);
    return cached;
}

// Metadata cache for O(1) character checking inside text
interface MapMetadata {
    min: number;
    max: number;
    charCodes: Set<number>;
}
const metadataCache = new WeakMap<Map<string, Color>, MapMetadata>();

function getMetadataFor(splitChars: Map<string, Color>): MapMetadata {
    let meta = metadataCache.get(splitChars);
    if (!meta) {
        let min = Infinity;
        let max = -Infinity;
        const charCodes = new Set<number>();
        for (const key of splitChars.keys()) {
            const code = key.charCodeAt(0);
            if (code < min) min = code;
            if (code > max) max = code;
            charCodes.add(code);
        }
        meta = {min, max, charCodes};
        metadataCache.set(splitChars, meta);
    }
    return meta;
}

function hasNamedMarker(text: string, splitChars: Map<string, Color>): boolean {
    const meta = getMetadataFor(splitChars);
    const len = text.length;
    for (let i = 0; i < len; i++) {
        const code = text.charCodeAt(i);
        if (code >= meta.min && code <= meta.max && meta.charCodes.has(code)) {
            return true;
        }
    }
    return false;
}

// Apply color-splitting to a Formatted-like object.
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

        // Quick check: if there are no markers, keep original section
        if (sectionText.indexOf(RGB) === -1 && sectionText.indexOf(RGBA) === -1 && !hasNamedMarker(sectionText, splitChars)) {
            updatedSections.push(originalSection);
            continue;
        }

        let lastIndex = 0;
        let currentColor: Color | undefined = originalSection.textColor;
        let match: RegExpExecArray | null;

        markerRegex.lastIndex = 0;
        while ((match = markerRegex.exec(sectionText)) !== null) {
            const matchIndex = match.index;
            const matchStr = match[0];

            // push preceding text (may be empty)
            if (lastIndex < matchIndex) {
                updatedSections.push({
                    ...originalSection,
                    text: sectionText.substring(lastIndex, matchIndex),
                    textColor: currentColor
                });
            }

            if (matchStr.length === 1) {
                // include the marker char at the end of the previous substring (mimic prior behavior)
                updatedSections.push({
                    ...originalSection,
                    text: matchStr,
                    textColor: currentColor
                });
                currentColor = splitChars.get(matchStr);
            } else {
                // It's either an RGB or RGBA marker string (e.g., '\uE100#rrggbb')
                const hex = matchStr.slice(1); // remove marker char
                const parsed = parseHexColor(hex);
                if (parsed) currentColor = parsed;
            }
            lastIndex = markerRegex.lastIndex;
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
