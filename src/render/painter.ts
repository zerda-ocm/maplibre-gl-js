import {now} from '../util/time_control.ts';
import {mat4} from 'gl-matrix';
import {TileManager} from '../tile/tile_manager.ts';
import {EXTENT} from '../data/extent.ts';
import {SegmentVector} from '../data/segment.ts';
import {RasterBoundsArray, PosArray, TriangleIndexArray, LineStripIndexArray} from '../data/array_types.g.ts';
import rasterBoundsAttributes from '../data/raster_bounds_attributes.ts';
import posAttributes from '../data/pos_attributes.ts';
import {type ProgramConfiguration} from '../data/program_configuration.ts';
import {CrossTileSymbolIndex} from '../symbol/cross_tile_symbol_index.ts';
import {shaders} from '../shaders/shaders.ts';
import {Program} from '../webgl/program.ts';
import {programUniforms} from '../webgl/program/program_uniforms.ts';
import {Context} from '../webgl/context.ts';
import {DepthMode} from '../webgl/depth_mode.ts';
import {StencilMode} from '../webgl/stencil_mode.ts';
import {ColorMode} from '../webgl/color_mode.ts';
import {CullFaceMode} from '../webgl/cull_face_mode.ts';
import {Texture} from '../webgl/texture.ts';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {selectDebugSource, webglDrawFunctions, type DrawFunctions} from '../webgl/draw/index.ts';
import {type OverscaledTileID} from '../tile/tile_id.ts';
import {Mesh} from './mesh.ts';
import {MercatorShaderDefine, MercatorShaderVariantKey} from '../geo/projection/mercator_projection.ts';

import type {IReadonlyTransform} from '../geo/transform_interface.ts';
import type {Style} from '../style/style.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {CrossFaded} from '../style/properties.ts';
import type {LineAtlas} from './line_atlas.ts';
import type {ImageManager} from './image_manager.ts';
import type {GlyphManager} from './glyph_manager.ts';
import type {VertexBuffer} from '../webgl/vertex_buffer.ts';
import type {IndexBuffer} from '../webgl/index_buffer.ts';
import type {DepthRangeType, DepthMaskType, DepthFuncType} from '../webgl/types.ts';
import type {ResolvedImage} from '@maplibre/maplibre-gl-style-spec';
import type {IRenderToTexture} from './render_to_texture_interface.ts';
import type {TerrainData} from './terrain.ts';
import type {ProjectionData} from '../geo/projection/projection_data.ts';
import type {Framebuffer} from '../webgl/framebuffer.ts';
import {coveringTiles} from '../geo/projection/covering_tiles.ts';
import {isSymbolStyleLayer} from '../style/style_layer/symbol_style_layer.ts';
import {isCircleStyleLayer} from '../style/style_layer/circle_style_layer.ts';
import {isHeatmapStyleLayer} from '../style/style_layer/heatmap_style_layer.ts';
import {isLineStyleLayer} from '../style/style_layer/line_style_layer.ts';
import {isFillStyleLayer} from '../style/style_layer/fill_style_layer.ts';
import {isFillExtrusionStyleLayer} from '../style/style_layer/fill_extrusion_style_layer.ts';
import {isHillshadeStyleLayer} from '../style/style_layer/hillshade_style_layer.ts';
import {isColorReliefStyleLayer} from '../style/style_layer/color_relief_style_layer.ts';
import {isRasterStyleLayer} from '../style/style_layer/raster_style_layer.ts';
import {isBackgroundStyleLayer} from '../style/style_layer/background_style_layer.ts';
import {isCustomStyleLayer} from '../style/style_layer/custom_style_layer.ts';

export type RenderPass = 'offscreen' | 'opaque' | 'translucent';

type PainterOptions = {
    showOverdrawInspector: boolean;
    showTileBoundaries: boolean;
    showPadding: boolean;
    rotating: boolean;
    zooming: boolean;
    moving: boolean;
    fadeDuration: number;
    anisotropicFilterPitch: number;
};

export type RenderOptions = {
    isRenderingToTexture: boolean;
    isRenderingGlobe: boolean;
};

export type RTTObject = {
    texture: Texture;
    size: number;
};

/**
 * @internal
 * Initialize a new painter object.
 */
export class Painter {
    drawFunctions: DrawFunctions;
    context: Context;
    transform: IReadonlyTransform;
    renderToTexture: IRenderToTexture;
    _tileTextures: {
        [_: number]: Texture[];
    };
    _rttObjectRecyclePool: RTTObject[];
    _rttSharedFbo: {
        fbo: Framebuffer;
        depthRenderbuffer: WebGLRenderbuffer;
        size: number;
    } | null;
    layerOpacityFbo: Framebuffer | null;
    /**
     * Isolated scratch FBO used by composite groups sharing a `composite-group` identifier.
     */
    compositeGroupFbo: Framebuffer | null;
    compositeGroupTexture: Texture | null;
    /**
     * Second isolated scratch FBO used to capture the alpha/mask geometry.
     */
    compositeMaskFbo: Framebuffer | null;
    compositeMaskTexture: Texture | null;
    numSublayers: number;
    depthEpsilon: number;
    emptyProgramConfiguration: ProgramConfiguration;
    width: number;
    height: number;
    pixelRatio: number;
    tileExtentBuffer: VertexBuffer;
    tileExtentSegments: SegmentVector;
    tileExtentMesh: Mesh;

    debugBuffer: VertexBuffer;
    debugSegments: SegmentVector;
    rasterBoundsBuffer: VertexBuffer;
    rasterBoundsSegments: SegmentVector;
    rasterBoundsBufferPosOnly: VertexBuffer;
    rasterBoundsSegmentsPosOnly: SegmentVector;
    viewportBuffer: VertexBuffer;
    viewportSegments: SegmentVector;
    quadTriangleIndexBuffer: IndexBuffer;
    tileBorderIndexBuffer: IndexBuffer;
    _tileClippingMaskIDs: {[_: string]: number};
    stencilClearMode: StencilMode;
    style: Style;
    options: PainterOptions;
    lineAtlas: LineAtlas;
    imageManager: ImageManager;
    glyphManager: GlyphManager;
    depthRangeFor3D: DepthRangeType;
    opaquePassCutoff: number;
    renderPass: RenderPass;
    currentLayer: number;
    currentStencilSource: string;
    nextStencilID: number;
    id: string;
    _showOverdrawInspector: boolean;
    cache: {[_: string]: Program<any>};
    crossTileSymbolIndex: CrossTileSymbolIndex;
    symbolFadeChange: number;
    debugOverlayTexture: Texture;
    debugOverlayCanvas: HTMLCanvasElement;
    terrainFacilitator: {depthDirty: boolean; coordsDirty: boolean; matrix: mat4; renderTime: number};

    constructor(gl: WebGL2RenderingContext, transform: IReadonlyTransform) {
        this.drawFunctions = webglDrawFunctions;
        this.context = new Context(gl);
        this.transform = transform;
        this.layerOpacityFbo = null;
        this.compositeGroupFbo = null;
        this.compositeGroupTexture = null;
        this.compositeMaskFbo = null;
        this.compositeMaskTexture = null;
        this._tileTextures = {};
        this._rttObjectRecyclePool = [];
        this._rttSharedFbo = null;
        this.terrainFacilitator = {depthDirty: true, coordsDirty: false, matrix: mat4.identity(new Float64Array(16)), renderTime: 0};

        this.setup();

        this.numSublayers = TileManager.maxOverzooming + TileManager.maxUnderzooming + 1;
        this.depthEpsilon = 1 / Math.pow(2, 16);

        this.crossTileSymbolIndex = new CrossTileSymbolIndex();
    }

    resize(width: number, height: number, pixelRatio: number): void {
        this.width = Math.floor(width * pixelRatio);
        this.height = Math.floor(height * pixelRatio);
        this.pixelRatio = pixelRatio;
        this.context.viewport.set([0, 0, this.width, this.height]);

        if (this.style) {
            for (const layerId of this.style._order) {
                this.style._layers[layerId].resize();
            }
        }
    }

    setup(): void {
        const context = this.context;

        const tileExtentArray = new PosArray();
        tileExtentArray.emplaceBack(0, 0);
        tileExtentArray.emplaceBack(EXTENT, 0);
        tileExtentArray.emplaceBack(0, EXTENT);
        tileExtentArray.emplaceBack(EXTENT, EXTENT);
        this.tileExtentBuffer = context.createVertexBuffer(tileExtentArray, posAttributes.members);
        this.tileExtentSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const debugArray = new PosArray();
        debugArray.emplaceBack(0, 0);
        debugArray.emplaceBack(EXTENT, 0);
        debugArray.emplaceBack(0, EXTENT);
        debugArray.emplaceBack(EXTENT, EXTENT);
        this.debugBuffer = context.createVertexBuffer(debugArray, posAttributes.members);
        this.debugSegments = SegmentVector.simpleSegment(0, 0, 4, 5);

        const rasterBoundsArray = new RasterBoundsArray();
        rasterBoundsArray.emplaceBack(0, 0, 0, 0);
        rasterBoundsArray.emplaceBack(EXTENT, 0, EXTENT, 0);
        rasterBoundsArray.emplaceBack(0, EXTENT, 0, EXTENT);
        rasterBoundsArray.emplaceBack(EXTENT, EXTENT, EXTENT, EXTENT);
        this.rasterBoundsBuffer = context.createVertexBuffer(rasterBoundsArray, rasterBoundsAttributes.members);
        this.rasterBoundsSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const rasterBoundsArrayPosOnly = new PosArray();
        rasterBoundsArrayPosOnly.emplaceBack(0, 0);
        rasterBoundsArrayPosOnly.emplaceBack(EXTENT, 0);
        rasterBoundsArrayPosOnly.emplaceBack(0, EXTENT);
        rasterBoundsArrayPosOnly.emplaceBack(EXTENT, EXTENT);
        this.rasterBoundsBufferPosOnly = context.createVertexBuffer(rasterBoundsArrayPosOnly, posAttributes.members);
        this.rasterBoundsSegmentsPosOnly = SegmentVector.simpleSegment(0, 0, 4, 5);

        const viewportArray = new PosArray();
        viewportArray.emplaceBack(0, 0);
        viewportArray.emplaceBack(1, 0);
        viewportArray.emplaceBack(0, 1);
        viewportArray.emplaceBack(1, 1);
        this.viewportBuffer = context.createVertexBuffer(viewportArray, posAttributes.members);
        this.viewportSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const tileLineStripIndices = new LineStripIndexArray();
        tileLineStripIndices.emplaceBack(0);
        tileLineStripIndices.emplaceBack(1);
        tileLineStripIndices.emplaceBack(3);
        tileLineStripIndices.emplaceBack(2);
        tileLineStripIndices.emplaceBack(0);
        this.tileBorderIndexBuffer = context.createIndexBuffer(tileLineStripIndices);

        const quadTriangleIndices = new TriangleIndexArray();
        quadTriangleIndices.emplaceBack(1, 0, 2);
        quadTriangleIndices.emplaceBack(1, 2, 3);
        this.quadTriangleIndexBuffer = context.createIndexBuffer(quadTriangleIndices);

        const gl = this.context.gl;
        this.stencilClearMode = new StencilMode({func: gl.ALWAYS, mask: 0}, 0x0, 0xFF, gl.ZERO, gl.ZERO, gl.ZERO);

        this.tileExtentMesh = new Mesh(this.tileExtentBuffer, this.quadTriangleIndexBuffer, this.tileExtentSegments);
    }

    clearStencil(): void {
        const context = this.context;
        const gl = context.gl;

        this.nextStencilID = 1;
        this.currentStencilSource = undefined;

        const matrix = mat4.create();
        mat4.ortho(matrix, 0, this.width, this.height, 0, 0, 1);
        mat4.scale(matrix, matrix, [gl.drawingBufferWidth, gl.drawingBufferHeight, 0]);

        const projectionData: ProjectionData = {
            mainMatrix: matrix,
            tileMercatorCoords: [0, 0, 1, 1],
            clippingPlane: [0, 0, 0, 0],
            projectionTransition: 0.0,
            fallbackMatrix: matrix,
        };

        this.useProgram('clippingMask', null, true).draw(context, gl.TRIANGLES,
            DepthMode.disabled, this.stencilClearMode, ColorMode.disabled, CullFaceMode.disabled,
            null, null, projectionData,
            '$clipping', this.viewportBuffer,
            this.quadTriangleIndexBuffer, this.viewportSegments);
    }

    renderTileClippingMasks(layer: StyleLayer, tileIDs: OverscaledTileID[], renderToTexture: boolean): void {
        if (this.currentStencilSource === layer.source || !layer.isTileClipped() || !tileIDs?.length) {
            return;
        }

        this.currentStencilSource = layer.source;

        if (this.nextStencilID + tileIDs.length > 256) {
            this.clearStencil();
        }

        const context = this.context;
        context.setColorMode(ColorMode.disabled);
        context.setDepthMode(DepthMode.disabled);

        const stencilRefs = {};

        for (const tileID of tileIDs) {
            stencilRefs[tileID.key] = this.nextStencilID++;
        }

        this._renderTileMasks(stencilRefs, tileIDs, renderToTexture, true);
        this._renderTileMasks(stencilRefs, tileIDs, renderToTexture, false);

        this._tileClippingMaskIDs = stencilRefs;
    }

    _renderTileMasks(tileStencilRefs: {[_: string]: number}, tileIDs: OverscaledTileID[], renderToTexture: boolean, useBorders: boolean): void {
        const context = this.context;
        const gl = context.gl;
        const projection = this.style.projection;
        const transform = this.transform;

        const program = this.useProgram('clippingMask');

        for (const tileID of tileIDs) {
            const stencilRef = tileStencilRefs[tileID.key];
            const terrainData = this.getTerrainDataForTile(tileID, renderToTexture);

            const mesh = projection.getMeshFromTileID(this.context, tileID.canonical, useBorders, true, 'stencil');

            const projectionData = transform.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: !renderToTexture, applyTerrainMatrix: true});

            program.draw(context, gl.TRIANGLES, DepthMode.disabled,
                new StencilMode({func: gl.ALWAYS, mask: 0}, stencilRef, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE),
                ColorMode.disabled, renderToTexture ? CullFaceMode.disabled : CullFaceMode.backCCW, null,
                terrainData, projectionData, '$clipping', mesh.vertexBuffer,
                mesh.indexBuffer, mesh.segments);
        }
    }

    getTerrainDataForTile(tileID: OverscaledTileID, isRenderingToTexture: boolean): TerrainData | null {
        if (isRenderingToTexture && this.style.projection?.name === 'mercator') return null;
        return this.style.map.terrain?.getTerrainData(tileID) || null;
    }

    _renderTilesDepthBuffer(): void {
        const context = this.context;
        const gl = context.gl;
        const projection = this.style.projection;
        const transform = this.transform;

        const program = this.useProgram('depth');
        const depthMode = this.getDepthModeFor3D();
        const tileIDs = coveringTiles(transform, {tileSize: transform.tileSize});

        for (const tileID of tileIDs) {
            const terrainData = this.style.map.terrain?.getTerrainData(tileID);
            const mesh = projection.getMeshFromTileID(this.context, tileID.canonical, true, true, 'raster');

            const projectionData = transform.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: true, applyTerrainMatrix: true});

            program.draw(context, gl.TRIANGLES, depthMode, StencilMode.disabled,
                ColorMode.disabled, CullFaceMode.backCCW, null,
                terrainData, projectionData, '$clipping', mesh.vertexBuffer,
                mesh.indexBuffer, mesh.segments);
        }
    }

    stencilModeFor3D(): StencilMode {
        this.currentStencilSource = undefined;

        if (this.nextStencilID + 1 > 256) {
            this.clearStencil();
        }

        const id = this.nextStencilID++;
        const gl = this.context.gl;
        return new StencilMode({func: gl.NOTEQUAL, mask: 0xFF}, id, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
    }

    stencilModeForClipping(tileID: OverscaledTileID): StencilMode {
        const gl = this.context.gl;
        return new StencilMode({func: gl.EQUAL, mask: 0xFF}, this._tileClippingMaskIDs[tileID.key], 0x00, gl.KEEP, gl.KEEP, gl.REPLACE);
    }

    getStencilConfigForOverlapAndUpdateStencilID(tileIDs: OverscaledTileID[]): [{
        [_: number]: Readonly<StencilMode>;
    }, OverscaledTileID[]] {
        const gl = this.context.gl;
        const coords = tileIDs.sort((a, b) => b.overscaledZ - a.overscaledZ);
        const minTileZ = coords[coords.length - 1].overscaledZ;
        const stencilValues = coords[0].overscaledZ - minTileZ + 1;
        if (stencilValues > 1) {
            this.currentStencilSource = undefined;
            if (this.nextStencilID + stencilValues > 256) {
                this.clearStencil();
            }
            const zToStencilMode = {};
            for (let i = 0; i < stencilValues; i++) {
                zToStencilMode[i + minTileZ] = new StencilMode({func: gl.GEQUAL, mask: 0xFF}, i + this.nextStencilID, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
            }
            this.nextStencilID += stencilValues;
            return [zToStencilMode, coords];
        }
        return [{[minTileZ]: StencilMode.disabled}, coords];
    }

    stencilConfigForOverlapTwoPass(tileIDs: OverscaledTileID[]): [
        { [_: number]: Readonly<StencilMode> },
        { [_: number]: Readonly<StencilMode> },
        OverscaledTileID[]
    ] {
        const gl = this.context.gl;
        const coords = tileIDs.sort((a, b) => b.overscaledZ - a.overscaledZ);
        const minTileZ = coords[coords.length - 1].overscaledZ;
        const stencilValues = coords[0].overscaledZ - minTileZ + 1;

        this.clearStencil();

        if (stencilValues > 1) {
            const zToStencilModeHigh = {};
            const zToStencilModeLow = {};
            for (let i = 0; i < stencilValues; i++) {
                zToStencilModeHigh[i + minTileZ] = new StencilMode({func: gl.GREATER, mask: 0xFF}, stencilValues + 1 + i, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
                zToStencilModeLow[i + minTileZ] = new StencilMode({func: gl.GREATER, mask: 0xFF}, 1 + i, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
            }
            this.nextStencilID = stencilValues * 2 + 1;
            return [
                zToStencilModeHigh,
                zToStencilModeLow,
                coords
            ];
        } else {
            this.nextStencilID = 3;
            return [
                {[minTileZ]: new StencilMode({func: gl.GREATER, mask: 0xFF}, 2, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE)},
                {[minTileZ]: new StencilMode({func: gl.GREATER, mask: 0xFF}, 1, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE)},
                coords
            ];
        }
    }

    colorModeForRenderPass(): Readonly<ColorMode> {
        const gl = this.context.gl;
        if (this._showOverdrawInspector) {
            const numOverdrawSteps = 8;
            const a = 1 / numOverdrawSteps;

            return new ColorMode([gl.CONSTANT_COLOR, gl.ONE], new Color(a, a, a, 0), [true, true, true, true]);
        } else if (this.renderPass === 'opaque') {
            return ColorMode.unblended;
        } else {
            return ColorMode.alphaBlended;
        }
    }

    getDepthModeForSublayer(n: number, mask: DepthMaskType, func?: DepthFuncType | null): Readonly<DepthMode> {
        if (!this.opaquePassEnabledForLayer()) return DepthMode.disabled;
        const depth = 1 - ((1 + this.currentLayer) * this.numSublayers + n) * this.depthEpsilon;
        return new DepthMode(func || this.context.gl.LEQUAL, mask, [depth, depth]);
    }

    getDepthModeFor3D(): Readonly<DepthMode> {
        return new DepthMode(this.context.gl.LEQUAL, DepthMode.ReadWrite, this.depthRangeFor3D);
    }

    opaquePassEnabledForLayer(): boolean {
        return this.currentLayer < this.opaquePassCutoff;
    }

    render(style: Style, options: PainterOptions): void {
        this.style = style;
        this.options = options;

        this.lineAtlas = style.lineAtlas;
        this.imageManager = style.imageManager;
        this.glyphManager = style.glyphManager;

        this.symbolFadeChange = style.placement.symbolFadeChange(now());

        this.imageManager.beginFrame();

        const layerIds = this.style._order;
        const tileManagers = this.style.tileManagers;

        const coordsAscending: {[_: string]: OverscaledTileID[]} = {};
        const coordsDescending: {[_: string]: OverscaledTileID[]} = {};
        const coordsDescendingSymbol: {[_: string]: OverscaledTileID[]} = {};
        const renderOptions: RenderOptions = {isRenderingToTexture: false, isRenderingGlobe: style.projection?.transitionState > 0};

        for (const id in tileManagers) {
            const tileManager = tileManagers[id];
            if (tileManager.used) {
                tileManager.prepare(this.context);
            }

            coordsAscending[id] = tileManager.getVisibleCoordinates(false);
            coordsDescending[id] = coordsAscending[id].slice().reverse();
            coordsDescendingSymbol[id] = tileManager.getVisibleCoordinates(true).reverse();
        }

        this.opaquePassCutoff = Infinity;
        for (let i = 0; i < layerIds.length; i++) {
            const layerId = layerIds[i];
            if (this.style._layers[layerId].is3D()) {
                this.opaquePassCutoff = i;
                break;
            }
        }

        this.maybeDrawDepth(false);

        if (this.renderToTexture) {
            this.renderToTexture.prepareForRender(this.style, this.transform.zoom);
            this.opaquePassCutoff = 0;
        }

        this.renderPass = 'offscreen';

        for (const layerId of layerIds) {
            const layer = this.style._layers[layerId];
            if (!layer.hasOffscreenPass() || layer.isHidden(this.transform.zoom)) continue;

            const coords = coordsDescending[layer.source];
            if (layer.type !== 'custom' && !coords.length) continue;

            this.renderLayer(this, tileManagers[layer.source], layer, coords, renderOptions);
        }

        this.style.projection?.updateGPUdependent({
            context: this.context,
            useProgram: (name: string) => this.useProgram(name)
        });

        this.context.viewport.set([0, 0, this.width, this.height]);
        this.context.bindFramebuffer.set(null);

        this.context.clear({color: options.showOverdrawInspector ? Color.black : Color.transparent, depth: 1});
        this.clearStencil();

        if (this.style.sky) this.drawFunctions.sky(this, this.style.sky);

        this._showOverdrawInspector = options.showOverdrawInspector;
        this.depthRangeFor3D = [0, 1 - ((style._order.length + 2) * this.numSublayers * this.depthEpsilon)];

        if (!this.renderToTexture) {
            this.renderPass = 'opaque';

            for (this.currentLayer = layerIds.length - 1; this.currentLayer >= 0; this.currentLayer--) {
                const layer = this.style._layers[layerIds[this.currentLayer]];

                if (layer.compositeGroup) continue;

                const tileManager = tileManagers[layer.source];
                const coords = coordsAscending[layer.source];

                this.renderTileClippingMasks(layer, coords, false);
                this.renderLayer(this, tileManager, layer, coords, renderOptions);
            }
        }

        this.renderPass = 'translucent';

        let globeDepthRendered = false;
        const renderedGroups = new Set<string>();

        // --- OPTIMIZATION: Precompute Composite Groups Once Per Frame ---
        const compositeGroups: {[_: string]: {layers: StyleLayer[], indices: number[]}} = {};
        for (let j = 0; j < layerIds.length; j++) {
            const l = this.style._layers[layerIds[j]];
            if (l.compositeGroup) {
                compositeGroups[l.compositeGroup] ||= {layers: [], indices: []};
                compositeGroups[l.compositeGroup].layers.push(l);
                compositeGroups[l.compositeGroup].indices.push(j);
            }
        }

        for (this.currentLayer = 0; this.currentLayer < layerIds.length; this.currentLayer++) {
            const layer = this.style._layers[layerIds[this.currentLayer]];
            const tileManager = tileManagers[layer.source];

            if (this.renderToTexture?.renderLayer(layer, renderOptions)) continue;

            if (!this.opaquePassEnabledForLayer() && !globeDepthRendered) {
                globeDepthRendered = true;
                if (renderOptions.isRenderingGlobe && !this.style.map.terrain) {
                    this._renderTilesDepthBuffer();
                }
            }

            if (layer.compositeGroup) {
                if (renderedGroups.has(layer.compositeGroup)) {
                    continue;
                }

                const group = compositeGroups[layer.compositeGroup];
                this.renderCompositeGroup(
                    group.layers, 
                    group.indices, 
                    renderOptions, 
                    coordsAscending, 
                    coordsDescending, 
                    coordsDescendingSymbol
                );
                renderedGroups.add(layer.compositeGroup);
                continue;
            }

            const coords = (layer.type === 'symbol' ? coordsDescendingSymbol : coordsDescending)[layer.source];

            this.renderTileClippingMasks(layer, coordsAscending[layer.source], !!this.renderToTexture);
            this.renderLayer(this, tileManager, layer, coords, renderOptions);
        }

        if (renderOptions.isRenderingGlobe) {
            this.drawFunctions.atmosphere(this, this.style.sky, this.style.light);
        }

        if (this.options.showTileBoundaries) {
            const selectedSource = selectDebugSource(this.style, this.transform.zoom);
            if (selectedSource) {
                this.drawFunctions.debug(this, selectedSource, selectedSource.getVisibleCoordinates());
            }
        }

        if (this.options.showPadding) {
            this.drawFunctions.debugPadding(this);
        }

        this.context.setDefault();
    }

    maybeDrawDepth(requireExact: boolean): void {
        if (!this.style?.map?.terrain) {
            return;
        }
        const prevMatrix = this.terrainFacilitator.matrix;
        const currMatrix = this.transform.modelViewProjectionMatrix;

        let doUpdate = this.terrainFacilitator.depthDirty;
        doUpdate ||= requireExact ? !mat4.exactEquals(prevMatrix, currMatrix) : !mat4.equals(prevMatrix, currMatrix);
        doUpdate ||= this.style.map.terrain.tileManager.anyTilesAfterTime(this.terrainFacilitator.renderTime);

        if (!doUpdate) {
            return;
        }

        mat4.copy(prevMatrix, currMatrix);
        this.terrainFacilitator.renderTime = now();
        this.terrainFacilitator.depthDirty = false;
        this.terrainFacilitator.coordsDirty = true;
        this.drawFunctions.terrainDepth(this, this.style.map.terrain);
    }

    maybeDrawCoords(): void {
        if (!this.style?.map?.terrain || !this.terrainFacilitator.coordsDirty) {
            return;
        }
        this.terrainFacilitator.coordsDirty = false;
        this.drawFunctions.terrainCoords(this, this.style.map.terrain);
    }

    renderLayer(painter: Painter, tileManager: TileManager, layer: StyleLayer, coords: OverscaledTileID[], renderOptions: RenderOptions): void {
        if (layer.isHidden(this.transform.zoom)) return;
        if (layer.type !== 'background' && layer.type !== 'custom' && !(coords || []).length) return;
        this.id = layer.id;

        const draw = this.drawFunctions;
        if (isSymbolStyleLayer(layer)) {
            draw.symbol(painter, tileManager, layer, coords, this.style.placement.variableOffsets, renderOptions);
        } else if (isCircleStyleLayer(layer)) {
            draw.circle(painter, tileManager, layer, coords, renderOptions);
        } else if (isHeatmapStyleLayer(layer)) {
            draw.heatmap(painter, tileManager, layer, coords, renderOptions);
        } else if (isLineStyleLayer(layer)) {
            draw.line(painter, tileManager, layer, coords, renderOptions);
        } else if (isFillStyleLayer(layer)) {
            draw.fill(painter, tileManager, layer, coords, renderOptions);
        } else if (isFillExtrusionStyleLayer(layer)) {
            draw.fillExtrusion(painter, tileManager, layer, coords, renderOptions);
        } else if (isHillshadeStyleLayer(layer)) {
            draw.hillshade(painter, tileManager, layer, coords, renderOptions);
        } else if (isColorReliefStyleLayer(layer)) {
            draw.colorRelief(painter, tileManager, layer, coords, renderOptions);
        } else if (isRasterStyleLayer(layer)) {
            draw.raster(painter, tileManager, layer, coords, renderOptions);
        } else if (isBackgroundStyleLayer(layer)) {
            draw.background(painter, tileManager, layer, coords, renderOptions);
        } else if (isCustomStyleLayer(layer)) {
            draw.custom(painter, tileManager, layer, renderOptions);
        }
    }

    renderCompositeGroup(
        layers: StyleLayer[],
        layerIndices: number[],
        renderOptions: RenderOptions,
        coordsAscending: {[_: string]: OverscaledTileID[]},
        coordsDescending: {[_: string]: OverscaledTileID[]},
        coordsDescendingSymbol: {[_: string]: OverscaledTileID[]}
    ): void {
        const tileManagers = this.style.tileManagers;
        const gl = this.context.gl;

        const prevFbo = this.context.bindFramebuffer.get();

        // 1. Partition layers immediately to avoid re-evaluating getBlendMode() / compositeMask repeatedly.
        const maskLayers: StyleLayer[] = [];
        const maskLayerIndices: number[] = [];
        const contentLayers: StyleLayer[] = [];
        const contentLayerIndices: number[] = [];

        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            const isMask = layer.compositeMask || layer.getBlendMode() === 'mask';
            if (isMask) {
                maskLayers.push(layer);
                maskLayerIndices.push(layerIndices[i]);
            } else {
                contentLayers.push(layer);
                contentLayerIndices.push(layerIndices[i]);
            }
        }

        const hasMask = maskLayers.length > 0;

        // Setup only the necessary offscreen scratch FBOs on-demand
        this.prepareCompositeGroupFbo(hasMask);

        const originalRenderPass = this.renderPass;
        const originalCurrentLayer = this.currentLayer;

        // --- PASS 1: DRAW MASK LAYERS (Skipped entirely if there is no mask) ---
        if (hasMask) {
            this.context.bindFramebuffer.set(this.compositeMaskFbo.framebuffer);
            this.context.clear({
                color: Color.transparent,
                depth: 1.0,
                stencil: 0
            });

            this.currentStencilSource = undefined;

            for (let i = 0; i < maskLayers.length; i++) {
                const layer = maskLayers[i];
                this.currentLayer = maskLayerIndices[i];

                // Fast O(1) cached coordinate lookups
                const coordsAsc = coordsAscending[layer.source] || [];
                const coords = (layer.type === 'symbol' ? coordsDescendingSymbol[layer.source] : coordsDescending[layer.source]) || [];

                this.renderTileClippingMasks(layer, coordsAsc, false);

                // Use the layer's actual blend mode (or fallback to 'normal' if the blend mode is 'mask')
                const blendMode = layer.getBlendMode();
                const actualBlendMode = (blendMode === 'mask') ? 'normal' : blendMode;
                this.context.setBlendMode(actualBlendMode);
                
                this.renderPass = 'opaque';
                this.renderLayer(this, tileManagers[layer.source], layer, coords, renderOptions);

                this.renderPass = 'translucent';
                this.renderLayer(this, tileManagers[layer.source], layer, coords, renderOptions);
            }
        }

        // --- PASS 2: DRAW CONTENT LAYERS ---
        this.context.bindFramebuffer.set(this.compositeGroupFbo.framebuffer);
        this.context.clear({
            color: Color.transparent,
            depth: 1.0,
            stencil: 0
        });

        this.currentStencilSource = undefined;

        for (let i = 0; i < contentLayers.length; i++) {
            const layer = contentLayers[i];
            this.currentLayer = contentLayerIndices[i];

            // Fast O(1) cached coordinate lookups
            const coordsAsc = coordsAscending[layer.source] || [];
            const coords = (layer.type === 'symbol' ? coordsDescendingSymbol[layer.source] : coordsDescending[layer.source]) || [];

            this.renderTileClippingMasks(layer, coordsAsc, false);

            const blendMode = layer.getBlendMode();
            this.context.setBlendMode(blendMode);

            this.renderPass = 'opaque';
            this.renderLayer(this, tileManagers[layer.source], layer, coords, renderOptions);

            this.renderPass = 'translucent';
            this.renderLayer(this, tileManagers[layer.source], layer, coords, renderOptions);
        }

        // --- PASS 3: COMPOSITE / CLIP THE GROUP (Skipped if there is no mask) ---
        if (hasMask) {
            this.context.bindFramebuffer.set(this.compositeGroupFbo.framebuffer);
            this.context.setBlendMode('destination-in');
            this.drawCompositeTextureToScreen(this.compositeMaskFbo.colorAttachment.get());
        }

        this.currentLayer = originalCurrentLayer;
        this.renderPass = originalRenderPass;

        this.context.bindFramebuffer.set(prevFbo);
        this.currentStencilSource = undefined;

        this.context.setBlendMode('normal');
        this.drawCompositeTextureToScreen(this.compositeGroupFbo.colorAttachment.get());
    }

    prepareCompositeGroupFbo(hasMask: boolean): void {
        const width = this.width;
        const height = this.height;
        const gl = this.context.gl;

        // 1. Content FBO is always needed
        if (!this.compositeGroupFbo) {
            this.compositeGroupFbo = this.context.createFramebuffer(width, height, true, true);

            this.compositeGroupTexture = new Texture(this.context, {width, height, data: null}, gl.RGBA);
            this.compositeGroupTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            this.compositeGroupFbo.colorAttachment.set(this.compositeGroupTexture.texture);

            const depthRenderbuffer = this.context.createRenderbuffer(gl.DEPTH_STENCIL, width, height);
            this.compositeGroupFbo.depthAttachment.set(depthRenderbuffer);
        } else if (this.compositeGroupFbo.width !== width || this.compositeGroupFbo.height !== height) {
            this.compositeGroupFbo.destroy();
            this.compositeGroupTexture.destroy();

            this.compositeGroupFbo = this.context.createFramebuffer(width, height, true, true);

            this.compositeGroupTexture = new Texture(this.context, {width, height, data: null}, gl.RGBA);
            this.compositeGroupTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            this.compositeGroupFbo.colorAttachment.set(this.compositeGroupTexture.texture);

            const depthRenderbuffer = this.context.createRenderbuffer(gl.DEPTH_STENCIL, width, height);
            this.compositeGroupFbo.depthAttachment.set(depthRenderbuffer);
        }

        // 2. Mask FBO is allocated and resized ONLY if a mask is active in the group
        if (hasMask) {
            if (!this.compositeMaskFbo) {
                this.compositeMaskFbo = this.context.createFramebuffer(width, height, true, true);

                this.compositeMaskTexture = new Texture(this.context, {width, height, data: null}, gl.RGBA);
                this.compositeMaskTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
                this.compositeMaskFbo.colorAttachment.set(this.compositeMaskTexture.texture);

                const depthRenderbuffer = this.context.createRenderbuffer(gl.DEPTH_STENCIL, width, height);
                this.compositeMaskFbo.depthAttachment.set(depthRenderbuffer);
            } else if (this.compositeMaskFbo.width !== width || this.compositeMaskFbo.height !== height) {
                this.compositeMaskFbo.destroy();
                this.compositeMaskTexture.destroy();

                this.compositeMaskFbo = this.context.createFramebuffer(width, height, true, true);

                this.compositeMaskTexture = new Texture(this.context, {width, height, data: null}, gl.RGBA);
                this.compositeMaskTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
                this.compositeMaskFbo.colorAttachment.set(this.compositeMaskTexture.texture);

                const depthRenderbuffer = this.context.createRenderbuffer(gl.DEPTH_STENCIL, width, height);
                this.compositeMaskFbo.depthAttachment.set(depthRenderbuffer);
            }
        }
    }

    drawCompositeTextureToScreen(texture: WebGLTexture): void {
        const context = this.context;
        const gl = context.gl;

        const matrix = mat4.create();
        mat4.ortho(matrix, 0, EXTENT, 0, EXTENT, 0, 1);

        const projectionData: ProjectionData = {
            mainMatrix: matrix,
            tileMercatorCoords: [0, 0, 1, 1],
            clippingPlane: [0, 0, 0, 0],
            projectionTransition: 0.0,
            fallbackMatrix: matrix,
        };

        const program = this.useProgram('raster', null, true);

        context.activeTexture.set(gl.TEXTURE0);
        context.bindTexture.set(texture);

        const uniformValues = {
            'u_tl_parent': [0.0, 0.0],
            'u_scale_parent': 1.0,
            'u_buffer_scale': 1.0,
            'u_fade_t': 0.0,
            'u_opacity': 1.0,
            'u_image0': 0,
            'u_image1': 1,
            'u_brightness_low': 0.0,
            'u_brightness_high': 1.0,
            'u_saturation_factor': 0.0,
            'u_contrast_factor': 1.0,
            'u_spin_weights': [1.0, 0.0, 0.0],
            'u_coords_top': [0.0, 0.0, EXTENT, 0.0],
            'u_coords_bottom': [0.0, EXTENT, EXTENT, EXTENT]
        };

        program.draw(
            context,
            gl.TRIANGLES,
            DepthMode.disabled,
            StencilMode.disabled,
            ColorMode.alphaBlended,
            CullFaceMode.disabled,
            uniformValues,
            null,
            projectionData,
            '$clipping',
            this.rasterBoundsBuffer,
            this.quadTriangleIndexBuffer,
            this.rasterBoundsSegments
        );
    }

    static readonly MAX_TEXTURE_POOL_SIZE_PER_BUCKET = 50;

    saveTileTexture(texture: Texture): void {
        const textures = this._tileTextures[texture.size[0]];
        if (!textures) {
            this._tileTextures[texture.size[0]] = [texture];
        } else if (textures.length < Painter.MAX_TEXTURE_POOL_SIZE_PER_BUCKET) {
            textures.push(texture);
        } else {
            texture.destroy();
        }
    }

    getTileTexture(size: number): Texture {
        const textures = this._tileTextures[size];
        return textures && textures.length > 0 ? textures.pop() : null;
    }

    acquireRTT(size: number): RTTObject {
        const gl = this.context.gl;
        const obj = this._rttObjectRecyclePool.pop();
        if (obj) {
            if (obj.size !== size) {
                gl.bindTexture(gl.TEXTURE_2D, obj.texture.texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                obj.texture.size = [size, size];
                obj.size = size;
            }
            return obj;
        }
        const texture = new Texture(this.context, {width: size, height: size, data: null}, gl.RGBA);
        texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
        if (this.context.extTextureFilterAnisotropic) {
            gl.texParameterf(gl.TEXTURE_2D, this.context.extTextureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT, this.context.extTextureFilterAnisotropicMax);
        }
        return {texture, size};
    }

    bindRTT(obj: RTTObject): void {
        const gl = this.context.gl;
        const size = obj.size;

        if (!this._rttSharedFbo) {
            const fbo = this.context.createFramebuffer(size, size, true, true);
            const depthRenderbuffer = this.context.createRenderbuffer(gl.DEPTH_STENCIL, size, size);
            fbo.depthAttachment.set(depthRenderbuffer);
            this._rttSharedFbo = {fbo, depthRenderbuffer, size};
        }

        if (this._rttSharedFbo.size !== size) {
            this.context.bindRenderbuffer.set(this._rttSharedFbo.depthRenderbuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, size, size);
            this.context.bindRenderbuffer.set(null);
            this._rttSharedFbo.fbo.width = size;
            this._rttSharedFbo.fbo.height = size;
            this._rttSharedFbo.size = size;
        }

        this._rttSharedFbo.fbo.colorAttachment.set(obj.texture.texture);
        this.context.bindFramebuffer.set(this._rttSharedFbo.fbo.framebuffer);
    }

    releaseRTT(obj: RTTObject): void {
        this._rttObjectRecyclePool.push(obj);
    }

    isPatternMissing(image?: CrossFaded<ResolvedImage> | null): boolean {
        if (!image) return false;
        if (!image.from || !image.to) return true;
        const imagePosA = this.imageManager.getPattern(image.from.toString());
        const imagePosB = this.imageManager.getPattern(image.to.toString());
        return !imagePosA || !imagePosB;
    }

    useProgram(name: string, programConfiguration?: ProgramConfiguration | null, forceSimpleProjection: boolean = false, defines: string[] = []): Program<any> {
        this.cache ||= {};
        const useTerrain = !!this.style.map.terrain;

        const projection = this.style.projection;

        const projectionPrelude = forceSimpleProjection ? shaders.projectionMercator : projection.shaderPreludeCode;
        const projectionDefine = forceSimpleProjection ? MercatorShaderDefine : projection.shaderDefine;
        const projectionKey = `/${forceSimpleProjection ? MercatorShaderVariantKey : projection.shaderVariantName}`;

        const configurationKey = (programConfiguration ? programConfiguration.cacheKey : '');
        const overdrawKey = (this._showOverdrawInspector ? '/overdraw' : '');
        const terrainKey = (useTerrain ? '/terrain' : '');
        const definesKey = (defines ? `/${defines.join('/')}` : '');

        const key = name + configurationKey + projectionKey + overdrawKey + terrainKey + definesKey;

        this.cache[key] ||= new Program(
            this.context,
            shaders[name],
            programConfiguration,
            programUniforms[name],
            this._showOverdrawInspector,
            useTerrain,
            projectionPrelude,
            projectionDefine,
            defines
        );
        return this.cache[key];
    }

    setCustomLayerDefaults(): void {
        this.context.unbindVAO();

        this.context.cullFace.setDefault();
        this.context.activeTexture.setDefault();
        this.context.pixelStoreUnpack.setDefault();
        this.context.pixelStoreUnpackPremultiplyAlpha.setDefault();
        this.context.pixelStoreUnpackFlipY.setDefault();
    }

    setBaseState(): void {
        const gl = this.context.gl;
        this.context.cullFace.set(false);
        this.context.viewport.set([0, 0, this.width, this.height]);
        this.context.blendEquation.set(gl.FUNC_ADD);
    }

    initDebugOverlayCanvas(): void {
        if (this.debugOverlayCanvas == null) {
            this.debugOverlayCanvas = document.createElement('canvas');
            this.debugOverlayCanvas.width = 512;
            this.debugOverlayCanvas.height = 512;
            const gl = this.context.gl;
            this.debugOverlayTexture = new Texture(this.context, this.debugOverlayCanvas, gl.RGBA);
        }
    }

    destroy(): void {
        if (this._tileTextures) {
            for (const size in this._tileTextures) {
                const textures = this._tileTextures[size];
                if (textures) {
                    for (const texture of textures) {
                        texture.destroy();
                    }
                }
            }
            this._tileTextures = {};
        }

        for (const obj of this._rttObjectRecyclePool) {
            obj.texture.destroy();
        }
        this._rttObjectRecyclePool = [];

        if (this._rttSharedFbo) {
            this._rttSharedFbo.fbo.colorAttachment.set(null);
            this._rttSharedFbo.fbo.depthAttachment.set(null);
            const gl = this.context.gl;
            gl.deleteRenderbuffer(this._rttSharedFbo.depthRenderbuffer);
            gl.deleteFramebuffer(this._rttSharedFbo.fbo.framebuffer);
            this._rttSharedFbo = null;
        }

        this.layerOpacityFbo?.destroy();
        this.layerOpacityFbo = null;

        this.compositeGroupFbo?.destroy();
        this.compositeGroupFbo = null;

        if (this.compositeGroupTexture) {
            this.compositeGroupTexture.destroy();
            this.compositeGroupTexture = null;
        }

        this.compositeMaskFbo?.destroy();
        this.compositeMaskFbo = null;

        if (this.compositeMaskTexture) {
            this.compositeMaskTexture.destroy();
            this.compositeMaskTexture = null;
        }

        if (this.tileExtentBuffer) this.tileExtentBuffer.destroy();
        if (this.debugBuffer) this.debugBuffer.destroy();
        if (this.rasterBoundsBuffer) this.rasterBoundsBuffer.destroy();
        if (this.rasterBoundsBufferPosOnly) this.rasterBoundsBufferPosOnly.destroy();
        if (this.viewportBuffer) this.viewportBuffer.destroy();
        if (this.tileBorderIndexBuffer) this.tileBorderIndexBuffer.destroy();
        if (this.quadTriangleIndexBuffer) this.quadTriangleIndexBuffer.destroy();
        if (this.tileExtentMesh) this.tileExtentMesh.vertexBuffer?.destroy();
        if (this.tileExtentMesh) this.tileExtentMesh.indexBuffer?.destroy();

        if (this.debugOverlayTexture) {
            this.debugOverlayTexture.destroy();
        }

        if (this.cache) {
            for (const key in this.cache) {
                const program = this.cache[key];
                if (program?.program) {
                    this.context.gl.deleteProgram(program.program);
                }
            }
            this.cache = {};
        }

        if (this.context) {
            this.context.setDefault();
        }
    }

    overLimit(): boolean {
        const {drawingBufferWidth, drawingBufferHeight} = this.context.gl;
        return this.width !== drawingBufferWidth || this.height !== drawingBufferHeight;
    }
}