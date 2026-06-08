// js/metadata/metadata-ui.js - Metadata popup rendering and interaction
import { state, dom } from '../state.js';
import { escapeHtml, showStatus } from '../utils/helpers.js';
import { TEMPLATES, DATA_MANAGEMENT_GUIDELINE, getFieldDefinition, getMetadataStats, createEmptyMetadata } from './templates.js';

/**
 * Initialize the metadata system. Creates empty metadata if none exists.
 */
export function initMetadata() {
    if (!state.modelInfo.metadata) {
        state.modelInfo.metadata = createEmptyMetadata();
    }
}

/**
 * Updates the metadata sidebar subtitle with fill status and preview.
 */
export function updateMetadataDisplay() {
    const subtitle = document.getElementById('metadata-subtitle');
    if (!subtitle) return;

    const metadata = state.modelInfo.metadata;
    if (!metadata || !metadata.sections) {
        subtitle.textContent = 'No metadata yet';
        return;
    }

    const { total, filled } = getMetadataStats(metadata);
    let text = `${filled} of ${total} fields filled`;

    // Preview: show first filled field value
    if (filled > 0) {
        outer:
        for (const section of metadata.sections) {
            for (const field of section.fields) {
                if (field.value && field.value.trim()) {
                    const words = field.value.trim().split(/\s+/);
                    const preview = words.length > 4
                        ? words.slice(0, 4).join(' ') + '\u2026'
                        : field.value.trim();
                    text += ` \u2014 ${preview}`;
                    break outer;
                }
            }
        }
    }

    subtitle.textContent = text;
}

/**
 * Opens the metadata popup directly in edit mode.
 */
export function openMetadataPopup() {
    const popup = document.getElementById('metadata-popup');
    if (!popup) return;

    initMetadata();
    renderMetadataPopup();
    popup.classList.add('visible');
}

/**
 * Closes the metadata popup without saving.
 */
export function closeMetadataPopup() {
    const popup = document.getElementById('metadata-popup');
    if (!popup) return;
    popup.classList.remove('visible');
}

/**
 * Renders the metadata popup content with editable fields.
 */
function renderMetadataPopup() {
    const body = document.getElementById('metadata-popup-body');
    if (!body) return;

    const metadata = state.modelInfo.metadata;
    if (!metadata) return;

    const templateId = metadata.template || '3d-documentation';

    let html = '';

    for (let si = 0; si < metadata.sections.length; si++) {
        const section = metadata.sections[si];
        html += `<div class="metadata-section">`;
        html += `<h4 class="metadata-section-title">${escapeHtml(section.title)}</h4>`;
        html += `<div class="metadata-fields">`;

        // Template fields
        for (let fi = 0; fi < section.fields.length; fi++) {
            const field = section.fields[fi];
            const def = getFieldDefinition(templateId, section.id, field.id);
            const hint = def ? def.hint : '';
            const multiline = def ? def.multiline : false;
            const label = def ? def.label : (field.label || field.id);
            html += renderField(si, fi, label, field.value, hint, multiline, false);
        }

        // Custom fields
        if (section.customFields) {
            for (let ci = 0; ci < section.customFields.length; ci++) {
                const field = section.customFields[ci];
                html += renderField(si, ci, field.label, field.value, '', false, true);
            }
        }

        // Add custom field button
        html += `<div class="metadata-add-field">
            <button class="btn-add-custom-field" data-section="${si}">+ Add custom field</button>
        </div>`;

        html += `</div></div>`;
    }

    // Data Management guideline (always visible, never editable)
    html += `<div class="metadata-section metadata-guideline">`;
    html += `<h4 class="metadata-section-title">Data Management</h4>`;
    html += `<pre class="metadata-guideline-text">${escapeHtml(DATA_MANAGEMENT_GUIDELINE)}</pre>`;
    html += `</div>`;

    body.innerHTML = html;

    // Wire up custom field buttons
    body.querySelectorAll('.btn-add-custom-field').forEach(btn => {
        btn.addEventListener('click', () => {
            saveFieldsToState(); // Preserve current input values before re-render
            const si = parseInt(btn.dataset.section);
            addCustomField(si);
        });
    });
    body.querySelectorAll('.btn-remove-custom-field').forEach(btn => {
        btn.addEventListener('click', () => {
            saveFieldsToState();
            const si = parseInt(btn.dataset.section);
            const ci = parseInt(btn.dataset.customIndex);
            removeCustomField(si, ci);
        });
    });
}

/**
 * Renders a single editable field row.
 */
function renderField(sectionIndex, fieldIndex, key, value, hint, multiline, isCustom) {
    const dataAttr = isCustom
        ? `data-section="${sectionIndex}" data-custom-index="${fieldIndex}"`
        : `data-section="${sectionIndex}" data-field-index="${fieldIndex}"`;

    const escapedValue = escapeHtml(value || '');
    const escapedHint = escapeHtml(hint || '');

    let inputHtml;
    if (isCustom) {
        // Custom field: editable key + value + remove button
        if (multiline || (value && value.includes('\n'))) {
            inputHtml = `<div class="metadata-custom-row">
                <input type="text" class="metadata-custom-key" ${dataAttr} data-role="custom-key" value="${escapeHtml(key)}" placeholder="Field name">
                <button class="btn-remove-custom-field" data-section="${sectionIndex}" data-custom-index="${fieldIndex}" title="Remove field">&times;</button>
            </div>
            <textarea class="metadata-input metadata-textarea" ${dataAttr} data-role="value" placeholder="${escapedHint}">${escapedValue}</textarea>`;
        } else {
            inputHtml = `<div class="metadata-custom-row">
                <input type="text" class="metadata-custom-key" ${dataAttr} data-role="custom-key" value="${escapeHtml(key)}" placeholder="Field name">
                <button class="btn-remove-custom-field" data-section="${sectionIndex}" data-custom-index="${fieldIndex}" title="Remove field">&times;</button>
            </div>
            <input type="text" class="metadata-input" ${dataAttr} data-role="value" value="${escapedValue}" placeholder="${escapedHint}">`;
        }
    } else {
        // Template field: fixed key, editable value
        if (multiline) {
            inputHtml = `<textarea class="metadata-input metadata-textarea" ${dataAttr} data-role="value" placeholder="${escapedHint}">${escapedValue}</textarea>`;
        } else {
            inputHtml = `<input type="text" class="metadata-input" ${dataAttr} data-role="value" value="${escapedValue}" placeholder="${escapedHint}">`;
        }
    }

    return `<div class="metadata-field-row">
        <label class="metadata-label">${escapeHtml(key)}${hint ? ` <span class="metadata-hint">(${escapedHint})</span>` : ''}</label>
        ${inputHtml}
    </div>`;
}

/**
 * Reads all input/textarea values from the popup back into state.
 */
function saveFieldsToState() {
    const body = document.getElementById('metadata-popup-body');
    if (!body || !state.modelInfo.metadata) return;

    // Read template field values
    body.querySelectorAll('.metadata-input[data-field-index]').forEach(input => {
        const si = parseInt(input.dataset.section);
        const fi = parseInt(input.dataset.fieldIndex);
        const value = input.tagName === 'TEXTAREA' ? input.value : input.value;
        if (state.modelInfo.metadata.sections[si] && state.modelInfo.metadata.sections[si].fields[fi]) {
            state.modelInfo.metadata.sections[si].fields[fi].value = value;
        }
    });

    // Read custom field values and keys
    body.querySelectorAll('.metadata-custom-key[data-custom-index]').forEach(input => {
        const si = parseInt(input.dataset.section);
        const ci = parseInt(input.dataset.customIndex);
        if (state.modelInfo.metadata.sections[si] && state.modelInfo.metadata.sections[si].customFields[ci]) {
            state.modelInfo.metadata.sections[si].customFields[ci].label = input.value;
        }
    });
    body.querySelectorAll('.metadata-input[data-custom-index]').forEach(input => {
        const si = parseInt(input.dataset.section);
        const ci = parseInt(input.dataset.customIndex);
        const value = input.tagName === 'TEXTAREA' ? input.value : input.value;
        if (state.modelInfo.metadata.sections[si] && state.modelInfo.metadata.sections[si].customFields[ci]) {
            state.modelInfo.metadata.sections[si].customFields[ci].value = value;
        }
    });
}

/**
 * Saves metadata and closes the popup.
 */
export function saveMetadata() {
    saveFieldsToState();
    updateMetadataDisplay();
    closeMetadataPopup();
    showStatus('Metadata saved');
}

/**
 * Adds a custom field to a section.
 */
function addCustomField(sectionIndex) {
    const section = state.modelInfo.metadata.sections[sectionIndex];
    if (!section) return;
    if (!section.customFields) section.customFields = [];
    section.customFields.push({ label: '', value: '' });
    renderMetadataPopup();

    // Focus the new key input
    const body = document.getElementById('metadata-popup-body');
    const newInputs = body.querySelectorAll(`.metadata-custom-key[data-section="${sectionIndex}"]`);
    if (newInputs.length > 0) {
        newInputs[newInputs.length - 1].focus();
    }
}

/**
 * Removes a custom field from a section.
 */
function removeCustomField(sectionIndex, customIndex) {
    const section = state.modelInfo.metadata.sections[sectionIndex];
    if (!section || !section.customFields) return;
    section.customFields.splice(customIndex, 1);
    renderMetadataPopup();
}
