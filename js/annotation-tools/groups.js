// js/annotation-tools/groups.js
import * as THREE from 'three';
import { state, dom } from '../state.js';
import { generateUUID, escapeHtml, showStatus } from '../utils/helpers.js';
import { renderAnnotations } from './render.js';

// Late-bound references
let _openGroupPopup = null;
let _openAnnotationPopupForEdit = null;

export function setGroupCallbacks({ openGroupPopup, openAnnotationPopupForEdit }) {
    _openGroupPopup = openGroupPopup;
    _openAnnotationPopupForEdit = openAnnotationPopupForEdit;
}

export function createDefaultGroup() {
    if (state.groups.length === 0) {
        state.groups.push({
            id: Date.now(),
            uuid: generateUUID(),
            name: 'Default',
            color: '#EDC040',
            visible: true
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
        dom.btnGroupDelete.style.display = state.groups.length > 1 ? 'block' : 'none';
    } else {
        dom.groupPopupTitle.textContent = 'New Group';
        dom.groupName.value = '';
        dom.groupColor.value = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
        dom.btnGroupDelete.style.display = 'none';
    }

    dom.groupPopup.classList.add('visible');
    dom.groupName.focus();
}

export function saveGroup() {
    const name = dom.groupName.value.trim() || 'Unnamed Group';
    const color = dom.groupColor.value;

    if (state.editingGroup) {
        state.editingGroup.name = name;
        state.editingGroup.color = color;
    } else {
        state.groups.push({
            id: Date.now(),
            uuid: generateUUID(),
            name,
            color,
            visible: true
        });
    }

    dom.groupPopup.classList.remove('visible');
    state.editingGroup = null;
    updateGroupsList();
    updateGroupSelect();
    renderAnnotations();
}

export function deleteGroup(group) {
    if (state.groups.length <= 1) {
        showStatus('Cannot delete the last group');
        return;
    }

    const targetGroup = state.groups.find(g => g.id !== group.id);
    state.annotations.forEach(ann => {
        if (ann.groupId === group.id) {
            ann.groupId = targetGroup.id;
        }
    });

    state.groups = state.groups.filter(g => g.id !== group.id);
    dom.groupPopup.classList.remove('visible');
    state.editingGroup = null;
    updateGroupsList();
    updateGroupSelect();
    renderAnnotations();
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
        ann.points.forEach(p => center.add(new THREE.Vector3(p.x, p.y, p.z)));
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
        return;
    }

    dom.noGroups.style.display = 'none';

    dom.groupsContainer.innerHTML = state.groups.map(group => {
        const groupAnnotations = state.annotations.filter(a => a.groupId === group.id);
        return `
            <div class="group-item" data-id="${group.id}">
                <div class="group-header">
                    <div class="group-color" style="background: ${group.color}" data-action="edit"></div>
                    <span class="group-name" data-action="edit">${escapeHtml(group.name)} (${groupAnnotations.length})</span>
                    <button class="group-visibility ${group.visible ? '' : 'hidden'}" data-action="visibility">
                        ${group.visible ? '👁' : '👁‍🗨'}
                    </button>
                    <div class="group-actions">
                        <button data-action="edit">✏️</button>
                    </div>
                </div>
                ${group.visible ? `
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

            if (action === 'visibility') {
                toggleGroupVisibility(group);
            } else if (action === 'edit') {
                openGroupPopup(group);
            }
        });
    });

    // Use event delegation for click/dblclick to avoid issues with DOM rebuilding
    // Remove old listeners by replacing container content (innerHTML already does this)
    // Attach delegated listeners only once during init, not here
}

// Call this once during initialization to set up delegated event listeners
export function initGroupsEventDelegation() {
    let clickTimeout = null;
    
    dom.groupsContainer.addEventListener('click', (e) => {
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
            selectAnnotation(id, true); // skipRebuild=true to preserve DOM
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
        if (ann && _openAnnotationPopupForEdit) {
            _openAnnotationPopupForEdit(ann);
        }
    });
}

function renderAnnotationItem(ann) {
    const icons = { point: '📍', line: '📏', polygon: '⬡', surface: '🎨' };
    const entryCount = (ann.entries && ann.entries.length) || 0;
    const entryText = entryCount === 1 ? '1 entry' : `${entryCount} entries`;
    return `
        <div class="annotation-item ${state.selectedAnnotation === ann.id ? 'selected' : ''}" data-id="${ann.id}">
            <div class="header">
                <span class="type-icon">${icons[ann.type] || '📍'}</span>
                <span class="name">${escapeHtml(ann.name)}</span>
            </div>
            <div class="description">${entryText}</div>
        </div>
    `;
}

export function updateGroupSelect() {
    dom.annGroup.innerHTML = state.groups.map(g =>
        `<option value="${g.id}">${escapeHtml(g.name)}</option>`
    ).join('');
}
