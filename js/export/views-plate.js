// js/export/views-plate.js — six-view plate ("unfolded cube") export
//
// Renders the model from the six axis directions and arranges them in the
// cross/net layout used for archaeological object plates:
//
//                 [ Top ]
//   [ Back ] [ Left ] [ Front ] [ Right ]
//                [ Bottom ]
//
// All six views share one camera frustum, so they share one scale by
// construction and a single scale bar below the block is true for the whole
// plate. Output is either a transparent PNG or a PDF page (fit to page).
//
// This module is the single implementation behind both the standalone plate
// export and the "Axis Views" page of the PDF report.

import * as THREE from 'three';
import { state, dom } from '../state.js';
import { showStatus, delay } from '../utils/helpers.js';
import { saveCameraPose, restoreCameraPose, toggleCamera } from '../core/camera.js';
import { updateFixedLightDirection } from '../core/lighting.js';
import { showScalebarConfirm } from '../annotation-tools/data.js';
import { captureAtSize } from './render-capture.js';
import { getPdfPageConfig } from './pdf-layout.js';
import {
    computeScalebarParams,
    formatScalebarLabel,
    autoScalebarColor,
    drawScalebarOnCanvas,
    drawScalebarOnPdf,
    scalebarBlockHeight,
    scalebarBlockHeightMm
} from './scalebar.js';

// Grid positions follow the net above: row 1 = Top over Front, row 2 = the
// horizontal strip with Back as the left-hand tail, row 3 = Bottom under Front.
//
// Directions and up-vectors are in internal Three.js Y-up space. Every view in
// the strip keeps up = +Y, so the model stays upright and the Back view needs
// no 180-degree correction (unlike GigaMesh, which tips the object over a
// horizontal axis to produce it).
//
// Top and Bottom take up = +Z and -Z respectively. Both give a screen-right of
// -X, matching the strip; the mirrored pair (-Z / +Z) that this code used
// before v1.4.0 put screen-right at +X, i.e. rotated 180 degrees against the
// rest of the net, which only showed on clearly asymmetric objects.
export const PLATE_VIEWS = [
    { name: 'Top',    col: 2, row: 0, dir: new THREE.Vector3(0, 1, 0),  up: new THREE.Vector3(0, 0, 1) },
    { name: 'Back',   col: 0, row: 1, dir: new THREE.Vector3(0, 0, 1),  up: new THREE.Vector3(0, 1, 0) },
    { name: 'Left',   col: 1, row: 1, dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
    { name: 'Front',  col: 2, row: 1, dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) },
    { name: 'Right',  col: 3, row: 1, dir: new THREE.Vector3(1, 0, 0),  up: new THREE.Vector3(0, 1, 0) },
    { name: 'Bottom', col: 2, row: 2, dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1) }
];

export const PLATE_COLS = 4;
export const PLATE_ROWS = 3;

/**
 * Works out the shared frustum for the six views.
 *
 * Framing is always derived from the model's bounding box, never from the live
 * camera. A plate is a normed figure: two exports of the same object, or two
 * objects in the same publication, have to be directly comparable, which rules
 * out anything that depends on where the user happened to be zoomed.
 *
 * @param {{cellShape?: string}} [opts] - 'fit' (default) or 'square'
 * @returns {Object|null} framing descriptor, or null if no model is loaded
 */
export function getPlateFraming(opts = {}) {
    if (!state.currentModel) return null;

    const cellShape = opts.cellShape === 'square' ? 'square' : 'fit';

    const box = new THREE.Box3().setFromObject(state.currentModel);
    const size = box.getSize(new THREE.Vector3());
    const target = box.getCenter(new THREE.Vector3());

    // One frustum shared by all six views, so they share one scale and the
    // single scale bar below the block is true for the whole plate.
    //
    // Each view projects a different pair of bounding-box dimensions:
    //   Front / Back  ->  X wide, Y high
    //   Left / Right  ->  Z wide, Y high
    //   Top / Bottom  ->  X wide, Z high
    // so the shared half-extents are the worst case of each pair. Fitting every
    // view to its own extents would pack each cell tighter, but the views would
    // then be at different scales, which one scale bar cannot describe.
    const MARGIN = 1.03;
    let halfW = (Math.max(size.x, size.z) / 2) * MARGIN;
    let halfH = (Math.max(size.y, size.z) / 2) * MARGIN;

    // Guard flat or degenerate geometry (a plane has a zero extent on one axis).
    if (!(halfW > 0)) halfW = 1;
    if (!(halfH > 0)) halfH = 1;

    // Square cells equalise to the larger half-extent, adding empty margin
    // rather than cropping. Needed by the PDF report, whose grid cells are
    // square, and available as a setting for a tidier grid.
    if (cellShape === 'square') {
        const half = Math.max(halfW, halfH);
        halfW = half;
        halfH = half;
    }

    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    return {
        target,
        halfW,
        halfH,
        distance: maxDim * 1.8,
        frustumWidth: halfW * 2,
        aspect: halfW / halfH
    };
}

/**
 * Renders the six views into canvases at a given cell width.
 *
 * @param {Object} params
 * @param {Object} params.framing - from getPlateFraming()
 * @param {number} params.cellWidthPx
 * @param {boolean} [params.transparent=false]
 * @returns {Promise<{views: Array, cellW: number, cellH: number, frustumWidth: number}>}
 */
export async function renderSixViews({ framing, cellWidthPx, transparent = false }) {
    const { target, halfW, halfH, distance } = framing;

    const cellW = Math.max(1, Math.round(cellWidthPx));
    const cellH = Math.max(1, Math.round(cellW * halfH / halfW));

    const savedPose = saveCameraPose();
    const savedLightMode = state.lightFollowsCamera;

    // A perspective camera cannot use the frustum directly, so pull it back far
    // enough that the same extents fill the frame. Orthographic is the norm for
    // a plate; this only matters when the user declined the switch.
    const cellAspect = cellW / cellH;
    let perspectiveDistance = distance;
    if (!state.isOrthographic) {
        const halfFov = THREE.MathUtils.degToRad(state.camera.fov) / 2;
        const distForHeight = halfH / Math.tan(halfFov);
        const distForWidth = halfW / (Math.tan(halfFov) * cellAspect);
        perspectiveDistance = Math.max(distForHeight, distForWidth) + distance * 0.1;
    }

    // Camera-linked lighting for all six views, so faces are lit consistently
    // regardless of the user's current light setting.
    state.lightFollowsCamera = true;

    const views = [];

    for (const view of PLATE_VIEWS) {
        const dist = state.isOrthographic ? distance : perspectiveDistance;

        state.camera.up.copy(view.up);
        state.camera.position.copy(target).addScaledVector(view.dir, dist);
        state.controls.target.copy(target);
        state.camera.lookAt(target);

        if (state.isOrthographic) {
            state.camera.left = -halfW;
            state.camera.right = halfW;
            state.camera.top = halfH;
            state.camera.bottom = -halfH;
            state.camera.zoom = 1;
        } else {
            state.camera.aspect = cellAspect;
        }
        state.camera.updateProjectionMatrix();

        // Yield a frame so the animation loop can re-aim the camera-linked
        // light at the new camera position before we capture.
        await delay(50);

        views.push({
            name: view.name,
            col: view.col,
            row: view.row,
            canvas: captureAtSize(cellW, cellH, { transparent })
        });
    }

    restoreCameraPose(savedPose);
    state.lightFollowsCamera = savedLightMode;
    if (!state.lightFollowsCamera) {
        updateFixedLightDirection();
    }
    state.renderer.render(state.scene, state.camera);

    return { views, cellW, cellH, frustumWidth: halfW * 2 };
}

// ============ Entry points ============

/**
 * Opens the format chooser. The actual export starts once the user picks PNG
 * or PDF; both paths then share the same orthographic check and renderer.
 */
export function exportViewsPlate() {
    if (!state.currentModel) {
        showStatus('No model loaded');
        return;
    }
    dom.plateFormatOverlay.classList.add('visible');
}

export function hidePlateFormatDialog() {
    dom.plateFormatOverlay.classList.remove('visible');
}

export function choosePlateFormat(format) {
    hidePlateFormatDialog();
    startPlateExport(format === 'pdf' ? doExportViewsPdf : doExportViewsPng);
}

/**
 * Shared entry guard: requires a model, and offers to switch to orthographic
 * when in perspective — the same flow the Screenshot button uses.
 * @param {Function} run - receives includeScalebar
 */
function startPlateExport(run) {
    if (!state.currentModel) {
        showStatus('No model loaded');
        return;
    }

    if (!state.isOrthographic) {
        showScalebarConfirm(
            () => {
                toggleCamera();
                setTimeout(() => run(true), 100);
            },
            () => run(false)
        );
    } else {
        run(true);
    }
}

// ============ PNG plate ============

async function doExportViewsPng(includeScalebar) {
    showStatus('Rendering six-view plate...');

    const framing = getPlateFraming({ cellShape: state.plateCellShape });
    if (!framing) return;

    // Gaps are proportional so the plate looks identical at any resolution.
    // Total width = 4 cells + 3 inner gaps + 2 outer margins, margin = gap.
    const gapFraction = 0.03;
    const plateWidth = state.platePngWidth || 4000;
    const cellWidthPx = Math.floor(plateWidth / (PLATE_COLS + 5 * gapFraction));
    const gap = Math.max(1, Math.round(cellWidthPx * gapFraction));

    const { views, cellW, cellH, frustumWidth } = await renderSixViews({
        framing,
        cellWidthPx,
        transparent: true
    });

    const margin = gap;
    const gridW = PLATE_COLS * cellW + (PLATE_COLS - 1) * gap;
    const gridH = PLATE_ROWS * cellH + (PLATE_ROWS - 1) * gap;

    const barScale = Math.max(1, cellW / 500);
    const params = includeScalebar && state.isOrthographic
        ? computeScalebarParams(cellW, frustumWidth)
        : null;
    const barGap = gap * 2;
    const barBlock = params ? scalebarBlockHeight(barScale) : 0;

    const plate = document.createElement('canvas');
    plate.width = margin * 2 + gridW;
    plate.height = margin * 2 + gridH + (params ? barGap + barBlock : 0);
    const ctx = plate.getContext('2d');

    // Left transparent on purpose — no background fill.
    for (const view of views) {
        const x = margin + view.col * (cellW + gap);
        const y = margin + view.row * (cellH + gap);
        ctx.drawImage(view.canvas, x, y);
    }

    if (params) {
        drawScalebarOnCanvas(plate, {
            barPx: params.pixelWidth,
            label: formatScalebarLabel(params.units),
            scale: barScale,
            color: autoScalebarColor({ transparent: true }),
            x: margin,
            y: margin + gridH + barGap
        });
    }

    downloadCanvasPng(plate);
}

function downloadCanvasPng(canvas) {
    const base = (state.modelFileName || 'model').replace(/\.[^.]+$/, '');
    const name = `meshnotes-views-${base}-${Date.now()}.png`;

    canvas.toBlob(blob => {
        const link = document.createElement('a');
        link.download = name;

        if (!blob) {
            link.href = canvas.toDataURL('image/png');
            link.click();
        } else {
            const url = URL.createObjectURL(blob);
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        showStatus('Six-view plate saved');
    }, 'image/png');
}

// ============ PDF plate ============

async function doExportViewsPdf(includeScalebar) {
    showStatus('Rendering six-view plate...');

    const framing = getPlateFraming({ cellShape: state.plateCellShape });
    if (!framing) return;

    const pageConfig = getPdfPageConfig();
    const margin = 15;
    const gapMm = 5.5;
    const availW = pageConfig.pageWidth - 2 * margin;
    const availH = pageConfig.pageHeight - 2 * margin;

    const withBar = includeScalebar && state.isOrthographic;
    const barGapMm = 6;
    const barBlockMm = withBar ? barGapMm + scalebarBlockHeightMm() : 0;

    // Fit to page: uniform scale, limited by whichever of width or height binds
    // first. This mirrors adjustbox's max width / max height behaviour, and the
    // scale bar shrinks with the images so it stays true either way.
    const byWidth = (availW - (PLATE_COLS - 1) * gapMm) / PLATE_COLS;
    const byHeight = ((availH - (PLATE_ROWS - 1) * gapMm - barBlockMm) / PLATE_ROWS) * framing.aspect;
    const cellWmm = Math.min(byWidth, byHeight);
    const cellHmm = cellWmm / framing.aspect;

    const dpi = state.pdfDpi || 150;
    const cellWidthPx = Math.max(1, Math.round((cellWmm / 25.4) * dpi));

    const { views, frustumWidth } = await renderSixViews({
        framing,
        cellWidthPx,
        transparent: true
    });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF(pageConfig.orientation, 'mm', pageConfig.format);

    const blockW = PLATE_COLS * cellWmm + (PLATE_COLS - 1) * gapMm;
    const blockH = PLATE_ROWS * cellHmm + (PLATE_ROWS - 1) * gapMm + barBlockMm;
    const originX = margin + (availW - blockW) / 2;
    const originY = margin + (availH - blockH) / 2;

    for (const view of views) {
        const x = originX + view.col * (cellWmm + gapMm);
        const y = originY + view.row * (cellHmm + gapMm);
        pdf.addImage(view.canvas.toDataURL('image/png'), 'PNG', x, y, cellWmm, cellHmm);
    }

    if (withBar) {
        // computeScalebarParams is unit-agnostic: feed it millimetres and it
        // returns the bar length in millimetres.
        const params = computeScalebarParams(cellWmm, frustumWidth);
        if (params) {
            drawScalebarOnPdf(pdf, {
                x: originX,
                y: originY + PLATE_ROWS * cellHmm + (PLATE_ROWS - 1) * gapMm + barGapMm,
                barMm: params.pixelWidth,
                label: formatScalebarLabel(params.units)
            });
        }
    }

    const base = (state.modelFileName || 'model').replace(/\.[^.]+$/, '');
    pdf.save(`meshnotes-views-${base}-${Date.now()}.pdf`);
    showStatus('Six-view plate exported');
}
