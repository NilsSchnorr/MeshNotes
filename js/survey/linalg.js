// js/survey/linalg.js - Small dense linear-algebra helpers for the survey fit
// Pure: no Three.js, state or DOM imports, so the solver loads in Node tests.
//
// Conventions used throughout js/survey/:
// - Vectors are plain arrays [x, y, z].
// - Matrices are arrays of rows, M[row][col]. A 3x3 rotation R maps a column
//   vector v to R * v.
// - Quaternions are [x, y, z, w] (scalar last), the order the box selector
//   already uses for meshnotes:rotation. They are active rotations, so
//   quatToMat(q) * v rotates v by q.

// ============ 3-vectors ============

export function add3(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a, s) {
    return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
}

export function norm3(a) {
    return Math.hypot(a[0], a[1], a[2]);
}

/**
 * Mean of a list of 3-vectors. The sum is taken relative to the first point,
 * so seven-digit UTM values do not lose their millimetres to rounding.
 * @param {number[][]} points - Non-empty list of [x, y, z]
 * @returns {number[]} [x, y, z]
 */
export function mean3(points) {
    const n = points.length;
    if (n === 0) throw new RangeError('mean3: empty point list');
    const r = points[0];
    let sx = 0, sy = 0, sz = 0;
    for (const p of points) {
        sx += p[0] - r[0];
        sy += p[1] - r[1];
        sz += p[2] - r[2];
    }
    return [r[0] + sx / n, r[1] + sy / n, r[2] + sz / n];
}

// ============ Matrices ============

export function identityMatrix(n) {
    const m = [];
    for (let i = 0; i < n; i++) {
        const row = new Array(n).fill(0);
        row[i] = 1;
        m.push(row);
    }
    return m;
}

export function transpose(m) {
    return m[0].map((_, j) => m.map(row => row[j]));
}

export function matMul(a, b) {
    const rows = a.length, cols = b[0].length, inner = b.length;
    const out = [];
    for (let i = 0; i < rows; i++) {
        const row = new Array(cols).fill(0);
        for (let j = 0; j < cols; j++) {
            let s = 0;
            for (let k = 0; k < inner; k++) s += a[i][k] * b[k][j];
            row[j] = s;
        }
        out.push(row);
    }
    return out;
}

// Matrix times column vector.
export function matVec(m, v) {
    return m.map(row => {
        let s = 0;
        for (let k = 0; k < row.length; k++) s += row[k] * v[k];
        return s;
    });
}

export function det3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

// Rotation by theta (radians) about +Z, counter-clockwise seen from above:
// +X turns towards +Y.
export function rotZ(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

// ============ Symmetric eigen-solver ============

/**
 * Eigen-decomposition of a real symmetric matrix by the cyclic Jacobi method.
 * Works for any size; the survey fit uses it on the 4x4 Horn matrix and on
 * 3x3 covariance matrices. The input is not modified.
 *
 * Layout of the result: values are sorted in descending order, and
 * vectors[k] is the unit eigenvector (a plain array) that belongs to
 * values[k]. The vectors are mutually orthogonal, also for repeated values.
 *
 * @param {number[][]} a - Symmetric n x n matrix (only symmetry is assumed)
 * @param {{maxSweeps?: number}} [options]
 * @returns {{values: number[], vectors: number[][], sweeps: number}}
 */
export function jacobiEigenSym(a, { maxSweeps = 50 } = {}) {
    const n = a.length;
    if (!n || a.some(row => row.length !== n)) throw new RangeError('jacobiEigenSym: square matrix expected');
    const m = a.map(row => row.slice());
    const v = identityMatrix(n);

    let total = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) total += m[i][j] * m[i][j];
    // Stop once the off-diagonal part is below machine precision of the whole.
    const stop = total * Number.EPSILON * Number.EPSILON;

    let sweeps = 0;
    for (; sweeps < maxSweeps; sweeps++) {
        let off = 0;
        for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) off += m[p][q] * m[p][q];
        if (off <= stop) break;

        for (let p = 0; p < n - 1; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = m[p][q];
                if (apq === 0) continue;
                // Rotation angle that zeroes m[p][q]; t = tan(angle), the
                // smaller root, keeps the rotation below 45 degrees.
                const theta = (m[q][q] - m[p][p]) / (2 * apq);
                let t = isFinite(theta * theta)
                    ? 1 / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
                    : 1 / (2 * Math.abs(theta));
                if (theta < 0) t = -t;
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;

                for (let k = 0; k < n; k++) {          // columns p and q
                    const mkp = m[k][p], mkq = m[k][q];
                    m[k][p] = c * mkp - s * mkq;
                    m[k][q] = s * mkp + c * mkq;
                }
                for (let k = 0; k < n; k++) {          // rows p and q
                    const mpk = m[p][k], mqk = m[q][k];
                    m[p][k] = c * mpk - s * mqk;
                    m[q][k] = s * mpk + c * mqk;
                }
                m[p][q] = 0;
                m[q][p] = 0;
                for (let k = 0; k < n; k++) {          // accumulate eigenvectors (columns of v)
                    const vkp = v[k][p], vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }

    const order = [...Array(n).keys()].sort((i, j) => m[j][j] - m[i][i]);
    return {
        values: order.map(i => m[i][i]),
        vectors: order.map(i => v.map(row => row[i])),
        sweeps
    };
}

// ============ Quaternions [x, y, z, w] ============

// Unit quaternion with the same sign. A zero quaternion becomes the identity,
// as Three.js treats it.
export function quatNormalize(q) {
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    if (!(len > 0)) return [0, 0, 0, 1];
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

// Hamilton product a * b: the rotation b first, then a.
export function quatMultiply(a, b) {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz
    ];
}

// Rotation by angle (radians) about axis (any length > 0).
export function quatFromAxisAngle(axis, angle) {
    const len = norm3(axis);
    if (!(len > 0)) return [0, 0, 0, 1];
    const s = Math.sin(angle / 2) / len;
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/**
 * Rotation matrix of a quaternion. A non-unit quaternion gives the matrix of
 * its normalised form; a zero quaternion gives the identity.
 * @param {number[]} q - [x, y, z, w]
 * @returns {number[][]} 3x3 rows
 */
export function quatToMat(q) {
    const [x, y, z, w] = q;
    const len2 = x * x + y * y + z * z + w * w;
    const s = len2 > 0 ? 2 / len2 : 0;
    const xs = x * s, ys = y * s, zs = z * s;
    const wx = w * xs, wy = w * ys, wz = w * zs;
    const xx = x * xs, xy = x * ys, xz = x * zs;
    const yy = y * ys, yz = y * zs, zz = z * zs;
    return [
        [1 - (yy + zz), xy - wz, xz + wy],
        [xy + wz, 1 - (xx + zz), yz - wx],
        [xz - wy, yz + wx, 1 - (xx + yy)]
    ];
}

/**
 * Unit quaternion of a rotation matrix (Shepperd's method). It divides by the
 * largest of the four components, so it stays accurate near 180 degrees. The
 * result has w >= 0; at exactly 180 degrees (w = 0) either sign may come back.
 * @param {number[][]} r - 3x3 rotation, rows
 * @returns {number[]} [x, y, z, w]
 */
export function matToQuat(r) {
    const m00 = r[0][0], m11 = r[1][1], m22 = r[2][2];
    const tr = m00 + m11 + m22;
    let x, y, z, w;
    if (tr >= m00 && tr >= m11 && tr >= m22) {
        const s = 2 * Math.sqrt(Math.max(0, 1 + tr));             // 4w
        w = 0.25 * s;
        x = (r[2][1] - r[1][2]) / s;
        y = (r[0][2] - r[2][0]) / s;
        z = (r[1][0] - r[0][1]) / s;
    } else if (m00 >= m11 && m00 >= m22) {
        const s = 2 * Math.sqrt(Math.max(0, 1 + m00 - m11 - m22)); // 4x
        w = (r[2][1] - r[1][2]) / s;
        x = 0.25 * s;
        y = (r[0][1] + r[1][0]) / s;
        z = (r[0][2] + r[2][0]) / s;
    } else if (m11 >= m22) {
        const s = 2 * Math.sqrt(Math.max(0, 1 + m11 - m00 - m22)); // 4y
        w = (r[0][2] - r[2][0]) / s;
        x = (r[0][1] + r[1][0]) / s;
        y = 0.25 * s;
        z = (r[1][2] + r[2][1]) / s;
    } else {
        const s = 2 * Math.sqrt(Math.max(0, 1 + m22 - m00 - m11)); // 4z
        w = (r[1][0] - r[0][1]) / s;
        x = (r[0][2] + r[2][0]) / s;
        y = (r[1][2] + r[2][1]) / s;
        z = 0.25 * s;
    }
    const q = quatNormalize([x, y, z, w]);
    return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}
