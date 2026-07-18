import {DepthMode} from '../depth_mode.ts';
import {StencilMode} from '../stencil_mode.ts';
import {CullFaceMode} from '../cull_face_mode.ts';
import {layerOpacityUniformValues} from '../program/layer_opacity_program.ts';
import {Color} from '@maplibre/maplibre-gl-style-spec';

import type {Painter} from '../../render/painter.ts';
import type {LineStyleLayer} from '../../style/style_layer/line_style_layer.ts';
import type {FillStyleLayer} from '../../style/style_layer/fill_style_layer.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';

export type PrepareDrawLayerOpacityResult = {
    compositeTarget: WebGLFramebuffer;
    compositeViewport: [number, number, number, number];
    originalCustomBlendMode: string | null;
};

/**
 * Partial line-layer-opacity
 * render the whole layer to a scratch FBO, then composite with `layerOpacity`.
 * Applies opacity uniformly to the layer instead of accumulating alpha across overlapping segments.
 */
export function prepareDrawLayerOpacity(painter: Painter, layer: LineStyleLayer | FillStyleLayer, coords: OverscaledTileID[], terrain: boolean): PrepareDrawLayerOpacityResult {
    const context = painter.context;
    const compositeTarget = context.bindFramebuffer.get();
    const compositeViewport = context.viewport.get();
    const [, , width, height] = compositeViewport;

    const originalCustomBlendMode = context._customBlendMode;
    context.setBlendMode('normal');

    bindLayerOpacity(painter, width, height);

    context.viewport.set([0, 0, width, height]);
    context.clear({color: Color.transparent, depth: 1, stencil: 0});

    painter.currentStencilSource = undefined;
    painter.renderTileClippingMasks(layer, coords, terrain);

    return {
        compositeTarget,
        compositeViewport,
        originalCustomBlendMode
    };
}

function bindLayerOpacity(painter: Painter, width: number, height: number): void {
    const gl = painter.context.gl;
    const context = painter.context;

    if (!painter.layerOpacityFbo) {
        const fbo = context.createFramebuffer(width, height, true, true);
        const texture = gl.createTexture();

        // Use the cache-safe binder to keep WebGL state tracking in sync
        context.bindTexture.set(texture);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        fbo.colorAttachment.set(texture);
        fbo.depthAttachment.set(context.createRenderbuffer(gl.DEPTH_STENCIL, width, height));
        painter.layerOpacityFbo = fbo;
        context.bindFramebuffer.set(painter.layerOpacityFbo.framebuffer);
        return;
    }
    if (painter.layerOpacityFbo.width === width && painter.layerOpacityFbo.height === height) {
        context.bindFramebuffer.set(painter.layerOpacityFbo.framebuffer);
        return;
    }
    const fbo = painter.layerOpacityFbo;

    // Use the cache-safe binder to keep WebGL state tracking in sync
    context.bindTexture.set(fbo.colorAttachment.get());

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    context.bindRenderbuffer.set(fbo.depthAttachment.get());
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, width, height);
    context.bindRenderbuffer.set(null);
    fbo.width = width;
    fbo.height = height;
    context.bindFramebuffer.set(fbo.framebuffer);
}

export function drawLayerOpacity(painter: Painter, opacity: number, prepareDrawLayerOpacityResult: PrepareDrawLayerOpacityResult, layer: LineStyleLayer | FillStyleLayer): void {
    const context = painter.context;
    const gl = context.gl;

    context.bindFramebuffer.set(prepareDrawLayerOpacityResult.compositeTarget);
    context.viewport.set(prepareDrawLayerOpacityResult.compositeViewport);

    context.activeTexture.set(gl.TEXTURE0);
    context.bindTexture.set(painter.layerOpacityFbo.colorAttachment.get());

    // Restore the original custom blend mode before we composite onto the target
    const originalBlendMode = prepareDrawLayerOpacityResult.originalCustomBlendMode || 'normal';
    context.setBlendMode(originalBlendMode);

    painter.useProgram('layerOpacity').draw(context, gl.TRIANGLES,
        DepthMode.disabled, StencilMode.disabled, painter.colorModeForRenderPass(), CullFaceMode.disabled,
        layerOpacityUniformValues(opacity, 0), null, null,
        layer.id, painter.viewportBuffer, painter.quadTriangleIndexBuffer,
        painter.viewportSegments, layer.paint, painter.transform.zoom);

    // Reset context blending back to normal to prevent pipeline bleeding
    context.setBlendMode('normal');

    // Clear texture binding cache to safeguard other layers ---
    context.activeTexture.set(gl.TEXTURE0);
    context.bindTexture.set(null);

    // Clipping masks were drawn into the scratch FBO's stencil buffer, not the composite target's.
    // Reset currentStencilSource so a later layer on the same source redraws its masks into the composite target instead of reusing stale ones.
    painter.currentStencilSource = undefined;
}
