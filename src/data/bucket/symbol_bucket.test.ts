import {describe, test, expect, vi, beforeAll} from 'vitest';
import {SymbolBucket} from './symbol_bucket';
import {RGB_MARKER, RGBA_MARKER, defaultSplitChars, parseHexColor} from './color_split';
import {CollisionBoxArray} from '../../data/array_types.g';
import {performSymbolLayout} from '../../symbol/symbol_layout';
import {Placement} from '../../symbol/placement';
import {type CanonicalTileID, OverscaledTileID} from '../../tile/tile_id';
import {Tile} from '../../tile/tile';
import {CrossTileSymbolIndex} from '../../symbol/cross_tile_symbol_index';
import {FeatureIndex} from '../../data/feature_index';
import {createSymbolBucket, createSymbolIconBucket} from '../../../test/unit/lib/create_symbol_layer';
import {RGBAImage} from '../../util/image';
import {ImagePosition} from '../../render/image_atlas';
import {type IndexedFeature, type PopulateParameters} from '../bucket';
import {type StyleImage} from '../../style/style_image';
import {SIZE_PACK_FACTOR} from '../../symbol/symbol_size';
import glyphs from '../../../test/unit/assets/fontstack-glyphs.json' with {type: 'json'};
import {type StyleGlyph} from '../../style/style_glyph';
import {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings';
import {MercatorTransform} from '../../geo/projection/mercator_transform';
import {createPopulateOptions, loadVectorTile} from '../../../test/unit/lib/tile';
import {Color} from '@maplibre/maplibre-gl-style-spec';

const collisionBoxArray = new CollisionBoxArray();
const transform = new MercatorTransform();
transform.resize(100, 100);

const stacks = {'Test': glyphs} as any as {
    [_: string]: {
        [x: number]: StyleGlyph;
    };
};

function bucketSetup(text = 'abcde') {
    return createSymbolBucket('test', 'Test', text, collisionBoxArray);
}

function createIndexedFeature(id: number, index: number, iconId: string): IndexedFeature {
    return {
        feature: {
            extent: 8192,
            type: 1,
            id,
            properties: {
                icon: iconId
            },
            loadGeometry() {
                return [[{x: 0, y: 0}]];
            }
        },
        id,
        index,
        sourceLayerIndex: 0
    } as any as IndexedFeature;
}

function createPointIndexedFeature(properties: Record<string, any>, id = 0, index = 0): IndexedFeature {
    return {
        feature: {
            extent: 8192,
            type: 1,
            id,
            properties,
            loadGeometry() {
                return [[{x: 0, y: 0}]];
            }
        } as any,
        id,
        index,
        sourceLayerIndex: 0
    } as IndexedFeature;
}

function expectColorEquals(actual: Color | null | undefined, expected: Color) {
    expect(actual).toBeDefined();
    const actualRgb = actual!.rgb;
    const expectedRgb = expected.rgb;
    for (let i = 0; i < expectedRgb.length; i++) {
        expect(actualRgb[i]).toBeCloseTo(expectedRgb[i], 6);
    }
}

describe('SymbolBucket', () => {
    let features: IndexedFeature[];
    beforeAll(() => {
        // Load point features from fixture tile.
        const sourceLayer = loadVectorTile().layers.place_label;
        features = [{feature: sourceLayer.feature(10)} as IndexedFeature];
    });

    test('applies color splitting to plain string text-field values', () => {
        const stringCollisionArray = new CollisionBoxArray();
        const [namedMarker, namedColor] = defaultSplitChars.entries().next().value as [string, Color];
        const textValue = `Hello${namedMarker}World${RGB_MARKER}#112233RGB${RGBA_MARKER}#aabbccddRGBA`;

        const bucket = createSymbolBucket('color-string', 'Test', '', stringCollisionArray, {
            'text-field': ['get', 'name']
        });

        const options = createPopulateOptions([]);
        const feature = createPointIndexedFeature({name: textValue});

        bucket.populate([feature], options, undefined as unknown as CanonicalTileID);

        expect(bucket.features).toHaveLength(1);
        const formatted = bucket.features[0].text;
        expect(formatted).toBeDefined();
        if (!formatted) {
            throw new Error('Expected formatted text when testing color splitting for string values.');
        }

        const sections = formatted.sections;
        const sectionByText = (text: string) => sections.find(section => section.text === text);

        expect(sectionByText('Hello')?.textColor).toBeNull();
        const worldSection = sectionByText('World');
        expect(worldSection).toBeDefined();
        expect(worldSection!.textColor).toBe(namedColor);

        const rgbSection = sectionByText('RGB');
        expect(rgbSection).toBeDefined();
        const rgbColor = parseHexColor('#112233');
        expect(rgbColor).toBeDefined();
        expectColorEquals(rgbSection!.textColor, rgbColor!);

        const rgbaSection = sectionByText('RGBA');
        expect(rgbaSection).toBeDefined();
        const rgbaColor = parseHexColor('#aabbccdd');
        expect(rgbaColor).toBeDefined();
        expectColorEquals(rgbaSection!.textColor, rgbaColor!);
    });

    test('applies color splitting to formatted text-field values', () => {
        const formattedCollisionArray = new CollisionBoxArray();
        const [namedMarker, namedColor] = defaultSplitChars.entries().next().value as [string, Color];
        const textValue = `Hello${namedMarker}World${RGB_MARKER}#112233RGB${RGBA_MARKER}#aabbccddRGBA`;

        const bucket = createSymbolBucket('color-formatted', 'Test', '', formattedCollisionArray, {
            'text-field': ['format', textValue, {}]
        });

        const options = createPopulateOptions([]);
        const feature = createPointIndexedFeature({});

        bucket.populate([feature], options, undefined as unknown as CanonicalTileID);

        expect(bucket.features).toHaveLength(1);
        const formatted = bucket.features[0].text;
        expect(formatted).toBeDefined();
        if (!formatted) {
            throw new Error('Expected formatted text when testing color splitting for formatted values.');
        }

        const sections = formatted.sections;
        const sectionByText = (text: string) => sections.find(section => section.text === text);

        expect(sectionByText('Hello')?.textColor).toBeNull();
        const worldSection = sectionByText('World');
        expect(worldSection).toBeDefined();
        expect(worldSection!.textColor).toBe(namedColor);

        const rgbSection = sectionByText('RGB');
        expect(rgbSection).toBeDefined();
        const rgbColor = parseHexColor('#112233');
        expect(rgbColor).toBeDefined();
        expectColorEquals(rgbSection!.textColor, rgbColor!);

        const rgbaSection = sectionByText('RGBA');
        expect(rgbaSection).toBeDefined();
        const rgbaColor = parseHexColor('#aabbccdd');
        expect(rgbaColor).toBeDefined();
        expectColorEquals(rgbaSection!.textColor, rgbaColor!);
    });

    test('SymbolBucket', () => {
        const bucketA = bucketSetup();
        const bucketB = bucketSetup();
        const options = createPopulateOptions([]);
        const placement = new Placement(transform, undefined as any, 0, true);
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const crossTileSymbolIndex = new CrossTileSymbolIndex();

        // add feature from bucket A
        bucketA.populate(features, options, undefined as any);
        performSymbolLayout(
            {
                bucket: bucketA,
                glyphMap: stacks,
                glyphPositions: {},
                subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
            } as any);
        const tileA = new Tile(tileID, 512);
        tileA.latestFeatureIndex = new FeatureIndex(tileID);
        tileA.buckets = {test: bucketA};
        tileA.collisionBoxArray = collisionBoxArray;

        // add same feature from bucket B
        bucketB.populate(features, options, undefined as any);
        performSymbolLayout({
            bucket: bucketB, glyphMap: stacks, glyphPositions: {}, subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);
        const tileB = new Tile(tileID, 512);
        tileB.buckets = {test: bucketB};
        tileB.collisionBoxArray = collisionBoxArray;

        crossTileSymbolIndex.addLayer(bucketA.layers[0], [tileA, tileB], undefined as any);

        const place = (layer, tile) => {
            const parts = [];
            placement.getBucketParts(parts, layer, tile, false);
            for (const part of parts) {
                placement.placeLayerBucketPart(part, {}, false);
            }
        };
        const a = placement.collisionIndex.grid.keysLength();
        place(bucketA.layers[0], tileA);
        const b = placement.collisionIndex.grid.keysLength();
        expect(a).not.toBe(b);

        const a2 = placement.collisionIndex.grid.keysLength();
        place(bucketB.layers[0], tileB);
        const b2 = placement.collisionIndex.grid.keysLength();
        expect(b2).toBe(a2);
    });

    test('SymbolBucket integer overflow', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        SymbolBucket.MAX_GLYPHS = 5;

        const bucket = bucketSetup();
        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;

        bucket.populate(features, options, undefined as any);
        const fakeGlyph = {rect: {w: 10, h: 10}, metrics: {left: 10, top: 10, advance: 10}};
        performSymbolLayout({
            bucket,
            glyphMap: stacks,
            glyphPositions: {'Test': {97: fakeGlyph, 98: fakeGlyph, 99: fakeGlyph, 100: fakeGlyph, 101: fakeGlyph, 102: fakeGlyph} as any},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].includes('Too many glyphs being rendered in a tile.')).toBeTruthy();
    });

    test('SymbolBucket image undefined sdf', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        spy.mockReset();

        const imageMap = {
            a: {
                data: new RGBAImage({width: 0, height: 0})
            },
            b: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: false
            }
        } as any as { [_: string]: StyleImage };
        const imagePos = {
            a: new ImagePosition({x: 0, y: 0, w: 10, h: 10}, 1 as any as StyleImage),
            b: new ImagePosition({x: 10, y: 0, w: 10, h: 10}, 1 as any as StyleImage)
        };
        const bucket = createSymbolIconBucket('test', 'icon', collisionBoxArray);
        const options = createPopulateOptions([]);

        bucket.populate(
            [
                createIndexedFeature(0, 0, 'a'),
                createIndexedFeature(1, 1, 'b'),
                createIndexedFeature(2, 2, 'a')
            ] as any as IndexedFeature[],
            options, undefined as any
        );

        const icons = options.iconDependencies as any;
        expect(icons.a).toBe(true);
        expect(icons.b).toBe(true);

        performSymbolLayout({
            bucket, imageMap, imagePositions: imagePos,
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        // undefined SDF should be treated the same as false SDF - no warning raised
        expect(spy).not.toHaveBeenCalledTimes(1);
    });

    test('SymbolBucket image mismatched sdf', () => {
        const originalWarn = console.warn;
        console.warn = vi.fn();

        const imageMap = {
            a: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: true
            },
            b: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: false
            }
        } as any as { [_: string]: StyleImage };
        const imagePos = {
            a: new ImagePosition({x: 0, y: 0, w: 10, h: 10}, 1 as any as StyleImage),
            b: new ImagePosition({x: 10, y: 0, w: 10, h: 10}, 1 as any as StyleImage)
        };
        const bucket = createSymbolIconBucket('test', 'icon', collisionBoxArray);
        const options = createPopulateOptions([]);

        bucket.populate(
            [
                createIndexedFeature(0, 0, 'a'),
                createIndexedFeature(1, 1, 'b'),
                createIndexedFeature(2, 2, 'a')
            ] as any as IndexedFeature[],
            options, undefined as unknown as CanonicalTileID
        );

        const icons = options.iconDependencies as any;
        expect(icons.a).toBe(true);
        expect(icons.b).toBe(true);

        performSymbolLayout({bucket, imageMap, imagePositions: imagePos, subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision} as any);

        // true SDF and false SDF in same bucket should trigger warning
        expect(console.warn).toHaveBeenCalledTimes(1);
        console.warn = originalWarn;
    });

    test('SymbolBucket creates secondary text instances from text-field2', () => {
        const secondaryCollisionArray = new CollisionBoxArray();
        const bucketWithSecondary = createSymbolBucket('secondary', 'Test', 'hello', secondaryCollisionArray, {'text-field2': 'world'});
        const secondaryOptions = createPopulateOptions([]);
        bucketWithSecondary.populate(features, secondaryOptions, undefined as any);

        expect(bucketWithSecondary.features.some(feature => feature.isTextField2)).toBeTruthy();

        performSymbolLayout({
            bucket: bucketWithSecondary,
            glyphMap: stacks,
            glyphPositions: {},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        const baselineCollisionArray = new CollisionBoxArray();
        const baselineBucket = createSymbolBucket('baseline', 'Test', 'hello', baselineCollisionArray);
        const baselineOptions = createPopulateOptions([]);
        baselineBucket.populate(features, baselineOptions, undefined as any);

        performSymbolLayout({
            bucket: baselineBucket,
            glyphMap: stacks,
            glyphPositions: {},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        expect(bucketWithSecondary.symbolInstances.length).toBeGreaterThan(baselineBucket.symbolInstances.length);
    });

    test('text-field2 offset shifts secondary text collision boxes', () => {
        const collisionArray = new CollisionBoxArray();
        const bucket = createSymbolBucket('offset', 'Test', 'hello', collisionArray, {
            'text-variable-anchor': ['top'],
            'text-field2': 'world',
            'text-field2-offset': [0, 2]
        });
        const options = createPopulateOptions([]);
        bucket.populate(features, options, undefined as any);

        performSymbolLayout({
            bucket,
            glyphMap: stacks,
            glyphPositions: {},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        const firstInstance = bucket.symbolInstances.get(0);
        const secondInstance = bucket.symbolInstances.get(1);

        expect(firstInstance.textAnchorOffsetStartIndex).not.toEqual(65535);
        expect(secondInstance.textAnchorOffsetStartIndex).not.toEqual(65535);

        const firstOffsets = [] as Array<{anchor: number; offset: [number, number]}>;
        for (let i = firstInstance.textAnchorOffsetStartIndex; i < firstInstance.textAnchorOffsetEndIndex; i++) {
            const entry = bucket.textAnchorOffsets.get(i);
            firstOffsets.push({anchor: entry.textAnchor, offset: [entry.textOffset0, entry.textOffset1]});
        }

        const secondOffsets = [] as Array<{anchor: number; offset: [number, number]}>;
        for (let i = secondInstance.textAnchorOffsetStartIndex; i < secondInstance.textAnchorOffsetEndIndex; i++) {
            const entry = bucket.textAnchorOffsets.get(i);
            secondOffsets.push({anchor: entry.textAnchor, offset: [entry.textOffset0, entry.textOffset1]});
        }

        expect(firstOffsets).toHaveLength(1);
        expect(secondOffsets).toHaveLength(1);
        expect(firstOffsets[0].anchor).toEqual(secondOffsets[0].anchor);
        expect(firstOffsets[0].offset[0]).toEqual(secondOffsets[0].offset[0]);
        expect(firstOffsets[0].offset[1]).not.toEqual(secondOffsets[0].offset[1]);
    });

    test('text-field2-size scales secondary text independently', () => {
        const collisionArray = new CollisionBoxArray();
        const primarySize = 10;
        const secondarySize = 30;
        const bucket = createSymbolBucket('size-control', 'Test', 'hello', collisionArray, {
            'text-field2': 'world',
            'text-size': primarySize,
            'text-field2-size': secondarySize
        });
        const options = createPopulateOptions([]);
        bucket.populate(features, options, undefined as any);

        performSymbolLayout({
            bucket,
            glyphMap: stacks,
            glyphPositions: {},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        const primaryIndex = bucket.symbolInstanceIsTextField2.findIndex(flag => !flag);
        const secondaryIndex = bucket.symbolInstanceIsTextField2.findIndex(flag => flag);

        expect(primaryIndex).toBeGreaterThanOrEqual(0);
        expect(secondaryIndex).toBeGreaterThanOrEqual(0);

        const primaryInstance = bucket.symbolInstances.get(primaryIndex);
        const secondaryInstance = bucket.symbolInstances.get(secondaryIndex);

        const expectedPrimaryScale = bucket.tilePixelRatio * (primarySize / 24);
        const expectedSecondaryScale = bucket.tilePixelRatio * (secondarySize / 24);

        expect(primaryInstance.textBoxScale).toBeCloseTo(expectedPrimaryScale, 5);
        expect(secondaryInstance.textBoxScale).toBeCloseTo(expectedSecondaryScale, 5);

        const selectPlacedIndex = (instance: any) => {
            const candidates = [
                instance.centerJustifiedTextSymbolIndex,
                instance.rightJustifiedTextSymbolIndex,
                instance.leftJustifiedTextSymbolIndex,
                instance.verticalPlacedTextSymbolIndex
            ];
            return candidates.find(index => index >= 0) ?? -1;
        };

        const primaryPlacedIndex = selectPlacedIndex(primaryInstance);
        const secondaryPlacedIndex = selectPlacedIndex(secondaryInstance);

        expect(primaryPlacedIndex).toBeGreaterThanOrEqual(0);
        expect(secondaryPlacedIndex).toBeGreaterThanOrEqual(0);

        const primaryPlaced = bucket.text.placedSymbolArray.get(primaryPlacedIndex);
        const secondaryPlaced = bucket.text.placedSymbolArray.get(secondaryPlacedIndex);

        expect(primaryPlaced.lowerSize).toBe(Math.round(primarySize * SIZE_PACK_FACTOR));
        expect(secondaryPlaced.lowerSize).toBe(Math.round(secondarySize * SIZE_PACK_FACTOR));
    });

    test('text-field2 does not render without primary text', () => {
        const collisionArray = new CollisionBoxArray();
        const bucket = createSymbolBucket('secondary-only', 'Test', '', collisionArray, {
            'text-field2': 'secondary'
        });
        const options = createPopulateOptions([]);
        bucket.populate(features, options, undefined as any);

        performSymbolLayout({
            bucket,
            glyphMap: stacks,
            glyphPositions: {},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const tile = new Tile(tileID, 512);
        tile.latestFeatureIndex = new FeatureIndex(tileID);
        tile.buckets = {['secondary-only']: bucket};
        tile.collisionBoxArray = collisionArray;

        const crossTileSymbolIndex = new CrossTileSymbolIndex();
        crossTileSymbolIndex.addLayer(bucket.layers[0], [tile], undefined as any);

        const placement = new Placement(transform, undefined as any, 0, true);
        const parts: any[] = [];
        placement.getBucketParts(parts, bucket.layers[0], tile, false);
        for (const part of parts) {
            placement.placeLayerBucketPart(part, {}, false);
        }

        const secondaryCrossTileIDs: number[] = [];
        for (let i = 0; i < bucket.symbolInstances.length; i++) {
            if (bucket.symbolInstanceIsTextField2[i]) {
                const symbolInstance = bucket.symbolInstances.get(i);
                secondaryCrossTileIDs.push(symbolInstance.crossTileID);
            }
        }

        expect(secondaryCrossTileIDs).not.toHaveLength(0);
        for (const id of secondaryCrossTileIDs) {
            const placementResult = placement.placements[id];
            expect(placementResult?.text).toBe(false);
        }
    });

    test('text-field2 hidden when primary is occluded by collision', () => {
        const collisionArray = new CollisionBoxArray();
        const baseBucket = createSymbolBucket('base-layer', 'Test', 'base', collisionArray);
        const secondaryBucket = createSymbolBucket('secondary-layer', 'Test', 'base', collisionArray, {
            'text-field2': 'secondary',
            'text-field2-offset': [0, 2]
        });

        const baseOptions = createPopulateOptions([]);
        const secondaryOptions = createPopulateOptions([]);
        baseBucket.populate(features, baseOptions, undefined as any);
        secondaryBucket.populate(features, secondaryOptions, undefined as any);

        performSymbolLayout({
            bucket: baseBucket,
            glyphMap: stacks,
            glyphPositions: {},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        performSymbolLayout({
            bucket: secondaryBucket,
            glyphMap: stacks,
            glyphPositions: {},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const tile = new Tile(tileID, 512);
        tile.latestFeatureIndex = new FeatureIndex(tileID);
        tile.buckets = {
            'base-layer': baseBucket,
            'secondary-layer': secondaryBucket
        } as any;
        tile.collisionBoxArray = collisionArray;

        const crossTileSymbolIndex = new CrossTileSymbolIndex();
        crossTileSymbolIndex.addLayer(baseBucket.layers[0], [tile], undefined as any);
        crossTileSymbolIndex.addLayer(secondaryBucket.layers[0], [tile], undefined as any);

        const placement = new Placement(transform, undefined as any, 0, true);

        let parts: any[] = [];
        placement.getBucketParts(parts, baseBucket.layers[0], tile, false);
        for (const part of parts) {
            placement.placeLayerBucketPart(part, {}, false);
        }

        parts = [];
        placement.getBucketParts(parts, secondaryBucket.layers[0], tile, false);
        for (const part of parts) {
            placement.placeLayerBucketPart(part, {}, false);
        }

        for (let i = 0; i < secondaryBucket.symbolInstances.length; i++) {
            if (!secondaryBucket.symbolInstanceIsTextField2[i]) continue;
            const symbolInstance = secondaryBucket.symbolInstances.get(i);
            const placementResult = placement.placements[symbolInstance.crossTileID];
            expect(placementResult?.text).toBe(false);
        }
    });

    test('SymbolBucket detects rtl text', () => {
        const rtlBucket = bucketSetup('مرحبا');
        const ltrBucket = bucketSetup('hello');
        const options = createPopulateOptions([]);
        rtlBucket.populate(features, options, undefined as any);
        ltrBucket.populate(features, options, undefined as any);

        expect(rtlBucket.hasRTLText).toBeTruthy();
        expect(ltrBucket.hasRTLText).toBeFalsy();
    });

    // Test to prevent symbol bucket with rtl from text being culled by worker serialization.
    test('SymbolBucket with rtl text is NOT empty even though no symbol instances are created', () => {
        const rtlBucket = bucketSetup('مرحبا');
        const options = createPopulateOptions([]);
        rtlBucket.createArrays();
        rtlBucket.populate(features, options, undefined as any);

        expect(rtlBucket.isEmpty()).toBeFalsy();
        expect(rtlBucket.symbolInstances).toHaveLength(0);
    });

    test('SymbolBucket detects rtl text mixed with ltr text', () => {
        const mixedBucket = bucketSetup('مرحبا translates to hello');
        const options = createPopulateOptions([]);
        mixedBucket.populate(features, options, undefined as any);

        expect(mixedBucket.hasRTLText).toBeTruthy();
    });
});
