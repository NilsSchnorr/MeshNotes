// js/export/view-state.js — "See what I see" scene snapshot
//
// Captures the parts of the current scene that carry analytical meaning
// (camera, lighting, model opacity, display mode, flip) so a per-annotation
// share link can restore the exact view the author was looking at.
//
// Deliberately excluded: background colour, mesh/wireframe colours, and
// point/text sizes. Those are the recipient's personal preferences and are
// never overwritten by a share link.
//
// Carried as a collection-level `meshnotes:viewState` extension inside the
// shared JSON-LD. Restored only when opening a share/direct link, never on a
// manual import — so importing a file mid-session never moves the camera.

import { state, dom } from '../state.js';
import { toggleCamera } from '../core/camera.js';
import { toggleFlip } from '../core/scene.js';
import { setBrightness, setModelOpacity, setLightAzimuth, setLightElevation, toggleLightMode } from '../core/lighting.js';
import { applyDisplayMode, updateTextureButtonLabel } from '../core/model-loader.js';
import { renderAnnotations } from '../annotation-tools/render.js';

// Bump only on a breaking change to the shape below. applyViewState() is
// deliberately forgiving: it applies the fields it recognises and ignores
// the rest, so older/newer readers degrade gracefully.
const VIEW_STATE_VERSION = 1;

const VALID_DISPLAY_MODES = ['texture', 'vertexColors', 'mesh', 'wireframe'];

/**
 * Snapshot the current analytical view.
 * @returns {Object} viewState object suitable for JSON serialisation
 */
export function captureViewState() {
    const cam = state.camera;
    return {
        version: VIEW_STATE_VERSION,
        camera: {
            orthographic: !!state.isOrthographic,
            position: [cam.position.x, cam.position.y, cam.position.z],
            target: [state.controls.target.x, state.controls.target.y, state.controls.target.z]
        },
        lighting: {
            followsCamera: !!state.lightFollowsCamera,
            azimuth: state.fixedLightAzimuth,
            elevation: state.fixedLightElevation,
            brightness: state.brightness
        },
        modelOpacity: state.modelOpacity,
        displayMode: state.displayMode,
        flipped: !!state.isFlipped
    };
}

/**
 * Restore a previously captured view. Safe to call after a fresh model load,
 * where state is at known defaults (perspective camera, un-flipped,
 * light-follows-camera). Applies model display first, then lighting, then the
 * camera last so the final controls.update() wins.
 *
 * @param {Object} vs - a viewState object from captureViewState()
 */
export function applyViewState(vs) {
    if (!vs || typeof vs !== 'object') return;

    // --- Display mode ---
    if (typeof vs.displayMode === 'string' && VALID_DISPLAY_MODES.includes(vs.displayMode)) {
        // Colours mode only makes sense if the model actually carries vertex
        // colours; otherwise fall back to plain mesh.
        let mode = vs.displayMode;
        if (mode === 'vertexColors' && !state.hasVertexColors) mode = 'mesh';
        if (mode !== state.displayMode) {
            state.displayMode = mode;
            applyDisplayMode();
            updateTextureButtonLabel();
        }
    }

    // --- Model opacity ---
    if (typeof vs.modelOpacity === 'number' && isFinite(vs.modelOpacity)) {
        const pct = Math.round(Math.max(0, Math.min(1, vs.modelOpacity)) * 100);
        if (dom.opacitySlider) dom.opacitySlider.value = pct;
        setModelOpacity(pct);
    }

    // --- Flip (visual only) ---
    if (typeof vs.flipped === 'boolean' && vs.flipped !== state.isFlipped) {
        toggleFlip();
    }

    // --- Lighting ---
    const L = vs.lighting || {};
    // Brightness first: toggleLightMode() below recomputes the directional
    // light from state.brightness, so it must already hold the restored value.
    if (typeof L.brightness === 'number' && isFinite(L.brightness)) {
        const b = Math.max(0, Math.min(300, L.brightness));
        if (dom.brightnessSlider) dom.brightnessSlider.value = b;
        setBrightness(b);
    }
    // Azimuth/elevation are stored now; they only drive the light once the
    // mode is fixed, which toggleLightMode() applies immediately after.
    if (typeof L.azimuth === 'number' && isFinite(L.azimuth)) {
        if (dom.lightAzimuthSlider) dom.lightAzimuthSlider.value = L.azimuth;
        setLightAzimuth(L.azimuth);
    }
    if (typeof L.elevation === 'number' && isFinite(L.elevation)) {
        if (dom.lightElevationSlider) dom.lightElevationSlider.value = L.elevation;
        setLightElevation(L.elevation);
    }
    if (typeof L.followsCamera === 'boolean' && L.followsCamera !== state.lightFollowsCamera) {
        toggleLightMode();
    }

    // --- Camera (last) ---
    const C = vs.camera || {};
    if (Array.isArray(C.target) && C.target.length === 3 && C.target.every(n => typeof n === 'number' && isFinite(n))) {
        state.controls.target.set(C.target[0], C.target[1], C.target[2]);
    }
    if (Array.isArray(C.position) && C.position.length === 3 && C.position.every(n => typeof n === 'number' && isFinite(n))) {
        state.camera.position.set(C.position[0], C.position[1], C.position[2]);
    }
    state.controls.update();
    // Switch projection after position/target are set so toggleCamera() copies
    // the correct pose and derives the orthographic frustum from the real
    // distance-to-target.
    if (typeof C.orthographic === 'boolean' && C.orthographic !== state.isOrthographic) {
        toggleCamera();
    }
    state.controls.update();

    // Flip / display changes can affect annotation rendering.
    renderAnnotations();
}
