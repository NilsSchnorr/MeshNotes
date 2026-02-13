// js/export/pdf-report.js - Multi-page PDF report generation
import * as THREE from 'three';
import { state, dom } from '../state.js';
import { showStatus, hexToRgb, delay } from '../utils/helpers.js';
import { toggleCamera } from '../core/camera.js';
import { updateFixedLightDirection } from '../core/lighting.js';
import { renderAnnotations } from '../annotation-tools/render.js';
import { showScalebarConfirm, drawScalebarOnCanvas } from '../annotation-tools/data.js';

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
 * @param {boolean} includeScalebar - Whether to draw scalebar on screenshot
 * @param {HTMLCanvasElement} [sourceCanvas] - Source canvas to capture from
 * @returns {string} Data URL of the captured image (JPEG)
 */
function pdfCaptureScreenshot(includeScalebar, sourceCanvas) {
    const src = sourceCanvas || dom.canvas;
    if (includeScalebar && state.isOrthographic) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = src.width;
        tempCanvas.height = src.height;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(src, 0, 0);
        drawScalebarOnCanvas(tempCanvas);
        return tempCanvas.toDataURL('image/jpeg', 0.9);
    }
    return src.toDataURL('image/jpeg', 0.9);
}

/**
 * Saves the current camera state for later restoration.
 * @returns {Object} Camera state snapshot
 */
function pdfSaveCameraState() {
    return {
        position: state.camera.position.clone(),
        target: state.controls.target.clone(),
        up: state.camera.up.clone(),
        zoom: state.camera.zoom,
        frustum: state.isOrthographic ? {
            left: state.camera.left, right: state.camera.right,
            top: state.camera.top, bottom: state.camera.bottom
        } : null
    };
}

/**
 * Restores camera to a previously saved state.
 * @param {Object} saved - State from pdfSaveCameraState()
 */
function pdfRestoreCamera(saved) {
    state.camera.up.copy(saved.up);
    state.camera.position.copy(saved.position);
    state.controls.target.copy(saved.target);
    if (state.isOrthographic && saved.frustum) {
        state.camera.left = saved.frustum.left;
        state.camera.right = saved.frustum.right;
        state.camera.top = saved.frustum.top;
        state.camera.bottom = saved.frustum.bottom;
        state.camera.zoom = saved.zoom;
        state.camera.updateProjectionMatrix();
    }
    state.controls.update();
}

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
        pdf.setFontSize(9);
        pdf.setTextColor(170, 129, 1);
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
                pdf.textWithLink('\u{1F517} ' + displayLink, margin, yPos, { url: link });
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

    // Title
    pdf.setFontSize(24);
    pdf.setTextColor(170, 129, 1);
    pdf.text('MeshNotes Report', pageWidth / 2, 25, { align: 'center' });

    // Model filename
    pdf.setFontSize(14);
    pdf.setTextColor(60, 60, 60);
    pdf.text(state.modelFileName || 'Untitled Model', pageWidth / 2, 35, { align: 'center' });

    // Date
    pdf.setFontSize(10);
    pdf.setTextColor(120, 120, 120);
    const dateStr = new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString();
    pdf.text(`Generated: ${dateStr}`, pageWidth / 2, 42, { align: 'center' });

    // Overview screenshot
    await delay(100);
    state.renderer.render(state.scene, state.camera);
    const overviewImg = pdfCaptureScreenshot(includeScalebar);
    const canvasAspect = dom.canvas.width / dom.canvas.height;
    const imgHeight = contentWidth / canvasAspect;
    pdf.addImage(overviewImg, 'JPEG', margin, 50, contentWidth, imgHeight);

    // Model Information
    let yPos = 50 + imgHeight + 10;
    pdf.setFontSize(14);
    pdf.setTextColor(170, 129, 1);
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
    const { margin } = layout;

    pdf.addPage();
    pdf.setFontSize(18);
    pdf.setTextColor(170, 129, 1);
    pdf.text('Axis Views', margin, 20);
    pdf.setFontSize(10);
    pdf.setTextColor(120, 120, 120);
    pdf.text('Unfolded cube \u2014 six orthogonal views of the model', margin, 28);

    // Calculate model bounds for consistent framing
    const axisBox = new THREE.Box3().setFromObject(state.currentModel);
    const axisSize = axisBox.getSize(new THREE.Vector3());
    const axisMaxDim = Math.max(axisSize.x, axisSize.y, axisSize.z);
    const axisDist = axisMaxDim * 1.8;
    const axisTarget = new THREE.Vector3(0, 0, 0);

    // Unfolded cube cross layout (Z-up display convention):
    //             [Top Z+]
    // [Left X-] [Front Y+] [Right X+] [Back Y-]
    //            [Bottom Z-]
    // Note: Internally Three.js uses Y-up, but MeshNotes displays Z-up.
    // Mapping: display Z = internal Y, display Y = internal -Z.
    // "Front" = camera at display +Y (internal -Z) looking toward model.
    const cellSize = 42;
    const cellGap = 3;
    const labelSpace = 8; // extra vertical space for labels between rows
    const gridStartY = 35;

    const axisViews = [
        { name: 'Top',    col: 1, row: 0, dir: new THREE.Vector3(0, 1, 0),  up: new THREE.Vector3(0, 0, -1) },
        { name: 'Left',   col: 0, row: 1, dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
        { name: 'Front',  col: 1, row: 1, dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) },
        { name: 'Right',  col: 2, row: 1, dir: new THREE.Vector3(1, 0, 0),  up: new THREE.Vector3(0, 1, 0) },
        { name: 'Back',   col: 3, row: 1, dir: new THREE.Vector3(0, 0, 1),  up: new THREE.Vector3(0, 1, 0) },
        { name: 'Bottom', col: 1, row: 2, dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
    ];

    for (const axView of axisViews) {
        state.camera.position.copy(axisTarget).addScaledVector(axView.dir, axisDist);
        state.camera.up.copy(axView.up);
        state.camera.lookAt(axisTarget);

        if (state.isOrthographic) {
            const aspect = dom.canvas.width / dom.canvas.height;
            const frustumHalf = axisMaxDim * 0.75;
            state.camera.left = -frustumHalf * aspect;
            state.camera.right = frustumHalf * aspect;
            state.camera.top = frustumHalf;
            state.camera.bottom = -frustumHalf;
            state.camera.updateProjectionMatrix();
        }

        state.renderer.clear();
        state.renderer.render(state.scene, state.camera);
        await delay(50);
        state.renderer.render(state.scene, state.camera);

        // Crop center square from canvas for cube face
        const cropCanvas = document.createElement('canvas');
        const cropSize = Math.min(dom.canvas.width, dom.canvas.height);
        cropCanvas.width = cropSize;
        cropCanvas.height = cropSize;
        const cropCtx = cropCanvas.getContext('2d');
        const offsetX = (dom.canvas.width - cropSize) / 2;
        const offsetY = (dom.canvas.height - cropSize) / 2;
        cropCtx.drawImage(dom.canvas, offsetX, offsetY, cropSize, cropSize, 0, 0, cropSize, cropSize);

        if (includeScalebar && state.isOrthographic) {
            drawScalebarOnCanvas(cropCanvas);
        }

        const axImg = cropCanvas.toDataURL('image/jpeg', 0.9);
        const cellX = margin + axView.col * (cellSize + cellGap);
        const cellY = gridStartY + axView.row * (cellSize + cellGap + labelSpace);

        pdf.setDrawColor(180, 180, 180);
        pdf.setLineWidth(0.3);
        pdf.rect(cellX, cellY, cellSize, cellSize);
        pdf.addImage(axImg, 'JPEG', cellX, cellY, cellSize, cellSize);

        pdf.setFontSize(8);
        pdf.setTextColor(120, 120, 120);
        pdf.text(axView.name, cellX + cellSize / 2, cellY + cellSize + 6, { align: 'center' });
    }
}

/**
 * Renders the table of contents page.
 * @param {jsPDF} pdf - The jsPDF instance
 * @param {Array} tocData - Array of {type, name, page} entries
 * @param {Object} layout - Page layout constants
 */
function pdfRenderTOC(pdf, tocData, layout) {
    const { margin, pageWidth, pageHeight } = layout;

    pdf.addPage();
    pdf.setFontSize(18);
    pdf.setTextColor(170, 129, 1);
    pdf.text('Table of Contents', margin, 20);

    let yPos = 35;
    pdf.setFontSize(10);

    tocData.forEach(item => {
        if (yPos > pageHeight - 20) {
            pdf.addPage();
            yPos = 20;
        }

        if (item.type === 'group') {
            pdf.setTextColor(170, 129, 1);
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

    // Position camera to frame the annotation
    const center = new THREE.Vector3();
    const annPoints = ann.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
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
    const baseDistance = annExtent > 0 ? annExtent * 2 : maxDim * 0.15;
    const distance = Math.max(baseDistance, maxDim * 0.08);

    const angle = Math.PI / 3; // 60 degrees from horizontal
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
    const typeLabels = { point: 'Point', line: 'Line', polygon: 'Polygon', surface: 'Surface' };
    pdf.text(typeLabels[ann.type] || ann.type, margin, contentStartY + 6);

    // Screenshot
    const canvasAspect = dom.canvas.width / dom.canvas.height;
    const screenshotHeight = contentWidth / canvasAspect;
    const screenshotY = contentStartY + 10;
    pdf.addImage(screenshot, 'JPEG', margin, screenshotY, contentWidth, screenshotHeight);

    // Coordinates
    pdf.setFontSize(7);
    pdf.setTextColor(150, 150, 150);
    const coordStrings = ann.points.map((p, i) =>
        `P${i + 1}: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`
    );
    const coordLine = coordStrings.join('  \u2022  ');
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
async function doExportPdfReport(includeScalebar) {
    // Store and override light settings for consistent screenshots
    const originalLightMode = state.lightFollowsCamera;
    state.lightFollowsCamera = true;

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const layout = {
        pageWidth: 210,
        pageHeight: 297,
        margin: 15,
        contentWidth: 210 - 30  // pageWidth - 2*margin
    };

    // Save camera state
    const savedCamera = pdfSaveCameraState();

    showStatus('Generating PDF report...');
    renderAnnotations();
    await delay(100);

    // Determine visible content
    const visibleGroups = state.groups.filter(g => g.visible);
    const visibleAnnotations = state.annotations.filter(ann => {
        const group = state.groups.find(g => g.id === ann.groupId);
        return group && group.visible;
    });

    // Build table of contents data
    const tocData = [];
    let pageNum = 4; // After title, axis views, and TOC pages
    visibleGroups.forEach(group => {
        const groupAnns = visibleAnnotations.filter(a => a.groupId === group.id);
        if (groupAnns.length > 0) {
            tocData.push({ type: 'group', name: group.name, page: pageNum });
            groupAnns.forEach((ann, idx) => {
                if (idx === 0) {
                    tocData.push({ type: 'annotation', name: ann.name, page: pageNum });
                } else {
                    tocData.push({ type: 'annotation', name: ann.name, page: pageNum });
                }
                pageNum++;
            });
        }
    });

    // Render each section
    await pdfRenderTitlePage(pdf, layout, includeScalebar, visibleGroups, visibleAnnotations);

    await pdfRenderAxisViews(pdf, layout, includeScalebar);
    pdfRestoreCamera(savedCamera);

    pdfRenderTOC(pdf, tocData, layout);

    // Render annotation pages
    for (const group of visibleGroups) {
        const groupAnns = visibleAnnotations.filter(a => a.groupId === group.id);
        if (groupAnns.length === 0) continue;

        for (let annIdx = 0; annIdx < groupAnns.length; annIdx++) {
            await pdfRenderAnnotationPage(pdf, groupAnns[annIdx], group, groupAnns, annIdx, layout, includeScalebar);
        }
    }

    // Restore everything
    pdfRestoreCamera(savedCamera);
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
