// js/annotation-tools/survey-block.js - The Surveyed position block, shared by the edit popup and the read-only viewer
// Built with createElement/textContent only: names, raw values, attribute keys
// and values and file names come from a CSV file and are never parsed as
// markup. The text itself comes from the pure js/survey/survey-display.js.
import { surveyedPositionView } from '../survey/survey-display.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Fills container with the Surveyed position block of a survey point, or
 * empties and hides it for any other annotation.
 * @param {HTMLElement} container
 * @param {Object} ann
 * @param {Object[]} alignments - state.alignments (to resolve survey.alignmentId)
 * @returns {boolean} true when a block is shown
 */
export function renderSurveyBlock(container, ann, alignments) {
    if (!container) return false;
    container.textContent = '';

    const view = surveyedPositionView(ann, alignments);
    if (!view) {
        container.style.display = 'none';
        return false;
    }

    container.appendChild(el('div', 'survey-block-title', view.title));

    const rows = el('dl', 'survey-block-rows');
    view.rows.forEach(row => {
        rows.appendChild(el('dt', '', row.label));
        const value = el('dd', '', row.value);
        if (row.key === 'alignment' && view.detached) value.classList.add('survey-muted');
        if (row.key === 'surface' && view.note) value.title = view.note;
        rows.appendChild(value);
    });
    container.appendChild(rows);

    if (view.note) container.appendChild(el('div', 'survey-block-note', view.note));

    // Kept CSV columns, collapsed by default (the version-history toggle pattern).
    if (view.attributes.length > 0) {
        const toggle = el('button', 'survey-attr-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.appendChild(el('span', 'toggle-icon', '▶'));
        toggle.appendChild(el('span', '', 'Attributes'));
        toggle.appendChild(el('span', 'survey-attr-count', String(view.attributes.length)));

        const list = el('dl', 'survey-attr-list');
        view.attributes.forEach(attr => {
            list.appendChild(el('dt', '', attr.key));
            list.appendChild(el('dd', '', attr.value));
        });

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const expanded = toggle.classList.toggle('expanded');
            toggle.setAttribute('aria-expanded', String(expanded));
        });

        container.appendChild(toggle);
        container.appendChild(list);
    }

    container.style.display = '';
    return true;
}
