// js/export/screenshot.js - Screenshot capture and download
import { state, dom } from '../state.js';
import { showStatus } from '../utils/helpers.js';
import { toggleCamera } from '../core/camera.js';
import { showScalebarConfirm, drawScalebarOnCanvas } from '../annotation-tools/data.js';

export function takeScreenshot() {
    if (!state.isOrthographic) {
        // Show confirmation dialog for perspective mode
        showScalebarConfirm(
            () => {
                // User chose to switch to orthographic
                toggleCamera();
                setTimeout(() => {
                    captureScreenshot(true);
                }, 100);
            },
            () => {
                // User chose to continue without scalebar
                captureScreenshot(false);
            }
        );
    } else {
        captureScreenshot(true);
    }
}

export function captureScreenshot(includeScalebar) {
    const scaleFactor = state.screenshotQuality || 1;
    const currentPixelRatio = state.renderer.getPixelRatio();
    const rendererCanvas = state.renderer.domElement;

    // Current buffer dimensions (logical × pixelRatio)
    const baseBufferW = rendererCanvas.width;
    const baseBufferH = rendererCanvas.height;

    // Original logical dimensions (what setSize was originally called with)
    const logicalW = baseBufferW / currentPixelRatio;
    const logicalH = baseBufferH / currentPixelRatio;

    // Target full image dimensions
    const fullW = Math.round(baseBufferW * scaleFactor);
    const fullH = Math.round(baseBufferH * scaleFactor);

    let outputCanvas;

    if (scaleFactor <= 1) {
        // ---- Standard quality: simple capture ----
        state.renderer.render(state.scene, state.camera);
        outputCanvas = document.createElement('canvas');
        outputCanvas.width = baseBufferW;
        outputCanvas.height = baseBufferH;
        outputCanvas.getContext('2d').drawImage(rendererCanvas, 0, 0);

    } else {
        // ---- Tiled rendering ----
        // Render the high-res image in tiles, each at most the original
        // buffer size. This avoids hitting any GPU or browser canvas size
        // limits because the renderer canvas never grows beyond the size
        // that’s already working on screen.
        //
        // camera.setViewOffset() adjusts the projection matrix so each
        // render pass captures a different sub-rectangle of the full image.
        // The tiles are then stitched onto a regular 2D canvas (no size limit).
        outputCanvas = document.createElement('canvas');
        outputCanvas.width = fullW;
        outputCanvas.height = fullH;
        const ctx = outputCanvas.getContext('2d');

        // Tile size = original buffer (guaranteed to fit)
        const tileW = baseBufferW;
        const tileH = baseBufferH;

        // Switch to pixelRatio 1 for precise buffer control
        state.renderer.setPixelRatio(1);

        for (let tileY = 0; tileY < fullH; tileY += tileH) {
            for (let tileX = 0; tileX < fullW; tileX += tileW) {
                const w = Math.min(tileW, fullW - tileX);
                const h = Math.min(tileH, fullH - tileY);

                // Resize renderer to this tile (handles edge tiles that
                // may be smaller than a full tile)
                state.renderer.setSize(w, h, false);

                // Tell the camera to render only this tile’s region
                state.camera.setViewOffset(fullW, fullH, tileX, tileY, w, h);
                state.camera.updateProjectionMatrix();

                state.renderer.render(state.scene, state.camera);

                // Blit tile onto output canvas at the correct position
                ctx.drawImage(rendererCanvas, tileX, tileY);
            }
        }

        // Restore camera projection
        state.camera.clearViewOffset();
        state.camera.updateProjectionMatrix();

        // Restore renderer: set logical size first (updates internal _width/_height),
        // then pixel ratio (which internally calls setSize with the correct dimensions)
        state.renderer.setSize(logicalW, logicalH, false);
        state.renderer.setPixelRatio(currentPixelRatio);
    }

    // Re-render at original resolution so the viewport looks correct
    state.renderer.render(state.scene, state.camera);

    // Add scalebar
    if (includeScalebar && state.isOrthographic) {
        const effectiveDpr = currentPixelRatio * scaleFactor;
        drawScalebarOnCanvas(outputCanvas, effectiveDpr);
    }

    // Download
    downloadScreenshot(outputCanvas, scaleFactor);
}

/**
 * Triggers a PNG download of the given canvas.
 * Prefers canvas.toBlob (avoids base64 overhead for large images)
 * with a toDataURL fallback for older browsers.
 */
function downloadScreenshot(canvas, scaleFactor) {
    canvas.toBlob((blob) => {
        if (!blob) {
            const dataURL = canvas.toDataURL('image/png');
            const link = document.createElement('a');
            link.download = `meshnotes-screenshot-${Date.now()}.png`;
            link.href = dataURL;
            link.click();
        } else {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `meshnotes-screenshot-${Date.now()}.png`;
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        const qualityLabel = scaleFactor > 1 ? ` (${scaleFactor}×)` : '';
        showStatus(`Screenshot saved${qualityLabel}`);
    }, 'image/png');
}
