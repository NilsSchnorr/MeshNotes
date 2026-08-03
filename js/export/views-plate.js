// js/export/views-plate.js — six-view plate ("unfolded cube") export
//
// Renders the model from the six axis directions and arranges them in the
// cross/net layout used for archaeological object plates:
//
//                 [ Top ]
//   [ Back ] [ Left ] [ Front ] [ Right ]
//                [ Bottom ]
//
// The layout is a TRUE net: every cell is exactly the size of the face it
// shows, so the plate packs tightly and the six views still share one scale.
//
// The unit that ties everything together is `ppu` — output pixels per model
// unit. Cell sizes, image sizes and the scale bar are all derived from it, so
// a shared scale holds by construction rather than by reading the camera back.
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

// Grid positions follow the net above: row 1 = the horizontal strip with Back
// as the left-hand tail, Top and Bottom above and below Front.
//
// Directions and up-vectors are in internal Three.js Y-up space. Every view in
// the strip keeps up = +Y, so the model stays upright and the Back view needs
// no 180-degree correction (unlike GigaMesh, which tips the object over a
// horizontal axis to produce it).
//
// wAxis / hAxis record which bounding-box dimensions each view projects onto
// the horizontal and vertical of its image. Working these out from the up
// vectors: Front/Back show X across and Y up, Left/Right show Z across and Y
// up, Top/Bottom show X across and Z up. That is what makes the net tile
// exactly — the four strip cells are sx, sz, sx, sz wide, and the three rows
// are sz, sy, sz high.
export const PLATE_VIEWS = [
    { name: 'Top',    col: 2, row: 0, dir: new THREE.Vector3(0, 1, 0),  up: new THREE.Vector3(0, 0, 1),  wAxis: 'x', hAxis: 'z' },
    { name: 'Back',   col: 0, row: 1, dir: new THREE.Vector3(0, 0, 1),  up: new THREE.Vector3(0, 1, 0),  wAxis: 'x', hAxis: 'y' },
    { name: 'Left',   col: 1, row: 1, dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0),  wAxis: 'z', hAxis: 'y' },
    { name: 'Front',  col: 2, row: 1, dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0),  wAxis: 'x', hAxis: 'y' },
    { name: 'Right',  col: 3, row: 1, dir: new THREE.Vector3(1, 0, 0),  up: new THREE.Vector3(0, 1, 0),  wAxis: 'z', hAxis: 'y' },
    { name: 'Bottom', col: 2, row: 2, dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1), wAxis: 'x', hAxis: 'z' }
];

export const PLATE_COLS = 4;
export const PLATE_ROWS = 3;

// Breathing room around each face and between cells, as fractions of the
// model's largest dimension.
const PAD_FRACTION = 0.02;
const GAP_FRACTION = 0.025;

// Conservative canvas ceilings. Browsers reject canvases beyond roughly
// 16384 px on a side, and very large areas fail on memory long before that.
const MAX_CANVAS_DIM = 16000;
const MAX_CANVAS_AREA = 150e6;

/**
 * Bounding box of everything the model actually draws.
 *
 * Box3.setFromObject() includes meshes whose `visible` flag is false, so a
 * model carrying hidden geometry (a proxy mesh, a disabled scan chunk, a
 * hidden node left in by the exporter) frames as though that geometry were
 * there — the object is rendered small inside a frustum sized for something
 * invisible. traverseVisible() skips those subtrees, so the box matches what
 * ends up in the image.
 *
 * @returns {THREE.Box3}
 */
export function getVisibleModelBox() {
    const box = new THREE.Box3();
    const childBox = new THREE.Box3();

    state.currentModel.updateWorldMatrix(false, true);
    state.currentModel.traverseVisible(obj => {
        const geom = obj.geometry;
        if (!geom || !(obj.isMesh || obj.isPoints || obj.isLine)) return;
        if (!geom.boundingBox) geom.computeBoundingBox();
        if (!geom.boundingBox) return;
        childBox.copy(geom.boundingBox).applyMatrix4(obj.matrixWorld);
        box.union(childBox);
    });

    // Fall back to the whole object if nothing visible was found, so a model
    // that is entirely hidden still exports something rather than nothing.
    if (box.isEmpty()) box.setFromObject(state.currentModel);
    return box;
}

/**
 * Works out the per-view frustums.
 *
 * Framing is derived from the model's bounding box, never from the live
 * camera. A plate is a normed figure: two exports of the same object, or two
 * objects in the same publication, have to be directly comparable, which rules
 * out anything that depends on where the user happened to be zoomed.
 *
 * Modes:
 *   'net'     — each view framed to the face it shows (tight; the default)
 *   'uniform' — all views share the worst-case extents
 *   'square'  — all views share a square frustum (the PDF report's grid)
 *
 * Note that a shared *scale* does not require a shared *frustum*. Giving each
 * view its own extents and rendering all of them at one pixels-per-unit keeps
 * the scale bar valid while removing the dead margin that a single worst-case
 * frustum forces onto every cell.
 *
 * @param {{mode?: string}} [opts]
 * @returns {Object|null} framing descriptor, or null if no model is loaded
 */
export function getPlateFraming(opts = {}) {
    if (!state.currentModel) return null;

    const mode = opts.mode || 'net';

    const box = getVisibleModelBox();
    const size = box.getSize(new THREE.Vector3());
    const target = box.getCenter(new THREE.Vector3());

    const dims = {
        x: Math.max(size.x, 1e-6),
        y: Math.max(size.y, 1e-6),
        z: Math.max(size.z, 1e-6)
    };
    const maxDim = Math.max(dims.x, dims.y, dims.z);
    const pad = maxDim * PAD_FRACTION;

    const views = PLATE_VIEWS.map(v => {
        let w;
        let h;
        if (mode === 'square') {
            w = maxDim;
            h = maxDim;
        } else if (mode === 'uniform') {
            w = Math.max(dims.x, dims.z);
            h = Math.max(dims.y, dims.z);
        } else {
            w = dims[v.wAxis];
            h = dims[v.hAxis];
        }
        return { ...v, halfW: w / 2 + pad, halfH: h / 2 + pad };
    });

    // Column widths and row heights, in model units. In every mode each column
    // holds views of one width and each row views of one height, so the net
    // tiles without slack.
    const cols = [];
    for (let c = 0; c < PLATE_COLS; c++) {
        cols.push(Math.max(...views.filter(v => v.col === c).map(v => v.halfW * 2)));
    }
    const rows = [];
    for (let r = 0; r < PLATE_ROWS; r++) {
        rows.push(Math.max(...views.filter(v => v.row === r).map(v => v.halfH * 2)));
    }

    return {
        target,
        views,
        cols,
        rows,
        maxDim,
        gap: maxDim * GAP_FRACTION,
        distance: maxDim * 1.8,
        blockWidth: cols.reduce((a, b) => a + b, 0),
        blockHeight: rows.reduce((a, b) => a + b, 0)
    };
}

/**
 * Renders the six views at a given pixels-per-unit.
 *
 * @param {Object} params
 * @param {Object} params.framing - from getPlateFraming()
 * @param {number} params.ppu - output pixels per model unit
 * @param {boolean} [params.transparent=false]
 * @returns {Promise<{views: Array}>}
 */
export async function renderSixViews({ framing, ppu, transparent = false }) {
    const { target, distance, views } = framing;

    const savedPose = saveCameraPose();
    const savedLightMode = state.lightFollowsCamera;

    // Camera-linked lighting for all six views, so faces are lit consistently
    // regardless of the user's current light setting.
    state.lightFollowsCamera = true;

    const out = [];

    for (const view of views) {
        const wPx = Math.max(1, Math.round(view.halfW * 2 * ppu));
        const hPx = Math.max(1, Math.round(view.halfH * 2 * ppu));
        const aspect = wPx / hPx;

        // A perspective camera cannot take the frustum directly, so pull it
        // back far enough that the same extents fill the frame. Orthographic
        // is the norm for a plate; this only matters when the user declined
        // the switch.
        let dist = distance;
        if (!state.isOrthographic) {
            const halfFov = THREE.MathUtils.degToRad(state.camera.fov) / 2;
            dist = Math.max(
                view.halfH / Math.tan(halfFov),
                view.halfW / (Math.tan(halfFov) * aspect)
            ) + distance * 0.1;
        }

        state.camera.up.copy(view.up);
        state.camera.position.copy(target).addScaledVector(view.dir, dist);
        state.controls.target.copy(target);
        state.camera.lookAt(target);

        if (state.isOrthographic) {
            state.camera.left = -view.halfW;
            state.camera.right = view.halfW;
            state.camera.top = view.halfH;
            state.camera.bottom = -view.halfH;
            state.camera.zoom = 1;
        } else {
            state.camera.aspect = aspect;
        }
        state.camera.updateProjectionMatrix();

        // Yield a frame so the animation loop can re-aim the camera-linked
        // light at the new camera position before we capture.
        await delay(50);

        out.push({
            name: view.name,
            col: view.col,
            row: view.row,
            widthPx: wPx,
            heightPx: hPx,
            canvas: captureAtSize(wPx, hPx, { transparent })
        });
    }

    restoreCameraPose(savedPose);
    state.lightFollowsCamera = savedLightMode;
    if (!state.lightFollowsCamera) {
        updateFixedLightDirection();
    }
    state.renderer.render(state.scene, state.camera);

    return { views: out };
}

/**
 * Scale-bar length for a plate, sized against the widest column so the bar
 * stays a sensible fraction of the figure.
 * @param {Object} framing
 * @param {number} scale - pixels (or mm) per model unit
 * @returns {{units: number, pixelWidth: number}|null}
 */
function plateScalebarParams(framing, scale) {
    const widest = Math.max(...framing.cols);
    return computeScalebarParams(widest * scale, widest);
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

function plateMode() {
    return state.plateCellShape === 'uniform' ? 'uniform' : 'net';
}

// ============ PNG plate ============

async function doExportViewsPng(includeScalebar) {
    showStatus('Rendering six-view plate...');

    const framing = getPlateFraming({ mode: plateMode() });
    if (!framing) return;

    const { cols, rows, gap } = framing;
    const withBar = includeScalebar && state.isOrthographic;

    // Everything is laid out in model units first, then multiplied by ppu.
    // Width = 4 cells + 3 inner gaps + 2 outer margins (margin = gap).
    const totalUnitsW = framing.blockWidth + 5 * gap;
    const gridUnitsH = framing.blockHeight + 2 * gap;

    let ppu = (state.platePngWidth || 4000) / totalUnitsW;

    // The bar block is a fixed pixel height, so resolve the layout, then check
    // it against the canvas ceilings and shrink once if needed.
    const layout = () => {
        const gapPx = Math.max(1, Math.round(gap * ppu));
        const colsPx = cols.map(c => Math.round(c * ppu));
        const rowsPx = rows.map(r => Math.round(r * ppu));
        const gridW = colsPx.reduce((a, b) => a + b, 0) + 3 * gapPx;
        const gridH = rowsPx.reduce((a, b) => a + b, 0) + 2 * gapPx;
        const barScale = Math.max(1, (Math.max(...colsPx)) / 500);
        const barBlock = withBar ? 2 * gapPx + scalebarBlockHeight(barScale) : 0;
        return {
            gapPx, colsPx, rowsPx, gridW, gridH, barScale, barBlock,
            width: gridW + 2 * gapPx,
            height: gridH + 2 * gapPx + barBlock
        };
    };

    let L = layout();
    const area = L.width * L.height;
    const overDim = Math.max(L.width, L.height) / MAX_CANVAS_DIM;
    const overArea = Math.sqrt(area / MAX_CANVAS_AREA);
    const over = Math.max(overDim, overArea);
    if (over > 1) {
        ppu /= over;
        L = layout();
        showStatus(`Plate reduced to ${L.width}px wide (browser canvas limit)`);
    }

    const { views } = await renderSixViews({ framing, ppu, transparent: true });

    const plate = document.createElement('canvas');
    plate.width = L.width;
    plate.height = L.height;
    const ctx = plate.getContext('2d');

    // Left transparent on purpose — no background fill.
    for (const view of views) {
        const x = L.gapPx + L.colsPx.slice(0, view.col).reduce((a, b) => a + b, 0) + view.col * L.gapPx;
        const y = L.gapPx + L.rowsPx.slice(0, view.row).reduce((a, b) => a + b, 0) + view.row * L.gapPx;
        // Centre inside the cell; in practice they match to within a pixel.
        ctx.drawImage(
            view.canvas,
            x + (L.colsPx[view.col] - view.widthPx) / 2,
            y + (L.rowsPx[view.row] - view.heightPx) / 2
        );
    }

    if (withBar) {
        const params = plateScalebarParams(framing, ppu);
        if (params) {
            drawScalebarOnCanvas(plate, {
                barPx: params.pixelWidth,
                label: formatScalebarLabel(params.units),
                scale: L.barScale,
                color: autoScalebarColor({ transparent: true }),
                x: L.gapPx,
                y: L.gapPx + L.gridH + 2 * L.gapPx
            });
        }
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

        showStatus(`Six-view plate saved (${canvas.width}×${canvas.height})`);
    }, 'image/png');
}

// ============ PDF plate ============

async function doExportViewsPdf(includeScalebar) {
    showStatus('Rendering six-view plate...');

    const framing = getPlateFraming({ mode: plateMode() });
    if (!framing) return;

    const { cols, rows, gap } = framing;
    const pageConfig = getPdfPageConfig();
    const margin = 15;
    const availW = pageConfig.pageWidth - 2 * margin;
    const availH = pageConfig.pageHeight - 2 * margin;

    const withBar = includeScalebar && state.isOrthographic;
    const barGapMm = 6;
    const barBlockMm = withBar ? barGapMm + scalebarBlockHeightMm() : 0;

    // Fit to page: one uniform scale, limited by whichever of width or height
    // binds first. This mirrors adjustbox's max width / max height behaviour,
    // and the scale bar shrinks with the images so it stays true either way.
    const blockUnitsW = framing.blockWidth + 3 * gap;
    const blockUnitsH = framing.blockHeight + 2 * gap;
    const mmPerUnit = Math.min(availW / blockUnitsW, (availH - barBlockMm) / blockUnitsH);

    const dpi = state.platePdfDpi || 300;
    const ppu = (mmPerUnit / 25.4) * dpi;

    const { views } = await renderSixViews({ framing, ppu, transparent: true });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF(pageConfig.orientation, 'mm', pageConfig.format);

    const gapMm = gap * mmPerUnit;
    const colsMm = cols.map(c => c * mmPerUnit);
    const rowsMm = rows.map(r => r * mmPerUnit);
    const blockW = blockUnitsW * mmPerUnit;
    const blockH = blockUnitsH * mmPerUnit + barBlockMm;
    const originX = margin + (availW - blockW) / 2;
    const originY = margin + (availH - blockH) / 2;

    for (const view of views) {
        const x = originX + colsMm.slice(0, view.col).reduce((a, b) => a + b, 0) + view.col * gapMm;
        const y = originY + rowsMm.slice(0, view.row).reduce((a, b) => a + b, 0) + view.row * gapMm;
        pdf.addImage(
            view.canvas.toDataURL('image/png'), 'PNG',
            x, y, colsMm[view.col], rowsMm[view.row]
        );
    }

    if (withBar) {
        // computeScalebarParams is unit-agnostic: feed it millimetres and it
        // returns the bar length in millimetres.
        const params = plateScalebarParams(framing, mmPerUnit);
        if (params) {
            drawScalebarOnPdf(pdf, {
                x: originX,
                y: originY + blockUnitsH * mmPerUnit + barGapMm,
                barMm: params.pixelWidth,
                label: formatScalebarLabel(params.units)
            });
        }
    }

    const base = (state.modelFileName || 'model').replace(/\.[^.]+$/, '');
    pdf.save(`meshnotes-views-${base}-${Date.now()}.pdf`);
    showStatus(`Six-view plate exported (${dpi} DPI)`);
}
