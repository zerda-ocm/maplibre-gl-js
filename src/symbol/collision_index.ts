import Point from '@mapbox/point-geometry';
import {clipLine} from './clip_line';
import {PathInterpolator} from './path_interpolator';

import * as intersectionTests from '../util/intersection_tests';
import {GridIndex} from './grid_index';
import {mat4, vec4} from 'gl-matrix';
import ONE_EM from '../symbol/one_em';

import type {IReadonlyTransform} from '../geo/transform_interface';
import type {SingleCollisionBox} from '../data/bucket/symbol_bucket';
import type {
    GlyphOffsetArray,
    GlyphRotationArray,
    GlyphCharacterArray,
    PlacedSymbol,
    SymbolLineVertexArray
} from '../data/array_types.g';
import type {OverlapMode} from '../style/style_layer/overlap_mode';
import {type OverscaledTileID, type UnwrappedTileID} from '../source/tile_id';
import {type PointProjection, type SymbolProjectionContext, getTileSkewVectors, pathSlicedToLongestUnoccluded, placeFirstAndLastGlyph, placeGlyphAlongLine, projectPathSpecialProjection, xyTransformMat4} from '../symbol/projection';
import type {TextRotationAlignmentOverrideValue} from './text_rotation_alignment';
import {shouldRotateGlyphToLine} from './text_rotation_alignment';
import {WritingMode} from './shaping';
import {clamp, getAABB} from '../util/util';
import {Bounds} from '../geo/bounds';

// When a symbol crosses the edge that causes it to be included in
// collision detection, it will cause changes in the symbols around
// it. This constant specifies how many pixels to pad the edge of
// the viewport for collision detection so that the bulk of the changes
// occur offscreen. Making this constant greater increases label
// stability, but it's expensive.
export const viewportPadding = 100;

const SPECIAL_GLYPH_CODES = new Set<number>(['w', 'n', 's', '\ue137'].map(ch => ch.codePointAt(0)!));

type GlyphCircleHitMeta = {
    circleIndex: number;
    glyphArrayIndex: number;
    glyphCharCode: number;
};

export type PlacedCircles = {
    circles: Array<number>;
    offscreen: boolean;
    collisionDetected: boolean;
    glyphHits: Array<GlyphCircleHitMeta>;
};

export type PlacedBox = {
    box: Array<number>;
    placeable: boolean;
    offscreen: boolean;
    occluded: boolean;
};

export type FeatureKey = {
    bucketInstanceId: number;
    featureIndex: number;
    collisionGroupID: number;
    overlapMode: OverlapMode;
    collisionCircleIndex?: number;
    glyphArrayIndex?: number;
    glyphCharCode?: number;
};

export type SymbolQueryMatch = {
    featureIndex: number;
    collisionCircleIndex?: number;
    glyphArrayIndex?: number;
    glyphCharCode?: number;
};

type ProjectedBox = {
    /**
     * The AABB in the format [minX, minY, maxX, maxY].
     */
    box: [number, number, number, number];
    allPointsOccluded: boolean;
};

/**
 * @internal
 * A collision index used to prevent symbols from overlapping. It keep tracks of
 * where previous symbols have been placed and is used to check if a new
 * symbol overlaps with any previously added symbols.
 *
 * There are two steps to insertion: first placeCollisionBox/Circles checks if
 * there's room for a symbol, then insertCollisionBox/Circles actually puts the
 * symbol in the index. The two step process allows paired symbols to be inserted
 * together even if they overlap.
 */
export class CollisionIndex {
    grid: GridIndex<FeatureKey>;
    ignoredGrid: GridIndex<FeatureKey>;
    transform: IReadonlyTransform;
    pitchFactor: number;
    screenRightBoundary: number;
    screenBottomBoundary: number;
    gridRightBoundary: number;
    gridBottomBoundary: number;

    // With perspectiveRatio the fontsize is calculated for tilted maps (near = bigger, far = smaller).
    // The cutoff defines a threshold to no longer render labels near the horizon.
    perspectiveRatioCutoff: number;

    constructor(
        transform: IReadonlyTransform,
        grid = new GridIndex<FeatureKey>(transform.width + 2 * viewportPadding, transform.height + 2 * viewportPadding, 25),
        ignoredGrid = new GridIndex<FeatureKey>(transform.width + 2 * viewportPadding, transform.height + 2 * viewportPadding, 25)
    ) {
        this.transform = transform;

        this.grid = grid;
        this.ignoredGrid = ignoredGrid;
        this.pitchFactor = Math.cos(transform.pitch * Math.PI / 180.0) * transform.cameraToCenterDistance;

        this.screenRightBoundary = transform.width + viewportPadding;
        this.screenBottomBoundary = transform.height + viewportPadding;
        this.gridRightBoundary = transform.width + 2 * viewportPadding;
        this.gridBottomBoundary = transform.height + 2 * viewportPadding;

        this.perspectiveRatioCutoff = 0.6;
    }

    placeCollisionBox(
        collisionBox: SingleCollisionBox,
        overlapMode: OverlapMode,
        textPixelRatio: number,
        tileID: OverscaledTileID,
        unwrappedTileID: UnwrappedTileID,
        pitchWithMap: boolean,
        rotateWithMap: boolean,
        translation: [number, number],
        collisionGroupPredicate?: (key: FeatureKey) => boolean,
        getElevation?: (x: number, y: number) => number,
        shift?: Point,
        simpleProjectionMatrix?: mat4,
    ): PlacedBox {
        const x = collisionBox.anchorPointX + translation[0];
        const y = collisionBox.anchorPointY + translation[1];
        const projectedPoint = this.projectAndGetPerspectiveRatio(
            x,
            y,
            unwrappedTileID,
            getElevation,
            simpleProjectionMatrix
        );
        const placedCollisionCircles = [];

        const tileToViewport = textPixelRatio * projectedPoint.perspectiveRatio;
        let projectedBox: ProjectedBox;

        if (!pitchWithMap && !rotateWithMap) {
            // Fast path for common symbols
            const pointX = projectedPoint.x + (shift ? shift.x * tileToViewport : 0);
            const pointY = projectedPoint.y + (shift ? shift.y * tileToViewport : 0);
            projectedBox = {
                allPointsOccluded: false,
                box: [
                    pointX + collisionBox.x1 * tileToViewport,
                    pointY + collisionBox.y1 * tileToViewport,
                    pointX + collisionBox.x2 * tileToViewport,
                    pointY + collisionBox.y2 * tileToViewport,
                ]
            };
        } else {
            projectedBox = this._projectCollisionBox(
                collisionBox,
                tileToViewport,
                tileID,
                unwrappedTileID,
                pitchWithMap,
                rotateWithMap,
                translation,
                projectedPoint,
                getElevation,
                shift,
                simpleProjectionMatrix,
            );
        }

        const [tlX, tlY, brX, brY] = projectedBox.box;

        placedCollisionCircles.push(tlX, tlY, 20, 0);

        placedCollisionCircles.push(tlX, tlY, 20, 0);

        // Conditions are ordered from the fastest to evaluate to the slowest.
        const occluded = pitchWithMap ? projectedBox.allPointsOccluded : projectedPoint.isOccluded;

        let unplaceable = occluded;
        unplaceable ||= projectedPoint.perspectiveRatio < this.perspectiveRatioCutoff;
        unplaceable ||= !this.isInsideGrid(tlX, tlY, brX, brY);

        if (unplaceable ||
            (overlapMode !== 'always' && this.grid.hitTest(tlX, tlY, brX, brY, overlapMode, collisionGroupPredicate))) {
            return {
                box: [tlX, tlY, brX, brY],
                placeable: false,
                offscreen: false,
                occluded
            };
        }

        return {
            box: [tlX, tlY, brX, brY],
            placeable: true,
            offscreen: this.isOffscreen(tlX, tlY, brX, brY),
            occluded
        };
    }

    placeCollisionCircles(
        overlapMode: OverlapMode,
        symbol: PlacedSymbol,
        lineVertexArray: SymbolLineVertexArray,
        glyphOffsetArray: GlyphOffsetArray,
        glyphRotationArray: GlyphRotationArray,
        glyphCharacterArray: GlyphCharacterArray,
        fontSize: number,
        unwrappedTileID: UnwrappedTileID,
        pitchedLabelPlaneMatrix: mat4,
        showCollisionCircles: boolean,
        pitchWithMap: boolean,
        rotateToLine: boolean,
        keepUpright: boolean,
        collisionGroupPredicate: (key: FeatureKey) => boolean,
        circlePixelDiameter: number,
        textPixelPadding: number,
        translation: [number, number],
        getElevation: (x: number, y: number) => number
    ): PlacedCircles {
        const placedCollisionCircles = [];
        const glyphHits: Array<GlyphCircleHitMeta> = [];

        const tileUnitAnchorPoint = new Point(symbol.anchorX, symbol.anchorY);
        const perspectiveRatio = this.getPerspectiveRatio(tileUnitAnchorPoint.x, tileUnitAnchorPoint.y, unwrappedTileID, getElevation);

        const labelPlaneFontSize = pitchWithMap ? fontSize / perspectiveRatio : fontSize * perspectiveRatio;
        const labelPlaneFontScale = labelPlaneFontSize / ONE_EM;

        const projectionCache = {projections: {}, offsets: {}, cachedAnchorPoint: undefined, anyProjectionOccluded: false};
        const lineOffsetX = symbol.lineOffsetX * labelPlaneFontScale;
        const lineOffsetY = symbol.lineOffsetY * labelPlaneFontScale;

        const projectionContext: SymbolProjectionContext = {
            getElevation,
            pitchedLabelPlaneMatrix,
            lineVertexArray,
            pitchWithMap,
            projectionCache,
            transform: this.transform,
            tileAnchorPoint: tileUnitAnchorPoint,
            unwrappedTileID,
            width: this.transform.width,
            height: this.transform.height,
            translation
        };

        const firstAndLastGlyph = placeFirstAndLastGlyph(
            labelPlaneFontScale,
            glyphOffsetArray,
            glyphRotationArray,
            lineOffsetX,
            lineOffsetY,
            /*flip*/ false,
            symbol,
            rotateToLine,
            projectionContext,
            unwrappedTileID);

        let collisionDetected = false;
        let inGrid = false;
        let entirelyOffscreen = true;
        const aspectRatio = this.transform.width / this.transform.height;
        const pitchedLabelPlaneMatrixInverse = pitchWithMap ? mat4.invert(mat4.create(), pitchedLabelPlaneMatrix) : null;

        const projectLabelPointToClip = (point: Point) => {
            if (pitchWithMap) {
                if (!pitchedLabelPlaneMatrixInverse) {
                    return new Point(0, 0);
                }
                const pos = vec4.fromValues(point.x, point.y, 0, 1);
                vec4.transformMat4(pos, pos, pitchedLabelPlaneMatrixInverse);
                const projected = this.transform.projectTileCoordinates(pos[0] / pos[3], pos[1] / pos[3], unwrappedTileID, getElevation);
                return projected.point;
            }

            return new Point(
                (point.x / this.transform.width) * 2.0 - 1.0,
                1.0 - (point.y / this.transform.height) * 2.0
            );
        };

        let glyphFlip = false;
        let canPlaceGlyphCircles = true;

        const updateCoverage = (centerX: number, centerY: number, radiusValue: number) => {
            const x1 = centerX - radiusValue;
            const y1 = centerY - radiusValue;
            const x2 = centerX + radiusValue;
            const y2 = centerY + radiusValue;
            entirelyOffscreen = entirelyOffscreen && this.isOffscreen(x1, y1, x2, y2);
            inGrid = inGrid || this.isInsideGrid(x1, y1, x2, y2);
        };

        if (firstAndLastGlyph) {
            if (keepUpright) {
                const firstClip = projectLabelPointToClip(firstAndLastGlyph.first.point);
                const lastClip = projectLabelPointToClip(firstAndLastGlyph.last.point);

                if (symbol.writingMode === WritingMode.horizontal) {
                    const rise = Math.abs(lastClip.y - firstClip.y);
                    const run = Math.abs(lastClip.x - firstClip.x) * aspectRatio;
                    if (rise > run) {
                        canPlaceGlyphCircles = false;
                    }
                }

                if (canPlaceGlyphCircles) {
                    const needsFlip = symbol.writingMode === WritingMode.vertical ?
                        firstClip.y < lastClip.y :
                        firstClip.x > lastClip.x;
                    glyphFlip = needsFlip;
                }
            }

            const zoomFraction = this.transform.zoom - Math.floor(this.transform.zoom);
            const circlePixelDiameterMultiplier = 1 / Math.pow(2, -zoomFraction);
            const radius = circlePixelDiameterMultiplier * circlePixelDiameter * 0.25 * perspectiveRatio + textPixelPadding;
            //const radius = circlePixelDiameter * 0.5 * perspectiveRatio + textPixelPadding;
            const screenPlaneMin = new Point(-viewportPadding, -viewportPadding);
            const screenPlaneMax = new Point(this.screenRightBoundary, this.screenBottomBoundary);
            const interpolator = new PathInterpolator();

            // Construct a projected path from projected line vertices. Anchor points are ignored and removed
            const first = firstAndLastGlyph.first;
            const last = firstAndLastGlyph.last;

            let projectedPath: Array<Point> = [];
            for (let i = first.path.length - 1; i >= 1; i--) {
                projectedPath.push(first.path[i]);
            }
            for (let i = 1; i < last.path.length; i++) {
                projectedPath.push(last.path[i]);
            }

            // Tolerate a slightly longer distance than one diameter between two adjacent circles
            const circleDist = radius * 2.5;

            // The path might need to be converted into screen space if a pitched map is used as the label space
            if (pitchWithMap) {
                const screenSpacePath = this.projectPathToScreenSpace(projectedPath, projectionContext);
                // Do not try to place collision circles if even one of the points is behind the camera.
                // This is a plausible scenario with big camera pitch angles
                if (screenSpacePath.some(point => point.signedDistanceFromCamera <= 0)) {
                    projectedPath = [];
                } else {
                    projectedPath = screenSpacePath.map(p => p.point);
                }
            }

            let segments = [];

            if (projectedPath.length > 0) {
                // Quickly check if the path is fully inside or outside of the padded collision region.
                // For overlapping paths we'll only create collision circles for the visible segments
                const minPoint = projectedPath[0].clone();
                const maxPoint = projectedPath[0].clone();

                for (let i = 1; i < projectedPath.length; i++) {
                    minPoint.x = Math.min(minPoint.x, projectedPath[i].x);
                    minPoint.y = Math.min(minPoint.y, projectedPath[i].y);
                    maxPoint.x = Math.max(maxPoint.x, projectedPath[i].x);
                    maxPoint.y = Math.max(maxPoint.y, projectedPath[i].y);
                }

                if (minPoint.x >= screenPlaneMin.x && maxPoint.x <= screenPlaneMax.x &&
                    minPoint.y >= screenPlaneMin.y && maxPoint.y <= screenPlaneMax.y) {
                    // Quad fully visible
                    segments = [projectedPath];
                } else if (maxPoint.x < screenPlaneMin.x || minPoint.x > screenPlaneMax.x ||
                    maxPoint.y < screenPlaneMin.y || minPoint.y > screenPlaneMax.y) {
                    // Not visible
                    segments = [];
                } else {
                    segments = clipLine([projectedPath], screenPlaneMin.x, screenPlaneMin.y, screenPlaneMax.x, screenPlaneMax.y);
                }
            }

            for (const seg of segments) {
                // interpolate positions for collision circles. Add a small padding to both ends of the segment
                interpolator.reset(seg, radius * 0.25);

                let numCircles = 0;

                if (interpolator.length <= 0.5 * radius) {
                    numCircles = 1;
                } else {
                    numCircles = Math.ceil(interpolator.paddedLength / circleDist) + 1;
                }

                for (let i = 0; i < numCircles; i++) {
                    const t = i / Math.max(numCircles - 1, 1);
                    const circlePosition = interpolator.lerp(t);

                    // add viewport padding to the position and perform initial collision check
                    const centerX = circlePosition.x + viewportPadding;
                    const centerY = circlePosition.y + viewportPadding;

                    updateCoverage(centerX, centerY, radius);

                    let collided = false;
                    if (overlapMode !== 'always' && this.grid.hitTestCircle(centerX, centerY, radius, overlapMode, collisionGroupPredicate)) {
                        // Don't early exit if we're showing the debug circles because we still want to calculate
                        // which circles are in use
                        collisionDetected = true;
                        collided = true;
                        if (!showCollisionCircles) {
                            return {
                                circles: [],
                                offscreen: false,
                                collisionDetected,
                                glyphHits: []
                            };
                        }
                    }

                    placedCollisionCircles.push(centerX, centerY, radius, collided ? 1 : 0);
                }
            }

            if (symbol.numGlyphs > 0 && symbol.lineLength > 0 && canPlaceGlyphCircles) {
                const glyphStartIndex = symbol.glyphStartIndex;
                const glyphEndIndex = glyphStartIndex + symbol.numGlyphs;
                const lineStartIndex = symbol.lineStartIndex;
                const lineEndIndex = lineStartIndex + symbol.lineLength;
                const glyphLabelPlanePoints: Array<{point: Point; glyphIndex: number; glyphCharCode: number}> = [];

                for (let glyphIndex = glyphStartIndex; glyphIndex < glyphEndIndex; glyphIndex++) {
                    const glyphCharCode = glyphCharacterArray.getchar(glyphIndex);
                    if (!SPECIAL_GLYPH_CODES.has(glyphCharCode)) {
                        continue;
                    }

                    const glyphOffset = glyphOffsetArray.getoffsetX(glyphIndex);
                    const glyphOverride = glyphRotationArray.getoverride(glyphIndex) as TextRotationAlignmentOverrideValue;
                    const rotateGlyphToLine = shouldRotateGlyphToLine(glyphOverride, rotateToLine);
                    const placedGlyph = placeGlyphAlongLine(
                        labelPlaneFontScale * glyphOffset,
                        lineOffsetX,
                        lineOffsetY,
                        glyphFlip,
                        symbol.segment,
                        lineStartIndex,
                        lineEndIndex,
                        projectionContext,
                        rotateGlyphToLine,
                        glyphOverride,
                        unwrappedTileID
                    );

                    if (!placedGlyph) {
                        continue;
                    }

                    glyphLabelPlanePoints.push({point: placedGlyph.point, glyphIndex, glyphCharCode});
                }

                let glyphProjections: Array<PointProjection> | null = null;
                if (pitchWithMap && glyphLabelPlanePoints.length > 0) {
                    const glyphPoints = glyphLabelPlanePoints.map(item => item.point);
                    glyphProjections = projectPathSpecialProjection(glyphPoints, projectionContext);
                }

                for (let i = 0; i < glyphLabelPlanePoints.length; i++) {
                    const glyphInfo = glyphLabelPlanePoints[i];
                    let glyphPoint = glyphInfo.point;
                    if (pitchWithMap) {
                        const projection = glyphProjections && glyphProjections[i];
                        if (!projection || projection.isOccluded) {
                            continue;
                        }
                        glyphPoint = projection.point;
                    }

                    const centerX = glyphPoint.x + viewportPadding;
                    const centerY = glyphPoint.y + viewportPadding;

                    updateCoverage(centerX, centerY, radius);
                    placedCollisionCircles.push(centerX, centerY, radius, 2);
                    const circleIndex = placedCollisionCircles.length / 4 - 1;
                    glyphHits.push({circleIndex, glyphArrayIndex: glyphInfo.glyphIndex, glyphCharCode: glyphInfo.glyphCharCode});
                }
            }
        }

        return {
            circles: ((!showCollisionCircles && collisionDetected) || !inGrid || perspectiveRatio < this.perspectiveRatioCutoff) ? [] : placedCollisionCircles,
            offscreen: entirelyOffscreen,
            collisionDetected,
            glyphHits
        };
    }

    projectPathToScreenSpace(projectedPath: Array<Point>, projectionContext: SymbolProjectionContext): Array<PointProjection> {
        const screenSpacePath = projectPathSpecialProjection(projectedPath, projectionContext);
        // We don't want to generate screenspace collision circles for parts of the line that
        // are occluded by the planet itself. Find the longest segment of the path that is
        // not occluded, and remove everything else.
        return pathSlicedToLongestUnoccluded(screenSpacePath);
    }

    /**
     * Because the geometries in the CollisionIndex are an approximation of the shape of
     * symbols on the map, we use the CollisionIndex to look up the symbol part of
     * `queryRenderedFeatures`.
     */
    queryRenderedSymbols(viewportQueryGeometry: Array<Point>): {[bucketInstanceId: number]: Array<SymbolQueryMatch>} {
        if (viewportQueryGeometry.length === 0 || (this.grid.keysLength() === 0 && this.ignoredGrid.keysLength() === 0)) {
            return {};
        }

        const query = [];
        const bounds = new Bounds();
        for (const point of viewportQueryGeometry) {
            const gridPoint = new Point(point.x + viewportPadding, point.y + viewportPadding);
            bounds.extend(gridPoint);
            query.push(gridPoint);
        }

        const {minX, minY, maxX, maxY} = bounds;
        const features = this.grid.query(minX, minY, maxX, maxY)
            .concat(this.ignoredGrid.query(minX, minY, maxX, maxY));

        const seenFeatures: {
            [bucketId: number]: {
                boxes: {[featureIndex: number]: boolean};
                circles: {[featureIndex: number]: {[circleIndex: number]: boolean}};
            };
        } = {};
        const result: {[bucketInstanceId: number]: Array<SymbolQueryMatch>} = {};

        for (const feature of features) {
            const featureKey = feature.key;
            if (!featureKey) {
                continue;
            }
            // Skip already seen features.
            const bucketId = featureKey.bucketInstanceId;
            if (seenFeatures[bucketId] === undefined) {
                seenFeatures[bucketId] = {boxes: {}, circles: {}};
            }
            const bucketSeen = seenFeatures[bucketId];

            // Check if query intersects with the feature box
            // "Collision Circles" for line labels are treated as boxes here
            // Since there's no actual collision taking place, the circle vs. square
            // distinction doesn't matter as much, and box geometry is easier
            // to work with.
            const bbox = [
                new Point(feature.x1, feature.y1),
                new Point(feature.x2, feature.y1),
                new Point(feature.x2, feature.y2),
                new Point(feature.x1, feature.y2)
            ];
            if (!intersectionTests.polygonIntersectsPolygon(query, bbox)) {
                continue;
            }

            const hasCircleIndex = featureKey.collisionCircleIndex !== undefined;
            if (hasCircleIndex) {
                if (!bucketSeen.circles[featureKey.featureIndex]) {
                    bucketSeen.circles[featureKey.featureIndex] = {};
                }
                const seenCircleIndexes = bucketSeen.circles[featureKey.featureIndex];
                if (seenCircleIndexes[featureKey.collisionCircleIndex]) {
                    continue;
                }
                seenCircleIndexes[featureKey.collisionCircleIndex] = true;
            } else {
                if (bucketSeen.boxes[featureKey.featureIndex]) {
                    continue;
                }
                bucketSeen.boxes[featureKey.featureIndex] = true;
            }

            if (result[bucketId] === undefined) {
                result[bucketId] = [];
            }
            const entry: SymbolQueryMatch = {featureIndex: featureKey.featureIndex};
            if (hasCircleIndex) {
                entry.collisionCircleIndex = featureKey.collisionCircleIndex;
                if (featureKey.glyphArrayIndex !== undefined) {
                    entry.glyphArrayIndex = featureKey.glyphArrayIndex;
                }
                if (featureKey.glyphCharCode !== undefined) {
                    entry.glyphCharCode = featureKey.glyphCharCode;
                }
            }
            result[bucketId].push(entry);
        }

        return result;
    }

    insertCollisionBox(collisionBox: Array<number>, overlapMode: OverlapMode, ignorePlacement: boolean, bucketInstanceId: number, featureIndex: number, collisionGroupID: number) {
        const grid = ignorePlacement ? this.ignoredGrid : this.grid;

        const key = {bucketInstanceId, featureIndex, collisionGroupID, overlapMode};
        grid.insert(key, collisionBox[0], collisionBox[1], collisionBox[2], collisionBox[3]);
    }

    insertCollisionCircles(placedCircles: PlacedCircles, overlapMode: OverlapMode, ignorePlacement: boolean, bucketInstanceId: number, featureIndex: number, collisionGroupID: number) {
        if (!placedCircles || placedCircles.circles.length === 0) {
            return;
        }
        const grid = ignorePlacement ? this.ignoredGrid : this.grid;

        const circles = placedCircles.circles;
        const glyphHitMap = new Map<number, GlyphCircleHitMeta>();
        for (const hit of placedCircles.glyphHits || []) {
            glyphHitMap.set(hit.circleIndex, hit);
        }

        const baseKey = {bucketInstanceId, featureIndex, collisionGroupID, overlapMode};
        for (let k = 0, circleIndex = 0; k < circles.length; k += 4, circleIndex++) {
            const hit = glyphHitMap.get(circleIndex);
            const key: FeatureKey = {...baseKey};
            if (hit) {
                key.collisionCircleIndex = hit.circleIndex;
                key.glyphArrayIndex = hit.glyphArrayIndex;
                key.glyphCharCode = hit.glyphCharCode;
            }
            grid.insertCircle(key, circles[k], circles[k + 1], circles[k + 2]);
        }
    }

    projectAndGetPerspectiveRatio(x: number, y: number, unwrappedTileID: UnwrappedTileID, getElevation?: (x: number, y: number) => number, simpleProjectionMatrix?: mat4) {
        if (simpleProjectionMatrix) {
            // This branch is a fast-path for mercator transform.
            // The code here is a copy of MercatorTransform.projectTileCoordinates, slightly modified for extra performance.
            // This has a huge impact for some reason.
            let pos;
            if (getElevation) { // slow because of handle z-index
                pos = [x, y, getElevation(x, y), 1] as vec4;
                vec4.transformMat4(pos, pos, simpleProjectionMatrix);
            } else { // fast because of ignore z-index
                pos = [x, y, 0, 1] as vec4;
                xyTransformMat4(pos, pos, simpleProjectionMatrix);
            }
            const w = pos[3];
            return {
                x: (((pos[0] / w + 1) / 2) * this.transform.width) + viewportPadding,
                y: (((-pos[1] / w + 1) / 2) * this.transform.height) + viewportPadding,
                perspectiveRatio: 0.5 + 0.5 * (this.transform.cameraToCenterDistance / w),
                isOccluded: false,
                signedDistanceFromCamera: w
            };
        } else {
            const projected = this.transform.projectTileCoordinates(x, y, unwrappedTileID, getElevation);
            return {
                x: (((projected.point.x + 1) / 2) * this.transform.width) + viewportPadding,
                y: (((-projected.point.y + 1) / 2) * this.transform.height) + viewportPadding,
                // See perspective ratio comment in symbol_sdf.vertex
                // We're doing collision detection in viewport space so we need
                // to scale down boxes in the distance
                perspectiveRatio: 0.5 + 0.5 * (this.transform.cameraToCenterDistance / projected.signedDistanceFromCamera),
                isOccluded: projected.isOccluded,
                signedDistanceFromCamera: projected.signedDistanceFromCamera
            };
        }
    }

    getPerspectiveRatio(x: number, y: number, unwrappedTileID: UnwrappedTileID, getElevation?: (x: number, y: number) => number): number {
        // We don't care about the actual projected point, just its W component.
        const projected = this.transform.projectTileCoordinates(x, y, unwrappedTileID, getElevation);
        return 0.5 + 0.5 * (this.transform.cameraToCenterDistance / projected.signedDistanceFromCamera);
    }

    isOffscreen(x1: number, y1: number, x2: number, y2: number) {
        return x2 < viewportPadding || x1 >= this.screenRightBoundary || y2 < viewportPadding || y1 > this.screenBottomBoundary;
    }

    isInsideGrid(x1: number, y1: number, x2: number, y2: number) {
        return x2 >= 0 && x1 < this.gridRightBoundary && y2 >= 0 && y1 < this.gridBottomBoundary;
    }

    /*
    * Returns a matrix for transforming collision shapes to viewport coordinate space.
    * Use this function to render e.g. collision circles on the screen.
    *   example transformation: clipPos = glCoordMatrix * viewportMatrix * circle_pos
    */
    getViewportMatrix() {
        const m = mat4.identity([] as any);
        mat4.translate(m, m, [-viewportPadding, -viewportPadding, 0.0]);
        return m;
    }

    /**
     * Applies all layout+paint properties of the given box in order to find as good approximation of its screen-space bounding box as possible.
     */
    private _projectCollisionBox(
        collisionBox: SingleCollisionBox,
        tileToViewport: number,
        tileID: OverscaledTileID,
        unwrappedTileID: UnwrappedTileID,
        pitchWithMap: boolean,
        rotateWithMap: boolean,
        translation: [number, number],
        projectedPoint: {x: number; y: number; perspectiveRatio: number; signedDistanceFromCamera: number},
        getElevation?: (x: number, y: number) => number,
        shift?: Point,
        simpleProjectionMatrix?: mat4,
    ): ProjectedBox {
        // These vectors are valid both for screen space viewport-rotation-aligned texts and for pitch-align: map texts that are map-rotation-aligned.
        let vecEastX = 1;
        let vecEastY = 0;
        let vecSouthX = 0;
        let vecSouthY = 1;

        const translatedAnchorX = collisionBox.anchorPointX + translation[0];
        const translatedAnchorY = collisionBox.anchorPointY + translation[1];

        if (rotateWithMap && !pitchWithMap) {
            // Handles screen space texts that are always aligned east-west.
            const projectedEast = this.projectAndGetPerspectiveRatio(
                translatedAnchorX + 1,
                translatedAnchorY,
                unwrappedTileID,
                getElevation,
                simpleProjectionMatrix,
            );
            const toEastX = projectedEast.x - projectedPoint.x;
            const toEastY = projectedEast.y - projectedPoint.y;
            const angle = Math.atan(toEastY / toEastX) + (toEastX < 0 ? Math.PI : 0);
            const sin = Math.sin(angle);
            const cos = Math.cos(angle);
            vecEastX = cos;
            vecEastY = sin;
            vecSouthX = -sin;
            vecSouthY = cos;
        } else if (!rotateWithMap && pitchWithMap) {
            // Handles pitch-align: map texts that are always aligned with the viewport's X axis.
            const skew = getTileSkewVectors(this.transform);
            vecEastX = skew.vecEast[0];
            vecEastY = skew.vecEast[1];
            vecSouthX = skew.vecSouth[0];
            vecSouthY = skew.vecSouth[1];
        }

        // Configuration for screen space offsets
        let basePointX = projectedPoint.x;
        let basePointY = projectedPoint.y;
        let distanceMultiplier = tileToViewport;

        if (pitchWithMap) {
            // Configuration for tile space (map-pitch-aligned) offsets
            basePointX = translatedAnchorX;
            basePointY = translatedAnchorY;

            const zoomFraction = this.transform.zoom - tileID.overscaledZ;
            distanceMultiplier = Math.pow(2, -zoomFraction);
            distanceMultiplier *= this.transform.getPitchedTextCorrection(translatedAnchorX, translatedAnchorY, unwrappedTileID);

            // This next correction can't be applied when variable anchors are in use.
            if (!shift) {
                // Shader applies a perspective size correction, we need to apply the same correction.
                // For non-pitchWithMap texts, this is handled above by multiplying `textPixelRatio` with `projectedPoint.perspectiveRatio`,
                // which is equivalent to the non-pitchWithMap branch of the GLSL code.
                // Here, we compute and apply the pitchWithMap branch.
                // See the computation of `perspective_ratio` in the symbol vertex shaders for the GLSL code.
                const distanceRatio = projectedPoint.signedDistanceFromCamera / this.transform.cameraToCenterDistance;
                const perspectiveRatio = clamp(0.5 + 0.5 * distanceRatio, 0.0, 4.0); // Same clamp as what is used in the shader.
                distanceMultiplier *= perspectiveRatio;
            }
        }

        if (shift) {
            // Variable anchors are in use
            basePointX += vecEastX * shift.x * distanceMultiplier + vecSouthX * shift.y * distanceMultiplier;
            basePointY += vecEastY * shift.x * distanceMultiplier + vecSouthY * shift.y * distanceMultiplier;
        }

        const offsetXmin = collisionBox.x1 * distanceMultiplier;
        const offsetXmax = collisionBox.x2 * distanceMultiplier;
        const offsetXhalf = (offsetXmin + offsetXmax) / 2;
        const offsetYmin = collisionBox.y1 * distanceMultiplier;
        const offsetYmax = collisionBox.y2 * distanceMultiplier;
        const offsetYhalf = (offsetYmin + offsetYmax) / 2;

        // 0--1--2
        // |     |
        // 7     3
        // |     |
        // 6--5--4
        const offsetsArray: Array<{offsetX: number; offsetY: number}> = [
            {offsetX: offsetXmin,  offsetY: offsetYmin},
            {offsetX: offsetXhalf, offsetY: offsetYmin},
            {offsetX: offsetXmax,  offsetY: offsetYmin},
            {offsetX: offsetXmax,  offsetY: offsetYhalf},
            {offsetX: offsetXmax,  offsetY: offsetYmax},
            {offsetX: offsetXhalf, offsetY: offsetYmax},
            {offsetX: offsetXmin,  offsetY: offsetYmax},
            {offsetX: offsetXmin,  offsetY: offsetYhalf}
        ];

        let points: Array<Point> = [];

        for (const {offsetX, offsetY} of offsetsArray) {
            points.push(new Point(
                basePointX + vecEastX * offsetX + vecSouthX * offsetY,
                basePointY + vecEastY * offsetX + vecSouthY * offsetY
            ));
        }

        // Is any point of the collision shape visible on the globe (on beyond horizon)?
        let anyPointVisible = false;

        if (pitchWithMap) {
            const projected = points.map(p => this.projectAndGetPerspectiveRatio(p.x, p.y, unwrappedTileID, getElevation, simpleProjectionMatrix));

            // Is at least one of the projected points NOT behind the horizon?
            anyPointVisible = projected.some(p => !p.isOccluded);

            points = projected.map(p => new Point(p.x, p.y));
        } else {
            // Labels that are not pitchWithMap cannot ever hide behind the horizon.
            anyPointVisible = true;
        }

        return {
            box: getAABB(points),
            allPointsOccluded: !anyPointVisible
        };
    }
}
