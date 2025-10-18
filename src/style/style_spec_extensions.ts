import {latest as styleSpec} from '@maplibre/maplibre-gl-style-spec';

const layoutSymbol = styleSpec['layout_symbol'] as Record<string, any>;
const clones: Array<[string, string]> = [
    ['text-field', 'text-field2'],
    ['text-anchor', 'text-field2-anchor'],
    ['text-offset', 'text-field2-offset'],
    ['text-radial-offset', 'text-field2-radial-offset']
];

if (layoutSymbol) {
    for (const [source, target] of clones) {
        if (!layoutSymbol[target] && layoutSymbol[source]) {
            layoutSymbol[target] = {
                ...layoutSymbol[source],
                name: target
            };
        }
    }
}
