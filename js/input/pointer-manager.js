// js/input/pointer-manager.js
// Pointer type detection utilities for tablet/stylus support
import { dom } from '../state.js';

export const PointerManager = {
    // Input type detection
    isPencil: (event) => event.pointerType === 'pen',
    isFinger: (event) => event.pointerType === 'touch',
    isMouse: (event) => event.pointerType === 'mouse',

    // Pressure for future brush dynamics (0-1, pen only)
    getPressure: (event) => event.pressure || 0.5,
};

// Track if we're on a touch device
export function isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * Set touch-action on the canvas.
 * MUST always be 'none' so that OrbitControls receives all pointer events.
 * If the browser handles pan/pinch natively (touch-action: pan-x pan-y),
 * it fires pointercancel which kills OrbitControls.
 */
export function initCanvasTouchAction() {
    if (!dom.canvas) return;
    dom.canvas.style.touchAction = 'none';
}
