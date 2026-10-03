// js/survey/rigid-fit.js - Rigid control-point fit (Horn 1987) and its quality checks
// Pure: imports only linalg.js, so it loads in Node tests.
//
// Frames and conventions
// - P are model points in the export frame: Z-up metres, the numbers written as
//   meshnotes:wkt (pointToZUp of a storage point).
// - Q are surveyed points (E, N, H).
// - A fit maps model to survey: survey = R * p + t.
// - rotation is the unit quaternion [x, y, z, w] of R with w >= 0, matrix is R as
//   rows, translation is t = [tE, tN, tH].
// - Points may be given as arrays [x, y, z], {x, y, z} or {e, n, h} objects.
// - Both point sets are centred in double precision before anything else, so
//   seven-digit UTM values keep their millimetres.
// - The estimated scale is survey spread over model spread (RMS distance from
//   the centroid). It is a diagnostic only and never applied.
//
// Fit types: 'rigid6' (full rotation plus shift) and 'level4' (rotation about
// the vertical axis plus shift, for models that are already level).
//
// Data problems (TOO_FEW, COINCIDENT, COLLINEAR) come back as
// { ok: false, error, ... } because the UI shows them; bad arguments throw.

import {
    sub3, add3, norm3, mean3, matVec, det3,
    jacobiEigenSym, quatNormalize, quatToMat
} from './linalg.js';

// ============ Thresholds ============
// The plan's Thresholds table. The residual warning and the two surface
// distances are defaults of user settings; the RMS limits of the verdict stay
// fixed (only the residual warning, a setting, can turn Good into Check).

export const MIN_CONTROL_POINTS = 3;
export const RECOMMENDED_CONTROL_POINTS = 4;
export const MIN_SPREAD = 0.25;              // m, RMS distance of the survey points from their centroid
export const COLLINEAR_RATIO = 0.05;         // sqrt(lambda2 / lambda1) of the survey covariance: blocked below
export const WEAK_GEOMETRY_RATIO = 0.15;     // ... warning below
export const GOOD_RMS = 0.03;                // m
export const RESIDUAL_WARN_DEFAULT = 0.05;   // m, setting meshnotes_surveyResidualWarn
export const POOR_RMS = 0.15;                // m
export const LOO_MIN_ERROR = 0.05;           // m
export const LOO_MEDIAN_FACTOR = 3;
export const LOO_REST_RMS_MIN = 0.02;        // m, four points only (see findLooOutliers)
export const SCALE_WARN = 0.01;              // relative deviation of the estimated scale from 1
export const SCALE_ERROR = 0.05;
export const TILT_WARN_DEG = 5;
export const UP_AXIS_MIN_DEG = 60;
export const UP_AXIS_MAX_DEG = 120;          // above this the model is upside down
export const LEVEL_SUGGEST_DEG = 0.5;
export const SELECTION_LIMIT_DEFAULT = 0.5;  // m, setting meshnotes_surveySurfaceLimit
export const SURFACE_WARN_DEFAULT = 0.10;    // m, setting meshnotes_surveySurfaceWarn
export const SITE_EXTENT_WARN = 2000;        // m
export const DUPLICATE_TOLERANCE = 0.001;    // m

// Mirror and swap trial (not in the plan's table; they define "far better").
// The trial must at least halve the RMS, gain more than SWAP_RMS_MARGIN and
// explain the data (RMS within POOR_RMS, or a leave-one-out outlier found).
// When the fit is on its side or upside down, the upright trial only has to
// be no worse than the fit plus SWAP_RMS_MARGIN, or within GOOD_RMS (flat
// points fit equally well either way), and must not be poor itself.
export const SWAP_RMS_RATIO = 0.5;
export const SWAP_RMS_MARGIN = 0.001;        // m
export const UNIT_HINT_TOLERANCE = 0.05;     // relative distance of the scale from a unit factor

// ============ Flags and errors ============

// Error codes of a failed fit ({ ok: false, error }).
export const ERRORS = Object.freeze({
    TOO_FEW: 'TOO_FEW',          // fewer than MIN_CONTROL_POINTS pairs
    COINCIDENT: 'COINCIDENT',    // points bunched together (side: 'survey' or 'model')
    COLLINEAR: 'COLLINEAR'       // survey points in a line
});

// Flags in quality.flags. The values are stored with an alignment, so they
// must stay stable.
export const FLAGS = Object.freeze({
    NO_REDUNDANCY: 'NO_REDUNDANCY',     // exactly 3 points: a bad pick cannot be found
    LOO_OUTLIER: 'LOO_OUTLIER',         // indices in result.looOutliers
    WEAK_GEOMETRY: 'WEAK_GEOMETRY',     // points nearly in a line
    RESIDUAL_WARN: 'RESIDUAL_WARN',     // a residual exceeds the residualWarn option
    SCALE_WARN: 'SCALE_WARN',           // scale more than 1 % from 1
    SCALE_ERROR: 'SCALE_ERROR',         // scale more than 5 % from 1
    UNIT_HINT: 'UNIT_HINT',             // details in result.unitHint
    TILT_WARN: 'TILT_WARN',             // tilt 5 to 60 degrees
    UP_AXIS: 'UP_AXIS',                 // tilt 60 to 120 degrees: wrong up-axis at load?
    FLIPPED: 'FLIPPED',                 // tilt over 120 degrees
    MIRRORED: 'MIRRORED',               // a mirror image fits far better
    SWAPPED_EN: 'SWAPPED_EN',           // E and N look swapped; trial fit in result.swapTrial
    SITE_EXTENT: 'SITE_EXTENT',         // control points span more than 2 km
    LEVEL_SUGGESTED: 'LEVEL_SUGGESTED'  // informational: full fit with tilt under 0.5 degrees
});

// Flags that make the verdict 'poor'. For messages, SWAPPED_EN and MIRRORED
// explain FLIPPED or UP_AXIS when both are present, so show them first.
export const POOR_FLAGS = Object.freeze([
    FLAGS.MIRRORED, FLAGS.SWAPPED_EN, FLAGS.FLIPPED, FLAGS.UP_AXIS, FLAGS.SCALE_ERROR
]);

// Flags that are hints, not warnings. Every other flag is a warning.
// LEVEL_SUGGESTED is left out when a flag in POOR_FLAGS is present.
export const INFO_FLAGS = Object.freeze([FLAGS.LEVEL_SUGGESTED]);

export function isWarningFlag(flag) {
    return !INFO_FLAGS.includes(flag);
}

// ============ Unit hint ============
// The estimated scale is survey spread over model spread. A model in
// millimetres reads about 0.001 ("the model looks like mm"); a survey in feet
// reads about 3.28 ("the survey looks like ft").

const UNIT_FACTORS = [
    { unit: 'mm', factor: 0.001 },
    { unit: 'cm', factor: 0.01 },
    { unit: 'in', factor: 0.0254 },
    { unit: 'ft', factor: 0.3048 }
];

/**
 * Likely unit mix-up for an estimated scale, or null.
 * @param {number} scale - survey spread / model spread
 * @returns {{unit: string, side: 'model'|'survey', factor: number}|null}
 *   side 'model': the model seems to be in this unit; 'survey': the survey does.
 */
export function unitHintForScale(scale) {
    if (!(scale > 0) || !isFinite(scale)) return null;
    for (const { unit, factor } of UNIT_FACTORS) {
        if (Math.abs(scale / factor - 1) <= UNIT_HINT_TOLERANCE) return { unit, side: 'model', factor };
        if (Math.abs(scale * factor - 1) <= UNIT_HINT_TOLERANCE) return { unit, side: 'survey', factor: 1 / factor };
    }
    return null;
}

// ============ Point helpers ============

function toVec3(p) {
    let v;
    if (Array.isArray(p)) v = [p[0], p[1], p[2]];
    else if (p && p.e !== undefined) v = [p.e, p.n, p.h];
    else if (p) v = [p.x, p.y, p.z];
    if (!v || !v.every(c => typeof c === 'number' && isFinite(c))) {
        throw new TypeError('rigid-fit: every point needs three finite coordinates');
    }
    return v;
}

function toPoints(list) {
    if (!Array.isArray(list)) throw new TypeError('rigid-fit: a list of points is expected');
    return list.map(toVec3);
}

// Copies of the points with E and N exchanged, as arrays.
export function swapEN(points) {
    return toPoints(points).map(([e, n, h]) => [n, e, h]);
}

// RMS distance of centred points from the origin.
function rmsRadius(centred) {
    let s = 0;
    for (const p of centred) s += p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    return Math.sqrt(s / centred.length);
}

function median(values) {
    const v = values.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ============ Conditioning ============

function conditioningCentred(centred) {
    const n = centred.length;
    const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of centred) {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += p[i] * p[j] / n;
    }
    const values = jacobiEigenSym(c).values.map(v => Math.max(0, v));
    const spread = Math.sqrt(values[0] + values[1] + values[2]);
    const ratio = values[0] > 0 ? Math.sqrt(values[1] / values[0]) : 0;
    let error = null;
    if (spread < MIN_SPREAD) error = ERRORS.COINCIDENT;
    else if (ratio < COLLINEAR_RATIO) error = ERRORS.COLLINEAR;
    return { spread, ratio, eigenvalues: values, error, weak: ratio < WEAK_GEOMETRY_RATIO };
}

/**
 * Geometry check of a point set, from the eigenvalues l1 >= l2 >= l3 of its
 * covariance. spread = sqrt(l1 + l2 + l3), the RMS distance from the centroid;
 * ratio = sqrt(l2 / l1), 0 for points in a line. A flat set is valid.
 * @param {Array} points
 * @returns {{spread: number, ratio: number, eigenvalues: number[],
 *            error: string|null, weak: boolean}}
 *   error is ERRORS.COINCIDENT or ERRORS.COLLINEAR when the set cannot be used.
 */
export function conditioning(points) {
    const pts = toPoints(points);
    if (pts.length === 0) return { spread: 0, ratio: 0, eigenvalues: [0, 0, 0], error: ERRORS.COINCIDENT, weak: true };
    const c = mean3(pts);
    return conditioningCentred(pts.map(p => sub3(p, c)));
}

// ============ Fit core ============

// Solves one fit without diagnostics. P and Q are arrays of [x, y, z].
function fitCore(fitType, P, Q) {
    const n = P.length;
    if (n < MIN_CONTROL_POINTS) return { ok: false, error: ERRORS.TOO_FEW, n };

    const cp = mean3(P), cq = mean3(Q);
    const pc = P.map(p => sub3(p, cp));
    const qc = Q.map(q => sub3(q, cq));

    const cond = conditioningCentred(qc);
    if (cond.error) return { ok: false, error: cond.error, side: 'survey', n, conditioning: cond };
    const spreadP = rmsRadius(pc);
    if (!(spreadP > cond.spread * 1e-9)) {
        return { ok: false, error: ERRORS.COINCIDENT, side: 'model', n, conditioning: cond };
    }

    // S[a][b] = sum over i of p'_a * q'_b
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
        const p = pc[i], q = qc[i];
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += p[a] * q[b];
    }

    let rotation, detS;
    if (fitType === 'level4') {
        // Rotation about the vertical axis only.
        const theta = Math.atan2(S[0][1] - S[1][0], S[0][0] + S[1][1]);
        rotation = [0, 0, Math.sin(theta / 2), Math.cos(theta / 2)];
        detS = S[0][0] * S[1][1] - S[0][1] * S[1][0];   // horizontal part decides the mirror test
    } else {
        // Horn: the best rotation is the eigenvector [w, x, y, z] of the
        // largest eigenvalue of this symmetric 4x4 matrix.
        const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
        const N = [
            [xx + yy + zz, yz - zy, zx - xz, xy - yx],
            [yz - zy, xx - yy - zz, xy + yx, zx + xz],
            [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
            [xy - yx, zx + xz, yz + zy, -xx - yy + zz]
        ];
        const [w, x, y, z] = jacobiEigenSym(N).vectors[0];
        rotation = quatNormalize([x, y, z, w]);
        detS = det3(S);
    }
    if (rotation[3] < 0) rotation = rotation.map(c => -c);
    const R = quatToMat(rotation);
    const t = sub3(cq, matVec(R, cp));
    return { ok: true, rotation, R, t, detS, pc, qc, spreadP, conditioning: cond };
}

// Survey position predicted by a fit core for model point p.
function predict(core, p) {
    return add3(matVec(core.R, p), core.t);
}

// ============ Leave-one-out ============

// One leave-one-out pass: for each point, the fit of the others, the error of
// the left-out point against it, and the RMS of the others in that fit.
// Entries are null where the remaining points cannot be fitted.
function looPass(fitType, P, Q) {
    return P.map((p, i) => {
        const restP = P.filter((_, j) => j !== i);
        const restQ = Q.filter((_, j) => j !== i);
        const core = fitCore(fitType, restP, restQ);
        if (!core.ok) return null;
        let sum = 0;
        for (let j = 0; j < restP.length; j++) {
            const r = sub3(restQ[j], predict(core, restP[j]));
            sum += r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
        }
        return { error: norm3(sub3(Q[i], predict(core, p))), restRms: Math.sqrt(sum / restP.length) };
    });
}

/**
 * Leave-one-out errors: each point is left out of the fit in turn and the
 * distance between its survey position and its prediction is measured.
 * @returns {Array<number|null>|null} one error per point (null where the
 *   remaining points cannot be fitted), or null for fewer than 4 points
 */
export function leaveOneOut(P, Q, fitType = 'rigid6') {
    const pts = toPoints(P), sur = toPoints(Q);
    if (pts.length !== sur.length) throw new RangeError('rigid-fit: P and Q differ in length');
    if (pts.length <= MIN_CONTROL_POINTS) return null;
    return looPass(fitType, pts, sur).map(r => (r ? r.error : null));
}

// Points flagged by leave-one-out, one at a time. The candidate is the point
// whose removal leaves the best fit of the others. It is flagged when its
// error exceeds LOO_MIN_ERROR and LOO_MEDIAN_FACTOR times the median
// leave-one-out error of the remaining points, computed without it. The
// search then repeats on the remaining points. Taking the median over all
// points instead lets the bad pick inflate the median it is compared with:
// on six points that missed a 0.5 m error about half the time.
// With four points the remaining three cannot be tested again, and the other
// first-pass errors all come from fits that still contain the bad pick. So
// the fits are compared instead: the candidate is flagged when leaving out
// any other point leaves an RMS over LOO_MEDIAN_FACTOR times the candidate's
// and over LOO_REST_RMS_MIN. The median rule found a 0.5 m error among four
// points in about one case in six; this one finds it in nearly all.
function findLooOutliers(fitType, P, Q, firstPass) {
    let idx = P.map((_, i) => i);
    let pass = firstPass;
    const outliers = [];
    while (idx.length > MIN_CONTROL_POINTS) {
        let c = -1;
        pass.forEach((r, i) => { if (r && (c < 0 || r.restRms < pass[c].restRms)) c = i; });
        if (c < 0 || !(pass[c].error > LOO_MIN_ERROR)) break;

        const rest = idx.filter((_, i) => i !== c);
        let restPass = null;
        let flagged;
        if (rest.length > MIN_CONTROL_POINTS) {
            restPass = looPass(fitType, rest.map(i => P[i]), rest.map(i => Q[i]));
            const reference = restPass.filter(r => r).map(r => r.error);
            flagged = reference.length > 0 && pass[c].error > LOO_MEDIAN_FACTOR * median(reference);
        } else {
            // Four points: compare the fits of the other three.
            const others = pass.filter((r, i) => r && i !== c).map(r => r.restRms);
            const limit = Math.max(LOO_MEDIAN_FACTOR * pass[c].restRms, LOO_REST_RMS_MIN);
            flagged = others.length > 0 && Math.min(...others) > limit;
        }
        if (!flagged) break;

        outliers.push(idx[c]);
        if (!restPass) break;
        idx = rest;
        pass = restPass;
    }
    return outliers.sort((a, b) => a - b);
}

// ============ Angles ============

const DEG = 180 / Math.PI;

/**
 * Tilt in degrees: the angle between the model's up-axis mapped into the
 * survey frame, R * (0, 0, 1), and the survey's up-axis.
 */
export function tiltFromMatrix(R) {
    return Math.atan2(Math.hypot(R[0][2], R[1][2]), R[2][2]) * DEG;
}

/**
 * Heading in degrees, [0, 360): the azimuth, clockwise from survey north, of
 * the model's +Y axis mapped into the survey frame, R * (0, 1, 0). A model
 * whose +Y already points north reads 0; one turned a quarter turn clockwise
 * (+Y pointing east) reads 90.
 */
export function headingFromMatrix(R) {
    let h = Math.atan2(R[0][1], R[1][1]) * DEG;
    if (h < 0) h += 360;
    if (h >= 360) h -= 360;
    return h;
}

// ============ Solving ============

/**
 * Fits P (model, export frame) to Q (survey) and runs every quality check.
 *
 * @param {Array} P - model points
 * @param {Array} Q - survey points, same order and length as P
 * @param {'rigid6'|'level4'} [fitType]
 * @param {{residualWarn?: number, swapCheck?: boolean}} [options]
 *   residualWarn: per-point residual that raises RESIDUAL_WARN (the setting);
 *   swapCheck: false skips the E/N swap trial (used for the trial itself).
 * @returns {object} On failure { ok: false, error, n, side?, conditioning? }.
 *   On success {
 *     ok: true, fitType, rotation: [x,y,z,w], matrix: 3x3, translation: [tE,tN,tH],
 *     quality: { n, rms, rmsH, rmsV, maxResidual, scale, tiltDeg, headingDeg, flags },
 *     residuals: [[dE,dN,dH], ...]   (survey minus prediction, in input order),
 *     residualNorms: [...]           (3D length of each residual),
 *     looErrors: [...]|null          (leaveOneOut(); null for 3 points),
 *     looOutliers: [indices]         (points flagged by leave-one-out, ascending),
 *     unitHint: {unit, side, factor}|null, conditioning: {spread, ratio, eigenvalues, error, weak},
 *     extent (largest distance between two survey points), detS,
 *     swapTrial: the same fit with E and N swapped (its own swapTrial is null),
 *                or null when the trial did not run
 *   }
 */
export function solveFit(P, Q, fitType = 'rigid6', options = {}) {
    if (fitType !== 'rigid6' && fitType !== 'level4') throw new RangeError(`rigid-fit: unknown fit type ${fitType}`);
    const { residualWarn = RESIDUAL_WARN_DEFAULT, swapCheck = true } = options;
    const pts = toPoints(P), sur = toPoints(Q);
    if (pts.length !== sur.length) throw new RangeError('rigid-fit: P and Q differ in length');

    const core = fitCore(fitType, pts, sur);
    if (!core.ok) return core;
    const n = pts.length;
    const R = core.R;

    // Residuals: survey minus prediction.
    const residuals = pts.map((p, i) => sub3(sur[i], predict(core, p)));
    const residualNorms = residuals.map(norm3);
    let sumH = 0, sumV = 0;
    for (const [dE, dN, dH] of residuals) {
        sumH += dE * dE + dN * dN;
        sumV += dH * dH;
    }
    const rmsH = Math.sqrt(sumH / n);
    const rmsV = Math.sqrt(sumV / n);
    const rms = Math.sqrt((sumH + sumV) / n);
    const maxResidual = Math.max(...residualNorms);

    const scale = rmsRadius(core.qc) / core.spreadP;
    const tiltDeg = tiltFromMatrix(R);
    const headingDeg = headingFromMatrix(R);
    const unitHint = unitHintForScale(scale);

    let extent = 0;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) extent = Math.max(extent, norm3(sub3(sur[i], sur[j])));
    }

    let looErrors = null;
    let looOutliers = [];
    if (n > MIN_CONTROL_POINTS) {
        const pass = looPass(fitType, pts, sur);
        looErrors = pass.map(r => (r ? r.error : null));
        looOutliers = findLooOutliers(fitType, pts, sur, pass);
    }

    const flags = [];
    if (n === MIN_CONTROL_POINTS) flags.push(FLAGS.NO_REDUNDANCY);
    if (looOutliers.length) flags.push(FLAGS.LOO_OUTLIER);
    if (core.conditioning.weak) flags.push(FLAGS.WEAK_GEOMETRY);
    if (maxResidual > residualWarn) flags.push(FLAGS.RESIDUAL_WARN);
    const scaleDev = Math.abs(scale - 1);
    if (scaleDev > SCALE_ERROR) flags.push(FLAGS.SCALE_ERROR);
    else if (scaleDev > SCALE_WARN) flags.push(FLAGS.SCALE_WARN);
    if (unitHint) flags.push(FLAGS.UNIT_HINT);
    if (tiltDeg > UP_AXIS_MAX_DEG) flags.push(FLAGS.FLIPPED);
    else if (tiltDeg >= UP_AXIS_MIN_DEG) flags.push(FLAGS.UP_AXIS);
    else if (tiltDeg > TILT_WARN_DEG) flags.push(FLAGS.TILT_WARN);

    // Mirror and swap. A rotation cannot reproduce a mirror image, so a mirror
    // shows up either as a poor fit with det(S) < 0 (points with height
    // variation) or as a good fit turned upside down or on its side (flat
    // points, and three points, which always lie in a plane). In these cases
    // the fit is tried again with E and N exchanged; that trial is the best
    // mirror-image fit there is. A trial that is itself poor explains nothing:
    // two picks in the wrong order often give an upside-down fit and an
    // equally poor upright trial.
    let swapTrial = null;
    const wrongUp = tiltDeg >= UP_AXIS_MIN_DEG;
    if (swapCheck && (core.detS < 0 || wrongUp)) {
        const trial = solveFit(pts, swapEN(sur), fitType, { residualWarn, swapCheck: false });
        if (trial.ok) {
            swapTrial = trial;
            const trialRms = trial.quality.rms;
            // The trial explains the data when it is not poor, or when its
            // leave-one-out finds the bad pick that keeps it poor.
            const explains = trialRms <= POOR_RMS || trial.looOutliers.length > 0;
            const farBetter = trialRms <= SWAP_RMS_RATIO * rms && rms - trialRms > SWAP_RMS_MARGIN && explains;
            const asGood = trialRms <= Math.max(rms + SWAP_RMS_MARGIN, GOOD_RMS) && trialRms <= POOR_RMS;
            const upright = trial.quality.tiltDeg < UP_AXIS_MIN_DEG;
            if (upright && (farBetter || (wrongUp && asGood))) flags.push(FLAGS.SWAPPED_EN);
            else if (farBetter) flags.push(FLAGS.MIRRORED);
        }
    }

    if (extent > SITE_EXTENT_WARN) flags.push(FLAGS.SITE_EXTENT);
    // A level fit is only worth suggesting when the full fit is usable.
    if (fitType === 'rigid6' && tiltDeg < LEVEL_SUGGEST_DEG && !flags.some(f => POOR_FLAGS.includes(f))) {
        flags.push(FLAGS.LEVEL_SUGGESTED);
    }

    return {
        ok: true,
        fitType,
        rotation: core.rotation,
        matrix: R,
        translation: core.t,
        quality: { n, rms, rmsH, rmsV, maxResidual, scale, tiltDeg, headingDeg, flags },
        residuals,
        residualNorms,
        looErrors,
        looOutliers,
        unitHint,
        conditioning: core.conditioning,
        extent,
        detS: core.detS,
        swapTrial
    };
}

// Full fit: rotation and shift (6 degrees of freedom), scale fixed at 1.
export function solveRigid(P, Q, options) {
    return solveFit(P, Q, 'rigid6', options);
}

// Level-only fit: rotation about the vertical axis and shift (4 degrees of
// freedom). theta = atan2(sum(p'x q'y - p'y q'x), sum(p'x q'x + p'y q'y)).
export function solveLevel(P, Q, options) {
    return solveFit(P, Q, 'level4', options);
}

// Both fits on the same pairs, for the side-by-side RMS in the review step.
// levelSuggested repeats the LEVEL_SUGGESTED flag of the full fit.
export function solveBoth(P, Q, options) {
    const rigid6 = solveRigid(P, Q, options);
    const level4 = solveLevel(P, Q, options);
    const levelSuggested = rigid6.ok && rigid6.quality.flags.includes(FLAGS.LEVEL_SUGGESTED);
    return { rigid6, level4, levelSuggested };
}

// ============ Verdict ============

/**
 * Verdict for the review step.
 * - 'poor': failed fit, RMS over POOR_RMS, or a flag in POOR_FLAGS
 * - 'good': RMS up to GOOD_RMS, at least RECOMMENDED_CONTROL_POINTS points and
 *   no warning flag (LEVEL_SUGGESTED is a hint, not a warning)
 * - 'check': everything else, including exactly 3 points and any warning
 * @param {object} fit - a solveFit result, or a saved quality object
 * @returns {'good'|'check'|'poor'}
 */
export function fitVerdict(fit) {
    if (!fit || fit.ok === false) return 'poor';
    const q = fit.quality || fit;
    const flags = q.flags || [];
    if (!(q.rms <= POOR_RMS) || flags.some(f => POOR_FLAGS.includes(f))) return 'poor';
    if (q.rms <= GOOD_RMS && q.n >= RECOMMENDED_CONTROL_POINTS && !flags.some(isWarningFlag)) return 'good';
    return 'check';
}
