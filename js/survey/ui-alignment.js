// js/survey/ui-alignment.js - The picking panel, live fit, preview markers and review (Steps B and C)
// A new alignment is made by picking control points: the user selects a CSV
// row in a side panel and taps where it was surveyed on the model. The model
// stays free to navigate (a drag orbits, a tap picks). From three picks on,
// the rigid fit is solved live: the footer shows its figures, every CSV row
// appears as a faint preview marker at its fitted position (dimmed when it
// falls off the model) and inline warnings name what looks wrong. The review
// (Step C) shows the verdict, the figures and a table per control point;
// Accept creates the alignment and hands the import job on to the selection
// step (ui-manager.js, late-bound from main.js).
//
// While the panel is open:
// - state.currentTool is 'survey-pick' the whole time, even with no row
//   selected, so markers are never dragged and box edits never start. The
//   annotation tools are disabled (setTool in event-listeners.js switches the
//   toolbar lock with the tool); taps reach handleSurveyPick() through
//   editing.js.
// - state.surveySession holds the session (shape below); it is never saved.
// - Picks are stored in storage terms (export frame of toStorageCoords of the
//   hit), so the flip toggle does not change them; the overlays are drawn
//   with toDisplayCoords and redrawn on flip (refreshSurveyOverlays).
// - The overlays live in state.surveyOverlay, a scene group that
//   renderAnnotations() never clears, on SURVEY_OVERLAY_LAYER, which only the
//   render loop in main.js draws: screenshots, the plate and the PDF leave
//   them out.
// - Loading another model ends the session (closeSurveyPicking from the
//   model-loader hook in main.js), as does clearing the workspace.
//
// state.surveySession (picking.js session plus the fields of this module):
//   { rows, picks, history, selectedKey, fitType,   // picking.js
//     job,          // the import job (ui-mapping.js shape), or null (refine without a CSV)
//     model,        // state.currentModel when the session started
//     title, subtitle, acceptLabel,
//     allowSwap,    // whether a swap message offers its Swap button
//     discardMessage, // the discard confirmation, or null for the default text
//     onAccept,     // see openPickingPanel
//     onCancel }
//
// The Alignment Manager (ui-manager.js) reopens the panel for Refine (initial
// picks from the alignment's control points) and Re-align (no picks) with
// openPickingPanel(), and shows a saved alignment's control points on the
// model with showAlignmentOverlay() (same layer and markers, no session).
//
// Row names come from the CSV file: the panel and the review are built with
// createElement and textContent only.

import * as THREE from 'three';
import { state, dom } from '../state.js';
import { showStatus, toStorageCoords, toDisplayCoords, getLastAuthor, generateInternalId, generateUUID } from '../utils/helpers.js';
import { pointToZUp, pointFromZUp } from '../utils/coords.js';
import { showConfirm } from '../annotation-tools/data.js';
import { cancelUnfinishedDrawing } from '../annotation-tools/editing.js';
import { createAlignment, surveyToStorage } from './alignment.js';
import { swapMappingEN } from './column-mapping.js';
import { SELECTION_LIMIT_DEFAULT, RESIDUAL_WARN_DEFAULT } from './rigid-fit.js';
import { findAlignment, formatCoordinate, formatMetres } from './survey-display.js';
import { measureSurfaceDistances, classifyMeasurement, jobWithMapping, surveyPointName, fileBaseName, metresShort } from './survey-import.js';
import {
    rowsFromRecords, swapRowsEN, filterRows, createPickingSession, rowOf, pickOf, canUndoPick,
    selectRow, setPick, removePick, setPickEnabled, undoPick, setFitType,
    evaluatePicking, canReview, verdictText, previewPositions, reviewRows, FIT_TYPE_LABELS
} from './picking.js';

// ============ Constants ============

// Scene layer of the picking overlays. Raycasters and the capture code use
// the default layer 0 only; main.js enables this layer for the on-screen
// render alone.
export const SURVEY_OVERLAY_LAYER = 5;

// Rows listed at once; more are reached through the search. Picked rows and
// the selected row are always listed.
const LIST_LIMIT = 300;

// Pause before the preview markers are measured against the surface, so a
// burst of changes (undo, swap) starts one run.
const MEASURE_DELAY = 120;  // ms

// Overlay colours. The markers are screen-sized dots (THREE.Points without
// size attenuation), so picks and preview markers stay visible at any zoom:
// the point annotation markers of render.js are a few millimetres wide and
// vanish in an overview. They are drawn over the model (no depth test), so
// rows behind a wall show too.
const COLORS = {
    preview: new THREE.Color(0x4FC3F7),         // faint preview markers
    pick: new THREE.Color(0xEDC040),            // picks
    pickSelected: new THREE.Color(0xFFFFFF),    // the selected row's pick
    pickDisabled: new THREE.Color(0x8A8F98),    // disabled picks
    target: new THREE.Color(0x00E5FF),          // the selected row's fitted position
    residual: new THREE.Color(0xFF8A65)         // pick to fitted position
};
const PREVIEW_OPACITY = 0.6;
const PREVIEW_OFF_OPACITY = 0.2;     // rows that fall off the model
// Dot diameters in CSS pixels at the default Point Markers size
const PREVIEW_SIZE = 7;
const PICK_SIZE = 11;
const TARGET_SIZE = 24;

const VERDICT_LABELS = { good: 'Good', check: 'Check', poor: 'Poor' };

// Viewport width below which the tool help, moved to the panel's right, would
// run into the view gizmo (panel 340 + help about 230 + gizmo 138 px): it is
// hidden then, as the panel says what to do (#viewport.survey-pick-narrow).
const NARROW_VIEWPORT = 720;    // px

// The import summary's note while the job's Easting and Northing are swapped
const SWAP_NOTE = 'Easting and Northing were swapped while picking control points.';

// Dot and ring sprites for the markers, drawn once and never disposed (the
// overlay materials and geometries are per session).
let _dotTexture = null;
let _ringTexture = null;

// ============ Module state ============

// Late-bound (main.js): setTool from event-listeners.js, the selection step
// from ui-manager.js, and the status chip refresh once an alignment is added.
let _setTool = null;
let _importIntoAlignment = null;
let _onAlignmentsChanged = null;

export function setSurveyPickingCallbacks({ setTool, importIntoAlignment, onAlignmentsChanged } = {}) {
    if (setTool) _setTool = setTool;
    if (importIntoAlignment) _importIntoAlignment = importIntoAlignment;
    if (onAlignmentsChanged) _onAlignmentsChanged = onAlignmentsChanged;
}

// What the panel shows, derived from state.surveySession.
function freshView() {
    return {
        evaluation: null,       // evaluatePicking() of the session
        fitKey: null,           // rotation and translation of the fit the positions belong to
        positions: null,        // preview positions (storage), parallel to the rows; null without a fit
        onModel: null,          // per row: true / false once measured, null before
        onModelCount: null,
        measured: false,        // whether onModel came from a surface query (else the model box)
        measureController: null,
        measureTimer: null,
        rowIndex: new Map(),    // row key -> index
        search: '',
        reviewOpen: false
    };
}
let _view = freshView();

// Overlay objects of the open session (in state.surveyOverlay), or null.
let _overlay = null;

// A saved alignment's control points shown by the Alignment Manager
// (showAlignmentOverlay): { alignment, materials, picks, fitted, residuals },
// or null. Its objects are marked userData.alignmentView, so the session
// overlays never remove them.
let _alignmentView = null;

// Desktop drag of the panel header.
let _drag = null;

// Watches the viewport width while the panel is open (sidebar collapse too).
let _resizeObserver = null;

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

function surfaceLimit() {
    const v = state.surveySurfaceLimit;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : SELECTION_LIMIT_DEFAULT;
}

// The Point Markers slider scales the dots too, within a readable range.
function dotSize(base) {
    const m = state.pointSizeMultiplier;
    return base * Math.min(3, Math.max(0.5, Number.isFinite(m) ? m : 1));
}

// A white disc with a dark rim (tinted by the material or vertex colour),
// or a ring.
function spriteTexture(ring) {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
    if (ring) {
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
    } else {
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#202020';
        ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function dotTexture() {
    if (!_dotTexture) _dotTexture = spriteTexture(false);
    return _dotTexture;
}

function ringTexture() {
    if (!_ringTexture) _ringTexture = spriteTexture(true);
    return _ringTexture;
}

// Replaces an overlay object's geometry with new positions (and colours).
function setPoints(obj, positions, colors = null) {
    const old = obj.geometry;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    obj.geometry = geometry;
    old.dispose();
}

function fitKeyOf(fit) {
    return fit && fit.ok ? JSON.stringify([fit.rotation, fit.translation]) : null;
}

function displayVector(storagePoint, target = new THREE.Vector3()) {
    const d = toDisplayCoords(storagePoint);
    return target.set(d.x, d.y, d.z);
}

function session() {
    return state.surveySession;
}

/** Whether the picking panel is open. */
export function isSurveyPickingOpen() {
    return !!state.surveySession;
}

/** Whether a row waits for its pick (the canvas shows a crosshair). */
export function isSurveyPickArmed() {
    const s = session();
    return !!s && s.selectedKey !== null && !_view.reviewOpen && state.currentModel === s.model;
}

// ============ Overlays ============

// Screen-sized dots drawn over the model.
function dotsMaterial(size, color, opacity, map = dotTexture(), vertexColors = false) {
    return new THREE.PointsMaterial({
        size, color, map, vertexColors, sizeAttenuation: false,
        transparent: true, opacity, alphaTest: 0.05, depthTest: false, depthWrite: false
    });
}

function residualMaterial() {
    return new THREE.LineBasicMaterial({ color: COLORS.residual, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
}

// An empty overlay object on the overlay layer, added to state.surveyOverlay.
function overlayObject(Type, material, renderOrder) {
    const obj = new Type(new THREE.BufferGeometry(), material);
    obj.frustumCulled = false;      // the positions change; no stale bounds
    obj.renderOrder = renderOrder;  // drawn after the model, in this order
    obj.layers.set(SURVEY_OVERLAY_LAYER);
    state.surveyOverlay.add(obj);
    return obj;
}

function createOverlays() {
    disposeOverlays();
    const materials = {
        previewOn: dotsMaterial(PREVIEW_SIZE, COLORS.preview, PREVIEW_OPACITY),
        previewOff: dotsMaterial(PREVIEW_SIZE, COLORS.preview, PREVIEW_OFF_OPACITY),
        picks: dotsMaterial(PICK_SIZE, 0xffffff, 1, dotTexture(), true),
        target: dotsMaterial(TARGET_SIZE, COLORS.target, 0.95, ringTexture()),
        residual: residualMaterial()
    };
    _overlay = {
        materials,
        previewOff: overlayObject(THREE.Points, materials.previewOff, 10),
        previewOn: overlayObject(THREE.Points, materials.previewOn, 11),
        residuals: overlayObject(THREE.LineSegments, materials.residual, 12),
        target: overlayObject(THREE.Points, materials.target, 13),
        picks: overlayObject(THREE.Points, materials.picks, 14)
    };
}

function disposeOverlays() {
    if (_overlay) {
        for (const key of ['previewOff', 'previewOn', 'residuals', 'target', 'picks']) _overlay[key].geometry.dispose();
        Object.values(_overlay.materials).forEach(m => m.dispose());
        _overlay = null;
    }
    // Everything but the Alignment Manager's control-point view
    state.surveyOverlay.children
        .filter(child => !child.userData.alignmentView)
        .forEach(child => state.surveyOverlay.remove(child));
}

/**
 * Redraws the picking overlays from the session: preview markers, picks,
 * residual lines and the selected row's fitted position. Called on every
 * change, and from event-listeners.js after the flip toggle and the Point
 * Markers slider. Also redraws the Alignment Manager's control-point view
 * (showAlignmentOverlay). Does nothing without either.
 */
export function refreshSurveyOverlays() {
    refreshAlignmentOverlay();
    const s = session();
    if (!s || !_overlay) return;
    const m = _overlay.materials;
    m.previewOn.size = m.previewOff.size = dotSize(PREVIEW_SIZE);
    m.picks.size = dotSize(PICK_SIZE);
    m.target.size = dotSize(TARGET_SIZE);
    const v = new THREE.Vector3();

    // Preview markers: every row at its fitted position, dimmed off the model
    const on = [], off = [];
    if (_view.positions) {
        _view.positions.forEach((p, i) => {
            displayVector(p, v);
            (_view.onModel && _view.onModel[i] === false ? off : on).push(v.x, v.y, v.z);
        });
    }
    setPoints(_overlay.previewOn, on);
    setPoints(_overlay.previewOff, off);

    // Picks, and a line from each enabled pick to its row's fitted position
    const picks = [], colors = [], lines = [];
    for (const pick of s.picks) {
        const a = displayVector(pointFromZUp(pick.modelPosition), new THREE.Vector3());
        picks.push(a.x, a.y, a.z);
        const color = pick.key === s.selectedKey ? COLORS.pickSelected : pick.enabled ? COLORS.pick : COLORS.pickDisabled;
        colors.push(color.r, color.g, color.b);
        const i = _view.rowIndex.get(pick.key);
        if (pick.enabled && _view.positions && i !== undefined) {
            displayVector(_view.positions[i], v);
            lines.push(a.x, a.y, a.z, v.x, v.y, v.z);
        }
    }
    setPoints(_overlay.picks, picks, colors);
    setPoints(_overlay.residuals, lines);

    // The selected row's fitted position (a ring), so it can be found on the model
    const i = s.selectedKey !== null ? _view.rowIndex.get(s.selectedKey) : undefined;
    const target = [];
    if (_view.positions && i !== undefined) {
        displayVector(_view.positions[i], v);
        target.push(v.x, v.y, v.z);
    }
    setPoints(_overlay.target, target);
}

// ============ Control-point view (Alignment Manager) ============
// A saved alignment's control points on the model, without a picking
// session: each pick (gold, disabled ones grey), where the fit puts its
// surveyed coordinate (cyan), and the residual line between them. The manager
// clears it when its view closes and on a model change; the flip toggle and
// the Point Markers slider redraw it through refreshSurveyOverlays().

/**
 * Shows a saved alignment's control points on the model, replacing any shown before.
 * @param {object} alignment
 */
export function showAlignmentOverlay(alignment) {
    clearAlignmentOverlay();
    if (!alignment) return;
    const materials = {
        picks: dotsMaterial(PICK_SIZE, 0xffffff, 1, dotTexture(), true),
        fitted: dotsMaterial(PREVIEW_SIZE, COLORS.target, 0.9),
        residual: residualMaterial()
    };
    const make = (Type, material, renderOrder) => {
        const obj = overlayObject(Type, material, renderOrder);
        obj.userData.alignmentView = true;
        return obj;
    };
    _alignmentView = {
        alignment,
        materials,
        residuals: make(THREE.LineSegments, materials.residual, 12),
        fitted: make(THREE.Points, materials.fitted, 13),
        picks: make(THREE.Points, materials.picks, 14)
    };
    refreshAlignmentOverlay();
}

/** Removes the control-point view from the model (safe when none is shown). */
export function clearAlignmentOverlay() {
    const view = _alignmentView;
    if (!view) return;
    _alignmentView = null;
    for (const key of ['residuals', 'fitted', 'picks']) {
        state.surveyOverlay.remove(view[key]);
        view[key].geometry.dispose();
    }
    Object.values(view.materials).forEach(m => m.dispose());
}

function refreshAlignmentOverlay() {
    const view = _alignmentView;
    if (!view) return;
    view.materials.picks.size = dotSize(PICK_SIZE);
    view.materials.fitted.size = dotSize(PREVIEW_SIZE);
    const picks = [], colors = [], fitted = [], lines = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const cp of view.alignment.controlPoints || []) {
        displayVector(pointFromZUp(cp.modelPosition), a);
        picks.push(a.x, a.y, a.z);
        const color = cp.enabled !== false ? COLORS.pick : COLORS.pickDisabled;
        colors.push(color.r, color.g, color.b);
        displayVector(surveyToStorage(view.alignment, cp.surveyed), b);
        fitted.push(b.x, b.y, b.z);
        lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    setPoints(view.picks, picks, colors);
    setPoints(view.fitted, fitted);
    setPoints(view.residuals, lines);
}

// ============ On the model or off it ============
// The preview markers of rows that fall off the model are dimmed: a fitted
// position farther than the selection limit from the surface (the commit 11
// surface query, chunked for large files), or from the model box without a BVH.

function cancelPreviewMeasurement() {
    if (_view.measureTimer) clearTimeout(_view.measureTimer);
    _view.measureTimer = null;
    if (_view.measureController) _view.measureController.abort();
    _view.measureController = null;
}

function schedulePreviewMeasurement() {
    cancelPreviewMeasurement();
    if (!_view.positions) return;
    _view.measureTimer = setTimeout(measurePreview, MEASURE_DELAY);
}

async function measurePreview() {
    _view.measureTimer = null;
    const s = session();
    const positions = _view.positions;
    if (!s || !positions || state.currentModel !== s.model) return;
    const controller = new AbortController();
    _view.measureController = controller;
    const limit = surfaceLimit();
    try {
        const m = await measureSurfaceDistances(positions, { maxDistance: limit, signal: controller.signal });
        if (controller.signal.aborted || session() !== s || _view.positions !== positions) return;
        const c = classifyMeasurement(s.rows, positions, m, { limit });
        const onModel = new Array(positions.length).fill(false);
        for (const row of c.rows) onModel[row.index] = row.onModel;
        _view.onModel = onModel;
        _view.onModelCount = c.onModelCount;
        _view.measured = m.measured;
        refreshSurveyOverlays();
        renderFit();
    } catch (e) {
        if (!e || e.name !== 'AbortError') console.warn('Survey picking: the preview could not be measured:', e);
    } finally {
        if (_view.measureController === controller) _view.measureController = null;
    }
}

// ============ Opening and closing ============

/**
 * Opens the picking panel (Step B) and makes 'survey-pick' the active tool.
 * Commit 14 reuses it for Refine (picks from picksFromControlPoints) and
 * Re-align (no picks).
 * @param {object} options
 * @param {object[]} options.rows - picking.js rows (rowsFromRecords / rowsFromControlPoints)
 * @param {object[]} [options.picks] - initial picks
 * @param {'rigid6'|'level4'} [options.fitType] - initial fit type (default full)
 * @param {object|null} [options.job] - the import job when the rows are its records:
 *   Swap then also swaps the job's mapping, and the result carries the job
 * @param {string} [options.title] - panel heading
 * @param {string} [options.subtitle] - e.g. 'file.csv → new alignment "Trench 3"'
 * @param {string} [options.acceptLabel] - the review's accept button
 * @param {boolean} [options.allowSwap] - false: a swap message has no Swap
 *   button (Refine: the rows' coordinates are stored data, not a mapping)
 * @param {string|null} [options.discardMessage] - the discard confirmation;
 *   null: 'Discard the picking session? … Nothing has been imported yet.'
 * @param {function(object): (function|void)} options.onAccept - called with
 *   { controlPoints, fit, fitType, verdict, job } when the review is accepted:
 *   controlPoints are all picked rows in row order (disabled ones included)
 *   and fit is the solveFit() result of the enabled ones in that order (as
 *   createAlignment expects). Throwing keeps the panel open; a returned
 *   function runs once the panel has closed (e.g. the selection step).
 * @param {function(): void} [options.onCancel] - after the session was discarded
 * @returns {boolean} false when no model is loaded
 */
export function openPickingPanel({
    rows, picks = [], fitType = 'rigid6', job = null,
    title = 'Pick control points', subtitle = '', acceptLabel = 'Accept and import',
    allowSwap = true, discardMessage = null, onAccept = null, onCancel = null
} = {}) {
    if (!state.currentModel) {
        showStatus('Load a model before picking control points');
        return false;
    }
    closeSurveyPicking();
    cancelUnfinishedDrawing();
    state.surveySession = createPickingSession({
        rows, picks, fitType, job, model: state.currentModel, title, subtitle, acceptLabel,
        allowSwap, discardMessage, onAccept, onCancel
    });
    _view = freshView();
    _view.rowIndex = new Map(state.surveySession.rows.map((r, i) => [r.key, i]));
    createOverlays();

    const panel = dom.surveyPickPanel;
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
    dom.surveyPickSearch.value = '';
    dom.surveyPickTitle.textContent = title;
    dom.surveyPickSubtitle.textContent = subtitle;
    dom.surveyPickRows.scrollTop = 0;
    panel.classList.add('visible');
    // #viewport: moves the tool help clear of the panel (styles.css)
    panel.parentElement.classList.add('survey-picking');
    watchViewportWidth(panel.parentElement);
    // Shows the survey-pick help and locks the toolbar (event-listeners.js)
    if (_setTool) _setTool('survey-pick');
    update();
    showStatus('Select a row, then tap its point on the model');
    return true;
}

/**
 * Picking for a new alignment: the rows are the import job's records. On
 * Accept the alignment is created with the name and coordinate system label
 * from the mapping dialog, added to the model's alignments, and the job goes
 * on to the selection step.
 * @param {object} job - from the mapping dialog, target { kind: 'new', name, crsLabel }
 */
export function startAlignmentPicking(job) {
    const name = (job.target && job.target.name) || fileBaseName(job.file.name);
    openPickingPanel({
        rows: rowsFromRecords(job.records, { label: r => surveyPointName(r, job.file.name) }),
        job,
        title: 'Pick control points',
        subtitle: `${job.file.name} → new alignment "${name}"`,
        acceptLabel: 'Accept and import',
        onAccept: acceptNewAlignment,
        onCancel: () => showStatus('Survey import cancelled: nothing was imported')
    });
}

/**
 * Ends the picking session: the panel, the review and the overlays close,
 * the tool goes back to none (unlocking the toolbar). Safe to call without a
 * session.
 * @param {{reason?: 'cancel'|'model'|null}} [options] - cancel: the user
 *   discarded it (onCancel runs); model: another model was loaded (a status
 *   line says so); none: silent (accept, clearing the workspace)
 */
export function closeSurveyPicking({ reason = null } = {}) {
    const s = state.surveySession;
    cancelPreviewMeasurement();
    closeReviewDialog();
    disposeOverlays();
    endPanelDrag();
    dom.surveyPickPanel.classList.remove('visible');
    dom.surveyPickPanel.parentElement.classList.remove('survey-picking', 'survey-pick-narrow');
    if (_resizeObserver) _resizeObserver.disconnect();
    _resizeObserver = null;
    dom.surveyPickRows.textContent = '';
    dom.surveyPickIssues.textContent = '';
    dom.surveyPickAnnotation.textContent = '';
    state.surveySession = null;
    _view = freshView();
    if (state.currentTool === 'survey-pick' && _setTool) _setTool(null);
    if (!s) return;
    // Held, so the loader's own "Loaded: …" line does not hide why the panel closed
    if (reason === 'model') showStatus('Control-point picking ended: another model was loaded', 5);
    if (reason === 'cancel' && s.onCancel) s.onCancel();
}

// #viewport gets survey-pick-narrow while it is too narrow for the tool help
// next to the panel.
function watchViewportWidth(viewport) {
    const apply = () => viewport.classList.toggle('survey-pick-narrow', viewport.clientWidth < NARROW_VIEWPORT);
    apply();
    if (typeof ResizeObserver === 'function') {
        _resizeObserver = new ResizeObserver(apply);
        _resizeObserver.observe(viewport);
    }
}

// Always asks: even without picks, discarding loses the column mapping of the
// import job (the file would have to be opened and mapped again).
function confirmDiscard() {
    const s = session();
    if (!s) return;
    const lost = s.picks.length ? ` ${plural(s.picks.length, 'pick')} will be lost.` : '';
    showConfirm(s.discardMessage || `Discard the picking session?${lost} Nothing has been imported yet.`,
        () => closeSurveyPicking({ reason: 'cancel' }));
}

// ============ Changes ============

// Re-evaluates the fit and redraws everything after a change of the picks,
// the rows or the fit type.
function update({ scrollToSelected = false } = {}) {
    const s = session();
    if (!s) return;
    _view.evaluation = evaluatePicking(s, { residualWarn: residualWarn() });
    const fit = _view.evaluation.fit;
    const key = fitKeyOf(fit);
    if (key !== _view.fitKey) {
        _view.fitKey = key;
        _view.positions = previewPositions(s.rows, fit);
        // The count belongs to the old positions: hidden until measured again.
        // The dimming keeps the old classification meanwhile (no flicker).
        _view.onModelCount = null;
        if (!_view.positions) _view.onModel = null;
        schedulePreviewMeasurement();
    }
    renderPanel({ scrollToSelected });
    if (_view.reviewOpen) renderReview();
    refreshSurveyOverlays();
}

/**
 * Applies changed survey settings to an open picking session (Settings →
 * Survey import, or Reset): the fit is evaluated again with the current
 * residual warning, and the preview markers are measured again with the
 * current distance limit. Does nothing without a session.
 */
export function refreshSurveyPickingSettings() {
    if (!session()) return;
    _view.onModelCount = null;
    update();
    schedulePreviewMeasurement();
}

// Selecting a row changes no fit: the list, the selected-row block, the
// overlays and the cursor are redrawn.
function select(key, { scrollToSelected = false } = {}) {
    const s = session();
    if (!s) return;
    state.surveySession = selectRow(s, key);
    renderRows({ scrollToSelected });
    renderSelected();
    refreshSurveyOverlays();
    if (state.currentTool === 'survey-pick') dom.canvas.style.cursor = isSurveyPickArmed() ? 'crosshair' : 'default';
}

/**
 * A tap on the model while picking (editing.js): the selected row's pick, or
 * its replacement when the row has one. The row stays selected, so a further
 * tap replaces the pick again.
 * @param {{x, y, z}} hit - the model hit in display (world) coordinates
 */
export function handleSurveyPick(hit) {
    const s = session();
    if (!s || !hit || _view.reviewOpen || state.currentModel !== s.model) return;
    const row = rowOf(s, s.selectedKey);
    if (!row) {
        showStatus('Select a row in the panel first, then tap its point on the model');
        return;
    }
    const replaced = !!pickOf(s, row.key);
    state.surveySession = setPick(s, row.key, { modelPosition: pointToZUp(toStorageCoords(hit)) });
    update();
    showStatus(replaced
        ? `Pick of ${row.label} replaced`
        : `Picked ${row.label}. Tap again to replace it, or select the next row.`);
}

// The selected row takes its position from an existing point annotation.
function pickFromAnnotation() {
    const s = session();
    const row = s ? rowOf(s, s.selectedKey) : null;
    const id = dom.surveyPickAnnotation.value;
    if (!row || !id) return;
    const ann = state.annotations.find(a => String(a.id) === id && a.type === 'point' && a.points && a.points[0]);
    if (!ann) {
        renderSelected();   // deleted meanwhile: redraw the list
        return;
    }
    try {
        state.surveySession = setPick(s, row.key, { modelPosition: pointToZUp(ann.points[0]), annotationUuid: ann.uuid });
    } catch (e) {
        showStatus('That annotation has no usable position');
        renderSelected();
        return;
    }
    update();
    showStatus(`${row.label} takes its position from the point annotation "${ann.name || 'Unnamed'}"`);
}

/** Whether Ctrl/Cmd+Z has a pick to undo (event-listeners.js). */
export function canUndoSurveyPick() {
    return canUndoPick(session());
}

/** Undoes the last change to the picks (Ctrl/Cmd+Z, or the panel's Undo button). */
export function undoSurveyPick() {
    const s = session();
    if (!canUndoPick(s)) return;
    state.surveySession = undoPick(s);
    update();
    showStatus('Last pick change undone');
}

function removeRowPick(key) {
    const s = session();
    const row = s ? rowOf(s, key) : null;
    if (!row) return;
    state.surveySession = removePick(s, key);
    update();
    showStatus(`Pick of ${row.label} removed`);
}

function setEnabled(key, enabled) {
    const s = session();
    if (!s) return;
    state.surveySession = setPickEnabled(s, key, enabled);
    update();
}

function chooseFitType(level) {
    const s = session();
    if (!s) return;
    state.surveySession = setFitType(s, level ? 'level4' : 'rigid6');
    update();
}

// Swap: Easting and Northing of every row are exchanged (and the import
// job's mapping, so the selection step and the created points use the same
// values); the picks keep their rows and the fit is solved again.
function swapEastingNorthing() {
    const s = session();
    if (!s) return;
    let job = s.job;
    if (job) {
        job = jobWithMapping(job, swapMappingEN(job.mapping));
        // Swapping back restores the mapping, and the note goes again
        const warnings = s.job.acceptedWarnings || [];
        job.acceptedWarnings = warnings.includes(SWAP_NOTE) ? warnings.filter(w => w !== SWAP_NOTE) : [...warnings, SWAP_NOTE];
    }
    state.surveySession = { ...s, rows: swapRowsEN(s.rows), job };
    update();
    showStatus('Easting and Northing swapped');
}

// A message's or the review table's re-pick: back to the panel with the row selected.
function repick(key) {
    const s = session();
    const row = s ? rowOf(s, key) : null;
    if (!row) return;
    closeReviewDialog();
    select(key, { scrollToSelected: true });
    showStatus(`Tap the model to re-pick ${row.label}`);
}

function onMessageAction(e) {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    const s = session();
    if (b.dataset.action === 'swap' && s && s.allowSwap !== false) swapEastingNorthing();
    else if (b.dataset.action === 'select') repick(b.dataset.key);
}

// ============ Panel ============

function renderPanel({ scrollToSelected = false } = {}) {
    const s = session();
    if (!s) return;
    const picked = s.picks.length;
    const disabled = s.picks.filter(p => !p.enabled).length;
    dom.surveyPickCounts.textContent = `${picked} of ${plural(s.rows.length, 'row')} picked` +
        (disabled ? `, ${disabled} disabled` : '');
    renderRows({ scrollToSelected });
    renderSelected();
    renderMessages(dom.surveyPickIssues, _view.evaluation.messages);
    renderFit();
}

function rowItem(s, row, review) {
    const pick = pickOf(s, row.key);
    const selected = row.key === s.selectedKey;
    const li = el('li', 'survey-pick-row');
    li.dataset.key = row.key;
    if (selected) li.classList.add('selected');
    if (pick) li.classList.add('picked');
    if (pick && !pick.enabled) li.classList.add('disabled');
    if (review && review.outlier) li.classList.add('outlier');

    const main = el('div', 'survey-pick-row-main');
    main.appendChild(el('div', 'survey-pick-row-name', row.label));
    // No-break spaces keep each letter with its value when the line wraps
    const where = `E\u00a0${formatCoordinate(row.surveyed.e)}  N\u00a0${formatCoordinate(row.surveyed.n)}  H\u00a0${formatCoordinate(row.surveyed.h)}`;
    main.appendChild(el('div', 'survey-pick-row-meta', row.csvRow !== null ? `Row ${row.csvRow} · ${where}` : where));
    if (pick) {
        const parts = [pick.annotationUuid ? 'From an annotation' : 'Picked'];
        if (!pick.enabled) parts.push('disabled');
        if (review && review.total !== null) parts.push(`residual ${formatMetres(review.total)}`);
        if (review && review.outlier) parts.push('does not fit the others');
        main.appendChild(el('div', 'survey-pick-row-status', parts.join(' · ')));
    }
    li.appendChild(main);

    const actions = el('div', 'survey-pick-row-actions');
    const pickButton = button(`btn-small ${selected ? 'btn-save' : 'btn-cancel'}`, selected ? 'Picking…' : pick ? 'Re-pick' : 'Pick', { action: 'pick' });
    pickButton.setAttribute('aria-pressed', selected ? 'true' : 'false');
    pickButton.setAttribute('aria-label', `${pick ? 'Re-pick' : 'Pick'} ${row.label}`);
    pickButton.title = selected ? 'Tap the model to pick this row; click again to deselect' : 'Select this row, then tap its point on the model';
    actions.appendChild(pickButton);
    if (pick) {
        const remove = button('btn-small btn-cancel', '✕', { action: 'remove' });
        remove.title = 'Remove this pick';
        remove.setAttribute('aria-label', `Remove the pick of ${row.label}`);
        actions.appendChild(remove);
    }
    li.appendChild(actions);
    return li;
}

function renderRows({ scrollToSelected = false } = {}) {
    const s = session();
    const list = dom.surveyPickRows;
    list.textContent = '';
    if (!s) return;
    const matches = filterRows(s.rows, _view.search);
    let shown = matches;
    if (matches.length > LIST_LIMIT) {
        const picked = new Set(s.picks.map(p => p.key));
        let others = 0;
        shown = matches.filter(r => picked.has(r.key) || r.key === s.selectedKey || others++ < LIST_LIMIT);
    }
    const review = _view.evaluation ? new Map(reviewRows(s, _view.evaluation).map(r => [r.key, r])) : new Map();
    const fragment = document.createDocumentFragment();
    for (const row of shown) fragment.appendChild(rowItem(s, row, review.get(row.key)));
    if (!matches.length) fragment.appendChild(el('li', 'survey-pick-note', 'No row matches the search.'));
    else if (shown.length < matches.length) {
        fragment.appendChild(el('li', 'survey-pick-note', `Showing ${shown.length} of ${matches.length} rows. Search by name to find the others.`));
    }
    list.appendChild(fragment);
    if (scrollToSelected) {
        const item = list.querySelector('.survey-pick-row.selected');
        if (item) item.scrollIntoView({ block: 'nearest' });
    }
}

// The selected row: what to do, and the existing point annotations it can
// take its position from (one with the row's name first).
function renderSelected() {
    const s = session();
    const row = s ? rowOf(s, s.selectedKey) : null;
    dom.surveyPickSelected.style.display = row ? '' : 'none';
    if (!row) {
        dom.surveyPickInstructions.textContent =
            'Select a row, then tap where it was surveyed on the model. Pick at least 3 rows spread over the site; with 4 or more, a bad pick can be found.';
        dom.surveyPickAnnotation.textContent = '';
        return;
    }
    const pick = pickOf(s, row.key);
    dom.surveyPickInstructions.textContent = 'Drag to navigate; a tap picks.';
    dom.surveyPickSelectedText.textContent = `${row.label}: tap the model where this row was surveyed.` +
        (pick ? ' Another tap replaces the pick.' : '') +
        (_view.positions ? ' The cyan ring shows where the fit expects it.' : '');

    const name = row.label.trim().toLowerCase();
    const points = state.annotations.filter(a => a.type === 'point' && a.points && a.points[0]);
    const sameName = (a) => (a.name || '').trim().toLowerCase() === name;
    points.sort((a, b) => (sameName(b) - sameName(a)) || (a.name || '').localeCompare(b.name || ''));
    const select = dom.surveyPickAnnotation;
    select.textContent = '';
    const none = el('option', '', points.length ? '—' : 'No point annotations yet');
    none.value = '';
    select.appendChild(none);
    for (const a of points) {
        const option = el('option', '', `${a.name || 'Unnamed'}${sameName(a) ? ' (same name)' : ''}`);
        option.value = String(a.id);
        select.appendChild(option);
    }
    const from = pick && pick.annotationUuid ? points.find(a => a.uuid === pick.annotationUuid) : null;
    select.value = from ? String(from.id) : '';
    select.disabled = points.length === 0;
}

function renderMessages(list, messages) {
    list.textContent = '';
    const s = session();
    const swapAllowed = !s || s.allowSwap !== false;
    for (const m of messages) {
        const li = el('li', `survey-issue ${m.level}`);
        li.appendChild(el('span', 'survey-issue-text', m.text));
        if (m.action && (m.action.id !== 'swap' || swapAllowed)) {
            li.appendChild(button('btn-cancel btn-small', m.action.label, { action: m.action.id, key: m.action.key || '' }));
        }
        list.appendChild(li);
    }
}

// The footer: the live fit's figures, the level option and the buttons.
function renderFit() {
    const s = session();
    const ev = _view.evaluation;
    if (!s || !ev) return;
    const box = dom.surveyPickFit;
    box.textContent = '';
    const fit = ev.fit;
    if (!fit) {
        box.appendChild(el('span', 'survey-hint', `The fit appears from 3 picks on (${ev.enabledCount} so far).`));
    } else if (!fit.ok) {
        box.appendChild(el('span', 'survey-verdict-badge poor', 'No fit'));
    } else {
        const q = fit.quality;
        box.appendChild(el('span', `survey-verdict-badge ${ev.verdict}`, VERDICT_LABELS[ev.verdict]));
        const figures = el('span', 'survey-pick-figures',
            `RMS ${formatMetres(q.rms)} · largest ${formatMetres(q.maxResidual)} · scale ${q.scale.toFixed(4)} · tilt ${degrees(ev.fullTilt)}`);
        figures.title = 'Root mean square and largest residual of the control points, estimated scale, tilt of the full fit';
        box.appendChild(figures);
        if (_view.onModel && _view.onModelCount !== null) {
            box.appendChild(el('div', 'survey-hint',
                `${_view.onModelCount} of ${plural(s.rows.length, 'row')} lie within ${metresShort(surfaceLimit())} of the model ${_view.measured ? 'surface' : 'bounding box'}.`));
        }
    }
    renderLevel(dom.surveyPickLevel, dom.surveyPickLevelHint);
    dom.surveyPickUndo.disabled = !canUndoPick(s);
    dom.surveyPickReview.disabled = !canReview(ev);
}

// The level option (panel and review): off by default; suggested when the
// full fit is tilted by less than 0.5 degrees.
function renderLevel(checkbox, hint) {
    const s = session();
    const ev = _view.evaluation;
    checkbox.checked = s.fitType === 'level4';
    const label = checkbox.closest('label');
    if (label) label.classList.toggle('suggested', !!ev.levelSuggested && s.fitType === 'rigid6');
    if (ev.levelSuggested && s.fitType === 'rigid6') hint.textContent = `Suggested: the full fit tilts the model by only ${degrees(ev.fullTilt)}.`;
    else if (s.fitType === 'level4' && Number.isFinite(ev.fullTilt)) hint.textContent = `Turn about the vertical only. The full fit would tilt the model by ${degrees(ev.fullTilt)}.`;
    else hint.textContent = '';
}

function onRowsClick(e) {
    const item = e.target.closest('.survey-pick-row');
    const s = session();
    if (!item || !s) return;
    const key = item.dataset.key;
    const action = e.target.closest('button[data-action]');
    if (action && action.dataset.action === 'remove') {
        removeRowPick(key);
        return;
    }
    // The Pick button or the row itself: select it, or deselect it again
    select(s.selectedKey === key ? null : key);
    if (s.selectedKey !== key) showStatus(`Tap the model where ${rowOf(s, key).label} was surveyed`);
}

// ============ Review (Step C) ============

function openReviewDialog() {
    if (!session() || !canReview(_view.evaluation)) return;
    _view.reviewOpen = true;
    renderReview();
    dom.surveyReviewOverlay.classList.add('visible');
    dom.surveyReviewOverlay.querySelector('.survey-dialog-body').scrollTop = 0;
    dom.surveyReviewBack.focus({ preventScroll: true });
    if (state.currentTool === 'survey-pick') dom.canvas.style.cursor = 'default';
}

function closeReviewDialog() {
    const wasOpen = _view.reviewOpen;
    _view.reviewOpen = false;
    dom.surveyReviewOverlay.classList.remove('visible');
    dom.surveyReviewRows.textContent = '';
    if (wasOpen && state.currentTool === 'survey-pick') dom.canvas.style.cursor = isSurveyPickArmed() ? 'crosshair' : 'default';
}

function figure(value, label) {
    const box = el('div', 'survey-figure');
    box.appendChild(el('div', 'survey-figure-value', String(value)));
    box.appendChild(el('div', 'survey-figure-label', label));
    return box;
}

function renderReview() {
    const s = session();
    const ev = _view.evaluation;
    if (!s || !ev) return;
    dom.surveyReviewSubtitle.textContent = s.subtitle;
    const fit = ev.fit && ev.fit.ok ? ev.fit : null;

    dom.surveyReviewVerdict.className = `survey-verdict ${ev.verdict || 'poor'}`;
    dom.surveyReviewVerdict.textContent = fit ? verdictText(ev) : 'No fit: go back and pick at least 3 rows that are spread out.';

    const figures = dom.surveyReviewFigures;
    figures.textContent = '';
    if (fit) {
        const q = fit.quality;
        figures.appendChild(figure(`${q.n} of ${ev.controlPoints.length}`, 'points used'));
        const type = figure(fit.fitType === 'level4' ? 'Level only' : 'Full', 'fit type');
        type.title = FIT_TYPE_LABELS[fit.fitType];
        figures.appendChild(type);
        figures.appendChild(figure(formatMetres(q.rms), 'RMS 3D'));
        figures.appendChild(figure(formatMetres(q.rmsH), 'RMS horizontal'));
        figures.appendChild(figure(formatMetres(q.rmsV), 'RMS vertical'));
        figures.appendChild(figure(formatMetres(q.maxResidual), 'largest residual'));
        figures.appendChild(figure(q.scale.toFixed(4), 'estimated scale (shown, not applied)'));
        figures.appendChild(figure(degrees(q.tiltDeg), 'tilt'));
        figures.appendChild(figure(degrees(q.headingDeg), 'heading'));
    }

    // Full and level fit side by side, next to the level option
    const rms = (r) => (r && r.ok ? formatMetres(r.quality.rms) : 'no fit');
    dom.surveyReviewCompare.textContent = ev.both
        ? `Full fit RMS ${rms(ev.both.rigid6)} · Level fit RMS ${rms(ev.both.level4)}`
        : '';
    renderLevel(dom.surveyReviewLevel, dom.surveyReviewLevelHint);
    renderMessages(dom.surveyReviewIssues, ev.messages);

    const tbody = dom.surveyReviewRows;
    tbody.textContent = '';
    const fragment = document.createDocumentFragment();
    for (const r of reviewRows(s, ev)) {
        const tr = document.createElement('tr');
        if (!r.enabled) tr.classList.add('survey-row-off');
        if (r.outlier) tr.classList.add('survey-review-outlier');
        const use = document.createElement('td');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = r.enabled;
        box.dataset.key = r.key;
        box.setAttribute('aria-label', `Use ${r.label}`);
        use.appendChild(box);
        tr.appendChild(use);
        tr.appendChild(el('td', 'survey-num', r.csvRow !== null ? String(r.csvRow) : '—'));
        const name = el('td', '', r.label);
        name.title = r.label + (r.fromAnnotation ? ' (position from an annotation)' : '');
        if (r.fromAnnotation) name.appendChild(el('span', 'survey-tag', ' annotation'));
        tr.appendChild(name);
        const [dE, dN, dH] = r.residual || [];
        tr.appendChild(el('td', 'survey-num', signed(dE)));
        tr.appendChild(el('td', 'survey-num', signed(dN)));
        tr.appendChild(el('td', 'survey-num', signed(dH)));
        tr.appendChild(el('td', 'survey-num', r.total !== null ? r.total.toFixed(3) : '—'));
        tr.appendChild(el('td', 'survey-num', r.looError !== null ? r.looError.toFixed(3) : '—'));
        const action = document.createElement('td');
        const repickButton = button('btn-cancel btn-small', 'Re-pick', { action: 'select', key: r.key });
        repickButton.setAttribute('aria-label', `Re-pick ${r.label}`);
        action.appendChild(repickButton);
        tr.appendChild(action);
        fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);

    dom.surveyReviewAccept.textContent = s.acceptLabel;
    dom.surveyReviewAccept.disabled = !fit;
}

function onReviewTableChange(e) {
    if (e.target.type !== 'checkbox' || !e.target.dataset.key) return;
    setEnabled(e.target.dataset.key, e.target.checked);
}

// Accept: a Poor verdict needs an extra confirmation.
function acceptReview() {
    const ev = _view.evaluation;
    if (!session() || !canReview(ev)) return;
    if (ev.verdict === 'poor') {
        showConfirm(`${verdictText(ev)} Accept this alignment anyway?`, finishAccept);
        return;
    }
    finishAccept();
}

function finishAccept() {
    const s = session();
    const ev = _view.evaluation;
    if (!s || !canReview(ev)) return;
    if (state.currentModel !== s.model) {
        closeSurveyPicking({ reason: 'model' });
        return;
    }
    const result = { controlPoints: ev.controlPoints, fit: ev.fit, fitType: ev.fitType, verdict: ev.verdict, job: s.job };
    let next = null;
    try {
        next = s.onAccept ? s.onAccept(result) : null;
    } catch (e) {
        console.error('Survey alignment could not be accepted:', e);
        showStatus(`The alignment could not be created: ${e && e.message ? e.message : e}`);
        return;
    }
    closeSurveyPicking();
    if (typeof next === 'function') next();
}

// The new-alignment path (startAlignmentPicking): creates the alignment, and
// once the panel has closed adds it and opens the selection step.
function acceptNewAlignment({ controlPoints, fit, fitType, verdict, job }) {
    const target = job.target || {};
    const alignment = createAlignment({
        generateId: generateInternalId,
        generateUuid: generateUUID,
        name: (target.name || '').trim() || fileBaseName(job.file.name),
        crsLabel: target.crsLabel || '',
        heightColumn: job.heightColumn || '',
        modelSha256: state.modelHash,           // null while the hash is still being computed
        modelUpAxis: state.modelUpAxis,
        fit, fitType, controlPoints,
        residualWarn: residualWarn(),
        creator: getLastAuthor(),
        // The ORCID belongs to the Settings identity only
        creatorOrcid: state.defaultAuthor ? (state.defaultAuthorOrcid || null) : null
    });
    return () => {
        state.alignments = [...state.alignments, alignment];
        // The first alignment (or the first after the default was removed) becomes the default
        if (!findAlignment(state.alignments, state.defaultAlignmentId)) state.defaultAlignmentId = alignment.id;
        if (_onAlignmentsChanged) _onAlignmentsChanged();
        const acceptedWarnings = [...(job.acceptedWarnings || [])];
        if (verdict !== 'good') {
            acceptedWarnings.push(`The alignment "${alignment.name || 'Unnamed alignment'}" was accepted with the verdict ` +
                `${VERDICT_LABELS[verdict] || verdict} (RMS ${formatMetres(alignment.quality.rms)}).`);
        }
        showStatus(`Alignment "${alignment.name || 'Unnamed alignment'}" created from ${plural(alignment.quality.n, 'control point')}`);
        if (_importIntoAlignment) {
            _importIntoAlignment({ ...job, target: { kind: 'existing', alignmentId: alignment.id }, acceptedWarnings });
        }
    };
}

// ============ Escape ============

/**
 * Escape while the panel is open, one stage per key press: the review goes
 * back to the panel; in the row search field it clears the search, then
 * leaves the field; then popups opened from the sidebar close (closePopups,
 * from event-listeners.js); then a selected row is deselected; then the
 * session is discarded after a confirmation. The tool is never reset here,
 * so markers stay undraggable until the panel closes.
 * @param {{closePopups?: function(): boolean}} [options] - closes the
 *   annotation or group popup or the selection; true when it closed something
 * @returns {boolean} true when the panel is open (Escape is handled)
 */
export function handleSurveyPickingEscape({ closePopups = null } = {}) {
    const s = session();
    if (!s) return false;
    if (_view.reviewOpen) {
        closeReviewDialog();
    } else if (document.activeElement === dom.surveyPickSearch) {
        // Escape in the search field clears the search, then leaves the field
        if (dom.surveyPickSearch.value) {
            dom.surveyPickSearch.value = '';
            _view.search = '';
            renderRows({ scrollToSelected: true });
        } else {
            dom.surveyPickSearch.blur();
        }
    } else if (closePopups && closePopups()) {
        // a popup or the annotation selection went first
    } else if (s.selectedKey !== null) {
        select(null);
        showStatus('Row deselected. Press Escape again to discard the picking session.');
    } else {
        confirmDiscard();
    }
    return true;
}

// ============ Panel drag (desktop) ============

function endPanelDrag() {
    _drag = null;
}

function initPanelDrag() {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const panel = dom.surveyPickPanel;
    dom.surveyPickHeader.addEventListener('mousedown', (e) => {
        // The bottom sheet of narrow windows stays where it is
        if (e.button !== 0 || e.target.closest('button') || window.matchMedia('(max-width: 760px)').matches) return;
        const rect = panel.getBoundingClientRect();
        _drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!_drag) return;
        const area = panel.parentElement.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - area.left - _drag.dx, area.width - panel.offsetWidth));
        const y = Math.max(0, Math.min(e.clientY - area.top - _drag.dy, area.height - panel.offsetHeight));
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', endPanelDrag);
}

// ============ Wiring ============

/**
 * Wires the picking panel and the review once at startup (main.js).
 */
export function initSurveyPicking() {
    dom.surveyPickClose.addEventListener('click', confirmDiscard);
    dom.surveyPickCancel.addEventListener('click', confirmDiscard);
    dom.surveyPickUndo.addEventListener('click', undoSurveyPick);
    dom.surveyPickReview.addEventListener('click', openReviewDialog);
    dom.surveyPickSearch.addEventListener('input', () => {
        _view.search = dom.surveyPickSearch.value;
        renderRows();
    });
    dom.surveyPickRows.addEventListener('click', onRowsClick);
    dom.surveyPickAnnotation.addEventListener('change', pickFromAnnotation);
    dom.surveyPickIssues.addEventListener('click', onMessageAction);
    dom.surveyPickLevel.addEventListener('change', () => chooseFitType(dom.surveyPickLevel.checked));

    dom.surveyReviewClose.addEventListener('click', closeReviewDialog);
    dom.surveyReviewBack.addEventListener('click', closeReviewDialog);
    dom.surveyReviewCancel.addEventListener('click', confirmDiscard);
    dom.surveyReviewAccept.addEventListener('click', acceptReview);
    dom.surveyReviewLevel.addEventListener('change', () => chooseFitType(dom.surveyReviewLevel.checked));
    dom.surveyReviewIssues.addEventListener('click', onMessageAction);
    dom.surveyReviewRows.addEventListener('change', onReviewTableChange);
    dom.surveyReviewRows.addEventListener('click', onMessageAction);

    initPanelDrag();
}
