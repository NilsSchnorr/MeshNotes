// js/export/render-capture.js — off-screen rendering at arbitrary resolution
//
// Renders the current scene/camera into a canvas of an exact pixel size,
// tiling the render when the requested size exceeds the on-screen buffer so
// we never ask the GPU for a framebuffer larger than one already known to
// work. Shared by the screenshot export and the six-view plate.

import { state } from '../state.js';

/**
 * Overrides the `resolution` uniform on every LineMaterial in the scene and
 * returns a function that puts the previous values back.
 *
 * Line2/LineSegments2 express their width in the pixel units of this uniform,
 * which the app pins to the CSS viewport size. During a tiled render the
 * viewport is a single tile rather than the whole image, so leaving it alone
 * makes annotation and measurement lines come out thinner in proportion to the
 * exported image the higher the resolution goes. Scaling the resolution down by
 * the export's magnification keeps line thickness proportional instead.
 *
 * @param {number} x
 * @param {number} y
 * @returns {Function} restore callback
 */
export function applyLineResolution(x, y) {
    const saved = [];

    state.scene.traverse(obj => {
        const mats = Array.isArray(obj.material)
            ? obj.material
            : (obj.material ? [obj.material] : []);

        for (const m of mats) {
            if (m && m.isLineMaterial) {
                saved.push({ material: m, prev: m.resolution.clone() });
                m.resolution.set(x, y);
            }
        }
    });

    return () => saved.forEach(({ material, prev }) => material.resolution.copy(prev));
}

/**
 * Renders the current scene and camera into a new canvas of exactly
 * fullW x fullH device pixels.
 *
 * The camera's projection is untouched apart from setViewOffset while tiling —
 * callers are responsible for setting a frustum whose aspect matches the
 * requested pixel aspect, otherwise the result is stretched.
 *
 * @param {number} fullW
 * @param {number} fullH
 * @param {{transparent?: boolean}} [opts]
 * @returns {HTMLCanvasElement}
 */
export function captureAtSize(fullW, fullH, opts = {}) {
    const renderer = state.renderer;
    const rendererCanvas = renderer.domElement;

    const prevPixelRatio = renderer.getPixelRatio();
    const baseBufferW = rendererCanvas.width;
    const baseBufferH = rendererCanvas.height;

    // Logical (CSS pixel) size the renderer was last sized with. This is also
    // the unit LineMaterial.resolution is expressed in.
    const logicalW = baseBufferW / prevPixelRatio;
    const logicalH = baseBufferH / prevPixelRatio;

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(fullW));
    out.height = Math.max(1, Math.round(fullH));
    const ctx = out.getContext('2d');

    // Magnification of the export relative to the logical viewport.
    const sX = out.width / logicalW;
    const sY = out.height / logicalH;

    // Transparent capture: drop the scene background and clear with alpha 0.
    // Requires the renderer to have been created with alpha: true.
    let prevBackground;
    let prevClearAlpha;
    if (opts.transparent) {
        prevBackground = state.scene.background;
        prevClearAlpha = renderer.getClearAlpha();
        state.scene.background = null;
        renderer.setClearAlpha(0);
    }

    renderer.setPixelRatio(1);

    const tileW = baseBufferW;
    const tileH = baseBufferH;

    for (let tileY = 0; tileY < out.height; tileY += tileH) {
        for (let tileX = 0; tileX < out.width; tileX += tileW) {
            const w = Math.min(tileW, out.width - tileX);
            const h = Math.min(tileH, out.height - tileY);

            renderer.setSize(w, h, false);
            state.camera.setViewOffset(out.width, out.height, tileX, tileY, w, h);
            state.camera.updateProjectionMatrix();

            const restoreLines = applyLineResolution(w / sX, h / sY);
            renderer.render(state.scene, state.camera);
            restoreLines();

            ctx.drawImage(rendererCanvas, tileX, tileY);
        }
    }

    // Restore projection, renderer size and background.
    state.camera.clearViewOffset();
    state.camera.updateProjectionMatrix();

    // Logical size first (updates the renderer's internal width/height), then
    // the pixel ratio, which re-applies setSize with the right buffer.
    renderer.setSize(logicalW, logicalH, false);
    renderer.setPixelRatio(prevPixelRatio);

    if (opts.transparent) {
        state.scene.background = prevBackground;
        renderer.setClearAlpha(prevClearAlpha);
    }

    renderer.render(state.scene, state.camera);

    return out;
}
