// tests/picking.test.js - Control-point picking session: rows, picks and undo, live fit, messages, review rows
// (plan: Workflow in detail > Step B picking panel and Step C review; Edge cases, fit block).
// Made-up data only: model points in the export frame and survey points built from a known transform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PK from '../js/survey/picking.js';
import { createAlignment, fittedPositions } from '../js/survey/alignment.js';
import { FLAGS, ERRORS } from '../js/survey/rigid-fit.js';
import { quatFromAxisAngle, quatMultiply, quatToMat } from '../js/survey/linalg.js';
import { parseSurveyCsv, autoMap, buildRecords, swapMappingEN } from '../js/survey/column-mapping.js';
import { pointFromZUp } from '../js/utils/coords.js';

const DEG = Math.PI / 180;
const T = [512300.25, 4123400.5, 58.2];           // UTM-sized shift

// survey = R p + t for a heading and a small tilt (written out, not taken from the solver).
function makeTransform(headingDeg, tiltDeg = 0) {
    const turn = quatFromAxisAngle([0, 0, 1], -headingDeg * DEG);
    const tilt = quatFromAxisAngle([1, 0, 0], tiltDeg * DEG);
    const q = quatMultiply(turn, tilt);
    const R = quatToMat(q);
    return (p) => {
        const v = [p.x, p.y, p.z];
        const r = R.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
        return { e: r[0] + T[0], n: r[1] + T[1], h: r[2] + T[2] };
    };
}

// Six model points in a 20 x 20 x 3 m box (export frame) and their survey coordinates.
const MODEL = [
    { x: -9, y: -8, z: 0.2 }, { x: 8, y: -9, z: 1.1 }, { x: 9, y: 7, z: 2.9 },
    { x: -7, y: 9, z: 0.6 }, { x: 0.5, y: 0.3, z: 1.8 }, { x: -3, y: 4, z: 2.2 }
];

function dataset({ headingDeg = 37, tiltDeg = 0.3, model = MODEL } = {}) {
    const toSurvey = makeTransform(headingDeg, tiltDeg);
    const records = model.map((p, i) => {
        const s = toSurvey(p);
        return { row: i + 2, name: `GCP${i + 1}`, e: s.e, n: s.n, h: s.h };
    });
    const rows = PK.rowsFromRecords(records);
    return { records, rows, model };
}

// A session with every row picked at its true model position.
function pickedSession(data, { count = data.rows.length, fitType = 'rigid6' } = {}) {
    let s = PK.createPickingSession({ rows: data.rows, fitType });
    for (let i = 0; i < count; i++) s = PK.setPick(s, data.rows[i].key, { modelPosition: data.model[i] });
    return s;
}

test('rows from CSV records: stable keys by spreadsheet row, labels, copies of E/N/H', () => {
    const records = [
        { row: 2, name: 'A', e: 1, n: 2, h: 3 },
        { row: 5, name: '', e: 4, n: 5, h: 6 }
    ];
    const rows = PK.rowsFromRecords(records);
    assert.deepEqual(rows.map(r => r.key), ['row2', 'row5']);
    assert.deepEqual(rows.map(r => r.label), ['A', 'Row 5']);
    assert.deepEqual(rows[1].surveyed, { e: 4, n: 5, h: 6 });
    const named = PK.rowsFromRecords(records, { label: r => r.name || `trench row ${r.row}` });
    assert.equal(named[1].label, 'trench row 5');
    records[0].e = 99;
    assert.equal(rows[0].surveyed.e, 1, 'rows hold copies');
});

test('the Swap button: swapping the rows equals rebuilding the records with the E/N mapping swapped; keys stay', () => {
    const csv = 'Name,Easting,Northing,Elevation\nP1,512345.120,4123456.780,58.100\nP2,512350.000,4123460.500,58.900\n';
    const p = parseSurveyCsv(new TextEncoder().encode(csv));
    const mapping = autoMap(p.headers, p.rows, { hasHeader: p.hasHeader, decimal: p.decimal });
    const rows = PK.rowsFromRecords(buildRecords(p.rows, mapping, { decimal: p.decimal, headers: p.headers }).valid);
    const swappedRecords = buildRecords(p.rows, swapMappingEN(mapping), { decimal: p.decimal, headers: p.headers }).valid;
    assert.deepEqual(PK.swapRowsEN(rows), PK.rowsFromRecords(swappedRecords));
    assert.deepEqual(PK.swapRowsEN(rows).map(r => r.key), rows.map(r => r.key));
});

test('search by name or row number, case-insensitive', () => {
    const rows = PK.rowsFromRecords([
        { row: 2, name: 'BB_14', e: 0, n: 0, h: 0 }, { row: 3, name: 'Wall corner', e: 0, n: 0, h: 0 }, { row: 12, name: 'bb_15', e: 0, n: 0, h: 0 }
    ]);
    assert.deepEqual(PK.filterRows(rows, 'bb').map(r => r.csvRow), [2, 12]);
    assert.deepEqual(PK.filterRows(rows, ' CORNER ').map(r => r.csvRow), [3]);
    assert.deepEqual(PK.filterRows(rows, '12').map(r => r.csvRow), [12]);
    assert.equal(PK.filterRows(rows, '').length, 3);
});

test('session: a second pick of a row replaces it, undo walks back through every change', () => {
    const data = dataset();
    const [a, b] = data.rows.map(r => r.key);
    let s = PK.createPickingSession({ rows: data.rows, job: { tag: 'kept' } });
    assert.equal(s.job.tag, 'kept', 'other fields are kept');
    assert.equal(PK.canUndoPick(s), false);
    s = PK.selectRow(s, a);
    assert.equal(s.selectedKey, a);
    s = PK.setPick(s, a, { modelPosition: { x: 1, y: 2, z: 3 } });
    s = PK.setPick(s, b, { modelPosition: { x: 4, y: 5, z: 6 }, annotationUuid: 'u-1' });
    s = PK.setPick(s, a, { modelPosition: { x: 7, y: 8, z: 9 } });
    assert.equal(s.picks.length, 2, 'one pick per row');
    assert.deepEqual(PK.pickOf(s, a).modelPosition, { x: 7, y: 8, z: 9 });
    assert.equal(PK.pickOf(s, b).annotationUuid, 'u-1');
    assert.equal(s.selectedKey, a, 'the row stays selected, so a further tap replaces the pick again');

    s = PK.setPickEnabled(s, b, false);
    assert.equal(PK.pickOf(s, b).enabled, false);
    s = PK.setPick(s, b, { modelPosition: { x: 0, y: 0, z: 1 } });
    assert.equal(PK.pickOf(s, b).enabled, true, 're-picking enables the point again');
    s = PK.removePick(s, a);
    assert.equal(PK.pickOf(s, a), null);

    s = PK.undoPick(s);   // remove
    assert.deepEqual(PK.pickOf(s, a).modelPosition, { x: 7, y: 8, z: 9 });
    s = PK.undoPick(s);   // re-pick of b
    assert.equal(PK.pickOf(s, b).enabled, false);
    s = PK.undoPick(s);   // disable
    s = PK.undoPick(s);   // replace of a
    assert.deepEqual(PK.pickOf(s, a).modelPosition, { x: 1, y: 2, z: 3 });
    s = PK.undoPick(s);
    s = PK.undoPick(s);
    assert.equal(s.picks.length, 0);
    assert.equal(PK.undoPick(s), s, 'nothing left to undo');

    assert.equal(PK.selectRow(s, 'no-such-row').selectedKey, null);
    assert.equal(PK.setPick(s, 'no-such-row', { modelPosition: { x: 0, y: 0, z: 0 } }), s);
    assert.throws(() => PK.setPick(s, a, { modelPosition: { x: NaN, y: 0, z: 0 } }), TypeError);
    assert.equal(PK.setFitType(s, 'level4').fitType, 'level4');
    assert.equal(PK.setFitType(s, 'level4').history.length, s.history.length, 'the fit type is not an undo step');
});

test('control points come out in row order with label, CSV row, enabled flag and annotation link', () => {
    const data = dataset();
    let s = PK.createPickingSession({ rows: data.rows });
    s = PK.setPick(s, data.rows[3].key, { modelPosition: data.model[3] });
    s = PK.setPick(s, data.rows[0].key, { modelPosition: data.model[0], annotationUuid: 'ann-uuid' });
    s = PK.setPickEnabled(s, data.rows[3].key, false);
    const { controlPoints, keys } = PK.controlPointsOf(s);
    assert.deepEqual(keys, [data.rows[0].key, data.rows[3].key]);
    assert.deepEqual(controlPoints.map(cp => [cp.label, cp.csvRow, cp.enabled, cp.annotationUuid]),
        [['GCP1', 2, true, 'ann-uuid'], ['GCP4', 5, false, null]]);
    assert.deepEqual(controlPoints[0].surveyed, data.rows[0].surveyed);
});

test('live fit: fewer than 3 picks give a notice and no fit; exact picks recover the transform', () => {
    const data = dataset();
    const two = PK.evaluatePicking(pickedSession(data, { count: 2 }));
    assert.equal(two.fit, null);
    assert.equal(two.messages[0].code, ERRORS.TOO_FEW);
    assert.match(two.messages[0].text, /Pick 1 more row/);
    assert.equal(PK.canReview(two), false);

    const ev = PK.evaluatePicking(pickedSession(data));
    assert.equal(ev.fit.ok, true);
    assert.ok(ev.fit.quality.rms < 1e-6);
    assert.ok(Math.abs(ev.fit.quality.headingDeg - 37) < 1e-6);
    assert.ok(Math.abs(ev.fullTilt - 0.3) < 1e-6);
    assert.equal(ev.verdict, 'good');
    assert.match(PK.verdictText(ev), /^Good: RMS 0\.000 m from 6 points/);
    assert.equal(PK.canReview(ev), true);
    // The preview markers sit where the model points are (storage frame).
    const positions = PK.previewPositions(data.rows, ev.fit);
    positions.forEach((p, i) => {
        const expected = pointFromZUp(data.model[i]);
        assert.ok(Math.hypot(p.x - expected.x, p.y - expected.y, p.z - expected.z) < 1e-6);
    });
    assert.equal(PK.previewPositions(data.rows, null), null);
});

test('three picks: verdict at best Check, and the panel asks for a fourth', () => {
    const ev = PK.evaluatePicking(pickedSession(dataset(), { count: 3 }));
    assert.equal(ev.verdict, 'check');
    assert.ok(ev.messages.some(m => m.code === FLAGS.NO_REDUNDANCY && /fourth row/.test(m.text)));
    assert.match(PK.verdictText(ev), /^Check: .*only 3 points/);
});

test('level option: suggested on level data, never chosen by itself, and switching it changes the active fit', () => {
    const data = dataset({ tiltDeg: 0.2 });
    const s = pickedSession(data);
    const full = PK.evaluatePicking(s);
    assert.equal(full.fitType, 'rigid6');
    assert.equal(full.levelSuggested, true);
    assert.ok(full.messages.some(m => m.code === FLAGS.LEVEL_SUGGESTED));
    const level = PK.evaluatePicking(PK.setFitType(s, 'level4'));
    assert.equal(level.fit.fitType, 'level4');
    assert.equal(level.fit.quality.tiltDeg, 0);
    assert.ok(Math.abs(level.fullTilt - 0.2) < 1e-6, 'the full fit tilt is still reported');
    assert.ok(!level.messages.some(m => m.code === FLAGS.LEVEL_SUGGESTED));
    assert.notDeepEqual(PK.previewPositions(data.rows, full.fit), PK.previewPositions(data.rows, level.fit));

    const tilted = PK.evaluatePicking(pickedSession(dataset({ tiltDeg: 2 })));
    assert.equal(tilted.levelSuggested, false);
});

test('one bad pick among six is named, with a re-pick action, and shows in the review table', () => {
    const data = dataset();
    let s = pickedSession(data);
    const bad = data.rows[2].key;
    const p = data.model[2];
    s = PK.setPick(s, bad, { modelPosition: { x: p.x + 0.5, y: p.y, z: p.z } });
    const ev = PK.evaluatePicking(s);
    const msg = ev.messages.find(m => m.code === FLAGS.LOO_OUTLIER);
    assert.ok(msg, 'leave-one-out flags the pick');
    assert.match(msg.text, /^GCP3 \(row 4\) does not fit the others/);
    assert.deepEqual(msg.action, { id: 'select', label: 'Re-pick', key: bad });
    const rows = PK.reviewRows(s, ev);
    assert.deepEqual(rows.filter(r => r.outlier).map(r => r.key), [bad]);
    assert.ok(rows.every(r => r.residual && r.total !== null && r.looError !== null));

    // Disabling it: the live fit is clean again and the disabled point shows its prediction error.
    const off = PK.setPickEnabled(s, bad, false);
    const ev2 = PK.evaluatePicking(off);
    assert.equal(ev2.enabledCount, 5);
    assert.ok(ev2.fit.quality.rms < 1e-6);
    const row = PK.reviewRows(off, ev2).find(r => r.key === bad);
    assert.equal(row.enabled, false);
    assert.equal(row.looError, null);
    assert.ok(Math.abs(row.total - 0.5) < 1e-6, `prediction error ${row.total}`);
    // The review residual of a disabled point matches what createAlignment stores.
    const alignment = createAlignment({ id: 1, uuid: 'u', fit: ev2.fit, controlPoints: ev2.controlPoints });
    const stored = alignment.controlPoints[ev2.keys.indexOf(bad)].residual;
    row.residual.forEach((v, i) => assert.ok(Math.abs(v - stored[i]) < 1e-9));
});

test('swapped Easting/Northing: the message offers Swap, and swapping the rows fixes the fit', () => {
    const data = dataset();
    const swapped = { ...data, rows: PK.swapRowsEN(data.rows) };
    const s = pickedSession(swapped);
    const ev = PK.evaluatePicking(s);
    const msg = ev.messages.find(m => m.code === FLAGS.SWAPPED_EN);
    assert.ok(msg, `messages: ${ev.messages.map(m => m.code)}`);
    assert.equal(msg.action.id, 'swap');
    assert.equal(ev.verdict, 'poor');
    assert.match(PK.verdictText(ev), /^Poor:/);
    assert.ok(!ev.messages.some(m => m.code === FLAGS.FLIPPED || m.code === FLAGS.UP_AXIS), 'the swap explains the tilt');
    assert.ok(!ev.messages.some(m => m.code === FLAGS.LOO_OUTLIER || m.code === FLAGS.RESIDUAL_WARN),
        'no re-pick or residual warning for picks that are fine');
    const fixed = PK.evaluatePicking({ ...s, rows: PK.swapRowsEN(s.rows) });
    assert.ok(fixed.fit.quality.rms < 1e-6);
    assert.equal(fixed.verdict, 'good');
});

test('wrong up-axis with the level fit ticked: the full fit\'s tilt is still reported', () => {
    const data = dataset({ tiltDeg: 90 });
    const ev = PK.evaluatePicking(pickedSession(data, { fitType: 'level4' }));
    assert.equal(ev.fit.quality.tiltDeg, 0);
    const msg = ev.messages.find(m => m.code === FLAGS.UP_AXIS);
    assert.ok(msg, `messages: ${ev.messages.map(m => m.code)}`);
    assert.match(msg.text, /^The full fit would tilt the model \(tilt 90\.00°\)\. Was the wrong up-axis chosen/);
    assert.equal(ev.verdict, 'poor');
    // Not repeated for the full fit itself, and absent on a level model
    const full = PK.evaluatePicking(pickedSession(data));
    assert.equal(full.messages.filter(m => m.code === FLAGS.UP_AXIS).length, 1);
    const level = PK.evaluatePicking(pickedSession(dataset({ tiltDeg: 0.2 }), { fitType: 'level4' }));
    assert.ok(!level.messages.some(m => m.code === FLAGS.UP_AXIS || m.code === FLAGS.FLIPPED));
});

test('blocking geometry: points in a line and points bunched together are named', () => {
    const line = [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 15, y: 0, z: 0 }];
    const collinear = PK.evaluatePicking(pickedSession(dataset({ model: line })));
    assert.equal(collinear.fit.ok, false);
    assert.equal(collinear.messages[0].code, ERRORS.COLLINEAR);
    assert.equal(collinear.messages[0].level, PK.MESSAGE_LEVELS.ERROR);
    assert.equal(PK.canReview(collinear), false);
    assert.match(PK.verdictText(collinear), /^Poor/);

    const bunch = [{ x: 0, y: 0, z: 0 }, { x: 0.05, y: 0, z: 0 }, { x: 0, y: 0.05, z: 0.01 }];
    const close = PK.evaluatePicking(pickedSession(dataset({ model: bunch })));
    assert.equal(close.messages[0].code, ERRORS.COINCIDENT);
    assert.match(close.messages[0].text, /too close together/);
});

test('a model in millimetres: the scale message names the unit', () => {
    const data = dataset({ tiltDeg: 0 });
    const s = pickedSession({ ...data, model: data.model.map(p => ({ x: p.x * 1000, y: p.y * 1000, z: p.z * 1000 })) });
    const ev = PK.evaluatePicking(s);
    const msg = ev.messages.find(m => m.code === FLAGS.SCALE_ERROR);
    assert.ok(msg);
    assert.match(msg.text, /0\.0010.*The model seems to be in millimetres\./);
    assert.equal(ev.verdict, 'poor');
});

test('refine hand-off (commit 14): stored control points become rows and picks again', () => {
    const data = dataset();
    let s = pickedSession(data, { count: 5 });
    s = PK.setPickEnabled(s, data.rows[1].key, false);
    const ev = PK.evaluatePicking(s);
    const alignment = createAlignment({ id: 1, uuid: 'u', fit: ev.fit, controlPoints: ev.controlPoints });

    const rows = PK.rowsFromControlPoints(alignment.controlPoints);
    const { picks, unmatched } = PK.picksFromControlPoints(rows, alignment.controlPoints);
    assert.equal(unmatched.length, 0);
    const again = PK.createPickingSession({ rows, picks, fitType: alignment.fitType });
    const ev2 = PK.evaluatePicking(again);
    assert.equal(ev2.enabledCount, 4);
    assert.deepEqual(ev2.fit.rotation, ev.fit.rotation);

    // Matched against CSV rows instead: by CSV row and coordinates.
    const csvMatch = PK.picksFromControlPoints(data.rows, alignment.controlPoints);
    assert.deepEqual(csvMatch.picks.map(p => p.key), data.rows.slice(0, 5).map(r => r.key));
    assert.equal(csvMatch.picks[1].enabled, false);
    const moved = PK.picksFromControlPoints(PK.swapRowsEN(data.rows), alignment.controlPoints);
    assert.equal(moved.unmatched.length, 5, 'coordinates must match');
});

test('previewPositions agrees with alignment.fittedPositions for the same fit', () => {
    const data = dataset();
    const ev = PK.evaluatePicking(pickedSession(data));
    const a = createAlignment({ id: 1, uuid: 'u', fit: ev.fit, controlPoints: ev.controlPoints });
    assert.deepEqual(PK.previewPositions(data.rows, ev.fit), fittedPositions(data.rows.map(r => r.surveyed), a, { frame: 'storage' }));
});
