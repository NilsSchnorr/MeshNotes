// tests/manager.test.js - Alignment Manager logic: chip text, list rows, refine rows and effects, delete and detach
// (plan: Workflow in detail > Alignment Manager; Defaults > Refining an alignment;
// Changes to existing behaviour > Model binding; Edge cases, alignment block).
// Made-up data only (tests/support/survey-samples.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as MG from '../js/survey/manager.js';
import { planRefinePlacement, refineAlignment, realignAlignment, editAlignmentMetadata, makeControlPoint, surveyToStorage, UNSPECIFIED_CRS } from '../js/survey/alignment.js';
import { picksFromControlPoints } from '../js/survey/picking.js';
import { makeAlignment, refined, surveyAnnotation, plainAnnotation, controlPoints, T1, T2, T3 } from './support/survey-samples.js';

// Survey coordinates of made-up points on the site of the sample alignment.
const S1 = { e: 512003.25, n: 4123004.5, h: 58.4 };
const S2 = { e: 511996.75, n: 4122998.25, h: 59.1 };
const S3 = { e: 512001.5, n: 4122994.75, h: 58.7 };

function session() {
    const a = makeAlignment({ id: 1, uuid: 'a-1', now: T1 });
    const b = makeAlignment({ id: 2, uuid: 'b-2', now: T1, name: 'Trench 4' });
    const annotations = [
        surveyAnnotation({ id: 10, uuid: 'p-10', alignment: a, s: S1, name: 'BB_1' }),
        surveyAnnotation({ id: 11, uuid: 'p-11', alignment: a, s: S2, name: 'BB_2', placement: 'manual' }),
        surveyAnnotation({ id: 12, uuid: 'p-12', alignment: b, s: S3, name: 'BB_3' }),
        plainAnnotation({ id: 13, uuid: 'n-13' })
    ];
    return { a, b, annotations };
}

test('chip text: no alignment, one with its RMS, or the number of alignments', () => {
    const none = MG.alignmentChipView([]);
    assert.equal(none.kind, 'none');
    assert.equal(none.text, 'No alignment');
    assert.match(none.title, /create one/);

    const a = { ...makeAlignment({ id: 1, uuid: 'a-1' }), quality: { n: 5, rms: 0.0216 }, crsLabel: '' };
    const one = MG.alignmentChipView([a]);
    assert.equal(one.kind, 'one');
    assert.equal(one.text, '1 alignment · RMS 0.022 m');
    assert.match(one.title, /"Trench 3" \(unspecified coordinate system\): RMS 0\.022 m from 5 control points/);

    const many = MG.alignmentChipView([a, { ...a, id: 2 }, { ...a, id: 3 }]);
    assert.equal(many.kind, 'many');
    assert.equal(many.text, '3 alignments');

    assert.equal(MG.alignmentDisplayName({ name: '  ' }), MG.UNNAMED_ALIGNMENT);
});

test('manager rows: points, hand-moved points, default, history and verdict', () => {
    const { a, b, annotations } = session();
    const a2 = refined(a, { headingDeg: 91, now: T2 });
    const rows = MG.managerRows([a2, b], annotations, { defaultAlignmentId: 2, modelHash: 'abc123', modelUpAxis: 'y-up' });
    assert.equal(rows.length, 2);
    const [ra, rb] = rows;
    assert.equal(ra.name, 'Trench 3');
    assert.equal(ra.crs, 'EPSG:32635');
    assert.equal(ra.heightColumn, 'Elevation');
    assert.equal(ra.fitType, 'Full');
    assert.equal(ra.controlPointCount, 5);
    assert.equal(ra.enabledCount, 5);
    assert.equal(ra.pointCount, 2);
    assert.equal(ra.manualCount, 1);
    assert.equal(ra.versionCount, 1);
    assert.equal(ra.isDefault, false);
    assert.equal(rb.isDefault, true);
    assert.equal(rb.pointCount, 1);
    assert.ok(ra.rms < 1e-6);
    assert.equal(ra.verdict, 'good');
    assert.deepEqual(ra.warnings, []);
    assert.equal(ra.checking, false);
});

test('binding warnings: another model file or up-axis warns; an unknown hash never does', () => {
    const { a } = session();
    // Compressed copy of the same model: a different hash, a warning, still listed
    let [row] = MG.managerRows([a], [], { modelHash: 'ffff', modelUpAxis: 'y-up' });
    assert.deepEqual(row.warnings.map(w => w.code), ['MODEL_HASH']);
    // Hash not known yet (still hashing): no warning, 'checking'
    [row] = MG.managerRows([a], [], { modelHash: null, modelUpAxis: 'y-up', hashPending: true });
    assert.deepEqual(row.warnings, []);
    assert.equal(row.checking, true);
    // A model loaded from a URL: no hash at all, neither warning nor 'checking'
    [row] = MG.managerRows([a], [], { modelHash: null, modelUpAxis: 'y-up', hashPending: false });
    assert.deepEqual(row.warnings, []);
    assert.equal(row.checking, false);
    // The same file: nothing to say
    [row] = MG.managerRows([a], [], { modelHash: 'ABC123', modelUpAxis: 'y-up', hashPending: false });
    assert.deepEqual(row.warnings, []);
    // Loaded with the other up-axis
    [row] = MG.managerRows([a], [], { modelHash: 'abc123', modelUpAxis: 'z-up' });
    assert.deepEqual(row.warnings.map(w => w.code), ['UP_AXIS']);
    // An alignment that recorded no model file is never 'checking'
    [row] = MG.managerRows([{ ...a, modelSha256: null }], [], { modelHash: null, hashPending: true });
    assert.equal(row.checking, false);
});

test('empty coordinate system label reads as unspecified; a rename bumps modified', () => {
    const { a } = session();
    const renamed = editAlignmentMetadata(a, { name: 'Trench 3 west', crsLabel: '', now: T3 });
    assert.equal(renamed.modified, T3);
    const [row] = MG.managerRows([renamed], []);
    assert.equal(row.crs, UNSPECIFIED_CRS);
    assert.equal(row.name, 'Trench 3 west');
});

test('refine rows: control points first, then attached points not taken as control points', () => {
    const { a, b, annotations } = session();
    // A point created from the row of control point 1 (same surveyed coordinates)
    const fromCp = surveyAnnotation({ id: 14, uuid: 'p-14', alignment: a, s: a.controlPoints[0].surveyed, name: 'GCP1' });
    const rows = MG.refineRows(a, [...annotations, fromCp]);
    assert.deepEqual(rows.map(r => r.key), ['cp0', 'cp1', 'cp2', 'cp3', 'cp4', 'ptp-10', 'ptp-11']);
    assert.equal(rows[5].label, 'BB_1');
    assert.equal(rows[5].csvRow, 5);
    assert.deepEqual(rows[5].surveyed, S1);
    // Points of another alignment and plain annotations are not candidates
    assert.ok(!rows.some(r => r.key === 'ptp-12' || r.key === 'ptn-13'));
    // Every stored control point finds its row again (Refine starts from them)
    const { picks, unmatched } = picksFromControlPoints(rows, a.controlPoints);
    assert.equal(picks.length, 5);
    assert.deepEqual(unmatched, []);
    assert.deepEqual(picks.map(p => p.key), ['cp0', 'cp1', 'cp2', 'cp3', 'cp4']);
    // An alignment without points offers only its control points
    assert.equal(MG.refineRows(b, []).length, 5);
});

test('refine: fit points move after the preview, hand-moved points never, the old fit is kept', () => {
    const { a, annotations } = session();
    // A fifth control point is added from an imported point (a row of the refine)
    const extra = makeControlPoint({ label: 'BB_1', csvRow: 5, modelPosition: { x: 1.5, y: -2.25, z: 0.4 }, surveyed: S1 });
    const r = refineAlignment(a, { controlPoints: [...controlPoints(90.5), extra], now: T2 });
    assert.equal(r.id, a.id);
    assert.equal(r.versions.length, 1);
    assert.equal(r.modified, T2);
    const plan = planRefinePlacement(annotations, a, r);
    assert.ok(MG.refineWouldMove(plan));
    const p = MG.refinePreview(plan);
    assert.equal(p.count, 1);
    assert.equal(p.manualCount, 1);
    assert.deepEqual(p.manualNames, ['BB_2']);
    assert.equal(p.manualMore, 0);
    assert.match(p.text, /^With the new fit, 1 survey point placed by the fit would move: largest \d+\.\d{3} m, median \d+\.\d{3} m\.$/);
    assert.equal(p.manualText, '1 point moved by hand stays where it is:');

    // The same fit again moves nothing: no preview
    const same = refineAlignment(a, { controlPoints: a.controlPoints, now: T2 });
    assert.equal(MG.refineWouldMove(planRefinePlacement(annotations, a, same)), false);

    // Re-align from scratch keeps the previous fit in the history too
    const re = realignAlignment(r, { controlPoints: controlPoints(92), fitType: 'level4', now: T3 });
    assert.equal(re.versions.length, 2);
    assert.equal(re.fitType, 'level4');
});

test('after Keep positions the next refine offers the move again, measured from where the points are', () => {
    const { a, annotations } = session();
    const p10 = annotations[0];
    // At its fitted position, which lies on the surface
    p10.survey.surfaceDistance = 0;
    // A snapped point: exactly its surface distance away from its fitted position
    const fitted = surveyToStorage(a, S3);
    const snapped = surveyAnnotation({ id: 15, uuid: 'p-15', alignment: a, s: S3, name: 'BB_4', position: { ...fitted, y: fitted.y - 0.012 } });
    const points = [...annotations, snapped];
    const r1 = refined(a, { headingDeg: 91, now: T2 });
    // Points at the previous fit keep the plan's figures
    const first = planRefinePlacement(points, a, r1);
    const measured = MG.refinePlanFromPositions(first);
    assert.deepEqual(measured.moves.map(m => m.displacement), first.moves.map(m => m.displacement));
    assert.ok(!measured.moves.some(m => m.keptEarlier));
    assert.equal(measured.maxDisplacement, first.maxDisplacement);

    // Keep: r1 is saved, the points stay at the fit of a. The same fit
    // accepted again moves no fitted position, but the kept points are offered.
    const again = planRefinePlacement(points, r1, r1);
    assert.equal(MG.refineWouldMove(again), false);
    const plan = MG.refinePlanFromPositions(again);
    assert.ok(MG.refineWouldMove(plan));
    assert.equal(plan.count, 2);
    const m10 = plan.moves.find(m => m.annotation === p10);
    assert.equal(m10.keptEarlier, true);
    assert.deepEqual(m10.from, p10.points[0]);
    // The figure is the real move: from points[0] (the fit of a) to the fit of r1
    const real = first.moves.find(m => m.annotation === p10).displacement;
    assert.ok(Math.abs(m10.displacement - real) < 1e-9);
    assert.match(MG.refinePreview(plan, { unchanged: true }).text,
        /^2 survey points placed by the fit are still at an earlier fit and would move: largest \d+\.\d{3} m, median \d+\.\d{3} m\.$/);
    // Hand-moved points are still never planned
    assert.deepEqual(plan.manual.map(x => x.id), [11]);
});

test('a point left by Keep is offered again also when it sits closer to the saved fit than its surface distance', () => {
    const { a } = session();
    const r1 = refined(a, { headingDeg: 91, now: T2 });
    const f0 = surveyToStorage(a, S3);
    const f1 = surveyToStorage(r1, S3);
    const d = Math.hypot(f1.x - f0.x, f1.y - f0.y, f1.z - f0.z);
    // Snapped 5 cm from the fit of a, towards the fit of r1: closer to r1's fitted position than 5 cm
    const sd = 0.05;
    assert.ok(d > sd && d < 2 * sd - 0.001, `test geometry: ${d}`);
    const k = sd / d;
    const p = { x: f0.x + (f1.x - f0.x) * k, y: f0.y + (f1.y - f0.y) * k, z: f0.z + (f1.z - f0.z) * k };
    const ann = surveyAnnotation({ id: 16, uuid: 'p-16', alignment: a, s: S3, name: 'BB_5', position: p, surfaceDistance: sd });
    // At the fit of a: the plan's figures
    assert.ok(!MG.refinePlanFromPositions(planRefinePlacement([ann], a, r1)).moves.some(m => m.keptEarlier));
    // Keep, then r1 accepted again without a change: still offered
    const plan = MG.refinePlanFromPositions(planRefinePlacement([ann], r1, r1));
    assert.ok(MG.refineWouldMove(plan));
    assert.equal(plan.moves[0].keptEarlier, true);
    assert.ok(Math.abs(plan.moves[0].displacement - (d - sd)) < 1e-9);
});

test('a refine accepted without a change saves nothing', () => {
    const { a } = session();
    const current = { modelHash: 'abc123', modelUpAxis: 'y-up' };
    const same = a.controlPoints.map(cp => makeControlPoint(cp));
    assert.equal(MG.refineUnchanged(a, { controlPoints: same, fitType: a.fitType, ...current }), true);
    // An unticked point, a re-pick, the other fit type or a further point is a change
    const unticked = same.map((cp, i) => (i === 2 ? { ...cp, enabled: false } : cp));
    assert.equal(MG.refineUnchanged(a, { controlPoints: unticked, fitType: a.fitType, ...current }), false);
    const repicked = same.map((cp, i) => (i === 0 ? { ...cp, modelPosition: { ...cp.modelPosition, x: cp.modelPosition.x + 0.01 } } : cp));
    assert.equal(MG.refineUnchanged(a, { controlPoints: repicked, fitType: a.fitType, ...current }), false);
    assert.equal(MG.refineUnchanged(a, { controlPoints: same, fitType: 'level4', ...current }), false);
    const extra = makeControlPoint({ label: 'BB_1', modelPosition: { x: 1.5, y: -2.25, z: 0.4 }, surveyed: S1 });
    assert.equal(MG.refineUnchanged(a, { controlPoints: [...same, extra], fitType: a.fitType, ...current }), false);
    // Accepting on another model file rebinds the alignment: a change
    assert.equal(MG.refineUnchanged(a, { controlPoints: same, fitType: a.fitType, modelHash: 'ffff', modelUpAxis: 'y-up' }), false);
    // An unknown hash (still hashing, URL load) is no change
    assert.equal(MG.refineUnchanged(a, { controlPoints: same, fitType: a.fitType, modelHash: null, modelUpAxis: 'y-up' }), true);
    // The status line says so
    assert.equal(MG.refineStatusText({ previous: a, refined: a, manualCount: 1 }), 'Alignment "Trench 3" unchanged: 1 point moved by hand stayed');
});

test('refine preview lists at most ten hand-moved points by name', () => {
    const { a } = session();
    const manual = Array.from({ length: 13 }, (_, i) =>
        surveyAnnotation({ id: 100 + i, uuid: `m-${i}`, alignment: a, s: S1, name: `M${i}`, placement: 'manual' }));
    const plan = planRefinePlacement(manual, a, refined(a, { headingDeg: 91, now: T2 }));
    const p = MG.refinePreview(plan);
    assert.equal(p.count, 0);
    assert.equal(p.manualNames.length, MG.PREVIEW_NAME_LIMIT);
    assert.equal(p.manualMore, 3);
    assert.equal(MG.refineWouldMove(plan), false);
});

test('refine status line: moved, kept, hand-moved and the RMS change', () => {
    const previous = { name: 'Trench 3', quality: { rms: 0.031 } };
    const next = { name: 'Trench 3', quality: { rms: 0.022 } };
    assert.equal(MG.rmsChangeText(previous, next), 'RMS 0.031 m → 0.022 m');
    assert.equal(
        MG.refineStatusText({ previous, refined: next, stats: { moved: 12, maxMove: 0.0424, snapped: true }, manualCount: 1 }),
        'Alignment "Trench 3" refined (RMS 0.031 m → 0.022 m): 12 survey points moved (largest 0.042 m); 1 point moved by hand stayed');
    assert.equal(
        MG.refineStatusText({ previous, refined: next, kind: 'realign', kept: 3 }),
        'Alignment "Trench 3" re-aligned (RMS 0.031 m → 0.022 m): 3 survey points kept their positions');
    assert.equal(
        MG.refineStatusText({ previous, refined: next, stats: { moved: 1, maxMove: 0.5, snapped: false } }),
        'Alignment "Trench 3" refined (RMS 0.031 m → 0.022 m): 1 survey point moved (largest 0.500 m, not snapped to the surface)');
    assert.equal(MG.refineStatusText({ previous, refined: next }), 'Alignment "Trench 3" refined (RMS 0.031 m → 0.022 m)');
});

test('delete, detach: points keep their surveyed coordinates without an alignment; the default passes on', () => {
    const { a, b, annotations } = session();
    const p10 = annotations[0];
    const before = { point: { ...p10.points[0] }, survey: p10.survey };
    const result = MG.deleteAlignment({ alignments: [a, b], annotations, defaultAlignmentId: 1 }, 1, 'detach');
    assert.equal(result.alignment, a);
    assert.deepEqual(result.alignments.map(x => x.id), [2]);
    assert.equal(result.defaultAlignmentId, 2);
    assert.deepEqual(result.detached.map(x => x.id), [10, 11]);
    assert.deepEqual(result.deleted, []);
    // Detached in place: same annotation objects, a new survey block
    assert.equal(annotations[0], p10);
    assert.notEqual(p10.survey, before.survey);
    assert.equal(p10.survey.alignmentId, null);
    assert.equal(p10.survey.e, S1.e);
    assert.equal(p10.survey.n, S1.n);
    assert.equal(p10.survey.h, S1.h);
    assert.deepEqual(p10.survey.raw, before.survey.raw);
    assert.deepEqual(p10.survey.attributes, before.survey.attributes);
    assert.deepEqual(p10.survey.source, before.survey.source);
    assert.equal(p10.survey.placement, 'fit');
    assert.deepEqual(p10.points[0], before.point);
    assert.equal(p10.locked, true);
    assert.equal(annotations[1].survey.placement, 'manual');
    // The other alignment's point is untouched
    assert.equal(annotations[2].survey.alignmentId, 2);
});

test('delete, delete points too: the points are listed for removal, nothing else changes', () => {
    const { a, b, annotations } = session();
    const result = MG.deleteAlignment({ alignments: [a, b], annotations, defaultAlignmentId: 2 }, 1, 'delete');
    assert.deepEqual(result.deleted.map(x => x.id), [10, 11]);
    assert.deepEqual(result.detached, []);
    assert.equal(result.defaultAlignmentId, 2);     // another one was the default
    assert.equal(annotations[0].survey.alignmentId, 1);     // the caller removes them
    assert.equal(annotations.length, 4);
});

test('delete: the last alignment clears the default; an unknown id changes nothing', () => {
    const { b } = session();
    const last = MG.deleteAlignment({ alignments: [b], annotations: [], defaultAlignmentId: 2 }, 2, 'detach');
    assert.deepEqual(last.alignments, []);
    assert.equal(last.defaultAlignmentId, null);

    const alignments = [b];
    const none = MG.deleteAlignment({ alignments, annotations: [], defaultAlignmentId: 2 }, 99, 'delete');
    assert.equal(none.alignment, null);
    assert.equal(none.alignments, alignments);
    assert.equal(none.defaultAlignmentId, 2);

    assert.equal(MG.defaultAfterRemoval([b], 1, 7), 2);      // a stale default goes to the first remaining
    assert.equal(MG.defaultAfterRemoval([b], 1, 2), 2);
});

test('delete message: a simple question without points, detach or delete with points', () => {
    const { a } = session();
    assert.match(MG.deleteMessage(a, 0), /^Delete the alignment "Trench 3"\? No survey points use it\./);
    assert.equal(MG.deleteMessage(a, 1), 'The alignment "Trench 3" places 1 survey point. Detach it, or delete it with the alignment?');
    assert.equal(MG.deleteMessage(a, 4), 'The alignment "Trench 3" places 4 survey points. Detach them, or delete them with the alignment?');
});

test('view control points: the read-only review matches the stored fit; a deleted annotation does not matter', () => {
    const { a } = session();
    const cps = a.controlPoints.map((cp, i) => (i === 1 ? { ...cp, annotationUuid: 'deleted-annotation' } : cp));
    cps[4] = { ...cps[4], enabled: false };
    const stored = refineAlignment(a, { controlPoints: cps, now: T2 });
    const review = MG.alignmentReview(stored);
    assert.equal(review.rows.length, 5);
    assert.deepEqual(review.rows.map(r => r.key), ['cp0', 'cp1', 'cp2', 'cp3', 'cp4']);
    assert.equal(review.rows[1].fromAnnotation, true);
    assert.equal(review.rows[4].enabled, false);
    assert.equal(review.evaluation.fit.quality.n, 4);
    review.rows.forEach((r, i) => {
        stored.controlPoints[i].residual.forEach((v, k) => assert.ok(Math.abs(v - r.residual[k]) < 1e-9));
    });
    assert.equal(review.evaluation.verdict, 'good');
    assert.match(review.verdictText, /^Good: /);
});

test('read-only checks: no buttons, picking steps point to Refine', () => {
    const messages = [
        { level: 'warning', code: 'LOO_OUTLIER', text: 'GCP2 (row 3) does not fit the others (leave-one-out error 0.512 m). Re-pick or disable it.', action: { id: 'select', label: 'Re-pick', key: 'cp1' } },
        { level: 'notice', code: 'LEVEL_SUGGESTED', text: 'The full fit tilts the model by only 0.12°. If the model is already level, tick "Model is already level".' },
        { level: 'warning', code: 'NO_REDUNDANCY', text: 'With only 3 points a bad pick cannot be found. Pick a fourth row.' },
        { level: 'error', code: 'SWAPPED_EN', text: 'Easting and Northing appear to be swapped.', action: { id: 'swap', label: 'Swap Easting and Northing' } }
    ];
    const out = MG.readOnlyMessages(messages);
    assert.ok(out.every(m => !('action' in m)));
    assert.equal(out[0].text, 'GCP2 (row 3) does not fit the others (leave-one-out error 0.512 m). Refine can re-pick or disable it.');
    assert.equal(out[1].text, 'The full fit tilts the model by only 0.12°. If the model is already level, Refine can switch to the level-only fit.');
    assert.equal(out[2].text, 'With only 3 points a bad pick cannot be found. Refine can add a fourth control point.');
    assert.equal(out[3].text, 'Easting and Northing appear to be swapped.');
});

test('list verdict: RESIDUAL_WARN follows the current residual-warning setting', () => {
    // A good fit whose largest residual (4 cm) lies between two settings.
    const a = {
        ...makeAlignment({ id: 1, uuid: 'a-1' }),
        quality: { n: 5, rms: 0.02, rmsH: 0.015, rmsV: 0.013, maxResidual: 0.04, scale: 1, tiltDeg: 0.1, headingDeg: 10, flags: [] }
    };
    assert.equal(MG.managerRows([a], [])[0].verdict, 'good');                          // stored flags
    assert.equal(MG.managerRows([a], [], { residualWarn: 0.05 })[0].verdict, 'good');
    assert.equal(MG.managerRows([a], [], { residualWarn: 0.03 })[0].verdict, 'check');

    // A flag stored with a stricter setting is dropped under a looser one,
    // and other flags are kept.
    const flagged = { ...a, quality: { ...a.quality, flags: ['RESIDUAL_WARN', 'WEAK_GEOMETRY'] } };
    assert.equal(MG.managerRows([flagged], [], { residualWarn: 0.1 })[0].verdict, 'check');
    const onlyResidual = { ...a, quality: { ...a.quality, flags: ['RESIDUAL_WARN'] } };
    assert.equal(MG.managerRows([onlyResidual], [], { residualWarn: 0.1 })[0].verdict, 'good');
    assert.deepEqual(onlyResidual.quality.flags, ['RESIDUAL_WARN']);                    // not mutated
    // An invalid setting keeps the stored flags.
    assert.equal(MG.managerRows([onlyResidual], [], { residualWarn: 0 })[0].verdict, 'check');
});

test('PDF summary: only alignments used by annotations in the report, in session order', () => {
    const { a, b, annotations } = session();
    const c = makeAlignment({ id: 3, uuid: 'c-3', name: 'Unused' });
    // Every annotation in the report: a and b, in session order (not point order).
    assert.deepEqual(MG.reportAlignments([annotations[2], annotations[0]], [a, b, c]).map(x => x.id), [1, 2]);
    // Hidden groups are left out by the caller: only b's point remains.
    assert.deepEqual(MG.reportAlignments([annotations[2], annotations[3]], [a, b, c]).map(x => x.id), [2]);
    // Plain, detached and lost links count for none.
    const detached = surveyAnnotation({ id: 20, uuid: 'p-20', alignment: null, s: S1, position: { x: 1, y: 2, z: 3 } });
    const lost = surveyAnnotation({ id: 21, uuid: 'p-21', alignment: { ...a, id: 99 }, s: S1 });
    assert.deepEqual(MG.reportAlignments([annotations[3], detached, lost], [a, b, c]), []);
    assert.equal(MG.alignmentSummaryView([annotations[3], detached], [a, b, c]), null);
    assert.equal(MG.alignmentSummaryView([], [a]), null);
    assert.equal(MG.alignmentSummaryView(null, null), null);
});

test('PDF summary rows: figures, verdict with the current residual warning, points in the report, dates', () => {
    const { a, annotations: all } = session();
    const annotations = [all[0], all[1], all[3]];   // a's two points and a plain one
    const quality = { n: 5, rms: 0.0216, rmsH: 0.0151, rmsV: 0.0142, maxResidual: 0.04, scale: 1.00031, tiltDeg: 0.187, headingDeg: 90.004, flags: [] };
    const al = { ...a, quality, fitType: 'level4', controlPoints: a.controlPoints.map((cp, i) => (i === 4 ? { ...cp, enabled: false } : cp)) };
    const view = MG.alignmentSummaryView(annotations, [al], { modelHash: 'abc123', modelUpAxis: 'y-up', residualWarn: 0.05 });
    assert.equal(view.title, MG.SUMMARY_TITLE);
    assert.equal(view.note, null);
    assert.equal(view.alignments.length, 1);
    const s = view.alignments[0];
    assert.equal(s.name, 'Trench 3');
    const value = (key) => (s.rows.find(r => r.key === key) || {}).value;
    assert.deepEqual(s.rows.map(r => r.key),
        ['crs', 'heightColumn', 'fitType', 'controlPoints', 'rms', 'maxResidual', 'scale', 'tilt', 'heading', 'verdict', 'points', 'created', 'modified']);
    assert.equal(value('crs'), 'EPSG:32635');
    assert.equal(value('heightColumn'), 'Elevation');
    assert.equal(value('fitType'), 'Level only');
    assert.equal(value('controlPoints'), '4 of 5');
    assert.equal(value('rms'), '0.022 m / 0.015 m / 0.014 m');
    assert.equal(value('maxResidual'), '0.040 m');
    assert.equal(value('scale'), '1.0003 (shown, not applied)');
    assert.equal(value('tilt'), '0.19 deg');
    assert.equal(value('heading'), '90.00 deg');
    assert.equal(value('verdict'), 'Good (residual warning 0.050 m)');
    assert.equal(value('points'), '2, 1 moved by hand');
    assert.equal(value('created'), MG.reportDateText(a.created));
    assert.match(value('created'), /^\d{4}-\d\d-\d\d \d\d:\d\d$/);

    // A stricter residual warning turns the verdict to Check (as in the manager).
    const strict = MG.alignmentSummaryView(annotations, [al], { residualWarn: 0.03 });
    assert.equal(strict.alignments[0].rows.find(r => r.key === 'verdict').value, 'Check (residual warning 0.030 m)');

    // Points in hidden groups are not passed in, so they are not counted.
    const visibleOnly = MG.alignmentSummaryView([annotations[0]], [al], { residualWarn: 0.05 });
    assert.equal(visibleOnly.alignments[0].rows.find(r => r.key === 'points').value, '1');

    // Everything except user text is printable ASCII (the report font covers WinAnsi only).
    const text = [view.title, view.intro, ...s.rows.flatMap(r => [r.label, r.value])].join('\n');
    assert.match(text, /^[\x20-\x7e\n]*$/);
});

test('PDF summary: binding status only when it applies; a null model hash is never a mismatch; detached note', () => {
    const { a, b, annotations } = session();
    const binding = (view, i = 0) => (view.alignments[i].rows.find(r => r.key === 'binding') || {}).value;

    const same = MG.alignmentSummaryView(annotations, [a, b], { modelHash: 'ABC123', modelUpAxis: 'y-up' });
    assert.equal(binding(same), undefined);
    assert.equal(binding(MG.alignmentSummaryView(annotations, [a], { modelHash: null, modelUpAxis: 'y-up' })), undefined);

    const other = MG.alignmentSummaryView(annotations, [a], { modelHash: 'ffff00', modelUpAxis: 'z-up' });
    assert.equal(binding(other), 'Made on a different model file; Made with the model loaded as Y-up, now loaded as Z-up');

    const detached = surveyAnnotation({ id: 20, uuid: 'p-20', alignment: null, s: S1, position: { x: 1, y: 2, z: 3 } });
    const lost = surveyAnnotation({ id: 21, uuid: 'p-21', alignment: { ...a, id: 99 }, s: S2 });
    const one = MG.alignmentSummaryView([annotations[0], detached], [a, b]);
    assert.equal(one.note, '1 survey point in this report has no alignment (detached); its page shows the surveyed coordinate only.');
    assert.equal(one.alignments.length, 1);
    const two = MG.alignmentSummaryView([annotations[0], detached, lost], [a, b]);
    assert.match(two.note, /^2 survey points in this report have no alignment \(detached\); their pages show/);
});

test('PDF summary: missing figures and dates read as n/a and unknown', () => {
    const { a, annotations: all } = session();
    const annotations = [all[0], all[1]];
    const bare = { ...a, name: '', crsLabel: '', heightColumn: '', quality: {}, created: 'not a date', modified: null };
    const s = MG.alignmentSummaryView(annotations, [bare]).alignments[0];
    const value = (key) => s.rows.find(r => r.key === key).value;
    assert.equal(s.name, MG.UNNAMED_ALIGNMENT);
    assert.equal(value('crs'), UNSPECIFIED_CRS);
    assert.equal(value('heightColumn'), 'not recorded');
    assert.equal(value('rms'), 'n/a / n/a / n/a');
    assert.equal(value('scale'), 'n/a');
    assert.equal(value('tilt'), 'n/a');
    assert.equal(value('verdict'), 'Poor');
    assert.equal(value('created'), 'unknown');
    assert.equal(value('modified'), 'unknown');
    assert.equal(MG.reportDateText(new Date(2026, 9, 3, 7, 5)), '2026-10-03 07:05');
});
