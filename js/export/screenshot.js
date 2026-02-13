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
    state.renderer.render(state.scene, state.camera);

    // Create a copy of the canvas to draw scalebar on
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = dom.canvas.width;
    tempCanvas.height = dom.canvas.height;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(dom.canvas, 0, 0);

    // Draw scalebar if in orthographic mode
    if (includeScalebar && state.isOrthographic) {
        drawScalebarOnCanvas(tempCanvas);
    }

    const dataURL = tempCanvas.toDataURL('image/png');

    const link = document.createElement('a');
    link.download = `meshnotes-screenshot-${Date.now()}.png`;
    link.href = dataURL;
    link.click();

    showStatus('Screenshot saved');
}
