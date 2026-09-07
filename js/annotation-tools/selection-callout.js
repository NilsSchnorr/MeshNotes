// js/annotation-tools/selection-callout.js — the callout box for the selected annotation
//
// A small HTML panel anchored to the selected annotation's position in the
// model, in the manner of the Smithsonian Voyager annotation callouts.
//
// Deliberately an HTML overlay rather than a THREE.Sprite:
//   • text stays crisp at any zoom and any device pixel ratio, where a
//     CanvasTexture would blur (and would blur again in a 4× export tile);
//   • it keeps a constant on-screen size instead of scaling with the model the
//     way createScaledTextSprite() does;
//   • the "Details" button and any entry links are real, clickable DOM;
//   • it inherits the app's CSS custom properties directly;
//   • and, most importantly, captureAtSize() renders state.scene only, so the
//     callout is automatically absent from screenshots, the six-view plate and
//     the PDF report. Selection is interface state and has no business in a
//     published figure.
//
// The anchor points come from state.annotationAnchors, which renderAnnotations()
// fills with the same per-type position it uses for label occlusion (already
// flip-aware, already correct for polygon centroids and box centres).

import * as THREE from 'three';
import { state, dom } from '../state.js';

const TYPE_LABELS = { point: 'Point', line: 'Line', polygon: 'Polygon', surface: 'Surface', box: 'Box' };

// Gap in CSS pixels between the anchor point and the near edge of the box.
const ANCHOR_GAP = 16;
// Keep this much clear of the viewport edges when clamping.
const EDGE_MARGIN = 8;

// Late-bound to avoid importing data.js (which imports groups.js, which imports
// this module) — same pattern as setGroupCallbacks().
let _openAnnotationPopupForEdit = null;

export function setCalloutCallbacks({ openAnnotationPopupForEdit }) {
    _openAnnotationPopupForEdit = openAnnotationPopupForEdit;
}

// Reusable vector — the position update runs every frame.
const _projected = new THREE.Vector3();

// Cached box dimensions. Measured when the content changes and on resize, not
// per frame: reading offsetWidth every frame alongside a transform write is a
// needless layout read.
let _boxW = 0;
let _boxH = 0;

// Last written position, rounded, so an unchanged frame writes nothing.
let _lastX = null;
let _lastY = null;
let _lastFlipped = null;

let _annotationId = null;

function el() {
    return document.getElementById('annotation-callout');
}

/**
 * Wire the Details button once at startup.
 */
export function initSelectionCallout() {
    const panel = el();
    if (!panel) return;

    const detailsBtn = panel.querySelector('.ac-details');
    if (detailsBtn) {
        detailsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ann = state.annotations.find(a => a.id === _annotationId);
            if (ann && _openAnnotationPopupForEdit) {
                _openAnnotationPopupForEdit(ann);
            }
        });
    }

    window.addEventListener('resize', () => {
        measure();
        // Force a reposition on the next frame.
        _lastX = null;
        _lastY = null;
    });
}

/**
 * Show the callout for an annotation. Contents are written with textContent
 * throughout, so no escaping is needed and no markup from a description can
 * ever be interpreted.
 *
 * @param {Object} ann
 */
export function showSelectionCallout(ann) {
    const panel = el();
    if (!panel || !ann) return;

    _annotationId = ann.id;

    const group = state.groups.find(g => g.id === ann.groupId);

    const nameEl = panel.querySelector('.ac-name');
    if (nameEl) nameEl.textContent = ann.name || 'Untitled';

    const typeEl = panel.querySelector('.ac-type');
    if (typeEl) typeEl.textContent = TYPE_LABELS[ann.type] || 'Annotation';

    const groupEl = panel.querySelector('.ac-group');
    const dotEl = panel.querySelector('.ac-group-dot');
    const groupNameEl = panel.querySelector('.ac-group-name');
    if (groupEl && dotEl && groupNameEl) {
        if (group) {
            groupEl.style.display = '';
            dotEl.style.background = group.color;
            groupNameEl.textContent = group.name;
        } else {
            groupEl.style.display = 'none';
        }
    }

    const entries = ann.entries || [];
    const newest = entries.length > 0 ? entries[entries.length - 1] : null;
    const description = newest ? (newest.description || '').trim() : '';

    const descEl = panel.querySelector('.ac-desc');
    if (descEl) {
        descEl.textContent = description;
        descEl.style.display = description ? '' : 'none';
    }

    const entriesEl = panel.querySelector('.ac-entries');
    if (entriesEl) {
        entriesEl.textContent = entries.length === 1 ? '1 entry' : `${entries.length} entries`;
    }

    panel.classList.add('visible');

    // Content just changed, so the cached size is stale.
    measure();
    _lastX = null;
    _lastY = null;
    _lastFlipped = null;

    updateSelectionCallout();
}

/**
 * Hide the callout.
 */
export function hideSelectionCallout() {
    const panel = el();
    if (!panel) return;
    panel.classList.remove('visible');
    panel.classList.remove('anchor-lost');
    _annotationId = null;
    _lastX = null;
    _lastY = null;
    _lastFlipped = null;
}

/**
 * Re-project the anchor and reposition the box. Called once per frame from
 * animate(); returns immediately when nothing is selected, which is the
 * overwhelmingly common case.
 */
export function updateSelectionCallout() {
    const panel = el();
    if (!panel || !panel.classList.contains('visible')) return;

    if (state.selectedAnnotation === null || !state.camera) {
        hideSelectionCallout();
        return;
    }

    const anchor = state.annotationAnchors.get(state.selectedAnnotation);
    if (!anchor) {
        // No anchor means renderAnnotations() skipped this annotation — its
        // group was hidden, or the model was cleared. Keep the selection but
        // take the box off screen.
        panel.classList.add('anchor-lost');
        return;
    }
    panel.classList.remove('anchor-lost');

    _projected.copy(anchor).project(state.camera);

    // Behind the camera.
    if (_projected.z > 1) {
        panel.classList.add('anchor-lost');
        return;
    }

    const rect = dom.canvas.getBoundingClientRect();
    const anchorX = rect.left + (_projected.x * 0.5 + 0.5) * rect.width;
    const anchorY = rect.top + (-_projected.y * 0.5 + 0.5) * rect.height;

    if (_boxW === 0 || _boxH === 0) measure();

    // Sit to the right of the anchor, vertically centred on it. Flip to the
    // left when there isn't room, so the box never runs off the edge.
    let flipped = false;
    let x = anchorX + ANCHOR_GAP;
    if (x + _boxW > window.innerWidth - EDGE_MARGIN) {
        flipped = true;
        x = anchorX - ANCHOR_GAP - _boxW;
    }
    x = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - _boxW - EDGE_MARGIN));

    let y = anchorY - _boxH / 2;
    y = Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - _boxH - EDGE_MARGIN));

    const rx = Math.round(x);
    const ry = Math.round(y);
    if (rx === _lastX && ry === _lastY && flipped === _lastFlipped) return;

    panel.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
    panel.classList.toggle('flip-left', flipped);

    // The tail tracks the anchor vertically, so it still points at the
    // annotation when the box has been clamped against a viewport edge.
    const tailY = Math.max(10, Math.min(anchorY - ry, _boxH - 10));
    panel.style.setProperty('--ac-tail-y', `${Math.round(tailY)}px`);

    _lastX = rx;
    _lastY = ry;
    _lastFlipped = flipped;
}

function measure() {
    const panel = el();
    if (!panel || !panel.classList.contains('visible')) return;
    _boxW = panel.offsetWidth;
    _boxH = panel.offsetHeight;
}
