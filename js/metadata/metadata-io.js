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

// ============ PDF Export ============

/**
 * Exports metadata as a PDF document.
 * All fields are always present (for use as a standalone form).
 * Pre-populated values are printed if available; empty fields show hint text and a box.
 */
export function downloadMetadataPDF() {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
        showStatus('PDF library not loaded');
        return;
    }

    const metadata = state.modelInfo.metadata || createEmptyMetadata();
    const templateId = metadata.template || '3d-documentation';
    const template = TEMPLATES[templateId];
    if (!template) {
        showStatus('Unknown template');
        return;
    }

    const pdf = new jsPDF('portrait', 'mm', 'a4');
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 15;
    const contentWidth = pageWidth - 2 * margin;
    const fieldLabelWidth = 60;
    const fieldInputWidth = contentWidth - fieldLabelWidth - 2;
    const lineHeight = 7;
    const sectionGap = 6;

    let y = margin;

    // Title
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(16);
    pdf.text('3D Documentation \u2014 Metadata Report', margin, y);
    y += 10;

    // Model filename if available
    if (state.modelFileName) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        pdf.setTextColor(100, 100, 100);
        pdf.text(`Model: ${state.modelFileName}`, margin, y);
        pdf.setTextColor(0, 0, 0);
        y += 8;
    }

    // Separator
    pdf.setDrawColor(170, 129, 1); // Gold accent
    pdf.setLineWidth(0.5);
    pdf.line(margin, y, pageWidth - margin, y);
    y += sectionGap;

    // Render sections
    for (let si = 0; si < metadata.sections.length; si++) {
        const section = metadata.sections[si];
        const templateSection = template.sections.find(s => s.title === section.title);

        // Check if we need a new page for the section header + at least one field
        if (y + 20 > pageHeight - margin) {
            pdf.addPage();
            y = margin;
        }

        // Section header
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(12);
        pdf.setTextColor(170, 129, 1);
        pdf.text(section.title, margin, y);
        pdf.setTextColor(0, 0, 0);
        y += 2;
        pdf.setDrawColor(170, 129, 1);
        pdf.setLineWidth(0.3);
        pdf.line(margin, y, pageWidth - margin, y);
        y += sectionGap;

        // Template fields
        for (let fi = 0; fi < section.fields.length; fi++) {
            const field = section.fields[fi];
            const def = templateSection
                ? templateSection.fields.find(f => f.key === field.key)
                : null;
            const hint = def ? def.hint : '';
            const multiline = def ? def.multiline : false;

            y = renderPdfField(pdf, field.key, field.value, hint, multiline, y, margin, fieldLabelWidth, fieldInputWidth, lineHeight, pageHeight);
        }

        // Custom fields
        if (section.customFields) {
            for (const field of section.customFields) {
                y = renderPdfField(pdf, field.key || 'Custom', field.value, '', false, y, margin, fieldLabelWidth, fieldInputWidth, lineHeight, pageHeight);
            }
        }

        y += sectionGap;
    }

    // Data Management guideline
    if (y + 40 > pageHeight - margin) {
        pdf.addPage();
        y = margin;
    }

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(170, 129, 1);
    pdf.text('Data Management', margin, y);
    pdf.setTextColor(0, 0, 0);
    y += 2;
    pdf.setDrawColor(170, 129, 1);
    pdf.setLineWidth(0.3);
    pdf.line(margin, y, pageWidth - margin, y);
    y += sectionGap;

    pdf.setFont('courier', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(80, 80, 80);
    const guidelineLines = DATA_MANAGEMENT_GUIDELINE.split('\n');
    for (const line of guidelineLines) {
        if (y + 5 > pageHeight - margin) {
            pdf.addPage();
            y = margin;
        }
        pdf.text(line.replace(/\t/g, '    '), margin, y);
        y += 4;
    }

    // Footer on last page
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(8);
    pdf.setTextColor(120, 120, 120);
    pdf.text(
        'Generated by MeshNotes \u2014 https://github.com/NilsSchnorr/MeshNotes',
        margin,
        pageHeight - 8
    );
    pdf.text(
        'For questions about the report, please contact: Nils Schnorr, nils.schnorr@uni-saarland.de',
        margin,
        pageHeight - 4
    );

    // Save
    const baseName = state.modelFileName
        ? state.modelFileName.replace(/\.[^.]+$/, '')
        : 'metadata';
    pdf.save(`${baseName}-metadata-report.pdf`);
    showStatus('Metadata PDF exported');
}

/**
 * Renders a single field row in the PDF.
 * Shows label on the left, value or hint in a bordered box on the right.
 * @returns {number} Updated y position
 */
function renderPdfField(pdf, key, value, hint, multiline, y, margin, fieldLabelWidth, fieldInputWidth, lineHeight, pageHeight) {
    const fieldHeight = multiline ? lineHeight * 3 : lineHeight;
    const fieldX = margin + fieldLabelWidth;

    // Page break check
    if (y + fieldHeight + 2 > pageHeight - margin) {
        pdf.addPage();
        y = margin;
    }

    // Label
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(0, 0, 0);
    pdf.text(key, margin, y + 4.5);

    // Field box
    pdf.setDrawColor(180, 180, 180);
    pdf.setLineWidth(0.2);
    pdf.rect(fieldX, y, fieldInputWidth, fieldHeight);

    // Content: value or hint
    if (value && value.trim()) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(0, 0, 0);
        if (multiline) {
            const lines = pdf.splitTextToSize(value, fieldInputWidth - 4);
            const maxLines = Math.floor(fieldHeight / 4);
            pdf.text(lines.slice(0, maxLines), fieldX + 2, y + 4);
        } else {
            pdf.text(value.substring(0, 80), fieldX + 2, y + 4.5);
        }
    } else if (hint) {
        pdf.setFont('helvetica', 'italic');
        pdf.setFontSize(9);
        pdf.setTextColor(160, 160, 160);
        pdf.text(hint.substring(0, 60), fieldX + 2, y + 4.5);
        pdf.setTextColor(0, 0, 0);
    }

    return y + fieldHeight + 2;
}
