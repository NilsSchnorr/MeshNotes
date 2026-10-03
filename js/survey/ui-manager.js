// js/survey/ui-manager.js - The Alignment Manager, the status chip, the selection step, creating the points and the summary
// The selection step (Step D) places every row of an import job with its
// alignment, measures each fitted position's distance to the surface (in
// chunks, with a progress line) and lists the rows nearest first, ticked when
// within the distance limit. The limit can be changed for this import only
// (the setting stays the default), rows can be ticked one by one, or all
// imported. When no row lies near the surface the dialog asks whether the
// coordinate system or the mapping is wrong and offers Swap when E/N swapped
// would fit. Importing turns the ticked rows into locked point annotations
// (survey-import.js) and shows the summary.
//
// The status chip beside the face count shows the model's alignments (none,
// one with its RMS, or how many) and opens the Alignment Manager: per
// alignment its name, label, height column, control points, RMS, points and
// binding warnings, and the actions View control points (read-only review
// in a side panel, pick markers on the model), Rename (metadata only),
// Refine and Re-align from scratch (the picking panel of ui-alignment.js,
// then a preview of how far the points move), Set as default and Delete
// (detach or delete the points). The logic is in manager.js (pure).
//
// The import job comes from the mapping dialog (shape in ui-mapping.js).
// Names, cells, file names, alignment names and labels are user text:
// everything is built with createElement and textContent.

import { state, dom } from '../state.js';
import { showStatus, getLastAuthor, getDefaultLanguage } from '../utils/helpers.js';
import { saveSurveyMapping } from '../core/lighting.js';
import { updateGroupsList, updateGroupSelect, removeAnnotations } from '../annotation-tools/groups.js';
import { renderAnnotations } from '../annotation-tools/render.js';
import { showConfirm } from '../annotation-tools/data.js';
import { renderSurveyBlock } from '../annotation-tools/survey-block.js';
import { refreshViewerSurveyBlock } from '../annotation-tools/annotation-viewer.js';
import { getIcon } from '../ui/icons.js';
import {
    checkDuplicates, swapWouldFit, crsDisplayLabel, refineAlignment, realignAlignment, planRefinePlacement,
    editAlignmentMetadata, surveyPointsOf, bindingWarnings, DUPLICATE_STATUS, SELECTION_METHODS
} from './alignment.js';
import { swapMappingEN } from './column-mapping.js';
import { SELECTION_LIMIT_DEFAULT, RESIDUAL_WARN_DEFAULT } from './rigid-fit.js';
import { findAlignment, formatCoordinate, formatMetres } from './survey-display.js';
import {
    fittedStoragePositions, measureSurfaceDistances, remeasureForLimit, classifyMeasurement, searchRadiusForLimit,
    surfacePlacements, planSurveyCreation, commitSurveyImport, surveyImportSummary, surveySummaryText,
    selectionDistanceText, surveyPointName, jobWithMapping, fileBaseName, metresShort,
    applyReplacement, applyReplacementChunked, SURFACE_CHUNK_SIZE
} from './survey-import.js';
import { picksFromControlPoints, FIT_TYPE_LABELS } from './picking.js';
import {
    alignmentChipView, managerRows, alignmentReview, refineRows, refineWouldMove, refinePreview, refineStatusText,
    refineUnchanged, refinePlanFromPositions, rmsChangeText, readOnlyMessages, deleteAlignment, deleteMessage, alignmentDisplayName
} from './manager.js';
import { initSurveyMapping, reopenSurveyMapping, closeSurveyMapping, isSurveyMappingOpen, startNewAlignmentPending } from './ui-mapping.js';
import { openPickingPanel, isSurveyPickingOpen, showAlignmentOverlay, clearAlignmentOverlay } from './ui-alignment.js';

// The selection step while its dialog is open:
// { job, alignment, model, limit, positions, measurement, classification,
//   ticked: boolean[] (per record), duplicates (checkDuplicates per record, for
//   the notes), swapFits, showRows, busy, controller (AbortController) }
let _sel = null;

// Text of the summary on screen, for the Copy button
let _summaryText = '';

// The import summary's note after Swap in the selection step
const SELECTION_SWAP_NOTE = 'Easting and Northing were swapped in the selection step.';

const VERDICT_LABELS = { good: 'Good', check: 'Check', poor: 'Poor' };

// The Alignment Manager while open: { editId (alignment whose name and label
// form is open, or null), editName, editCrs (the form's values, kept across
// redraws) }, or null.
let _mgr = null;

// The refine preview while open: { kind 'refine'|'realign', previous, refined,
// plan, model, busy, controller }, or null. The refined alignment is already
// saved; the preview only decides whether the points follow it.
let _refine = null;

// Alignment id waiting for a choice in the delete dialog
let _pendingDeleteId = null;

// The control-point view: the alignment id shown, and the alignment object
// whose markers are on the model (redrawn when the alignment changes).
let _viewId = null;
let _viewShown = null;

// What the status chip shows, so a redraw only touches the DOM on a change
let _chipKey = '';

// Late-bound picking step for a new alignment (main.js)
let _startNewAlignment = startNewAlignmentPending;

export function setSurveyManagerCallbacks({ startNewAlignment } = {}) {
    if (startNewAlignment) _startNewAlignment = startNewAlignment;
}

// ============ Small helpers ============

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(className, text, data = {}) {
    const b = el('button', className, text);
    b.type = 'button';
    Object.assign(b.dataset, data);
    return b;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const degrees = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}°` : '—');
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}` : '—');

function residualWarn() {
    const v = state.surveyResidualWarn;
    return typeof v === 'number' && v > 0 ? v : RESIDUAL_WARN_DEFAULT;
}

function validLimit(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : SELECTION_LIMIT_DEFAULT;
}

function progressFor(sel, label) {
    return (done, total) => {
        if (_sel === sel) dom.surveySelectProgress.textContent = `${label}: ${done} of ${total}`;
    };
}

function setBusy(sel, busy) {
    if (_sel !== sel) return;
    sel.busy = busy;
    if (!busy) dom.surveySelectProgress.textContent = '';
    updateSelectionButtons();
}

// The model or the alignment changed under a running step: stop it.
function sessionStillValid(sel) {
    if (state.currentModel !== sel.model) {
        abortSelection();
        showStatus('Survey import cancelled: another model was loaded');
        return false;
    }
    if (!findAlignment(state.alignments, sel.alignment.id)) {
        abortSelection();
        showStatus('Survey import cancelled: the alignment was removed');
        return false;
    }
    return true;
}

function runFailed(sel, error) {
    if (_sel !== sel) return;   // closed meanwhile (Cancel, Escape, Back)
    if (error && error.name === 'AbortError' && state.currentModel !== sel.model) {
        abortSelection();
        showStatus('Survey import cancelled: another model was loaded');
        return;
    }
    console.error('Survey selection step failed:', error);
    setBusy(sel, false);
    dom.surveySelectProgress.textContent = `Stopped: ${error && error.message ? error.message : error}`;
}

// ============ Selection step ============

/**
 * Opens the selection step for an import job into an existing alignment.
 * @param {object} job - from the mapping dialog (shape in ui-mapping.js), target.kind 'existing'
 * @param {{limit?: number}} [options] - limit: keep this distance limit (after Swap)
 */
export function startSurveySelection(job, { limit = null } = {}) {
    abortSelection();
    const alignment = job && job.target ? findAlignment(state.alignments, job.target.alignmentId) : null;
    if (!alignment || !state.currentModel) {
        reopenSurveyMapping(job, {
            notice: alignment ? 'Load a model before importing survey points.' : 'The chosen alignment no longer exists. Choose another one.'
        });
        return;
    }
    const sel = {
        job, alignment, model: state.currentModel,
        limit: validLimit(limit ?? state.surveySurfaceLimit),
        positions: null, measurement: null, classification: null, ticked: [],
        duplicates: checkDuplicates(
            job.records.map(r => ({ name: surveyPointName(r, job.file.name), row: r.row, e: r.e, n: r.n, h: r.h })),
            state.annotations, { alignmentId: alignment.id, fileSha256: job.file.sha256 }),
        swapFits: false, showRows: false, busy: false, controller: null
    };
    _sel = sel;
    dom.surveySelectLimit.value = String(sel.limit);
    dom.surveySelectRows.textContent = '';
    dom.surveySelectProgress.textContent = '';
    dom.surveySelectOverlay.classList.add('visible');
    dom.surveySelectClose.focus({ preventScroll: true });
    renderSelection();
    measureAll(sel);
}

async function measureAll(sel) {
    const { job, alignment } = sel;
    setBusy(sel, true);
    const controller = new AbortController();
    sel.controller = controller;
    try {
        sel.positions = fittedStoragePositions(job.records, alignment);
        sel.measurement = await measureSurfaceDistances(sel.positions, {
            maxDistance: searchRadiusForLimit(sel.limit),
            signal: controller.signal,
            onProgress: progressFor(sel, 'Measuring the distance to the surface')
        });
        if (_sel !== sel) return;
        classify(sel);
        sel.swapFits = false;
        if (sel.classification.onModelCount === 0) {
            const swapped = fittedStoragePositions(job.records, alignment, { swapEN: true });
            const m = await measureSurfaceDistances(swapped, {
                maxDistance: sel.measurement.searchRadius,
                signal: controller.signal,
                onProgress: progressFor(sel, 'Trying Easting and Northing swapped')
            });
            if (_sel !== sel) return;
            sel.swapFits = swapWouldFit(sel.classification, classifyMeasurement(job.records, swapped, m, { limit: sel.limit }));
        }
    } catch (e) {
        runFailed(sel, e);
        return;
    }
    sel.controller = null;
    setBusy(sel, false);
    renderSelection();
}

// Classifies the rows for the current limit; the ticks follow the limit
// again (ticks set by hand are reset when the limit changes).
function classify(sel) {
    sel.classification = classifyMeasurement(sel.job.records, sel.positions, sel.measurement, { limit: sel.limit });
    sel.ticked = new Array(sel.job.records.length).fill(false);
    for (const row of sel.classification.rows) sel.ticked[row.index] = row.ticked;
}

async function applyLimit() {
    const sel = _sel;
    if (!sel || sel.busy || !sel.measurement) return;
    const value = parseFloat(dom.surveySelectLimit.value);
    if (!Number.isFinite(value) || value < 0) {
        dom.surveySelectLimit.value = String(sel.limit);
        return;
    }
    if (value === sel.limit) return;
    setBusy(sel, true);
    const controller = new AbortController();
    sel.controller = controller;
    try {
        sel.measurement = await remeasureForLimit(sel.positions, sel.measurement, value, {
            signal: controller.signal,
            onProgress: progressFor(sel, 'Measuring the rows farther away')
        });
    } catch (e) {
        // The old limit still matches the measurement and the ticks.
        if (_sel === sel) dom.surveySelectLimit.value = String(sel.limit);
        runFailed(sel, e);
        return;
    }
    if (_sel !== sel) return;
    sel.controller = null;
    sel.limit = value;
    classify(sel);
    setBusy(sel, false);
    renderSelection();
}

// Duplicate notes are computed over all rows; a match with another row of
// the file only applies when both rows are imported.
function noteFor(sel, row) {
    const parts = [];
    if (!row.onModel) parts.push('off the model');
    const d = sel.duplicates[row.index];
    const other = d && d.match && Number.isInteger(d.match.index) ? sel.job.records[d.match.index] : null;
    if (d && d.status === DUPLICATE_STATUS.DUPLICATE) {
        parts.push(other ? `same as row ${other.row}, skipped when both are imported` : 'already imported, skipped');
    } else if (d && d.status === DUPLICATE_STATUS.NAME_CONFLICT) {
        parts.push(other ? `same name as row ${other.row}` : 'name already in use');
    }
    return parts.join(', ');
}

function cell(text, className = '') {
    const td = el('td', className, text);
    if (text) td.title = text;
    return td;
}

// Returns the number of distances shown as beyond the warning distance.
function renderRows(sel) {
    const tbody = dom.surveySelectRows;
    tbody.textContent = '';
    const fragment = document.createDocumentFragment();
    const warn = state.surveySurfaceWarn;
    let warned = 0;
    for (const row of sel.classification.rows) {
        const r = row.record;
        const tr = document.createElement('tr');
        if (!row.onModel) tr.className = 'survey-row-off';
        const tick = document.createElement('td');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.index = String(row.index);
        box.checked = sel.ticked[row.index];
        box.setAttribute('aria-label', `Import row ${r.row}`);
        tick.appendChild(box);
        tr.appendChild(tick);
        tr.appendChild(cell(String(r.row), 'survey-num'));
        tr.appendChild(cell(surveyPointName(r, sel.job.file.name)));
        const distance = cell(selectionDistanceText(row, sel.measurement), 'survey-num');
        if (row.method === SELECTION_METHODS.SURFACE && Number.isFinite(row.distance) && Math.abs(row.distance) > warn) {
            distance.classList.add('survey-dist-warn');
            warned++;
        }
        tr.appendChild(distance);
        tr.appendChild(cell(formatCoordinate(r.e), 'survey-num'));
        tr.appendChild(cell(formatCoordinate(r.n), 'survey-num'));
        tr.appendChild(cell(formatCoordinate(r.h), 'survey-num'));
        tr.appendChild(cell(noteFor(sel, row)));
        fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
    return warned;
}

function renderSelection() {
    const sel = _sel;
    if (!sel) return;
    const { job, alignment } = sel;
    dom.surveySelectSubtitle.textContent = `${job.file.name} → ${alignment.name || 'Unnamed alignment'} (${crsDisplayLabel(alignment)})`;
    const c = sel.classification;
    if (!c) {
        dom.surveySelectSummary.textContent = `Placing ${plural(job.records.length, 'row')} with the alignment…`;
        dom.surveySelectNomatch.classList.remove('visible');
        dom.surveySelectTableWrap.style.display = 'none';
        updateSelectionButtons();
        return;
    }
    const measured = sel.measurement.measured;
    const noMatch = c.onModelCount === 0 && !sel.showRows;
    const warned = noMatch ? 0 : renderRows(sel);
    dom.surveySelectSummary.textContent =
        `${c.onModelCount} of ${c.total} rows lie within ${metresShort(sel.limit)} of the model ${measured ? 'surface' : 'bounding box'}.` +
        (measured ? '' : ' The model has no surface query (BVH): the points will stay at their fitted positions.') +
        (warned ? ` Distances in orange are more than ${metresShort(state.surveySurfaceWarn)} from the surface.` : '');

    dom.surveySelectNomatch.classList.toggle('visible', noMatch);
    if (noMatch) {
        dom.surveySelectNomatchText.textContent =
            `No row lies within ${metresShort(sel.limit)} of the model. Is the coordinate system or the column mapping wrong? ` +
            'A file in another coordinate system or height datum needs its own alignment.' +
            (sel.swapFits ? ' With Easting and Northing swapped, rows land on the model.' : '');
        dom.surveySelectSwap.style.display = sel.swapFits ? '' : 'none';
    }
    dom.surveySelectTableWrap.style.display = noMatch ? 'none' : '';
    updateSelectionButtons();
}

function tickedIndices(sel) {
    const out = [];
    sel.ticked.forEach((t, i) => { if (t) out.push(i); });
    return out;
}

function updateSelectionButtons() {
    const sel = _sel;
    if (!sel) return;
    const ready = !!sel.classification && !sel.busy;
    // While the no-match question is showing, the rows are hidden: nothing
    // can be imported until 'Show the rows'.
    const rowsShown = ready && (sel.classification.onModelCount > 0 || sel.showRows);
    const total = sel.job.records.length;
    const count = sel.classification ? tickedIndices(sel).length : 0;
    dom.surveySelectImport.textContent = `Import ${count} ticked`;
    dom.surveySelectImport.disabled = !rowsShown || count === 0;
    dom.surveySelectImportAll.textContent = `Import all ${total}`;
    dom.surveySelectImportAll.disabled = !rowsShown || total === 0;
    dom.surveySelectLimit.disabled = !ready;
    dom.surveySelectAll.disabled = !ready;
    dom.surveySelectAll.checked = total > 0 && count === total;
    dom.surveySelectAll.indeterminate = count > 0 && count < total;
    [dom.surveySelectSwap, dom.surveySelectNewAlignment, dom.surveySelectRemap, dom.surveySelectShowRows]
        .forEach(button => { button.disabled = sel.busy; });
}

function onRowTick(e) {
    const sel = _sel;
    if (!sel || e.target.type !== 'checkbox') return;
    const index = parseInt(e.target.dataset.index, 10);
    if (!Number.isInteger(index)) return;
    if (sel.busy) {
        e.target.checked = sel.ticked[index];
        return;
    }
    sel.ticked[index] = e.target.checked;
    updateSelectionButtons();
}

function onTickAll() {
    const sel = _sel;
    if (!sel || !sel.classification || sel.busy) return;
    const value = dom.surveySelectAll.checked;
    sel.ticked = sel.ticked.map(() => value);
    dom.surveySelectRows.querySelectorAll('input[type="checkbox"]').forEach(box => { box.checked = value; });
    updateSelectionButtons();
}

function swapAndMeasure() {
    const sel = _sel;
    if (!sel || sel.busy) return;
    const job = jobWithMapping(sel.job, swapMappingEN(sel.job.mapping));
    job.acceptedWarnings = [...(sel.job.acceptedWarnings || []), SELECTION_SWAP_NOTE];
    startSurveySelection(job, { limit: sel.limit });
}

function backToMapping() {
    const sel = _sel;
    if (!sel) return;
    const job = sel.job;
    abortSelection();
    reopenSurveyMapping(job);
}

function newAlignmentFromSelection() {
    const sel = _sel;
    if (!sel) return;
    // The binding and height-column warnings belong to the old target
    // alignment; only a swap made here still applies to the new one.
    const job = {
        ...sel.job,
        target: { kind: 'new', name: fileBaseName(sel.job.file.name), crsLabel: '' },
        acceptedWarnings: (sel.job.acceptedWarnings || []).filter(w => w === SELECTION_SWAP_NOTE)
    };
    abortSelection();
    _startNewAlignment(job);
}

function cancelSelection() {
    if (!_sel) return;
    abortSelection();
    showStatus('Survey import cancelled');
}

// Closes the selection dialog and stops a running measurement.
function abortSelection() {
    const sel = _sel;
    _sel = null;
    if (sel && sel.controller) sel.controller.abort();
    dom.surveySelectOverlay.classList.remove('visible');
    dom.surveySelectRows.textContent = '';
    dom.surveySelectProgress.textContent = '';
}

// ============ Creating the points ============

function refreshAfterImport(result) {
    if (result.groupCreated) {
        // updateGroupSelect() rebuilds #ann-group; keep an open popup's choice.
        const previous = dom.annGroup.value;
        updateGroupSelect();
        if (previous && Array.from(dom.annGroup.options).some(o => o.value === previous)) dom.annGroup.value = previous;
    }
    updateGroupsList();
    renderAnnotations();
}

async function createPoints(indices) {
    const sel = _sel;
    if (!sel || sel.busy || !sel.classification || indices.length === 0) return;
    if (!sessionStillValid(sel)) return;
    const { job, alignment } = sel;
    const plan = planSurveyCreation(indices.map(i => ({ index: i, record: job.records[i] })), {
        fileName: job.file.name, alignmentId: alignment.id, fileSha256: job.file.sha256, annotations: state.annotations
    });

    setBusy(sel, true);
    const controller = new AbortController();
    sel.controller = controller;
    let placements;
    try {
        placements = await surfacePlacements(sel.positions, sel.measurement, plan.create.map(c => c.index), {
            signal: controller.signal,
            onProgress: progressFor(sel, 'Placing the points on the surface')
        });
    } catch (e) {
        runFailed(sel, e);
        return;
    }
    if (_sel !== sel || !sessionStillValid(sel)) return;

    // Everything below runs in one go: nothing is added until here.
    const result = commitSurveyImport({
        plan, placements,
        alignmentId: alignment.id,
        fileName: job.file.name,
        fileSha256: job.file.sha256,
        codeColumn: job.codeColumn,
        group: job.group,
        author: getLastAuthor(),
        language: getDefaultLanguage(),
        locked: state.surveyLockImported !== false,
        labelsOffAbove: state.surveyLabelsOffAbove,
        importedAt: new Date().toISOString()
    });
    refreshAfterImport(result);
    saveSurveyMapping(job.signature, job.mapping);

    const summary = surveyImportSummary({
        job, alignment, plan, result,
        classification: sel.classification,
        ticked: indices,
        measurement: sel.measurement,
        limit: sel.limit,
        surfaceWarn: state.surveySurfaceWarn,
        labelsOffAbove: state.surveyLabelsOffAbove,
        acceptedWarnings: job.acceptedWarnings || []
    });
    abortSelection();
    showSurveySummary(summary);
    showStatus(result.created.length
        ? `Imported ${plural(result.created.length, 'survey point')} into "${result.group.name}"`
        : 'No survey points imported');
}

function importTicked() {
    if (_sel) createPoints(tickedIndices(_sel));
}

function importAll() {
    if (_sel) createPoints(_sel.job.records.map((_, i) => i));
}

// ============ Summary ============

function figure(value, label) {
    const box = el('div', 'survey-figure');
    box.appendChild(el('div', 'survey-figure-value', String(value)));
    box.appendChild(el('div', 'survey-figure-label', label));
    return box;
}

function rowList(title, items, detailOf) {
    const fragment = document.createDocumentFragment();
    if (!items.length) return fragment;
    fragment.appendChild(el('h4', '', `${title} (${items.length})`));
    const list = el('ul', 'survey-summary-list');
    for (const item of items) {
        const li = document.createElement('li');
        li.appendChild(el('span', 'survey-summary-row', `Row ${item.row}`));
        li.appendChild(document.createTextNode([item.name, detailOf(item)].filter(Boolean).join(' · ')));
        list.appendChild(li);
    }
    fragment.appendChild(list);
    return fragment;
}

/**
 * Shows the import summary (plan: Step D, 3).
 * @param {object} summary - surveyImportSummary()
 */
export function showSurveySummary(summary) {
    _summaryText = surveySummaryText(summary);
    dom.surveySummarySubtitle.textContent = `${summary.fileName} → ${summary.alignmentName} (${summary.crsLabel})`;

    const figures = dom.surveySummaryFigures;
    figures.textContent = '';
    figures.appendChild(figure(summary.imported, summary.imported === 1 ? 'point imported' : 'points imported'));
    figures.appendChild(figure(summary.offModel.length, 'off the model'));
    if (summary.unticked.length) figures.appendChild(figure(summary.unticked.length, 'unticked'));
    figures.appendChild(figure(summary.skipped.length, 'skipped'));
    figures.appendChild(figure(summary.warnings.length, summary.warnings.length === 1 ? 'warning' : 'warnings'));

    const details = dom.surveySummaryDetails;
    details.textContent = '';
    const facts = [];
    if (summary.groupName) facts.push(`Group: ${summary.groupName}`);
    facts.push(`Distance limit: ${metresShort(summary.limit)}${summary.measured ? '' : ' (model bounding box)'}`);
    details.appendChild(el('p', '', facts.join(' · ')));
    if (summary.warnings.length) {
        details.appendChild(el('h4', '', `Warnings (${summary.warnings.length})`));
        const list = el('ul', 'survey-summary-list');
        summary.warnings.forEach(w => list.appendChild(el('li', '', w)));
        details.appendChild(list);
    }
    details.appendChild(rowList('Skipped', summary.skipped, item => item.reason));
    details.appendChild(rowList('Off the model', summary.offModel, item => item.distance));
    details.appendChild(rowList('Unticked', summary.unticked, item => item.distance));

    dom.surveySummaryCopy.textContent = 'Copy summary';
    dom.surveySummaryOverlay.classList.add('visible');
    dom.surveySummaryOverlay.querySelector('.survey-dialog-body').scrollTop = 0;
    dom.surveySummaryOk.focus({ preventScroll: true });
}

function closeSummary() {
    dom.surveySummaryOverlay.classList.remove('visible');
    dom.surveySummaryDetails.textContent = '';
    _summaryText = '';
}

function copySummary() {
    const text = _summaryText;
    if (!text) return;
    const button = dom.surveySummaryCopy;
    const done = (ok) => {
        button.textContent = ok ? 'Copied' : 'Copy failed';
        showStatus(ok ? 'Import summary copied to the clipboard' : 'Could not copy the import summary');
        setTimeout(() => { button.textContent = 'Copy summary'; }, 1500);
    };
    const fallback = () => {
        const temp = document.createElement('textarea');
        temp.value = text;
        document.body.appendChild(temp);
        temp.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(temp);
        done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true)).catch(fallback);
    } else {
        fallback();
    }
}

// ============ Status chip ============

/**
 * Redraws the status chip beside the face count, and an open Alignment
 * Manager and control-point view, from state.alignments and
 * state.annotations. main.js runs it after every sidebar rebuild (the
 * groups.js hook: imports, merges, the autosave restore, clearing, deleted
 * annotations), once a new alignment is added and when the model hash is
 * known; the manager's actions call it themselves. The chip is shown with
 * #model-stats, i.e. once a model is loaded.
 */
export function refreshSurveyChip() {
    const chip = dom.alignmentChip;
    if (chip) {
        const view = alignmentChipView(state.alignments);
        const icon = getIcon('measure');
        const key = [view.kind, view.text, view.title, icon ? 1 : 0].join('|');
        if (key !== _chipKey) {
            _chipKey = key;
            chip.textContent = '';
            if (icon) {
                const span = el('span', 'alignment-chip-icon');
                span.innerHTML = icon;      // an SVG file from icons/, not user text
                span.setAttribute('aria-hidden', 'true');
                chip.appendChild(span);
            }
            chip.appendChild(el('span', 'alignment-chip-text', view.text));
            chip.title = view.title;
            // The accessible name starts with the visible text (WCAG 2.5.3)
            chip.setAttribute('aria-label', `${view.text}. ${view.title}`);
            chip.classList.toggle('none', view.kind === 'none');
        }
    }
    if (_mgr) renderManager();
    if (_viewId !== null) renderAlignmentView();
}

// ============ Alignment Manager ============
// Every change to an alignment goes through alignment.js, which bumps its
// `modified` stamp, so the autosave and a later merge see it.

function alignmentById(id) {
    return state.alignments.find(a => String(a.id) === String(id)) || null;
}

function replaceAlignment(next) {
    state.alignments = state.alignments.map(a => (a.id === next.id ? next : a));
}

// The Surveyed position block of an open edit popup or read-only viewer
// shows the alignment's name and the distance to the surface: redrawn after
// a rename, a detach or a move.
function refreshSurveyBlocks(annotations) {
    for (const ann of annotations) {
        if (state.editingAnnotation === ann) renderSurveyBlock(dom.annSurveyBlock, ann, state.alignments);
        refreshViewerSurveyBlock(ann);
    }
}

/**
 * Opens the Alignment Manager (the status chip). While control points are
 * being picked it only says so: Refine and Re-align would replace that session.
 */
export function openAlignmentManager() {
    if (!state.currentModel) return;
    if (isSurveyPickingOpen()) {
        showStatus('Finish or discard the control-point picking first');
        return;
    }
    // The chip stays reachable by keyboard behind the survey dialogs
    if (_refine || isSurveyMappingOpen() || dom.alignmentDeleteOverlay.classList.contains('visible') ||
        dom.surveySelectOverlay.classList.contains('visible') || dom.surveySummaryOverlay.classList.contains('visible')) return;
    closeAlignmentView();
    _mgr = { editId: null, editName: '', editCrs: '' };
    renderManager();
    dom.alignmentManagerOverlay.classList.add('visible');
    dom.alignmentManagerOverlay.querySelector('.survey-dialog-body').scrollTop = 0;
    dom.alignmentManagerClose.focus({ preventScroll: true });
}

function closeManager() {
    _mgr = null;
    dom.alignmentManagerOverlay.classList.remove('visible');
    dom.alignmentManagerList.textContent = '';
}

function renderManager() {
    if (!_mgr) return;
    const rows = managerRows(state.alignments, state.annotations, {
        defaultAlignmentId: state.defaultAlignmentId,
        modelHash: state.modelHash,
        modelUpAxis: state.modelUpAxis,
        hashPending: state.modelHashPending,
        residualWarn: residualWarn()
    });
    if (_mgr.editId !== null && !rows.some(r => r.id === _mgr.editId)) _mgr.editId = null;
    const count = plural(rows.length, 'alignment');
    dom.alignmentManagerSubtitle.textContent = state.modelFileName ? `${state.modelFileName} · ${count}` : count;
    dom.alignmentManagerEmpty.style.display = rows.length ? 'none' : '';
    // A redraw while the name and label form is in use keeps the caret there
    const active = document.activeElement;
    const typing = active && (active.id === 'alignment-edit-name' || active.id === 'alignment-edit-crs')
        ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    const list = dom.alignmentManagerList;
    list.textContent = '';
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.appendChild(managerItem(row));
    list.appendChild(fragment);
    const input = typing ? document.getElementById(typing.id) : null;
    if (input) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(typing.start, typing.end);
    }
}

function managerItem(row) {
    const li = el('li', `alignment-item${row.isDefault ? ' default' : ''}`);
    li.dataset.id = String(row.id);

    const head = el('div', 'alignment-item-head');
    head.appendChild(el('span', 'alignment-item-name', row.name));
    if (row.isDefault) {
        const badge = el('span', 'alignment-badge', 'Default');
        badge.title = 'Preselected when survey points are imported';
        head.appendChild(badge);
    }
    const verdict = el('span', `survey-verdict-badge ${row.verdict}`, VERDICT_LABELS[row.verdict] || row.verdict);
    verdict.title = 'Verdict of the fit';
    head.appendChild(verdict);
    li.appendChild(head);

    const facts = el('dl', 'alignment-facts');
    const fact = (label, value) => {
        facts.appendChild(el('dt', '', label));
        facts.appendChild(el('dd', '', value));
    };
    fact('Coordinate system', row.crs);
    fact('Height column', row.heightColumn || '—');
    fact('Fit', `${row.fitType}, ${row.enabledCount} of ${plural(row.controlPointCount, 'control point')} used`);
    fact('RMS', row.rms !== null ? `${formatMetres(row.rms)} (largest residual ${formatMetres(row.maxResidual)})` : '—');
    fact('Survey points', row.pointCount
        ? `${row.pointCount}${row.manualCount ? ` (${row.manualCount} moved by hand)` : ''}`
        : 'none');
    if (row.versionCount) fact('Earlier fits', `${row.versionCount} kept in the history`);
    li.appendChild(facts);

    if (row.warnings.length || row.checking) {
        const issues = el('ul', 'survey-issues');
        for (const w of row.warnings) {
            const item = el('li', 'survey-issue warning');
            item.appendChild(el('span', 'survey-issue-text', w.message));
            issues.appendChild(item);
        }
        if (row.checking) {
            const item = el('li', 'survey-issue');
            item.appendChild(el('span', 'survey-issue-text', 'Checking whether it was made on this model file…'));
            issues.appendChild(item);
        }
        li.appendChild(issues);
    }

    li.appendChild(_mgr.editId === row.id ? editForm(row) : managerActions(row));
    return li;
}

function managerActions(row) {
    const box = el('div', 'alignment-actions');
    const add = (action, label, title, className = 'btn-cancel') => {
        const b = button(`btn-small ${className}`, label, { action, id: String(row.id) });
        b.title = title;
        b.setAttribute('aria-label', `${label}: ${row.name}`);
        box.appendChild(b);
    };
    add('view', 'View control points', 'Show the review table and the picks on the model');
    add('edit', 'Rename', 'Edit the name and the coordinate system label');
    add('refine', 'Refine', 'Add, re-pick or disable control points');
    add('realign', 'Re-align from scratch', 'Pick the control points again; the current fit is kept in the history');
    if (!row.isDefault) add('default', 'Set as default', 'Preselect this alignment when survey points are imported');
    add('delete', 'Delete', row.pointCount ? 'Delete the alignment; its points are detached or deleted' : 'Delete the alignment', 'btn-delete');
    return box;
}

function editForm(row) {
    const form = el('div', 'alignment-edit');
    const grid = el('div', 'survey-field-grid');
    const field = (id, label, value, placeholder = '') => {
        const wrap = el('div', 'survey-field');
        const l = el('label', '', label);
        l.htmlFor = id;
        const input = document.createElement('input');
        input.type = 'text';
        input.id = id;
        input.value = value;
        input.autocomplete = 'off';
        if (placeholder) input.placeholder = placeholder;
        wrap.appendChild(l);
        wrap.appendChild(input);
        grid.appendChild(wrap);
    };
    field('alignment-edit-name', 'Name', _mgr.editName);
    field('alignment-edit-crs', 'Coordinate system (optional)', _mgr.editCrs, 'e.g. EPSG:32635');
    form.appendChild(grid);
    form.appendChild(el('p', 'survey-hint',
        'Only the name and the label change; the fit and the points stay as they are. An empty label shows as "unspecified coordinate system".'));
    const buttons = el('div', 'alignment-actions');
    buttons.appendChild(button('btn-small btn-cancel', 'Cancel', { action: 'edit-cancel', id: String(row.id) }));
    buttons.appendChild(button('btn-small btn-save', 'Save', { action: 'edit-save', id: String(row.id) }));
    form.appendChild(buttons);
    return form;
}

function startEdit(alignment) {
    _mgr.editId = alignment.id;
    _mgr.editName = alignment.name || '';
    _mgr.editCrs = alignment.crsLabel || '';
    renderManager();
    const input = document.getElementById('alignment-edit-name');
    if (input) {
        input.focus({ preventScroll: true });
        input.select();
    }
}

function cancelEdit() {
    if (!_mgr || _mgr.editId === null) return;
    _mgr.editId = null;
    renderManager();
}

// The form's values, kept in _mgr so a redraw (e.g. after a JSON-LD import
// in the background) does not lose them.
function onEditInput(e) {
    if (!_mgr) return;
    if (e.target.id === 'alignment-edit-name') _mgr.editName = e.target.value;
    else if (e.target.id === 'alignment-edit-crs') _mgr.editCrs = e.target.value;
}

function saveEdit(alignment) {
    const name = _mgr.editName.trim();
    if (!name) {
        showStatus('Enter a name for the alignment');
        const input = document.getElementById('alignment-edit-name');
        if (input) input.focus({ preventScroll: true });
        return;
    }
    const next = editAlignmentMetadata(alignment, { name, crsLabel: _mgr.editCrs });
    _mgr.editId = null;
    if (next !== alignment) {
        replaceAlignment(next);
        refreshSurveyBlocks(surveyPointsOf(state.annotations, next.id));
        showStatus(`Alignment "${alignmentDisplayName(next)}" saved (${crsDisplayLabel(next)})`);
    }
    refreshSurveyChip();
}

function setDefaultAlignment(alignment) {
    state.defaultAlignmentId = alignment.id;
    refreshSurveyChip();
    showStatus(`"${alignmentDisplayName(alignment)}" is now preselected for survey imports`);
}

function onManagerClick(e) {
    const b = e.target.closest('button[data-action]');
    if (!b || !_mgr) return;
    const alignment = alignmentById(b.dataset.id);
    if (!alignment) {
        renderManager();    // removed meanwhile
        return;
    }
    switch (b.dataset.action) {
        case 'view': openAlignmentView(alignment.id); break;
        case 'edit': startEdit(alignment); break;
        case 'edit-save': saveEdit(alignment); break;
        case 'edit-cancel': cancelEdit(); break;
        case 'refine': startRefine(alignment, 'refine'); break;
        case 'realign': startRefine(alignment, 'realign'); break;
        case 'default': setDefaultAlignment(alignment); break;
        case 'delete': requestDelete(alignment); break;
    }
}

function onManagerKeydown(e) {
    if (e.key !== 'Enter' || !_mgr || _mgr.editId === null) return;
    if (e.target.id !== 'alignment-edit-name' && e.target.id !== 'alignment-edit-crs') return;
    e.preventDefault();
    const alignment = alignmentById(_mgr.editId);
    if (alignment) saveEdit(alignment);
}

// ============ Delete ============

function requestDelete(alignment) {
    const count = surveyPointsOf(state.annotations, alignment.id).length;
    if (!count) {
        showConfirm(deleteMessage(alignment, 0), () => removeAlignmentFromSession(alignment.id, 'detach'));
        return;
    }
    _pendingDeleteId = alignment.id;
    dom.alignmentDeleteMessage.textContent = deleteMessage(alignment, count);
    dom.alignmentDeleteOverlay.classList.add('visible');
    dom.alignmentDeleteCancel.focus({ preventScroll: true });
}

function hideDeleteDialog() {
    _pendingDeleteId = null;
    dom.alignmentDeleteOverlay.classList.remove('visible');
}

function confirmDelete(mode) {
    const id = _pendingDeleteId;
    hideDeleteDialog();
    if (id !== null) removeAlignmentFromSession(id, mode);
}

// Detach: the points keep their surveyed coordinates, position, lock and
// attributes, without an alignment. Delete: the points go too, and the
// selection, callout, edit popup and box edit state let go of them.
function removeAlignmentFromSession(id, mode) {
    const result = deleteAlignment({
        alignments: state.alignments,
        annotations: state.annotations,
        defaultAlignmentId: state.defaultAlignmentId
    }, id, mode);
    if (!result.alignment) {
        refreshSurveyChip();
        return;
    }
    state.alignments = result.alignments;
    state.defaultAlignmentId = result.defaultAlignmentId;
    if (_viewId === id) closeAlignmentView();
    const name = alignmentDisplayName(result.alignment);
    if (result.deleted.length) {
        removeAnnotations(result.deleted);
        updateGroupsList();     // also redraws the chip and the manager
        renderAnnotations();
        showStatus(`Alignment "${name}" and ${plural(result.deleted.length, 'survey point')} deleted`);
    } else if (result.detached.length) {
        refreshSurveyBlocks(result.detached);
        refreshSurveyChip();
        showStatus(`Alignment "${name}" deleted; ${plural(result.detached.length, 'survey point')} detached, with their surveyed coordinates kept`);
    } else {
        refreshSurveyChip();
        showStatus(`Alignment "${name}" deleted`);
    }
}

// ============ Refine and re-align ============

/**
 * Refine (the alignment's control points as picks) or Re-align from scratch
 * (no picks) in the picking panel. The rows are the control points plus the
 * surveyed coordinates of the survey points attached to the alignment, and an
 * existing point annotation can serve too; the level option starts at the
 * alignment's fit type.
 */
function startRefine(alignment, kind) {
    if (!state.currentModel) return;
    const realign = kind === 'realign';
    const rows = refineRows(alignment, state.annotations);
    const picks = realign ? [] : picksFromControlPoints(rows, alignment.controlPoints).picks;
    const id = alignment.id;
    const name = alignmentDisplayName(alignment);
    closeManager();
    closeAlignmentView();
    const opened = openPickingPanel({
        rows, picks,
        fitType: alignment.fitType,
        job: null,
        title: realign ? 'Re-align from scratch' : 'Refine the alignment',
        subtitle: `"${name}" (${crsDisplayLabel(alignment)})`,
        acceptLabel: realign ? 'Accept the new fit' : 'Accept the refined fit',
        // The rows' coordinates are stored data, not a column mapping
        allowSwap: false,
        discardMessage: realign
            ? `Discard the new picks? The alignment "${name}" stays as it is.`
            : `Discard the changes to the control points? The alignment "${name}" stays as it is.`,
        onAccept: (result) => acceptRefine(id, kind, result),
        onCancel: () => showStatus(`The alignment "${name}" was left unchanged`)
    });
    if (opened) {
        // Accepting binds the alignment to this model (refit); say so when it
        // was made on another model file or up-axis.
        const warned = bindingWarnings(alignment, { modelHash: state.modelHash, modelUpAxis: state.modelUpAxis }).length > 0;
        showStatus(warned
            ? 'This alignment was made on a different model file or up-axis: check where its control points sit and re-pick them if needed. Accepting binds it to this model'
            : realign
                ? 'Pick at least 3 rows again; the current fit is kept in the history'
                : 'Re-pick, add or untick control points, then review the fit', warned ? 10 : 0);
    }
}

// The review was accepted: the new fit replaces the old one (kept in the
// alignment's history) once the panel has closed; then the points placed by
// the fit are offered to move with it. Without a change nothing is saved, but
// points left at an earlier fit by Keep positions are still offered.
function acceptRefine(id, kind, { controlPoints, fit, fitType }) {
    const previous = findAlignment(state.alignments, id);
    if (!previous) return () => showStatus('The alignment was removed meanwhile; the new fit was not saved');
    const unchanged = refineUnchanged(previous, {
        controlPoints, fitType, modelHash: state.modelHash, modelUpAxis: state.modelUpAxis
    });
    const options = {
        fit, fitType, controlPoints,
        residualWarn: residualWarn(),
        // New picks are made on this model; a null hash keeps the stored binding
        modelSha256: state.modelHash,
        modelUpAxis: state.modelUpAxis
    };
    const refined = unchanged ? previous
        : kind === 'realign' ? realignAlignment(previous, options) : refineAlignment(previous, options);
    return () => {
        if (!unchanged) {
            replaceAlignment(refined);
            refreshSurveyChip();
            // Open survey blocks show offsets measured from the fit
            refreshSurveyBlocks(surveyPointsOf(state.annotations, refined.id));
        }
        const plan = refinePlanFromPositions(planRefinePlacement(state.annotations, previous, refined));
        if (refineWouldMove(plan)) {
            showRefinePreview({ kind, previous, refined, plan });
        } else {
            showStatus(refineStatusText({ previous, refined, kind, manualCount: plan.manualCount }), 6);
        }
    };
}

function showRefinePreview({ kind, previous, refined, plan }) {
    closeRefinePreview();
    _refine = { kind, previous, refined, plan, model: state.currentModel, busy: false, controller: null };
    const unchanged = refined === previous;
    const p = refinePreview(plan, { unchanged });
    dom.alignmentRefineSubtitle.textContent = `"${alignmentDisplayName(refined)}" (${crsDisplayLabel(refined)})`;
    const change = rmsChangeText(previous, refined);
    dom.alignmentRefineText.textContent = unchanged
        ? `The fit is unchanged. ${p.text}`
        : `The alignment was ${kind === 'realign' ? 're-aligned' : 'refined'}${change ? ` (${change})` : ''}. ${p.text}`;

    const figures = dom.alignmentRefineFigures;
    figures.textContent = '';
    figures.appendChild(figure(p.count, p.count === 1 ? 'point would move' : 'points would move'));
    figures.appendChild(figure(p.largest, 'largest move'));
    figures.appendChild(figure(p.median, 'median move'));
    if (p.manualCount) figures.appendChild(figure(p.manualCount, 'moved by hand, stay'));

    const manual = dom.alignmentRefineManual;
    manual.textContent = '';
    if (p.manualCount) {
        manual.appendChild(el('p', '', p.manualText));
        const list = el('ul', 'survey-summary-list');
        p.manualNames.forEach(name => list.appendChild(el('li', '', name)));
        if (p.manualMore) list.appendChild(el('li', 'survey-muted', `and ${p.manualMore} more`));
        manual.appendChild(list);
    }

    dom.alignmentRefineProgress.textContent = '';
    setRefineBusy(false);
    dom.alignmentRefineOverlay.classList.add('visible');
    dom.alignmentRefineOverlay.querySelector('.survey-dialog-body').scrollTop = 0;
    dom.alignmentRefineKeep.focus({ preventScroll: true });
}

function setRefineBusy(busy) {
    if (_refine) _refine.busy = busy;
    dom.alignmentRefineKeep.disabled = busy;
    dom.alignmentRefineMove.disabled = busy;
}

function closeRefinePreview() {
    const r = _refine;
    _refine = null;
    if (r && r.controller) r.controller.abort();
    dom.alignmentRefineOverlay.classList.remove('visible');
    dom.alignmentRefineFigures.textContent = '';
    dom.alignmentRefineManual.textContent = '';
    dom.alignmentRefineProgress.textContent = '';
}

// Keep positions: the points stay where they are and stay 'fit' (Nils,
// decision 4), so the next refine offers to move them again.
function keepRefinedPositions() {
    const r = _refine;
    if (!r || r.busy) return;
    closeRefinePreview();
    showStatus(refineStatusText({
        previous: r.previous, refined: r.refined, kind: r.kind,
        kept: r.plan.count, manualCount: r.plan.manualCount
    }), 6);
}

// The ✕ and Escape: keep the positions, or stop a running move (nothing moves).
function onRefineClose() {
    const r = _refine;
    if (!r) return;
    if (r.busy) {
        closeRefinePreview();
        showStatus('Moving the survey points was stopped; no point was moved');
    } else {
        keepRefinedPositions();
    }
}

// Move points: the fit points go to their new fitted positions, snapped to the
// surface (chunked above SURFACE_CHUNK_SIZE, with a progress line); points
// moved by hand stay. Planned again now, against the current points.
async function moveRefinedPoints() {
    const r = _refine;
    if (!r || r.busy) return;
    if (findAlignment(state.alignments, r.refined.id) !== r.refined || state.currentModel !== r.model) {
        closeRefinePreview();
        showStatus('The alignment changed meanwhile; no survey point was moved');
        return;
    }
    const plan = refinePlanFromPositions(planRefinePlacement(state.annotations, r.previous, r.refined));
    let stats;
    if (plan.moves.length > SURFACE_CHUNK_SIZE) {
        setRefineBusy(true);
        const controller = new AbortController();
        r.controller = controller;
        try {
            stats = await applyReplacementChunked(plan, {
                signal: controller.signal,
                onProgress: (done, total) => {
                    if (_refine === r) dom.alignmentRefineProgress.textContent = `Placing the survey points on the surface: ${done} of ${total}`;
                }
            });
        } catch (e) {
            if (_refine !== r) return;      // closed meanwhile (a new model, clearing): nothing moved
            closeRefinePreview();
            if (e && e.name === 'AbortError') {
                showStatus('Moving the survey points was stopped; no point was moved');
            } else {
                console.error('Survey points could not be moved to the refined alignment:', e);
                showStatus(`The survey points could not be moved: ${e && e.message ? e.message : e}`);
            }
            return;
        }
    } else {
        stats = applyReplacement(plan);
    }
    if (_refine === r) closeRefinePreview();
    updateGroupsList();
    renderAnnotations();
    refreshSurveyBlocks(surveyPointsOf(state.annotations, r.refined.id));
    showStatus(refineStatusText({
        previous: r.previous, refined: r.refined, kind: r.kind,
        stats, manualCount: plan.manualCount
    }), 6);
}

// ============ View control points ============

/** Whether the read-only control-point view is open (event-listeners.js, Escape). */
export function isAlignmentViewOpen() {
    return _viewId !== null;
}

function openAlignmentView(id) {
    const alignment = findAlignment(state.alignments, id);
    if (!alignment || !state.currentModel) return;
    closeManager();
    _viewId = id;
    _viewShown = null;
    dom.alignmentViewPanel.classList.add('visible');
    // #viewport: moves the tool help clear of the panel (styles.css)
    dom.alignmentViewPanel.parentElement.classList.add('alignment-viewing');
    renderAlignmentView();
    dom.alignmentViewPanel.querySelector('.survey-dialog-body').scrollTop = 0;
    showStatus(`Control points of "${alignmentDisplayName(alignment)}" on the model`);
}

/**
 * Closes the control-point view and removes its markers from the model.
 * Safe to call when it is not open.
 */
export function closeAlignmentView() {
    _viewId = null;
    _viewShown = null;
    clearAlignmentOverlay();
    dom.alignmentViewPanel.classList.remove('visible');
    dom.alignmentViewPanel.parentElement.classList.remove('alignment-viewing');
    dom.alignmentViewRows.textContent = '';
    dom.alignmentViewIssues.textContent = '';
}

// The stored fit, read-only: the verdict, the figures, the checks and one row
// per control point (residual in E, N, H, total, leave-one-out error).
function renderAlignmentView() {
    const alignment = findAlignment(state.alignments, _viewId);
    if (!alignment || !state.currentModel) {
        closeAlignmentView();
        return;
    }
    if (alignment !== _viewShown) {
        showAlignmentOverlay(alignment);
        _viewShown = alignment;
    }
    const review = alignmentReview(alignment, { residualWarn: residualWarn() });
    const ev = review.evaluation;
    const cps = alignment.controlPoints || [];
    const q = alignment.quality || {};
    dom.alignmentViewSubtitle.textContent = `${alignmentDisplayName(alignment)} (${crsDisplayLabel(alignment)})`;

    dom.alignmentViewVerdict.className = `survey-verdict ${ev.verdict || 'poor'}`;
    dom.alignmentViewVerdict.textContent = review.verdictText || 'No fit can be made from the stored control points.';

    const figures = dom.alignmentViewFigures;
    figures.textContent = '';
    figures.appendChild(figure(`${q.n ?? '—'} of ${cps.length}`, 'points used'));
    const type = figure(alignment.fitType === 'level4' ? 'Level only' : 'Full', 'fit type');
    type.title = FIT_TYPE_LABELS[alignment.fitType] || '';
    figures.appendChild(type);
    figures.appendChild(figure(formatMetres(q.rms), 'RMS 3D'));
    figures.appendChild(figure(formatMetres(q.rmsH), 'RMS horizontal'));
    figures.appendChild(figure(formatMetres(q.rmsV), 'RMS vertical'));
    figures.appendChild(figure(formatMetres(q.maxResidual), 'largest residual'));
    figures.appendChild(figure(Number.isFinite(q.scale) ? q.scale.toFixed(4) : '—', 'estimated scale (not applied)'));
    figures.appendChild(figure(degrees(q.tiltDeg), 'tilt'));
    figures.appendChild(figure(degrees(q.headingDeg), 'heading'));

    // The checks as text only: this view changes nothing
    const issues = dom.alignmentViewIssues;
    issues.textContent = '';
    for (const m of readOnlyMessages(ev.messages)) {
        const li = el('li', `survey-issue ${m.level}`);
        li.appendChild(el('span', 'survey-issue-text', m.text));
        issues.appendChild(li);
    }

    const uuids = new Set(state.annotations.map(a => a.uuid));
    const tbody = dom.alignmentViewRows;
    tbody.textContent = '';
    const fragment = document.createDocumentFragment();
    review.rows.forEach((r, i) => {
        const cp = cps[i] || {};
        const tr = document.createElement('tr');
        if (!r.enabled) tr.classList.add('survey-row-off');
        if (r.outlier) tr.classList.add('survey-review-outlier');
        tr.appendChild(el('td', '', r.enabled ? 'Yes' : 'No'));
        tr.appendChild(el('td', 'survey-num', r.csvRow !== null ? String(r.csvRow) : '—'));
        const name = el('td', '', r.label);
        if (cp.annotationUuid) {
            // The alignment keeps its own copy when the annotation is deleted
            const gone = !uuids.has(cp.annotationUuid);
            name.appendChild(el('span', 'survey-tag', gone ? ' annotation deleted' : ' annotation'));
            name.title = `${r.label} (position from ${gone ? 'an annotation that was deleted since' : 'an annotation'})`;
        } else {
            name.title = r.label;
        }
        tr.appendChild(name);
        const [dE, dN, dH] = r.residual || [];
        tr.appendChild(el('td', 'survey-num', signed(dE)));
        tr.appendChild(el('td', 'survey-num', signed(dN)));
        tr.appendChild(el('td', 'survey-num', signed(dH)));
        tr.appendChild(el('td', 'survey-num', r.total !== null ? r.total.toFixed(3) : '—'));
        tr.appendChild(el('td', 'survey-num', r.looError !== null ? r.looError.toFixed(3) : '—'));
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

function backToManager() {
    closeAlignmentView();
    openAlignmentManager();
}

/**
 * Closes the Alignment Manager, its dialogs and the control-point view (a
 * new model, clearing the workspace, a new CSV file). An open refine preview
 * closes as "keep positions": the refined fit is already saved.
 */
export function closeAlignmentManager() {
    hideDeleteDialog();
    closeRefinePreview();
    closeManager();
    closeAlignmentView();
}

// ============ Wiring ============

/**
 * Wires the survey import dialogs once at startup (mapping, selection, summary).
 */
export function initSurveyUI() {
    initSurveyMapping();

    dom.surveySelectClose.addEventListener('click', cancelSelection);
    dom.surveySelectCancel.addEventListener('click', cancelSelection);
    dom.surveySelectBack.addEventListener('click', backToMapping);
    dom.surveySelectRemap.addEventListener('click', backToMapping);
    dom.surveySelectSwap.addEventListener('click', swapAndMeasure);
    dom.surveySelectNewAlignment.addEventListener('click', newAlignmentFromSelection);
    dom.surveySelectShowRows.addEventListener('click', () => {
        if (!_sel) return;
        _sel.showRows = true;
        renderSelection();
    });
    dom.surveySelectLimit.addEventListener('change', applyLimit);
    dom.surveySelectAll.addEventListener('change', onTickAll);
    dom.surveySelectRows.addEventListener('change', onRowTick);
    dom.surveySelectImport.addEventListener('click', importTicked);
    dom.surveySelectImportAll.addEventListener('click', importAll);

    dom.surveySummaryClose.addEventListener('click', closeSummary);
    dom.surveySummaryOk.addEventListener('click', closeSummary);
    dom.surveySummaryCopy.addEventListener('click', copySummary);
    dom.surveySummaryOverlay.addEventListener('click', (e) => {
        if (e.target === dom.surveySummaryOverlay) closeSummary();
    });

    // Status chip and Alignment Manager
    dom.alignmentChip.addEventListener('click', openAlignmentManager);
    dom.alignmentManagerClose.addEventListener('click', closeManager);
    dom.alignmentManagerOk.addEventListener('click', closeManager);
    dom.alignmentManagerOverlay.addEventListener('click', (e) => {
        if (e.target === dom.alignmentManagerOverlay) closeManager();
    });
    dom.alignmentManagerList.addEventListener('click', onManagerClick);
    dom.alignmentManagerList.addEventListener('input', onEditInput);
    dom.alignmentManagerList.addEventListener('keydown', onManagerKeydown);

    dom.alignmentDeleteDialogClose.addEventListener('click', hideDeleteDialog);
    dom.alignmentDeleteCancel.addEventListener('click', hideDeleteDialog);
    dom.alignmentDeleteOverlay.addEventListener('click', (e) => {
        if (e.target === dom.alignmentDeleteOverlay) hideDeleteDialog();
    });
    dom.alignmentDeleteDetach.addEventListener('click', () => confirmDelete('detach'));
    dom.alignmentDeletePoints.addEventListener('click', () => confirmDelete('delete'));

    // The refine preview needs a choice: no closing by a click beside it
    dom.alignmentRefineClose.addEventListener('click', onRefineClose);
    dom.alignmentRefineKeep.addEventListener('click', keepRefinedPositions);
    dom.alignmentRefineMove.addEventListener('click', moveRefinedPoints);

    dom.alignmentViewClose.addEventListener('click', closeAlignmentView);
    dom.alignmentViewBack.addEventListener('click', backToManager);
    refreshSurveyChip();
}

/**
 * Closes every survey import dialog and stops a running measurement (a new
 * session or model).
 */
export function closeSurveyDialogs() {
    abortSelection();
    closeSummary();
    closeSurveyMapping();
    closeAlignmentManager();
}

/**
 * Escape: closes the open survey dialog, one stage per press: the delete
 * question (back to the manager), the refine preview (as "keep positions";
 * while points are being moved it stops the run, which moves nothing), the
 * summary, the selection, the mapping, and in the Alignment Manager first an
 * open name and label form, then the manager.
 * @returns {boolean} true when a dialog was closed
 */
export function handleSurveyEscape() {
    if (dom.alignmentDeleteOverlay.classList.contains('visible')) {
        hideDeleteDialog();
        return true;
    }
    if (_refine) {
        onRefineClose();
        return true;
    }
    if (dom.surveySummaryOverlay.classList.contains('visible')) {
        closeSummary();
        return true;
    }
    if (dom.surveySelectOverlay.classList.contains('visible')) {
        cancelSelection();
        return true;
    }
    if (isSurveyMappingOpen()) {
        closeSurveyMapping();
        return true;
    }
    if (_mgr) {
        if (_mgr.editId !== null) cancelEdit();
        else closeManager();
        return true;
    }
    return false;
}
