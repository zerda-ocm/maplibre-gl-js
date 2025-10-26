const {performance} = require('perf_hooks');

// Small synthetic namedColors map for the benchmark (we don't need the full spec)
const namedColors = {
    aliceblue: [240, 248, 255],
    antiquewhite: [250, 235, 215],
    aqua: [0, 255, 255],
    aquamarine: [127, 255, 212],
    azure: [240, 255, 255],
    beige: [245, 245, 220],
    bisque: [255, 228, 196],
    black: [0, 0, 0],
    blanchedalmond: [255, 235, 205],
    blue: [0, 0, 255]
};

const RGB_MARKER = String.fromCodePoint(0xE100);
const RGBA_MARKER = String.fromCodePoint(0xE101);

function generateSplitChars(namedColors) {
    const splitChars = new Map();
    let charCode = 0xE001;
    for (const k in namedColors) {
        const rgb = namedColors[k];
        splitChars.set(String.fromCodePoint(charCode), {r: rgb[0]/255, g: rgb[1]/255, b: rgb[2]/255, a: 1});
        charCode++;
    }
    return splitChars;
}

function parseHexColor(hex) {
    if (!hex || hex[0] !== '#') return undefined;
    const clean = hex.slice(1);
    if (clean.length === 6) {
        const r = parseInt(clean.slice(0,2), 16);
        const g = parseInt(clean.slice(2,4), 16);
        const b = parseInt(clean.slice(4,6), 16);
        if (Number.isNaN(r)||Number.isNaN(g)||Number.isNaN(b)) return undefined;
        return {r: r/255, g: g/255, b: b/255, a:1};
    } else if (clean.length === 8) {
        const r = parseInt(clean.slice(0,2), 16);
        const g = parseInt(clean.slice(2,4), 16);
        const b = parseInt(clean.slice(4,6), 16);
        const a = parseInt(clean.slice(6,8), 16) / 255;
        if (Number.isNaN(r)||Number.isNaN(g)||Number.isNaN(b)||Number.isNaN(a)) return undefined;
        return {r: r/255, g: g/255, b: b/255, a};
    }
    return undefined;
}

// New implementation (regex + parse cache) — adapted from color_split.ts
function newApplyColorSplit(formattedText, splitChars) {
    if (!formattedText) return formattedText;

    const RGB = RGB_MARKER;
    const RGBA = RGBA_MARKER;

    const namedKeys = Array.from(splitChars.keys()).map(c => escapeRegExp(c)).join('');
    const namedClass = namedKeys.length ? `[${namedKeys}]` : '(?:)';
    const markerRegex = new RegExp(`(${namedClass})|(${escapeRegExp(RGB)}#[0-9a-fA-F]{6})|(${escapeRegExp(RGBA)}#[0-9a-fA-F]{8})`, 'g');

    const updatedSections = [];

    for (const originalSection of formattedText.sections) {
        const sectionText = originalSection.text || '';
        if (!sectionText) { updatedSections.push(originalSection); continue; }

        let lastIndex = 0;
        let currentColor = originalSection.textColor;

        if (sectionText.indexOf(RGB) === -1 && sectionText.indexOf(RGBA) === -1 && !hasNamedMarker(sectionText, splitChars)) {
            updatedSections.push(originalSection);
            continue;
        }

        let match;
        markerRegex.lastIndex = 0;
        while ((match = markerRegex.exec(sectionText)) !== null) {
            const matchIndex = match.index;
            if (lastIndex < matchIndex) {
                updatedSections.push(Object.assign({}, originalSection, { text: sectionText.substring(lastIndex, matchIndex), textColor: currentColor }));
            }
            const named = match[1];
            const rgbMatch = match[2];
            const rgbaMatch = match[3];

            if (named) {
                updatedSections.push(Object.assign({}, originalSection, { text: named, textColor: currentColor }));
                currentColor = splitChars.get(named);
                lastIndex = markerRegex.lastIndex;
                continue;
            }
            if (rgbMatch) {
                const hex = rgbMatch.slice(1);
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
            updatedSections.push(Object.assign({}, originalSection, { text: sectionText.substring(lastIndex), textColor: currentColor }));
        }
    }

    formattedText.sections = updatedSections;
    return formattedText;
}

// Old implementation (character-by-character loop) — reconstructed
function oldApplyColorSplit(formattedText, splitChars) {
    if (!formattedText) return formattedText;
    const RGB = RGB_MARKER;
    const RGBA = RGBA_MARKER;

    const updatedSections = [];

    for (const originalSection of formattedText.sections) {
        const sectionText = originalSection.text || '';
        if (!sectionText) { updatedSections.push(originalSection); continue; }

        let lastIndex = 0;
        let currentColor = originalSection.textColor;

        let i = 0;
        while (i < sectionText.length) {
            const ch = sectionText[i];

            if (splitChars.has(ch)) {
                const end = i + 1;
                if (lastIndex < end) {
                    updatedSections.push(Object.assign({}, originalSection, { text: sectionText.substring(lastIndex, end), textColor: currentColor }));
                }
                currentColor = splitChars.get(ch);
                lastIndex = end;
                i = lastIndex;
                continue;
            }

            if (ch === RGB || ch === RGBA) {
                const remaining = sectionText.slice(i + 1);
                let match = null;
                if (ch === RGBA) {
                    match = remaining.match(/^#([0-9a-fA-F]{8})/);
                } else {
                    match = remaining.match(/^#([0-9a-fA-F]{6})/);
                }
                if (match) {
                    if (lastIndex < i) {
                        updatedSections.push(Object.assign({}, originalSection, { text: sectionText.substring(lastIndex, i), textColor: currentColor }));
                    }
                    const hex = match[0];
                    const parsed = parseHexColor(hex);
                    if (parsed) currentColor = parsed;
                    const advance = 1 + hex.length; // marker + hex
                    i = i + advance;
                    lastIndex = i;
                    continue;
                }
                // fallthrough — treat marker as normal char
            }

            i++;
        }

        if (lastIndex < sectionText.length) {
            updatedSections.push(Object.assign({}, originalSection, { text: sectionText.substring(lastIndex), textColor: currentColor }));
        }
    }

    formattedText.sections = updatedSections;
    return formattedText;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'); }
function hasNamedMarker(text, splitChars) { for (const k of splitChars.keys()) if (text.indexOf(k)!==-1) return true; return false; }

// Compose a test string containing named markers and hex markers, repeated
const splitChars = generateSplitChars(namedColors);
const firstNamed = Array.from(splitChars.keys())[0];
const secondNamed = Array.from(splitChars.keys())[2];

const testChunk = [];
// include some normal text
testChunk.push('Hello world ');
// include named marker
testChunk.push(firstNamed + 'named ');
// include RGB marker
testChunk.push(RGB_MARKER + '#ff0000' + ' red ');
// include RGBA marker
testChunk.push(RGBA_MARKER + '#00ff00aa' + ' translucent ');
// include mixed content
testChunk.push(secondNamed + 'mixed ' + RGB_MARKER + '#0000ffblue ');

const baseString = testChunk.join('');
// make a long string to increase workload
let longString = '';
for (let i=0;i<50;i++) longString += baseString;

const formatted = { sections: [ { text: longString, textColor: undefined } ] };

function runBench(fn, name, iterations) {
    // Warmup
    for (let i=0;i<100;i++) fn({ sections: [ { text: longString, textColor: undefined } ] }, splitChars);

    const start = performance.now();
    for (let i=0;i<iterations;i++) {
        // clone minimal formatted to avoid mutation carry-over
        fn({ sections: [ { text: longString, textColor: undefined } ] }, splitChars);
    }
    const end = performance.now();
    console.log(`${name}: ${(end-start).toFixed(2)} ms for ${iterations} iterations`);
}

const ITERS = 2000;
console.log('Benchmarking with string length', longString.length);
runBench(oldApplyColorSplit, 'oldApplyColorSplit (char-loop)', ITERS);
runBench(newApplyColorSplit, 'newApplyColorSplit (regex+cache)', ITERS);

// Run each a few times to get stable results
runBench(oldApplyColorSplit, 'oldApplyColorSplit (char-loop) 2nd', ITERS);
runBench(newApplyColorSplit, 'newApplyColorSplit (regex+cache) 2nd', ITERS);

console.log('Done.');
