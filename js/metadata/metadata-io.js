// js/metadata/metadata-io.js - Metadata JSON and PDF export/import
import { state } from '../state.js';
import { showStatus } from '../utils/helpers.js';
import { TEMPLATES, DATA_MANAGEMENT_GUIDELINE, createEmptyMetadata, getMetadataStats } from './templates.js';
import { updateMetadataDisplay, openMetadataPopup } from './metadata-ui.js';

// ============ JSON Export ============

/**
 * Exports metadata as a JSON file for re-importing.
 * If metadata is empty, exports the empty template.
 */
export function downloadMetadataJSON() {
    const metadata = state.modelInfo.metadata || createEmptyMetadata();
    const exportObj = {
        generator: 'MeshNotes',
        type: 'MetadataReport',
        exported: new Date().toISOString(),
        model: state.modelFileName || undefined,
        metadata: metadata
    };

    const json = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    const baseName = state.modelFileName
        ? state.modelFileName.replace(/\.[^.]+$/, '')
        : 'metadata';
    link.download = `${baseName}-metadata.json`;
    link.href = url;
    link.click();

    URL.revokeObjectURL(url);
    showStatus('Metadata JSON exported');
}

// ============ JSON Import ============

/**
 * Imports metadata from a JSON file.
 * Replaces current metadata after user confirmation.
 * @param {File} file
 */
export function importMetadataJSON(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);

            // Validate structure
            if (!data.metadata || !data.metadata.sections || !Array.isArray(data.metadata.sections)) {
                showStatus('Invalid metadata file: missing sections');
                return;
            }

            // Check if current metadata has any filled fields
            const { filled } = getMetadataStats(state.modelInfo.metadata);
            if (filled > 0) {
                if (!confirm('This will replace the current metadata. Continue?')) {
                    return;
                }
            }

            // Apply imported metadata
            state.modelInfo.metadata = data.metadata;
            updateMetadataDisplay();
            showStatus('Metadata imported successfully');

            // Re-open popup to show updated data
            openMetadataPopup();
        } catch (err) {
            console.error('Metadata import error:', err);
            showStatus('Failed to import metadata: invalid JSON');
        }
    };
    reader.readAsText(file);
}

// ============ Fillable PDF Export (pdf-lib) ============

// Layout constants in PDF points (1pt = 1/72 inch, A4 = 595.28 x 841.89)
const PT = {
    pageWidth: 595.28,
    pageHeight: 841.89,
    margin: 42.52,         // ~15mm
    labelWidth: 170,       // ~60mm
    lineHeight: 20,        // single-line field height
    multilineHeight: 54,   // multiline field height (3 lines)
    sectionGap: 14,
    fieldGap: 3,           // vertical gap between fields
    labelFieldGap: 6,      // horizontal gap between label and field box
    fontSize: 9,
    sectionFontSize: 12,
    titleFontSize: 16,
    guidelineFontSize: 7,
    footerFontSize: 7
};
PT.contentWidth = PT.pageWidth - 2 * PT.margin;
PT.fieldWidth = PT.contentWidth - PT.labelWidth - PT.labelFieldGap;
PT.fieldX = PT.margin + PT.labelWidth + PT.labelFieldGap;

/**
 * Exports metadata as a fillable PDF form using pdf-lib.
 * All fields are always present. Pre-populated if values exist.
 */
export async function downloadMetadataPDF() {
    if (!window.PDFLib) {
        showStatus('pdf-lib not loaded');
        return;
    }

    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

    const metadata = state.modelInfo.metadata || createEmptyMetadata();
    const templateId = metadata.template || '3d-documentation';
    const template = TEMPLATES[templateId];
    if (!template) {
        showStatus('Unknown template');
        return;
    }

    try {
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
        const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);
        const form = pdfDoc.getForm();

        const gold = rgb(170 / 255, 129 / 255, 1 / 255);
        const black = rgb(0, 0, 0);
        const gray = rgb(0.47, 0.47, 0.47);
        const lightGray = rgb(0.7, 0.7, 0.7);
        const hintGray = rgb(0.63, 0.63, 0.63);

        // cursorY tracks position from the TOP of the page (increases downward)
        let page = pdfDoc.addPage([PT.pageWidth, PT.pageHeight]);
        let cursorY = PT.margin;
        let fieldCounter = 0;

        // Convert top-down cursorY to pdf-lib y (from bottom)
        const fromTop = (topY) => PT.pageHeight - topY;

        // Get a new page if not enough space remaining
        const ensureSpace = (needed) => {
            if (cursorY + needed > PT.pageHeight - PT.margin - 30) { // 30pt reserved for footer
                page = pdfDoc.addPage([PT.pageWidth, PT.pageHeight]);
                cursorY = PT.margin;
            }
        };

        // Draws a label + fillable form field and advances cursorY
        const drawFormField = (key, value, hint, multiline) => {
            const fieldHeight = multiline ? PT.multilineHeight : PT.lineHeight;

            ensureSpace(fieldHeight + PT.fieldGap);

            // Label — baseline aligned near the top of the field
            page.drawText(key, {
                x: PT.margin,
                y: fromTop(cursorY + PT.fontSize + 3),
                size: PT.fontSize,
                font: fontBold,
                color: black
            });

            // Fillable text field — positioned with bottom-left in pdf-lib coords
            const fieldBottomY = fromTop(cursorY + fieldHeight);
            const uniqueName = `field_${fieldCounter++}`;

            const textField = form.createTextField(uniqueName);
            textField.addToPage(page, {
                x: PT.fieldX,
                y: fieldBottomY,
                width: PT.fieldWidth,
                height: fieldHeight,
                borderWidth: 0.5,
                borderColor: lightGray
            });

            textField.setFontSize(PT.fontSize);
            if (multiline) {
                textField.enableMultiline();
            }

            if (value && value.trim()) {
                textField.setText(value);
            } else if (hint) {
                textField.setText(hint);
            }

            cursorY += fieldHeight + PT.fieldGap;
        };

        // ---- Title ----
        page.drawText('3D Documentation \u2014 Metadata Report', {
            x: PT.margin,
            y: fromTop(cursorY + PT.titleFontSize),
            size: PT.titleFontSize,
            font: fontBold,
            color: black
        });
        cursorY += PT.titleFontSize + 8;

        // Model filename
        if (state.modelFileName) {
            page.drawText(`Model: ${state.modelFileName}`, {
                x: PT.margin,
                y: fromTop(cursorY + 10),
                size: 10,
                font: font,
                color: gray
            });
            cursorY += 18;
        }

        // Gold separator line
        page.drawLine({
            start: { x: PT.margin, y: fromTop(cursorY) },
            end: { x: PT.margin + PT.contentWidth, y: fromTop(cursorY) },
            thickness: 1.5,
            color: gold
        });
        cursorY += PT.sectionGap;

        // ---- Sections ----
        for (let si = 0; si < metadata.sections.length; si++) {
            const section = metadata.sections[si];
            const templateSection = template.sections.find(s => s.title === section.title);

            ensureSpace(30);

            // Section header
            page.drawText(section.title, {
                x: PT.margin,
                y: fromTop(cursorY + PT.sectionFontSize),
                size: PT.sectionFontSize,
                font: fontBold,
                color: gold
            });
            cursorY += PT.sectionFontSize + 3;

            // Section underline
            page.drawLine({
                start: { x: PT.margin, y: fromTop(cursorY) },
                end: { x: PT.margin + PT.contentWidth, y: fromTop(cursorY) },
                thickness: 0.75,
                color: gold
            });
            cursorY += PT.sectionGap;

            // Template fields
            for (let fi = 0; fi < section.fields.length; fi++) {
                const field = section.fields[fi];
                const def = templateSection
                    ? templateSection.fields.find(f => f.key === field.key)
                    : null;
                const hint = def ? def.hint : '';
                const multiline = def ? def.multiline : false;

                drawFormField(field.key, field.value, hint, multiline);
            }

            // Custom fields
            if (section.customFields) {
                for (const field of section.customFields) {
                    drawFormField(field.key || 'Custom', field.value, '', false);
                }
            }

            cursorY += PT.sectionGap;
        }

        // ---- Data Management guideline ----
        ensureSpace(60);

        page.drawText('Data Management', {
            x: PT.margin,
            y: fromTop(cursorY + PT.sectionFontSize),
            size: PT.sectionFontSize,
            font: fontBold,
            color: gold
        });
        cursorY += PT.sectionFontSize + 3;

        page.drawLine({
            start: { x: PT.margin, y: fromTop(cursorY) },
            end: { x: PT.margin + PT.contentWidth, y: fromTop(cursorY) },
            thickness: 0.75,
            color: gold
        });
        cursorY += PT.sectionGap;

        const guidelineLines = DATA_MANAGEMENT_GUIDELINE.split('\n');
        for (const line of guidelineLines) {
            ensureSpace(12);
            page.drawText(line.replace(/\t/g, '    '), {
                x: PT.margin,
                y: fromTop(cursorY + PT.guidelineFontSize),
                size: PT.guidelineFontSize,
                font: fontMono,
                color: gray
            });
            cursorY += PT.guidelineFontSize + 3;
        }

        // ---- Footer on every page ----
        const pages = pdfDoc.getPages();
        for (const p of pages) {
            p.drawText(
                'Generated by MeshNotes \u2014 https://github.com/NilsSchnorr/MeshNotes',
                { x: PT.margin, y: 22, size: PT.footerFontSize, font: fontItalic, color: hintGray }
            );
            p.drawText(
                'For questions about the report, please contact: Nils Schnorr, nils.schnorr@uni-saarland.de',
                { x: PT.margin, y: 13, size: PT.footerFontSize, font: fontItalic, color: hintGray }
            );
        }

        // ---- Save ----
        const pdfBytes = await pdfDoc.save();
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        const baseName = state.modelFileName
            ? state.modelFileName.replace(/\.[^.]+$/, '')
            : 'metadata';
        link.download = `${baseName}-metadata-report.pdf`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);

        showStatus('Metadata PDF exported');

    } catch (err) {
        console.error('PDF export error:', err);
        showStatus('PDF export failed: ' + err.message);
    }
}
