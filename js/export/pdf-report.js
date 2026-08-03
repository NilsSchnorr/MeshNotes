// js/export/pdf-report.js - Multi-page PDF report generation
import * as THREE from 'three';
import { state, dom, APP_VERSION } from '../state.js';
import { showStatus, hexToRgb, delay, toDisplayCoords, safeUrl } from '../utils/helpers.js';
import { pointToZUp } from './w3c-format.js';
import { toggleCamera, saveCameraPose, restoreCameraPose } from '../core/camera.js';
import { updateFixedLightDirection, getDpiMultiplier } from '../core/lighting.js';
import { renderAnnotations } from '../annotation-tools/render.js';
import { showScalebarConfirm } from '../annotation-tools/data.js';
import { getPdfPageConfig, getAccentColor } from './pdf-layout.js';
import { getPlateFraming, renderSixViews } from './views-plate.js';
import {
    computeScalebarParams,
    formatScalebarLabel,
    autoScalebarColor,
    drawScalebarOnCanvas,
    drawViewportScalebar
} from './scalebar.js';
import { getFieldDefinition, getMetadataStats, DATA_MANAGEMENT_GUIDELINE, SUBJECT_KINDS, METADATA_SPEC } from '../metadata/templates.js';

// Page geometry and accent colour now live in pdf-layout.js, shared with the
// six-view plate export.

// ============ PDF Export Entry Point ============

export async function exportPdfReport() {
    if (!state.currentModel) {
        showStatus('No model loaded');
        return;
    }

    if (!state.isOrthographic) {
        // Show confirmation dialog for perspective mode
        showScalebarConfirm(
            () => {
                // User chose to switch to orthographic
                toggleCamera();
                setTimeout(() => {
                    doExportPdfReport(true);
                }, 100);
            },
            () => {
                // User chose to continue without scalebar
                doExportPdfReport(false);
            }
        );
    } else {
        doExportPdfReport(true);
    }
}

// ============ PDF Helper Functions ============

/**
 * Captures a screenshot from the renderer, optionally with a scalebar overlay.
 * Uses canvas upscaling for higher quality output based on DPI setting.
 * @param {boolean} includeScalebar - Whether to draw scalebar on screenshot
 * @returns {string} Data URL of the captured image (JPEG)
 */
function pdfCaptureScreenshot(includeScalebar) {
    const src = dom.canvas;
    const multiplier = getDpiMultiplier();
    
    // Create output canvas at scaled resolution
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = Math.floor(src.width * multiplier);
    outputCanvas.height = Math.floor(src.height * multiplier);
    const ctx = outputCanvas.getContext('2d');
    
    // Enable image smoothing for better upscaling
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    
    // Draw the source canvas scaled up
    ctx.drawImage(src, 0, 0, outputCanvas.width, outputCanvas.height);
    
    // Add scalebar if requested. The effective ratio is the renderer's pixel
    // ratio times the DPI upscaling applied above — omitting the multiplier
    // (the behaviour before v1.4.0) drew the bar 2x or 4x too short.
    if (includeScalebar && state.isOrthographic) {
        drawViewportScalebar(outputCanvas, state.renderer.getPixelRatio() * multiplier);
    }
    
    return outputCanvas.toDataURL('image/jpeg', 0.92);
}

// Camera pose save/restore now lives in core/camera.js as saveCameraPose() /
// restoreCameraPose(), shared with the six-view plate export.

/**
 * Renders a list of entries (author, date, description, links) into the PDF.
 * Used for both model info entries on the title page and annotation entries.
 * @param {jsPDF} pdf - The jsPDF instance
 * @param {Array} entries - Array of entry objects with author, timestamp, description, links
 * @param {number} yPos - Starting Y position on the page
 * @param {Object} layout - Page layout constants {margin, contentWidth, pageHeight}
 * @returns {number} Updated Y position after rendering
 */
function pdfRenderEntries(pdf, entries, yPos, layout) {
    const { margin, contentWidth, pageHeight } = layout;

    entries.forEach(entry => {
        if (yPos > pageHeight - 35) {
            pdf.addPage();
            yPos = margin;
        }

        // Author and date
        const accent = getAccentColor();
        pdf.setFontSize(9);
        pdf.setTextColor(accent.r, accent.g, accent.b);
        const entryDate = new Date(entry.timestamp);
        const entryDateStr = entryDate.toLocaleDateString() + ' ' + entryDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        pdf.text(`${entry.author || 'Unknown'} \u2022 ${entryDateStr}`, margin, yPos);
        yPos += 5;

        // Description
        pdf.setFontSize(10);
        pdf.setTextColor(60, 60, 60);
        if (entry.description) {
            const descLines = pdf.splitTextToSize(entry.description, contentWidth);
            pdf.text(descLines, margin, yPos);
            yPos += descLines.length * 5;
        }

        // Links
        if (entry.links && entry.links.length > 0) {
            yPos += 2;
            pdf.setFontSize(8);
            pdf.setTextColor(100, 100, 200);
            entry.links.forEach(link => {
                if (yPos > pageHeight - 15) {
                    pdf.addPage();
                    yPos = margin;
                }
                const displayLink = link.length > 60 ? link.substring(0, 57) + '...' : link;
                // Same link policy as the UI (safeUrl): http(s) passes, DOIs
                // become doi.org resolver links, anything else is plain text.
                const url = safeUrl(link);
                if (url) {
                    pdf.textWithLink('\u{1F517} ' + displayLink, margin, yPos, { url });
                } else {
                    pdf.text('\u{1F517} ' + displayLink, margin, yPos);
                }
                yPos += 4;
            });
        }

        yPos += 6;
    });

    return yPos;
}

/**
 * Renders the title page: overview screenshot, model info, and summary stats.
 * @param {jsPDF} pdf - The jsPDF instance
 * @param {Object} layout - Page layout constants
 * @param {boolean} includeScalebar - Whether to include scalebar on screenshots
 * @param {Array} visibleGroups - Currently visible groups
 * @param {Array} visibleAnnotations - Currently visible annotations
 */
async function pdfRenderTitlePage(pdf, layout, includeScalebar, visibleGroups, visibleAnnotations) {
    const { margin, contentWidth, pageWidth, pageHeight } = layout;
    const accent = getAccentColor();

    // Title (use custom title from settings, or default)
    const reportTitle = state.pdfTitle || 'MeshNotes Report';
    pdf.setFontSize(24);
    pdf.setTextColor(accent.r, accent.g, accent.b);
    pdf.text(reportTitle, pageWidth / 2, 25, { align: 'center' });

    // Model filename
    pdf.setFontSize(14);
    pdf.setTextColor(60, 60, 60);
    pdf.text(state.modelFileName || 'Untitled Model', pageWidth / 2, 35, { align: 'center' });

    // Institution and Project (if set)
    let metaY = 42;
    if (state.pdfInstitution) {
        pdf.setFontSize(11);
        pdf.setTextColor(80, 80, 80);
        pdf.text(state.pdfInstitution, pageWidth / 2, metaY, { align: 'center' });
        metaY += 6;
    }
    if (state.pdfProject) {
        pdf.setFontSize(10);
        pdf.setTextColor(100, 100, 100);
        pdf.text(`Project: ${state.pdfProject}`, pageWidth / 2, metaY, { align: 'center' });
        metaY += 6;
    }

    // Author (use default author from settings)
    if (state.defaultAuthor) {
        pdf.setFontSize(10);
        pdf.setTextColor(100, 100, 100);
        pdf.text(`Prepared by: ${state.defaultAuthor}`, pageWidth / 2, metaY, { align: 'center' });
        metaY += 6;
    }

    // Date
    pdf.setFontSize(10);
    pdf.setTextColor(120, 120, 120);
    const dateStr = new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString();
    pdf.text(`Generated: ${dateStr}`, pageWidth / 2, metaY, { align: 'center' });
    metaY += 6;

    // Software version
    pdf.setFontSize(9);
    pdf.setTextColor(150, 150, 150);
    pdf.text(`MeshNotes v${APP_VERSION}`, pageWidth / 2, metaY, { align: 'center' });

    // Overview screenshot (position after metadata)
    const screenshotY = metaY + 8;
    await delay(100);
    state.renderer.render(state.scene, state.camera);
    const overviewImg = pdfCaptureScreenshot(includeScalebar);
    const canvasAspect = dom.canvas.width / dom.canvas.height;
    const imgHeight = contentWidth / canvasAspect;
    pdf.addImage(overviewImg, 'JPEG', margin, screenshotY, contentWidth, imgHeight);

    // Model Information
    let yPos = screenshotY + imgHeight + 10;
    pdf.setFontSize(14);
    pdf.setTextColor(accent.r, accent.g, accent.b);
    pdf.text('Model Information', margin, yPos);
    yPos += 8;

    if (state.modelInfo.entries.length === 0) {
        pdf.setFontSize(10);
        pdf.setTextColor(120, 120, 120);
        pdf.text('No model information entries.', margin, yPos);
    } else {
        yPos = pdfRenderEntries(pdf, state.modelInfo.entries, yPos, layout);
    }

    // Summary stats
    yPos += 5;
    if (yPos > pageHeight - 30) {
        pdf.addPage();
        yPos = margin;
    }
    pdf.setFontSize(10);
    pdf.setTextColor(100, 100, 100);
    pdf.text(`Total: ${visibleGroups.length} groups, ${visibleAnnotations.length} annotations`, margin, yPos);
}

/**
 * Renders the axis views page with an unfolded cube layout showing six orthogonal views.
 * @param {jsPDF} pdf - The jsPDF instance
 * @param {Object} layout - Page layout constants
 * @param {boolean} includeScalebar - Whether to include scalebar on screenshots
 */
async function pdfRenderAxisViews(pdf, layout, includeScalebar) {
    const { margin, pageWidth, pageHeight } = layout;
    const accent = getAccentColor();

    pdf.addPage();
    pdf.setFontSize(18);
    pdf.setTextColor(accent.r, accent.g, accent.b);
    pdf.text('Axis Views', margin, 20);
    pdf.setFontSize(10);
    pdf.setTextColor(120, 120, 120);
    pdf.text('Unfolded cube \u2014 six orthogonal views of the model', margin, 28);

    // Shared framing: the whole model in square cells. The net layout, the
    // view directions and the camera save/restore all live in views-plate.js
    // now, so this page and the standalone plate export cannot drift apart.
    const framing = getPlateFraming({ mode: 'square' });
    if (!framing) return;
    
    // Calculate cell size dynamically based on available page space
    // Layout: 4 columns × 3 rows
    const gridStartY = 35;
    const cellGap = 3;
    const labelSpace = 8; // extra vertical space for labels between rows
    
    const availableWidth = pageWidth - 2 * margin;  // Total width minus margins
    const availableHeight = pageHeight - gridStartY - margin - 10;  // Height minus header and bottom margin
    
    // Calculate max cell size that fits both constraints
    const maxCellWidth = (availableWidth - 3 * cellGap) / 4;  // 4 columns, 3 gaps
    const maxCellHeight = (availableHeight - 2 * labelSpace) / 3;  // 3 rows, 2 label spaces
    
    // Use the smaller of the two to maintain square cells
    const cellSize = Math.floor(Math.min(maxCellWidth, maxCellHeight));
    
    // Center the grid horizontally
    const gridWidth = 4 * cellSize + 3 * cellGap;
    const gridStartX = margin + (availableWidth - gridWidth) / 2;
    
    // Scale label font size based on cell size (base: 8pt at 42mm)
    const labelFontSize = Math.max(8, Math.min(12, Math.floor(cellSize / 5)));

    // Render the six cells at the DPI setting. Each cell is rendered at its
    // final size rather than cropped from the viewport, so the scale bar can
    // be derived from the cell width directly.
    const cellPx = Math.max(1, Math.round((cellSize / 25.4) * (state.pdfDpi || 150)));
    const frustumWidth = framing.cols[0];
    const { views } = await renderSixViews({
        framing,
        ppu: cellPx / frustumWidth,
        transparent: false
    });

    const barParams = includeScalebar && state.isOrthographic
        ? computeScalebarParams(cellPx, frustumWidth)
        : null;
    const barScale = Math.max(1, cellPx / 500);

    for (const view of views) {
        if (barParams) {
            drawScalebarOnCanvas(view.canvas, {
                barPx: barParams.pixelWidth,
                label: formatScalebarLabel(barParams.units),
                scale: barScale,
                color: autoScalebarColor()
            });
        }

        const axImg = view.canvas.toDataURL('image/jpeg', 0.92);
        const cellX = gridStartX + view.col * (cellSize + cellGap);
        const cellY = gridStartY + view.row * (cellSize + cellGap + labelSpace);

        pdf.setDrawColor(180, 180, 180);
        pdf.setLineWidth(0.3);
        pdf.rect(cellX, cellY, cellSize, cellSize);
        pdf.addImage(axImg, 'JPEG', cellX, cellY, cellSize, cellSize);

        pdf.setFontSize(labelFontSize);
        pdf.setTextColor(120, 120, 120);
        pdf.text(view.name, cellX + cellSize / 2, cellY + cellSize + labelFontSize - 2, { align: 'center' });
    }
}

/**
 * Computes how many pages the TOC will occupy. Must mirror pdfRenderTOC's
 * pagination exactly: start y=35, page break above pageHeight-20,
 * continuation pages restart at y=20; group rows 7mm, annotation rows 6mm.
 */
function computeTocPageCount(tocData, layout) {
    const { pageHeight } = layout;
    let pages = 1;
    let yPos = 35;
    tocData.forEach(item => {
        if (yPos > pageHeight - 20) {
            pages++;
            yPos = 20;
        }
        yPos += item.type === 'group' ? 7 : 6;
    });
    return pages;
}

/**
 * Fills the previously reserved TOC page(s) with entries and their actual
 * page numbers (recorded while rendering the annotation pages). Writes via
 * setPage into the reserved pages instead of appending.
 * @param {jsPDF} pdf - The jsPDF instance
 * @param {Array} tocData - Array of {type, name, page} entries
 * @param {Object} layout - Page layout constants
 * @param {number} firstPageIndex - 1-based index of the first reserved TOC page
 */
function pdfRenderTOC(pdf, tocData, layout, firstPageIndex) {
    const { margin, pageWidth, pageHeight } = layout;
    const accent = getAccentColor();

    let pageOffset = 0;
    pdf.setPage(firstPageIndex);
    pdf.setFontSize(18);
    pdf.setTextColor(accent.r, accent.g, accent.b);
    pdf.text('Table of Contents', margin, 20);

    let yPos = 35;
    pdf.setFontSize(10);

    tocData.forEach(item => {
        if (yPos > pageHeight - 20) {
            pageOffset++;
            pdf.setPage(firstPageIndex + pageOffset);
            yPos = 20;
        }

        if (item.type === 'group') {
            pdf.setTextColor(accent.r, accent.g, accent.b);
            pdf.setFont(undefined, 'bold');
            pdf.text(item.name, margin, yPos);
            pdf.setTextColor(100, 100, 100);
            pdf.text(String(item.page), pageWidth - margin, yPos, { align: 'right' });
            yPos += 7;
        } else {
            pdf.setTextColor(60, 60, 60);
            pdf.setFont(undefined, 'normal');
            pdf.text('   ' + item.name, margin, yPos);
            pdf.setTextColor(100, 100, 100);
            pdf.text(String(item.page), pageWidth - margin, yPos, { align: 'right' });
            yPos += 6;
        }
    });

    // Resume appending at the end of the document
    pdf.setPage(pdf.getNumberOfPages());
}

/**
 * Renders a single annotation page with screenshot, metadata, coordinates, and entries.
 * @param {jsPDF} pdf - The jsPDF instance
 * @param {Object} ann - The annotation object
 * @param {Object} group - The group this annotation belongs to
 * @param {Array} groupAnns - All annotations in this group
 * @param {number} annIdx - Index of this annotation within the group
 * @param {Object} layout - Page layout constants
 * @param {boolean} includeScalebar - Whether to include scalebar on screenshots
 */
async function pdfRenderAnnotationPage(pdf, ann, group, groupAnns, annIdx, layout, includeScalebar) {
    const { margin, contentWidth, pageWidth, pageHeight } = layout;

    pdf.addPage();

    // Group header (first annotation) or colored bar (subsequent)
    let contentStartY;
    if (annIdx === 0) {
        pdf.setFillColor(10, 53, 89);
        pdf.rect(0, 0, pageWidth, 25, 'F');

        const rgb = hexToRgb(group.color);
        pdf.setFillColor(rgb.r, rgb.g, rgb.b);
        pdf.rect(margin, 8, 8, 8, 'F');

        pdf.setFontSize(14);
        pdf.setTextColor(255, 255, 255);
        pdf.text(group.name, margin + 12, 14);

        pdf.setFontSize(10);
        pdf.setTextColor(200, 200, 200);
        pdf.text(`${groupAnns.length} annotation${groupAnns.length !== 1 ? 's' : ''}`, margin + 12, 21);
        contentStartY = 32;
    } else {
        const headerRgb = hexToRgb(group.color);
        pdf.setFillColor(headerRgb.r, headerRgb.g, headerRgb.b);
        pdf.rect(0, 0, pageWidth, 12, 'F');

        pdf.setFontSize(10);
        pdf.setTextColor(255, 255, 255);
        pdf.text(group.name, margin, 8);
        contentStartY = 22;
    }

    // Position camera to frame the annotation (use display coords for correct view)
    const center = new THREE.Vector3();
    const annPoints = ann.points.map(p => { const dp = toDisplayCoords(p); return new THREE.Vector3(dp.x, dp.y, dp.z); });
    annPoints.forEach(p => center.add(p));
    center.divideScalar(annPoints.length);

    let annExtent = 0;
    if (annPoints.length > 1) {
        const annBox = new THREE.Box3().setFromPoints(annPoints);
        const annSize = annBox.getSize(new THREE.Vector3());
        annExtent = Math.max(annSize.x, annSize.y, annSize.z);
    }

    const box = new THREE.Box3().setFromObject(state.currentModel);
    const modelSize = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(modelSize.x, modelSize.y, modelSize.z);
    const distanceMultiplier = state.pdfCameraDistance || 1.0;
    const baseDistance = annExtent > 0 ? annExtent * 2 : maxDim * 0.15;
    const distance = Math.max(baseDistance, maxDim * 0.08) * distanceMultiplier;

    const angle = ((state.pdfCameraAngle || 60) * Math.PI) / 180;
    const horizontalOffset = distance * Math.cos(angle);
    const verticalOffset = distance * Math.sin(angle);
    const horizontalDir = new THREE.Vector3(1, 0, 1).normalize();

    state.camera.position.set(
        center.x + horizontalDir.x * horizontalOffset,
        center.y + verticalOffset,
        center.z + horizontalDir.z * horizontalOffset
    );
    state.controls.target.copy(center);
    state.camera.lookAt(center);

    if (state.isOrthographic) {
        const aspect = dom.canvas.width / dom.canvas.height;
        const frustumHalf = distance * 0.8;
        state.camera.left = -frustumHalf * aspect;
        state.camera.right = frustumHalf * aspect;
        state.camera.top = frustumHalf;
        state.camera.bottom = -frustumHalf;
        state.camera.zoom = 1;
        state.camera.updateProjectionMatrix();
    }

    state.controls.update();

    // Temporarily enlarge markers for visibility in screenshot
    const originalScales = [];
    state.annotationObjects.children.forEach(obj => {
        if (obj.userData.annotationId === ann.id && obj.isMesh) {
            originalScales.push({ obj, scale: obj.scale.clone() });
            if (obj.geometry.type === 'SphereGeometry') {
                obj.scale.multiplyScalar(2.5);
            }
        }
    });

    // For surface annotations, temporarily increase opacity
    let originalOpacity = null;
    if (ann.type === 'surface') {
        state.annotationObjects.children.forEach(obj => {
            if (obj.userData.annotationId === ann.id && obj.isMesh && obj.material) {
                originalOpacity = obj.material.opacity;
                obj.material.opacity = 0.75;
                obj.material.needsUpdate = true;
            }
        });
    }

    // Render and capture
    state.renderer.clear();
    state.renderer.render(state.scene, state.camera);
    await delay(50);
    state.renderer.render(state.scene, state.camera);

    const screenshot = pdfCaptureScreenshot(includeScalebar);

    // Restore marker scales and surface opacity
    originalScales.forEach(({ obj, scale }) => obj.scale.copy(scale));
    if (ann.type === 'surface' && originalOpacity !== null) {
        state.annotationObjects.children.forEach(obj => {
            if (obj.userData.annotationId === ann.id && obj.isMesh && obj.material) {
                obj.material.opacity = originalOpacity;
                obj.material.needsUpdate = true;
            }
        });
    }

    // Annotation name and type
    pdf.setFontSize(16);
    pdf.setTextColor(60, 60, 60);
    pdf.text(ann.name || 'Unnamed', margin, contentStartY);

    pdf.setFontSize(9);
    pdf.setTextColor(150, 150, 150);
    const typeLabels = { point: 'Point', line: 'Line', polygon: 'Polygon', surface: 'Surface', box: 'Box' };
    pdf.text(typeLabels[ann.type] || ann.type, margin, contentStartY + 6);

    // Screenshot
    const canvasAspect = dom.canvas.width / dom.canvas.height;
    const screenshotHeight = contentWidth / canvasAspect;
    const screenshotY = contentStartY + 10;
    pdf.addImage(screenshot, 'JPEG', margin, screenshotY, contentWidth, screenshotHeight);

    // Coordinates — printed in the Z-up frame to match the JSON-LD export
    // (pointToZUp converts from internal Three.js Y-up storage).
    pdf.setFontSize(7);
    pdf.setTextColor(150, 150, 150);
    const coordStrings = ann.points.map((p, i) => {
        const z = pointToZUp(p);
        return `P${i + 1}: (${z.x.toFixed(2)}, ${z.y.toFixed(2)}, ${z.z.toFixed(2)})`;
    });
    const coordLine = 'Coordinates (Z-up): ' + coordStrings.join('  \u2022  ');
    const coordLines = pdf.splitTextToSize(coordLine, contentWidth);
    pdf.text(coordLines, margin, screenshotY + screenshotHeight + 4);
    const coordHeight = coordLines.length * 3;

    // Entries
    let yPos = screenshotY + screenshotHeight + 6 + coordHeight;
    const entries = ann.entries || [];

    if (entries.length === 0) {
        pdf.setFontSize(10);
        pdf.setTextColor(150, 150, 150);
        pdf.text('No entries.', margin, yPos);
    } else {
        pdfRenderEntries(pdf, entries, yPos, layout);
    }
}

// ============ PDF Export (main coordinator) ============

/**
 * Generates a multi-page PDF report with title page, axis views,
 * table of contents, and one page per annotation with auto-screenshots.
 * @param {boolean} includeScalebar - Whether to include scalebar on screenshots
 */
// ============ Metadata Pages ============

/**
 * Renders metadata report pages at the end of the PDF.
 * Only includes filled fields to keep it compact.
 */
function pdfRenderMetadataPages(pdf, layout) {
    const metadata = state.modelInfo.metadata;
    if (!metadata || !metadata.sections) return;

    const { filled } = getMetadataStats(metadata);
    if (filled === 0) return; // Skip entirely if nothing filled

    const accent = getAccentColor();
    const templateId = metadata.template || '3d-documentation';

    pdf.addPage();
    let y = layout.margin;

    // Page title
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    pdf.setTextColor(accent.r, accent.g, accent.b);
    pdf.text('Metadata Report', layout.margin, y);
    y += 4;
    pdf.setDrawColor(accent.r, accent.g, accent.b);
    pdf.setLineWidth(0.5);
    pdf.line(layout.margin, y, layout.margin + layout.contentWidth, y);
    y += 8;

    // Subject kind (CIDOC CRM root class) — static, read-only in the report
    const subjectKind = SUBJECT_KINDS.find(k => k.id === (metadata.subjectKind || 'mixed'))
        || SUBJECT_KINDS.find(k => k.id === 'mixed');
    if (subjectKind) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(60, 60, 60);
        pdf.text(`Subject kind: ${subjectKind.label} \u2014 CIDOC CRM ${subjectKind.crm}`, layout.margin, y);
        y += 5;
    }

    // Conformance note (fine print)
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(7.5);
    pdf.setTextColor(120, 120, 120);
    pdf.text(`Conforms to MeshNotes Metadata Format v1 \u2014 ${METADATA_SPEC.replace(/^https?:\/\//, '')}`, layout.margin, y);
    y += 8;
    pdf.setFont('helvetica', 'normal');

    for (const section of metadata.sections) {
        // Collect only filled fields (template + custom)
        const filledFields = [];
        for (const field of section.fields) {
            if (field.value && field.value.trim()) {
                filledFields.push(field);
            }
        }
        if (section.customFields) {
            for (const field of section.customFields) {
                if (field.value && field.value.trim()) {
                    filledFields.push(field);
                }
            }
        }

        if (filledFields.length === 0) continue; // Skip empty sections

        // Page break check: section header + at least one field
        if (y + 18 > layout.pageHeight - layout.margin) {
            pdf.addPage();
            y = layout.margin;
        }

        // Section header
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(11);
        pdf.setTextColor(accent.r, accent.g, accent.b);
        pdf.text(section.title, layout.margin, y);
        y += 2;
        pdf.setDrawColor(200, 200, 200);
        pdf.setLineWidth(0.2);
        pdf.line(layout.margin, y, layout.margin + layout.contentWidth, y);
        y += 5;

        // Render filled fields as label: value rows
        const labelWidth = 55;
        const valueX = layout.margin + labelWidth + 3;
        const valueWidth = layout.contentWidth - labelWidth - 3;

        for (const field of filledFields) {
            // Estimate height needed
            pdf.setFontSize(9);
            const valueLines = pdf.splitTextToSize(field.value, valueWidth);
            const hasUri = field.uri && field.uri.trim();
            const uriLines = hasUri ? pdf.splitTextToSize(field.uri.trim(), valueWidth) : [];
            const valueBlockH = valueLines.length * 4;
            const rowHeight = Math.max(6, valueBlockH + 2) + (hasUri ? uriLines.length * 3.4 + 1 : 0);

            if (y + rowHeight > layout.pageHeight - layout.margin) {
                pdf.addPage();
                y = layout.margin;
            }

            // Label
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9);
            pdf.setTextColor(60, 60, 60);
            pdf.text(field.label || '', layout.margin, y + 3.5);

            // Value
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(9);
            pdf.setTextColor(0, 0, 0);
            pdf.text(valueLines, valueX, y + 3.5);

            // Authority URI (when present)
            if (hasUri) {
                pdf.setFont('courier', 'normal');
                pdf.setFontSize(7);
                pdf.setTextColor(110, 110, 110);
                pdf.text(uriLines, valueX, y + 3.5 + valueBlockH);
            }

            y += rowHeight;
        }

        y += 4; // Gap between sections
    }
}

// ============ Main Export Flow ============

async function doExportPdfReport(includeScalebar) {
    // Store and override light settings for consistent screenshots
    const originalLightMode = state.lightFollowsCamera;
    state.lightFollowsCamera = true;

    // Get page configuration from settings
    const pageConfig = getPdfPageConfig();
    
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF(pageConfig.orientation, 'mm', pageConfig.format);
    const layout = {
        pageWidth: pageConfig.pageWidth,
        pageHeight: pageConfig.pageHeight,
        margin: 15,
        contentWidth: pageConfig.pageWidth - 30  // pageWidth - 2*margin
    };

    // Save camera state
    const savedCamera = saveCameraPose();

    showStatus('Generating PDF report...');
    renderAnnotations();
    await delay(100);

    // Determine visible content
    const visibleGroups = state.groups.filter(g => g.visible);
    const visibleAnnotations = state.annotations.filter(ann => {
        const group = state.groups.find(g => g.id === ann.groupId);
        return group && group.visible;
    });

    // Build the TOC skeleton. Page numbers are recorded during rendering,
    // because the title page and individual annotation sections can span a
    // variable number of pages — the previous hardcoded numbering (start at
    // 4, +1 per annotation) drifted on long reports.
    const tocData = [];
    const tocIndexByAnn = new Map();
    const tocIndexByGroup = new Map();
    visibleGroups.forEach(group => {
        const groupAnns = visibleAnnotations.filter(a => a.groupId === group.id);
        if (groupAnns.length > 0) {
            tocIndexByGroup.set(group.id, tocData.length);
            tocData.push({ type: 'group', name: group.name, page: 0 });
            groupAnns.forEach(ann => {
                tocIndexByAnn.set(ann.id, tocData.length);
                tocData.push({ type: 'annotation', name: ann.name, page: 0 });
            });
        }
    });

    // Render each section
    await pdfRenderTitlePage(pdf, layout, includeScalebar, visibleGroups, visibleAnnotations);

    await pdfRenderAxisViews(pdf, layout, includeScalebar);
    restoreCameraPose(savedCamera);

    // Reserve the TOC page(s) now; fill them in once annotation pages exist
    const tocPageCount = computeTocPageCount(tocData, layout);
    const tocFirstPage = pdf.getNumberOfPages() + 1;
    for (let i = 0; i < tocPageCount; i++) pdf.addPage();

    // Render annotation pages, recording each one's actual page number
    for (const group of visibleGroups) {
        const groupAnns = visibleAnnotations.filter(a => a.groupId === group.id);
        if (groupAnns.length === 0) continue;

        for (let annIdx = 0; annIdx < groupAnns.length; annIdx++) {
            const ann = groupAnns[annIdx];
            const pageOfAnn = pdf.getNumberOfPages() + 1; // pdfRenderAnnotationPage begins with addPage()
            tocData[tocIndexByAnn.get(ann.id)].page = pageOfAnn;
            if (annIdx === 0) {
                tocData[tocIndexByGroup.get(group.id)].page = pageOfAnn;
            }
            await pdfRenderAnnotationPage(pdf, ann, group, groupAnns, annIdx, layout, includeScalebar);
        }
    }

    // Fill the reserved TOC with the recorded page numbers
    pdfRenderTOC(pdf, tocData, layout, tocFirstPage);

    // Render metadata pages at end (only filled fields)
    pdfRenderMetadataPages(pdf, layout);

    // Restore everything
    restoreCameraPose(savedCamera);
    state.lightFollowsCamera = originalLightMode;
    if (!state.lightFollowsCamera) {
        updateFixedLightDirection();
    }
    renderAnnotations();
    state.renderer.render(state.scene, state.camera);

    // Save
    pdf.save(`meshnotes-report-${state.modelFileName || 'export'}-${Date.now()}.pdf`);
    showStatus('PDF report exported');
}
