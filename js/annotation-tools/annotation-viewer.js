// js/annotation-tools/annotation-viewer.js — read-only "Shared Annotation View"
//
// A dedicated, draggable, read-only panel that opens ONLY when an annotation is
// focused from a share/direct link. It has no edit affordances by construction,
// so a shared annotation can't be changed by accident. Re-opening the same
// annotation from the sidebar uses the normal (editable) popup instead.
//
// Closing rule: the panel closes on its own ✕, and as soon as the user clicks
// anything in the sidebar or toolbar (any tool or other annotation) — so the
// next sidebar interaction naturally lands them in the editable popup.

import { state } from '../state.js';
import { escapeHtml, safeUrl } from '../utils/helpers.js';

// Drag state (module-local; mirrors the settings-modal drag pattern)
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

const TYPE_LABELS = { point: 'Point', line: 'Line', polygon: 'Polygon', surface: 'Surface', box: 'Box' };

function isViewerOpen() {
    const panel = document.getElementById('annotation-viewer');
    return !!panel && panel.classList.contains('visible');
}

/**
 * Wire drag, close button, and the sidebar/toolbar auto-close once at startup.
 */
export function initAnnotationViewer() {
    const panel = document.getElementById('annotation-viewer');
    const header = document.getElementById('annotation-viewer-header');
    const closeBtn = document.getElementById('annotation-viewer-close');
    if (!panel || !header) return;

    if (closeBtn) closeBtn.addEventListener('click', closeAnnotationViewer);

    // Dragging (desktop only — coarse pointers don't need it)
    if (!window.matchMedia('(pointer: coarse)').matches) {
        header.addEventListener('mousedown', (e) => {
            if (e.target === closeBtn) return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const maxX = window.innerWidth - panel.offsetWidth;
            const maxY = window.innerHeight - panel.offsetHeight;
            const newX = Math.max(0, Math.min(e.clientX - dragOffsetX, maxX));
            const newY = Math.max(0, Math.min(e.clientY - dragOffsetY, maxY));
            panel.style.left = newX + 'px';
            panel.style.top = newY + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });
    }

    // Close as soon as the user touches the sidebar or toolbar — any tool or
    // other annotation. Re-opening from the sidebar then yields the editable
    // popup (handled by the existing sidebar handlers).
    ['sidebar', 'toolbar'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => {
            if (isViewerOpen()) closeAnnotationViewer();
        });
    });
}

/**
 * Open the read-only viewer for an annotation.
 * @param {Object} ann
 */
export function openAnnotationViewer(ann) {
    const panel = document.getElementById('annotation-viewer');
    if (!panel || !ann) return;

    const group = state.groups.find(g => g.id === ann.groupId);
    const typeLabel = TYPE_LABELS[ann.type] || 'Annotation';

    const nameEl = document.getElementById('annotation-viewer-name');
    if (nameEl) nameEl.textContent = ann.name || 'Untitled';

    const metaEl = document.getElementById('annotation-viewer-meta');
    if (metaEl) {
        metaEl.innerHTML = '';
        const typeSpan = document.createElement('span');
        typeSpan.className = 'av-type';
        typeSpan.textContent = typeLabel;
        metaEl.appendChild(typeSpan);
        if (group) {
            const groupSpan = document.createElement('span');
            groupSpan.className = 'av-group';
            const dot = document.createElement('span');
            dot.className = 'av-group-dot';
            dot.style.background = group.color;
            groupSpan.appendChild(dot);
            groupSpan.appendChild(document.createTextNode(group.name));
            metaEl.appendChild(groupSpan);
        }
    }

    renderViewerEntries(ann);

    panel.classList.add('visible');
}

function renderViewerEntries(ann) {
    const listEl = document.getElementById('annotation-viewer-entries');
    if (!listEl) return;

    const entries = ann.entries || [];
    if (entries.length === 0) {
        listEl.innerHTML = '<div class="av-empty">No description entries.</div>';
        return;
    }

    listEl.innerHTML = entries.map(entry => {
        const date = entry.timestamp ? new Date(entry.timestamp) : null;
        const dateStr = date
            ? date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';
        const linksHtml = (entry.links && entry.links.length > 0) ? `
            <div class="entry-card-links">
                ${entry.links.map(link => {
                    const url = safeUrl(link);
                    const label = `🔗 ${escapeHtml(link.split('/').pop() || link)}`;
                    return url
                        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`
                        : `<span title="Link disabled (unsupported protocol)">${label}</span>`;
                }).join('')}
            </div>
        ` : '';
        return `
            <div class="entry-card av-entry">
                <div class="entry-card-meta">
                    <span class="author">${escapeHtml(entry.author || 'Unknown')}</span>${dateStr ? ' • ' + escapeHtml(dateStr) : ''}
                </div>
                <div class="entry-card-description">${escapeHtml(entry.description || '')}</div>
                ${linksHtml}
            </div>
        `;
    }).join('');
}

/**
 * Close the read-only viewer.
 */
export function closeAnnotationViewer() {
    const panel = document.getElementById('annotation-viewer');
    if (panel) panel.classList.remove('visible');
}
