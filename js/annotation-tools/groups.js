// js/annotation-tools/groups.js
import * as THREE from 'three';
import { state, dom } from '../state.js';
import { getIcon } from '../ui/icons.js';
import { generateUUID, generateInternalId, escapeHtml, showStatus, toDisplayCoords, filterAnnotations } from '../utils/helpers.js';
import { renderAnnotations } from './render.js';
import { applySelectionHighlight } from './selection-highlight.js';
import { showSelectionCallout, hideSelectionCallout } from './selection-callout.js';
import { clearBoxEditState, restoreToolHelp } from '../ui/tool-help.js';

// Group flags are optional and read tolerantly, so groups from older files and
// from every existing constructor need no migration:
//   group.collapsed      absent = expanded       -> read as !!group.collapsed
//   group.labelsVisible  absent = labels shown   -> read as group.labelsVisible !== false

// Late-bound references
let _openGroupPopup = null;
let _openAnnotationPopupForEdit = null;
let _openAnnotationShare = null;
// Runs after every sidebar rebuild (main.js: the survey status chip and an
// open Alignment Manager follow the annotations and alignments from here,
// since every change to them ends with updateGroupsList()).
let _onListUpdated = null;

// Group waiting for a choice in the move-or-delete dialog
let _pendingDeleteGroup = null;

export function setGroupCallbacks({ openGroupPopup, openAnnotationPopupForEdit, openAnnotationShare, onListUpdated = null }) {
    _openGroupPopup = openGroupPopup;
    _openAnnotationPopupForEdit = openAnnotationPopupForEdit;
    _openAnnotationShare = openAnnotationShare;
    _onListUpdated = onListUpdated;
}

export function createDefaultGroup() {
    if (state.groups.length === 0) {
        state.groups.push({
            id: generateInternalId(),
            uuid: generateUUID(),
            name: 'Default',
            color: '#EDC040',
            visible: true,
            opacity: 1.0
        });
        updateGroupsList();
    }
}

export function openGroupPopup(group = null) {
    state.editingGroup = group;

    if (group) {
        dom.groupPopupTitle.textContent = 'Edit Group';
        dom.groupName.value = group.name;
        dom.groupColor.value = group.color;
        const opacityPercent = Math.round((group.opacity !== undefined ? group.opacity : 1.0) * 100);
        dom.groupOpacity.value = opacityPercent;
        dom.groupOpacityValue.textContent = opacityPercent + '%';
        dom.groupLabelsVisible.checked = group.labelsVisible !== false;
        dom.btnGroupDelete.style.display = state.groups.length > 1 ? 'block' : 'none';
    } else {
        dom.groupPopupTitle.textContent = 'New Group';
        dom.groupName.value = '';
        dom.groupColor.value = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
        dom.groupOpacity.value = 100;
        dom.groupOpacityValue.textContent = '100%';
        dom.groupLabelsVisible.checked = true;
        dom.btnGroupDelete.style.display = 'none';
    }

    dom.groupPopup.classList.add('visible');
    dom.groupName.focus();
}

export function saveGroup() {
    const name = dom.groupName.value.trim() || 'Unnamed Group';
    const color = dom.groupColor.value;
    const opacity = parseInt(dom.groupOpacity.value) / 100;
    const labelsVisible = dom.groupLabelsVisible.checked;

    if (state.editingGroup) {
        state.editingGroup.name = name;
        state.editingGroup.color = color;
        state.editingGroup.opacity = opacity;
        state.editingGroup.labelsVisible = labelsVisible;
    } else {
        state.groups.push({
            id: generateInternalId(),
            uuid: generateUUID(),
            name,
            color,
            visible: true,
            opacity,
            labelsVisible
        });
    }

    dom.groupPopup.classList.remove('visible');
    state.editingGroup = null;
    updateGroupsList();
    refreshGroupSelectKeepingChoice();
    renderAnnotations();
}

function annotationCountText(count) {
    return count === 1 ? '1 annotation' : `${count} annotations`;
}

/**
 * Deletes a group. An empty group goes at once; a group that holds annotations
 * opens the move-or-delete dialog, which finishes through confirmGroupDelete().
 * The last remaining group can never be deleted.
 */
export function deleteGroup(group) {
    if (state.groups.length <= 1) {
        showStatus('Cannot delete the last group');
        return;
    }

    const count = state.annotations.filter(a => a.groupId === group.id).length;
    if (count === 0) {
        removeGroup(group);
        showStatus(`Group "${group.name}" deleted`);
        return;
    }

    openGroupDeleteDialog(group, count);
}

function openGroupDeleteDialog(group, count) {
    _pendingDeleteGroup = group;
    dom.groupDeleteMessage.textContent = `Group "${group.name}" has ${annotationCountText(count)}.`;
    // The first other group is preselected: the target the old silent move used.
    dom.groupDeleteTarget.innerHTML = state.groups
        .filter(g => g.id !== group.id)
        .map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`)
        .join('');
    dom.groupDeleteOverlay.classList.add('visible');
}

export function hideGroupDeleteDialog() {
    _pendingDeleteGroup = null;
    dom.groupDeleteOverlay.classList.remove('visible');
}

/**
 * Finishes the move-or-delete dialog.
 * @param {'move'|'delete'} mode 'move' reassigns the group's annotations to the
 *   group chosen in the dialog; 'delete' removes them with the group.
 */
export function confirmGroupDelete(mode) {
    const group = _pendingDeleteGroup;
    hideGroupDeleteDialog();
    // The session may have been replaced while the dialog was open.
    if (!group || !state.groups.includes(group) || state.groups.length <= 1) return;

    const members = state.annotations.filter(a => a.groupId === group.id);

    if (mode === 'move') {
        const targetId = parseInt(dom.groupDeleteTarget.value);
        const target = state.groups.find(g => g.id === targetId && g.id !== group.id)
            || state.groups.find(g => g.id !== group.id);
        members.forEach(ann => { ann.groupId = target.id; });
        removeGroup(group, target.id);
        showStatus(`Group "${group.name}" deleted, ${annotationCountText(members.length)} moved to "${target.name}"`);
    } else if (mode === 'delete') {
        removeAnnotations(members);
        removeGroup(group);
        showStatus(`Group "${group.name}" and ${annotationCountText(members.length)} deleted`);
    }
}

/**
 * Removes annotations and every reference the session holds to them: the
 * selection and its callout, box edit state, and an annotation popup that is
 * showing one of them. The caller re-renders. Used by the group delete and
 * by the Alignment Manager (Delete > Delete points too).
 */
export function removeAnnotations(annotations) {
    const ids = new Set(annotations.map(a => a.id));
    state.annotations = state.annotations.filter(a => !ids.has(a.id));

    // Clears the sidebar highlight, the model emphasis and the callout.
    if (ids.has(state.selectedAnnotation)) deselectAnnotation();

    if (ids.has(state.boxEditUnlocked)) clearBoxEditState();
    if (state.selectedBoxAnnotation && ids.has(state.selectedBoxAnnotation.id)) {
        state.selectedBoxAnnotation = null;
    }

    // The sidebar stays clickable while the annotation popup is open, so it may
    // be showing one of the deleted annotations. A later Save would write into
    // an orphan object.
    if (state.editingAnnotation && ids.has(state.editingAnnotation.id)) {
        dom.annotationPopup.classList.remove('visible');
        state.editingAnnotation = null;
        state.editingModelInfo = false;
        state.isAddingEntry = false;
        state.editingEntryId = null;
        hideInlineGroupForm();
        restoreToolHelp();
        state.controls.enabled = true;
    }
}

function removeGroup(group, fallbackGroupId = null) {
    state.groups = state.groups.filter(g => g.id !== group.id);
    dom.groupPopup.classList.remove('visible');
    state.editingGroup = null;
    updateGroupsList();
    refreshGroupSelectKeepingChoice(fallbackGroupId);
    renderAnnotations();
}

/**
 * Rebuilds the annotation popup's group select but keeps its current choice,
 * so a popup left open across a group change still saves into the group it
 * shows. A choice that pointed at a removed group falls back to
 * fallbackGroupId (the move target), else to the first group.
 */
function refreshGroupSelectKeepingChoice(fallbackGroupId = null) {
    const previousId = parseInt(dom.annGroup.value);
    updateGroupSelect();
    const keepId = state.groups.some(g => g.id === previousId) ? previousId : fallbackGroupId;
    if (keepId !== null && state.groups.some(g => g.id === keepId)) {
        dom.annGroup.value = keepId;
    }
}

export function toggleGroupCollapsed(group) {
    group.collapsed = !group.collapsed;
    updateGroupsList();
}

export function toggleGroupVisibility(group) {
    group.visible = !group.visible;
    updateGroupsList();
    renderAnnotations();
}

export function selectAnnotation(id, skipRebuild = false) {
    state.selectedAnnotation = id;
    const ann = state.annotations.find(a => a.id === id);

    if (ann && ann.points.length > 0) {
        const center = new THREE.Vector3();
        ann.points.forEach(p => {
            const dp = toDisplayCoords(p);
            center.add(new THREE.Vector3(dp.x, dp.y, dp.z));
        });
        center.divideScalar(ann.points.length);
        state.controls.target.copy(center);
        state.controls.update();
    }

    if (!skipRebuild) {
        updateGroupsList();
    } else {
        // Just update the visual selection without rebuilding DOM
        updateSelectionHighlight(id);
    }

    // Emphasise the annotation in the model and raise its callout.
    applySelectionHighlight();
    if (ann) showSelectionCallout(ann);
}

/**
 * Clears the current selection: sidebar highlight, model emphasis and callout.
 *
 * Deliberately does NOT move the camera — deselecting should leave the view
 * exactly where the user put it.
 *
 * @param {{skipRebuild?: boolean}} [options] Pass skipRebuild: false to rebuild
 *   the whole sidebar list instead of just stripping the selected class.
 */
export function deselectAnnotation({ skipRebuild = true } = {}) {
    if (state.selectedAnnotation === null) return;

    state.selectedAnnotation = null;

    if (skipRebuild) {
        updateSelectionHighlight(null);
    } else {
        updateGroupsList();
    }

    applySelectionHighlight();
    hideSelectionCallout();
}

function updateSelectionHighlight(selectedId) {
    // Remove selected class from all items
    dom.groupsContainer.querySelectorAll('.annotation-item').forEach(item => {
        item.classList.remove('selected');
    });
    // Add selected class to the newly selected item
    const selectedItem = dom.groupsContainer.querySelector(`.annotation-item[data-id="${selectedId}"]`);
    if (selectedItem) {
        selectedItem.classList.add('selected');
    }
}

export function updateGroupsList() {
    if (state.groups.length === 0) {
        dom.noGroups.style.display = 'block';
        dom.groupsContainer.innerHTML = '';
        if (_onListUpdated) _onListUpdated();
        return;
    }

    dom.noGroups.style.display = 'none';

    // While a search term is active, collapsed groups render their items too,
    // so the filter below can reveal matches inside them. Hidden groups never
    // render items.
    const searching = !!(dom.searchInput && dom.searchInput.value.trim());

    dom.groupsContainer.innerHTML = state.groups.map(group => {
        const groupAnnotations = state.annotations.filter(a => a.groupId === group.id);
        const collapsed = !!group.collapsed;
        const showItems = group.visible && (!collapsed || searching);
        return `
            <div class="group-item ${collapsed ? 'collapsed' : ''}" data-id="${group.id}">
                <div class="group-header">
                    <button class="group-collapse ${collapsed ? 'collapsed' : ''}" data-action="collapse" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'}" title="${collapsed ? 'Expand' : 'Collapse'}">
                        ${getIcon('chevron') || '▾'}
                    </button>
                    <div class="group-color" style="background: ${group.color}" data-action="edit"></div>
                    <span class="group-name" data-action="edit">${escapeHtml(group.name)} (${groupAnnotations.length})</span>
                    <button class="group-visibility ${group.visible ? '' : 'hidden'}" data-action="visibility">
                        ${group.visible ? getIcon('eyeOpen') : getIcon('eyeClosed')}
                    </button>
                    <div class="group-actions">
                        <button data-action="edit">${getIcon('edit')}</button>
                    </div>
                </div>
                ${showItems ? `
                    <div class="annotation-list">
                        ${groupAnnotations.map(ann => renderAnnotationItem(ann)).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');

    dom.groupsContainer.querySelectorAll('.group-header').forEach(header => {
        header.addEventListener('click', (e) => {
            const groupId = parseInt(header.closest('.group-item').dataset.id);
            const group = state.groups.find(g => g.id === groupId);
            const action = e.target.dataset.action || e.target.closest('[data-action]')?.dataset.action;

            if (action === 'collapse') {
                toggleGroupCollapsed(group);
            } else if (action === 'visibility') {
                toggleGroupVisibility(group);
            } else if (action === 'edit') {
                openGroupPopup(group);
            }
        });
    });

    // A rebuild starts from unfiltered markup; keep the current search applied.
    filterAnnotations(dom.searchInput ? dom.searchInput.value : '');

    if (_onListUpdated) _onListUpdated();

    // Use event delegation for click/dblclick to avoid issues with DOM rebuilding
    // Remove old listeners by replacing container content (innerHTML already does this)
    // Attach delegated listeners only once during init, not here
}

// Call this once during initialization to set up delegated event listeners
export function initGroupsEventDelegation() {
    let clickTimeout = null;
    
    dom.groupsContainer.addEventListener('click', (e) => {
        // Share button: open the per-annotation share dialog immediately, no delay
        const shareBtn = e.target.closest('[data-action="share-annotation"]');
        if (shareBtn) {
            const item = shareBtn.closest('.annotation-item');
            if (!item) return;
            const id = parseInt(item.dataset.id);
            const ann = state.annotations.find(a => a.id === id);
            if (ann && _openAnnotationShare) {
                _openAnnotationShare(ann);
            }
            return;
        }

        // Edit button: open annotation popup immediately, no delay. The
        // callout stands down first — editing and the callout are alternative
        // views of the same annotation, never shown together.
        const editBtn = e.target.closest('[data-action="edit-annotation"]');
        if (editBtn) {
            const item = editBtn.closest('.annotation-item');
            if (!item) return;
            const id = parseInt(item.dataset.id);
            const ann = state.annotations.find(a => a.id === id);
            deselectAnnotation();
            if (ann && _openAnnotationPopupForEdit) {
                _openAnnotationPopupForEdit(ann);
            }
            return;
        }

        const item = e.target.closest('.annotation-item');
        if (!item) return;
        
        // Clear any pending single-click action
        if (clickTimeout) {
            clearTimeout(clickTimeout);
            clickTimeout = null;
        }
        
        // Delay single-click action to allow dblclick to fire first
        clickTimeout = setTimeout(() => {
            const id = parseInt(item.dataset.id);
            // Clicking the already-selected item toggles the selection off.
            if (state.selectedAnnotation === id) {
                deselectAnnotation();
            } else {
                selectAnnotation(id, true); // skipRebuild=true to preserve DOM
            }
            clickTimeout = null;
        }, 200);
    });
    
    dom.groupsContainer.addEventListener('dblclick', (e) => {
        const item = e.target.closest('.annotation-item');
        if (!item) return;
        
        // Cancel the pending single-click action
        if (clickTimeout) {
            clearTimeout(clickTimeout);
            clickTimeout = null;
        }
        
        const id = parseInt(item.dataset.id);
        const ann = state.annotations.find(a => a.id === id);
        deselectAnnotation();
        if (ann && _openAnnotationPopupForEdit) {
            _openAnnotationPopupForEdit(ann);
        }
    });
}

function renderAnnotationItem(ann) {
    const icons = { point: getIcon('point'), line: getIcon('line'), polygon: getIcon('polygon'), surface: getIcon('surface'), box: getIcon('box') };
    const entryCount = (ann.entries && ann.entries.length) || 0;
    const entryText = entryCount === 1 ? '1 entry' : `${entryCount} entries`;

    let previewHtml = '';
    if (entryCount > 0) {
        const newest = ann.entries[entryCount - 1];
        const desc = (newest.description || '').trim();
        if (desc) {
            const words = desc.split(/\s+/);
            const preview = words.length > 4
                ? words.slice(0, 4).join(' ') + '\u2026'
                : desc;
            previewHtml = ` — ${escapeHtml(preview)}`;
        }
    }

    // Persistent position lock. Like the other sidebar icons it is empty until
    // the icons have loaded; main.js rebuilds the list then.
    const lockHtml = ann.locked === true
        ? `<span class="annotation-lock" title="Position locked" aria-label="Position locked">${getIcon('lock')}</span>`
        : '';

    return `
        <div class="annotation-item ${state.selectedAnnotation === ann.id ? 'selected' : ''}" data-id="${ann.id}">
            <div class="header">
                <span class="type-icon">${icons[ann.type] || getIcon('point')}</span>
                <span class="name">${escapeHtml(ann.name)}</span>
                ${lockHtml}
                <button class="annotation-edit-btn" data-action="edit-annotation" title="Edit annotation">${getIcon('edit')}</button>
                <button class="annotation-share-btn" data-action="share-annotation" title="Share this annotation">${getIcon('share')}</button>
            </div>
            <div class="description">${entryText}${previewHtml}</div>
        </div>
    `;
}

export function updateGroupSelect() {
    dom.annGroup.innerHTML = state.groups.map(g =>
        `<option value="${g.id}">${escapeHtml(g.name)}</option>`
    ).join('');
}

/**
 * Creates a new group inline from the annotation popup and selects it.
 * This allows users to create a group on-the-fly while creating an annotation.
 * @returns {Object} The newly created group
 */
export function createGroupInline() {
    const name = dom.inlineGroupName.value.trim() || 'Unnamed Group';
    const color = dom.inlineGroupColor.value;

    const newGroup = {
        id: generateInternalId(),
        uuid: generateUUID(),
        name,
        color,
        visible: true,
        opacity: 1.0
    };

    state.groups.push(newGroup);
    
    // Update the group select dropdown and select the new group
    updateGroupSelect();
    dom.annGroup.value = newGroup.id;
    
    // Update the sidebar groups list
    updateGroupsList();
    
    // Hide the inline form and reset it
    hideInlineGroupForm();
    
    showStatus(`Group "${name}" created`);
    
    return newGroup;
}

/**
 * Shows the inline group creation form in the annotation popup
 */
export function showInlineGroupForm() {
    // Generate a random color for the new group
    dom.inlineGroupColor.value = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    dom.inlineGroupName.value = '';
    dom.inlineNewGroupForm.classList.add('visible');
    dom.inlineGroupName.focus();
}

/**
 * Hides the inline group creation form and resets its values
 */
export function hideInlineGroupForm() {
    dom.inlineNewGroupForm.classList.remove('visible');
    dom.inlineGroupName.value = '';
    dom.inlineGroupColor.value = '#EDC040';
}
