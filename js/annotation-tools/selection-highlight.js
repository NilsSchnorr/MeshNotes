// js/annotation-tools/selection-highlight.js — emphasise the selected annotation in 3D
//
// Selection is UI state, not data. Rather than re-running renderAnnotations()
// on every sidebar click (which disposes and rebuilds every annotation object,
// including surface meshes that walk faceData), this module mutates the
// materials of the objects that are already in the scene and remembers the
// previous values so it can put them back.
//
// Every object renderAnnotations() creates already carries
// userData.annotationId, which is the only hook needed here.
//
// The render loop in main.js runs continuously, so a mutated material shows up
// on the next frame with no explicit re-render call.
//
// Note on colour: white is deliberately NOT used. renderBoxAnnotation() already
// spends white on state.boxEditUnlocked ("this box is unlocked for editing"),
// so the selection emphasis brightens towards white instead of becoming white.

import * as THREE from 'three';
import { state } from '../state.js';

// Tuning constants, kept together so the look can be adjusted in one place.
const MARKER_SCALE = 1.5;          // point / vertex / box-handle spheres
const LINE_WIDTH = 6;              // Line2 linewidth (default is 3)
const SURFACE_OPACITY = 0.9;       // surface paint fill (default is 0.5 × groupOpacity)
const BOX_FILL_OPACITY = 0.45;     // box body fill (default is 0.25 × groupOpacity)
const BRIGHTEN = 0.35;             // how far to lerp a colour towards white

const _WHITE = new THREE.Color(0xffffff);

/**
 * Applies the highlight to every object belonging to state.selectedAnnotation
 * and restores every other object to its stored original state.
 *
 * Safe to call repeatedly — already-highlighted objects are skipped, and
 * objects with nothing stored are left alone.
 *
 * renderAnnotations() rebuilds the scene graph from scratch, so the stored
 * originals never survive a rebuild; that is why renderAnnotations() calls this
 * again at the end of its own pass.
 */
export function applySelectionHighlight() {
    if (!state.annotationObjects) return;

    const selectedId = state.selectedAnnotation;

    state.annotationObjects.children.forEach(obj => {
        // Measurement objects and anything else untagged is not ours.
        if (obj.userData.annotationId === undefined) return;

        if (obj.userData.annotationId === selectedId) {
            highlight(obj);
        } else {
            restore(obj);
        }
    });
}

/**
 * Clears every stored highlight without consulting the current selection.
 * Used when the scene is about to be torn down.
 */
export function clearSelectionHighlight() {
    if (!state.annotationObjects) return;
    state.annotationObjects.children.forEach(restore);
}

function highlight(obj) {
    // Already highlighted — the stored originals must not be overwritten with
    // the highlighted values, or restore() would be a no-op.
    if (obj.userData._selPrev) return;

    const prev = {};

    if (obj.isSprite) {
        // The name label is hidden while the callout is open: the callout
        // already shows the name, and two copies of it a few pixels apart
        // reads as a rendering glitch. label-occlusion.js has a matching
        // guard so a camera move doesn't bring it back.
        prev.visible = obj.visible;
        obj.visible = false;
    } else if (obj.material && obj.material.isLineMaterial) {
        // Line2 / polygon outline. Checked before the generic mesh branch
        // because Line2 extends Mesh.
        prev.linewidth = obj.material.linewidth;
        obj.material.linewidth = LINE_WIDTH;
    } else if (obj.userData.isAnnotationMarker) {
        // Point markers, line/polygon vertices and box corner handles.
        prev.scale = obj.scale.clone();
        prev.color = obj.material.color.clone();
        obj.scale.multiplyScalar(MARKER_SCALE);
        obj.material.color.lerp(_WHITE, BRIGHTEN);
    } else if (obj.userData.isBoxBody) {
        prev.opacity = obj.material.opacity;
        obj.material.opacity = BOX_FILL_OPACITY;
    } else if (obj.isLineSegments) {
        // Box wireframe.
        prev.color = obj.material.color.clone();
        obj.material.color.lerp(_WHITE, BRIGHTEN);
    } else if (obj.isMesh) {
        // Surface paint region.
        prev.opacity = obj.material.opacity;
        obj.material.opacity = SURFACE_OPACITY;
    } else {
        return; // nothing we know how to emphasise
    }

    obj.userData._selPrev = prev;
}

function restore(obj) {
    const prev = obj.userData._selPrev;
    if (!prev) return;

    if (prev.visible !== undefined) obj.visible = prev.visible;
    if (prev.scale) obj.scale.copy(prev.scale);
    if (obj.material) {
        if (prev.linewidth !== undefined) obj.material.linewidth = prev.linewidth;
        if (prev.opacity !== undefined) obj.material.opacity = prev.opacity;
        if (prev.color) obj.material.color.copy(prev.color);
    }

    delete obj.userData._selPrev;
}
