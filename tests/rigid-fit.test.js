// tests/rigid-fit.test.js - Rigid control-point fit and its checks (plan: Rigid fit tests 1 to 10)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    solveRigid, solveLevel, solveBoth, solveFit, conditioning, leaveOneOut, swapEN,
    unitHintForScale, fitVerdict, isWarningFlag, FLAGS, ERRORS, POOR_FLAGS
} from '../js/survey/rigid-fit.js';
import * as RF from '../js/survey/rigid-fit.js';

// ---- Seeded test data ----

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function gaussian(rand) {
    const u = 1 - rand(), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Matrix helpers written out here rather than taken from linalg.js, so a
// mistake there cannot cancel out in these tests.
const DEG = Math.PI / 180;
const rotX = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const rotZ = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const mul = (A, B) => A.map(row => B[0].map((_, j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const apply = (R, t, p) => R.map((row, i) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + t[i]);
const norm = (v) => Math.hypot(v[0], v[1], v[2]);

function maxAbsDiff(a, b) {
    let m = 0;
    for (let i = 0; i < a.length; i++) {
        if (Array.isArray(a[i])) m = Math.max(m, maxAbsDiff(a[i], b[i]));
        else m = Math.max(m, Math.abs(a[i] - b[i]));
    }
    return m;
}

// Model to survey rotation: heading (clockwise from north, of the model's +Y
// axis) after a tilt about the model's X axis.
const pose = (headingDeg, tiltDeg) => mul(rotZ(-headingDeg * DEG), rotX(tiltDeg * DEG));

const SHIFT = [512000, 4123000, 58];

// n points in a box of the given size around the model origin; Q = R p + t
// plus Gaussian noise whose 3D RMS is `noise` metres.
function makeCase({ seed = 1, n = 6, size = [20, 20, 3], heading = 37, tilt = 0.3, noise = 0, shift = SHIFT } = {}) {
    const rand = mulberry32(seed);
    const P = [];
    for (let i = 0; i < n; i++) P.push(size.map(s => (rand() - 0.5) * s));
    const R = pose(heading, tilt);
    const sigma = noise / Math.sqrt(3);
    const Q = P.map(p => apply(R, shift, p).map(c => c + sigma * gaussian(rand)));
    return { P, Q, R, t: shift };
}

// ---- 1 and 2: exact and noisy data ----

test('1. exact data: rotation within 1e-10, shift within 1e-6 m, scale 1', () => {
    const { P, Q, R, t } = makeCase();
    const fit = solveRigid(P, Q);
    assert.equal(fit.ok, true);
    assert.equal(fit.fitType, 'rigid6');
    assert.ok(maxAbsDiff(fit.matrix, R) < 1e-10);

    // Expected quaternion [x, y, z, w] of Rz(-37 deg) * Rx(0.3 deg), worked out by hand.
    const sz = Math.sin(-18.5 * DEG), cz = Math.cos(18.5 * DEG);
    const sx = Math.sin(0.15 * DEG), cx = Math.cos(0.15 * DEG);
    assert.ok(maxAbsDiff(fit.rotation, [cz * sx, sz * sx, sz * cx, cz * cx]) < 1e-10);
    assert.ok(fit.rotation[3] > 0);

    assert.ok(maxAbsDiff(fit.translation, t) < 1e-6);
    assert.ok(Math.abs(fit.quality.scale - 1) < 1e-9);
    assert.ok(fit.quality.rms < 1e-6);
    assert.ok(Math.abs(fit.quality.headingDeg - 37) < 1e-6);
    assert.ok(Math.abs(fit.quality.tiltDeg - 0.3) < 1e-6);
    assert.equal(fit.quality.n, 6);
    assert.deepEqual(fit.quality.flags, [FLAGS.LEVEL_SUGGESTED]);   // 0.3 degrees is level enough
    assert.equal(fit.unitHint, null);
    assert.equal(fit.swapTrial, null);
    assert.deepEqual(fit.looOutliers, []);
    assert.ok(fit.looErrors.length === 6 && fit.looErrors.every(e => e < 1e-6));
    assert.equal(fitVerdict(fit), 'good');

    // Points as {x, y, z} and {e, n, h} objects give the same fit.
    const objFit = solveRigid(P.map(([x, y, z]) => ({ x, y, z })), Q.map(([e, n, h]) => ({ e, n, h })));
    assert.deepEqual(objFit.rotation, fit.rotation);
    assert.deepEqual(objFit.translation, fit.translation);
});

test('2. 1 cm noise: RMS between 0.5 and 1.5 cm, no warning flags', () => {
    const { P, Q, R } = makeCase({ noise: 0.01 });
    const fit = solveRigid(P, Q);
    assert.equal(fit.ok, true);
    const q = fit.quality;
    assert.ok(q.rms >= 0.005 && q.rms <= 0.015, `rms ${q.rms}`);
    assert.deepEqual(q.flags, [FLAGS.LEVEL_SUGGESTED]);
    assert.equal(q.flags.some(isWarningFlag), false);
    assert.equal(fitVerdict(fit), 'good');
    assert.ok(maxAbsDiff(fit.matrix, R) < 2e-3);

    // The residual figures agree with residuals recomputed from the returned fit.
    const res = P.map((p, i) => apply(fit.matrix, fit.translation, p).map((c, k) => Q[i][k] - c));
    assert.ok(maxAbsDiff(fit.residuals, res) < 1e-9);
    const n = P.length;
    const h2 = res.reduce((s, r) => s + r[0] * r[0] + r[1] * r[1], 0);
    const v2 = res.reduce((s, r) => s + r[2] * r[2], 0);
    assert.ok(Math.abs(q.rmsH - Math.sqrt(h2 / n)) < 1e-9);
    assert.ok(Math.abs(q.rmsV - Math.sqrt(v2 / n)) < 1e-9);
    assert.ok(Math.abs(q.rms - Math.sqrt((h2 + v2) / n)) < 1e-9);
    assert.ok(Math.abs(q.maxResidual - Math.max(...res.map(norm))) < 1e-9);
    assert.ok(q.rmsV > 0 && q.rmsH > 0 && q.rmsH < q.rms);
});

// ---- 3: leave-one-out ----

test('3. one point moved by 0.5 m: leave-one-out flags exactly that point', () => {
    // Seed 46 has picks where a good point far from the centre gets a larger
    // leave-one-out error than the moved one, and where the moved point stays
    // under three times the median of all errors.
    for (const seed of [1, 46]) {
        const { P, Q } = makeCase({ seed, noise: 0.01 });
        const dir = [1, -2, 0.5];
        const len = norm(dir);
        for (let k = 0; k < P.length; k++) {
            const bad = Q.map(q => q.slice());
            bad[k] = bad[k].map((c, i) => c + 0.5 * dir[i] / len);
            const fit = solveRigid(P, bad);
            assert.deepEqual(fit.looOutliers, [k], `seed ${seed}, moved point ${k}`);
            assert.ok(fit.quality.flags.includes(FLAGS.LOO_OUTLIER));
            assert.ok(fit.looErrors[k] > 0.4);
            assert.notEqual(fitVerdict(fit), 'good');
        }
        // Clean data flags nothing; leaveOneOut() is the per-point error the fit reports.
        const clean = solveRigid(P, Q);
        assert.deepEqual(clean.looOutliers, []);
        assert.deepEqual(leaveOneOut(P, Q), clean.looErrors);
    }
});

test('3b. leave-one-out: the 5 cm floor and the 3 x median condition', () => {
    // Exact and nearly exact data: tiny leave-one-out errors are never flagged,
    // even when one stands out against an even tinier median.
    for (const noise of [0, 0.002]) {
        for (let seed = 1; seed <= 40; seed++) {
            const { P, Q } = makeCase({ seed, noise });
            assert.deepEqual(solveRigid(P, Q).looOutliers, [], `noise ${noise}, seed ${seed}`);
        }
    }
    // A 15 cm error is over the floor and is found.
    for (let seed = 1; seed <= 20; seed++) {
        const { P, Q } = makeCase({ seed, noise: 0.002 });
        Q[2] = [Q[2][0], Q[2][1] + 0.15, Q[2][2]];
        assert.deepEqual(solveRigid(P, Q).looOutliers, [2], `seed ${seed}`);
    }
    // 4 cm noise: many errors pass 5 cm, but few stand out three times above the rest.
    let flagged = 0;
    for (let seed = 1; seed <= 40; seed++) {
        const { P, Q } = makeCase({ seed, noise: 0.04 });
        if (solveRigid(P, Q).looOutliers.length) flagged++;
    }
    assert.ok(flagged <= 5, `${flagged} of 40 noisy sets flagged`);
});

test('3c. leave-one-out with four points and with two bad picks among eight', () => {
    // A hand-made case: the other three errors are inflated by the bad pick,
    // so it stays under three times their median, but the fits tell it apart.
    const P4 = [[-8, -7, 0.5], [9, -6, -1], [7, 8, 1.2], [-6, 9, -0.4]];
    const Q4 = P4.map(p => [p[0] + SHIFT[0], p[1] + SHIFT[1], p[2] + SHIFT[2]]);
    Q4[2][0] += 0.5;
    const fit4 = solveRigid(P4, Q4);
    assert.deepEqual(fit4.looOutliers, [2]);
    assert.ok(fit4.quality.flags.includes(FLAGS.LOO_OUTLIER));

    // Seeded four-point sets: the moved point is found nearly always and
    // another point is never blamed; clean sets flag nothing.
    let found = 0;
    for (let seed = 1; seed <= 20; seed++) {
        const { P, Q } = makeCase({ seed, n: 4, noise: 0.01 });
        assert.deepEqual(solveRigid(P, Q).looOutliers, [], `clean, seed ${seed}`);
        const clean2 = makeCase({ seed, n: 4, noise: 0.02 });
        assert.deepEqual(solveRigid(clean2.P, clean2.Q).looOutliers, [], `2 cm noise, seed ${seed}`);
        for (let k = 0; k < 4; k++) {
            const bad = Q.map(q => q.slice());
            bad[k][0] += 0.5;
            const out = solveRigid(P, bad).looOutliers;
            assert.ok(out.length === 0 || (out.length === 1 && out[0] === k), `seed ${seed}, moved ${k}: ${out}`);
            if (out.length) found++;
        }
    }
    assert.ok(found >= 75, `found ${found} of 80`);

    // Two moved points among eight are both flagged.
    for (let seed = 1; seed <= 10; seed++) {
        const { P, Q } = makeCase({ seed, n: 8, noise: 0.01 });
        Q[1] = [Q[1][0] + 0.4, Q[1][1], Q[1][2]];
        Q[5] = [Q[5][0], Q[5][1] - 0.3, Q[5][2] + 0.2];
        assert.deepEqual(solveRigid(P, Q).looOutliers, [1, 5], `seed ${seed}`);
    }
});

// ---- 4 and 5: swapped Easting and Northing, mirror images ----

test('4. E and N swapped, points with height variation: reported as swapped', () => {
    const { P, Q, R, t } = makeCase();
    const fit = solveRigid(P, swapEN(Q));
    assert.equal(fit.ok, true);
    assert.ok(fit.detS < 0);
    assert.ok(fit.quality.rms > 0.3, 'a rotation cannot fit a mirror image');
    assert.ok(fit.quality.flags.includes(FLAGS.SWAPPED_EN));
    assert.ok(!fit.quality.flags.includes(FLAGS.MIRRORED));
    assert.ok(!fit.quality.flags.includes(FLAGS.LEVEL_SUGGESTED));
    assert.equal(fitVerdict(fit), 'poor');
    // The trial fit is the fit after the swap, so the UI can offer it.
    assert.equal(fit.swapTrial.ok, true);
    assert.ok(fit.swapTrial.quality.rms < 1e-6);
    assert.ok(maxAbsDiff(fit.swapTrial.matrix, R) < 1e-9);
    assert.ok(maxAbsDiff(fit.swapTrial.translation, t) < 1e-6);

    // A tall point set, where the best rotation stays upright: the poor fit
    // and det(S) < 0 alone lead to the swap.
    const tall = makeCase({ seed: 5, size: [4, 20, 12], noise: 0.01 });
    const tallFit = solveRigid(tall.P, swapEN(tall.Q));
    assert.ok(tallFit.detS < 0);
    assert.ok(tallFit.quality.tiltDeg < 60, `tilt ${tallFit.quality.tiltDeg}`);
    assert.ok(tallFit.quality.flags.includes(FLAGS.SWAPPED_EN));

    // The level fit runs the same check on the horizontal part.
    const level = makeCase({ tilt: 0, noise: 0.01 });
    const levelFit = solveLevel(level.P, swapEN(level.Q));
    assert.ok(levelFit.quality.flags.includes(FLAGS.SWAPPED_EN));
    assert.equal(levelFit.swapTrial.fitType, 'level4');
    // ... also for flat points, where det(S) of the full 3x3 is zero.
    const flatLevel = makeCase({ size: [20, 20, 0], tilt: 0, noise: 0.01 });
    const flatLevelFit = solveLevel(flatLevel.P, swapEN(flatLevel.Q));
    assert.ok(flatLevelFit.quality.flags.includes(FLAGS.SWAPPED_EN));
    assert.equal(flatLevelFit.swapTrial.fitType, 'level4');
    assert.ok(flatLevelFit.swapTrial.quality.rms < 0.015);
});

test('5. E and N swapped, flat points: tilt near 180 degrees, reported as swapped', () => {
    const { P, Q, R, t } = makeCase({ size: [20, 20, 0] });
    const fit = solveRigid(P, swapEN(Q));
    assert.equal(fit.ok, true);
    assert.ok(fit.quality.rms < 1e-6, 'upside down, the flat set fits exactly');
    assert.ok(fit.quality.tiltDeg > 179, `tilt ${fit.quality.tiltDeg}`);
    assert.ok(fit.quality.flags.includes(FLAGS.FLIPPED));
    assert.ok(fit.quality.flags.includes(FLAGS.SWAPPED_EN));
    assert.equal(fitVerdict(fit), 'poor');
    assert.ok(fit.swapTrial.quality.tiltDeg < 1);
    assert.ok(maxAbsDiff(fit.swapTrial.matrix, R) < 1e-9);
    assert.ok(maxAbsDiff(fit.swapTrial.translation, t) < 1e-6);

    // Nearly flat with 3 cm noise: the upside-down fit absorbs some noise
    // with its tilt and beats the upright trial by a few millimetres.
    const noisy = makeCase({ seed: 119, n: 4, size: [20, 20, 0.5], noise: 0.03 });
    const noisyFit = solveRigid(noisy.P, swapEN(noisy.Q));
    assert.ok(noisyFit.quality.flags.includes(FLAGS.FLIPPED));
    assert.ok(noisyFit.swapTrial.quality.rms > noisyFit.quality.rms + 0.001);
    assert.ok(noisyFit.quality.flags.includes(FLAGS.SWAPPED_EN));

    // Three points always lie in a plane; swapped, the fit can end up on its
    // side (60 to 120 degrees) instead of upside down.
    for (const seed of [5, 23, 26]) {
        const three = makeCase({ seed, n: 3 });
        const threeFit = solveRigid(three.P, swapEN(three.Q));
        const tilt = threeFit.quality.tiltDeg;
        assert.ok(tilt >= 60 && tilt <= 120, `seed ${seed}, tilt ${tilt}`);
        assert.ok(threeFit.quality.flags.includes(FLAGS.SWAPPED_EN), `seed ${seed}`);
        assert.ok(maxAbsDiff(threeFit.swapTrial.matrix, three.R) < 1e-9);
    }
});

test('two picks in the wrong order are not reported as swapped or mirrored', () => {
    // The best rotation for such data is often upside down, and the upright
    // swap trial is just as poor: that explains nothing.
    let flipped = 0;
    for (let seed = 1; seed <= 20; seed++) {
        const { P, Q } = makeCase({ seed, size: [20, 20, 1], noise: 0.01 });
        [Q[0], Q[3]] = [Q[3], Q[0]];
        const fit = solveRigid(P, Q);
        assert.ok(!fit.quality.flags.includes(FLAGS.SWAPPED_EN), `seed ${seed}`);
        assert.ok(!fit.quality.flags.includes(FLAGS.MIRRORED), `seed ${seed}`);
        assert.equal(fitVerdict(fit), 'poor');
        if (fit.quality.flags.includes(FLAGS.FLIPPED)) flipped++;
    }
    assert.ok(flipped >= 3, 'some of these fits are upside down');
});

test('level fit: two picks in the wrong order are not reported as swapped or mirrored', () => {
    // A level fit is never tilted, so only "far better" can trigger the swap;
    // a swap trial that is still poor without a leave-one-out outlier must not.
    for (const [n, k] of [[3, 1], [3, 2], [4, 2], [4, 3]]) {
        for (let seed = 1; seed <= 20; seed++) {
            const { P, Q } = makeCase({ seed, n, size: [20, 20, 1], noise: 0.01 });
            [Q[0], Q[k]] = [Q[k], Q[0]];
            const fit = solveLevel(P, Q);
            if (!fit.ok) continue;   // some three- and four-point draws are collinear
            assert.ok(!fit.quality.flags.includes(FLAGS.SWAPPED_EN), `n ${n}, k ${k}, seed ${seed}`);
            assert.ok(!fit.quality.flags.includes(FLAGS.MIRRORED), `n ${n}, k ${k}, seed ${seed}`);
        }
    }
});

test('a mirror that a swap cannot explain is reported as mirrored', () => {
    const { P, Q } = makeCase({ noise: 0.01 });
    const fit = solveRigid(P, Q.map(([e, n, h]) => [e, n, -h]));   // heights mirrored
    assert.ok(fit.quality.flags.includes(FLAGS.MIRRORED));
    assert.ok(!fit.quality.flags.includes(FLAGS.SWAPPED_EN));
    assert.equal(fitVerdict(fit), 'poor');
});

test('a model that is really upside down is flipped, not swapped or mirrored', () => {
    const { P } = makeCase();
    const R = mul(pose(37, 0.3), rotX(Math.PI));
    const Q = P.map(p => apply(R, SHIFT, p));
    const fit = solveRigid(P, Q);
    assert.ok(fit.quality.rms < 1e-6);
    assert.ok(fit.quality.flags.includes(FLAGS.FLIPPED));
    assert.ok(!fit.quality.flags.includes(FLAGS.SWAPPED_EN));
    assert.ok(!fit.quality.flags.includes(FLAGS.MIRRORED));
    assert.ok(fit.swapTrial && fit.swapTrial.quality.rms > 0.3, 'the swap trial ran and fits worse');
});

// ---- 6 and 7: degenerate input and three points ----

test('6. collinear, coincident and two points: the matching errors', () => {
    const P0 = [[-10, 0, 0], [-6, 0, 0], [-2, 0, 0], [2, 0, 0], [6, 0, 0], [10, 0, 0]];
    const R = pose(37, 0.3);
    // Survey points along a line with +-0.2 m sideways: sqrt(l2/l1) = 0.029.
    const line = P0.map(([x], i) => [x, i % 2 ? 0.2 : -0.2, 0]);
    const lineFit = solveRigid(line, line.map(p => apply(R, SHIFT, p)));
    assert.equal(lineFit.ok, false);
    assert.equal(lineFit.error, ERRORS.COLLINEAR);
    assert.equal(lineFit.side, 'survey');
    const exact = [[0, 0, 0], [5, 5, 1], [10, 10, 2]];
    assert.equal(solveRigid(exact, exact.map(p => apply(R, SHIFT, p))).error, ERRORS.COLLINEAR);

    // +-0.7 m sideways: sqrt(l2/l1) = 0.10, usable but weak.
    const weak = P0.map(([x], i) => [x, i % 2 ? 0.7 : -0.7, 0]);
    const weakCond = conditioning(weak);
    assert.ok(weakCond.ratio > 0.05 && weakCond.ratio < 0.15 && weakCond.error === null && weakCond.weak);
    const weakFit = solveRigid(weak, weak.map(p => apply(R, SHIFT, p)));
    assert.equal(weakFit.ok, true);
    assert.ok(weakFit.quality.flags.includes(FLAGS.WEAK_GEOMETRY));
    assert.equal(fitVerdict(weakFit), 'check');

    // Four survey points within 3 cm of each other.
    const bunch = [[0, 0, 0], [0.03, 0, 0], [0, 0.03, 0], [0, 0, 0.03]];
    const bunchFit = solveRigid(bunch, bunch.map(p => apply(R, SHIFT, p)));
    assert.equal(bunchFit.ok, false);
    assert.equal(bunchFit.error, ERRORS.COINCIDENT);
    assert.equal(fitVerdict(bunchFit), 'poor');

    // Spread-out survey points but all picks on one model spot.
    const Q = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 3]].map(p => apply(R, SHIFT, p));
    const samePick = solveRigid(Q.map(() => [1, 2, 3]), Q);
    assert.equal(samePick.error, ERRORS.COINCIDENT);
    assert.equal(samePick.side, 'model');

    const two = solveRigid([[0, 0, 0], [10, 0, 0]], [[0, 0, 0], [10, 0, 0]].map(p => apply(R, SHIFT, p)));
    assert.equal(two.ok, false);
    assert.equal(two.error, ERRORS.TOO_FEW);

    // A flat set is valid.
    assert.equal(conditioning([[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0]]).error, null);

    // Programming errors throw instead.
    assert.throws(() => solveRigid([[0, 0, 0]], []), RangeError);
    assert.throws(() => solveRigid([[0, 0, NaN], [1, 0, 0], [0, 1, 0]], Q.slice(0, 3)), TypeError);
    assert.throws(() => solveFit(P0, P0, 'affine'), RangeError);
});

test('7. three points: no leave-one-out and a no-redundancy flag', () => {
    const { P, Q } = makeCase({ n: 3 });
    const fit = solveRigid(P, Q);
    assert.equal(fit.ok, true);
    assert.ok(fit.quality.rms < 1e-6);
    assert.equal(fit.looErrors, null);
    assert.deepEqual(fit.looOutliers, []);
    assert.equal(leaveOneOut(P, Q), null);
    assert.ok(fit.quality.flags.includes(FLAGS.NO_REDUNDANCY));
    assert.equal(fitVerdict(fit), 'check');   // even a perfect fit
    // A fourth point removes the flag.
    const four = makeCase({ n: 4 });
    assert.ok(!solveRigid(four.P, four.Q).quality.flags.includes(FLAGS.NO_REDUNDANCY));
});

// ---- 8 and 9: units and axes ----

test('8. model scaled by 1000: the unit hint', () => {
    const { P, Q, R } = makeCase();
    const mm = solveRigid(P.map(p => p.map(c => c * 1000)), Q);
    assert.ok(Math.abs(mm.quality.scale / 0.001 - 1) < 1e-9);
    assert.deepEqual(mm.unitHint, { unit: 'mm', side: 'model', factor: 0.001 });
    assert.ok(mm.quality.flags.includes(FLAGS.UNIT_HINT));
    assert.ok(mm.quality.flags.includes(FLAGS.SCALE_ERROR));
    assert.ok(!mm.quality.flags.includes(FLAGS.LEVEL_SUGGESTED));
    assert.equal(fitVerdict(mm), 'poor');
    assert.ok(maxAbsDiff(mm.matrix, R) < 1e-9, 'the rotation does not depend on the scale');

    // A survey in feet reads about 3.28 and names the survey side.
    const ft = solveRigid(P, Q.map(q => q.map(c => c / 0.3048)));
    assert.equal(ft.unitHint.unit, 'ft');
    assert.equal(ft.unitHint.side, 'survey');

    // 2 % off: a scale warning, not an error, and no unit.
    const off = solveRigid(P.map(p => p.map(c => c * 1.02)), Q);
    assert.ok(off.quality.flags.includes(FLAGS.SCALE_WARN));
    assert.ok(!off.quality.flags.includes(FLAGS.SCALE_ERROR));
    assert.equal(off.unitHint, null);
    // Survey over model: 1.04 is a warning, 1.06 an error, 1.005 nothing.
    const scaled = (f) => solveRigid(P, Q.map((q, i) => q.map((c, k) => SHIFT[k] + (c - SHIFT[k]) * f))).quality.flags;
    assert.ok(scaled(1.04).includes(FLAGS.SCALE_WARN) && !scaled(1.04).includes(FLAGS.SCALE_ERROR));
    assert.ok(scaled(1.06).includes(FLAGS.SCALE_ERROR) && !scaled(1.06).includes(FLAGS.SCALE_WARN));
    assert.ok(!scaled(1.005).some(f => f === FLAGS.SCALE_WARN || f === FLAGS.SCALE_ERROR));

    assert.equal(unitHintForScale(1), null);
    assert.equal(unitHintForScale(0.9996), null);   // UTM grid against ground distances
    assert.equal(unitHintForScale(0.0254).unit, 'in');
    assert.equal(unitHintForScale(100).side, 'survey');
});

test('9. model rotated 90 degrees about X: the up-axis message', () => {
    const { P, Q } = makeCase();
    const fit = solveRigid(P.map(p => apply(rotX(Math.PI / 2), [0, 0, 0], p)), Q);
    assert.ok(fit.quality.rms < 1e-6);
    assert.ok(Math.abs(fit.quality.tiltDeg - 90) < 1, `tilt ${fit.quality.tiltDeg}`);
    assert.ok(fit.quality.flags.includes(FLAGS.UP_AXIS));
    assert.ok(!fit.quality.flags.includes(FLAGS.TILT_WARN));
    assert.ok(!fit.quality.flags.includes(FLAGS.FLIPPED));
    assert.equal(fitVerdict(fit), 'poor');

    // 10 degrees is only a tilt warning.
    const tilted = makeCase({ tilt: 10 });
    const tiltFit = solveRigid(tilted.P, tilted.Q);
    assert.deepEqual(tiltFit.quality.flags, [FLAGS.TILT_WARN]);
    assert.equal(fitVerdict(tiltFit), 'check');

    // The band edges: 4 and 50 degrees, 65 and 115, 125.
    const tiltFlags = (tilt) => { const c = makeCase({ tilt }); return solveRigid(c.P, c.Q).quality.flags; };
    assert.deepEqual(tiltFlags(4), []);
    assert.deepEqual(tiltFlags(50), [FLAGS.TILT_WARN]);
    assert.ok(tiltFlags(65).includes(FLAGS.UP_AXIS));
    assert.ok(tiltFlags(115).includes(FLAGS.UP_AXIS));
    assert.ok(tiltFlags(125).includes(FLAGS.FLIPPED));
});

// ---- 10: level-only fit ----

test('10. the level fit recovers the heading; suggested on level data, not at 2 degrees', () => {
    const level = makeCase({ tilt: 0 });
    const lf = solveLevel(level.P, level.Q);
    assert.equal(lf.ok, true);
    assert.equal(lf.fitType, 'level4');
    assert.equal(lf.rotation[0], 0);
    assert.equal(lf.rotation[1], 0);
    assert.ok(maxAbsDiff(lf.matrix, level.R) < 1e-10);
    assert.ok(maxAbsDiff(lf.translation, level.t) < 1e-6);
    assert.ok(Math.abs(lf.quality.headingDeg - 37) < 1e-9);
    assert.equal(lf.quality.tiltDeg, 0);
    assert.ok(!lf.quality.flags.includes(FLAGS.LEVEL_SUGGESTED));
    assert.ok(solveRigid(level.P, level.Q).quality.flags.includes(FLAGS.LEVEL_SUGGESTED));

    // With 1 cm noise the full fit still finds the data level.
    const noisy = makeCase({ tilt: 0, noise: 0.01 });
    const both = solveBoth(noisy.P, noisy.Q);
    assert.equal(both.levelSuggested, true);
    assert.ok(Math.abs(both.level4.quality.headingDeg - 37) < 0.1);
    assert.ok(both.level4.quality.rms < 0.015);

    // 0.8 degrees is over the 0.5 degree limit.
    const slight = makeCase({ tilt: 0.8 });
    assert.equal(solveBoth(slight.P, slight.Q).levelSuggested, false);

    // At 2 degrees of tilt the level fit is not suggested and fits visibly worse.
    const steep = makeCase({ tilt: 2 });
    const steepBoth = solveBoth(steep.P, steep.Q);
    assert.equal(steepBoth.levelSuggested, false);
    assert.ok(!steepBoth.rigid6.quality.flags.includes(FLAGS.LEVEL_SUGGESTED));
    assert.ok(Math.abs(steepBoth.rigid6.quality.tiltDeg - 2) < 1e-6);
    assert.ok(steepBoth.rigid6.quality.rms < 1e-6);
    assert.ok(steepBoth.level4.quality.rms > 0.05);
    assert.ok(Math.abs(steepBoth.level4.quality.headingDeg - 37) < 0.5);

    // Headings run clockwise from north, in [0, 360).
    const west = makeCase({ heading: 270, tilt: 0 });
    assert.ok(Math.abs(solveLevel(west.P, west.Q).quality.headingDeg - 270) < 1e-9);
    const north = makeCase({ heading: 0, tilt: 0 });
    const h0 = solveLevel(north.P, north.Q).quality.headingDeg;
    assert.ok(h0 >= 0 && h0 < 360 && Math.min(h0, 360 - h0) < 1e-9);
});

// ---- Verdict and other checks ----

test('verdict: good, check and poor', () => {
    const q = (rms, n, flags = []) => ({ n, rms, rmsH: rms, rmsV: 0, maxResidual: rms, scale: 1, tiltDeg: 0, headingDeg: 0, flags });
    assert.equal(fitVerdict(q(0.03, 4)), 'good');
    assert.equal(fitVerdict(q(0.01, 6, [FLAGS.LEVEL_SUGGESTED])), 'good');
    assert.equal(fitVerdict(q(0.031, 4)), 'check');
    assert.equal(fitVerdict(q(0.01, 3, [FLAGS.NO_REDUNDANCY])), 'check');
    assert.equal(fitVerdict(q(0.01, 3)), 'check');
    assert.equal(fitVerdict(q(0.01, 5, [FLAGS.RESIDUAL_WARN])), 'check');
    assert.equal(fitVerdict(q(0.15, 5)), 'check');
    assert.equal(fitVerdict(q(0.151, 5)), 'poor');
    for (const f of POOR_FLAGS) assert.equal(fitVerdict(q(0.01, 6, [f])), 'poor');
    assert.equal(fitVerdict({ ok: false, error: ERRORS.TOO_FEW }), 'poor');
    assert.equal(fitVerdict(null), 'poor');
});

test('the thresholds match the plan', () => {
    const expected = {
        MIN_CONTROL_POINTS: 3, RECOMMENDED_CONTROL_POINTS: 4, MIN_SPREAD: 0.25,
        COLLINEAR_RATIO: 0.05, WEAK_GEOMETRY_RATIO: 0.15, GOOD_RMS: 0.03,
        RESIDUAL_WARN_DEFAULT: 0.05, POOR_RMS: 0.15, LOO_MIN_ERROR: 0.05, LOO_MEDIAN_FACTOR: 3,
        SCALE_WARN: 0.01, SCALE_ERROR: 0.05, TILT_WARN_DEG: 5, UP_AXIS_MIN_DEG: 60,
        UP_AXIS_MAX_DEG: 120, LEVEL_SUGGEST_DEG: 0.5, SELECTION_LIMIT_DEFAULT: 0.5,
        SURFACE_WARN_DEFAULT: 0.10, SITE_EXTENT_WARN: 2000, DUPLICATE_TOLERANCE: 0.001
    };
    for (const [name, value] of Object.entries(expected)) assert.equal(RF[name], value, name);

    // Spread limit: survey points about 0.2 m from their centroid are
    // coincident, about 0.3 m are not.
    const R = pose(37, 0.3);
    const box = (s) => [[s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s / 2]];
    const small = box(0.22), large = box(0.33);
    assert.equal(solveRigid(small, small.map(p => apply(R, SHIFT, p))).error, ERRORS.COINCIDENT);
    assert.equal(solveRigid(large, large.map(p => apply(R, SHIFT, p))).ok, true);

    // Residual warning default: one point raised by 10 cm leaves a residual
    // just under 5 cm, by 12 cm just over (the fit absorbs about half).
    const { P, Q } = makeCase({ n: 8 });
    const raised = (d) => solveRigid(P, Q.map((q, i) => (i === 0 ? [q[0], q[1], q[2] + d] : q))).quality;
    const under = raised(0.10), over = raised(0.12);
    assert.ok(under.maxResidual > 0.045 && under.maxResidual < 0.05, `${under.maxResidual}`);
    assert.ok(!under.flags.includes(FLAGS.RESIDUAL_WARN));
    assert.ok(over.maxResidual > 0.05 && over.maxResidual < 0.06, `${over.maxResidual}`);
    assert.ok(over.flags.includes(FLAGS.RESIDUAL_WARN));
});

test('residual warning follows its option; site extent is flagged', () => {
    const { P, Q } = makeCase({ noise: 0.01 });
    const strict = solveRigid(P, Q, { residualWarn: 0.001 });
    assert.ok(strict.quality.flags.includes(FLAGS.RESIDUAL_WARN));
    assert.equal(fitVerdict(strict), 'check');
    assert.ok(!solveRigid(P, Q).quality.flags.includes(FLAGS.RESIDUAL_WARN));

    const big = makeCase({ size: [3000, 3000, 30] });
    const bigFit = solveRigid(big.P, big.Q);
    assert.ok(bigFit.extent > 2000);
    assert.ok(bigFit.quality.flags.includes(FLAGS.SITE_EXTENT));
});
