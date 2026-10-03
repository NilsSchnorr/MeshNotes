// tests/alignment.test.js - Survey alignments: transforms, selection, duplicates, refine, JSON-LD, merge
// (plan: Unit tests > Alignment and format)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as AL from '../js/survey/alignment.js';
import { DUPLICATE_TOLERANCE, FLAGS } from '../js/survey/rigid-fit.js';
import { pointFromZUp } from '../js/utils/coords.js';

// ---- Test data (made up) ----

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Matrix helpers written out here, independent of linalg.js.
const DEG = Math.PI / 180;
const rotX = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const rotZ = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const mul = (A, B) => A.map(row => B[0].map((_, j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const apply = (R, t, p) => R.map((row, i) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + t[i]);
const pose = (headingDeg, tiltDeg) => mul(rotZ(-headingDeg * DEG), rotX(tiltDeg * DEG));
const surveyDist = (a, b) => Math.hypot(a.e - b.e, a.n - b.n, a.h - b.h);
const modelDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const SHIFT = [512000, 4123000, 58];
const T1 = '2026-10-01T09:00:00.000Z';
const T2 = '2026-10-02T09:00:00.000Z';
const T3 = '2026-10-03T09:00:00.000Z';
const T5 = '2026-10-05T09:00:00.000Z';

// Control-point positions in the export frame, at most 6 decimals, so the
// WKT of modelPosition round-trips exactly.
const MODEL_POINTS = [
    [-8.412, 3.115, -1.204], [6.25, 7.5, 0.4], [9.125, -6.75, 1.1],
    [-5.5, -8.25, 0.2], [0.75, 0.5, 2.3], [3.333333, -2.5, -0.75]
];

let counter = 0;
const generateId = () => ++counter;
const generateUuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const IDS = { generateId, generateUuid };

function controlPointsFor({ heading = 90, tilt = 0.3, shift = SHIFT, disabled = [], offset = {} } = {}) {
    const R = pose(heading, tilt);
    return MODEL_POINTS.map((p, i) => {
        const [e, n, h] = apply(R, shift, p);
        return AL.makeControlPoint({
            label: `GCP${i + 1}`,
            csvRow: i + 2,
            enabled: !disabled.includes(i),
            modelPosition: { x: p[0], y: p[1], z: p[2] },
            surveyed: { e: e + (offset[i] || 0), n, h },
            annotationUuid: i === 0 ? 'aaaaaaaa-0000-4000-8000-000000000001' : null
        });
    });
}

function makeAlignment({ uuid, now = T1, crsLabel = 'EPSG:32635', ...cpOptions } = {}) {
    const controlPoints = controlPointsFor(cpOptions);
    const { fit } = AL.fitControlPoints(controlPoints, 'rigid6');
    return AL.createAlignment({
        generateId, uuid: uuid || generateUuid(),
        name: 'Trench 3', crsLabel, heightColumn: 'Elevation',
        modelSha256: 'abc123', modelUpAxis: 'y-up',
        fit, controlPoints,
        creator: 'Test Person', creatorOrcid: '0000-0002-1825-0097',
        now
    });
}

function surveyPoint(alignment, p, extra = {}) {
    const s = AL.exportToSurvey(alignment, p);
    return {
        alignmentId: alignment.id, e: s.e, n: s.n, h: s.h,
        raw: { e: String(s.e), n: String(s.n), h: String(s.h) },
        columns: { e: 'Easting', n: 'Northing', h: 'Elevation' },
        attributes: {},
        source: { fileName: 'trench3.csv', fileSha256: 'f00d', row: 2, importedAt: T1 },
        placement: 'fit',
        surfaceDistance: 0.01,
        ...extra
    };
}

// ---- Transforms ----

test('forward and inverse transforms round-trip within 1e-9 at UTM magnitudes', () => {
    // A northern site with a quarter-turn heading, and a southern one with a
    // northing near 1e7 and an oblique heading: there an inverse that rotates
    // before subtracting (R^T s - R^T t) misses 1e-9, subtraction first does not.
    const south = [512000, 9912000, 58];
    const cases = [[makeAlignment(), SHIFT], [makeAlignment({ heading: 37, shift: south }), south]];
    const rand = mulberry32(7);
    for (const [a, shift] of cases) {
        for (const cp of a.controlPoints) {
            assert.ok(surveyDist(AL.exportToSurvey(a, cp.modelPosition), cp.surveyed) < 1e-6);
        }
        for (let i = 0; i < 200; i++) {
            const p = { x: (rand() - 0.5) * 100, y: (rand() - 0.5) * 100, z: (rand() - 0.5) * 10 };
            const back = AL.surveyToExport(a, AL.exportToSurvey(a, p));
            assert.ok(Math.max(Math.abs(back.x - p.x), Math.abs(back.y - p.y), Math.abs(back.z - p.z)) < 1e-9);

            const s = { e: shift[0] + (rand() - 0.5) * 200, n: shift[1] + (rand() - 0.5) * 200, h: shift[2] + (rand() - 0.5) * 10 };
            const s2 = AL.exportToSurvey(a, AL.surveyToExport(a, s));
            assert.ok(Math.max(Math.abs(s2.e - s.e), Math.abs(s2.n - s.n), Math.abs(s2.h - s.h)) < 1e-9);

            // Storage wrappers: Y-up, through pointFromZUp / pointToZUp.
            const st = AL.surveyToStorage(a, s);
            assert.deepEqual(st, pointFromZUp(AL.surveyToExport(a, s)));
            const s3 = AL.storageToSurvey(a, st);
            assert.ok(Math.max(Math.abs(s3.e - s.e), Math.abs(s3.n - s.n), Math.abs(s3.h - s.h)) < 1e-9);
        }
    }
    const a = cases[0][0];
    // Arrays are accepted on both sides.
    assert.deepEqual(AL.surveyToExport(a, [SHIFT[0], SHIFT[1], SHIFT[2]]), AL.surveyToExport(a, { e: SHIFT[0], n: SHIFT[1], h: SHIFT[2] }));
});

test('the transform follows survey = R p + t, and the inverse undoes it', () => {
    // A quarter turn counter-clockwise about Z: model +X points north.
    const a = { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], translation: [500000, 4100000, 50] };
    const s = AL.exportToSurvey(a, { x: 1, y: 0, z: 0 });
    assert.ok(Math.abs(s.e - 500000) < 1e-9 && Math.abs(s.n - 4100001) < 1e-9 && Math.abs(s.h - 50) < 1e-9);
    const p = AL.surveyToExport(a, [500000.001, 4100000, 50]);
    assert.ok(Math.abs(p.x) < 1e-10 && Math.abs(p.y + 0.001) < 1e-10 && Math.abs(p.z) < 1e-10);
    assert.throws(() => AL.exportToSurvey({ rotation: [0, 0, 1], translation: [0, 0, 0] }, [0, 0, 0]), TypeError);
    assert.throws(() => AL.surveyToExport(a, { e: 1, n: NaN, h: 0 }), TypeError);
});

// ---- Creating ----

test('createAlignment copies the fit, fills residuals and sets the metadata', () => {
    const controlPoints = controlPointsFor({ disabled: [5], offset: { 5: 0.2 } });
    const { fit, indices } = AL.fitControlPoints(controlPoints, 'rigid6');
    assert.deepEqual(indices, [0, 1, 2, 3, 4]);
    const a = AL.createAlignment({
        id: 42, uuid: 'b0c2d4e6-0000-4000-8000-000000000001', name: ' Trench 3 ', crsLabel: '',
        heightColumn: 'Elevation', modelSha256: 'abc123', modelUpAxis: 'y-up',
        fit, controlPoints, creator: 'Test Person', creatorOrcid: 'https://orcid.org/0000-0002-1825-0097', now: new Date(T1)
    });
    assert.equal(a.id, 42);
    assert.equal(a.name, 'Trench 3');
    assert.equal(a.crsLabel, '');
    assert.equal(AL.crsDisplayLabel(a), 'unspecified coordinate system');
    assert.equal(a.created, T1);
    assert.equal(a.modified, T1);
    assert.equal(a.creatorOrcid, 'https://orcid.org/0000-0002-1825-0097');
    assert.deepEqual(a.versions, []);
    assert.equal(a.fitType, 'rigid6');
    assert.deepEqual(a.rotation, fit.rotation);
    assert.deepEqual(a.translation, fit.translation);
    assert.equal(a.quality.n, 5);
    assert.deepEqual(a.quality.flags, fit.quality.flags);
    assert.ok(a.quality.flags.includes(FLAGS.LEVEL_SUGGESTED));

    assert.equal(a.controlPoints.length, 6);
    assert.deepEqual(a.controlPoints[0].residual, fit.residuals[0]);
    assert.equal(a.controlPoints[0].looError, fit.looErrors[0]);
    // The disabled point gets its prediction error and no leave-one-out error.
    const r5 = a.controlPoints[5].residual;
    assert.ok(Math.abs(r5[0] - 0.2) < 1e-6 && Math.abs(r5[1]) < 1e-6 && Math.abs(r5[2]) < 1e-6);
    assert.equal(a.controlPoints[5].looError, null);
    assert.equal(a.controlPoints[5].enabled, false);

    // Without a fit it is computed; a bare ORCID iD is normalised.
    const b = AL.createAlignment({ ...IDS, controlPoints, creator: 'X', creatorOrcid: '0000-0002-1825-009x', now: T1 });
    assert.ok(Math.max(...b.rotation.map((c, i) => Math.abs(c - a.rotation[i]))) < 1e-12);
    assert.equal(b.creatorOrcid, 'https://orcid.org/0000-0002-1825-009X');
    assert.equal(typeof b.uuid, 'string');

    // Copies: later edits of the session's control points leave the alignment alone.
    const before = a.controlPoints[0].surveyed.e;
    controlPoints[0].surveyed.e += 10;
    assert.equal(a.controlPoints[0].surveyed.e, before);

    assert.throws(() => AL.createAlignment({ ...IDS, controlPoints: controlPoints.slice(0, 2) }), RangeError);
    const allEnabled = controlPointsFor();
    assert.throws(() => AL.createAlignment({ ...IDS, fit, controlPoints: allEnabled }), RangeError);
    assert.throws(() => AL.createAlignment({ uuid: 'u', controlPoints: allEnabled }), TypeError);
});

// ---- Selection step ----

// The model surface: a 20 x 20 m patch at z = 0 in the export frame.
const patchDistance = (p) => Math.hypot(Math.max(Math.abs(p.x) - 10, 0), Math.max(Math.abs(p.y) - 10, 0), p.z);

const SPOTS = [
    ['A', [0, 0, 0.02]], ['B', [5, 5, -0.1]], ['C', [-8, 3, 0.3]], ['D', [2, -9, 0.49]],
    ['E', [3, 3, 0.6]], ['F', [30, 0, 0]], ['G', [0, 0, 2]]
];

function spotRecords(a) {
    return SPOTS.map(([name, [x, y, z]], i) => ({ row: i + 2, name, ...AL.exportToSurvey(a, { x, y, z }) }));
}

const names = (classification, pick = () => true) => classification.rows.filter(pick).map(r => r.record.name);

test('the row classification ticks the rows within the limit, nearest first', () => {
    const a = makeAlignment();
    const records = spotRecords(a);
    const distances = AL.fittedPositions(records, a).map(patchDistance);
    const c = AL.classifyByDistance(records, distances, { limit: 0.5 });
    assert.deepEqual(names(c), ['A', 'B', 'C', 'D', 'E', 'G', 'F']);
    assert.deepEqual(names(c, r => r.ticked), ['A', 'B', 'C', 'D']);
    assert.equal(c.onModelCount, 4);
    assert.equal(c.total, 7);
    assert.ok(Math.abs(c.rows[0].distance - 0.02) < 1e-9);
    assert.equal(c.rows[0].index, 0);
    assert.equal(c.rows[0].method, AL.SELECTION_METHODS.SURFACE);

    const wider = AL.classifyByDistance(records, distances, { limit: 1 });
    assert.deepEqual(names(wider, r => r.ticked), ['A', 'B', 'C', 'D', 'E']);
    // Exactly on the limit counts as within it, above or below.
    for (const d of [0.5, -0.5]) {
        const edge = distances.slice();
        edge[4] = d;
        assert.deepEqual(names(AL.classifyByDistance(records, edge, { limit: 0.5 }), r => r.ticked), ['A', 'B', 'C', 'D', 'E']);
    }

    // Signed distances (above/below): the magnitude decides.
    const signed = AL.fittedPositions(records, a).map(p => (p.z < 0 ? -1 : 1) * patchDistance(p));
    const cs = AL.classifyByDistance(records, signed, { limit: 0.5 });
    assert.deepEqual(names(cs), names(c));
    assert.deepEqual(names(cs, r => r.ticked), ['A', 'B', 'C', 'D']);
    assert.ok(Math.abs(cs.rows[1].distance + 0.1) < 1e-9);
    const below = signed.slice();
    below[4] = -0.6;
    assert.equal(AL.classifyByDistance(records, below, { limit: 0.5 }).onModelCount, 4);

    // Nothing found within the search radius sorts last and is never ticked.
    const far = distances.slice();
    far[0] = Infinity;
    const cf = AL.classifyByDistance(records, far, { limit: 0.5 });
    assert.equal(cf.rows[6].record.name, 'A');
    assert.equal(cf.rows[6].ticked, false);

    const storage = AL.fittedPositions(records, a, { frame: 'storage' });
    assert.deepEqual(storage[0], pointFromZUp(AL.fittedPositions(records, a)[0]));
    assert.throws(() => AL.classifyByDistance(records, distances.slice(1)), RangeError);
});

test('the row classification ticks none when the data is shifted by 1 km, and detects that a swap would fit', () => {
    const a = makeAlignment();
    const records = spotRecords(a);
    const measure = (recs, opts) => AL.classifyByDistance(recs, AL.fittedPositions(recs, a, opts).map(patchDistance));

    const shifted = records.map(r => ({ ...r, e: r.e + 1000 }));
    const cs = measure(shifted);
    assert.equal(cs.onModelCount, 0);
    assert.equal(cs.rows.filter(r => r.ticked).length, 0);
    assert.equal(AL.swapWouldFit(cs, measure(shifted, { swapEN: true })), false);

    // A CSV with Easting and Northing exchanged.
    const swapped = records.map(r => ({ ...r, e: r.n, n: r.e }));
    const cw = measure(swapped);
    assert.equal(cw.onModelCount, 0);
    const trial = measure(swapped, { swapEN: true });
    assert.equal(trial.onModelCount, 4);
    assert.equal(AL.swapWouldFit(cw, trial), true);
    // Rows already on the model: no swap offered.
    assert.equal(AL.swapWouldFit(measure(records), trial), false);
});

test('without surface distances the bounding box decides', () => {
    const a = makeAlignment();
    const records = spotRecords(a);
    const positions = AL.fittedPositions(records, a);
    const distances = records.map(() => null);
    // Corners in any order.
    const box = { min: { x: 10, y: 10, z: 1 }, max: { x: -10, y: -10, z: -1 } };
    const c = AL.classifyByDistance(records, distances, { limit: 0.5, positions, box });
    assert.deepEqual(names(c, r => r.ticked), ['A', 'B', 'C', 'D', 'E']);
    assert.ok(c.rows.every(r => r.method === AL.SELECTION_METHODS.BOX && r.distance === null));
    assert.deepEqual(names(c).slice(5), ['G', 'F']);
    const g = c.rows.find(r => r.record.name === 'G');
    assert.ok(Math.abs(g.boxDistance - 1) < 1e-9);
    assert.equal(AL.classifyByDistance(records, distances, { limit: 1, positions, box }).onModelCount, 6);
    // Exactly on the limit counts as within it.
    const edge = positions.slice();
    edge[5] = { x: 10.5, y: 0, z: 0 };
    const ce = AL.classifyByDistance(records, distances, { limit: 0.5, positions: edge, box });
    assert.equal(ce.rows.find(r => r.record.name === 'F').boxDistance, 0.5);
    assert.equal(ce.onModelCount, 6);

    const none = AL.classifyByDistance(records, distances);
    assert.equal(none.onModelCount, 0);
    assert.ok(none.rows.every(r => r.method === AL.SELECTION_METHODS.NONE));
});

// ---- Duplicates ----

test('the duplicate rules', () => {
    const at = (e, n, h) => ({ e, n, h });
    const base = at(512000, 4123000, 58);
    const annotations = [
        { uuid: 'a1', name: 'GCP1', survey: { alignmentId: 7, ...base, source: { fileSha256: 'abc', row: 2 } } },
        { uuid: 'a2', name: 'GCP2', survey: { alignmentId: 7, ...at(512010, 4123000, 58), source: { fileSha256: 'other', row: 5 } } },
        { uuid: 'a3', name: 'GCP9', survey: { alignmentId: 8, ...at(512050, 4123000, 58), source: { fileSha256: 'abc', row: 7 } } },
        { uuid: 'a4', name: 'GCP3', type: 'point', points: [{ x: 0, y: 0, z: 0 }] }
    ];
    const candidates = [
        { row: 2, name: 'GCP1', ...base },                                // same file and row
        { row: 3, name: 'GCP2', ...at(512010.0005, 4123000, 58) },        // same name, 0.5 mm away
        { row: 4, name: 'GCP2', ...at(512010.05, 4123000, 58) },          // same name, 5 cm away
        { row: 5, name: 'GCP3', ...at(512020, 4123000, 58) },             // flagged: the name of a4 (hand-made; a2 is another file)
        { row: 6, name: 'GCP3', ...at(512020, 4123000, 58.0004) },        // repeats row 5 of this batch
        { row: 7, name: 'GCP9', ...at(512050, 4123000, 58) },             // flagged, not skipped: a3 belongs to another alignment
        { row: 8, name: 'GCP4', ...at(512000.0009, 4123000, 58) },        // close to a1 but another name
        { row: 9, name: 'GCP1', ...at(512000 + 1.5 * DUPLICATE_TOLERANCE, 4123000, 58) },  // just over the tolerance
        { row: 10, name: 'GCP2', ...at(512010, 4123000, 58.05) },         // same name and E/N, 5 cm higher
        { row: 11, name: 'GCP1', ...at(512000, 4123000, 58.0005) },       // same name, 0.5 mm higher
        { row: 12, name: 'GCP5', ...at(512030, 4123000, 58) }             // new
    ];
    const result = AL.checkDuplicates(candidates, annotations, { alignmentId: 7, fileSha256: 'abc' });
    const S = AL.DUPLICATE_STATUS, R = AL.DUPLICATE_REASONS;
    assert.deepEqual(result.map(r => r.status), [
        S.DUPLICATE, S.DUPLICATE, S.NAME_CONFLICT, S.NAME_CONFLICT, S.DUPLICATE, S.NAME_CONFLICT,
        S.NEW, S.NAME_CONFLICT, S.NAME_CONFLICT, S.DUPLICATE, S.NEW
    ]);
    assert.deepEqual(result.map(r => r.reason), [
        R.SAME_ROW, R.SAME_NAME_POSITION, R.SAME_NAME, R.SAME_NAME_OTHER, R.SAME_NAME_POSITION, R.SAME_NAME_OTHER,
        null, R.SAME_NAME, R.SAME_NAME, R.SAME_NAME_POSITION, null
    ]);
    assert.deepEqual(result[0].match, { uuid: 'a1', index: null });
    assert.deepEqual(result[1].match, { uuid: 'a2', index: null });
    assert.deepEqual(result[3].match, { uuid: 'a4', index: null });
    assert.deepEqual(result[4].match, { uuid: null, index: 3 });
    assert.deepEqual(result[5].match, { uuid: 'a3', index: null });
    assert.equal(result[6].match, null);
    assert.deepEqual(result[8].match, { uuid: 'a2', index: null });
    assert.deepEqual(result[9].match, { uuid: 'a1', index: null });

    // The same file imported again into another alignment is not a duplicate,
    // only a name collision.
    const other = AL.checkDuplicates([candidates[0]], annotations, { alignmentId: 9, fileSha256: 'abc' });
    assert.equal(other[0].status, S.NAME_CONFLICT);
    assert.equal(other[0].reason, R.SAME_NAME_OTHER);
});

// ---- Refine and re-align ----

test('a refine keeps the old fit in the history, skips hand-moved points and returns displacement figures', () => {
    const a = makeAlignment({ now: T1 });
    const b = AL.refineAlignment(a, { controlPoints: controlPointsFor({ heading: 90.2 }), now: T2 });
    assert.equal(b.id, a.id);
    assert.equal(b.uuid, a.uuid);
    assert.equal(b.name, a.name);
    assert.equal(b.created, T1);
    assert.equal(b.modified, T2);
    assert.notDeepEqual(b.rotation, a.rotation);
    assert.equal(b.versions.length, 1);
    assert.deepEqual(b.versions[0].rotation, a.rotation);
    assert.deepEqual(b.versions[0].translation, a.translation);
    assert.deepEqual(b.versions[0].controlPoints, a.controlPoints);
    assert.equal(b.versions[0].created, T1);
    assert.equal(b.versions[0].modified, T2);
    assert.deepEqual(a.versions, []);   // the input is unchanged
    assert.equal(a.modified, T1);

    const fitA = { uuid: 'p1', type: 'point', survey: surveyPoint(a, { x: 8, y: 6, z: 0 }) };
    const fitB = { uuid: 'p2', type: 'point', survey: surveyPoint(a, { x: -4, y: 2, z: 0.5 }) };
    const fitC = { uuid: 'p6', type: 'point', survey: surveyPoint(a, { x: 60, y: 45, z: 0 }) };
    const moved = { uuid: 'p3', type: 'point', survey: surveyPoint(a, { x: 1, y: 1, z: 0 }, { placement: 'manual' }) };
    const otherAlignment = { uuid: 'p4', type: 'point', survey: { ...surveyPoint(a, { x: 2, y: 2, z: 0 }), alignmentId: -1 } };
    const plain = { uuid: 'p5', type: 'point', points: [{ x: 0, y: 0, z: 0 }] };
    const before = JSON.stringify([fitA, fitB, fitC, moved]);

    const plan = AL.planRefinePlacement([fitA, fitB, moved, fitC, otherAlignment, plain], a, b);
    assert.equal(plan.count, 3);
    assert.equal(plan.manualCount, 1);
    assert.equal(plan.manual[0], moved);
    assert.deepEqual(plan.moves.map(m => m.annotation), [fitA, fitB, fitC]);
    const expected = [fitA, fitB, fitC].map(ann => modelDist(AL.surveyToExport(b, ann.survey), AL.surveyToExport(a, ann.survey)));
    plan.moves.forEach((m, i) => {
        assert.ok(Math.abs(m.displacement - expected[i]) < 1e-12);
        assert.ok(modelDist(m.from, AL.surveyToStorage(a, m.annotation.survey)) < 1e-12);
        assert.ok(modelDist(m.to, AL.surveyToStorage(b, m.annotation.survey)) < 1e-12);
    });
    // A 0.2 degree turn moves points about 10 m from the centre by a few centimetres.
    assert.ok(expected[0] > 0.01 && expected[0] < 0.1);
    assert.equal(plan.maxDisplacement, expected[2]);
    // Skewed figures: the median is the middle one (fitA), well below the mean.
    assert.ok(expected[1] < expected[0] && expected[0] < expected[2]);
    assert.equal(plan.medianDisplacement, expected[0]);
    assert.ok(plan.medianDisplacement < 0.5 * (expected[0] + expected[1] + expected[2]) / 3);
    assert.equal(JSON.stringify([fitA, fitB, fitC, moved]), before);   // nothing was moved

    // Re-align from scratch, now level-only: a second version spanning T2 to T3.
    const c = AL.realignAlignment(b, { controlPoints: controlPointsFor({ tilt: 0 }), fitType: 'level4', now: T3 });
    assert.equal(c.fitType, 'level4');
    assert.equal(c.versions.length, 2);
    assert.deepEqual(c.versions[1].rotation, b.rotation);
    assert.equal(c.versions[1].created, T2);
    assert.equal(c.versions[1].modified, T3);

    // The binding follows the current model; an unknown hash keeps the old one.
    assert.equal(AL.refineAlignment(a, { controlPoints: controlPointsFor(), modelSha256: null, now: T2 }).modelSha256, 'abc123');
    assert.equal(AL.refineAlignment(a, { controlPoints: controlPointsFor(), modelSha256: 'def456', now: T2 }).modelSha256, 'def456');
    assert.throws(() => AL.refineAlignment(a, { controlPoints: [], now: T2 }), RangeError);
});

test('metadata edits, detaching and deleting', () => {
    const a = makeAlignment({ now: T1 });
    assert.equal(AL.editAlignmentMetadata(a, { name: 'Trench 3', now: T2 }), a);
    const renamed = AL.editAlignmentMetadata(a, { name: ' Trench 3 north ', crsLabel: 'EPSG:32635 ', now: T2 });
    assert.equal(renamed.name, 'Trench 3 north');
    assert.equal(renamed.modified, T2);
    assert.equal(a.name, 'Trench 3');

    const p1 = { uuid: 'p1', survey: surveyPoint(a, { x: 1, y: 2, z: 0 }) };
    const p2 = { uuid: 'p2', survey: surveyPoint(a, { x: 3, y: 2, z: 0 }) };
    const p3 = { uuid: 'p3', survey: { ...surveyPoint(a, { x: 3, y: 2, z: 0 }), alignmentId: 99 } };
    const plain = { uuid: 'p4' };
    assert.deepEqual(AL.surveyPointsOf([p1, p2, p3, plain], a.id), [p1, p2]);
    const counts = AL.countSurveyPoints([p1, p2, p3, plain]);
    assert.equal(counts.get(a.id), 2);
    assert.equal(counts.get(99), 1);

    const detached = AL.detachSurvey(p1.survey);
    assert.equal(detached.alignmentId, null);
    assert.equal(detached.e, p1.survey.e);
    assert.deepEqual(detached.raw, p1.survey.raw);
    assert.equal(p1.survey.alignmentId, a.id);
    assert.notEqual(detached.source, p1.survey.source);

    const other = makeAlignment();
    assert.deepEqual(AL.removeAlignment([a, other], a.id, a.id), { alignments: [other], defaultAlignmentId: null });
    assert.deepEqual(AL.removeAlignment([a, other], a.id, other.id), { alignments: [other], defaultAlignmentId: other.id });
});

// ---- Binding and labels ----

test('binding warnings ignore an unknown model hash', () => {
    const a = makeAlignment();
    assert.equal(AL.modelHashStatus(a, null), 'unknown');
    assert.equal(AL.modelHashStatus(a, 'ABC123'), 'match');
    assert.equal(AL.modelHashStatus(a, 'fff'), 'mismatch');
    assert.equal(AL.modelHashStatus({ ...a, modelSha256: null }, 'fff'), 'unknown');

    assert.deepEqual(AL.bindingWarnings(a, { modelHash: null, modelUpAxis: 'y-up' }), []);
    assert.deepEqual(AL.bindingWarnings(a, { modelHash: 'abc123', modelUpAxis: 'y-up' }), []);
    assert.deepEqual(AL.bindingWarnings(a, { modelHash: 'fff', modelUpAxis: 'y-up' }).map(w => w.code), [AL.BINDING_WARNINGS.MODEL_HASH]);
    const axis = AL.bindingWarnings(a, { modelHash: null, modelUpAxis: 'z-up' });
    assert.deepEqual(axis.map(w => w.code), [AL.BINDING_WARNINGS.UP_AXIS]);
    assert.match(axis[0].message, /Y-up.*Z-up/);
    assert.deepEqual(AL.bindingWarnings({ ...a, modelSha256: null, modelUpAxis: null }, { modelHash: 'fff', modelUpAxis: 'z-up' }), []);

    assert.equal(AL.crsDisplayLabel(''), 'unspecified coordinate system');
    assert.equal(AL.crsDisplayLabel('   '), AL.UNSPECIFIED_CRS);
    assert.equal(AL.crsDisplayLabel({ crsLabel: 'EPSG:32635' }), 'EPSG:32635');
    assert.equal(AL.crsDisplayLabel(null), AL.UNSPECIFIED_CRS);
});

// ---- JSON-LD ----

// The plan's 39 new terms plus the reused rotation and unit.
const NEW_TERMS = new Set([
    'SurveyAlignment', 'SurveyedPosition', 'alignments', 'defaultAlignment', 'frameOrigin', 'crsLabel',
    'heightColumn', 'modelSha256', 'modelUpAxis', 'fitType', 'translation', 'quality', 'controlPointCount',
    'rms', 'rmsHorizontal', 'rmsVertical', 'maxResidual', 'scaleDiagnostic', 'tiltDeg', 'headingDeg',
    'controlPoints', 'enabled', 'modelPosition', 'residual', 'looError', 'alignmentVersions',
    'surveyedPosition', 'alignment', 'easting', 'northing', 'height', 'rawValues', 'attributes',
    'placement', 'surfaceDistance', 'row', 'locked', 'labelsVisible', 'collapsed', 'rotation', 'unit'
]);
const OTHER_KEYS = new Set(['id', 'type', 'name', 'created', 'modified', 'creator', 'schema:name', 'schema:sha256', 'dcterms:source']);

// Every key and meshnotes: type value is a known term; header names inside
// rawValues and attributes are data and are not checked.
function assertKnownTerms(node) {
    if (Array.isArray(node)) { node.forEach(assertKnownTerms); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('meshnotes:')) assert.ok(NEW_TERMS.has(key.slice(10)), `unknown term ${key}`);
        else assert.ok(OTHER_KEYS.has(key), `unexpected key ${key}`);
        if (key === 'type' && value.startsWith('meshnotes:')) assert.ok(NEW_TERMS.has(value.slice(10)), `unknown type ${value}`);
        if (key !== 'meshnotes:rawValues' && key !== 'meshnotes:attributes') assertKnownTerms(value);
    }
}

const roundTrip = (x) => JSON.parse(JSON.stringify(x));

test('an alignment survives export and import unchanged, with list order kept', () => {
    const a0 = makeAlignment({ disabled: [5], offset: { 5: 0.2 }, now: T1 });
    const a1 = AL.refineAlignment(a0, { controlPoints: controlPointsFor({ heading: 90.1, disabled: [2] }), now: T2 });
    const a = AL.refineAlignment(a1, { controlPoints: controlPointsFor({ heading: 90.2 }), now: T3 });
    const b = makeAlignment({ crsLabel: '', heading: 30, now: T3 });
    const json = roundTrip(AL.alignmentsToJsonLd([a, b], a.id));

    const node = json['meshnotes:alignments'][0];
    assert.equal(node.id, `urn:meshnotes:alignment:${a.uuid}`);
    assert.equal(node.type, 'meshnotes:SurveyAlignment');
    assert.equal(json['meshnotes:defaultAlignment'], `urn:meshnotes:alignment:${a.uuid}`);
    assert.deepEqual(node['meshnotes:rotation'], a.rotation);
    assert.deepEqual(node['meshnotes:translation'], a.translation);
    assert.equal(node['meshnotes:controlPoints'][0]['meshnotes:modelPosition'], 'POINT Z (-8.412 3.115 -1.204)');
    assert.deepEqual(node['meshnotes:controlPoints'][0]['dcterms:source'], { id: 'urn:meshnotes:annotation:aaaaaaaa-0000-4000-8000-000000000001' });
    assert.equal(node['meshnotes:controlPoints'][0]['meshnotes:row'], 2);
    assert.deepEqual(node.creator, { type: 'Person', name: 'Test Person', id: 'https://orcid.org/0000-0002-1825-0097' });
    assert.equal('flags' in node['meshnotes:quality'], false);
    assert.deepEqual(node['meshnotes:alignmentVersions'].map(v => v.modified), [T2, T3]);
    assert.equal('meshnotes:crsLabel' in json['meshnotes:alignments'][1], false);
    assertKnownTerms(json);

    const read = AL.alignmentsFromJsonLd(json, IDS);
    assert.equal(read.alignments.length, 2);
    assert.deepEqual(read.skipped, []);
    assert.equal(read.defaultAlignmentUuid, a.uuid);
    assert.equal(read.idMap[a.uuid], read.alignments[0].id);
    assert.notEqual(read.alignments[0].id, a.id);
    // Everything but the session id comes back, flags included (recomputed).
    assert.deepEqual({ ...read.alignments[0], id: a.id }, a);
    assert.deepEqual({ ...read.alignments[1], id: b.id }, b);
    assert.deepEqual(read.alignments[0].controlPoints.map(cp => cp.label), ['GCP1', 'GCP2', 'GCP3', 'GCP4', 'GCP5', 'GCP6']);

    // modelPosition goes through WKT with 6 decimals.
    const odd = { ...b, controlPoints: b.controlPoints.map((cp, i) => (i ? cp : { ...cp, modelPosition: { x: 1.23456789, y: -2.000000444, z: 0 } })) };
    const back = AL.alignmentFromJsonLd(roundTrip(AL.alignmentToJsonLd(odd)), IDS);
    assert.ok(modelDist(back.controlPoints[0].modelPosition, odd.controlPoints[0].modelPosition) < 1e-6);
});

test('a surveyed position and the lock survive export and import unchanged', () => {
    const a = makeAlignment();
    const survey = {
        alignmentId: a.id,
        e: 512345.123, n: 4123456.789, h: 62.345,
        raw: { e: '512345,123', n: '4123456,789', h: '62,345' },
        columns: { e: 'Rechtswert', n: 'Hochwert', h: 'Höhe' },
        attributes: { Code: 'GCP', 'Solution status': 'FIX' },
        source: { fileName: 'trench3.csv', fileSha256: '9f2c', row: 12, importedAt: T1 },
        placement: 'manual',
        surfaceDistance: -0.023
    };
    const ann = { uuid: 'p1', type: 'point', locked: true, survey };
    const members = roundTrip(AL.annotationSurveyToJsonLd(ann, [a]));
    const sp = members['meshnotes:surveyedPosition'];
    assert.equal(members['meshnotes:locked'], true);
    assert.equal(sp.type, 'meshnotes:SurveyedPosition');
    assert.equal(sp['meshnotes:alignment'], `urn:meshnotes:alignment:${a.uuid}`);
    assert.deepEqual(Object.keys(sp['meshnotes:rawValues']), ['Rechtswert', 'Hochwert', 'Höhe']);
    assert.deepEqual(sp['dcterms:source'], { 'schema:name': 'trench3.csv', 'schema:sha256': '9f2c', 'meshnotes:row': 12 });
    assertKnownTerms(members);

    const w3cAnn = { type: 'Annotation', created: T1, annotationType: 'point', ...members };
    const read = AL.annotationSurveyFromJsonLd(w3cAnn, { alignmentIdMap: { [a.uuid]: a.id } });
    assert.deepEqual(read, { locked: true, survey });

    // Columns are found by value when the keys come back in another order,
    // also for integer-like header names, which JSON objects move to the front.
    const reordered = { ...sp, 'meshnotes:rawValues': { 'Höhe': '62,345', 'Hochwert': '4123456,789', 'Rechtswert': '512345,123' } };
    assert.deepEqual(AL.surveyedPositionFromJsonLd(reordered).columns, survey.columns);
    const numeric = { ...sp, 'meshnotes:rawValues': roundTrip({ 2: '512345.123', 1: '4123456.789', 3: '62.345' }) };
    assert.deepEqual(AL.surveyedPositionFromJsonLd(numeric).columns, { e: '2', n: '1', h: '3' });
    // Unreadable cells fall back to the key order.
    const text = { ...sp, 'meshnotes:rawValues': { A: 'x', B: 'y', C: 'z' } };
    assert.deepEqual(AL.surveyedPositionFromJsonLd(text).columns, { e: 'A', n: 'B', h: 'C' });

    // A detached point without a surface distance and without the lock.
    const loose = { uuid: 'p2', survey: { ...survey, alignmentId: null, surfaceDistance: null, placement: 'fit' } };
    const looseJson = roundTrip(AL.annotationSurveyToJsonLd(loose, [a]));
    assert.equal('meshnotes:locked' in looseJson, false);
    assert.equal('meshnotes:alignment' in looseJson['meshnotes:surveyedPosition'], false);
    assert.deepEqual(AL.annotationSurveyFromJsonLd({ created: T1, ...looseJson }), { locked: false, survey: loose.survey });
});

test('a v1.5 file parses with no alignments, and unknown properties are ignored', () => {
    const v15 = {
        '@context': ['http://www.w3.org/ns/anno.jsonld', 'https://meshnotes.org/ns/context-v1.jsonld'],
        type: 'AnnotationCollection',
        'meshnotes:groups': [{ id: 1, 'meshnotes:uuid': 'g1', 'schema:name': 'Default' }],
        first: { type: 'AnnotationPage', items: [{ type: 'Annotation', created: T1, annotationType: 'point' }] }
    };
    assert.deepEqual(AL.alignmentsFromJsonLd(v15, IDS), { alignments: [], idMap: Object.create(null), defaultAlignmentUuid: null, skipped: [] });
    assert.deepEqual(AL.annotationSurveyFromJsonLd(v15.first.items[0]), { locked: false, survey: null });
    assert.deepEqual(AL.alignmentsToJsonLd([], null), {});
    assert.deepEqual(AL.annotationSurveyToJsonLd({ type: 'point' }), {});

    // Unknown members at every level change nothing.
    const a = AL.refineAlignment(makeAlignment(), { controlPoints: controlPointsFor({ heading: 91 }), now: T2 });
    const json = roundTrip(AL.alignmentToJsonLd(a));
    json['meshnotes:futureTerm'] = { deep: [1, 2] };
    json.foo = 'bar';
    json['meshnotes:quality']['meshnotes:flags'] = ['SOMETHING'];
    json['meshnotes:controlPoints'][1]['meshnotes:colour'] = 'red';
    json['meshnotes:alignmentVersions'][0]['meshnotes:note'] = 'x';
    assert.deepEqual({ ...AL.alignmentFromJsonLd(json, IDS), id: a.id }, a);

    const survey = surveyPoint(a, { x: 1, y: 2, z: 0 });
    const sp = roundTrip(AL.surveyedPositionToJsonLd(survey, [a]));
    sp['meshnotes:accuracy'] = 0.01;
    sp['dcterms:source'].extra = true;
    assert.deepEqual(AL.surveyedPositionFromJsonLd(sp, { alignmentIdMap: { [a.uuid]: a.id }, importedAt: T1 }), survey);

    // Unusable alignment nodes are skipped and reported.
    const mixed = { 'meshnotes:alignments': [{ id: 'urn:meshnotes:alignment:x', 'meshnotes:rotation': [0, 0, 1] }, 'junk', json] };
    const read = AL.alignmentsFromJsonLd(mixed, IDS);
    assert.equal(read.alignments.length, 1);
    assert.deepEqual(read.skipped, [{ index: 0 }, { index: 1 }]);
    assert.equal(AL.surveyedPositionFromJsonLd({ 'meshnotes:easting': 1, 'meshnotes:northing': 2 }), null);
});

// ---- Merge ----

test('alignments merge by UUID, and survey points follow the newer alignment', () => {
    const U1 = '11111111-0000-4000-8000-000000000001';
    const U2 = '22222222-0000-4000-8000-000000000002';
    const U3 = '33333333-0000-4000-8000-000000000003';
    // Local session.
    const localA = makeAlignment({ uuid: U1, now: T1 });
    const localB = makeAlignment({ uuid: U2, heading: 45, now: T5 });
    const localList = [localA, localB];
    const localSnapshot = JSON.stringify(localList);
    // Another session: U1 refined later, an older copy of U2, and a new U3.
    const remoteA = AL.refineAlignment({ ...localA, id: 501 }, { controlPoints: controlPointsFor({ heading: 90.3 }), now: T2 });
    const remoteB = { ...localB, id: 502, modified: T3, name: 'Old name' };
    const remoteC = makeAlignment({ uuid: U3, heading: 10, now: T3 });
    const file = roundTrip(AL.alignmentsToJsonLd([remoteA, remoteB, remoteC], remoteC.id));

    const read = AL.alignmentsFromJsonLd(file, IDS);
    const merge = AL.mergeAlignments(localList, read.alignments);
    assert.deepEqual(merge.replaced, [U1]);
    assert.deepEqual(merge.kept, [U2]);
    assert.deepEqual(merge.added, [U3]);
    assert.equal(merge.alignments.length, 3);
    assert.equal(merge.alignments[0].id, localA.id);            // the local id stays
    assert.deepEqual(merge.alignments[0].rotation, remoteA.rotation);
    assert.equal(merge.alignments[0].versions.length, 1);
    assert.equal(merge.alignments[1], localB);                  // local copy kept as is
    assert.equal(merge.alignments[2].uuid, U3);
    assert.equal(merge.idMap[U1], localA.id);
    assert.equal(merge.idMap[U2], localB.id);
    assert.equal(merge.idMap[U3], read.idMap[U3]);
    assert.equal(AL.resolveAlignmentRef(file['meshnotes:defaultAlignment'], merge.idMap), read.idMap[U3]);
    assert.equal(JSON.stringify(localList), localSnapshot);     // inputs unchanged

    // Survey points present in both sessions.
    const spot = { x: 4, y: -3, z: 0 };
    const localPoint = { uuid: 'p1', survey: surveyPoint(localA, spot) };
    const remotePoint = { uuid: 'p1', created: T1, ...AL.annotationSurveyToJsonLd({ locked: true, survey: surveyPoint(remoteA, spot) }, [remoteA, remoteB, remoteC]) };
    const imported = AL.annotationSurveyFromJsonLd(remotePoint, { alignmentIdMap: merge.idMap });
    assert.equal(imported.survey.alignmentId, localA.id);
    assert.equal(AL.surveyPointMergeSource(localPoint, imported, merge), AL.MERGE_SOURCE.IMPORTED);

    const localPointB = { uuid: 'p2', survey: surveyPoint(localB, spot) };
    const remotePointB = { uuid: 'p2', survey: { ...surveyPoint(localB, spot), alignmentId: localB.id } };
    assert.equal(AL.surveyPointMergeSource(localPointB, remotePointB, merge), AL.MERGE_SOURCE.LOCAL);

    // Hand-moved wins (decided by Nils): a hand-moved copy falls back to the entries rule.
    const manualLocal = { ...localPoint, survey: { ...localPoint.survey, placement: 'manual' } };
    assert.equal(AL.surveyPointMergeSource(manualLocal, imported, merge), AL.MERGE_SOURCE.ENTRIES);
    const manualImported = { survey: { ...imported.survey, placement: 'manual' } };
    assert.equal(AL.surveyPointMergeSource(localPoint, manualImported, merge), AL.MERGE_SOURCE.ENTRIES);
    // No alignment rule: not both survey points, or different alignments.
    assert.equal(AL.surveyPointMergeSource({ uuid: 'p1' }, imported, merge), AL.MERGE_SOURCE.ENTRIES);
    assert.equal(AL.surveyPointMergeSource(localPoint, remotePointB, merge), AL.MERGE_SOURCE.ENTRIES);
});

test('a merge tie keeps the local copy, and version histories are united', () => {
    const a = makeAlignment({ now: T1 });
    const tie = AL.mergeAlignments([a], [{ ...a, id: 900, name: 'Other' }]);
    assert.deepEqual(tie.kept, [a.uuid]);
    assert.equal(tie.alignments[0], a);

    const v1 = AL.refineAlignment(a, { controlPoints: controlPointsFor({ heading: 90.1 }), now: T2 });
    const v2 = AL.refineAlignment(v1, { controlPoints: controlPointsFor({ heading: 90.2 }), now: T3 });
    // Imported newer with a longer history: replaced, history from both.
    const newer = AL.mergeAlignments([v1], [{ ...v2, id: 901 }]);
    assert.deepEqual(newer.replaced, [a.uuid]);
    assert.equal(newer.alignments[0].id, v1.id);
    assert.deepEqual(newer.alignments[0].versions.map(v => v.modified), [T2, T3]);
    // Local newer, imported holds a version the local copy lacks: kept, history united.
    const early = AL.refineAlignment({ ...a, created: '2026-09-01T00:00:00.000Z' },
        { controlPoints: controlPointsFor({ heading: 89.5 }), now: '2026-09-02T00:00:00.000Z' });
    const forked = { ...a, id: 902, modified: T1, versions: early.versions.map(v => ({ ...v, rotation: early.rotation, translation: early.translation })) };
    const kept = AL.mergeAlignments([v2], [forked]);
    assert.deepEqual(kept.kept, [a.uuid]);
    assert.deepEqual(kept.alignments[0].rotation, v2.rotation);
    assert.deepEqual(kept.alignments[0].versions.map(v => v.modified), ['2026-09-02T00:00:00.000Z', T2, T3]);
    assert.equal(v2.versions.length, 2);   // the input is unchanged

    // Two sessions refine the same fit separately (local at T2, remote at T3):
    // the shared original fit is listed once, and the losing local fit is kept.
    const remote = AL.refineAlignment(a, { controlPoints: controlPointsFor({ heading: 89.8 }), now: T3 });
    const fork = AL.mergeAlignments([v1], [{ ...remote, id: 903 }]);
    assert.deepEqual(fork.replaced, [a.uuid]);
    assert.deepEqual(fork.alignments[0].rotation, remote.rotation);
    const history = fork.alignments[0].versions;
    assert.deepEqual(history.map(v => v.rotation), [a.rotation, v1.rotation]);
    assert.deepEqual(history.map(v => [v.created, v.modified]), [[T1, T2], [T2, T3]]);
    // Local wins: the losing remote fit goes into the local history.
    const back = AL.mergeAlignments([{ ...remote, modified: T5 }], [v1]);
    assert.deepEqual(back.kept, [a.uuid]);
    assert.deepEqual(back.alignments[0].versions.map(v => v.rotation), [a.rotation, v1.rotation]);
    assert.equal(back.alignments[0].versions[1].modified, T5);
    // The same fit on both sides adds nothing.
    assert.equal(AL.mergeAlignments([v1], [{ ...v1, id: 904, name: 'Renamed', modified: T3 }]).alignments[0].versions.length, 1);
});
