// js/survey/alignment.js - Survey alignments: transforms, refine, selection, duplicates, JSON-LD and merge
// Pure: imports only linalg.js, rigid-fit.js and ../utils/coords.js, so it loads
// in Node tests. No Three.js, state or DOM.
//
// Frames
// - Storage: the Three.js Y-up scene frame, re-centred and not flipped. An
//   annotation's points[0] lives here.
// - Export: the Z-up frame of pointToZUp(storage), the numbers written as
//   meshnotes:wkt. Control-point modelPosition is kept in this frame.
// - Survey: E, N, H in metres, in the CSV's projected coordinate system.
// An alignment maps export to survey: survey = R * p + t, with R the unit
// quaternion rotation [x, y, z, w] and t the translation [tE, tN, tH]. The
// inverse subtracts first, p = R^T * (survey - t), in double precision, so
// seven-digit UTM numbers never reach the scene.
//
// Identity, the same pattern as groups:
// - id: the internal session handle. The caller passes it, or a generator
//   such as helpers.generateInternalId (this module cannot import helpers).
//   annotation.survey.alignmentId holds this id.
// - uuid: the persistent identity. JSON-LD always writes
//   'urn:meshnotes:alignment:<uuid>', and the readers return uuid -> id maps
//   (like groupIdMap in import-json.js) to resolve survey.alignment references.
//
// Alignment:
//   { id, uuid, name, crsLabel, heightColumn, modelSha256, modelUpAxis,
//     fitType, rotation, translation,
//     quality: { n, rms, rmsH, rmsV, maxResidual, scale, tiltDeg, headingDeg, flags },
//     controlPoints: [{ label, csvRow, enabled, modelPosition: {x,y,z} (export frame),
//                       surveyed: {e,n,h}, residual: [dE,dN,dH]|null, looError, annotationUuid }],
//     created, modified, creator, creatorOrcid,
//     versions: [{ fitType, rotation, translation, quality, controlPoints, created, modified }] }
// Control points are copies, never shared with the picking session, the CSV
// records or the annotations, so deleting imported points later leaves the
// record of how the alignment was made intact. A version records an earlier
// fit and the time span it was in use (created = when that fit was made,
// modified = when it was replaced). A version records no model binding: after
// a refine that rebinds to another model file, older versions' modelPositions
// refer to the earlier model, which is not recorded (the plan keeps only the
// earlier fits).

import { sub3, norm3, matVec, transpose, quatToMat } from './linalg.js';
import {
    solveFit, tiltFromMatrix, headingFromMatrix,
    DUPLICATE_TOLERANCE, SELECTION_LIMIT_DEFAULT, RESIDUAL_WARN_DEFAULT
} from './rigid-fit.js';
import { wktPointZ, parsePointZ, pointToZUp, pointFromZUp } from '../utils/coords.js';

// ============ Constants ============

export const ALIGNMENT_URN_PREFIX = 'urn:meshnotes:alignment:';
export const ANNOTATION_URN_PREFIX = 'urn:meshnotes:annotation:';
export const FIT_TYPES = Object.freeze(['rigid6', 'level4']);

// survey.placement: 'fit' = placed from the alignment (a refine moves it),
// 'manual' = moved by hand (a refine never moves it).
export const PLACEMENT = Object.freeze({ FIT: 'fit', MANUAL: 'manual' });

// Shown wherever an empty coordinate system label would appear.
export const UNSPECIFIED_CRS = 'unspecified coordinate system';

// How a row of the selection step was judged (classifyByDistance).
export const SELECTION_METHODS = Object.freeze({
    SURFACE: 'surface',   // a measured surface distance
    BOX: 'box',           // no surface distance (no BVH): the model's bounding box decides
    NONE: 'none'          // neither: never on the model
});

export const DUPLICATE_STATUS = Object.freeze({
    NEW: 'NEW',                       // imported
    DUPLICATE: 'DUPLICATE',           // skipped and counted
    NAME_CONFLICT: 'NAME_CONFLICT'    // name already in use (see DUPLICATE_REASONS): imported and flagged
});

export const DUPLICATE_REASONS = Object.freeze({
    SAME_ROW: 'SAME_ROW',                         // same alignment, file hash and row
    SAME_NAME_POSITION: 'SAME_NAME_POSITION',     // same alignment and name, coordinates within DUPLICATE_TOLERANCE
    SAME_NAME: 'SAME_NAME',                       // same alignment and name, coordinates farther apart
    SAME_NAME_OTHER: 'SAME_NAME_OTHER'            // name of another annotation (not a survey point of this alignment)
});

export const BINDING_WARNINGS = Object.freeze({
    MODEL_HASH: 'MODEL_HASH',   // made on a different model file
    UP_AXIS: 'UP_AXIS'          // made with the model loaded under the other up-axis
});

// Where a survey point's position and survey data come from in a merge.
export const MERGE_SOURCE = Object.freeze({
    IMPORTED: 'imported',   // the imported alignment is newer: take the imported copy
    LOCAL: 'local',         // the local alignment is newer or equal: keep the local copy
    ENTRIES: 'entries'      // no alignment rule applies: the existing entries-timestamp rule decides
});

// ============ Small helpers ============

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (v) => (typeof v === 'string' ? v : '');
const textOrNull = (v) => (typeof v === 'string' && v ? v : null);
const intOrNull = (v) => (Number.isInteger(v) ? v : null);

function numberList(v, length) {
    return Array.isArray(v) && v.length === length && v.every(isNum) ? v.slice() : null;
}

// A JSON-LD member that may hold one object instead of an array.
function asList(v) {
    if (Array.isArray(v)) return v;
    return v && typeof v === 'object' ? [v] : [];
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function modelVec(p) {
    let v;
    if (Array.isArray(p)) v = [p[0], p[1], p[2]];
    else if (p) v = [p.x, p.y, p.z];
    if (!v || !v.every(isNum)) throw new TypeError('alignment: a model point needs finite x, y, z');
    return v;
}

function surveyVec(s) {
    let v;
    if (Array.isArray(s)) v = [s[0], s[1], s[2]];
    else if (s) v = [s.e, s.n, s.h];
    if (!v || !v.every(isNum)) throw new TypeError('alignment: a survey point needs finite e, n, h');
    return v;
}

function median(values) {
    const v = values.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ISO timestamp from a Date, an ISO string or epoch milliseconds; now when absent.
function isoTime(now) {
    if (now instanceof Date) return now.toISOString();
    if (typeof now === 'string' && now) return now;
    if (isNum(now)) return new Date(now).toISOString();
    return new Date().toISOString();
}

// Milliseconds of an ISO timestamp, 0 when missing or unreadable.
function timeValue(s) {
    const t = typeof s === 'string' ? Date.parse(s) : NaN;
    return Number.isNaN(t) ? 0 : t;
}

function newId(id, generateId) {
    if (id !== undefined && id !== null) return id;
    if (typeof generateId === 'function') return generateId();
    throw new TypeError('alignment: pass an id or a generateId function');
}

// Pass helpers.generateUUID from the app; crypto.randomUUID is only a
// fallback for secure contexts and Node.
function newUuid(uuid, generateUuid) {
    if (typeof uuid === 'string' && uuid) return uuid;
    if (typeof generateUuid === 'function') return generateUuid();
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    throw new TypeError('alignment: pass a uuid or a generateUuid function');
}

// Canonical https://orcid.org/ URI of a bare iD or URL, or null. Same rule as
// normalizeOrcid in w3c-format.js, which cannot be imported here (Three.js).
function orcidUri(raw) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i);
    return m ? `https://orcid.org/${m[1].toUpperCase()}` : null;
}

// ============ Transforms ============

/**
 * Rotation matrix R (rows) of an alignment: survey = R * p + t.
 * @param {object} alignment - needs rotation [x, y, z, w]
 * @returns {number[][]}
 */
export function alignmentMatrix(alignment) {
    const q = alignment && alignment.rotation;
    if (!numberList(q, 4)) throw new TypeError('alignment: rotation must be four finite numbers [x, y, z, w]');
    return quatToMat(q);
}

function translationOf(alignment) {
    const t = alignment && alignment.translation;
    if (!numberList(t, 3)) throw new TypeError('alignment: translation must be three finite numbers [tE, tN, tH]');
    return t;
}

// Both directions with the matrix built once, for long lists of points.
function makeTransform(alignment) {
    const R = alignmentMatrix(alignment);
    const Rt = transpose(R);
    const t = translationOf(alignment);
    return {
        toSurvey(p) {
            const r = matVec(R, modelVec(p));
            return { e: r[0] + t[0], n: r[1] + t[1], h: r[2] + t[2] };
        },
        toExport(s) {
            // Subtract first: the difference is small and exact, so the
            // rotation never sees seven-digit numbers.
            const p = matVec(Rt, sub3(surveyVec(s), t));
            return { x: p[0], y: p[1], z: p[2] };
        }
    };
}

/**
 * Survey coordinate of a point in the export frame: R * p + t.
 * @param {object} alignment
 * @param {{x,y,z}|number[]} p - export frame (Z-up)
 * @returns {{e: number, n: number, h: number}}
 */
export function exportToSurvey(alignment, p) {
    return makeTransform(alignment).toSurvey(p);
}

/**
 * Export-frame position of a survey coordinate: R^T * (s - t), subtraction first.
 * @param {object} alignment
 * @param {{e,n,h}|number[]} s - a survey point, record or annotation.survey
 * @returns {{x: number, y: number, z: number}} export frame (Z-up)
 */
export function surveyToExport(alignment, s) {
    return makeTransform(alignment).toExport(s);
}

// Survey coordinate of a storage point (Y-up, unflipped, like points[0]).
export function storageToSurvey(alignment, p) {
    const v = modelVec(p);
    return exportToSurvey(alignment, pointToZUp({ x: v[0], y: v[1], z: v[2] }));
}

// Storage position (Y-up, unflipped) of a survey coordinate: the fitted
// position of a survey point. toDisplayCoords() of it gives the scene position.
export function surveyToStorage(alignment, s) {
    return pointFromZUp(surveyToExport(alignment, s));
}

// ============ Control points and fits ============

/**
 * A control point, copied from its parts: a CSV row (or an existing point
 * annotation) and the pick on the model.
 * @param {{label?: string, csvRow?: number|null, enabled?: boolean,
 *          modelPosition: {x,y,z}|number[], surveyed: {e,n,h}|number[],
 *          residual?: number[]|null, looError?: number|null, annotationUuid?: string|null}} cp
 *   modelPosition is in the export frame: pointToZUp(toStorageCoords(hit)),
 *   or pointToZUp(ann.points[0]) for an existing annotation.
 * @returns {object} a new control point (throws on non-finite coordinates)
 */
export function makeControlPoint({
    label = '', csvRow = null, enabled = true, modelPosition, surveyed,
    residual = null, looError = null, annotationUuid = null
} = {}) {
    const p = modelVec(modelPosition);
    const s = surveyVec(surveyed);
    return {
        label: typeof label === 'string' ? label : String(label ?? ''),
        csvRow: intOrNull(csvRow),
        enabled: enabled !== false,
        modelPosition: { x: p[0], y: p[1], z: p[2] },
        surveyed: { e: s[0], n: s[1], h: s[2] },
        residual: numberList(residual, 3),
        looError: isNum(looError) ? looError : null,
        annotationUuid: textOrNull(annotationUuid)
    };
}

// Copy of a stored control point, without validation.
function copyControlPoint(cp) {
    return {
        ...cp,
        modelPosition: { ...cp.modelPosition },
        surveyed: { ...cp.surveyed },
        residual: Array.isArray(cp.residual) ? cp.residual.slice() : null
    };
}

function copyQuality(q) {
    return {
        n: q.n, rms: q.rms, rmsH: q.rmsH, rmsV: q.rmsV, maxResidual: q.maxResidual,
        scale: q.scale, tiltDeg: q.tiltDeg, headingDeg: q.headingDeg,
        flags: Array.isArray(q.flags) ? q.flags.slice() : []
    };
}

/**
 * Fits the enabled control points (solveFit with P = modelPosition,
 * Q = surveyed, in list order).
 * @param {object[]} controlPoints
 * @param {'rigid6'|'level4'} [fitType]
 * @param {{residualWarn?: number}} [options] - passed to solveFit
 * @returns {{fit: object, indices: number[]}} fit = the solveFit result;
 *   indices[k] = position in controlPoints of the k-th fitted pair, so
 *   fit.residuals[k] and fit.looErrors[k] belong to controlPoints[indices[k]]
 */
export function fitControlPoints(controlPoints, fitType = 'rigid6', options = {}) {
    const list = controlPoints || [];
    const indices = [];
    list.forEach((cp, i) => { if (cp && cp.enabled !== false) indices.push(i); });
    const P = indices.map(i => list[i].modelPosition);
    const Q = indices.map(i => list[i].surveyed);
    return { fit: solveFit(P, Q, fitType, options), indices };
}

// The fit part of an alignment from a solveFit result (or a fresh fit when
// none is given) and the control points, residuals filled in. A disabled
// control point gets its prediction error against the fit as residual and no
// leave-one-out error.
function fitFields(fit, controlPoints, fitType, residualWarn) {
    const cps = (controlPoints || []).map(cp => makeControlPoint(cp));
    let result = fit;
    let indices;
    if (!result) {
        ({ fit: result, indices } = fitControlPoints(cps, fitType || 'rigid6', { residualWarn }));
    } else {
        indices = [];
        cps.forEach((cp, i) => { if (cp.enabled) indices.push(i); });
    }
    if (!result || !result.ok) {
        throw new RangeError(`alignment: the fit failed (${(result && result.error) || 'no fit'})`);
    }
    if (result.quality.n !== indices.length) {
        throw new RangeError('alignment: the fit does not match the enabled control points');
    }
    const R = result.matrix || quatToMat(result.rotation);
    const t = result.translation;
    const fitted = new Map(indices.map((cpIndex, k) => [cpIndex, k]));
    cps.forEach((cp, i) => {
        const k = fitted.get(i);
        if (k !== undefined) {
            cp.residual = result.residuals[k].slice();
            cp.looError = result.looErrors && isNum(result.looErrors[k]) ? result.looErrors[k] : null;
        } else {
            const d = sub3(surveyVec(cp.surveyed), t);
            cp.residual = sub3(d, matVec(R, modelVec(cp.modelPosition)));
            cp.looError = null;
        }
    });
    return {
        fitType: result.fitType,
        rotation: result.rotation.slice(),
        translation: result.translation.slice(),
        quality: copyQuality(result.quality),
        controlPoints: cps
    };
}

// ============ Creating, refining, editing ============

/**
 * Creates an alignment from accepted control points and their fit.
 * @param {object} options
 * @param {*} [options.id] - internal id, or pass generateId (e.g. helpers.generateInternalId)
 * @param {string} [options.uuid] - persistent id, or pass generateUuid (helpers.generateUUID)
 * @param {string} [options.name]
 * @param {string} [options.crsLabel] - free text, '' allowed (see crsDisplayLabel)
 * @param {string} [options.heightColumn] - header name of the height column
 * @param {string|null} [options.modelSha256] - state.modelHash (null while unknown)
 * @param {string|null} [options.modelUpAxis] - state.modelUpAxis ('y-up' | 'z-up')
 * @param {object} [options.fit] - solveFit result of the ENABLED control points in
 *   list order (see fitControlPoints); computed with fitType when omitted
 * @param {'rigid6'|'level4'} [options.fitType] - only used without fit
 * @param {object[]} options.controlPoints - all control points incl. disabled ones
 * @param {number} [options.residualWarn] - only used without fit
 * @param {string} [options.creator] - Settings identity of the person
 * @param {string|null} [options.creatorOrcid] - bare iD or URL; stored as https://orcid.org/ URI
 * @param {Date|string|number} [options.now] - creation time (default: now)
 * @returns {object} the alignment (throws RangeError when the fit failed)
 */
export function createAlignment({
    id, generateId, uuid, generateUuid,
    name = '', crsLabel = '', heightColumn = '',
    modelSha256 = null, modelUpAxis = null,
    fit = null, fitType = 'rigid6', controlPoints = [], residualWarn = RESIDUAL_WARN_DEFAULT,
    creator = '', creatorOrcid = null, now
} = {}) {
    const time = isoTime(now);
    return {
        id: newId(id, generateId),
        uuid: newUuid(uuid, generateUuid),
        name: text(name).trim(),
        crsLabel: text(crsLabel).trim(),
        heightColumn: text(heightColumn),
        modelSha256: textOrNull(modelSha256),
        modelUpAxis: textOrNull(modelUpAxis),
        ...fitFields(fit, controlPoints, fitType, residualWarn),
        created: time,
        modified: time,
        creator: text(creator),
        creatorOrcid: orcidUri(creatorOrcid),
        versions: []
    };
}

// The current fit of an alignment as a version entry, replaced at supersededAt.
// The model binding is not copied (see the file header).
function fitSnapshot(alignment, supersededAt) {
    const versions = alignment.versions || [];
    const previous = versions.length ? versions[versions.length - 1] : null;
    return {
        fitType: alignment.fitType,
        rotation: alignment.rotation.slice(),
        translation: alignment.translation.slice(),
        quality: copyQuality(alignment.quality),
        controlPoints: (alignment.controlPoints || []).map(copyControlPoint),
        created: (previous && previous.modified) || alignment.created || null,
        modified: supersededAt
    };
}

function refit(alignment, {
    fit = null, fitType, controlPoints = [], residualWarn = RESIDUAL_WARN_DEFAULT,
    modelSha256 = null, modelUpAxis = null, now
} = {}) {
    const time = isoTime(now);
    return {
        ...alignment,
        ...fitFields(fit, controlPoints, fitType || alignment.fitType, residualWarn),
        // New picks are made on the current model; an unknown hash keeps the old binding.
        modelSha256: textOrNull(modelSha256) || alignment.modelSha256 || null,
        modelUpAxis: textOrNull(modelUpAxis) || alignment.modelUpAxis || null,
        modified: time,
        versions: [...(alignment.versions || []), fitSnapshot(alignment, time)]
    };
}

/**
 * Refine (Alignment Manager): a new fit from added, re-picked or disabled
 * control points. The previous fit goes into versions. The input is not
 * changed; id, uuid, name, label, created and creator are kept.
 * @param {object} alignment
 * @param {{fit?, fitType?, controlPoints, residualWarn?, modelSha256?, modelUpAxis?, now?}} options
 *   as in createAlignment; fitType defaults to the alignment's (the level
 *   option can change through Refine). modelSha256/modelUpAxis = the current
 *   model; a null hash keeps the stored one.
 * @returns {object} the refined alignment. planRefinePlacement(annotations,
 *   alignment, result) gives the points to move.
 */
export function refineAlignment(alignment, options) {
    return refit(alignment, options);
}

// Re-align from scratch: the same data change as a refine (the picking
// starts empty instead); the previous fit is kept in versions.
export function realignAlignment(alignment, options) {
    return refit(alignment, options);
}

/**
 * Rename or edit the label (metadata only). modified is bumped when
 * something changed, so a merge picks the newer copy.
 * @param {object} alignment
 * @param {{name?: string, crsLabel?: string, now?: Date|string|number}} changes
 * @returns {object} a new alignment, or the same object when nothing changed
 */
export function editAlignmentMetadata(alignment, { name, crsLabel, now } = {}) {
    const next = { ...alignment };
    let changed = false;
    if (typeof name === 'string' && name.trim() !== alignment.name) { next.name = name.trim(); changed = true; }
    if (typeof crsLabel === 'string' && crsLabel.trim() !== alignment.crsLabel) { next.crsLabel = crsLabel.trim(); changed = true; }
    if (!changed) return alignment;
    next.modified = isoTime(now);
    return next;
}

// ============ Life cycle ============

// Survey points that belong to an alignment.
export function surveyPointsOf(annotations, alignmentId) {
    return (annotations || []).filter(a => a && a.survey && a.survey.alignmentId === alignmentId);
}

// Map alignmentId -> number of survey points (for the manager's list).
export function countSurveyPoints(annotations) {
    const counts = new Map();
    for (const a of annotations || []) {
        const id = a && a.survey ? a.survey.alignmentId : null;
        if (id !== null && id !== undefined) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
}

// Copy of a survey block detached from its alignment (Delete > Detach): the
// surveyed coordinate, raw values, attributes and source stay.
export function detachSurvey(survey) {
    return {
        ...survey,
        alignmentId: null,
        raw: survey.raw ? { ...survey.raw } : survey.raw,
        columns: survey.columns ? { ...survey.columns } : survey.columns,
        attributes: survey.attributes ? { ...survey.attributes } : survey.attributes,
        source: survey.source ? { ...survey.source } : survey.source
    };
}

// The alignment list without one alignment; the default is cleared when it was that one.
export function removeAlignment(alignments, alignmentId, defaultAlignmentId = null) {
    return {
        alignments: (alignments || []).filter(a => a.id !== alignmentId),
        defaultAlignmentId: defaultAlignmentId === alignmentId ? null : defaultAlignmentId
    };
}

/**
 * Points to move after a refine or re-align: survey points of the alignment
 * with placement 'fit'. Points moved by hand ('manual') never move. Positions
 * are fitted positions (before snapping) in storage coordinates; the caller
 * snaps `to` to the surface.
 * @param {object[]} annotations
 * @param {object} oldAlignment - before the refine
 * @param {object} newAlignment - after the refine (same id)
 * @returns {{moves: Array<{annotation, from: {x,y,z}, to: {x,y,z}, displacement: number}>,
 *            manual: object[], count: number, manualCount: number,
 *            maxDisplacement: number, medianDisplacement: number}}
 *   displacement in metres between the old and the new fitted position.
 */
export function planRefinePlacement(annotations, oldAlignment, newAlignment) {
    const before = makeTransform(oldAlignment);
    const after = makeTransform(newAlignment);
    const moves = [];
    const manual = [];
    for (const ann of annotations || []) {
        const s = ann && ann.survey;
        if (!s || s.alignmentId !== oldAlignment.id) continue;
        if (s.placement === PLACEMENT.MANUAL) { manual.push(ann); continue; }
        if (![s.e, s.n, s.h].every(isNum)) continue;
        const a = before.toExport(s);
        const b = after.toExport(s);
        moves.push({
            annotation: ann,
            from: pointFromZUp(a),
            to: pointFromZUp(b),
            displacement: norm3([b.x - a.x, b.y - a.y, b.z - a.z])
        });
    }
    const d = moves.map(m => m.displacement);
    return {
        moves,
        manual,
        count: moves.length,
        manualCount: manual.length,
        maxDisplacement: d.reduce((m, v) => Math.max(m, v), 0),
        medianDisplacement: d.length ? median(d) : 0
    };
}

// ============ Selection step ============
// The per-row surface query stays with the caller (it needs the BVH and runs
// in chunks per frame). Order of use:
//   1. positions = fittedPositions(records, alignment)
//   2. distances[i] = surface distance of positions[i] (caller)
//   3. classification = classifyByDistance(records, distances, { limit })
//   4. nothing on the model: measure fittedPositions(records, alignment,
//      { swapEN: true }) as well, classify, and offer Swap when
//      swapWouldFit(classification, swapped).

/**
 * Fitted position of each record.
 * @param {Array<{e,n,h}|number[]>} records - buildRecords() records, survey blocks or arrays
 * @param {object} alignment
 * @param {{frame?: 'export'|'storage', swapEN?: boolean}} [options]
 *   frame: 'export' (Z-up, default) or 'storage' (Y-up, like points[0]);
 *   swapEN: exchange E and N first (the Swap trial).
 * @returns {Array<{x,y,z}>} parallel to records (throws on a non-finite coordinate)
 */
export function fittedPositions(records, alignment, { frame = 'export', swapEN = false } = {}) {
    const tf = makeTransform(alignment);
    return (records || []).map(r => {
        const [e, n, h] = surveyVec(r);
        const p = tf.toExport(swapEN ? [n, e, h] : [e, n, h]);
        return frame === 'storage' ? pointFromZUp(p) : p;
    });
}

function normaliseBox(box) {
    const a = modelVec(box.min), b = modelVec(box.max);
    return {
        min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
        max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]
    };
}

// Distance from a point to an axis-aligned box, 0 inside.
function distanceToBox(p, box) {
    const v = modelVec(p);
    let s = 0;
    for (let i = 0; i < 3; i++) {
        const d = Math.max(box.min[i] - v[i], 0, v[i] - box.max[i]);
        s += d * d;
    }
    return Math.sqrt(s);
}

/**
 * Rows of the selection step, nearest first, ticked when within the limit.
 * @param {object[]} records
 * @param {Array<number|null>} distances - parallel to records: metres from the
 *   fitted position to the surface (may be signed, above/below: the magnitude
 *   decides); Infinity when the query found nothing within its search radius;
 *   null when nothing could be measured (no BVH). An Infinity row is
 *   final only for limits up to the search radius it was measured with:
 *   when the user raises the limit above that radius, measure those rows
 *   again with the wider radius before classifying again.
 * @param {{limit?: number, positions?: Array<{x,y,z}>, box?: {min, max}}} [options]
 *   limit: the selection limit (setting meshnotes_surveySurfaceLimit).
 *   positions and box: for rows without a distance, a row counts as on the
 *   model when its position is within limit of the box. Both must be in the
 *   same frame (e.g. fittedPositions() and the model box converted to the
 *   export frame); the box corners may come in any order.
 * @returns {{rows: Array<{index, record, distance: number|null, boxDistance: number|null,
 *            method: string, onModel: boolean, ticked: boolean}>,
 *            onModelCount: number, total: number, limit: number}}
 *   index is the record's position in the input. "10 of 50" = onModelCount of total.
 */
export function classifyByDistance(records, distances, { limit = SELECTION_LIMIT_DEFAULT, positions = null, box = null } = {}) {
    if (!Array.isArray(records) || !Array.isArray(distances) || distances.length !== records.length) {
        throw new RangeError('alignment: one distance per record is expected');
    }
    if (!(isNum(limit) && limit >= 0)) throw new RangeError('alignment: the limit must be a number >= 0');
    const b = box ? normaliseBox(box) : null;
    const rows = records.map((record, index) => {
        const d = distances[index];
        if (typeof d === 'number' && !Number.isNaN(d)) {
            const onModel = Math.abs(d) <= limit;
            return { index, record, distance: d, boxDistance: null, method: SELECTION_METHODS.SURFACE, onModel, ticked: onModel };
        }
        if (b && positions && positions[index]) {
            const boxDistance = distanceToBox(positions[index], b);
            const onModel = boxDistance <= limit;
            return { index, record, distance: null, boxDistance, method: SELECTION_METHODS.BOX, onModel, ticked: onModel };
        }
        return { index, record, distance: null, boxDistance: null, method: SELECTION_METHODS.NONE, onModel: false, ticked: false };
    });
    const key = (r) => (r.method === SELECTION_METHODS.SURFACE ? Math.abs(r.distance)
        : r.method === SELECTION_METHODS.BOX ? r.boxDistance : Infinity);
    // Infinity - Infinity is NaN, which falls through to the input order.
    rows.sort((a, b) => (key(a) - key(b)) || (a.index - b.index));
    return { rows, onModelCount: rows.filter(r => r.onModel).length, total: rows.length, limit };
}

// True when no row lands on the model but rows do with E and N swapped:
// then the dialog offers Swap.
export function swapWouldFit(classification, swappedClassification) {
    return !!classification && !!swappedClassification &&
        classification.onModelCount === 0 && swappedClassification.onModelCount > 0;
}

// ============ Duplicates ============

function surveyDistance(a, b) {
    return norm3([a.e - b.e, a.n - b.n, a.h - b.h]);
}

/**
 * Duplicate rules for rows about to be imported into an alignment:
 * - same alignment + same file hash + same row: DUPLICATE (SAME_ROW)
 * - same alignment + same name + coordinates within tolerance: DUPLICATE (SAME_NAME_POSITION)
 * - same alignment + same name, coordinates farther apart: NAME_CONFLICT (imported and flagged)
 * - otherwise, the name of any other annotation (a point of another alignment,
 *   a detached point, a hand-made annotation): NAME_CONFLICT (SAME_NAME_OTHER),
 *   imported and flagged, never skipped
 * Candidates are also compared with the earlier candidates of the same batch
 * that will be imported.
 * @param {Array<{name, row, e, n, h}>} candidates - name = the annotation name to be used
 * @param {object[]} annotations - existing annotations (state.annotations)
 * @param {{alignmentId, fileSha256?: string|null, tolerance?: number}} options
 * @returns {Array<{status, reason: string|null, match: {uuid: string|null, index: number|null}|null}>}
 *   parallel to candidates; match.uuid = the existing annotation, match.index =
 *   an earlier candidate.
 */
export function checkDuplicates(candidates, annotations, { alignmentId, fileSha256 = null, tolerance = DUPLICATE_TOLERANCE } = {}) {
    const byRow = new Map();    // row -> match (existing points from the same file)
    const byName = new Map();   // name -> [{ e, n, h, match }]
    const otherNames = new Map();   // name -> match (any other annotation)
    const addName = (name, s, match) => {
        if (!name) return;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ e: s.e, n: s.n, h: s.h, match });
    };
    const hasAlignment = alignmentId !== null && alignmentId !== undefined;
    for (const ann of annotations || []) {
        if (!ann) continue;
        const s = ann.survey;
        const match = { uuid: ann.uuid ?? null, index: null };
        if (!hasAlignment || !s || s.alignmentId !== alignmentId || ![s.e, s.n, s.h].every(isNum)) {
            if (ann.name && !otherNames.has(ann.name)) otherNames.set(ann.name, match);
            continue;
        }
        const src = s.source || {};
        if (fileSha256 && src.fileSha256 === fileSha256 && Number.isInteger(src.row)) byRow.set(src.row, match);
        addName(ann.name, s, match);
    }
    return (candidates || []).map((c, index) => {
        const rowMatch = fileSha256 && Number.isInteger(c.row) ? byRow.get(c.row) : undefined;
        if (rowMatch) return { status: DUPLICATE_STATUS.DUPLICATE, reason: DUPLICATE_REASONS.SAME_ROW, match: rowMatch };
        const same = (c.name && byName.get(c.name)) || [];
        const close = same.find(o => surveyDistance(o, c) <= tolerance);
        if (close) return { status: DUPLICATE_STATUS.DUPLICATE, reason: DUPLICATE_REASONS.SAME_NAME_POSITION, match: close.match };
        const other = c.name ? otherNames.get(c.name) : undefined;
        const result = same.length
            ? { status: DUPLICATE_STATUS.NAME_CONFLICT, reason: DUPLICATE_REASONS.SAME_NAME, match: same[0].match }
            : other
                ? { status: DUPLICATE_STATUS.NAME_CONFLICT, reason: DUPLICATE_REASONS.SAME_NAME_OTHER, match: other }
                : { status: DUPLICATE_STATUS.NEW, reason: null, match: null };
        const self = { uuid: null, index };
        if (fileSha256 && Number.isInteger(c.row)) byRow.set(c.row, self);
        addName(c.name, c, self);
        return result;
    });
}

// ============ Binding and labels ============

/**
 * Model hash check. A null or empty hash on either side (still hashing, or
 * a URL-loaded model) is 'unknown' and must not warn.
 * @returns {'match'|'mismatch'|'unknown'}
 */
export function modelHashStatus(alignment, modelHash) {
    const a = textOrNull(alignment && alignment.modelSha256);
    const m = textOrNull(modelHash);
    if (!a || !m) return 'unknown';
    return a.toLowerCase() === m.toLowerCase() ? 'match' : 'mismatch';
}

const UP_AXIS_LABELS = { 'y-up': 'Y-up', 'z-up': 'Z-up' };

/**
 * Warnings for the mapping dialog and the manager: the alignment was made on
 * another model file, or with the model loaded under the other up-axis.
 * Warn and allow: the alignment stays usable.
 * @param {object} alignment
 * @param {{modelHash?: string|null, modelUpAxis?: string|null}} current - state.modelHash, state.modelUpAxis
 * @returns {Array<{code, message}>}
 */
export function bindingWarnings(alignment, { modelHash = null, modelUpAxis = null } = {}) {
    const warnings = [];
    if (modelHashStatus(alignment, modelHash) === 'mismatch') {
        warnings.push({
            code: BINDING_WARNINGS.MODEL_HASH,
            message: 'This alignment was made on a different model file. It can still be used; check that the points sit where expected.'
        });
    }
    const a = textOrNull(alignment && alignment.modelUpAxis);
    const m = textOrNull(modelUpAxis);
    if (a && m && a.toLowerCase() !== m.toLowerCase()) {
        const label = (v) => UP_AXIS_LABELS[v.toLowerCase()] || v;
        warnings.push({
            code: BINDING_WARNINGS.UP_AXIS,
            message: `This alignment was made with the model loaded as ${label(a)}; it is now loaded as ${label(m)}. Reload the model with ${label(a)} to use it as made.`,
            alignmentUpAxis: a,
            modelUpAxis: m
        });
    }
    return warnings;
}

// The coordinate system label for display: 'unspecified coordinate system' when empty.
export function crsDisplayLabel(alignmentOrLabel) {
    const label = typeof alignmentOrLabel === 'string' ? alignmentOrLabel : alignmentOrLabel && alignmentOrLabel.crsLabel;
    const trimmed = typeof label === 'string' ? label.trim() : '';
    return trimmed || UNSPECIFIED_CRS;
}

// ============ JSON-LD references ============

// 'urn:meshnotes:alignment:<uuid>' for an alignment or a uuid.
export function alignmentRef(alignmentOrUuid) {
    const uuid = typeof alignmentOrUuid === 'string' ? alignmentOrUuid : alignmentOrUuid && alignmentOrUuid.uuid;
    return ALIGNMENT_URN_PREFIX + uuid;
}

// The value after a URN prefix, from a string or a node {id} / {'@id'}; null otherwise.
function parseUrn(value, prefix) {
    const s = typeof value === 'string' ? value
        : isPlainObject(value) ? (value.id || value['@id']) : null;
    if (typeof s !== 'string' || !s.startsWith(prefix)) return null;
    return s.slice(prefix.length) || null;
}

// uuid of an alignment reference, or null.
export function parseAlignmentRef(ref) {
    return parseUrn(ref, ALIGNMENT_URN_PREFIX);
}

function mapGet(map, key) {
    if (!map || key === null || key === undefined) return undefined;
    if (typeof map.get === 'function') return map.get(key);
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Internal id for an alignment reference.
 * @param {string|object} ref - 'urn:meshnotes:alignment:<uuid>'
 * @param {object|Map} idMap - uuid -> id (mergeAlignments().idMap)
 * @returns {*} the id, or null when unknown
 */
export function resolveAlignmentRef(ref, idMap) {
    const id = mapGet(idMap, parseAlignmentRef(ref));
    return id === undefined ? null : id;
}

// ============ JSON-LD writing ============
// Only the plan's new meshnotes: terms plus existing vocabulary (id, type,
// schema:name, schema:sha256, created, modified, creator, dcterms:source).
// Numbers are written as they are; JSON keeps full double precision.
// quality.flags has no term: it is recomputed on reading.

// Sets obj[key] unless the value is empty or not representable in JSON.
function put(obj, key, value) {
    if (value === null || value === undefined || value === '') return;
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    obj[key] = value;
}

function qualityToJsonLd(q) {
    const out = {};
    if (!q) return out;
    put(out, 'meshnotes:controlPointCount', q.n);
    put(out, 'meshnotes:rms', q.rms);
    put(out, 'meshnotes:rmsHorizontal', q.rmsH);
    put(out, 'meshnotes:rmsVertical', q.rmsV);
    put(out, 'meshnotes:maxResidual', q.maxResidual);
    put(out, 'meshnotes:scaleDiagnostic', q.scale);
    put(out, 'meshnotes:tiltDeg', q.tiltDeg);
    put(out, 'meshnotes:headingDeg', q.headingDeg);
    return out;
}

function controlPointToJsonLd(cp) {
    const out = {};
    put(out, 'schema:name', cp.label);
    put(out, 'meshnotes:row', intOrNull(cp.csvRow));
    out['meshnotes:enabled'] = cp.enabled !== false;
    // wktNum keeps 6 decimals: 1 micrometre at the model's small export coordinates.
    out['meshnotes:modelPosition'] = wktPointZ(cp.modelPosition);
    put(out, 'meshnotes:easting', cp.surveyed.e);
    put(out, 'meshnotes:northing', cp.surveyed.n);
    put(out, 'meshnotes:height', cp.surveyed.h);
    if (numberList(cp.residual, 3)) out['meshnotes:residual'] = cp.residual.slice();
    put(out, 'meshnotes:looError', cp.looError);
    if (cp.annotationUuid) out['dcterms:source'] = { id: ANNOTATION_URN_PREFIX + cp.annotationUuid };
    return out;
}

function fitToJsonLd(out, f) {
    out['meshnotes:fitType'] = f.fitType;
    out['meshnotes:rotation'] = f.rotation.slice();
    out['meshnotes:translation'] = f.translation.slice();
    out['meshnotes:quality'] = qualityToJsonLd(f.quality);
    out['meshnotes:controlPoints'] = (f.controlPoints || []).map(controlPointToJsonLd);
}

function versionToJsonLd(v) {
    const out = {};
    fitToJsonLd(out, v);
    put(out, 'created', v.created);
    put(out, 'modified', v.modified);
    return out;
}

function creatorToJsonLd(name, orcid) {
    if (!name) return undefined;
    const creator = { type: 'Person', name };
    const uri = orcidUri(orcid);
    if (uri) creator.id = uri;
    return creator;
}

/**
 * One alignment as a 'meshnotes:SurveyAlignment' node (the plan's JSON example,
 * plus meshnotes:headingDeg, meshnotes:row, meshnotes:looError, dcterms:source
 * of a control point and meshnotes:alignmentVersions). Empty optional members
 * are left out.
 * @param {object} alignment
 * @returns {object}
 */
export function alignmentToJsonLd(alignment) {
    const out = { id: alignmentRef(alignment), type: 'meshnotes:SurveyAlignment' };
    put(out, 'schema:name', alignment.name);
    put(out, 'meshnotes:crsLabel', alignment.crsLabel);
    put(out, 'meshnotes:heightColumn', alignment.heightColumn);
    put(out, 'meshnotes:modelSha256', alignment.modelSha256);
    put(out, 'meshnotes:modelUpAxis', alignment.modelUpAxis);
    fitToJsonLd(out, alignment);
    put(out, 'created', alignment.created);
    put(out, 'modified', alignment.modified);
    const creator = creatorToJsonLd(alignment.creator, alignment.creatorOrcid);
    if (creator) out.creator = creator;
    if (alignment.versions && alignment.versions.length) {
        out['meshnotes:alignmentVersions'] = alignment.versions.map(versionToJsonLd);
    }
    return out;
}

/**
 * The collection-level members, to be placed after 'meshnotes:groups'.
 * @param {object[]} alignments - state.alignments
 * @param {*} [defaultAlignmentId] - state.defaultAlignmentId
 * @returns {object} { 'meshnotes:alignments'?, 'meshnotes:defaultAlignment'? };
 *   empty when there is no alignment, so older-style files stay unchanged
 */
export function alignmentsToJsonLd(alignments, defaultAlignmentId = null) {
    const list = alignments || [];
    const out = {};
    if (list.length) out['meshnotes:alignments'] = list.map(alignmentToJsonLd);
    const def = defaultAlignmentId === null || defaultAlignmentId === undefined
        ? null : list.find(a => a.id === defaultAlignmentId);
    if (def) out['meshnotes:defaultAlignment'] = alignmentRef(def);
    return out;
}

const RAW_FALLBACK_KEYS = { e: 'Easting', n: 'Northing', h: 'Height' };

// rawValues keyed by header name, in E, N, H order.
function rawValuesToJsonLd(raw, columns) {
    const out = {};
    for (const k of ['e', 'n', 'h']) {
        const value = raw ? raw[k] : null;
        if (typeof value !== 'string') continue;
        let key = textOrNull(columns && columns[k]) || RAW_FALLBACK_KEYS[k];
        if (Object.prototype.hasOwnProperty.call(out, key)) key = `${key} (${k.toUpperCase()})`;
        out[key] = value;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * A survey block as a 'meshnotes:SurveyedPosition' node. survey.source.importedAt
 * has no term and is not written: it equals the annotation's import time, and
 * the reader takes it from the annotation's `created`.
 * @param {object} survey - annotation.survey
 * @param {object[]} [alignments] - to turn survey.alignmentId into its URN;
 *   left out when the point is detached or the alignment is unknown
 * @returns {object|undefined}
 */
export function surveyedPositionToJsonLd(survey, alignments = []) {
    if (!survey) return undefined;
    const out = { type: 'meshnotes:SurveyedPosition' };
    const alignment = survey.alignmentId === null || survey.alignmentId === undefined
        ? null : (alignments || []).find(a => a.id === survey.alignmentId);
    if (alignment) out['meshnotes:alignment'] = alignmentRef(alignment);
    put(out, 'meshnotes:easting', survey.e);
    put(out, 'meshnotes:northing', survey.n);
    put(out, 'meshnotes:height', survey.h);
    const raw = rawValuesToJsonLd(survey.raw, survey.columns);
    if (raw) out['meshnotes:rawValues'] = raw;
    if (isPlainObject(survey.attributes) && Object.keys(survey.attributes).length) {
        out['meshnotes:attributes'] = { ...survey.attributes };
    }
    out['meshnotes:placement'] = survey.placement === PLACEMENT.MANUAL ? PLACEMENT.MANUAL : PLACEMENT.FIT;
    put(out, 'meshnotes:surfaceDistance', survey.surfaceDistance);
    const src = survey.source || {};
    const source = {};
    put(source, 'schema:name', src.fileName);
    put(source, 'schema:sha256', src.fileSha256);
    put(source, 'meshnotes:row', intOrNull(src.row));
    if (Object.keys(source).length) out['dcterms:source'] = source;
    return out;
}

/**
 * The annotation-level members: 'meshnotes:locked' (only when true) and
 * 'meshnotes:surveyedPosition' (only for survey points). Place them next to
 * annotationType; the selector is not touched.
 * @param {object} ann
 * @param {object[]} [alignments]
 * @returns {object} possibly empty
 */
export function annotationSurveyToJsonLd(ann, alignments = []) {
    const out = {};
    if (ann && ann.locked === true) out['meshnotes:locked'] = true;
    if (ann && ann.survey) out['meshnotes:surveyedPosition'] = surveyedPositionToJsonLd(ann.survey, alignments);
    return out;
}

// ============ JSON-LD reading ============
// Readers pick the members they know, so unknown properties are ignored.

function controlPointFromJsonLd(cp) {
    if (!isPlainObject(cp)) return null;
    const p = parsePointZ(cp['meshnotes:modelPosition']);
    const e = cp['meshnotes:easting'], n = cp['meshnotes:northing'], h = cp['meshnotes:height'];
    if (!p || ![p.x, p.y, p.z].every(isNum) || ![e, n, h].every(isNum)) return null;
    return {
        label: text(cp['schema:name']),
        csvRow: intOrNull(cp['meshnotes:row']),
        enabled: cp['meshnotes:enabled'] !== false,
        modelPosition: p,
        surveyed: { e, n, h },
        residual: numberList(cp['meshnotes:residual'], 3),
        looError: isNum(cp['meshnotes:looError']) ? cp['meshnotes:looError'] : null,
        annotationUuid: parseUrn(cp['dcterms:source'], ANNOTATION_URN_PREFIX)
    };
}

// The fit part of an alignment or version node, or null when the rotation or
// translation is unusable. The stored quality numbers are kept; missing ones
// and the flags come from a fresh solveFit of the enabled control points.
function fitFromJsonLd(obj, residualWarn) {
    const rotation = numberList(obj['meshnotes:rotation'], 4);
    const translation = numberList(obj['meshnotes:translation'], 3);
    if (!rotation || !translation) return null;
    const fitType = FIT_TYPES.includes(obj['meshnotes:fitType']) ? obj['meshnotes:fitType'] : 'rigid6';
    const controlPoints = asList(obj['meshnotes:controlPoints']).map(controlPointFromJsonLd).filter(Boolean);

    let fresh = null;
    try {
        const { fit } = fitControlPoints(controlPoints, fitType, { residualWarn });
        if (fit.ok) fresh = fit.quality;
    } catch (e) {
        fresh = null;
    }
    const q = isPlainObject(obj['meshnotes:quality']) ? obj['meshnotes:quality'] : {};
    const R = quatToMat(rotation);
    const pick = (key, freshKey, fallback = null) => {
        if (isNum(q[key])) return q[key];
        if (fresh && isNum(fresh[freshKey])) return fresh[freshKey];
        return fallback;
    };
    const quality = {
        n: Number.isInteger(q['meshnotes:controlPointCount'])
            ? q['meshnotes:controlPointCount'] : controlPoints.filter(cp => cp.enabled).length,
        rms: pick('meshnotes:rms', 'rms'),
        rmsH: pick('meshnotes:rmsHorizontal', 'rmsH'),
        rmsV: pick('meshnotes:rmsVertical', 'rmsV'),
        maxResidual: pick('meshnotes:maxResidual', 'maxResidual'),
        scale: pick('meshnotes:scaleDiagnostic', 'scale'),
        tiltDeg: pick('meshnotes:tiltDeg', 'tiltDeg', tiltFromMatrix(R)),
        headingDeg: pick('meshnotes:headingDeg', 'headingDeg', headingFromMatrix(R)),
        flags: fresh ? fresh.flags.slice() : []
    };
    return { fitType, rotation, translation, quality, controlPoints };
}

function versionFromJsonLd(v, residualWarn) {
    if (!isPlainObject(v)) return null;
    const fit = fitFromJsonLd(v, residualWarn);
    if (!fit) return null;
    return { ...fit, created: textOrNull(v.created), modified: textOrNull(v.modified) };
}

function creatorFromJsonLd(creator) {
    if (!isPlainObject(creator)) return { name: '', orcid: null };
    const rawId = creator.id || creator['schema:identifier'] || '';
    const orcid = typeof rawId === 'string' && rawId.includes('orcid.org') ? orcidUri(rawId) : null;
    return { name: text(creator.name), orcid };
}

/**
 * One alignment from a 'meshnotes:SurveyAlignment' node.
 * @param {object} obj
 * @param {{generateId: function, generateUuid?: function, residualWarn?: number}} options
 *   generateId gives the new internal id (helpers.generateInternalId);
 *   generateUuid is used only when the node has no alignment URN;
 *   residualWarn for the recomputed flags (default RESIDUAL_WARN_DEFAULT).
 * @returns {object|null} null when the node is not a usable alignment
 */
export function alignmentFromJsonLd(obj, { generateId, generateUuid, residualWarn = RESIDUAL_WARN_DEFAULT } = {}) {
    if (!isPlainObject(obj)) return null;
    const fit = fitFromJsonLd(obj, residualWarn);
    if (!fit) return null;
    const { name: creator, orcid } = creatorFromJsonLd(obj.creator);
    return {
        id: newId(undefined, generateId),
        uuid: parseAlignmentRef(obj.id) || newUuid(undefined, generateUuid),
        name: text(obj['schema:name']),
        crsLabel: text(obj['meshnotes:crsLabel']),
        heightColumn: text(obj['meshnotes:heightColumn']),
        modelSha256: textOrNull(obj['meshnotes:modelSha256']),
        modelUpAxis: textOrNull(obj['meshnotes:modelUpAxis']),
        ...fit,
        created: textOrNull(obj.created),
        modified: textOrNull(obj.modified),
        creator,
        creatorOrcid: orcid,
        versions: asList(obj['meshnotes:alignmentVersions'])
            .map(v => versionFromJsonLd(v, residualWarn)).filter(Boolean)
    };
}

/**
 * The alignments of a collection. A file without 'meshnotes:alignments'
 * (v1.5 and older) gives none.
 * @param {object} collection - the parsed AnnotationCollection
 * @param {object} options - as in alignmentFromJsonLd
 * @returns {{alignments: object[], idMap: object, defaultAlignmentUuid: string|null,
 *            skipped: Array<{index: number}>}}
 *   idMap: uuid -> new internal id (null-prototype object). After merging, use
 *   mergeAlignments().idMap instead, which points matched uuids at local ids.
 */
export function alignmentsFromJsonLd(collection, options = {}) {
    const items = asList(collection && collection['meshnotes:alignments']);
    const alignments = [];
    const skipped = [];
    const idMap = Object.create(null);
    items.forEach((item, index) => {
        const a = alignmentFromJsonLd(item, options);
        if (!a) { skipped.push({ index }); return; }
        alignments.push(a);
        if (!Object.prototype.hasOwnProperty.call(idMap, a.uuid)) idMap[a.uuid] = a.id;
    });
    return {
        alignments,
        idMap,
        defaultAlignmentUuid: parseAlignmentRef(collection && collection['meshnotes:defaultAlignment']),
        skipped
    };
}

// Candidate numbers of a raw CSV cell, for either decimal convention.
function rawNumberCandidates(s) {
    const t = s.replace(/[\s  ']/g, '');
    if (!t) return [];
    return [
        Number(t),
        Number(t.replace(/,/g, '.')),
        Number(t.replace(/,/g, '')),
        Number(t.replace(/\./g, '').replace(/,/g, '.'))
    ].filter(isNum);
}

function rawMatches(s, target) {
    const tolerance = 1e-9 * Math.max(1, Math.abs(target));
    return rawNumberCandidates(s).some(v => Math.abs(v - target) <= tolerance);
}

// raw and columns from rawValues: each of E, N, H takes the first unused key
// whose cell reads as its number; the rest fall back to key order (JSON
// objects reorder integer-like keys, so the order alone is not reliable).
function rawValuesFromJsonLd(rawValues, target) {
    const raw = { e: null, n: null, h: null };
    const columns = { e: null, n: null, h: null };
    if (!isPlainObject(rawValues)) return { raw, columns };
    const entries = Object.entries(rawValues)
        .filter(([, v]) => typeof v === 'string' || isNum(v))
        .map(([k, v]) => [k, String(v)]);
    const used = new Set();
    const take = (k, i) => { used.add(i); columns[k] = entries[i][0]; raw[k] = entries[i][1]; };
    for (const k of ['e', 'n', 'h']) {
        const i = entries.findIndex(([, v], j) => !used.has(j) && rawMatches(v, target[k]));
        if (i >= 0) take(k, i);
    }
    for (const k of ['e', 'n', 'h']) {
        if (columns[k] !== null) continue;
        const i = entries.findIndex((_, j) => !used.has(j));
        if (i >= 0) take(k, i);
    }
    return { raw, columns };
}

function attributesFromJsonLd(a) {
    const out = {};
    if (!isPlainObject(a)) return out;
    for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'string') out[k] = v;
        else if (isNum(v) || typeof v === 'boolean') out[k] = String(v);
    }
    return out;
}

/**
 * A survey block from a 'meshnotes:SurveyedPosition' node.
 * @param {object} obj
 * @param {{alignmentIdMap?: object|Map, importedAt?: string|null}} [options]
 *   alignmentIdMap: uuid -> id (mergeAlignments().idMap); an unknown or
 *   missing alignment gives alignmentId null (detached).
 *   importedAt: survey.source.importedAt (the annotation's `created`).
 * @returns {object|null} null when easting, northing or height is missing.
 *   raw and columns are always objects; their values are null when the file
 *   has no rawValues.
 */
export function surveyedPositionFromJsonLd(obj, { alignmentIdMap = null, importedAt = null } = {}) {
    if (!isPlainObject(obj)) return null;
    const e = obj['meshnotes:easting'], n = obj['meshnotes:northing'], h = obj['meshnotes:height'];
    if (![e, n, h].every(isNum)) return null;
    const { raw, columns } = rawValuesFromJsonLd(obj['meshnotes:rawValues'], { e, n, h });
    const src = isPlainObject(obj['dcterms:source']) ? obj['dcterms:source'] : {};
    return {
        alignmentId: resolveAlignmentRef(obj['meshnotes:alignment'], alignmentIdMap),
        e, n, h,
        raw,
        columns,
        attributes: attributesFromJsonLd(obj['meshnotes:attributes']),
        source: {
            fileName: text(src['schema:name']),
            fileSha256: textOrNull(src['schema:sha256']),
            row: intOrNull(src['meshnotes:row']),
            importedAt: textOrNull(importedAt)
        },
        placement: obj['meshnotes:placement'] === PLACEMENT.MANUAL ? PLACEMENT.MANUAL : PLACEMENT.FIT,
        surfaceDistance: isNum(obj['meshnotes:surfaceDistance']) ? obj['meshnotes:surfaceDistance'] : null
    };
}

/**
 * The lock and the survey block of a W3C annotation. An absent lock reads as
 * false (the imported-points-start-locked default is not applied here).
 * @param {object} w3cAnn
 * @param {{alignmentIdMap?: object|Map, importedAt?: string}} [options]
 *   importedAt defaults to w3cAnn.created
 * @returns {{locked: boolean, survey: object|null}}
 */
export function annotationSurveyFromJsonLd(w3cAnn, options = {}) {
    if (!isPlainObject(w3cAnn)) return { locked: false, survey: null };
    const importedAt = options.importedAt ?? w3cAnn.created ?? null;
    return {
        locked: w3cAnn['meshnotes:locked'] === true,
        survey: surveyedPositionFromJsonLd(w3cAnn['meshnotes:surveyedPosition'], { ...options, importedAt })
    };
}

// ============ Merge ============

// Two entries are the same fit when fitType, rotation and translation match exactly.
const fitKey = (f) => JSON.stringify([f.fitType, f.rotation, f.translation]);

// Union of the version lists of two copies of one alignment, oldest first.
// Copies refined in separate sessions hold their shared fits with different
// time spans, so entries are matched by fit, not by time; the local entry
// stays. The losing copy's current fit, when it is in neither history and
// differs from the winner's, is added as a version superseded at the
// winner's modified time, so no fit is lost.
function mergeVersions(local, imported, importedWins) {
    const winner = importedWins ? imported : local;
    const loser = importedWins ? local : imported;
    const out = (local.versions || []).slice();
    const keys = new Set(out.map(fitKey));
    let changed = false;
    const add = (v) => {
        const k = fitKey(v);
        if (keys.has(k)) return;
        keys.add(k);
        out.push(v);
        changed = true;
    };
    (imported.versions || []).forEach(add);
    if (fitKey(loser) !== fitKey(winner)) add(fitSnapshot(loser, winner.modified));
    if (changed) {
        out.sort((a, b) => (timeValue(a.modified) - timeValue(b.modified)) || (timeValue(a.created) - timeValue(b.created)));
    }
    return { versions: out, changed };
}

/**
 * Merges imported alignments into the local list by uuid. The newer
 * `modified` wins; a tie keeps the local copy. A replacing copy takes the
 * local id, so local survey points keep their link. Version histories are
 * united either way (see mergeVersions: shared fits once, the losing copy's
 * current fit kept as a version). The inputs are not changed.
 * @param {object[]} local - state.alignments
 * @param {object[]} imported - alignmentsFromJsonLd().alignments
 * @returns {{alignments: object[], idMap: object, replaced: string[], added: string[], kept: string[]}}
 *   idMap: uuid -> id for every alignment of the merged list (null-prototype
 *   object; use it to resolve survey.alignment). replaced: uuids whose
 *   imported copy was newer; added: uuids new to the session; kept: uuids in
 *   both where the local copy stays.
 */
export function mergeAlignments(local, imported) {
    const alignments = (local || []).slice();
    const localUuids = new Set(alignments.map(a => a.uuid));
    const status = new Map();   // uuid -> 'replaced' | 'added' | 'kept', in order of appearance
    for (const imp of imported || []) {
        if (!imp || !imp.uuid) continue;
        const i = alignments.findIndex(a => a.uuid === imp.uuid);
        if (i < 0) {
            alignments.push(imp);
            status.set(imp.uuid, 'added');
            continue;
        }
        const current = alignments[i];
        const importedWins = timeValue(imp.modified) > timeValue(current.modified);
        const { versions, changed } = mergeVersions(current, imp, importedWins);
        if (importedWins) {
            alignments[i] = { ...imp, id: current.id, versions };
            if (localUuids.has(imp.uuid)) status.set(imp.uuid, 'replaced');
        } else {
            if (changed) alignments[i] = { ...current, versions };
            if (!status.has(imp.uuid)) status.set(imp.uuid, 'kept');
        }
    }
    const idMap = Object.create(null);
    for (const a of alignments) {
        if (!Object.prototype.hasOwnProperty.call(idMap, a.uuid)) idMap[a.uuid] = a.id;
    }
    const pickStatus = (s) => [...status].filter(([, v]) => v === s).map(([uuid]) => uuid);
    return { alignments, idMap, replaced: pickStatus('replaced'), added: pickStatus('added'), kept: pickStatus('kept') };
}

/**
 * Hand-moved wins (decided by Nils): a survey point moved by hand on either
 * side is not moved by the alignment rule; the existing entries-timestamp
 * rule decides its position instead. Kept in this one function so the rule
 * can change in one place.
 * @returns {'entries'|null} MERGE_SOURCE.ENTRIES, or null when the alignment rule applies
 */
export function manualPlacementMergeRule(localSurvey, importedSurvey) {
    if (localSurvey.placement === PLACEMENT.MANUAL || importedSurvey.placement === PLACEMENT.MANUAL) {
        return MERGE_SOURCE.ENTRIES;
    }
    return null;
}

/**
 * Which copy of a survey point present in both sessions supplies its position
 * (points[0]) and survey block in a merge: the copy whose alignment won.
 * importedAnn.survey.alignmentId must already be resolved through
 * merge.idMap, so a matched alignment has the local id on both sides.
 * @param {object} localAnn
 * @param {object} importedAnn
 * @param {object} merge - the mergeAlignments() result
 * @returns {'imported'|'local'|'entries'} MERGE_SOURCE: 'imported' when the
 *   imported alignment was newer, 'local' when the local one stays (newer or
 *   equal), 'entries' when no alignment rule applies (not both survey points,
 *   different or unknown alignments, or a hand-moved point; see
 *   manualPlacementMergeRule) and the existing entries rule decides.
 */
export function surveyPointMergeSource(localAnn, importedAnn, merge) {
    const local = localAnn && localAnn.survey;
    const imported = importedAnn && importedAnn.survey;
    if (!local || !imported) return MERGE_SOURCE.ENTRIES;
    const manual = manualPlacementMergeRule(local, imported);
    if (manual) return manual;
    if (local.alignmentId === null || local.alignmentId === undefined || local.alignmentId !== imported.alignmentId) {
        return MERGE_SOURCE.ENTRIES;
    }
    const alignment = ((merge && merge.alignments) || []).find(a => a.id === local.alignmentId);
    if (!alignment) return MERGE_SOURCE.ENTRIES;
    if (merge.replaced.includes(alignment.uuid)) return MERGE_SOURCE.IMPORTED;
    if (merge.kept.includes(alignment.uuid)) return MERGE_SOURCE.LOCAL;
    return MERGE_SOURCE.ENTRIES;
}
