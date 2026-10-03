// js/survey/survey-import.js - Surface distance, snapping, re-placement and creation of survey points
// Survey points sit on the surface (plan: Algorithms > Surface distance and
// snapping): points[0] is the surface point nearest to the fitted position,
// and survey.surfaceDistance is the signed distance from the fitted position
// to that point (positive = above, on the side the face normal points to;
// negative = below; null = not measured). The fitted position itself is not
// stored; surveyToStorage() in alignment.js recomputes it.
//
// Frames: positions in and out are storage coordinates (Y-up, not flipped,
// like points[0]); the flip-aware query in projection.js converts to display
// space and back. Distances are world distances in metres (the flip is rigid).
//
// Without a BVH (state.bvhAvailable false: a very large model or a failed
// build) nothing is measured or snapped: points stay at their fitted position
// with surfaceDistance null, which is the flag, and the selection step judges
// rows by the model's bounding box (classifyByDistance in alignment.js).
//
// Long runs go in chunks of SURFACE_CHUNK_SIZE positions, one chunk per
// animation frame, so the page stays responsive and a progress line can
// update. Each chunk is one synchronous batch query, which builds the BVH mesh
// contexts once and cannot interleave with an edge projection.
//
// Creating points (plan: Data model > CSV row to annotation): each ticked row
// becomes a point annotation in the same shape data.js creates, plus `locked`
// and `survey`. The functions take the settings and the author as arguments,
// so they never read localStorage; the dialogs in ui-mapping.js and
// ui-manager.js pass them in.

import * as THREE from 'three';
import { state } from '../state.js';
import { toStorageCoords, generateInternalId, generateUUID } from '../utils/helpers.js';
import { nearestSurfacePointsFlipAware, isSurfaceQueryAvailable } from '../annotation-tools/projection.js';
import {
    fittedPositions, classifyByDistance, checkDuplicates, crsDisplayLabel,
    PLACEMENT, SELECTION_METHODS, DUPLICATE_STATUS, DUPLICATE_REASONS
} from './alignment.js';
import { SELECTION_LIMIT_DEFAULT, SURFACE_WARN_DEFAULT } from './rigid-fit.js';
import { buildRecords, emptyMapping, MAPPING_ROLES, REQUIRED_ROLES } from './column-mapping.js';
import { formatMetres } from './survey-display.js';

export { isSurfaceQueryAvailable };

// ============ Constants ============

// Positions per chunk (one chunk per animation frame) in long runs. Also the
// largest replacement the JSON-LD import runs synchronously.
export const SURFACE_CHUNK_SIZE = 200;

// Search radius of the selection step's surface query: wide enough to list the
// distances of rows somewhat off the model, small enough that the BVH prunes
// far rows at once. A row with nothing inside the radius reads Infinity.
export const SURFACE_SEARCH_MIN = 2;        // m
export const SURFACE_SEARCH_FACTOR = 4;     // times the selection limit

// Labels are hidden on an import with more points than this (default of the
// setting meshnotes_surveyLabelsOffAbove, state.surveyLabelsOffAbove; 0 = never).
export const LABELS_OFF_ABOVE_DEFAULT = 50;

// Colours of new import groups, taken in order, skipping colours in use.
export const SURVEY_GROUP_COLORS = Object.freeze([
    '#4FC3F7', '#81C784', '#FF8A65', '#BA68C8', '#4DB6AC', '#F06292', '#AED581', '#7986CB'
]);

// ============ Small helpers ============

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function distance3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function median(values) {
    const v = values.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function abortError(message) {
    return new DOMException(message, 'AbortError');
}

// Browsers pause animation frames in a hidden tab, so a timeout races the
// frame: a run started before the user switches tabs still finishes (at the
// background timer rate) instead of waiting for the tab to come back.
const HIDDEN_TAB_TICK = 100;    // ms

function nextFrame() {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
        const timer = setTimeout(resolve, HIDDEN_TAB_TICK);
        requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
    });
}

// ============ Positions and the model box ============

/**
 * Search radius for a selection limit: max(SURFACE_SEARCH_MIN, SURFACE_SEARCH_FACTOR * limit).
 * @param {number} [limit=SELECTION_LIMIT_DEFAULT] - metres
 * @returns {number} metres (Infinity for an infinite limit)
 */
export function searchRadiusForLimit(limit = SELECTION_LIMIT_DEFAULT) {
    const l = (typeof limit === 'number' && limit >= 0) ? limit : SELECTION_LIMIT_DEFAULT;
    return Math.max(SURFACE_SEARCH_MIN, SURFACE_SEARCH_FACTOR * l);
}

/**
 * Fitted position of each record in storage coordinates (the query input).
 * @param {Array<{e,n,h}|number[]>} records - buildRecords() records or survey blocks
 * @param {object} alignment
 * @param {{swapEN?: boolean}} [options] - swapEN: the Swap trial
 * @returns {Array<{x,y,z}>} parallel to records
 */
export function fittedStoragePositions(records, alignment, { swapEN = false } = {}) {
    return fittedPositions(records, alignment, { frame: 'storage', swapEN });
}

/**
 * The loaded model's bounding box in storage coordinates, for the no-BVH
 * selection fallback. The box is axis-aligned in display space; the flip and
 * the storage frame keep it axis-aligned, so two corners describe it exactly.
 * @returns {{min: {x,y,z}, max: {x,y,z}}|null} null without a model
 */
export function modelStorageBox() {
    if (!state.currentModel) return null;
    state.currentModel.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(state.currentModel);
    if (box.isEmpty()) return null;
    const a = toStorageCoords(box.min);
    const b = toStorageCoords(box.max);
    return {
        min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
        max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) }
    };
}

// ============ Chunked runs ============

/**
 * Runs work(start, end) over [0, count) in chunks: the first chunk at once,
 * each further one on the next animation frame (a timeout where there is no
 * requestAnimationFrame, as in Node).
 * @param {number} count
 * @param {function(number, number): void} work - handles indices start..end-1
 * @param {{chunkSize?: number, onProgress?: function(number, number), signal?: {aborted: boolean}}} [options]
 *   onProgress(done, total) after each chunk; signal: an AbortSignal.
 * @returns {Promise<void>} rejects with a DOMException named 'AbortError' when
 *   the signal is aborted or another model is loaded between two chunks.
 */
export async function runChunked(count, work, { chunkSize = SURFACE_CHUNK_SIZE, onProgress = null, signal = null } = {}) {
    const model = state.currentModel;
    const size = Math.max(1, Math.floor(chunkSize) || SURFACE_CHUNK_SIZE);
    for (let start = 0; start < count; start += size) {
        if (start > 0) await nextFrame();
        if (signal && signal.aborted) throw abortError('Survey surface query cancelled');
        if (state.currentModel !== model) throw abortError('The model changed during the survey surface query');
        const end = Math.min(count, start + size);
        work(start, end);
        if (onProgress) onProgress(end, count);
    }
}

// ============ Surface distance (selection step) ============

// Queries positions[i] for every i in indices (one batch) and writes the
// results into distances and results.
function measureIndices(positions, indices, maxDistance, distances, results) {
    const hits = nearestSurfacePointsFlipAware(indices.map(i => positions[i]), maxDistance);
    if (!hits) throw abortError('The surface query is no longer available');
    indices.forEach((i, k) => {
        const hit = hits[k];
        if (!hit) {
            distances[i] = Infinity;
            results[i] = null;
            return;
        }
        const signed = hit.side * hit.distance;
        distances[i] = signed;
        results[i] = { point: hit.point, distance: signed, side: hit.side };
    });
}

function indexRange(start, end) {
    const out = new Array(end - start);
    for (let i = start; i < end; i++) out[i - start] = i;
    return out;
}

/**
 * Signed surface distance of each fitted position, in chunks per frame.
 * @param {Array<{x,y,z}>} positions - fitted positions, storage frame
 * @param {{maxDistance?: number, onProgress?: function(number, number), signal?: {aborted: boolean}, chunkSize?: number}} [options]
 *   maxDistance: search radius in metres (default searchRadiusForLimit()).
 * @returns {Promise<{measured: boolean, searchRadius: number,
 *            distances: Array<number|null>, results: Array<{point: {x,y,z}, distance: number, side: number}|null>}>}
 *   measured false (no BVH): nothing is queried, every distance and result
 *   is null. Otherwise distances[i] = signed distance (positive = above), or
 *   Infinity when no surface lies within searchRadius; results[i] = {point:
 *   nearest surface point (storage), distance: the same signed value, side:
 *   +1|-1}, or null beyond the radius. distances goes straight into
 *   classifyByDistance(); see classifyMeasurement(). Rejects with an
 *   AbortError (see runChunked).
 */
export async function measureSurfaceDistances(positions, {
    maxDistance = searchRadiusForLimit(), onProgress = null, signal = null, chunkSize = SURFACE_CHUNK_SIZE
} = {}) {
    const n = positions.length;
    if (!isSurfaceQueryAvailable()) {
        return { measured: false, searchRadius: maxDistance, distances: new Array(n).fill(null), results: new Array(n).fill(null) };
    }
    const distances = new Array(n).fill(Infinity);
    const results = new Array(n).fill(null);
    await runChunked(n, (start, end) => measureIndices(positions, indexRange(start, end), maxDistance, distances, results),
        { chunkSize, onProgress, signal });
    return { measured: true, searchRadius: maxDistance, distances, results };
}

/**
 * Re-measures the rows found beyond the search radius once the user raises
 * the selection limit above that radius: an Infinity distance is final only
 * for limits up to the radius it was measured with (classifyByDistance).
 * The other rows keep their values.
 * @param {Array<{x,y,z}>} positions - the positions measured before
 * @param {object} measurement - a measureSurfaceDistances() result
 * @param {number} limit - the new selection limit
 * @param {object} [options] - onProgress, signal, chunkSize as for measureSurfaceDistances
 * @returns {Promise<object>} the same measurement when nothing needs measuring
 *   again (no BVH, or limit <= searchRadius), else a new one with
 *   searchRadius = searchRadiusForLimit(limit)
 */
export async function remeasureForLimit(positions, measurement, limit, { onProgress = null, signal = null, chunkSize = SURFACE_CHUNK_SIZE } = {}) {
    if (!measurement.measured || !(limit > measurement.searchRadius)) return measurement;
    const radius = searchRadiusForLimit(limit);
    const distances = measurement.distances.slice();
    const results = measurement.results.slice();
    const far = [];
    distances.forEach((d, i) => { if (d === Infinity) far.push(i); });
    await runChunked(far.length, (start, end) => measureIndices(positions, far.slice(start, end), radius, distances, results),
        { chunkSize, onProgress, signal });
    return { measured: true, searchRadius: radius, distances, results };
}

/**
 * The selection step's row classification for a measurement: the measured
 * distances decide, or, without a BVH, the fitted positions and the model's
 * bounding box (a row within the limit of the box counts as on the model).
 * @param {object[]} records
 * @param {Array<{x,y,z}>} positions - the fitted storage positions that were measured
 * @param {object} measurement - a measureSurfaceDistances() result
 * @param {{limit?: number}} [options]
 * @returns {object} classifyByDistance() result
 */
export function classifyMeasurement(records, positions, measurement, { limit = SELECTION_LIMIT_DEFAULT } = {}) {
    if (measurement.measured) return classifyByDistance(records, measurement.distances, { limit });
    return classifyByDistance(records, measurement.distances, { limit, positions, box: modelStorageBox() });
}

// ============ Snapping ============

// Snaps positions[start..end-1] (one batch, unlimited radius) into out.
// Returns false when nothing could be snapped (no BVH).
function snapRange(positions, start, end, out) {
    const slice = positions.slice(start, end);
    const hits = nearestSurfacePointsFlipAware(slice, Infinity);
    slice.forEach((p, k) => {
        const hit = hits && hits[k];
        out[start + k] = hit
            ? { point: hit.point, surfaceDistance: hit.side * hit.distance }
            : { point: { x: p.x, y: p.y, z: p.z }, surfaceDistance: null };
    });
    return !!hits;
}

/**
 * Snaps fitted positions to the surface, synchronously (for long lists use
 * snapToSurfaceChunked). The search radius is unlimited: every position gets
 * its nearest surface point, as the plan requires for every imported point.
 * @param {Array<{x,y,z}>} positions - fitted positions, storage frame
 * @returns {Array<{point: {x,y,z}, surfaceDistance: number|null}>} point = the
 *   nearest surface point (storage), surfaceDistance = signed distance from the
 *   fitted position. Without a BVH: a copy of the fitted position and null.
 */
export function snapToSurface(positions) {
    const out = new Array(positions.length);
    snapRange(positions, 0, positions.length, out);
    return out;
}

/**
 * snapToSurface in chunks per frame.
 * @param {Array<{x,y,z}>} positions
 * @param {{onProgress?: function(number, number), signal?: {aborted: boolean}, chunkSize?: number}} [options]
 * @returns {Promise<Array<{point: {x,y,z}, surfaceDistance: number|null}>>} rejects with an AbortError (see runChunked)
 */
export async function snapToSurfaceChunked(positions, options = {}) {
    const out = new Array(positions.length);
    await runChunked(positions.length, (start, end) => snapRange(positions, start, end, out), options);
    return out;
}

/**
 * Surface positions for the rows of a measurement, for creating points:
 * rows measured within the search radius reuse their nearest point, rows
 * beyond it (ticked by hand) are snapped with an unlimited radius, and
 * without a BVH every row keeps its fitted position with surfaceDistance null.
 * @param {Array<{x,y,z}>} positions - the fitted storage positions that were measured
 * @param {object} measurement - a measureSurfaceDistances() result
 * @param {number[]} [indices] - the rows to place (default: all), e.g. the ticked ones
 * @param {object} [options] - onProgress, signal, chunkSize for the snapping of far rows
 * @returns {Promise<Array<{index: number, point: {x,y,z}, surfaceDistance: number|null}>>} in the order of indices
 */
export async function surfacePlacements(positions, measurement, indices = null, options = {}) {
    const rows = indices || positions.map((_, i) => i);
    const placed = new Map();
    const far = [];
    for (const i of rows) {
        const r = measurement.measured ? measurement.results[i] : null;
        if (r) placed.set(i, { index: i, point: { ...r.point }, surfaceDistance: r.distance });
        else if (measurement.measured) far.push(i);
        else placed.set(i, { index: i, point: { ...positions[i] }, surfaceDistance: null });
    }
    if (far.length > 0) {
        const snaps = await snapToSurfaceChunked(far.map(i => positions[i]), options);
        far.forEach((i, k) => placed.set(i, { index: i, ...snaps[k] }));
    }
    return rows.map(i => placed.get(i));
}

// ============ Re-placement (refine, merge) ============

// Moves that may still be applied: the annotation is a survey point placed
// by the fit. A point moved by hand since the plan was made stays.
function stillFitPoint(move) {
    const s = move && move.annotation && move.annotation.survey;
    return !!s && s.placement !== PLACEMENT.MANUAL && !!move.to;
}

// What a chunked run checks again before it writes: the survey block, its
// alignment and points[0] as they were when the run started.
function markOf(ann) {
    const p = ann.points && ann.points[0];
    return { survey: ann.survey, alignmentId: ann.survey.alignmentId, point: p ? { x: p.x, y: p.y, z: p.z } : null };
}

function unchangedSince(ann, mark, session) {
    const p = ann.points && ann.points[0];
    return session.has(ann) && ann.survey === mark.survey && ann.survey.alignmentId === mark.alignmentId &&
        (p && mark.point ? p.x === mark.point.x && p.y === mark.point.y && p.z === mark.point.z : p === mark.point);
}

// marks: markOf() per move for a chunked run, or null (synchronous run).
function finishReplacement(moves, snaps, skippedBefore, snapped, marks = null) {
    const shifts = [];
    let skipped = skippedBefore;
    const session = marks ? new Set(state.annotations) : null;
    moves.forEach((move, i) => {
        // Checked again: a chunked run leaves time for a drag, an undo, a
        // second import or a new model; a point changed meanwhile keeps the
        // newer state.
        if (!stillFitPoint(move) || (marks && !unchangedSince(move.annotation, marks[i], session))) { skipped++; return; }
        const ann = move.annotation;
        const before = ann.points[0];
        const after = snaps[i].point;
        ann.points[0] = after;
        ann.survey.surfaceDistance = snaps[i].surfaceDistance;
        shifts.push(before && [before.x, before.y, before.z].every(isNum) ? distance3(before, after) : 0);
    });
    return {
        moved: shifts.length,
        maxMove: shifts.reduce((m, v) => Math.max(m, v), 0),
        medianMove: shifts.length ? median(shifts) : 0,
        skipped,
        snapped
    };
}

/**
 * Moves the 'fit' points of a refine plan to their new fitted positions and
 * snaps them to the surface: points[0] = nearest surface point of move.to,
 * survey.surfaceDistance = its signed distance; placement stays 'fit'.
 * Points moved by hand ('manual') are never moved, also when they became
 * manual after the plan was made. Without a model or BVH the points move to
 * their fitted positions unsnapped, with surfaceDistance null.
 * Synchronous; use applyReplacementChunked for more than SURFACE_CHUNK_SIZE points.
 * @param {{moves: Array<{annotation: object, to: {x,y,z}}>}} plan - a
 *   planRefinePlacement() result (only moves is read), or several plans' moves joined
 * @returns {{moved: number, maxMove: number, medianMove: number, skipped: number, snapped: boolean}}
 *   moved = points moved; maxMove / medianMove = metres between each moved
 *   point's old and new points[0]; skipped = moves left out (hand-moved);
 *   snapped = whether the points were snapped (false without a BVH).
 */
export function applyReplacement(plan) {
    const all = (plan && plan.moves) || [];
    const moves = all.filter(stillFitPoint);
    const out = new Array(moves.length);
    const snapped = moves.length > 0 ? snapRange(moves.map(m => m.to), 0, moves.length, out) : isSurfaceQueryAvailable();
    return finishReplacement(moves, out, all.length - moves.length, snapped);
}

/**
 * applyReplacement in chunks per frame. The surface queries run chunk by
 * chunk; the points move together at the end, so an aborted run moves nothing.
 * Call it right after making the plan. At the end a point is skipped (counted
 * in skipped) when it became manual, left the session, or got another survey
 * block, alignment or points[0] since the call: the targets were computed
 * from the state at the start, and newer state wins.
 * @param {{moves: Array<{annotation: object, to: {x,y,z}}>}} plan
 * @param {{onProgress?: function(number, number), signal?: {aborted: boolean}, chunkSize?: number}} [options]
 * @returns {Promise<{moved: number, maxMove: number, medianMove: number, skipped: number, snapped: boolean}>}
 *   rejects with an AbortError (see runChunked)
 */
export async function applyReplacementChunked(plan, options = {}) {
    const all = (plan && plan.moves) || [];
    const moves = all.filter(stillFitPoint);
    const marks = moves.map(m => markOf(m.annotation));
    const snapped = isSurfaceQueryAvailable();
    const out = await snapToSurfaceChunked(moves.map(m => m.to), options);
    return finishReplacement(moves, out, all.length - moves.length, snapped, marks);
}

/**
 * Status-line text for points moved after a merge, e.g.
 * '3 survey points moved to the newer alignment (largest 0.042 m)'.
 * @param {object} stats - an applyReplacement() result
 * @param {{alignmentCount?: number}} [options] - number of alignments the points moved to
 * @returns {string} '' when nothing moved
 */
export function replacementSummary(stats, { alignmentCount = 1 } = {}) {
    if (!stats || !(stats.moved > 0)) return '';
    const details = [`largest ${formatMetres(stats.maxMove)}`];
    if (!stats.snapped) details.push('not snapped to the surface');
    return `${stats.moved} survey point${stats.moved !== 1 ? 's' : ''} moved to the newer ` +
        `alignment${alignmentCount > 1 ? 's' : ''} (${details.join(', ')})`;
}

// ============ Creating points from CSV rows ============

/**
 * SHA-256 of the CSV bytes as lowercase hex (survey.source.fileSha256, one of
 * the duplicate keys), formatted like the model hash.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<string|null>} null where crypto.subtle is missing (an
 *   insecure context such as file://) or the digest fails
 */
export async function sha256Hex(bytes) {
    try {
        if (!globalThis.crypto || !globalThis.crypto.subtle) return null;
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        console.warn('Survey file hash failed:', e);
        return null;
    }
}

/**
 * The file name without its extension, for import group and point names.
 * @param {string} fileName - e.g. 'trench3.csv'
 * @returns {string} 'trench3' ('Survey import' for an empty name)
 */
export function fileBaseName(fileName) {
    const name = String(fileName ?? '').trim();
    return name.replace(/\.[^./\\]*$/, '') || name || 'Survey import';
}

/**
 * The annotation name of a row: its Name cell, or '<file> row N' when the
 * cell is blank or no Name column is mapped (N = spreadsheet row).
 * @param {object} record - a buildRecords() record
 * @param {string} fileName
 */
export function surveyPointName(record, fileName) {
    return record.name || `${fileBaseName(fileName)} row ${record.row}`;
}

/**
 * The first entry's text: the Description cell, plus a 'Code: X' line when
 * the row has a code.
 * @param {object} record - a buildRecords() record
 * @returns {string} '' when the row has neither
 */
export function surveyEntryText(record) {
    const lines = [];
    if (record.description) lines.push(record.description);
    if (record.code) lines.push(`Code: ${record.code}`);
    return lines.join('\n');
}

/**
 * The attributes kept on a point: the code first, keyed by the Code column's
 * header (so it survives as data, as in the plan's JSON-LD example), then the
 * extra columns verbatim. When the Code column is also ticked as an extra
 * column, its verbatim cell is kept.
 * @param {object} record - a buildRecords() record
 * @param {string|null} [codeColumn] - header of the mapped Code column
 * @returns {object} header -> string
 */
export function surveyAttributes(record, codeColumn = null) {
    const out = {};
    if (codeColumn && record.code) out[codeColumn] = record.code;
    for (const [key, value] of Object.entries(record.attributes || {})) out[key] = value;
    return out;
}

// ============ Import groups ============

/**
 * A group name not used yet: name, else name + ' (2)', ' (3)' and so on.
 * @param {string} name
 * @param {object[]} groups - state.groups
 */
export function uniqueGroupName(name, groups) {
    const taken = new Set((groups || []).map(g => g && g.name));
    if (!taken.has(name)) return name;
    for (let k = 2; ; k++) {
        const candidate = `${name} (${k})`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** The first SURVEY_GROUP_COLORS entry no group uses (cycling when all are taken). */
export function surveyGroupColor(groups) {
    const list = groups || [];
    const used = new Set(list.map(g => String((g && g.color) || '').toLowerCase()));
    return SURVEY_GROUP_COLORS.find(c => !used.has(c.toLowerCase())) ||
        SURVEY_GROUP_COLORS[list.length % SURVEY_GROUP_COLORS.length];
}

/**
 * Whether an import group shows labels: off when the import has more points
 * than labelsOffAbove (0 = never off).
 */
export function labelsVisibleFor(pointCount, labelsOffAbove = LABELS_OFF_ABOVE_DEFAULT) {
    return !(labelsOffAbove > 0 && pointCount > labelsOffAbove);
}

/**
 * A new import group (not added to state): the createGroupInline() shape plus
 * collapsed: true and labelsVisible from labelsVisibleFor().
 * @param {{name: string, groups?: object[], pointCount?: number, labelsOffAbove?: number}} options
 *   name: the wanted name (made unique against groups)
 */
export function makeSurveyGroup({ name, groups = [], pointCount = 0, labelsOffAbove = LABELS_OFF_ABOVE_DEFAULT }) {
    return {
        id: generateInternalId(),
        uuid: generateUUID(),
        name: uniqueGroupName(name, groups),
        color: surveyGroupColor(groups),
        visible: true,
        opacity: 1.0,
        collapsed: true,
        labelsVisible: labelsVisibleFor(pointCount, labelsOffAbove)
    };
}

// ============ Annotations ============

/**
 * A point annotation for one CSV row, in the shape saveAnnotation() in
 * data.js creates, plus `locked` (only when true) and `survey`.
 * @param {object} record - a buildRecords() record
 * @param {{name: string, point: {x,y,z}, surfaceDistance?: number|null, alignmentId, groupId,
 *          fileName: string, fileSha256?: string|null, importedAt: string, author?: string,
 *          language?: string, locked?: boolean, codeColumn?: string|null}} options
 *   point: the nearest surface point (storage frame); surfaceDistance: signed
 *   metres from the fitted position, null when not measured; importedAt: ISO
 *   time of the import (the entry timestamp and survey.source.importedAt);
 *   author: the Settings identity (creator and entry author); language: the
 *   default entry language (getDefaultLanguage()).
 * @returns {object} annotation
 */
export function buildSurveyAnnotation(record, {
    name, point, surfaceDistance = null, alignmentId, groupId, fileName, fileSha256 = null,
    importedAt, author = '', language, locked = true, codeColumn = null
}) {
    const ann = {
        id: generateInternalId(),
        uuid: generateUUID(),
        type: 'point',
        name,
        creator: author,
        groupId,
        points: [{ x: point.x, y: point.y, z: point.z }],
        entries: [{
            id: generateInternalId(),
            uuid: generateUUID(),
            description: surveyEntryText(record),
            author,
            language,
            timestamp: importedAt,
            links: []
        }]
    };
    if (locked) ann.locked = true;
    ann.survey = {
        alignmentId,
        e: record.e,
        n: record.n,
        h: record.h,
        raw: { e: record.raw.e, n: record.raw.n, h: record.raw.h },
        columns: { e: record.columns.e, n: record.columns.n, h: record.columns.h },
        attributes: surveyAttributes(record, codeColumn),
        source: { fileName, fileSha256, row: record.row, importedAt },
        placement: PLACEMENT.FIT,
        surfaceDistance: isNum(surfaceDistance) ? surfaceDistance : null
    };
    return ann;
}

function duplicateMessage(reason, other) {
    if (reason === DUPLICATE_REASONS.SAME_ROW) return 'already imported from this file';
    return other ? `same name and position as row ${other.record.row}` : 'same name and position as an existing point';
}

function nameConflictMessage(entry, reason, other) {
    const row = entry.record.row;
    if (reason === DUPLICATE_REASONS.SAME_NAME) {
        return other
            ? `Row ${row}: the name "${entry.name}" is also used by row ${other.record.row}, at other coordinates.`
            : `Row ${row}: the name "${entry.name}" is already used by a point of this alignment at other coordinates.`;
    }
    return `Row ${row}: the name "${entry.name}" is already used by another annotation.`;
}

/**
 * The duplicate rules for the ticked rows (plan: Data model > Identity), run
 * before anything is placed: exact duplicates (same alignment and file hash
 * and row, or same alignment and name with coordinates within 1 mm) are
 * skipped; a name already in use is imported and flagged.
 * @param {Array<{index: number, record: object}>} selected - the ticked rows, in list order
 * @param {{fileName: string, alignmentId, fileSha256?: string|null, annotations?: object[]}} options
 *   annotations: the session's annotations (state.annotations)
 * @returns {{create: Array<{index, record, name}>,
 *            duplicates: Array<{index, record, name, reason, message}>,
 *            nameConflicts: Array<{index, record, name, reason, message}>}}
 *   duplicates are left out of create; nameConflicts are in create too.
 *   message: summary text (contains CSV text: render it with textContent).
 */
export function planSurveyCreation(selected, { fileName, alignmentId, fileSha256 = null, annotations = [] }) {
    const named = (selected || []).map(s => ({ index: s.index, record: s.record, name: surveyPointName(s.record, fileName) }));
    const checks = checkDuplicates(
        named.map(s => ({ name: s.name, row: s.record.row, e: s.record.e, n: s.record.n, h: s.record.h })),
        annotations, { alignmentId, fileSha256 });
    const create = [], duplicates = [], nameConflicts = [];
    named.forEach((entry, k) => {
        const check = checks[k];
        const other = check.match && Number.isInteger(check.match.index) ? named[check.match.index] : null;
        if (check.status === DUPLICATE_STATUS.DUPLICATE) {
            duplicates.push({ ...entry, reason: check.reason, message: duplicateMessage(check.reason, other) });
            return;
        }
        create.push(entry);
        if (check.status === DUPLICATE_STATUS.NAME_CONFLICT) {
            nameConflicts.push({ ...entry, reason: check.reason, message: nameConflictMessage(entry, check.reason, other) });
        }
    });
    return { create, duplicates, nameConflicts };
}

/**
 * Adds the planned points to the session: one point annotation per row of
 * plan.create, in a new import group (collapsed; labels off above
 * labelsOffAbove points) or in an existing group (left as it is: its labels
 * also belong to annotations the import did not make; labelsCrowded tells the
 * summary to mention them). Changes state.groups and state.annotations only:
 * the caller refreshes the group select, the sidebar and the scene once.
 * @param {{plan: object, placements: Array<{index, point, surfaceDistance}>, alignmentId,
 *          fileName: string, fileSha256?: string|null, codeColumn?: string|null,
 *          group: {kind: 'new', name?: string}|{kind: 'existing', groupId},
 *          author?: string, language?: string, locked?: boolean, labelsOffAbove?: number,
 *          importedAt: string}} options
 *   plan: planSurveyCreation(); placements: surfacePlacements() for the
 *   indices of plan.create. An existing group that no longer exists falls
 *   back to a new group. No group is made when nothing is created.
 * @returns {{created: object[], group: object|null, groupCreated: boolean, labelsCrowded: boolean}}
 */
export function commitSurveyImport({
    plan, placements, alignmentId, fileName, fileSha256 = null, codeColumn = null, group: target,
    author = '', language, locked = true, labelsOffAbove = LABELS_OFF_ABOVE_DEFAULT, importedAt
}) {
    const rows = plan.create;
    if (rows.length === 0) return { created: [], group: null, groupCreated: false, labelsCrowded: false };
    const byIndex = new Map((placements || []).map(p => [p.index, p]));
    for (const row of rows) {
        if (!byIndex.has(row.index)) throw new RangeError(`survey-import: no placement for row index ${row.index}`);
    }

    let group = target && target.kind === 'existing' ? (state.groups.find(g => g.id === target.groupId) || null) : null;
    let groupCreated = false, labelsCrowded = false;
    if (!group) {
        group = makeSurveyGroup({
            name: (target && target.name) || fileBaseName(fileName),
            groups: state.groups, pointCount: rows.length, labelsOffAbove
        });
        state.groups.push(group);
        groupCreated = true;
    } else {
        labelsCrowded = !labelsVisibleFor(rows.length, labelsOffAbove) && group.labelsVisible !== false;
    }

    const created = rows.map(row => {
        const placed = byIndex.get(row.index);
        return buildSurveyAnnotation(row.record, {
            name: row.name, point: placed.point, surfaceDistance: placed.surfaceDistance,
            alignmentId, groupId: group.id, fileName, fileSha256, importedAt,
            author, language, locked, codeColumn
        });
    });
    // One push per item: a spread of thousands of arguments can exceed the call stack.
    for (const ann of created) state.annotations.push(ann);
    return { created, group, groupCreated, labelsCrowded };
}

// ============ Import jobs and remembered mappings ============

/**
 * The import job with another column mapping (the selection step's Swap
 * button): records, skipped rows and the column names rebuilt from the
 * parsed rows. The job shape is described in ui-mapping.js.
 * @param {object} job
 * @param {object} mapping - e.g. swapMappingEN(job.mapping)
 * @returns {object} a new job
 */
export function jobWithMapping(job, mapping) {
    const headers = job.parsed.headers;
    const built = buildRecords(job.parsed.rows, mapping, { decimal: job.decimal, headers });
    const hasCode = Number.isInteger(mapping.code);
    return {
        ...job,
        mapping,
        preset: 'custom',
        records: built.valid,
        skipped: built.skipped,
        codeColumn: hasCode ? (headers[mapping.code] ?? null) : null,
        heightColumn: headers[mapping.height] ?? null
    };
}

/**
 * A remembered mapping made safe for the file at hand: indices outside the
 * columns are dropped, extras never repeat a mapped column.
 * @param {object|null} mapping - from getSurveyMapping() (lighting.js)
 * @param {number} columnCount - parsed.headers.length
 * @returns {object|null} a mapping, or null when Easting, Northing or Height is unusable
 */
export function sanitizeMapping(mapping, columnCount) {
    if (!mapping || typeof mapping !== 'object') return null;
    const ok = (j) => Number.isInteger(j) && j >= 0 && j < columnCount;
    const out = emptyMapping();
    for (const role of MAPPING_ROLES) out[role] = ok(mapping[role]) ? mapping[role] : null;
    if (!REQUIRED_ROLES.every(role => out[role] !== null)) return null;
    const mapped = new Set(MAPPING_ROLES.map(role => out[role]).filter(j => j !== null));
    out.extras = [...new Set(Array.isArray(mapping.extras) ? mapping.extras : [])].filter(j => ok(j) && !mapped.has(j));
    return out;
}

// ============ Selection step and summary ============

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A distance with up to three decimals and no trailing zeros: '0.5 m'.
export function metresShort(value) {
    return isNum(value) ? `${parseFloat(value.toFixed(3))} m` : '—';
}

/**
 * How far a row of the selection step lies from the model, for the list and
 * the summary.
 * @param {object} row - a classifyByDistance() row
 * @param {{searchRadius: number}} measurement - the measureSurfaceDistances() result it came from
 * @returns {string} '0.023 m', 'more than 2 m', '0.400 m from the model box', 'inside the model box' or 'not measured'
 */
export function selectionDistanceText(row, measurement) {
    if (row.method === SELECTION_METHODS.SURFACE) {
        if (row.distance === Infinity) return `more than ${metresShort(measurement && measurement.searchRadius)}`;
        return formatMetres(Math.abs(row.distance));
    }
    if (row.method === SELECTION_METHODS.BOX) {
        return row.boxDistance > 0 ? `${formatMetres(row.boxDistance)} from the model box` : 'inside the model box';
    }
    return 'not measured';
}

/**
 * The import summary (plan: Step D, 3): number imported, rows off the model,
 * rows skipped with reason and row number, and warnings.
 * @param {{job: object, alignment: object, classification: object, ticked: Iterable<number>,
 *          plan: object, result: object, measurement: object, limit: number,
 *          surfaceWarn?: number, labelsOffAbove?: number, acceptedWarnings?: string[]}} input
 *   classification: the selection's classifyByDistance() result; ticked: the
 *   record indices chosen; plan: planSurveyCreation(); result:
 *   commitSurveyImport(); acceptedWarnings: messages accepted in the mapping
 *   dialog (binding warnings, a height-column mismatch used anyway).
 * @returns {{fileName, alignmentName, crsLabel, groupName, limit, measured, imported,
 *            offModel: Array<{row, name, distance}>, unticked: Array<{row, name, distance}>,
 *            skipped: Array<{row, name, reason}>, warnings: string[]}}
 *   Names, reasons and warnings contain CSV text: render with textContent.
 */
export function surveyImportSummary({
    job, alignment, classification, ticked, plan, result, measurement, limit,
    surfaceWarn = SURFACE_WARN_DEFAULT, labelsOffAbove = LABELS_OFF_ABOVE_DEFAULT, acceptedWarnings = []
}) {
    const chosen = new Set(ticked || []);
    const fileName = job.file.name;
    const offModel = [], unticked = [];
    for (const row of classification.rows) {
        if (chosen.has(row.index)) continue;
        const line = { row: row.record.row, name: surveyPointName(row.record, fileName), distance: selectionDistanceText(row, measurement) };
        (row.onModel ? unticked : offModel).push(line);
    }
    const skipped = [
        ...(job.skipped || []).map(s => ({ row: s.row, name: s.name || '', reason: s.message })),
        ...plan.duplicates.map(d => ({ row: d.record.row, name: d.name, reason: d.message }))
    ].sort((a, b) => a.row - b.row);

    const created = result.created;
    const warnings = [...acceptedWarnings, ...plan.nameConflicts.map(c => c.message)];
    if (!measurement.measured && created.length) {
        warnings.push('The model has no surface query (BVH): the points stay at their fitted positions, without a distance to the surface.');
    }
    // Created points beyond the warning distance, one line per kind: from the
    // surface, or (no surface query) outside the model's bounding box.
    const rowsByIndex = new Map(classification.rows.map(row => [row.index, row]));
    const far = [], outside = [];
    plan.create.forEach((entry, k) => {
        const ann = created[k];
        if (!ann) return;
        const d = ann.survey.surfaceDistance;
        const row = rowsByIndex.get(entry.index);
        if (isNum(d)) {
            if (Math.abs(d) > surfaceWarn) far.push({ row: entry.record.row, distance: Math.abs(d) });
        } else if (row && row.method === SELECTION_METHODS.BOX && row.boxDistance > surfaceWarn) {
            outside.push({ row: entry.record.row, distance: row.boxDistance });
        }
    });
    const farWarning = (items, where) => {
        if (!items.length) return;
        const largest = items.reduce((m, x) => Math.max(m, x.distance), 0);
        const rows = items.map(x => x.row).join(', ');
        warnings.push(`${plural(items.length, 'point')} ${items.length === 1 ? 'lies' : 'lie'} more than ${metresShort(surfaceWarn)} ${where} ` +
            `(largest ${formatMetres(largest)}): ${items.length === 1 ? 'row' : 'rows'} ${rows}.`);
    };
    farWarning(far, 'from the surface');
    farWarning(outside, 'outside the model bounding box');
    if (result.group && result.groupCreated && result.group.labelsVisible === false) {
        warnings.push(`Labels are hidden in group "${result.group.name}" because the import has more than ${labelsOffAbove} points. They can be turned on in the group settings.`);
    } else if (result.group && result.labelsCrowded) {
        warnings.push(`Group "${result.group.name}" shows labels and received more than ${labelsOffAbove} points. Labels can be turned off in the group settings.`);
    }
    return {
        fileName,
        alignmentName: alignment.name || 'Unnamed alignment',
        crsLabel: crsDisplayLabel(alignment),
        groupName: result.group ? result.group.name : '',
        limit,
        measured: !!measurement.measured,
        imported: created.length,
        offModel,
        unticked,
        skipped,
        warnings
    };
}

/**
 * The summary as plain text for the Copy button.
 * @param {object} summary - surveyImportSummary()
 * @returns {string}
 */
export function surveySummaryText(summary) {
    const lines = [
        `Survey import: ${summary.fileName}`,
        `Alignment: ${summary.alignmentName} (${summary.crsLabel})`
    ];
    if (summary.groupName) lines.push(`Group: ${summary.groupName}`);
    lines.push(`Distance limit: ${metresShort(summary.limit)}${summary.measured ? '' : ' (model bounding box, no surface query)'}`);
    lines.push('', `Imported: ${plural(summary.imported, 'point')}`);
    lines.push(`Not imported, off the model: ${summary.offModel.length}`);
    if (summary.unticked.length) lines.push(`Not imported, unticked: ${summary.unticked.length}`);
    lines.push(`Skipped: ${summary.skipped.length}`);
    const rowText = (r, detail) => [`Row ${r.row}`, r.name, detail].filter(Boolean).join('  ');
    const section = (title, items) => {
        if (!items.length) return;
        lines.push('', title);
        items.forEach(t => lines.push(`  ${t}`));
    };
    section('Off the model', summary.offModel.map(r => rowText(r, r.distance)));
    section('Unticked', summary.unticked.map(r => rowText(r, r.distance)));
    section('Skipped', summary.skipped.map(r => rowText(r, r.reason)));
    section('Warnings', summary.warnings);
    return lines.join('\n');
}
