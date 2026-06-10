// js/utils/helpers.js - Utility functions and constants
import * as THREE from 'three';
import { state, dom } from '../state.js';

// ============ Constants ============
export const AUTHOR_STORAGE_KEY = 'meshnotes_author';

export function getLastAuthor() {
    // Settings default author has highest priority, then fall back to session author
    return state.defaultAuthor || localStorage.getItem(AUTHOR_STORAGE_KEY) || '';
}

export function saveLastAuthor(author) {
    // Only save session author if no default author is set in settings
    // This ensures manual changes in annotations are one-time overrides
    if (author && !state.defaultAuthor) {
        localStorage.setItem(AUTHOR_STORAGE_KEY, author);
    }
}

// ============ Utility Functions ============

export function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Sanitizes a user-supplied link for use as an href.
 * Returns the URL unchanged for http(s) links, converts DOIs
 * ("doi:10.xxxx/yyy" or bare "10.xxxx/yyy") to https://doi.org/
 * resolver links, and returns '' for everything else (javascript:,
 * data:, relative paths, ...) so callers can skip emitting an href.
 * Protects against script-injection via links in imported/shared
 * annotation files.
 * @param {string} url - Raw link string from user input or import
 * @returns {string} Safe absolute URL, or '' if the link is not safe
 */
export function safeUrl(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    const doiMatch = trimmed.match(/^(?:doi:)?(10\.\d{4,9}\/\S+)$/i);
    if (doiMatch) return 'https://doi.org/' + doiMatch[1];
    return '';
}

// Status hold — prevents other showStatus calls from overwriting for a duration
let statusHoldUntil = 0;
let statusTimeout = null;

export function showStatus(message, holdSeconds = 0) {
    const now = Date.now();
    
    // If a hold is active and this call isn't setting a new hold, skip it
    if (holdSeconds === 0 && now < statusHoldUntil) return;
    
    // Set hold if requested
    if (holdSeconds > 0) {
        statusHoldUntil = now + holdSeconds * 1000;
    }
    
    dom.status.textContent = message;
    dom.status.classList.add('visible');
    
    // Clear any existing timeout
    if (statusTimeout) clearTimeout(statusTimeout);
    
    // Use hold duration or default 3 seconds for visibility
    const visibleDuration = holdSeconds > 0 ? holdSeconds * 1000 : 3000;
    statusTimeout = setTimeout(() => {
        dom.status.classList.remove('visible');
    }, visibleDuration);
}

export function updateFaceCountDisplay(count) {
    const formatted = count.toLocaleString();

    if (count > 1000000) {
        dom.faceCountDisplay.innerHTML = `<span class="warning">\u26A0\uFE0F ${formatted} faces</span> (Surface tool may be slow)`;
    } else if (count > 500000) {
        dom.faceCountDisplay.innerHTML = `<span class="warning">${formatted} faces</span> (Surface tool may lag)`;
    } else {
        dom.faceCountDisplay.textContent = `${formatted} faces`;
    }

    dom.modelStats.classList.add('visible');
}

export function filterAnnotations(searchTerm) {
    const term = searchTerm.toLowerCase().trim();

    // Get all group items and annotation items
    const groupItems = dom.groupsContainer.querySelectorAll('.group-item');

    groupItems.forEach(groupItem => {
        const annotationItems = groupItem.querySelectorAll('.annotation-item');
        let hasVisibleAnnotation = false;

        annotationItems.forEach(annItem => {
            const name = annItem.querySelector('.name')?.textContent.toLowerCase() || '';

            if (term === '' || name.includes(term)) {
                annItem.classList.remove('search-hidden');
                hasVisibleAnnotation = true;
            } else {
                annItem.classList.add('search-hidden');
            }
        });

        // Hide group if no annotations match (unless search is empty)
        if (term === '') {
            groupItem.classList.remove('search-hidden');
        } else if (hasVisibleAnnotation) {
            groupItem.classList.remove('search-hidden');
        } else {
            groupItem.classList.add('search-hidden');
        }
    });
}

export function toggleManualItem(header) {
    header.classList.toggle('expanded');
    const content = header.nextElementSibling;
    content.classList.toggle('expanded');
}
// Make accessible for inline onclick handlers
window.toggleManualItem = toggleManualItem;

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 200, g: 200, b: 200 };
}

// ============ Flip Transform ============

/**
 * Transforms a point between flipped and non-flipped coordinate space.
 * When the model is flipped (180° rotation around X axis), world-space
 * coordinates map as (x, y, z) → (x, -y, -z).
 * This transform is self-inverse: applying it twice returns the original point.
 * @param {{x: number, y: number, z: number}} p - Point to transform
 * @returns {{x: number, y: number, z: number}} Transformed point
 */
export function flipTransform(p) {
    return { x: p.x, y: -p.y, z: -p.z };
}

/**
 * Returns the point in display space, applying the flip transform if active.
 * Use when positioning visual objects from stored annotation coordinates.
 * @param {{x: number, y: number, z: number}} p - Stored annotation point
 * @returns {{x: number, y: number, z: number}} Point in current display space
 */
export function toDisplayCoords(p) {
    if (!state.isFlipped) return p;
    return flipTransform(p);
}

/**
 * Converts a raycasted world-space point to storage coordinates,
 * undoing the flip transform if the model is currently flipped.
 * Use before saving annotation points from raycasting results.
 * @param {{x: number, y: number, z: number}} p - Raycasted world-space point
 * @returns {{x: number, y: number, z: number}} Point in non-flipped storage space
 */
export function toStorageCoords(p) {
    if (!state.isFlipped) return { x: p.x, y: p.y, z: p.z };
    return flipTransform(p);
}

/**
 * Returns the on-screen orientation of a stored box as a quaternion.
 * Storage rotation is an XYZ Euler. When the model is flipped it is rotated 180
 * degrees about X, so a box rigidly carried by that flip has display orientation
 * Rx(PI) * R (pre-multiply). Single source of truth shared by the box renderer
 * (body / wireframe / handles) and the box resize math, so they always agree.
 * @param {{x:number,y:number,z:number}|null} rotation - stored box rotation (XYZ euler)
 * @returns {THREE.Quaternion} display-space orientation
 */
export function boxDisplayQuaternion(rotation) {
    const r = rotation || { x: 0, y: 0, z: 0 };
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z, 'XYZ'));
    if (state.isFlipped) {
        const qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
        q.premultiply(qFlip);
    }
    return q;
}

export function getModelMimeType() {
    if (!state.modelFileName) return 'model/gltf-binary';
    const ext = state.modelFileName.toLowerCase().split('.').pop();
    if (ext === 'obj') return 'model/obj';
    if (ext === 'ply') return 'model/ply';
    return 'model/gltf-binary';
}
