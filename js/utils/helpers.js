// js/utils/helpers.js - Utility functions and constants
import { state, dom } from '../state.js';

// ============ Constants ============
export const AUTHOR_STORAGE_KEY = 'meshnotes_author';

export function getLastAuthor() {
    return localStorage.getItem(AUTHOR_STORAGE_KEY) || '';
}

export function saveLastAuthor(author) {
    if (author) localStorage.setItem(AUTHOR_STORAGE_KEY, author);
}

// ============ Utility Functions ============

export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function showStatus(message) {
    dom.status.textContent = message;
    dom.status.classList.add('visible');
    setTimeout(() => {
        dom.status.classList.remove('visible');
    }, 3000);
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

export function getModelMimeType() {
    if (!state.modelFileName) return 'model/gltf-binary';
    const ext = state.modelFileName.toLowerCase().split('.').pop();
    if (ext === 'obj') return 'model/obj';
    if (ext === 'ply') return 'model/ply';
    return 'model/gltf-binary';
}
