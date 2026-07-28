// js/export/scalebar.js — shared scale-bar geometry and renderers
//
// One geometry definition, three output targets. The bar is an "I-beam": a thin
// rule with a vertical tick at each end and a centred label below. That is the
// same shape the cutting-plane profile SVG already used, so every scale bar in
// MeshNotes now looks alike.
//
// Moved here from annotation-tools/data.js in v1.4.0, which also replaced the
// previous alternating black/white bar on a translucent panel. The bar is now
// drawn bare (no panel) in a single colour picked for contrast against the
// background, so it works on transparent exports as well.

import { state } from '../state.js';
import { getViewportWidth } from '../core/scene.js';

// Base geometry in "design pixels" at scale 1. Every renderer multiplies these
// by its own scale factor, so the bar keeps the same proportions whether it is
// drawn on a 900 px screenshot or an 8000 px plate.
const GEOM = {
    strokeWidth: 2,   // thickness of the rule and of the end ticks
    tickHalf: 5,      // half-height of the end ticks
    labelGap: 16,     // label baseline, measured down from the rule
    fontSize: 12,
    captionGap: 30,   // caption baseline, measured down from the rule
    captionSize: 10,
    margin: 20        // padding used when the bar is an in-image overlay
};

export const SCALEBAR_CAPTION = '(scale depends on model source)';

/**
 * The caption only makes sense while the model is unitless. Once a real unit
 * has been chosen in Settings, the user has asserted the model's scale and the
 * disclaimer is noise — and on a publication plate, actively misleading.
 *
 * Custom units are stored as their own text (e.g. 'ft'), so anything other than
 * the literal 'units' counts as a declared unit.
 *
 * @returns {string|null} caption text, or null when no caption should be drawn
 */
export function getScalebarCaption() {
    const unit = state.measurementUnit || 'units';
    return unit === 'units' ? SCALEBAR_CAPTION : null;
}

/**
 * Rounds a length to a readable value (1, 2, 5, 10, 20, 50, ...).
 * @param {number} value
 * @returns {number}
 */
export function getNiceScaleValue(value) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const normalized = value / magnitude;

    let nice;
    if (normalized < 1.5) nice = 1;
    else if (normalized < 3.5) nice = 2;
    else if (normalized < 7.5) nice = 5;
    else nice = 10;

    return nice * magnitude;
}

/**
 * Generic bar sizing. Given how wide an image is in pixels and how many model
 * units that width spans, return a readable bar length and its width in the
 * SAME pixel unit that was passed in.
 *
 * Callers that render a view themselves (the six-view plate, the report's axis
 * cells) pass their own cell width, so the bar is correct by construction and
 * never depends on reading the live camera back.
 *
 * @param {number} pixelWidth - image width, in whatever pixel unit the caller uses
 * @param {number} frustumWidth - model units spanned by that width
 * @returns {{units: number, pixelWidth: number}|null}
 */
export function computeScalebarParams(pixelWidth, frustumWidth) {
    if (!(pixelWidth > 0) || !(frustumWidth > 0)) return null;
    const units = getNiceScaleValue(frustumWidth * 0.25);
    return { units, pixelWidth: units * (pixelWidth / frustumWidth) };
}

/**
 * Bar sizing for the live viewport. pixelWidth is returned in CSS pixels, so
 * callers must multiply by their effective device-pixel ratio.
 * @returns {{units: number, pixelWidth: number}|null}
 */
export function calculateScalebarParams() {
    if (!state.isOrthographic || !state.currentModel) return null;

    const cam = state.orthographicCamera;
    const frustumWidth = (cam.right - cam.left) / cam.zoom;
    return computeScalebarParams(getViewportWidth(), frustumWidth);
}

/**
 * Bar label, e.g. "10 cm". The unit comes from the measurement unit setting.
 * @param {number} units
 * @returns {string}
 */
export function formatScalebarLabel(units) {
    const unit = state.measurementUnit || 'units';
    const n = units >= 1 ? String(units) : units.toFixed(2);
    return `${n} ${unit}`;
}

/**
 * Picks black or white for contrast. Transparent exports assume white paper.
 * @param {{transparent?: boolean}} [opts]
 * @returns {string} hex colour
 */
export function autoScalebarColor(opts = {}) {
    if (opts.transparent) return '#000000';

    const raw = (state.backgroundColor || '#041D31').replace('#', '');
    const h = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw;
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance > 140 ? '#000000' : '#ffffff';
}

/**
 * Vertical space the whole bar block occupies below its rule, at a given scale.
 * Used by the plate layouts to reserve room under the images.
 * @param {number} scale
 * @param {boolean} [withCaption] - defaults to whether a caption applies
 * @returns {number} pixels
 */
export function scalebarBlockHeight(scale, withCaption = !!getScalebarCaption()) {
    const below = withCaption
        ? GEOM.captionGap + GEOM.captionSize
        : GEOM.labelGap + GEOM.fontSize;
    return (GEOM.tickHalf + below) * scale;
}

/**
 * Draws the I-beam on a 2D canvas.
 *
 * @param {HTMLCanvasElement} targetCanvas
 * @param {Object} opts
 * @param {number} opts.barPx - bar length in canvas pixels
 * @param {string} opts.label
 * @param {string} [opts.caption]
 * @param {number} [opts.scale=1] - multiplies the base geometry
 * @param {string} [opts.color='#000000']
 * @param {number} [opts.x] - left end of the rule; defaults to a bottom-left overlay
 * @param {number} [opts.y] - centre line of the rule; defaults to a bottom-left overlay
 */
export function drawScalebarOnCanvas(targetCanvas, opts) {
    const {
        barPx,
        label,
        caption = getScalebarCaption(),
        scale = 1,
        color = '#000000'
    } = opts || {};

    if (!(barPx > 0)) return;

    const ctx = targetCanvas.getContext('2d');
    const x = opts.x !== undefined ? opts.x : GEOM.margin * scale;
    const y = opts.y !== undefined
        ? opts.y
        : targetCanvas.height - GEOM.margin * scale - scalebarBlockHeight(scale, !!caption);

    const stroke = GEOM.strokeWidth * scale;
    const tick = GEOM.tickHalf * scale;

    ctx.save();
    ctx.fillStyle = color;

    // Rule, then a tick at each end. Outer tick-to-tick span equals barPx.
    ctx.fillRect(x, y - stroke / 2, barPx, stroke);
    ctx.fillRect(x - stroke / 2, y - tick, stroke, tick * 2);
    ctx.fillRect(x + barPx - stroke / 2, y - tick, stroke, tick * 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${GEOM.fontSize * scale}px Arial, Helvetica, sans-serif`;
    ctx.fillText(label, x + barPx / 2, y + GEOM.labelGap * scale);

    if (caption) {
        ctx.globalAlpha = 0.65;
        ctx.font = `${GEOM.captionSize * scale}px Arial, Helvetica, sans-serif`;
        ctx.fillText(caption, x + barPx / 2, y + GEOM.captionGap * scale);
    }

    ctx.restore();
}

/**
 * Convenience wrapper for captures of the live viewport (screenshots).
 * Computes the bar from the current orthographic camera and draws it as a
 * bottom-left overlay.
 *
 * @param {HTMLCanvasElement} targetCanvas
 * @param {number} effectiveDpr - device-pixel ratio x any upscaling applied
 * @param {{transparent?: boolean}} [opts]
 */
export function drawViewportScalebar(targetCanvas, effectiveDpr, opts = {}) {
    const params = calculateScalebarParams();
    if (!params) return;

    const scale = effectiveDpr || (window.devicePixelRatio || 1);
    drawScalebarOnCanvas(targetCanvas, {
        barPx: params.pixelWidth * scale,
        label: formatScalebarLabel(params.units),
        scale,
        color: autoScalebarColor(opts)
    });
}

/**
 * Draws the same I-beam into a jsPDF document as vector primitives, so PDF
 * output stays crisp instead of being baked into a raster image.
 *
 * @param {Object} pdf - jsPDF instance
 * @param {Object} opts
 * @param {number} opts.x - left end of the rule, in mm
 * @param {number} opts.y - centre line of the rule, in mm
 * @param {number} opts.barMm - bar length in mm
 * @param {string} opts.label
 * @param {string} [opts.caption]
 * @param {string} [opts.color='#000000'] - hex
 */
export function drawScalebarOnPdf(pdf, opts) {
    const {
        x,
        y,
        barMm,
        label,
        caption = getScalebarCaption(),
        color = '#000000'
    } = opts || {};

    if (!(barMm > 0)) return;

    // Millimetre equivalents of the canvas geometry, tuned to read the same on
    // a printed page as on screen.
    const stroke = 0.4;
    const tickHalf = 1.5;
    const labelGap = 4.5;
    const fontSize = 9;
    const captionGap = 8.5;
    const captionSize = 7;

    const h = color.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);

    pdf.setDrawColor(r, g, b);
    pdf.setLineWidth(stroke);
    pdf.line(x, y, x + barMm, y);
    pdf.line(x, y - tickHalf, x, y + tickHalf);
    pdf.line(x + barMm, y - tickHalf, x + barMm, y + tickHalf);

    pdf.setTextColor(r, g, b);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(fontSize);
    pdf.text(label, x + barMm / 2, y + labelGap, { align: 'center' });

    if (caption) {
        pdf.setFontSize(captionSize);
        pdf.setTextColor(
            Math.round(r * 0.65 + 255 * 0.35),
            Math.round(g * 0.65 + 255 * 0.35),
            Math.round(b * 0.65 + 255 * 0.35)
        );
        pdf.text(caption, x + barMm / 2, y + captionGap, { align: 'center' });
    }
}

/**
 * Height in mm of the bar block below its rule, for PDF layout reservation.
 * @param {boolean} [withCaption] - defaults to whether a caption applies
 * @returns {number}
 */
export function scalebarBlockHeightMm(withCaption = !!getScalebarCaption()) {
    return withCaption ? 1.5 + 8.5 + 2.5 : 1.5 + 4.5 + 3;
}
