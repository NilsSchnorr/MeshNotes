// js/survey/manager.js - Alignment Manager logic: status chip text, list rows, refine rows, delete and refine effects, PDF alignment summary
// Pure: imports only alignment.js, picking.js, rigid-fit.js and survey-display.js,
// so it loads in Node tests. No Three.js, state or DOM. ui-manager.js draws the
// chip, the manager and its dialogs from what these functions return, with
// textContent, because alignment names and labels are user text. pdf-report.js
// prints the alignment summary from alignmentSummaryView().
//
// Plan: Workflow in detail > Alignment Manager; Defaults > Alignments per
// model, Refining an alignment; Changes to existing behaviour > Model binding.
// - Refine and Re-align from scratch offer as candidate rows the alignment's
//   own control points (frozen copies, so a deleted annotation never matters)
//   plus the surveyed coordinates of the survey points attached to it, so a
//   further imported point can become a control point.
// - After a refine, points placed by the fit ('fit') may follow the new fit
//   after a preview of how far they move; points moved by hand ('manual')
//   never move. Keeping the positions leaves the points 'fit' (Nils, decision
//   4), so the next refine offers to move them again: its move is measured
//   from where each point is (refinePlanFromPositions).
// - Deleting an alignment detaches its points (they keep their surveyed
//   coordinates, without an alignment) or lists them for deletion. A removed
//   default passes to the first remaining alignment, so a model with
//   alignments always has a default (as when an alignment is created).

import { surveyPointsOf, detachSurvey, removeAlignment, bindingWarnings, modelHashStatus, crsDisplayLabel, PLACEMENT, BINDING_WARNINGS } from './alignment.js';
import { fitVerdict, FLAGS } from './rigid-fit.js';
import {
    rowsFromControlPoints, picksFromControlPoints, createPickingSession, evaluatePicking, reviewRows, verdictText
} from './picking.js';
import { formatMetres } from './survey-display.js';

// ============ Constants ============

// Display name of an alignment without a name.
export const UNNAMED_ALIGNMENT = 'Unnamed alignment';

// A refit whose fitted positions move by no more than this leaves the points
// alone (no preview): 1 micrometre, below the precision of the export.
export const REFINE_MOVE_EPSILON = 1e-6;    // m

// A 'fit' point whose distance from its fitted position under the current fit
// differs from its surface distance by more than this was left at an earlier
// fit (Keep positions): the next refine measures its move from where it is.
export const KEPT_POSITION_TOLERANCE = 0.0005;    // m

// Hand-moved points named in the refine preview (the rest are counted).
export const PREVIEW_NAME_LIMIT = 10;

// Fit type names in the manager list.
export const FIT_TYPE_SHORT = Object.freeze({ rigid6: 'Full', level4: 'Level only' });

// ============ Small helpers ============

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const distance3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function medianOf(values) {
    const v = values.slice().sort((x, y) => x - y);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** The name to show for an alignment ('Unnamed alignment' when blank). */
export function alignmentDisplayName(alignment) {
    const name = alignment && typeof alignment.name === 'string' ? alignment.name.trim() : '';
    return name || UNNAMED_ALIGNMENT;
}

function annotationLabel(ann) {
    const name = ann && typeof ann.name === 'string' ? ann.name.trim() : '';
    if (name) return name;
    const row = ann && ann.survey && ann.survey.source ? ann.survey.source.row : null;
    return Number.isInteger(row) ? `Row ${row}` : 'Unnamed point';
}

// ============ Status chip ============

/**
 * Text of the status chip beside the face count: no alignment, one alignment
 * with its RMS, or the number of alignments.
 * @param {object[]} alignments - state.alignments
 * @returns {{kind: 'none'|'one'|'many', text: string, title: string}}
 *   title = tooltip and accessible name (holds the alignment name: user text)
 */
export function alignmentChipView(alignments) {
    const list = alignments || [];
    if (list.length === 0) {
        return {
            kind: 'none',
            text: 'No alignment',
            title: 'No survey alignment for this model yet. Click to see how to create one.'
        };
    }
    if (list.length === 1) {
        const a = list[0];
        const q = a.quality || {};
        const rms = isNum(q.rms) ? formatMetres(q.rms) : '—';
        const points = isNum(q.n) ? ` from ${plural(q.n, 'control point')}` : '';
        return {
            kind: 'one',
            text: `1 alignment · RMS ${rms}`,
            title: `Alignment "${alignmentDisplayName(a)}" (${crsDisplayLabel(a)}): RMS ${rms}${points}. Click to open the Alignment Manager.`
        };
    }
    return {
        kind: 'many',
        text: `${list.length} alignments`,
        title: `${list.length} survey alignments for this model. Click to open the Alignment Manager.`
    };
}

// ============ Manager list ============

// A stored quality's RESIDUAL_WARN flag was set with the residual warning of
// the time the fit was made. The list judges it against the current setting
// instead, so a changed setting shows without a refit (a JSON-LD import or
// autosave restore recomputes the stored flags with the setting anyway).
function qualityForResidualWarn(q, residualWarn) {
    if (!isNum(residualWarn) || residualWarn <= 0 || !isNum(q.maxResidual)) return q;
    const flags = (q.flags || []).filter(f => f !== FLAGS.RESIDUAL_WARN);
    if (q.maxResidual > residualWarn) flags.push(FLAGS.RESIDUAL_WARN);
    return { ...q, flags };
}

/**
 * One row per alignment for the manager list.
 * @param {object[]} alignments - state.alignments
 * @param {object[]} annotations - state.annotations
 * @param {{defaultAlignmentId?: *, modelHash?: string|null, modelUpAxis?: string|null, hashPending?: boolean, residualWarn?: number|null}} [current]
 *   modelHash null = unknown (still hashing, or a model loaded from a URL): never a mismatch;
 *   residualWarn = the current residual-warning setting (m): the verdict judges
 *   RESIDUAL_WARN against it, as View control points does (null = the stored flags)
 * @returns {Array<{alignment, id, name, crs, heightColumn, fitType, controlPointCount, enabledCount,
 *                  rms, maxResidual, verdict, pointCount, manualCount, versionCount, isDefault,
 *                  warnings: Array<{code, message}>, checking: boolean}>}
 *   checking = the alignment records a model file and the current one is still being hashed
 */
export function managerRows(alignments, annotations, { defaultAlignmentId = null, modelHash = null, modelUpAxis = null, hashPending = false, residualWarn = null } = {}) {
    const points = new Map();
    const manual = new Map();
    for (const ann of annotations || []) {
        const id = ann && ann.survey ? ann.survey.alignmentId : null;
        if (id === null || id === undefined) continue;
        points.set(id, (points.get(id) || 0) + 1);
        if (ann.survey.placement === PLACEMENT.MANUAL) manual.set(id, (manual.get(id) || 0) + 1);
    }
    return (alignments || []).map(a => {
        const cps = a.controlPoints || [];
        const q = a.quality || {};
        return {
            alignment: a,
            id: a.id,
            name: alignmentDisplayName(a),
            crs: crsDisplayLabel(a),
            heightColumn: typeof a.heightColumn === 'string' ? a.heightColumn : '',
            fitType: FIT_TYPE_SHORT[a.fitType] || String(a.fitType || ''),
            controlPointCount: cps.length,
            enabledCount: cps.filter(cp => cp.enabled !== false).length,
            rms: isNum(q.rms) ? q.rms : null,
            maxResidual: isNum(q.maxResidual) ? q.maxResidual : null,
            verdict: fitVerdict(qualityForResidualWarn(q, residualWarn)),
            pointCount: points.get(a.id) || 0,
            manualCount: manual.get(a.id) || 0,
            versionCount: (a.versions || []).length,
            isDefault: a.id === defaultAlignmentId,
            warnings: bindingWarnings(a, { modelHash, modelUpAxis }),
            checking: !!hashPending && !!a.modelSha256 && modelHashStatus(a, modelHash) === 'unknown'
        };
    });
}

// ============ Review (View control points) ============

/**
 * The review of a saved alignment, read-only: the same verdict, checks and
 * table as the picking review, recomputed from the stored control points.
 * @param {object} alignment
 * @param {{residualWarn?: number}} [options]
 * @returns {{evaluation: object, rows: object[], verdictText: string}}
 *   evaluation = evaluatePicking(); rows = reviewRows() (key 'cp<i>', in
 *   control-point order); messages may carry actions, which a read-only view ignores
 */
export function alignmentReview(alignment, options = {}) {
    const cps = (alignment && alignment.controlPoints) || [];
    const rows = rowsFromControlPoints(cps);
    const session = createPickingSession({
        rows,
        picks: picksFromControlPoints(rows, cps).picks,
        fitType: alignment && alignment.fitType
    });
    const evaluation = evaluatePicking(session, options);
    return { evaluation, rows: reviewRows(session, evaluation), verdictText: verdictText(evaluation) };
}

// The checks of the picking review ask for picking steps; in the read-only
// view those changes are made through Refine.
const READ_ONLY_WORDING = [
    [FLAGS.LOO_OUTLIER, 'Re-pick or disable it.', 'Refine can re-pick or disable it.'],
    [FLAGS.WEAK_GEOMETRY, 'Add a row away from that line.', 'Refine can add a control point away from that line.'],
    [FLAGS.NO_REDUNDANCY, 'Pick a fourth row.', 'Refine can add a fourth control point.'],
    [FLAGS.LEVEL_SUGGESTED, /If the model is already level, tick .*$/, 'If the model is already level, Refine can switch to the level-only fit.']
];

/**
 * The review's checks for the read-only view: text only (no Swap or Re-pick
 * buttons), picking instructions pointing to Refine.
 * @param {object[]} messages - fitMessages() / evaluation.messages
 * @returns {Array<{level: string, code: string, text: string}>}
 */
export function readOnlyMessages(messages) {
    return (messages || []).map(m => {
        let text = m.text;
        for (const [code, from, to] of READ_ONLY_WORDING) {
            if (m.code === code) text = text.replace(from, to);
        }
        return { level: m.level, code: m.code, text };
    });
}

// ============ Refine and re-align ============

/**
 * Candidate rows for Refine and Re-align from scratch: the alignment's
 * control points (keys 'cp<i>', so picksFromControlPoints finds their picks)
 * followed by the survey points attached to the alignment (keys 'pt<uuid>'),
 * leaving out points whose surveyed coordinates equal a control point's (the
 * row a control point was taken from).
 * @param {object} alignment
 * @param {object[]} annotations - state.annotations
 * @returns {Array<{key, label, csvRow, surveyed: {e, n, h}}>} picking.js rows
 */
export function refineRows(alignment, annotations) {
    const rows = rowsFromControlPoints((alignment && alignment.controlPoints) || []);
    const taken = new Set(rows.map(r => JSON.stringify([r.surveyed.e, r.surveyed.n, r.surveyed.h])));
    const keys = new Set(rows.map(r => r.key));
    surveyPointsOf(annotations, alignment && alignment.id).forEach((ann, i) => {
        const s = ann.survey;
        if (![s.e, s.n, s.h].every(isNum)) return;
        const where = JSON.stringify([s.e, s.n, s.h]);
        if (taken.has(where)) return;
        taken.add(where);
        let key = `pt${ann.uuid || ann.id || i}`;
        if (keys.has(key)) key = `${key}#${i}`;
        keys.add(key);
        const row = s.source ? s.source.row : null;
        rows.push({ key, label: annotationLabel(ann), csvRow: Number.isInteger(row) ? row : null, surveyed: { e: s.e, n: s.n, h: s.h } });
    });
    return rows;
}

/**
 * Whether an accepted Refine or Re-align changes nothing: the same fit type,
 * the same control points (enabled flags, picks and surveyed coordinates)
 * and no binding to rewrite. Then no fit is added to the history and
 * `modified` stays, so a merge does not prefer this copy for a no-op.
 * @param {object} alignment - the stored alignment
 * @param {{controlPoints: object[], fitType?: string, modelHash?: string|null, modelUpAxis?: string|null}} result
 *   the accepted picking result plus the current model
 * @returns {boolean}
 */
export function refineUnchanged(alignment, { controlPoints, fitType, modelHash = null, modelUpAxis = null }) {
    if (!alignment) return false;
    if ((fitType || alignment.fitType) !== alignment.fitType) return false;
    if (bindingWarnings(alignment, { modelHash, modelUpAxis }).length) return false;
    const before = alignment.controlPoints || [];
    const after = controlPoints || [];
    if (before.length !== after.length) return false;
    const same = (a, b, keys) => !!a && !!b && keys.every(k => a[k] === b[k]);
    return before.every((cp, i) => {
        const next = after[i];
        return !!next && (cp.enabled !== false) === (next.enabled !== false) &&
            same(cp.modelPosition, next.modelPosition, ['x', 'y', 'z']) &&
            same(cp.surveyed, next.surveyed, ['e', 'n', 'h']);
    });
}

/**
 * A refine plan measured from where the points are. planRefinePlacement
 * measures from the fitted positions under the previous fit. A 'fit' point
 * at that fit lies exactly its surface distance from that position (the
 * nearest surface point, or the position itself when unsnapped); a point
 * left at an earlier fit by Keep positions lies farther or closer by more
 * than KEPT_POSITION_TOLERANCE, so its move is measured from points[0] instead. The next refine then offers it again,
 * also when the fit did not change (Nils, decision 4), and the preview's
 * figures match what Move does.
 * @param {object} plan - planRefinePlacement(annotations, previous, refined)
 * @returns {object} a plan of the same shape; moves of such points get
 *   from = points[0] and keptEarlier = true, and the figures are recomputed
 */
export function refinePlanFromPositions(plan) {
    if (!plan) return plan;
    const moves = plan.moves.map(m => {
        const ann = m.annotation;
        const p = ann && ann.points && ann.points[0];
        if (!p || ![p.x, p.y, p.z].every(isNum) || !m.from || !m.to) return m;
        const sd = ann.survey ? ann.survey.surfaceDistance : null;
        if (Math.abs(distance3(p, m.from) - (isNum(sd) ? Math.abs(sd) : 0)) <= KEPT_POSITION_TOLERANCE) return m;
        return { ...m, from: { x: p.x, y: p.y, z: p.z }, displacement: distance3(p, m.to), keptEarlier: true };
    });
    const d = moves.map(m => m.displacement);
    return {
        ...plan,
        moves,
        maxDisplacement: d.reduce((mx, v) => Math.max(mx, v), 0),
        medianDisplacement: d.length ? medianOf(d) : 0
    };
}

/**
 * Whether a refine plan moves any point by more than REFINE_MOVE_EPSILON
 * (then the preview asks; otherwise the points are left alone).
 * @param {object} plan - planRefinePlacement()
 */
export function refineWouldMove(plan) {
    return !!plan && plan.count > 0 && plan.maxDisplacement > REFINE_MOVE_EPSILON;
}

/**
 * What the displacement preview shows.
 * @param {object} plan - refinePlanFromPositions(planRefinePlacement(annotations, previous, refined))
 * @param {{unchanged?: boolean}} [options] - unchanged: the fit stayed (refineUnchanged)
 *   and the points to move were left at an earlier fit
 * @returns {{count: number, largest: string, median: string, text: string,
 *            manualCount: number, manualNames: string[], manualMore: number, manualText: string}}
 *   manualNames = the first PREVIEW_NAME_LIMIT hand-moved points (user text), manualMore = the rest
 */
export function refinePreview(plan, { unchanged = false } = {}) {
    const count = plan ? plan.count : 0;
    const manual = (plan && plan.manual) || [];
    const largest = formatMetres(plan ? plan.maxDisplacement : null);
    const median = formatMetres(plan ? plan.medianDisplacement : null);
    const names = manual.slice(0, PREVIEW_NAME_LIMIT).map(annotationLabel);
    return {
        count,
        largest,
        median,
        text: unchanged
            ? `${plural(count, 'survey point')} placed by the fit ${count === 1 ? 'is' : 'are'} still at an earlier fit and would move: largest ${largest}, median ${median}.`
            : `With the new fit, ${plural(count, 'survey point')} placed by the fit would move: largest ${largest}, median ${median}.`,
        manualCount: manual.length,
        manualNames: names,
        manualMore: Math.max(0, manual.length - names.length),
        manualText: manual.length
            ? `${plural(manual.length, 'point')} moved by hand ${manual.length === 1 ? 'stays' : 'stay'} where ${manual.length === 1 ? 'it is' : 'they are'}:`
            : ''
    };
}

/**
 * The RMS before and after a refine: 'RMS 0.031 m → 0.022 m'.
 * @param {object} previous
 * @param {object} refined
 * @returns {string} '' without the new RMS
 */
export function rmsChangeText(previous, refined) {
    const a = previous && previous.quality ? previous.quality.rms : null;
    const b = refined && refined.quality ? refined.quality.rms : null;
    if (!isNum(b)) return '';
    return isNum(a) ? `RMS ${formatMetres(a)} → ${formatMetres(b)}` : `RMS ${formatMetres(b)}`;
}

/**
 * Status line after a refine or re-align.
 * @param {object} options
 * @param {object} options.previous - the alignment before
 * @param {object} options.refined - the alignment after (the same object: unchanged)
 * @param {'refine'|'realign'} [options.kind]
 * @param {object|null} [options.stats] - applyReplacement() result when points moved
 * @param {number} [options.kept] - fit points left where they were (Keep positions)
 * @param {number} [options.manualCount] - hand-moved points (never moved)
 * @returns {string} e.g. 'Alignment "Trench 3" refined (RMS 0.031 m → 0.022 m): 12 survey points moved (largest 0.042 m); 1 point moved by hand stayed'
 */
export function refineStatusText({ previous, refined, kind = 'refine', stats = null, kept = 0, manualCount = 0 }) {
    const unchanged = !!previous && refined === previous;
    const verb = unchanged ? 'unchanged' : (kind === 'realign' ? 're-aligned' : 'refined');
    const change = unchanged ? '' : rmsChangeText(previous, refined);
    const parts = [];
    if (stats && stats.moved > 0) {
        parts.push(`${plural(stats.moved, 'survey point')} moved (largest ${formatMetres(stats.maxMove)}${stats.snapped ? '' : ', not snapped to the surface'})`);
    } else if (stats) {
        parts.push('no survey point moved');
    }
    if (kept > 0) parts.push(`${plural(kept, 'survey point')} kept ${kept === 1 ? 'its position' : 'their positions'}`);
    if (manualCount > 0) parts.push(`${plural(manualCount, 'point')} moved by hand stayed`);
    return `Alignment "${alignmentDisplayName(refined || previous)}" ${verb}${change ? ` (${change})` : ''}` +
        (parts.length ? `: ${parts.join('; ')}` : '');
}

// ============ PDF report: alignment summary ============
// The summary is its own section after the metadata pages, listing the
// alignments used by the survey points in the report (Nils, decision 3).
// Everything here is ASCII, because the report's standard font covers
// WinAnsi only ('deg', not the degree sign); names and labels are user text
// and pass through unchanged, like annotation names in the report.

export const SUMMARY_TITLE = 'Survey alignments';

const VERDICT_WORDS = Object.freeze({ good: 'Good', check: 'Check', poor: 'Poor' });
const metresOrNa = (v) => (isNum(v) ? formatMetres(v) : 'n/a');
const degreesOrNa = (v) => (isNum(v) ? `${v.toFixed(2)} deg` : 'n/a');
const pad2 = (v) => String(v).padStart(2, '0');

/**
 * The alignments used by at least one of the annotations, in session order.
 * Detached points and links to an alignment no longer in the list count for none.
 * @param {object[]} annotations - the annotations in the report (visible groups only)
 * @param {object[]} alignments - state.alignments
 * @returns {object[]}
 */
export function reportAlignments(annotations, alignments) {
    const used = new Set();
    for (const ann of annotations || []) {
        const id = ann && ann.survey ? ann.survey.alignmentId : null;
        if (id !== null && id !== undefined) used.add(id);
    }
    return (alignments || []).filter(a => a && used.has(a.id));
}

/**
 * A timestamp as local 'YYYY-MM-DD HH:MM' (ASCII, unlike toLocaleString).
 * @param {string|number|Date} value
 * @returns {string} 'unknown' when it cannot be read
 */
export function reportDateText(value) {
    const t = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(value));
    if (!Number.isFinite(t)) return 'unknown';
    const d = new Date(t);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Short binding status for the report (the manager's messages are advice for the screen).
function bindingText(warning) {
    if (warning.code === BINDING_WARNINGS.MODEL_HASH) return 'Made on a different model file';
    if (warning.code === BINDING_WARNINGS.UP_AXIS) {
        const label = (v) => (typeof v === 'string' ? v.replace(/^([yz])-up$/i, (m, axis) => `${axis.toUpperCase()}-up`) : '?');
        return `Made with the model loaded as ${label(warning.alignmentUpAxis)}, now loaded as ${label(warning.modelUpAxis)}`;
    }
    return warning.message;
}

/**
 * What the report's alignment summary prints.
 * @param {object[]} annotations - the annotations in the report (visible groups only)
 * @param {object[]} alignments - state.alignments
 * @param {{modelHash?: string|null, modelUpAxis?: string|null, residualWarn?: number|null}} [current]
 *   modelHash null = unknown: never a mismatch; residualWarn = the current
 *   residual-warning setting (m), against which the verdict is judged, as in the manager
 * @returns {null|{title: string, intro: string, alignments: Array<{id, name: string,
 *   rows: Array<{key: string, label: string, value: string}>}>, note: string|null}}
 *   null when no annotation in the report uses an alignment. Row keys: crs,
 *   heightColumn, fitType, controlPoints, rms, maxResidual, scale, tilt,
 *   heading, verdict, points, created, modified, binding (only with a warning).
 */
export function alignmentSummaryView(annotations, alignments, { modelHash = null, modelUpAxis = null, residualWarn = null } = {}) {
    const used = reportAlignments(annotations, alignments);
    if (!used.length) return null;
    const rows = managerRows(used, annotations, { modelHash, modelUpAxis, residualWarn });
    const warnText = isNum(residualWarn) && residualWarn > 0 ? ` (residual warning ${formatMetres(residualWarn)})` : '';
    const ids = new Set((alignments || []).filter(Boolean).map(a => a.id));
    const detached = (annotations || []).filter(ann => ann && ann.survey && !ids.has(ann.survey.alignmentId)).length;

    return {
        title: SUMMARY_TITLE,
        intro: 'Alignments used by the survey points in this report. Each converts surveyed coordinates (E, N, H) ' +
            'into the model frame by a rigid fit to picked control points; the scale is fixed at 1.',
        alignments: rows.map(r => {
            const a = r.alignment;
            const q = a.quality || {};
            const list = [
                { key: 'crs', label: 'Coordinate system', value: r.crs },
                { key: 'heightColumn', label: 'Height column', value: r.heightColumn.trim() || 'not recorded' },
                { key: 'fitType', label: 'Fit type', value: r.fitType || 'unknown' },
                {
                    key: 'controlPoints', label: 'Control points used',
                    value: r.enabledCount === r.controlPointCount ? String(r.enabledCount) : `${r.enabledCount} of ${r.controlPointCount}`
                },
                { key: 'rms', label: 'RMS 3D / H / V', value: `${metresOrNa(q.rms)} / ${metresOrNa(q.rmsH)} / ${metresOrNa(q.rmsV)}` },
                { key: 'maxResidual', label: 'Largest residual', value: metresOrNa(q.maxResidual) },
                { key: 'scale', label: 'Estimated scale', value: isNum(q.scale) ? `${q.scale.toFixed(4)} (shown, not applied)` : 'n/a' },
                { key: 'tilt', label: 'Tilt', value: degreesOrNa(q.tiltDeg) },
                { key: 'heading', label: 'Heading', value: degreesOrNa(q.headingDeg) },
                { key: 'verdict', label: 'Verdict', value: `${VERDICT_WORDS[r.verdict] || r.verdict}${warnText}` },
                {
                    key: 'points', label: 'Points in this report',
                    value: String(r.pointCount) + (r.manualCount ? `, ${r.manualCount} moved by hand` : '')
                },
                { key: 'created', label: 'Created', value: reportDateText(a.created) },
                { key: 'modified', label: 'Modified', value: reportDateText(a.modified) }
            ];
            if (r.warnings.length) {
                list.push({ key: 'binding', label: 'Model binding', value: r.warnings.map(bindingText).join('; ') });
            }
            return { id: r.id, name: r.name, rows: list };
        }),
        note: detached
            ? `${plural(detached, 'survey point')} in this report ${detached === 1 ? 'has' : 'have'} no alignment (detached); ` +
              `${detached === 1 ? 'its page shows' : 'their pages show'} the surveyed coordinate only.`
            : null
    };
}

// ============ Delete ============

/**
 * The default alignment after one is removed: unchanged when another one was
 * the default; otherwise the first remaining alignment, or null when none is left.
 * @param {object[]} remaining - the alignments after the removal
 * @param {*} removedId
 * @param {*} defaultAlignmentId - the default before
 * @returns {*} the new default id
 */
export function defaultAfterRemoval(remaining, removedId, defaultAlignmentId) {
    const list = remaining || [];
    if (defaultAlignmentId !== removedId && list.some(a => a.id === defaultAlignmentId)) return defaultAlignmentId;
    return list.length ? list[0].id : null;
}

/**
 * Removes an alignment from a session (Delete in the manager).
 * mode 'detach': the alignment's survey points get detachSurvey() blocks IN
 * PLACE (annotation objects keep their identity; the surveyed coordinate,
 * raw values, attributes, source, placement, lock and position stay).
 * mode 'delete': the points are only listed; the caller removes them and
 * tidies the selection, popup and callout (groups.js removeAnnotations).
 * @param {{alignments: object[], annotations: object[], defaultAlignmentId: *}} session
 * @param {*} alignmentId
 * @param {'detach'|'delete'} mode
 * @returns {{alignments: object[], defaultAlignmentId: *, detached: object[], deleted: object[], alignment: object|null}}
 *   alignment = the removed one (null when it did not exist; nothing changes then)
 */
export function deleteAlignment({ alignments, annotations, defaultAlignmentId = null }, alignmentId, mode = 'detach') {
    const alignment = (alignments || []).find(a => a.id === alignmentId) || null;
    if (!alignment) return { alignments: alignments || [], defaultAlignmentId, detached: [], deleted: [], alignment: null };
    const points = surveyPointsOf(annotations, alignmentId);
    const remaining = removeAlignment(alignments, alignmentId, defaultAlignmentId).alignments;
    const out = {
        alignments: remaining,
        defaultAlignmentId: defaultAfterRemoval(remaining, alignmentId, defaultAlignmentId),
        detached: [],
        deleted: [],
        alignment
    };
    if (mode === 'delete') {
        out.deleted = points;
    } else {
        for (const ann of points) ann.survey = detachSurvey(ann.survey);
        out.detached = points;
    }
    return out;
}

/**
 * Message of the delete dialog.
 * @param {object} alignment
 * @param {number} pointCount - survey points attached to it
 * @returns {string}
 */
export function deleteMessage(alignment, pointCount) {
    const name = alignmentDisplayName(alignment);
    if (!pointCount) return `Delete the alignment "${name}"? No survey points use it. This cannot be undone.`;
    return `The alignment "${name}" places ${plural(pointCount, 'survey point')}. Detach ${pointCount === 1 ? 'it' : 'them'}, or delete ${pointCount === 1 ? 'it' : 'them'} with the alignment?`;
}
