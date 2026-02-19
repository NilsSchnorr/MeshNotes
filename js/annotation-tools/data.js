// js/annotation-tools/data.js
import { state, dom } from '../state.js';
import { generateUUID, escapeHtml, showStatus, getLastAuthor, saveLastAuthor } from '../utils/helpers.js';
import { computeProjectedEdges } from './projection.js';
import { renderAnnotations } from './render.js';
import { updateGroupsList, updateGroupSelect } from './groups.js';
import { clearTempDrawing } from './editing.js';
import { hideAllToolPanels, restoreToolHelp } from '../ui/tool-help.js';

export function positionPopup(popup, x, y) {
    popup.style.transform = 'none';
    popup.style.left = `${x + 10}px`;
    popup.style.top = `${y + 10}px`;

    requestAnimationFrame(() => {
        const rect = popup.getBoundingClientRect();
        if (rect.right > window.innerWidth - 320) {
            popup.style.left = `${x - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            popup.style.top = `${y - rect.height - 10}px`;
        }
        const newRect = popup.getBoundingClientRect();
        if (newRect.top < 50) {
            popup.style.top = '60px';
        }
        if (newRect.left < 10) {
            popup.style.left = '10px';
        }
    });
}

function resetPopupPosition() {
    const viewportWidth = window.innerWidth - 320;
    const viewportHeight = window.innerHeight - 50;
    dom.annotationPopup.style.left = Math.max(20, (viewportWidth - 400) / 2) + 'px';
    dom.annotationPopup.style.top = Math.max(20, (viewportHeight - 400) / 2) + 'px';
    dom.annotationPopup.style.right = 'auto';
    dom.annotationPopup.style.bottom = 'auto';
    dom.annotationPopup.style.transform = 'none';
}

export function openAnnotationPopup(event, type, points, extraData = null) {
    // Hide all tool info panels when annotation popup opens
    hideAllToolPanels();
    
    state.editingAnnotation = null;
    state.editingModelInfo = false;
    state.isAddingEntry = false;
    state.editingEntryId = null;
    state.pendingLinks = [];

    dom.popupTitle.textContent = `New ${type.charAt(0).toUpperCase() + type.slice(1)}`;
    dom.annName.value = '';
    dom.annDescription.value = '';
    dom.annAuthor.value = getLastAuthor();
    updateGroupSelect();
    updateLinksDisplay();
    dom.btnPopupDelete.style.display = 'none';

    document.getElementById('popup-main-fields').style.display = 'block';
    dom.entriesContainer.style.display = 'none';
    dom.newEntryForm.style.display = 'block';

    dom.annotationPopup.dataset.type = type;
    dom.annotationPopup.dataset.points = JSON.stringify(points.map(p => ({ x: p.x, y: p.y, z: p.z })));

    if ((type === 'line' || type === 'polygon') && state.surfaceProjectionEnabled) {
        dom.surfaceProjectionToggle.style.display = 'block';
        dom.annSurfaceProjection.checked = true;
    } else {
        dom.surfaceProjectionToggle.style.display = 'none';
    }

    if (type === 'surface' && extraData) {
        dom.annotationPopup.dataset.faceData = JSON.stringify(extraData);
    } else {
        delete dom.annotationPopup.dataset.faceData;
    }

    if (type === 'box' && extraData) {
        dom.annotationPopup.dataset.boxData = JSON.stringify(extraData);
    } else {
        delete dom.annotationPopup.dataset.boxData;
    }

    if (type === 'surface') {
        resetPopupPosition();
    } else {
        positionPopup(dom.annotationPopup, event.clientX, event.clientY);
    }
    dom.annotationPopup.classList.add('visible');
    dom.annName.focus();
}

export function openAnnotationPopupForEdit(ann) {
    // Hide all tool info panels when annotation popup opens
    hideAllToolPanels();
    
    state.editingAnnotation = ann;
    state.editingModelInfo = false;
    state.isAddingEntry = false;
    state.editingEntryId = null;
    state.pendingLinks = [];

    dom.popupTitle.textContent = `Edit ${ann.type.charAt(0).toUpperCase() + ann.type.slice(1)}`;
    dom.annName.value = ann.name;
    updateGroupSelect();
    dom.annGroup.value = ann.groupId;
    dom.btnPopupDelete.style.display = 'block';

    dom.annotationPopup.dataset.type = ann.type;
    dom.annotationPopup.dataset.points = JSON.stringify(ann.points);

    if ((ann.type === 'line' || ann.type === 'polygon') && state.surfaceProjectionEnabled) {
        dom.surfaceProjectionToggle.style.display = 'block';
        dom.annSurfaceProjection.checked = ann.surfaceProjection !== false;
    } else {
        dom.surfaceProjectionToggle.style.display = 'none';
    }

    document.getElementById('popup-main-fields').style.display = 'block';
    dom.entriesContainer.style.display = 'block';
    dom.newEntryForm.style.display = 'none';

    renderEntriesList(ann);

    resetPopupPosition();
    dom.annotationPopup.classList.add('visible');
    dom.annName.focus();
}

export function openModelInfoPopup() {
    // Hide all tool info panels when popup opens
    hideAllToolPanels();
    
    state.editingAnnotation = null;
    state.editingModelInfo = true;
    state.isAddingEntry = false;
    state.editingEntryId = null;
    state.pendingLinks = [];

    dom.popupTitle.textContent = 'Model Information';

    document.getElementById('popup-main-fields').style.display = 'none';
    dom.btnPopupDelete.style.display = 'none';

    dom.entriesContainer.style.display = 'block';

    if (state.modelInfo.entries.length === 0) {
        dom.newEntryForm.style.display = 'block';
        dom.annDescription.value = '';
        dom.annAuthor.value = getLastAuthor();
        updateLinksDisplay();
    } else {
        dom.newEntryForm.style.display = 'none';
    }

    renderModelInfoEntriesList();

    resetPopupPosition();
    dom.annotationPopup.classList.add('visible');
}

export function renderModelInfoEntriesList() {
    const entries = state.modelInfo.entries || [];

    if (entries.length === 0) {
        dom.entriesList.innerHTML = '<div style="color: #888; padding: 10px; text-align: center;">No entries yet. Add general information about this model.</div>';
        return;
    }

    dom.entriesList.innerHTML = entries.map((entry, index) => {
        const date = new Date(entry.timestamp);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const linksHtml = (entry.links && entry.links.length > 0) ? `
            <div class="entry-card-links">
                ${entry.links.map(link => `<a href="${escapeHtml(link)}" target="_blank">🔗 ${escapeHtml(link.split('/').pop() || link)}</a>`).join('')}
            </div>
        ` : '';

        return `
            <div class="entry-card" data-entry-id="${entry.id}">
                <div class="entry-card-header">
                    <div class="entry-card-meta">
                        <span class="author">${escapeHtml(entry.author || 'Unknown')}</span> • ${dateStr}
                    </div>
                    <div class="entry-card-actions">
                        <button data-action="edit" data-entry-id="${entry.id}">✏️ Edit</button>
                        <button data-action="delete" data-entry-id="${entry.id}">🗑️</button>
                    </div>
                </div>
                <div class="entry-card-description">${escapeHtml(entry.description || '')}</div>
                ${linksHtml}
                <div class="entry-edit-form">
                    <textarea data-field="description">${escapeHtml(entry.description || '')}</textarea>
                    <input type="text" data-field="author" value="${escapeHtml(entry.author || '')}" placeholder="Author">
                    <div class="links-section">
                        <label>Links</label>
                        <div class="entry-links-list" data-entry-id="${entry.id}">
                            ${(entry.links || []).map((link, li) => `
                                <div class="link-item">
                                    <a href="${escapeHtml(link)}" target="_blank">${escapeHtml(link)}</a>
                                    <button data-link-index="${li}">✕</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="add-link-row">
                            <input type="text" data-field="new-link" placeholder="https://...">
                            <button class="btn-save" data-action="add-link">+</button>
                        </div>
                    </div>
                    <div class="entry-edit-buttons">
                        <button class="btn-cancel" data-action="cancel-edit">Cancel</button>
                        <button class="btn-save" data-action="save-edit">Save Entry</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    dom.entriesList.querySelectorAll('.entry-card-actions button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entryId = parseInt(btn.dataset.entryId);
            const action = btn.dataset.action;

            if (action === 'edit') {
                showConfirm('Are you sure you want to edit this entry instead of adding a new one?', () => {
                    startEditingModelInfoEntry(entryId);
                });
            } else if (action === 'delete') {
                showConfirm('Are you sure you want to delete this entry? This cannot be undone.', () => {
                    deleteModelInfoEntry(entryId);
                });
            }
        });
    });

    dom.entriesList.querySelectorAll('.entry-edit-form button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const card = btn.closest('.entry-card');
            const entryId = parseInt(card.dataset.entryId);

            if (action === 'cancel-edit') {
                cancelEditingEntry();
                renderModelInfoEntriesList();
            } else if (action === 'save-edit') {
                saveModelInfoEntryEdit(entryId, card);
            } else if (action === 'add-link') {
                const input = card.querySelector('[data-field="new-link"]');
                const link = input.value.trim();
                if (link) {
                    const entry = state.modelInfo.entries.find(en => en.id === entryId);
                    if (!entry.links) entry.links = [];
                    entry.links.push(link);
                    input.value = '';
                    renderModelInfoEntriesList();
                    startEditingModelInfoEntry(entryId);
                }
            }
        });
    });

    dom.entriesList.querySelectorAll('.entry-links-list button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = btn.closest('.entry-card');
            const entryId = parseInt(card.dataset.entryId);
            const linkIndex = parseInt(btn.dataset.linkIndex);
            const entry = state.modelInfo.entries.find(en => en.id === entryId);
            if (entry && entry.links) {
                entry.links.splice(linkIndex, 1);
                renderModelInfoEntriesList();
                startEditingModelInfoEntry(entryId);
            }
        });
    });
}

function startEditingModelInfoEntry(entryId) {
    state.editingEntryId = entryId;
    dom.entriesList.querySelectorAll('.entry-card').forEach(card => {
        if (parseInt(card.dataset.entryId) === entryId) {
            card.classList.add('editing');
        } else {
            card.classList.remove('editing');
        }
    });
}

function saveModelInfoEntryEdit(entryId, card) {
    const entry = state.modelInfo.entries.find(en => en.id === entryId);
    if (!entry) return;

    const description = card.querySelector('[data-field="description"]').value.trim();
    const author = card.querySelector('[data-field="author"]').value.trim();

    entry.description = description;
    entry.author = author;
    entry.modified = new Date().toISOString();
    saveLastAuthor(author);

    state.editingEntryId = null;
    renderModelInfoEntriesList();
    updateModelInfoDisplay();
    showStatus('Entry updated');
}

function deleteModelInfoEntry(entryId) {
    state.modelInfo.entries = state.modelInfo.entries.filter(e => e.id !== entryId);
    renderModelInfoEntriesList();
    updateModelInfoDisplay();
    showStatus('Entry deleted');
}

export function updateModelInfoDisplay() {
    const entryCount = state.modelInfo.entries.length;
    if (entryCount === 0) {
        dom.modelInfoSubtitle.textContent = 'No entries yet';
    } else {
        dom.modelInfoSubtitle.textContent = entryCount === 1 ? '1 entry' : `${entryCount} entries`;
    }
}

export function renderEntriesList(ann) {
    const entries = ann.entries || [];

    if (entries.length === 0) {
        dom.entriesList.innerHTML = '<div style="color: #888; padding: 10px; text-align: center;">No entries yet</div>';
        return;
    }

    dom.entriesList.innerHTML = entries.map((entry, index) => {
        const date = new Date(entry.timestamp);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const linksHtml = (entry.links && entry.links.length > 0) ? `
            <div class="entry-card-links">
                ${entry.links.map(link => `<a href="${escapeHtml(link)}" target="_blank">🔗 ${escapeHtml(link.split('/').pop() || link)}</a>`).join('')}
            </div>
        ` : '';

        return `
            <div class="entry-card" data-entry-id="${entry.id}">
                <div class="entry-card-header">
                    <div class="entry-card-meta">
                        <span class="author">${escapeHtml(entry.author || 'Unknown')}</span> • ${dateStr}
                    </div>
                    <div class="entry-card-actions">
                        <button data-action="edit" data-entry-id="${entry.id}">✏️ Edit</button>
                        <button data-action="delete" data-entry-id="${entry.id}">🗑️</button>
                    </div>
                </div>
                <div class="entry-card-description">${escapeHtml(entry.description || '')}</div>
                ${linksHtml}
                <div class="entry-edit-form">
                    <textarea data-field="description">${escapeHtml(entry.description || '')}</textarea>
                    <input type="text" data-field="author" value="${escapeHtml(entry.author || '')}" placeholder="Author">
                    <div class="links-section">
                        <label>Links</label>
                        <div class="entry-links-list" data-entry-id="${entry.id}">
                            ${(entry.links || []).map((link, li) => `
                                <div class="link-item">
                                    <a href="${escapeHtml(link)}" target="_blank">${escapeHtml(link)}</a>
                                    <button data-link-index="${li}">✕</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="add-link-row">
                            <input type="text" data-field="new-link" placeholder="https://...">
                            <button class="btn-save" data-action="add-link">+</button>
                        </div>
                    </div>
                    <div class="entry-edit-buttons">
                        <button class="btn-cancel" data-action="cancel-edit">Cancel</button>
                        <button class="btn-save" data-action="save-edit">Save Entry</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    dom.entriesList.querySelectorAll('.entry-card-actions button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entryId = parseInt(btn.dataset.entryId);
            const action = btn.dataset.action;

            if (action === 'edit') {
                showConfirm('Are you sure you want to edit this entry instead of adding a new one?', () => {
                    startEditingEntry(entryId);
                });
            } else if (action === 'delete') {
                showConfirm('Are you sure you want to delete this entry? This cannot be undone.', () => {
                    deleteEntry(entryId);
                });
            }
        });
    });

    dom.entriesList.querySelectorAll('.entry-edit-form button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const card = btn.closest('.entry-card');
            const entryId = parseInt(card.dataset.entryId);

            if (action === 'cancel-edit') {
                cancelEditingEntry();
                renderEntriesList(ann);
            } else if (action === 'save-edit') {
                saveEntryEdit(entryId, card);
            } else if (action === 'add-link') {
                const input = card.querySelector('[data-field="new-link"]');
                const link = input.value.trim();
                if (link) {
                    const entry = ann.entries.find(en => en.id === entryId);
                    if (!entry.links) entry.links = [];
                    entry.links.push(link);
                    input.value = '';
                    renderEntriesList(ann);
                    startEditingEntry(entryId);
                }
            }
        });
    });

    dom.entriesList.querySelectorAll('.entry-links-list button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = btn.closest('.entry-card');
            const entryId = parseInt(card.dataset.entryId);
            const linkIndex = parseInt(btn.dataset.linkIndex);
            const entry = ann.entries.find(en => en.id === entryId);
            if (entry && entry.links) {
                entry.links.splice(linkIndex, 1);
                renderEntriesList(ann);
                startEditingEntry(entryId);
            }
        });
    });
}

function startEditingEntry(entryId) {
    state.editingEntryId = entryId;
    dom.entriesList.querySelectorAll('.entry-card').forEach(card => {
        if (parseInt(card.dataset.entryId) === entryId) {
            card.classList.add('editing');
        } else {
            card.classList.remove('editing');
        }
    });
}

export function cancelEditingEntry() {
    state.editingEntryId = null;
    dom.entriesList.querySelectorAll('.entry-card').forEach(card => {
        card.classList.remove('editing');
    });
}

function saveEntryEdit(entryId, card) {
    const entry = state.editingAnnotation.entries.find(en => en.id === entryId);
    if (!entry) return;

    const description = card.querySelector('[data-field="description"]').value.trim();
    const author = card.querySelector('[data-field="author"]').value.trim();

    entry.description = description;
    entry.author = author;
    entry.modified = new Date().toISOString();
    saveLastAuthor(author);

    state.editingEntryId = null;
    renderEntriesList(state.editingAnnotation);
    showStatus('Entry updated');
}

function deleteEntry(entryId) {
    if (!state.editingAnnotation || !state.editingAnnotation.entries) return;

    state.editingAnnotation.entries = state.editingAnnotation.entries.filter(e => e.id !== entryId);
    renderEntriesList(state.editingAnnotation);
    updateGroupsList();
    showStatus('Entry deleted');
}

export function showAddEntryForm() {
    state.isAddingEntry = true;
    dom.newEntryForm.style.display = 'block';
    dom.annDescription.value = '';
    dom.annAuthor.value = getLastAuthor();
    state.pendingLinks = [];
    updateLinksDisplay();
    dom.annDescription.focus();
}

export function hideAddEntryForm() {
    state.isAddingEntry = false;
    dom.newEntryForm.style.display = 'none';
}

export function updateLinksDisplay() {
    dom.annLinks.innerHTML = state.pendingLinks.map((link, i) => `
        <div class="link-item">
            <a href="${escapeHtml(link)}" target="_blank">${escapeHtml(link)}</a>
            <button data-index="${i}">✕</button>
        </div>
    `).join('');

    dom.annLinks.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            state.pendingLinks.splice(parseInt(btn.dataset.index), 1);
            updateLinksDisplay();
        });
    });
}

export function addLink() {
    const url = dom.annNewLink.value.trim();
    if (url) {
        state.pendingLinks.push(url);
        dom.annNewLink.value = '';
        updateLinksDisplay();
    }
}

export function showConfirm(message, callback) {
    dom.confirmMessage.textContent = message;
    state.confirmCallback = callback;
    dom.confirmOverlay.classList.add('visible');
}

export function hideConfirm() {
    dom.confirmOverlay.classList.remove('visible');
    state.confirmCallback = null;
}

export function showScalebarConfirm(switchCallback, noSwitchCallback) {
    state.scalebarConfirmCallback = switchCallback;
    state.scalebarNoSwitchCallback = noSwitchCallback;
    dom.scalebarConfirmOverlay.classList.add('visible');
}

export function hideScalebarConfirm() {
    dom.scalebarConfirmOverlay.classList.remove('visible');
    state.scalebarConfirmCallback = null;
    state.scalebarNoSwitchCallback = null;
}

export function saveAnnotation() {
    if (state.editingModelInfo) {
        if (state.isAddingEntry || state.modelInfo.entries.length === 0) {
            const description = dom.annDescription.value.trim();
            const author = dom.annAuthor.value.trim();

            if (description || author) {
                saveLastAuthor(author);
                state.modelInfo.entries.push({
                    id: Date.now(),
                    uuid: generateUUID(),
                    description,
                    author,
                    timestamp: new Date().toISOString(),
                    links: [...state.pendingLinks]
                });
            }
        }

        dom.annotationPopup.classList.remove('visible');
        state.isAddingEntry = false;
        state.editingModelInfo = false;
        updateModelInfoDisplay();
        showStatus('Model information saved');
        restoreToolHelp();
        return;
    }

    const type = dom.annotationPopup.dataset.type;
    const points = JSON.parse(dom.annotationPopup.dataset.points);
    const name = dom.annName.value.trim() || 'Unnamed';
    const groupId = parseInt(dom.annGroup.value) || state.groups[0].id;

    if (state.editingAnnotation) {
        state.editingAnnotation.name = name;
        state.editingAnnotation.groupId = groupId;

        if ((state.editingAnnotation.type === 'line' || state.editingAnnotation.type === 'polygon') && state.surfaceProjectionEnabled) {
            const wantsProjection = dom.annSurfaceProjection.checked;
            const hadProjection = state.editingAnnotation.surfaceProjection !== false;

            if (wantsProjection && !hadProjection) {
                state.editingAnnotation.projectedEdges = computeProjectedEdges(
                    state.editingAnnotation.points, state.editingAnnotation.type === 'polygon'
                );
                state.editingAnnotation.surfaceProjection = true;
            } else if (!wantsProjection && hadProjection) {
                delete state.editingAnnotation.projectedEdges;
                state.editingAnnotation.surfaceProjection = false;
            }
        }

        if (state.isAddingEntry) {
            const description = dom.annDescription.value.trim();
            const author = dom.annAuthor.value.trim();
            saveLastAuthor(author);

            if (!state.editingAnnotation.entries) state.editingAnnotation.entries = [];
            state.editingAnnotation.entries.push({
                id: Date.now(),
                uuid: generateUUID(),
                description,
                author,
                timestamp: new Date().toISOString(),
                links: [...state.pendingLinks]
            });
        }
    } else {
        const description = dom.annDescription.value.trim();
        const author = dom.annAuthor.value.trim();
        saveLastAuthor(author);

        const newAnnotation = {
            id: Date.now(),
            uuid: generateUUID(),
            type,
            name,
            groupId,
            points,
            entries: [{
                id: Date.now() + 1,
                uuid: generateUUID(),
                description,
                author,
                timestamp: new Date().toISOString(),
                links: [...state.pendingLinks]
            }]
        };

        if (type === 'surface' && dom.annotationPopup.dataset.faceData) {
            newAnnotation.faceData = JSON.parse(dom.annotationPopup.dataset.faceData);
        }

        if (type === 'box' && dom.annotationPopup.dataset.boxData) {
            newAnnotation.boxData = JSON.parse(dom.annotationPopup.dataset.boxData);
        }

        if ((type === 'line' || type === 'polygon') && points.length >= 2) {
            const wantsProjection = state.surfaceProjectionEnabled && dom.annSurfaceProjection.checked;
            newAnnotation.surfaceProjection = wantsProjection;
            if (wantsProjection) {
                newAnnotation.projectedEdges = computeProjectedEdges(points, type === 'polygon');
            }
        }

        state.annotations.push(newAnnotation);
    }

    dom.annotationPopup.classList.remove('visible');
    state.isAddingEntry = false;
    clearTempDrawing();
    updateGroupsList();
    renderAnnotations();
    showStatus(`Saved: ${name}`);
    
    // Restore tool help if a tool is still active
    restoreToolHelp();
}

export function deleteAnnotation() {
    if (!state.editingAnnotation) return;

    showConfirm('Are you sure you want to delete this annotation and all its entries? This cannot be undone.', () => {
        state.annotations = state.annotations.filter(a => a.id !== state.editingAnnotation.id);
        dom.annotationPopup.classList.remove('visible');
        state.editingAnnotation = null;
        state.selectedAnnotation = null;
        updateGroupsList();
        renderAnnotations();
        showStatus('Annotation deleted');
    });
}

export function getNiceScaleValue(value) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const normalized = value / magnitude;

    let nice;
    if (normalized < 1.5) nice = 1;
    else if (normalized < 3.5) nice = 2;
    else if (normalized < 7.5) nice = 5;
    else nice = 10;

    return nice * magnitude;
}

export function calculateScalebarParams() {
    if (!state.isOrthographic || !state.currentModel) return null;

    const viewportWidth = window.innerWidth - 320;

    const baseFrustumWidth = state.orthographicCamera.right - state.orthographicCamera.left;
    const effectiveFrustumWidth = baseFrustumWidth / state.orthographicCamera.zoom;

    const targetScalebarUnits = effectiveFrustumWidth * 0.25;
    const niceValue = getNiceScaleValue(targetScalebarUnits);

    const pixelsPerUnit = viewportWidth / effectiveFrustumWidth;
    const scalebarPixelWidth = niceValue * pixelsPerUnit;

    return {
        units: niceValue,
        pixelWidth: scalebarPixelWidth
    };
}

export function drawScalebarOnCanvas(targetCanvas) {
    const params = calculateScalebarParams();
    if (!params) return;

    const ctx = targetCanvas.getContext('2d');
    const canvasWidth = targetCanvas.width;
    const canvasHeight = targetCanvas.height;

    const dpr = window.devicePixelRatio || 1;
    const scalebarWidth = params.pixelWidth * dpr;
    const segmentCount = 4;
    const segmentWidth = scalebarWidth / segmentCount;
    const barHeight = 12 * dpr;

    const padding = 20 * dpr;
    const x = padding;
    const y = canvasHeight - padding - barHeight - 25 * dpr;

    const bgPadding = 10 * dpr;
    ctx.fillStyle = 'rgba(4, 29, 49, 0.85)';
    ctx.fillRect(
        x - bgPadding,
        y - bgPadding,
        scalebarWidth + bgPadding * 2,
        barHeight + 45 * dpr + bgPadding
    );

    for (let i = 0; i < segmentCount; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#000000' : '#ffffff';
        ctx.fillRect(x + i * segmentWidth, y, segmentWidth, barHeight);
    }

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(x, y, scalebarWidth, barHeight);

    ctx.fillStyle = '#ffffff';
    ctx.font = `${12 * dpr}px Arial`;
    ctx.textAlign = 'center';

    ctx.fillText('0', x, y + barHeight + 15 * dpr);

    const endLabel = params.units >= 1 ? params.units.toString() : params.units.toFixed(2);
    ctx.fillText(endLabel, x + scalebarWidth, y + barHeight + 15 * dpr);

    ctx.font = `${10 * dpr}px Arial`;
    ctx.fillStyle = '#aaaaaa';
    ctx.textAlign = 'left';
    ctx.fillText('units (scale depends on model source)', x, y + barHeight + 30 * dpr);
}
