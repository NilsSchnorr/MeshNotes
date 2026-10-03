// js/survey/survey-display.js - Text of the Surveyed position block (edit popup, callout, read-only viewer, PDF line)
// Pure: imports only ./alignment.js, so it loads in Node tests. No Three.js,
// state or DOM. The UI renders what these functions return with textContent,
// because names, raw values, attribute keys and values and file names come
// from a CSV file.
//
// survey.surfaceDistance sign: positive = the fitted position lies above the
// surface (on the side the nearest face's normal points to), negative = below
// it, null = not measured. The side is judged from face normals, so a mesh
// with inconsistent normals can show the wrong side; the distance itself is
// unaffected.

import { surveyToStorage, crsDisplayLabel, PLACEMENT } from './alignment.js';

// ============ Constants ============

// E, N, H and distances are shown in metres with millimetre precision.
export const COORD_DECIMALS = 3;

// A distance below this rounds to 0.000 m and is shown as "on the surface".
export const ON_SURFACE_TOLERANCE = 0.0005;

export const NOT_MEASURED = 'not measured';
export const DETACHED = 'detached';
export const FACE_NORMAL_NOTE = 'Above or below is judged from the mesh face normals.';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ============ Formatting ============

// A coordinate with three decimals, or a dash when it is not a finite number.
export function formatCoordinate(value, decimals = COORD_DECIMALS) {
    return isNum(value) ? value.toFixed(decimals) : '—';
}

// A length in metres with three decimals: '0.023 m'.
export function formatMetres(value, decimals = COORD_DECIMALS) {
    return isNum(value) ? `${value.toFixed(decimals)} m` : '—';
}

/**
 * The distance between the fitted position and the surface, in words.
 * @param {number|null} distance - survey.surfaceDistance (signed, metres)
 * @returns {string} 'not measured', 'on the surface' or '0.023 m above|below the surface'
 */
export function surfaceDistanceText(distance) {
    if (!isNum(distance)) return NOT_MEASURED;
    if (Math.abs(distance) < ON_SURFACE_TOLERANCE) return 'on the surface';
    return `${formatMetres(Math.abs(distance))} ${distance > 0 ? 'above' : 'below'} the surface`;
}

/**
 * The one-line form for the callout: 'E 512345.123  N 4123456.789  H 62.345'.
 * @param {object|null} survey - annotation.survey
 * @returns {string} '' without a survey block
 */
export function surveyCompactLine(survey) {
    if (!survey) return '';
    return `E ${formatCoordinate(survey.e)}  N ${formatCoordinate(survey.n)}  H ${formatCoordinate(survey.h)}`;
}

/**
 * The line on a survey point's PDF report page, ASCII only because the
 * report's standard font covers WinAnsi only:
 * 'Surveyed: E 512345.123  N 4123456.789  H 62.345 m (Elevation), EPSG:32635'
 * plus ', moved by hand' when the point was dragged. A detached point (no
 * alignment, or one that is no longer in the session) says 'detached' in
 * place of the coordinate system. The height column and the label are user
 * text and pass through unchanged, like annotation names in the report.
 * @param {object|null} survey - annotation.survey
 * @param {object[]} alignments - state.alignments
 * @returns {string} '' without a survey block
 */
export function surveyReportLine(survey, alignments) {
    if (!survey || typeof survey !== 'object') return '';
    const coord = (v) => (isNum(v) ? v.toFixed(COORD_DECIMALS) : 'n/a');
    const columns = survey.columns || {};
    const heightColumn = typeof columns.h === 'string' ? columns.h.trim() : '';
    const alignment = findAlignment(alignments, survey.alignmentId);
    let line = `Surveyed: E ${coord(survey.e)}  N ${coord(survey.n)}  H ${coord(survey.h)} m`;
    if (heightColumn) line += ` (${heightColumn})`;
    line += `, ${alignment ? crsDisplayLabel(alignment) : DETACHED}`;
    if (survey.placement === PLACEMENT.MANUAL) line += ', moved by hand';
    return line;
}

// ============ Alignment lookup and the hand-move offset ============

// The alignment a survey point links to (survey.alignmentId = internal id), or null.
export function findAlignment(alignments, alignmentId) {
    if (alignmentId === null || alignmentId === undefined) return null;
    return (alignments || []).find(a => a && a.id === alignmentId) || null;
}

/**
 * How far a point sits from its fitted position (the surveyed coordinate
 * through the alignment), in metres. Both positions are storage coordinates,
 * so the flip toggle does not enter.
 * @param {object} survey - annotation.survey ({e, n, h})
 * @param {{x, y, z}} point - annotation.points[0] (storage)
 * @param {object|null} alignment
 * @returns {number|null} null without an alignment or with unusable numbers
 */
export function handMovedOffset(survey, point, alignment) {
    if (!survey || !point || !alignment) return null;
    try {
        const fitted = surveyToStorage(alignment, survey);
        const d = Math.hypot(point.x - fitted.x, point.y - fitted.y, point.z - fitted.z);
        return isNum(d) ? d : null;
    } catch (e) {
        return null;
    }
}

// Status line after an unlocked survey point was dragged.
export function handMovedStatus(offset) {
    return isNum(offset)
        ? `Moved by hand: ${formatMetres(offset)} from the surveyed position`
        : 'Moved by hand';
}

// ============ The block ============

function sourceText(source) {
    if (!source) return '';
    const fileName = typeof source.fileName === 'string' ? source.fileName.trim() : '';
    const row = Number.isInteger(source.row) ? `row ${source.row}` : '';
    return [fileName, row].filter(Boolean).join(', ');
}

/**
 * Everything the Surveyed position block shows, as plain text.
 * @param {object} ann - an annotation; only one with ann.survey gets a block
 * @param {object[]} alignments - state.alignments
 * @returns {null|{title: string, rows: {key: string, label: string, value: string}[],
 *   note: string|null, attributes: {key: string, value: string}[], compact: string,
 *   alignment: object|null, detached: boolean, movedByHand: boolean, offset: number|null}}
 *   rows keys: e, n, h, crs, alignment, surface, placement (only when moved by
 *   hand), source (only when the file name or row is known).
 */
export function surveyedPositionView(ann, alignments) {
    const survey = ann && ann.survey;
    if (!survey) return null;

    const alignment = findAlignment(alignments, survey.alignmentId);
    const columns = survey.columns || {};
    const heightColumn = typeof columns.h === 'string' ? columns.h.trim() : '';
    const movedByHand = survey.placement === PLACEMENT.MANUAL;
    const point = ann.points && ann.points[0];
    const offset = movedByHand ? handMovedOffset(survey, point, alignment) : null;

    const rows = [
        { key: 'e', label: 'E', value: formatMetres(survey.e) },
        { key: 'n', label: 'N', value: formatMetres(survey.n) },
        { key: 'h', label: 'H', value: formatMetres(survey.h) + (heightColumn ? ` (${heightColumn})` : '') },
        { key: 'crs', label: 'Coordinate system', value: crsDisplayLabel(alignment) },
        { key: 'alignment', label: 'Alignment', value: alignment ? (alignment.name || 'Unnamed alignment') : DETACHED },
        // survey.surfaceDistance belongs to the fitted position, not to a marker moved by hand.
        { key: 'surface', label: 'Fitted position', value: surfaceDistanceText(survey.surfaceDistance) }
    ];
    if (movedByHand) {
        rows.push({
            key: 'placement',
            label: 'Placement',
            value: isNum(offset) ? `moved by hand, ${formatMetres(offset)} from the surveyed position` : 'moved by hand'
        });
    }
    const source = sourceText(survey.source);
    if (source) rows.push({ key: 'source', label: 'Source', value: source });

    const sided = isNum(survey.surfaceDistance) && Math.abs(survey.surfaceDistance) >= ON_SURFACE_TOLERANCE;
    const attributes = survey.attributes && typeof survey.attributes === 'object' && !Array.isArray(survey.attributes)
        ? Object.entries(survey.attributes).map(([key, value]) => ({ key, value: value === null || value === undefined ? '' : String(value) }))
        : [];

    return {
        title: 'Surveyed position',
        rows,
        note: sided ? FACE_NORMAL_NOTE : null,
        attributes,
        compact: surveyCompactLine(survey),
        alignment,
        detached: !alignment,
        movedByHand,
        offset
    };
}
