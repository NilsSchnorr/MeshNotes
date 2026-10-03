// js/survey/picking.js - Control-point picking session: rows, picks, undo, live fit, messages and review rows
// Pure: imports only alignment.js, rigid-fit.js, linalg.js and survey-display.js,
// so it loads in Node tests. No Three.js, state or DOM. ui-alignment.js keeps
// the session in state.surveySession and draws what these functions return.
//
// Rows are what can be picked: one per CSV record (rowsFromRecords) or, for a
// refine of a saved alignment, one per stored control point
// (rowsFromControlPoints):
//   { key, label, csvRow, surveyed: { e, n, h } }
// key is stable for the session ('row<csvRow>' for CSV records), so picks
// survive an E/N swap, which only changes the rows' surveyed values.
//
// A pick holds the model side only; the survey side always comes from its row:
//   { key, modelPosition: { x, y, z } (export frame, Z-up), annotationUuid, enabled }
// modelPosition = pointToZUp(toStorageCoords(hit)) for a tap on the model, or
// pointToZUp(ann.points[0]) with annotationUuid = ann.uuid for an existing
// point annotation.
//
// Session (the reducers copy every other field unchanged, so the UI may keep
// its own fields on the same object):
//   { rows, picks, history, selectedKey, fitType, ... }
// history holds earlier pick lists for undo; every change to the picks
// (pick, replace, remove, enable or disable) pushes one entry.

import { makeControlPoint, fittedPositions } from './alignment.js';
import {
    solveBoth, fitVerdict, FLAGS, ERRORS, POOR_FLAGS,
    MIN_CONTROL_POINTS, RECOMMENDED_CONTROL_POINTS, MIN_SPREAD, GOOD_RMS, POOR_RMS,
    SCALE_ERROR, SCALE_WARN, SITE_EXTENT_WARN, RESIDUAL_WARN_DEFAULT
} from './rigid-fit.js';
import { sub3, matVec, norm3, quatToMat } from './linalg.js';
import { formatMetres } from './survey-display.js';

// ============ Constants ============

// Undo steps kept per session (older ones are dropped).
export const PICK_HISTORY_LIMIT = 200;

// Levels of the messages shown in the panel and the review (CSS classes of
// .survey-issue in styles.css).
export const MESSAGE_LEVELS = Object.freeze({ ERROR: 'error', WARNING: 'warning', NOTICE: 'notice' });

// Fit type names for the review figures.
export const FIT_TYPE_LABELS = Object.freeze({
    rigid6: 'Full (rotation and shift)',
    level4: 'Level only (turn about the vertical and shift)'
});

const UNIT_NAMES = { mm: 'millimetres', cm: 'centimetres', in: 'inches', ft: 'feet' };

// ============ Small helpers ============

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const degrees = (v) => (isNum(v) ? `${v.toFixed(2)}°` : '—');

function copyPoint(p) {
    return { x: p.x, y: p.y, z: p.z };
}

function copyPick(p) {
    return { key: p.key, modelPosition: copyPoint(p.modelPosition), annotationUuid: p.annotationUuid || null, enabled: p.enabled !== false };
}

// ============ Rows ============

/**
 * One row per CSV record.
 * @param {object[]} records - buildRecords() records ({row, name, e, n, h, ...})
 * @param {{label?: function(object): string}} [options] - label: the row's name,
 *   e.g. surveyPointName(record, fileName); default: the Name cell or 'Row N'
 * @returns {Array<{key: string, label: string, csvRow: number|null, surveyed: {e,n,h}}>}
 */
export function rowsFromRecords(records, { label = null } = {}) {
    const seen = new Set();
    return (records || []).map((r, i) => {
        // The spreadsheet row is unique per record; the index is only a fallback.
        let key = Number.isInteger(r.row) ? `row${r.row}` : `index${i}`;
        if (seen.has(key)) key = `${key}#${i}`;
        seen.add(key);
        return {
            key,
            label: label ? label(r) : (r.name || `Row ${r.row}`),
            csvRow: Number.isInteger(r.row) ? r.row : null,
            surveyed: { e: r.e, n: r.n, h: r.h }
        };
    });
}

/**
 * One row per stored control point (Refine of a saved alignment, commit 14).
 * @param {object[]} controlPoints - alignment.controlPoints
 * @returns {Array<{key, label, csvRow, surveyed}>} key 'cp<index>'
 */
export function rowsFromControlPoints(controlPoints) {
    return (controlPoints || []).map((cp, i) => ({
        key: `cp${i}`,
        label: cp.label || `Control point ${i + 1}`,
        csvRow: Number.isInteger(cp.csvRow) ? cp.csvRow : null,
        surveyed: { e: cp.surveyed.e, n: cp.surveyed.n, h: cp.surveyed.h }
    }));
}

/**
 * Picks for stored control points, matched to rows: the row with the same
 * CSV row and surveyed coordinates, else the first row with the same
 * coordinates that has no pick yet.
 * @param {object[]} rows
 * @param {object[]} controlPoints - alignment.controlPoints
 * @returns {{picks: object[], unmatched: object[]}} unmatched: control points without a row
 */
export function picksFromControlPoints(rows, controlPoints) {
    const picks = [];
    const unmatched = [];
    const used = new Set();
    const sameSurvey = (row, cp) => row.surveyed.e === cp.surveyed.e && row.surveyed.n === cp.surveyed.n && row.surveyed.h === cp.surveyed.h;
    for (const cp of controlPoints || []) {
        const free = (rows || []).filter(r => !used.has(r.key) && sameSurvey(r, cp));
        const row = free.find(r => r.csvRow !== null && r.csvRow === cp.csvRow) || free[0];
        if (!row) { unmatched.push(cp); continue; }
        used.add(row.key);
        picks.push({ key: row.key, modelPosition: copyPoint(cp.modelPosition), annotationUuid: cp.annotationUuid || null, enabled: cp.enabled !== false });
    }
    return { picks, unmatched };
}

/** Copies of the rows with Easting and Northing exchanged (the Swap button); keys stay. */
export function swapRowsEN(rows) {
    return (rows || []).map(r => ({ ...r, surveyed: { e: r.surveyed.n, n: r.surveyed.e, h: r.surveyed.h } }));
}

/**
 * Rows whose name (or row number) contains the search term, case-insensitive.
 * @param {object[]} rows
 * @param {string} term
 * @returns {object[]} all rows for an empty term
 */
export function filterRows(rows, term) {
    const t = String(term ?? '').trim().toLowerCase();
    if (!t) return (rows || []).slice();
    return (rows || []).filter(r => r.label.toLowerCase().includes(t) || (r.csvRow !== null && String(r.csvRow) === t));
}

// ============ Session ============

/**
 * A new picking session.
 * @param {{rows: object[], picks?: object[], fitType?: 'rigid6'|'level4'}} options - plus any
 *   other fields, which are kept (the UI's job, model, callbacks)
 * @returns {object} { ...options, rows, picks, history: [], selectedKey: null, fitType }
 */
export function createPickingSession({ rows, picks = [], fitType = 'rigid6', ...extra } = {}) {
    const keys = new Set((rows || []).map(r => r.key));
    return {
        ...extra,
        rows: rows || [],
        picks: (picks || []).filter(p => keys.has(p.key)).map(copyPick),
        history: [],
        selectedKey: null,
        fitType: fitType === 'level4' ? 'level4' : 'rigid6'
    };
}

export function rowOf(session, key) {
    return session.rows.find(r => r.key === key) || null;
}

export function pickOf(session, key) {
    return session.picks.find(p => p.key === key) || null;
}

export function canUndoPick(session) {
    return !!session && session.history.length > 0;
}

function withPicks(session, picks) {
    const history = [...session.history, session.picks];
    if (history.length > PICK_HISTORY_LIMIT) history.splice(0, history.length - PICK_HISTORY_LIMIT);
    return { ...session, picks, history };
}

/** Selects a row (null or an unknown key deselects). */
export function selectRow(session, key) {
    const selectedKey = key !== null && key !== undefined && rowOf(session, key) ? key : null;
    return selectedKey === session.selectedKey ? session : { ...session, selectedKey };
}

/**
 * Sets the pick of a row; a second pick of the same row replaces the first
 * and enables it again. Undoable.
 * @param {object} session
 * @param {string} key
 * @param {{modelPosition: {x,y,z}, annotationUuid?: string|null}} pick - export frame
 * @returns {object} the new session (the same session for an unknown row)
 */
export function setPick(session, key, { modelPosition, annotationUuid = null }) {
    if (!rowOf(session, key)) return session;
    if (![modelPosition && modelPosition.x, modelPosition && modelPosition.y, modelPosition && modelPosition.z].every(isNum)) {
        throw new TypeError('picking: a pick needs a finite model position');
    }
    const pick = { key, modelPosition: copyPoint(modelPosition), annotationUuid: annotationUuid || null, enabled: true };
    const i = session.picks.findIndex(p => p.key === key);
    const picks = session.picks.slice();
    if (i >= 0) picks[i] = pick;
    else picks.push(pick);
    return withPicks(session, picks);
}

/** Removes the pick of a row. Undoable. */
export function removePick(session, key) {
    if (!pickOf(session, key)) return session;
    return withPicks(session, session.picks.filter(p => p.key !== key));
}

/** Enables or disables a pick (the review's Use box). Undoable. */
export function setPickEnabled(session, key, enabled) {
    const pick = pickOf(session, key);
    if (!pick || pick.enabled === (enabled !== false)) return session;
    return withPicks(session, session.picks.map(p => (p.key === key ? { ...p, enabled: enabled !== false } : p)));
}

/** Undoes the last change to the picks (the same session when there is none). */
export function undoPick(session) {
    if (!canUndoPick(session)) return session;
    const history = session.history.slice();
    const picks = history.pop();
    return { ...session, picks, history };
}

/** Switches between the full and the level-only fit (not part of the undo history). */
export function setFitType(session, fitType) {
    const next = fitType === 'level4' ? 'level4' : 'rigid6';
    return next === session.fitType ? session : { ...session, fitType: next };
}

/**
 * The control points of the picked rows, in row order (disabled ones included).
 * @param {object} session
 * @returns {{controlPoints: object[], keys: string[]}} keys[i] = row key of controlPoints[i]
 */
export function controlPointsOf(session) {
    const byKey = new Map(session.picks.map(p => [p.key, p]));
    const controlPoints = [];
    const keys = [];
    for (const row of session.rows) {
        const pick = byKey.get(row.key);
        if (!pick) continue;
        controlPoints.push(makeControlPoint({
            label: row.label,
            csvRow: row.csvRow,
            enabled: pick.enabled !== false,
            modelPosition: pick.modelPosition,
            surveyed: row.surveyed,
            annotationUuid: pick.annotationUuid
        }));
        keys.push(row.key);
    }
    return { controlPoints, keys };
}

// ============ Live fit ============

/**
 * Fits the enabled picks with both fit types and collects what the panel and
 * the review show.
 * @param {object} session
 * @param {{residualWarn?: number}} [options] - the residual warning setting (metres)
 * @returns {{controlPoints: object[], keys: string[], enabledCount: number,
 *            both: object|null, fit: object|null, fitType: string, indices: number[],
 *            verdict: 'good'|'check'|'poor'|null, levelSuggested: boolean,
 *            fullTilt: number|null, messages: object[]}}
 *   both = solveBoth() of the enabled control points (null below 3); fit = the
 *   result of the chosen fit type (may be { ok: false }); indices[k] =
 *   position in controlPoints of the k-th fitted pair; fullTilt = tilt of the
 *   full fit (the level fit is never tilted); messages = fitMessages().
 */
export function evaluatePicking(session, { residualWarn = RESIDUAL_WARN_DEFAULT } = {}) {
    const { controlPoints, keys } = controlPointsOf(session);
    const indices = [];
    controlPoints.forEach((cp, i) => { if (cp.enabled) indices.push(i); });
    const evaluation = {
        controlPoints, keys, indices,
        enabledCount: indices.length,
        both: null, fit: null,
        fitType: session.fitType,
        verdict: null,
        levelSuggested: false,
        fullTilt: null,
        residualWarn,
        messages: []
    };
    if (indices.length >= MIN_CONTROL_POINTS) {
        const P = indices.map(i => controlPoints[i].modelPosition);
        const Q = indices.map(i => controlPoints[i].surveyed);
        evaluation.both = solveBoth(P, Q, { residualWarn });
        evaluation.fit = session.fitType === 'level4' ? evaluation.both.level4 : evaluation.both.rigid6;
        evaluation.verdict = fitVerdict(evaluation.fit);
        evaluation.levelSuggested = evaluation.both.levelSuggested;
        evaluation.fullTilt = evaluation.both.rigid6.ok ? evaluation.both.rigid6.quality.tiltDeg : null;
    }
    evaluation.messages = fitMessages(session, evaluation);
    return evaluation;
}

// Label of the k-th fitted pair.
function fittedLabel(session, evaluation, k) {
    const row = rowOf(session, evaluation.keys[evaluation.indices[k]]);
    return row ? row.label : `Point ${k + 1}`;
}

function rowRef(row) {
    return row.csvRow !== null ? `${row.label} (row ${row.csvRow})` : row.label;
}

/**
 * The inline warnings for a live fit, most important first: blocking
 * problems (points in a line or bunched together), mirror and swap, wrong
 * up-axis, scale, a pick that does not fit, residuals, too few points, and the
 * level-fit suggestion.
 * @param {object} session
 * @param {object} evaluation - evaluatePicking() (messages not used)
 * @returns {Array<{level: string, code: string, text: string, action?: {id: string, label: string, key?: string}}>}
 *   action ids: 'swap' (swap E/N of the rows and refit), 'select' (select row key for a re-pick)
 */
export function fitMessages(session, evaluation) {
    const out = [];
    const add = (level, code, text, action) => out.push(action ? { level, code, text, action } : { level, code, text });
    const n = evaluation.enabledCount;
    if (n < MIN_CONTROL_POINTS) {
        const missing = MIN_CONTROL_POINTS - n;
        add(MESSAGE_LEVELS.NOTICE, ERRORS.TOO_FEW,
            `Pick ${plural(missing, 'more row')} to see the fit (at least ${MIN_CONTROL_POINTS}, ${RECOMMENDED_CONTROL_POINTS} or more recommended, spread over the site).`);
        return out;
    }
    const fit = evaluation.fit;
    if (!fit.ok) {
        if (fit.error === ERRORS.COLLINEAR) {
            add(MESSAGE_LEVELS.ERROR, fit.error, 'The picked rows lie in a line, so the model could turn about that line. Pick a row away from it.');
        } else if (fit.error === ERRORS.COINCIDENT && fit.side === 'model') {
            add(MESSAGE_LEVELS.ERROR, fit.error, 'The picks on the model lie on top of each other. Pick each row at its own place.');
        } else if (fit.error === ERRORS.COINCIDENT) {
            const spread = fit.conditioning ? ` (spread ${formatMetres(fit.conditioning.spread)})` : '';
            add(MESSAGE_LEVELS.ERROR, fit.error,
                `The picked rows lie too close together${spread}; at least ${MIN_SPREAD} m is needed. Pick rows farther apart.`);
        } else {
            add(MESSAGE_LEVELS.ERROR, fit.error || 'FAILED', 'No fit could be made from these picks.');
        }
        return out;
    }

    const q = fit.quality;
    const flags = q.flags;
    const has = (f) => flags.includes(f);
    // A swap or mirror image also explains the tilt, the bad picks and the
    // residuals of the wrong-handed fit: those messages would point at fine picks.
    const explained = has(FLAGS.SWAPPED_EN) || has(FLAGS.MIRRORED);
    // The level fit is never tilted, so with it a wrong up-axis shows in the
    // full fit only.
    const full = evaluation.fitType === 'level4' && evaluation.both ? evaluation.both.rigid6 : null;
    const fullFlags = full && full.ok ? full.quality.flags : [];
    if (has(FLAGS.SWAPPED_EN)) {
        const trial = fit.swapTrial && fit.swapTrial.ok ? ` With them swapped, the picks fit with RMS ${formatMetres(fit.swapTrial.quality.rms)}.` : '';
        add(MESSAGE_LEVELS.ERROR, FLAGS.SWAPPED_EN, `Easting and Northing appear to be swapped.${trial}`,
            { id: 'swap', label: 'Swap Easting and Northing' });
    } else if (has(FLAGS.MIRRORED)) {
        add(MESSAGE_LEVELS.ERROR, FLAGS.MIRRORED,
            'The picks form a mirror image of the survey points. Check the picks and the column mapping.');
    }
    if (has(FLAGS.FLIPPED) && !explained) {
        add(MESSAGE_LEVELS.ERROR, FLAGS.FLIPPED,
            `The fit turns the model upside down (tilt ${degrees(q.tiltDeg)}). Two rows may be picked at each other's places, or Easting and Northing may be swapped.`);
    } else if (has(FLAGS.UP_AXIS) && !explained) {
        add(MESSAGE_LEVELS.ERROR, FLAGS.UP_AXIS,
            `The fit tilts the model by ${degrees(q.tiltDeg)}. Was the wrong up-axis chosen when the model was loaded? Reload it with the other up-axis.`);
    } else if ((fullFlags.includes(FLAGS.FLIPPED) || fullFlags.includes(FLAGS.UP_AXIS)) && !explained) {
        const flipped = fullFlags.includes(FLAGS.FLIPPED);
        add(MESSAGE_LEVELS.ERROR, flipped ? FLAGS.FLIPPED : FLAGS.UP_AXIS,
            `The full fit would ${flipped ? 'turn the model upside down' : 'tilt the model'} (tilt ${degrees(full.quality.tiltDeg)}). Was the wrong up-axis chosen when the model was loaded? Reload it with the other up-axis.`);
    } else if (has(FLAGS.TILT_WARN)) {
        add(MESSAGE_LEVELS.WARNING, FLAGS.TILT_WARN,
            `The fit tilts the model by ${degrees(q.tiltDeg)}. If the model should be level, check the picks.`);
    }
    if (has(FLAGS.SCALE_ERROR) || has(FLAGS.SCALE_WARN)) {
        const limit = has(FLAGS.SCALE_ERROR) ? SCALE_ERROR : SCALE_WARN;
        let text = `The estimated scale is ${q.scale.toFixed(4)}, more than ${Math.round(limit * 100)} % from 1.`;
        if (fit.unitHint) {
            const unit = UNIT_NAMES[fit.unitHint.unit] || fit.unitHint.unit;
            text += fit.unitHint.side === 'model' ? ` The model seems to be in ${unit}.` : ` The survey seems to be in ${unit}.`;
        }
        add(has(FLAGS.SCALE_ERROR) ? MESSAGE_LEVELS.ERROR : MESSAGE_LEVELS.WARNING, has(FLAGS.SCALE_ERROR) ? FLAGS.SCALE_ERROR : FLAGS.SCALE_WARN, text);
    }
    for (const k of explained ? [] : fit.looOutliers || []) {
        const row = rowOf(session, evaluation.keys[evaluation.indices[k]]);
        const label = row ? rowRef(row) : fittedLabel(session, evaluation, k);
        const err = fit.looErrors ? ` (leave-one-out error ${formatMetres(fit.looErrors[k])})` : '';
        add(MESSAGE_LEVELS.WARNING, FLAGS.LOO_OUTLIER, `${label} does not fit the others${err}. Re-pick or disable it.`,
            row ? { id: 'select', label: 'Re-pick', key: row.key } : undefined);
    }
    if (has(FLAGS.RESIDUAL_WARN) && !explained) {
        let worst = 0;
        fit.residualNorms.forEach((v, k) => { if (v > fit.residualNorms[worst]) worst = k; });
        add(MESSAGE_LEVELS.WARNING, FLAGS.RESIDUAL_WARN,
            `The largest residual, ${formatMetres(q.maxResidual)} at ${fittedLabel(session, evaluation, worst)}, is above the warning threshold of ${formatMetres(evaluation.residualWarn)}.`);
    }
    if (has(FLAGS.WEAK_GEOMETRY)) {
        add(MESSAGE_LEVELS.WARNING, FLAGS.WEAK_GEOMETRY, 'The picked rows lie nearly in a line. Add a row away from that line.');
    }
    if (has(FLAGS.NO_REDUNDANCY)) {
        add(MESSAGE_LEVELS.WARNING, FLAGS.NO_REDUNDANCY,
            `With only ${MIN_CONTROL_POINTS} points a bad pick cannot be found. Pick a fourth row.`);
    }
    if (has(FLAGS.SITE_EXTENT)) {
        add(MESSAGE_LEVELS.WARNING, FLAGS.SITE_EXTENT,
            `The control points span more than ${SITE_EXTENT_WARN / 1000} km. The fit is meant for site scale only.`);
    }
    if (evaluation.fitType === 'rigid6' && evaluation.levelSuggested) {
        add(MESSAGE_LEVELS.NOTICE, FLAGS.LEVEL_SUGGESTED,
            `The full fit tilts the model by only ${degrees(evaluation.fullTilt)}. If the model is already level, tick "Model is already level".`);
    }
    return out;
}

/**
 * Whether a message blocks Review: the fit failed, or fewer than 3 points.
 * @param {object} evaluation
 */
export function canReview(evaluation) {
    return !!evaluation && !!evaluation.fit && evaluation.fit.ok === true;
}

/**
 * The verdict in words, e.g. 'Good: RMS 0.021 m from 5 points, no warnings.'
 * @param {object} evaluation
 * @returns {string} '' without a fit
 */
export function verdictText(evaluation) {
    const fit = evaluation && evaluation.fit;
    if (!fit) return '';
    if (!fit.ok) return 'Poor: no fit could be made from these picks.';
    const q = fit.quality;
    const rms = formatMetres(q.rms);
    const warnings = evaluation.messages.filter(m => m.level !== MESSAGE_LEVELS.NOTICE).length;
    if (evaluation.verdict === 'good') return `Good: RMS ${rms} from ${q.n} points, no warnings.`;
    if (evaluation.verdict === 'poor') {
        const reasons = [];
        if (!(q.rms <= POOR_RMS)) reasons.push(`RMS ${rms} is above ${formatMetres(POOR_RMS)}`);
        if (q.flags.some(f => POOR_FLAGS.includes(f))) reasons.push('the fit is mirrored, swapped, tilted or scaled (see the checks)');
        return `Poor: ${reasons.join('; ')}.`;
    }
    const reasons = [];
    if (q.rms > GOOD_RMS) reasons.push(`RMS ${rms} is above ${formatMetres(GOOD_RMS)}`);
    if (q.n < RECOMMENDED_CONTROL_POINTS) reasons.push(`only ${q.n} points`);
    if (warnings) reasons.push(plural(warnings, 'warning'));
    return `Check: ${reasons.join(', ') || 'see the checks'}.`;
}

// ============ Preview and review ============

/**
 * Fitted position of every row with a fit, in storage coordinates (Y-up, not
 * flipped): the faint preview markers.
 * @param {object[]} rows
 * @param {object|null} fit - a solveFit() result
 * @returns {Array<{x,y,z}>|null} parallel to rows; null without a usable fit
 */
export function previewPositions(rows, fit) {
    if (!fit || !fit.ok) return null;
    return fittedPositions((rows || []).map(r => r.surveyed), { rotation: fit.rotation, translation: fit.translation }, { frame: 'storage' });
}

/**
 * One review-table row per control point (disabled ones included), in row order.
 * @param {object} session
 * @param {object} evaluation - evaluatePicking()
 * @returns {Array<{key, label, csvRow, enabled, fromAnnotation: boolean,
 *                  residual: number[]|null, total: number|null, looError: number|null, outlier: boolean}>}
 *   residual = surveyed minus fitted position [dE, dN, dH] in metres; a
 *   disabled point gets its prediction error against the fit (as
 *   createAlignment stores it) and no leave-one-out error.
 */
export function reviewRows(session, evaluation) {
    const fit = evaluation.fit && evaluation.fit.ok ? evaluation.fit : null;
    const fitted = new Map(evaluation.indices.map((cpIndex, k) => [cpIndex, k]));
    const R = fit ? (fit.matrix || quatToMat(fit.rotation)) : null;
    return evaluation.controlPoints.map((cp, i) => {
        const row = rowOf(session, evaluation.keys[i]);
        const k = fitted.get(i);
        let residual = null, looError = null, outlier = false;
        if (fit && k !== undefined) {
            residual = fit.residuals[k].slice();
            looError = fit.looErrors && isNum(fit.looErrors[k]) ? fit.looErrors[k] : null;
            outlier = (fit.looOutliers || []).includes(k);
        } else if (fit) {
            const s = [cp.surveyed.e, cp.surveyed.n, cp.surveyed.h];
            const p = [cp.modelPosition.x, cp.modelPosition.y, cp.modelPosition.z];
            residual = sub3(sub3(s, fit.translation), matVec(R, p));
        }
        return {
            key: evaluation.keys[i],
            label: row ? row.label : cp.label,
            csvRow: cp.csvRow,
            enabled: cp.enabled,
            fromAnnotation: !!cp.annotationUuid,
            residual,
            total: residual ? norm3(residual) : null,
            looError,
            outlier
        };
    });
}
