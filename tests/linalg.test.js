// tests/linalg.test.js - Jacobi eigen-solver and quaternion helpers (plan: Rigid fit tests 11 and 12)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mean3, matMul, matVec, transpose, det3, jacobiEigenSym,
    quatNormalize, quatMultiply, quatFromAxisAngle, quatToMat, matToQuat
} from '../js/survey/linalg.js';

// Seeded PRNG (mulberry32), so every run sees the same "random" matrices.
function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function maxAbsDiff(a, b) {
    let m = 0;
    for (let i = 0; i < a.length; i++) {
        if (Array.isArray(a[i])) m = Math.max(m, maxAbsDiff(a[i], b[i]));
        else m = Math.max(m, Math.abs(a[i] - b[i]));
    }
    return m;
}

function randomSymmetric(rand, n) {
    const a = [];
    for (let i = 0; i < n; i++) a.push(new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) a[i][j] = a[j][i] = (rand() - 0.5) * 20;
    }
    return a;
}

function randomUnitQuat(rand) {
    return quatNormalize([rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5]);
}

// Checks A v = lambda v for every pair, orthonormal vectors and descending values.
function assertEigenDecomposition(a, { values, vectors }, tol) {
    const n = a.length;
    assert.equal(values.length, n);
    assert.equal(vectors.length, n);
    for (let k = 1; k < n; k++) assert.ok(values[k - 1] >= values[k], 'values must be sorted descending');
    for (let k = 0; k < n; k++) {
        const av = matVec(a, vectors[k]);
        const lv = vectors[k].map(c => c * values[k]);
        assert.ok(maxAbsDiff(av, lv) < tol, `A v != lambda v for value ${values[k]}`);
        for (let l = 0; l < n; l++) {
            let d = 0;
            for (let i = 0; i < n; i++) d += vectors[k][i] * vectors[l][i];
            assert.ok(Math.abs(d - (k === l ? 1 : 0)) < 1e-12, 'eigenvectors must be orthonormal');
        }
    }
}

test('11. Jacobi: diagonal matrix', () => {
    const a = [[3, 0, 0, 0], [0, -1, 0, 0], [0, 0, 7, 0], [0, 0, 0, 0]];
    const r = jacobiEigenSym(a);
    assert.deepEqual(r.values, [7, 3, 0, -1]);
    assert.deepEqual(r.vectors.map(v => v.map(Math.abs)), [[0, 0, 1, 0], [1, 0, 0, 0], [0, 0, 0, 1], [0, 1, 0, 0]]);
    assert.equal(r.sweeps, 0);
});

test('11. Jacobi: repeated eigenvalues', () => {
    // U diag(5, 2, 2) U^T with a general rotation U: the 2-eigenspace is a plane.
    const u = quatToMat(quatNormalize([0.3, -0.5, 0.2, 0.8]));
    const a = matMul(matMul(u, [[5, 0, 0], [0, 2, 0], [0, 0, 2]]), transpose(u));
    const r = jacobiEigenSym(a);
    assert.ok(maxAbsDiff(r.values, [5, 2, 2]) < 1e-12);
    assertEigenDecomposition(a, r, 1e-12);
    // The single eigenvector is the first column of U (up to sign).
    const u0 = [u[0][0], u[1][0], u[2][0]];
    const d = r.vectors[0].reduce((s, c, i) => s + c * u0[i], 0);
    assert.ok(Math.abs(Math.abs(d) - 1) < 1e-12);

    // A 4x4 with a repeated largest value, as Horn's matrix has for symmetric point sets.
    const b = [[4, 0, 0, 0], [0, 4, 0, 0], [0, 0, 1, 1], [0, 0, 1, 1]];
    const rb = jacobiEigenSym(b);
    assert.ok(maxAbsDiff(rb.values, [4, 4, 2, 0]) < 1e-12);
    assertEigenDecomposition(b, rb, 1e-12);
});

test('11. Jacobi: random symmetric matrices', () => {
    const rand = mulberry32(11);
    for (const n of [3, 4, 4, 6, 9]) {
        const a = randomSymmetric(rand, n);
        const copy = a.map(row => row.slice());
        const r = jacobiEigenSym(a);
        assert.deepEqual(a, copy, 'input must not be modified');
        assertEigenDecomposition(a, r, 1e-11);
        // Reconstruction: A = sum of lambda v v^T, and the trace is kept.
        const rec = a.map((row, i) => row.map((_, j) => r.values.reduce((s, l, k) => s + l * r.vectors[k][i] * r.vectors[k][j], 0)));
        assert.ok(maxAbsDiff(rec, a) < 1e-11);
        const trace = a.reduce((s, row, i) => s + row[i], 0);
        assert.ok(Math.abs(r.values.reduce((s, v) => s + v, 0) - trace) < 1e-11);
        assert.ok(r.sweeps < 20);
    }
});

test('11. Jacobi: zero matrix and bad input', () => {
    const r = jacobiEigenSym([[0, 0], [0, 0]]);
    assert.deepEqual(r.values, [0, 0]);
    assert.deepEqual(r.vectors, [[1, 0], [0, 1]]);
    assert.throws(() => jacobiEigenSym([[1, 2, 3], [4, 5, 6]]), RangeError);
});

test('12. quatToMat: known rotations', () => {
    const z90 = quatToMat(quatFromAxisAngle([0, 0, 1], Math.PI / 2));
    assert.ok(maxAbsDiff(z90, [[0, -1, 0], [1, 0, 0], [0, 0, 1]]) < 1e-15);   // x turns to y
    const x90 = quatToMat(quatFromAxisAngle([1, 0, 0], Math.PI / 2));
    assert.ok(maxAbsDiff(matVec(x90, [0, 1, 0]), [0, 0, 1]) < 1e-15);          // y turns to z
    // A non-unit quaternion gives the matrix of its normalised form.
    const q = [0.1, -0.7, 0.3, 0.6];
    assert.ok(maxAbsDiff(quatToMat(q.map(c => c * 3.5)), quatToMat(quatNormalize(q))) < 1e-15);
    assert.deepEqual(quatToMat([0, 0, 0, 0]), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

test('12. quaternion to matrix and back', () => {
    const rand = mulberry32(12);
    const cases = [
        [0, 0, 0, 1],                                   // identity
        [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0],       // 180 degrees about X, Y, Z
        quatFromAxisAngle([1, 1, 1], Math.PI),          // 180 degrees about a diagonal
        quatFromAxisAngle([1, -2, 0.5], Math.PI - 1e-7) // just short of 180 degrees
    ];
    for (let i = 0; i < 200; i++) cases.push(randomUnitQuat(rand));
    for (let i = 0; i < 20; i++) {
        cases.push(quatFromAxisAngle([rand() - 0.5, rand() - 0.5, rand() - 0.5], Math.PI - rand() * 1e-4));
    }
    for (const raw of cases) {
        const q = quatNormalize(raw);
        const m = quatToMat(q);
        // A proper rotation: orthonormal with determinant +1.
        assert.ok(maxAbsDiff(matMul(m, transpose(m)), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) < 1e-14);
        assert.ok(Math.abs(det3(m) - 1) < 1e-14);
        const back = matToQuat(m);
        assert.ok(Math.abs(Math.hypot(...back) - 1) < 1e-15);
        if (Math.abs(q[3]) > 1e-12) assert.ok(back[3] > 0, 'w must be non-negative');
        const sign = (back[0] * q[0] + back[1] * q[1] + back[2] * q[2] + back[3] * q[3]) < 0 ? -1 : 1;
        assert.ok(maxAbsDiff(back, q.map(c => c * sign)) < 1e-14, `round trip failed for ${q}`);
    }
});

test('12. quaternion product matches the matrix product', () => {
    const rand = mulberry32(120);
    for (let i = 0; i < 50; i++) {
        const a = randomUnitQuat(rand), b = randomUnitQuat(rand);
        assert.ok(maxAbsDiff(quatToMat(quatMultiply(a, b)), matMul(quatToMat(a), quatToMat(b))) < 1e-14);
    }
});

test('mean3 keeps millimetres at UTM magnitudes', () => {
    const m = mean3([[512000.001, 4123000.001, 58.001], [512000.002, 4123000.002, 58.002], [512000.003, 4123000.003, 58.003]]);
    assert.ok(maxAbsDiff(m, [512000.002, 4123000.002, 58.002]) < 1e-9);
    assert.throws(() => mean3([]), RangeError);
});
