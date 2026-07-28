// js/export/screenshot.js - Screenshot capture and download
import { state } from '../state.js';
import { showStatus } from '../utils/helpers.js';
import { toggleCamera } from '../core/camera.js';
import { showScalebarConfirm } from '../annotation-tools/data.js';
import { drawViewportScalebar } from './scalebar.js';
import { captureAtSize } from './render-capture.js';

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

    // Target full image dimensions, in device pixels.
    const fullW = Math.round(rendererCanvas.width * scaleFactor);
    const fullH = Math.round(rendererCanvas.height * scaleFactor);

    // captureAtSize() renders in tiles no larger than the on-screen buffer, so
    // no GPU or browser canvas size limit is ever exceeded, and it keeps line
    // widths proportional to the exported image.
    const outputCanvas = captureAtSize(fullW, fullH);

    // Add scalebar
    if (includeScalebar && state.isOrthographic) {
        const effectiveDpr = currentPixelRatio * scaleFactor;
        drawViewportScalebar(outputCanvas, effectiveDpr);
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
