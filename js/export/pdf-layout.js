// js/export/pdf-layout.js — page geometry and colour shared by PDF exports
//
// Extracted from pdf-report.js in v1.4.0 so the six-view plate can use the same
// page-size / orientation / accent-colour settings without pdf-report.js and
// views-plate.js importing each other.

import { state } from '../state.js';
import { hexToRgb } from '../utils/helpers.js';

// Page dimensions in mm, portrait.
const PAGE_SIZES = {
    'a4': { width: 210, height: 297 },
    'letter': { width: 215.9, height: 279.4 },
    'a3': { width: 297, height: 420 }
};

/**
 * Page configuration derived from the PDF export settings.
 * @returns {{format: string, orientation: string, pageWidth: number, pageHeight: number}}
 */
export function getPdfPageConfig() {
    const orientation = state.pdfOrientation || 'portrait';
    const pageSize = state.pdfPageSize || 'a4';
    const base = PAGE_SIZES[pageSize] || PAGE_SIZES['a4'];

    if (orientation === 'landscape') {
        return {
            format: pageSize,
            orientation: 'l',
            pageWidth: base.height,
            pageHeight: base.width
        };
    }

    return {
        format: pageSize,
        orientation: 'p',
        pageWidth: base.width,
        pageHeight: base.height
    };
}

/**
 * Accent colour for PDF headings, as an RGB object.
 * @returns {{r: number, g: number, b: number}}
 */
export function getAccentColor() {
    return hexToRgb(state.pdfAccentColor || '#AA8101');
}
