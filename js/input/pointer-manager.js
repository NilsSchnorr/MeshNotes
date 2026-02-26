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

// Dynamic touch-action management
export function setCanvasTouchAction(allowNavigation) {
    if (!dom.canvas) return;
    if (allowNavigation) {
        // Allow browser to handle pan/zoom gestures
        dom.canvas.style.touchAction = 'pan-x pan-y pinch-zoom';
    } else {
        // Block all browser gestures (during annotation)
        dom.canvas.style.touchAction = 'none';
    }
}
