import {vi, describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {CollisionIndex, viewportPadding} from './collision_index';
import {MercatorTransform} from '../geo/projection/mercator_transform';
import {CanonicalTileID, UnwrappedTileID} from '../source/tile_id';
import {mat4} from 'gl-matrix';

describe('CollisionIndex', () => {
    test('floating point precision', () => {
        const x = 100000.123456, y = 0;
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        transform.resize(200, 200);
        const tile = new UnwrappedTileID(0, new CanonicalTileID(0, 0, 0));
        vi.spyOn(transform, 'calculatePosMatrix').mockImplementation(() => mat4.create());

        const ci = new CollisionIndex(transform);
        expect(ci.projectAndGetPerspectiveRatio(x, y, tile, null).x).toBeCloseTo(10000212.3456, 10);
    });

    test('queryRenderedSymbols returns glyph hit metadata', () => {
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        transform.resize(512, 512);
        const ci = new CollisionIndex(transform);

        const placedCircles = {
            circles: [viewportPadding + 16, viewportPadding + 16, 8, 2],
            offscreen: false,
            collisionDetected: false,
            glyphHits: [{circleIndex: 0, glyphArrayIndex: 3, glyphCharCode: 'w'.codePointAt(0)!, specialIndex: 0}]
        };

        ci.insertCollisionCircles(placedCircles, 'always', false, 7, 11, 2);

        const queryPolygon = [
            new Point(8, 8),
            new Point(24, 8),
            new Point(24, 24),
            new Point(8, 24)
        ];

        const result = ci.queryRenderedSymbols(queryPolygon);

        expect(result[7]).toEqual([
            {featureIndex: 11, collisionCircleIndex: 0, glyphArrayIndex: 3, glyphCharCode: 'w'.codePointAt(0)!}
        ]);
    });
});
