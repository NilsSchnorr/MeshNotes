// js/ui/event-listeners.js
import { state, dom } from '../state.js';
import { showStatus, filterAnnotations, toggleManualItem } from '../utils/helpers.js';
import { loadModel, toggleTexture, applyDisplayMode, loadOBJModel, loadOBJPlain, loadPLYModel, loadSTLModel } from '../core/model-loader.js';
import { toggleCamera } from '../core/camera.js';
import { toggleFlip } from '../core/scene.js';
import { setBrightness, setModelOpacity, toggleLightMode, setLightAzimuth, setLightElevation, setPointSize, setTextSize, setBackgroundColor, setDefaultAuthor, setDefaultAuthorOrcid, setMeasurementUnit, setMeasurementLineColor, setMeasurementPointColor, setMeshColor, setWireframeColor, setPdfTitle, setPdfInstitution, setPdfProject, setPdfAccentColor, setPdfPageSize, setPdfOrientation, setPdfDpi, setPdfCameraDistance, setPdfCameraAngle, setScreenshotQuality, resetAllSettings } from '../core/lighting.js';
import { onCanvasTap, onCanvasDoubleTap, onCanvasPointerDown, onCanvasPointerMove, onCanvasPointerUp, clearTempDrawing, cancelUnfinishedDrawing, clearAllMeasurements, undoLastPoint, undoLastSurfaceStroke, undoLastMeasurePoint } from '../annotation-tools/editing.js';
import { initCanvasTouchAction } from '../input/pointer-manager.js';
import { openGroupPopup, saveGroup, deleteGroup, updateGroupsList, createDefaultGroup, createGroupInline, showInlineGroupForm, hideInlineGroupForm } from '../annotation-tools/groups.js';
import { saveAnnotation, deleteAnnotation, addLink, showAddEntryForm, hideConfirm, hideScalebarConfirm, openModelInfoPopup, updateModelInfoDisplay } from '../annotation-tools/data.js';
import { takeScreenshot } from '../export/screenshot.js';
import { exportAnnotations } from '../export/export-json.js';
import { exportPdfReport } from '../export/pdf-report.js';
import { importAnnotations } from '../export/import-json.js';
import { openMetadataPopup, closeMetadataPopup, saveMetadata, initMetadata, updateMetadataDisplay } from '../metadata/metadata-ui.js';
import { downloadMetadataJSON, downloadMetadataPDF, importMetadataJSON } from '../metadata/metadata-io.js';
import { getMetadataStats } from '../metadata/templates.js';
import { downloadManualAsPdf } from '../export/pdf-manual.js';
import { shareModel, generateEphemeralLink, copyShareLink, closeShareDialog, showLongTermShareDialog, showEphemeralShareDialog, generateLongTermLink, toggleHistory, generateAnnotationShareLink, copyAnnotationShareLink, closeAnnotationShareDialog, toggleAnnotationShareHistory } from '../export/share.js';
import { renderAnnotations } from '../annotation-tools/render.js';
import { showToolHelp, restoreToolHelp, clearBoxEditState } from './tool-help.js';
import { toggleCuttingPlane, extractProfile, closeProfilePreview, downloadProfileSVG, downloadProfilePNG, onCuttingPlanePointerDown, onCuttingPlanePointerMove, onCuttingPlanePointerUp, cleanupCuttingPlane } from '../annotation-tools/cutting-plane.js';

// Re-export for modules that import from here
export { hideToolHelp, restoreToolHelp, hideAllToolPanels, showBoxEditHelp, clearBoxEditState } from './tool-help.js';

export function setTool(tool) {
    // If a box was unlocked, lock it and update visual feedback
    const hadUnlockedBox = state.boxEditUnlocked !== null;
    const previousTool = state.currentTool;

    state.currentTool = tool;

    // Reset the canvas cursor on every tool change; a leftover 'move'/'grab'/
    // 'resize' cursor from box hover or manipulation would otherwise stick,
    // since the drawing tools never set the cursor themselves.
    dom.canvas.style.cursor = 'default';

    // Clean up cutting plane when leaving the measure tool
    if (previousTool === 'measure' && tool !== 'measure') {
        cleanupCuttingPlane();
    }

    // Clear box edit state when selecting any tool
    clearBoxEditState();
    
    // Update visual feedback if we had an unlocked box
    if (hadUnlockedBox) {
        renderAnnotations();
    }

    // Update button states
    const toolButtons = [dom.btnPoint, dom.btnLine, dom.btnPolygon, dom.btnSurface, dom.btnBox, dom.btnMeasure];
    toolButtons.forEach(btn => btn.classList.remove('active'));

    if (tool === 'point') dom.btnPoint.classList.add('active');
    else if (tool === 'line') dom.btnLine.classList.add('active');
    else if (tool === 'polygon') dom.btnPolygon.classList.add('active');
    else if (tool === 'surface') dom.btnSurface.classList.add('active');
    else if (tool === 'box') dom.btnBox.classList.add('active');
    else if (tool === 'measure') dom.btnMeasure.classList.add('active');

    // Show/hide tool info panels (tool-help, brush-display, measurement-display)
    // All panel visibility is managed by showToolHelp() in tool-help.js
    showToolHelp(tool);
}

function getSelectedUpAxis(radioName) {
    const selected = document.querySelector(`input[name="${radioName}"]:checked`);
    return selected ? selected.value : 'z-up';
}

// ============ Annotation Clearing on Model Load ============

/**
 * Clears all annotations, groups, measurements, and model info,
 * then resets the workspace to a clean state with a default group.
 */
function clearAnnotationsAndGroups() {
    state.annotations = [];
    state.groups = [];
    state.selectedAnnotation = null;
    state.editingAnnotation = null;
    // New model = fresh metadata (metadata is per-model). The loader resets
    // modelInfo too; resetting here keeps the sidebar in sync immediately.
    state.modelInfo = { entries: [] };
    initMetadata();
    updateMetadataDisplay();

    // Close any open popups
    dom.annotationPopup.classList.remove('visible');
    dom.groupPopup.classList.remove('visible');
    const metadataPopup = document.getElementById('metadata-popup');
    if (metadataPopup) metadataPopup.classList.remove('visible');
    state.isAddingEntry = false;
    state.editingEntryId = null;
    state.editingModelInfo = false;

    // Clear active tool state
    setTool(null);
    clearTempDrawing();
    clearAllMeasurements();

    // Re-create default group and update UI
    createDefaultGroup();
    renderAnnotations();
    updateGroupsList();
    updateModelInfoDisplay();
}

function hideAnnotationClearDialog() {
    dom.annotationClearOverlay.classList.remove('visible');
}

function hideRefreshConfirmDialog() {
    dom.refreshConfirmOverlay.classList.remove('visible');
}

/**
 * Downloads all model files (model + materials/textures) to the user's computer.
 * For OBJ: downloads OBJ + MTL + texture files.
 * For PLY: downloads PLY + texture file if present.
 * For GLB: downloads the single GLB file.
 */
function downloadModelFiles() {
    if (!state.loadedModelFiles || state.loadedModelFiles.length === 0) {
        showStatus('No model files to export');
        return;
    }

    const files = state.loadedModelFiles;
    let downloadIndex = 0;

    function downloadNext() {
        if (downloadIndex >= files.length) {
            showStatus(`Downloaded ${files.length} model file${files.length > 1 ? 's' : ''}`);
            return;
        }

        const file = files[downloadIndex];
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        downloadIndex++;

        // Small delay between downloads so the browser doesn't block them
        if (downloadIndex < files.length) {
            setTimeout(downloadNext, 300);
        } else {
            downloadNext();
        }
    }

    downloadNext();
}

/**
 * Returns true if the current session holds work that loading a new model (or
 * refreshing) would discard: annotations, model-information notes, or filled
 * metadata.
 */
function sessionHasContent() {
    if (state.annotations.length > 0) return true;
    if (state.modelInfo.entries && state.modelInfo.entries.length > 0) return true;
    if (state.modelInfo.metadata && getMetadataStats(state.modelInfo.metadata).filled > 0) return true;
    return false;
}

/**
 * Builds a human-readable description of the work currently held in the
 * session, e.g. "12 annotations, metadata and model information".
 */
function describeSessionContent() {
    const parts = [];
    const a = state.annotations.length;
    if (a > 0) parts.push(`${a} annotation${a !== 1 ? 's' : ''}`);
    const filled = state.modelInfo.metadata ? getMetadataStats(state.modelInfo.metadata).filled : 0;
    if (filled > 0) parts.push('metadata');
    const e = state.modelInfo.entries ? state.modelInfo.entries.length : 0;
    if (e > 0) parts.push('model information');
    if (parts.length === 0) return 'unsaved work';
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/**
 * Wraps loadModel() with a check for existing session content (annotations,
 * model-info notes, or filled metadata). If any exists, prompts the user to
 * export (JSON-LD), discard, or cancel before the load clears it.
 */
function handleModelLoad(file) {
    if (!sessionHasContent()) {
        loadModel(file);
        return;
    }

    // Store file reference and show the three-option dialog
    const pendingFile = file;

    // Describe what the load will clear (annotations, metadata, model info)
    document.getElementById('annotation-clear-message').textContent =
        `You have ${describeSessionContent()} in the current session. Loading a new model will clear it. What would you like to do?`;

    dom.annotationClearOverlay.classList.add('visible');

    // Remove old listeners to avoid stacking
    const newCancel = dom.annotationClearCancel.cloneNode(true);
    const newDiscard = dom.annotationClearDiscard.cloneNode(true);
    const newExport = dom.annotationClearExport.cloneNode(true);
    dom.annotationClearCancel.replaceWith(newCancel);
    dom.annotationClearDiscard.replaceWith(newDiscard);
    dom.annotationClearExport.replaceWith(newExport);
    dom.annotationClearCancel = newCancel;
    dom.annotationClearDiscard = newDiscard;
    dom.annotationClearExport = newExport;

    newCancel.addEventListener('click', () => {
        hideAnnotationClearDialog();
    });

    newDiscard.addEventListener('click', () => {
        hideAnnotationClearDialog();
        clearAnnotationsAndGroups();
        loadModel(pendingFile);
    });

    newExport.addEventListener('click', () => {
        hideAnnotationClearDialog();
        exportAnnotations();
        clearAnnotationsAndGroups();
        loadModel(pendingFile);
    });
}

export function setupEventListeners() {
    // File loading
    dom.btnLoad.addEventListener('click', () => {
        dom.importDropdown.classList.remove('open');
        dom.fileInput.click();
    });
    dom.fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) handleModelLoad(e.target.files[0]);
        dom.fileInput.value = '';
    });

    // OBJ dialog
    let pendingObjUpAxis = 'z-up';

    // OBJ dialog close button and overlay click
    document.getElementById('obj-dialog-close').addEventListener('click', () => {
        dom.objDialogOverlay.classList.remove('visible');
        state.pendingObjFile = null;
    });
    dom.objDialogOverlay.addEventListener('click', (e) => {
        if (e.target === dom.objDialogOverlay) {
            dom.objDialogOverlay.classList.remove('visible');
            state.pendingObjFile = null;
        }
    });

    dom.objLoadPlain.addEventListener('click', () => {
        const upAxis = getSelectedUpAxis('obj-up-axis');
        dom.objDialogOverlay.classList.remove('visible');
        if (state.pendingObjFile) {
            loadOBJModel(state.pendingObjFile, null, upAxis);
            state.pendingObjFile = null;
        }
    });

    dom.objAddMaterials.addEventListener('click', () => {
        pendingObjUpAxis = getSelectedUpAxis('obj-up-axis');
        dom.objDialogOverlay.classList.remove('visible');
        dom.objMaterialInput.click();

        const handleCancel = () => {
            window.removeEventListener('focus', handleCancel);
            setTimeout(() => {
                if (state.pendingObjFile && dom.objMaterialInput.files.length === 0) {
                    loadOBJModel(state.pendingObjFile, null, pendingObjUpAxis);
                    state.pendingObjFile = null;
                }
            }, 300);
        };
        window.addEventListener('focus', handleCancel);
    });

    dom.objMaterialInput.addEventListener('change', (e) => {
        if (state.pendingObjFile) {
            const materialFiles = Array.from(e.target.files);
            loadOBJModel(state.pendingObjFile, materialFiles, pendingObjUpAxis);
            state.pendingObjFile = null;
        }
        dom.objMaterialInput.value = '';
    });

    // PLY dialog
    let pendingPlyUpAxis = 'z-up';

    // PLY dialog close button and overlay click
    document.getElementById('ply-dialog-close').addEventListener('click', () => {
        dom.plyDialogOverlay.classList.remove('visible');
        state.pendingPlyFile = null;
    });
    dom.plyDialogOverlay.addEventListener('click', (e) => {
        if (e.target === dom.plyDialogOverlay) {
            dom.plyDialogOverlay.classList.remove('visible');
            state.pendingPlyFile = null;
        }
    });

    dom.plyLoadPlain.addEventListener('click', () => {
        const upAxis = getSelectedUpAxis('ply-up-axis');
        dom.plyDialogOverlay.classList.remove('visible');
        if (state.pendingPlyFile) {
            loadPLYModel(state.pendingPlyFile, null, upAxis);
            state.pendingPlyFile = null;
        }
    });

    dom.plyAddTexture.addEventListener('click', () => {
        pendingPlyUpAxis = getSelectedUpAxis('ply-up-axis');
        dom.plyDialogOverlay.classList.remove('visible');
        dom.plyTextureInput.click();

        const handleCancel = () => {
            window.removeEventListener('focus', handleCancel);
            setTimeout(() => {
                if (state.pendingPlyFile && dom.plyTextureInput.files.length === 0) {
                    loadPLYModel(state.pendingPlyFile, null, pendingPlyUpAxis);
                    state.pendingPlyFile = null;
                }
            }, 300);
        };
        window.addEventListener('focus', handleCancel);
    });

    dom.plyTextureInput.addEventListener('change', (e) => {
        if (state.pendingPlyFile) {
            const textureFile = e.target.files[0] || null;
            loadPLYModel(state.pendingPlyFile, textureFile, pendingPlyUpAxis);
            state.pendingPlyFile = null;
        }
        dom.plyTextureInput.value = '';
    });

    // STL dialog
    document.getElementById('stl-dialog-close').addEventListener('click', () => {
        dom.stlDialogOverlay.classList.remove('visible');
        state.pendingStlFile = null;
    });
    dom.stlDialogOverlay.addEventListener('click', (e) => {
        if (e.target === dom.stlDialogOverlay) {
            dom.stlDialogOverlay.classList.remove('visible');
            state.pendingStlFile = null;
        }
    });

    dom.stlLoadBtn.addEventListener('click', () => {
        const upAxis = getSelectedUpAxis('stl-up-axis');
        dom.stlDialogOverlay.classList.remove('visible');
        if (state.pendingStlFile) {
            loadSTLModel(state.pendingStlFile, upAxis);
            state.pendingStlFile = null;
        }
    });

    // Toolbar buttons
    dom.btnTexture.addEventListener('click', toggleTexture);

    // Toggle tool: tap active tool again to deselect (also cleans up in-progress drawing)
    function toggleTool(tool) {
        if (state.currentTool === tool) {
            clearTempDrawing();
            setTool(null);
        } else {
            // Switching to a different tool: cancel any in-progress drawing/box/
            // surface (measurements deliberately persist), then activate the tool.
            cancelUnfinishedDrawing();
            setTool(tool);
        }
    }

    dom.btnPoint.addEventListener('click', () => toggleTool('point'));
    dom.btnLine.addEventListener('click', () => toggleTool('line'));
    dom.btnPolygon.addEventListener('click', () => toggleTool('polygon'));
    dom.btnSurface.addEventListener('click', () => toggleTool('surface'));
    dom.btnBox.addEventListener('click', () => toggleTool('box'));
    dom.btnMeasure.addEventListener('click', () => toggleTool('measure'));
    dom.btnScreenshot.addEventListener('click', takeScreenshot);

    // --- Touch dropdown portal ---
    // On touch devices the toolbar has overflow-x:auto which clips
    // position:absolute AND position:fixed children (WebKit treats the
    // scroll container as a containing block). Fix: portal the menu
    // to <body> while the dropdown is open.
    const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const _touchMenuRefs = new Map();

    if (isCoarsePointer) {
        _touchMenuRefs.set(dom.importDropdown, dom.importDropdown.querySelector('.export-dropdown-menu'));
        _touchMenuRefs.set(dom.exportDropdown, dom.exportDropdown.querySelector('.export-dropdown-menu'));

        const menuObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.attributeName !== 'class') continue;
                const dropdown = mutation.target;
                const menu = _touchMenuRefs.get(dropdown);
                if (!menu) continue;

                if (dropdown.classList.contains('open')) {
                    const button = dropdown.querySelector('.tool-btn');
                    const rect = button.getBoundingClientRect();
                    document.body.appendChild(menu);
                    Object.assign(menu.style, {
                        position: 'fixed',
                        display: 'block',
                        left: rect.left + 'px',
                        top: (rect.bottom + 4) + 'px',
                        zIndex: '10000',
                    });
                } else if (menu.parentElement !== dropdown) {
                    dropdown.appendChild(menu);
                    menu.style.cssText = '';
                }
            }
        });

        menuObserver.observe(dom.importDropdown, { attributes: true, attributeFilter: ['class'] });
        menuObserver.observe(dom.exportDropdown, { attributes: true, attributeFilter: ['class'] });
    }

    // Export dropdown
    dom.btnExport.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.exportDropdown.classList.toggle('open');
        dom.importDropdown.classList.remove('open');
    });
    dom.btnExportJsonld.addEventListener('click', () => {
        dom.exportDropdown.classList.remove('open');
        exportAnnotations();
    });
    dom.btnExportPdf.addEventListener('click', () => {
        dom.exportDropdown.classList.remove('open');
        exportPdfReport();
    });
    dom.btnExportModel.addEventListener('click', () => {
        dom.exportDropdown.classList.remove('open');
        downloadModelFiles();
    });
    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        // On touch devices, portaled menus live on <body>; check them too
        const exportMenu = _touchMenuRefs.get(dom.exportDropdown);
        const importMenu = _touchMenuRefs.get(dom.importDropdown);
        if (!dom.exportDropdown.contains(e.target) && !(exportMenu && exportMenu.contains(e.target))) {
            dom.exportDropdown.classList.remove('open');
        }
        if (!dom.importDropdown.contains(e.target) && !(importMenu && importMenu.contains(e.target))) {
            dom.importDropdown.classList.remove('open');
        }
    });
    dom.btnImport.addEventListener('click', () => {
        dom.importDropdown.classList.remove('open');
        dom.importInput.click();
    });
    dom.importInput.addEventListener('change', (e) => {
        if (e.target.files[0]) importAnnotations(e.target.files[0]);
    });

    // Import dropdown
    dom.btnImportMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.importDropdown.classList.toggle('open');
        dom.exportDropdown.classList.remove('open');
    });

    // Share button and dialog
    dom.btnShare.addEventListener('click', shareModel);
    document.getElementById('share-modal-close').addEventListener('click', closeShareDialog);
    document.getElementById('share-copy-btn').addEventListener('click', copyShareLink);
    document.getElementById('share-generate-btn').addEventListener('click', generateEphemeralLink);
    document.getElementById('share-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'share-overlay') closeShareDialog();
    });

    // Share mode toggle (ephemeral vs long-term)
    document.getElementById('share-mode-ephemeral').addEventListener('click', () => {
        document.getElementById('share-mode-ephemeral').classList.add('active');
        document.getElementById('share-mode-longterm').classList.remove('active');
        showEphemeralShareDialog();
    });
    document.getElementById('share-mode-longterm').addEventListener('click', () => {
        document.getElementById('share-mode-longterm').classList.add('active');
        document.getElementById('share-mode-ephemeral').classList.remove('active');
        showLongTermShareDialog();
    });
    document.getElementById('longterm-generate-btn').addEventListener('click', generateLongTermLink);
    document.getElementById('share-history-toggle').addEventListener('click', toggleHistory);

    // Per-annotation share dialog ("See what I see")
    document.getElementById('annotation-share-modal-close').addEventListener('click', closeAnnotationShareDialog);
    document.getElementById('ann-share-cancel-btn').addEventListener('click', closeAnnotationShareDialog);
    document.getElementById('ann-share-generate-btn').addEventListener('click', generateAnnotationShareLink);
    document.getElementById('ann-share-copy-btn').addEventListener('click', copyAnnotationShareLink);
    document.getElementById('ann-share-history-toggle').addEventListener('click', toggleAnnotationShareHistory);
    document.getElementById('annotation-share-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'annotation-share-overlay') closeAnnotationShareDialog();
    });

    // Brush size slider
    dom.brushSlider.addEventListener('input', (e) => {
        state.surfaceBrushSize = parseFloat(e.target.value);
        dom.brushValue.textContent = state.surfaceBrushSize + '%';
    });

    // Cutting plane buttons
    document.getElementById('btn-spawn-plane').addEventListener('click', toggleCuttingPlane);
    document.getElementById('btn-extract-profile').addEventListener('click', extractProfile);

    // Profile preview overlay
    document.getElementById('btn-download-svg').addEventListener('click', downloadProfileSVG);
    document.getElementById('btn-download-png').addEventListener('click', downloadProfilePNG);
    document.getElementById('btn-profile-cancel').addEventListener('click', closeProfilePreview);
    document.getElementById('profile-preview-close').addEventListener('click', closeProfilePreview);
    document.getElementById('profile-preview-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'profile-preview-overlay') closeProfilePreview();
    });

    // Search filter
    dom.searchInput.addEventListener('input', (e) => {
        filterAnnotations(e.target.value);
    });

    // Group popup
    dom.btnAddGroup.addEventListener('click', () => openGroupPopup());
    dom.btnGroupSave.addEventListener('click', saveGroup);
    dom.btnGroupCancel.addEventListener('click', () => {
        dom.groupPopup.classList.remove('visible');
        state.editingGroup = null;
    });
    dom.btnGroupDelete.addEventListener('click', () => {
        if (state.editingGroup) deleteGroup(state.editingGroup);
    });
    dom.groupOpacity.addEventListener('input', (e) => {
        dom.groupOpacityValue.textContent = e.target.value + '%';
    });

    // Group popup X close button
    document.getElementById('group-popup-close').addEventListener('click', () => {
        dom.groupPopup.classList.remove('visible');
        state.editingGroup = null;
    });

    // Inline group creation in annotation popup
    dom.btnAddGroupInline.addEventListener('click', showInlineGroupForm);
    dom.btnSaveInlineGroup.addEventListener('click', createGroupInline);
    dom.btnCancelInlineGroup.addEventListener('click', hideInlineGroupForm);
    dom.inlineGroupName.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createGroupInline();
    });

    // Annotation popup X close button
    document.getElementById('annotation-popup-close').addEventListener('click', () => {
        dom.annotationPopup.classList.remove('visible');
        clearTempDrawing();
        state.editingAnnotation = null;
        state.editingModelInfo = false;
        state.isAddingEntry = false;
        state.editingEntryId = null;
        hideInlineGroupForm();
        restoreToolHelp();
        state.controls.enabled = true;
    });

    // Annotation popup
    dom.btnPopupSave.addEventListener('click', () => {
        saveAnnotation();
        // Safety net: always re-enable orbit after popup closes
        state.controls.enabled = true;
    });
    dom.btnPopupCancel.addEventListener('click', () => {
        dom.annotationPopup.classList.remove('visible');
        clearTempDrawing();
        state.editingAnnotation = null;
        state.editingModelInfo = false;
        state.isAddingEntry = false;
        state.editingEntryId = null;
        hideInlineGroupForm();
        // Restore tool help if a tool is still active
        restoreToolHelp();
        // Safety net: always re-enable orbit after popup closes
        state.controls.enabled = true;
    });
    dom.btnPopupDelete.addEventListener('click', deleteAnnotation);
    dom.btnAddLink.addEventListener('click', addLink);
    dom.annNewLink.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addLink();
    });

    // Add Entry button
    dom.btnAddEntry.addEventListener('click', showAddEntryForm);

    // Model Info double-click
    dom.modelInfoItem.addEventListener('dblclick', openModelInfoPopup);

    document.getElementById('model-info-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openModelInfoPopup();
    });

    // Metadata popup X close button
    document.getElementById('metadata-popup-close').addEventListener('click', () => {
        closeMetadataPopup();
    });

    // Metadata popup
    document.getElementById('metadata-item').addEventListener('dblclick', openMetadataPopup);
    document.getElementById('metadata-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openMetadataPopup();
    });
    document.getElementById('btn-metadata-save').addEventListener('click', saveMetadata);
    document.getElementById('btn-metadata-close').addEventListener('click', closeMetadataPopup);
    document.getElementById('btn-metadata-download-json').addEventListener('click', downloadMetadataJSON);
    document.getElementById('btn-metadata-download-pdf').addEventListener('click', downloadMetadataPDF);
    document.getElementById('metadata-upload-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            importMetadataJSON(e.target.files[0]);
            e.target.value = ''; // Reset so same file can be re-imported
        }
    });

    // Confirm dialog X close button
    document.getElementById('confirm-dialog-close').addEventListener('click', hideConfirm);

    // Confirmation dialog
    dom.confirmOk.addEventListener('click', () => {
        if (state.confirmCallback) state.confirmCallback();
        hideConfirm();
    });
    dom.confirmCancel.addEventListener('click', hideConfirm);
    dom.confirmOverlay.addEventListener('click', (e) => {
        if (e.target === dom.confirmOverlay) hideConfirm();
    });

    // Annotation clear dialog X close button
    document.getElementById('annotation-clear-dialog-close').addEventListener('click', () => {
        hideAnnotationClearDialog();
    });

    // Annotation clear dialog - click overlay to dismiss
    dom.annotationClearOverlay.addEventListener('click', (e) => {
        if (e.target === dom.annotationClearOverlay) hideAnnotationClearDialog();
    });

    // Logo click — refresh with confirmation if the session holds work
    document.getElementById('header-logo').addEventListener('click', () => {
        if (!sessionHasContent()) {
            location.reload();
            return;
        }

        document.getElementById('refresh-confirm-message').textContent =
            `You have ${describeSessionContent()} in the current session. What would you like to do before refreshing?`;

        dom.refreshConfirmOverlay.classList.add('visible');
    });

    // Refresh confirm dialog — close button
    document.getElementById('refresh-confirm-dialog-close').addEventListener('click', hideRefreshConfirmDialog);

    // Refresh confirm dialog — overlay click to dismiss
    dom.refreshConfirmOverlay.addEventListener('click', (e) => {
        if (e.target === dom.refreshConfirmOverlay) hideRefreshConfirmDialog();
    });

    // Refresh confirm dialog — buttons
    dom.refreshConfirmCancel.addEventListener('click', hideRefreshConfirmDialog);

    dom.refreshConfirmRefresh.addEventListener('click', () => {
        hideRefreshConfirmDialog();
        location.reload();
    });

    dom.refreshConfirmExport.addEventListener('click', () => {
        hideRefreshConfirmDialog();
        exportAnnotations();
        setTimeout(() => location.reload(), 500);
    });

    // Scalebar confirm dialog X close button
    document.getElementById('scalebar-confirm-dialog-close').addEventListener('click', () => {
        hideScalebarConfirm();
    });

    // Scalebar confirmation dialog
    dom.scalebarSwitch.addEventListener('click', () => {
        if (state.scalebarConfirmCallback) state.scalebarConfirmCallback();
        hideScalebarConfirm();
    });
    dom.scalebarNoSwitch.addEventListener('click', () => {
        const callback = state.scalebarNoSwitchCallback;
        hideScalebarConfirm();
        if (callback) callback();
    });
    dom.scalebarConfirmOverlay.addEventListener('click', (e) => {
        if (e.target === dom.scalebarConfirmOverlay) hideScalebarConfirm();
    });

    // Canvas pointer events with capture phase interception for stylus/tablet support
    setupCanvasPointerEvents();

    // Prevent context menu when right-clicking on boxes (for rotation)
    dom.canvas.addEventListener('contextmenu', (e) => {
        if (state.isManipulatingBox && state.boxManipulationMode === 'rotate') {
            e.preventDefault();
        }
        // Prevent context menu during cutting plane rotation
        if (state.cuttingPlaneActive && state.currentTool === 'measure') {
            e.preventDefault();
        }
    });

    // Sliders
    dom.brightnessSlider.addEventListener('input', (e) => setBrightness(parseInt(e.target.value)));
    dom.opacitySlider.addEventListener('input', (e) => setModelOpacity(parseInt(e.target.value)));
    dom.lightToggle.addEventListener('click', toggleLightMode);
    dom.lightAzimuthSlider.addEventListener('input', (e) => setLightAzimuth(parseInt(e.target.value)));
    dom.lightElevationSlider.addEventListener('input', (e) => setLightElevation(parseInt(e.target.value)));
    dom.pointSizeSlider.addEventListener('input', (e) => { setPointSize(parseInt(e.target.value)); renderAnnotations(); });
    dom.textSizeSlider.addEventListener('input', (e) => { setTextSize(parseInt(e.target.value)); renderAnnotations(); });
    
    // Background color controls
    dom.backgroundColorPicker.addEventListener('input', (e) => setBackgroundColor(e.target.value));
    document.querySelectorAll('.bg-preset').forEach(btn => {
        btn.addEventListener('click', () => setBackgroundColor(btn.dataset.color));
    });

    // Sliders panel toggle
    dom.slidersPanelToggle.addEventListener('click', () => {
        dom.slidersPanel.classList.toggle('collapsed');
        dom.slidersPanelToggle.textContent = dom.slidersPanel.classList.contains('collapsed') ? '\u25B2' : '\u25BC';
    });

    // Popup dragging - only on desktop (pointer: fine)
    if (!window.matchMedia('(pointer: coarse)').matches) {
        dom.popupTitle.addEventListener('mousedown', (e) => {
            state.isDraggingPopup = true;
            const popupLeft = parseInt(dom.annotationPopup.style.left) || 0;
            const popupTop = parseInt(dom.annotationPopup.style.top) || 0;
            const viewportRect = dom.annotationPopup.parentElement.getBoundingClientRect();
            state.popupDragOffsetX = e.clientX - viewportRect.left - popupLeft;
            state.popupDragOffsetY = e.clientY - viewportRect.top - popupTop;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!state.isDraggingPopup) return;

            const viewportRect = dom.annotationPopup.parentElement.getBoundingClientRect();
            const viewportWidth = viewportRect.width;
            const viewportHeight = viewportRect.height;
            const popupRect = dom.annotationPopup.getBoundingClientRect();

            let newX = e.clientX - viewportRect.left - state.popupDragOffsetX;
            let newY = e.clientY - viewportRect.top - state.popupDragOffsetY;

            newX = Math.max(0, Math.min(newX, viewportWidth - popupRect.width));
            newY = Math.max(0, Math.min(newY, viewportHeight - popupRect.height));

            dom.annotationPopup.style.left = newX + 'px';
            dom.annotationPopup.style.top = newY + 'px';
            dom.annotationPopup.style.right = 'auto';
            dom.annotationPopup.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            state.isDraggingPopup = false;
        });
    }

    // About modal
    dom.btnAbout.addEventListener('click', () => {
        dom.aboutOverlay.classList.add('visible');
    });
    dom.aboutModalClose.addEventListener('click', () => {
        dom.aboutOverlay.classList.remove('visible');
    });
    dom.aboutOverlay.addEventListener('click', (e) => {
        if (e.target === dom.aboutOverlay) {
            dom.aboutOverlay.classList.remove('visible');
        }
    });

    // Manual modal
    dom.btnManual.addEventListener('click', () => {
        dom.manualOverlay.classList.add('visible');
    });
    dom.manualModalClose.addEventListener('click', () => {
        dom.manualOverlay.classList.remove('visible');
    });
    dom.manualOverlay.addEventListener('click', (e) => {
        if (e.target === dom.manualOverlay) {
            dom.manualOverlay.classList.remove('visible');
        }
    });

    // Download Manual as PDF
    dom.btnDownloadManual.addEventListener('click', downloadManualAsPdf);

    // Legal modal
    dom.btnLegal.addEventListener('click', () => {
        dom.legalOverlay.classList.add('visible');
    });
    dom.legalModalClose.addEventListener('click', () => {
        dom.legalOverlay.classList.remove('visible');
    });
    dom.legalOverlay.addEventListener('click', (e) => {
        if (e.target === dom.legalOverlay) {
            dom.legalOverlay.classList.remove('visible');
        }
    });

    // Camera toggle and flip toggle (now in sliders panel header)
    dom.cameraToggle.addEventListener('click', toggleCamera);
    dom.flipToggle.addEventListener('click', () => {
        // Measurements are stored in raw display space and are not flip-aware
        // (unlike annotations, which use the storage/display transform), so a
        // flip would leave them floating detached from the surface. Clear
        // them — both finalized and in-progress — before flipping.
        const hadMeasurements = state.measurements.length > 0 || state.measurePoints.length > 0;
        if (hadMeasurements) {
            clearAllMeasurements();
        }
        toggleFlip();
        renderAnnotations();
        if (hadMeasurements) {
            showStatus(state.isFlipped
                ? 'Model flipped — measurements cleared'
                : 'Model un-flipped — measurements cleared');
        }
    });
    
    // Settings modal
    const settingsModal = document.getElementById('settings-modal');
    const settingsHeader = document.getElementById('settings-modal-header');
    let isDraggingSettings = false;
    let settingsDragOffsetX = 0;
    let settingsDragOffsetY = 0;
    
    dom.btnSettings.addEventListener('click', () => {
        // Reset position to center when opening
        settingsModal.style.left = '';
        settingsModal.style.top = '';
        settingsModal.style.transform = '';
        dom.settingsOverlay.classList.add('visible');
    });
    dom.settingsModalClose.addEventListener('click', () => {
        dom.settingsOverlay.classList.remove('visible');
    });
    dom.settingsOverlay.addEventListener('click', (e) => {
        if (e.target === dom.settingsOverlay) {
            dom.settingsOverlay.classList.remove('visible');
        }
    });
    
    // Settings modal dragging
    settingsHeader.addEventListener('mousedown', (e) => {
        if (e.target === dom.settingsModalClose) return; // Don't drag when clicking close button
        isDraggingSettings = true;
        const rect = settingsModal.getBoundingClientRect();
        settingsDragOffsetX = e.clientX - rect.left;
        settingsDragOffsetY = e.clientY - rect.top;
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDraggingSettings) return;
        
        const newX = e.clientX - settingsDragOffsetX;
        const newY = e.clientY - settingsDragOffsetY;
        
        // Constrain to viewport
        const maxX = window.innerWidth - settingsModal.offsetWidth;
        const maxY = window.innerHeight - settingsModal.offsetHeight;
        
        settingsModal.style.left = Math.max(0, Math.min(newX, maxX)) + 'px';
        settingsModal.style.top = Math.max(0, Math.min(newY, maxY)) + 'px';
        settingsModal.style.transform = 'none';
    });
    
    document.addEventListener('mouseup', () => {
        isDraggingSettings = false;
    });
    
    // Settings: Default Author
    dom.settingsDefaultAuthor.addEventListener('input', (e) => {
        setDefaultAuthor(e.target.value);
    });
    
    // Settings: Default Author ORCID
    dom.settingsDefaultAuthorOrcid.addEventListener('input', (e) => {
        setDefaultAuthorOrcid(e.target.value);
    });
    
    // Settings: Measurement Unit
    dom.settingsMeasurementUnit.addEventListener('change', (e) => {
        if (e.target.value === 'custom') {
            dom.settingsMeasurementUnitCustom.style.display = 'block';
            dom.settingsMeasurementUnitCustom.focus();
            // If there's already a custom value, use it; otherwise wait for input
            if (dom.settingsMeasurementUnitCustom.value) {
                setMeasurementUnit(dom.settingsMeasurementUnitCustom.value, true);
            }
        } else {
            dom.settingsMeasurementUnitCustom.style.display = 'none';
            setMeasurementUnit(e.target.value);
        }
    });
    
    dom.settingsMeasurementUnitCustom.addEventListener('input', (e) => {
        const value = e.target.value.trim();
        if (value) {
            setMeasurementUnit(value, true);
        }
    });
    
    // Settings: Measurement Colors
    dom.settingsMeasurementLineColor.addEventListener('input', (e) => {
        setMeasurementLineColor(e.target.value);
    });
    
    dom.settingsMeasurementPointColor.addEventListener('input', (e) => {
        setMeasurementPointColor(e.target.value);
    });
    
    // Settings: Model Display Colors
    dom.settingsMeshColor.addEventListener('input', (e) => {
        setMeshColor(e.target.value);
        if (state.displayMode === 'mesh') applyDisplayMode();
    });
    
    dom.settingsWireframeColor.addEventListener('input', (e) => {
        setWireframeColor(e.target.value);
        if (state.displayMode === 'wireframe') applyDisplayMode();
    });
    
    // Settings: PDF Export
    dom.settingsPdfTitle.addEventListener('input', (e) => {
        setPdfTitle(e.target.value);
    });
    
    dom.settingsPdfInstitution.addEventListener('input', (e) => {
        setPdfInstitution(e.target.value);
    });
    
    dom.settingsPdfProject.addEventListener('input', (e) => {
        setPdfProject(e.target.value);
    });
    
    dom.settingsPdfAccentColor.addEventListener('input', (e) => {
        setPdfAccentColor(e.target.value);
    });
    
    dom.settingsPdfPageSize.addEventListener('change', (e) => {
        setPdfPageSize(e.target.value);
    });
    
    dom.settingsPdfOrientation.addEventListener('change', (e) => {
        setPdfOrientation(e.target.value);
    });
    
    dom.settingsPdfDpi.addEventListener('change', (e) => {
        setPdfDpi(e.target.value);
    });
    
    dom.settingsPdfCameraDistance.addEventListener('input', (e) => {
        setPdfCameraDistance(e.target.value);
    });
    
    dom.settingsPdfCameraAngle.addEventListener('input', (e) => {
        setPdfCameraAngle(e.target.value);
    });
    
    // Settings: Screenshot Quality
    dom.settingsScreenshotQuality.addEventListener('change', (e) => {
        setScreenshotQuality(e.target.value);
    });
    
    // Settings: Reset All
    dom.settingsResetAll.addEventListener('click', () => {
        if (confirm('Reset all settings to their default values?\n\nThis will clear your saved preferences for point size, text size, background color, model display colors, default author, and measurement unit.')) {
            resetAllSettings();
            showStatus('Settings reset to defaults');
        }
    });

    // Manual items - event delegation for dynamically generated content
    document.addEventListener('click', (e) => {
        const header = e.target.closest('.manual-item-header');
        if (header) {
            toggleManualItem(header);
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Undo last point/stroke with Ctrl+Z (Cmd+Z on Mac) for line/polygon/surface/measure tools
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            // Only trigger if we're in a supported tool and not in a text input
            const activeElement = document.activeElement;
            const isTextInput = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
            
            if (!isTextInput && (state.currentTool === 'line' || state.currentTool === 'polygon') && state.tempPoints.length > 0) {
                e.preventDefault();
                undoLastPoint();
                return;
            }
            
            if (!isTextInput && state.currentTool === 'surface' && state.surfaceStrokeHistory.length > 0) {
                e.preventDefault();
                undoLastSurfaceStroke();
                return;
            }
            
            if (!isTextInput && state.currentTool === 'measure' && state.measurePoints.length > 0) {
                e.preventDefault();
                undoLastMeasurePoint();
                return;
            }
        }
        
        if (e.key === 'Escape') {
            // Close profile preview overlay if open
            const profileOverlay = document.getElementById('profile-preview-overlay');
            if (profileOverlay && profileOverlay.classList.contains('visible')) {
                closeProfilePreview();
                return;
            }

            // Close export dropdown if open
            if (dom.exportDropdown.classList.contains('open')) {
                dom.exportDropdown.classList.remove('open');
                return;
            }

            if (dom.annotationClearOverlay.classList.contains('visible')) {
                hideAnnotationClearDialog();
                return;
            }

            if (dom.refreshConfirmOverlay.classList.contains('visible')) {
                hideRefreshConfirmDialog();
                return;
            }

            if (dom.confirmOverlay.classList.contains('visible')) {
                hideConfirm();
                return;
            }

            if (dom.aboutOverlay.classList.contains('visible')) {
                dom.aboutOverlay.classList.remove('visible');
                return;
            }

            if (dom.objDialogOverlay.classList.contains('visible')) {
                dom.objDialogOverlay.classList.remove('visible');
                state.pendingObjFile = null;
                return;
            }

            if (dom.plyDialogOverlay.classList.contains('visible')) {
                dom.plyDialogOverlay.classList.remove('visible');
                state.pendingPlyFile = null;
                return;
            }

            if (dom.stlDialogOverlay.classList.contains('visible')) {
                dom.stlDialogOverlay.classList.remove('visible');
                state.pendingStlFile = null;
                return;
            }

            if (dom.manualOverlay.classList.contains('visible')) {
                dom.manualOverlay.classList.remove('visible');
                return;
            }

            if (dom.legalOverlay.classList.contains('visible')) {
                dom.legalOverlay.classList.remove('visible');
                return;
            }

            if (dom.settingsOverlay.classList.contains('visible')) {
                dom.settingsOverlay.classList.remove('visible');
                return;
            }

            const shareOverlay = document.getElementById('share-overlay');
            if (shareOverlay && shareOverlay.classList.contains('visible')) {
                closeShareDialog();
                return;
            }

            const annShareOverlay = document.getElementById('annotation-share-overlay');
            if (annShareOverlay && annShareOverlay.classList.contains('visible')) {
                closeAnnotationShareDialog();
                return;
            }

            if (dom.scalebarConfirmOverlay.classList.contains('visible')) {
                hideScalebarConfirm();
                return;
            }

            const metadataPopupEl = document.getElementById('metadata-popup');
            if (metadataPopupEl && metadataPopupEl.classList.contains('visible')) {
                closeMetadataPopup();
                return;
            }

            dom.annotationPopup.classList.remove('visible');
            dom.groupPopup.classList.remove('visible');
            state.isAddingEntry = false;
            state.editingEntryId = null;
            state.editingModelInfo = false;
            hideInlineGroupForm();
            state.controls.enabled = true;

            if (state.currentTool === 'measure') {
                clearAllMeasurements();
                showStatus('Measurements cleared');
            }

            setTool(null);
            clearTempDrawing();
        }
    });

    // Sidebar toggle for tablet
    setupSidebarToggle();

    // Virtual keyboard handling for iOS
    setupVirtualKeyboardHandling();

    // Canvas touch-action must be 'none' so OrbitControls receives all pointer events
    initCanvasTouchAction();

    // Popup backdrop: auto-show when any viewport popup is visible, click to close
    setupPopupBackdrop();
}

// ============ Pointer Events with Capture Phase Interception ============

// Click/double-tap detection state
let _pointerDownX = 0;
let _pointerDownY = 0;
let _pointerDownTime = 0;
let _lastTapTime = 0;
let _lastTapX = 0;
let _lastTapY = 0;

// Apple Pencil barrel tap detection
// When configured to "Switch to Eraser" in iPad Settings, barrel tap toggles eraser mode.
// We detect this by watching for the eraser button (bit 32) in pointer events.
let _lastPenEraserState = false;
let _barrelTapCooldown = 0;

// Cutting plane drag/rotate interception flag
let _cuttingPlaneConsumed = false;

// Two-finger box rotation gesture state
const _activeTouches = new Map();
let _isRotatingBoxWithGesture = false;
let _boxGestureStartAngle = 0;
let _boxGestureStartRotation = null;

function setupCanvasPointerEvents() {
    const canvas = dom.canvas;

    // Capture phase: intercept pen events before OrbitControls.
    // MUST use stopImmediatePropagation for pen — plain stopPropagation
    // does NOT prevent other listeners on the SAME element (canvas) from
    // firing, so OrbitControls would still see pen events and corrupt its
    // internal pointer state, breaking subsequent finger orbit.
    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'pen') {
            e.stopImmediatePropagation();
            e.preventDefault();
            // Capture pen pointer to receive events even if stylus moves outside canvas
            canvas.setPointerCapture(e.pointerId);
            
            // Check for Apple Pencil barrel tap (eraser toggle)
            // When barrel is double-tapped, the eraser state toggles.
            // We detect this change and treat it as a "confirm" action.
            const isEraserActive = (e.buttons & 32) !== 0;
            if (isEraserActive !== _lastPenEraserState) {
                const now = Date.now();
                // Eraser state changed - this is likely a barrel tap
                // Only trigger if not in cooldown (prevents double-firing)
                if (now > _barrelTapCooldown && _shouldBarrelTapConfirm()) {
                    _barrelTapCooldown = now + 500; // 500ms cooldown
                    onCanvasDoubleTap(e);
                    _lastPenEraserState = isEraserActive;
                    return; // Don't process as normal tap
                }
                _lastPenEraserState = isEraserActive;
            }
            
            _handlePointerDown(e);
        } else if (e.pointerType === 'mouse') {
            _handlePointerDown(e);
        } else if (e.pointerType === 'touch') {
            _handleTouchDown(e);
        }
    }, { capture: true });

    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'pen') {
            e.stopImmediatePropagation();
            e.preventDefault();
            if (_cuttingPlaneConsumed && onCuttingPlanePointerMove(e)) return;
            onCanvasPointerMove(e);
        } else if (e.pointerType === 'mouse') {
            if (_cuttingPlaneConsumed && onCuttingPlanePointerMove(e)) return;
            onCanvasPointerMove(e);
        } else if (e.pointerType === 'touch') {
            _handleTouchMove(e);
        }
    }, { capture: true });

    canvas.addEventListener('pointerup', (e) => {
        if (e.pointerType === 'pen') {
            e.stopImmediatePropagation();
            // Release pointer capture
            if (canvas.hasPointerCapture(e.pointerId)) {
                canvas.releasePointerCapture(e.pointerId);
            }
            _handlePointerUp(e);
        } else if (e.pointerType === 'mouse') {
            _handlePointerUp(e);
        } else if (e.pointerType === 'touch') {
            _handleTouchUp(e);
        }
    }, { capture: true });

    canvas.addEventListener('pointercancel', (e) => {
        if (e.pointerType === 'pen') {
            // Release pointer capture on cancel
            if (canvas.hasPointerCapture(e.pointerId)) {
                canvas.releasePointerCapture(e.pointerId);
            }
            _handlePointerUp(e);
        } else if (e.pointerType === 'mouse') {
            _handlePointerUp(e);
        } else if (e.pointerType === 'touch') {
            _handleTouchUp(e);
        }
    }, { capture: true });
}

function _handlePointerDown(e) {
    // Check cutting plane interaction first when measure tool is active
    if (state.currentTool === 'measure' && state.cuttingPlaneActive) {
        if (onCuttingPlanePointerDown(e)) {
            _cuttingPlaneConsumed = true;
            return;
        }
    }
    _cuttingPlaneConsumed = false;

    _pointerDownX = e.clientX;
    _pointerDownY = e.clientY;
    _pointerDownTime = Date.now();
    onCanvasPointerDown(e);
}

/**
 * Determines if an Apple Pencil barrel tap should trigger a "confirm" action.
 * Returns true when we're in a state where double-tap would be meaningful:
 * - Drawing a line/polygon (would finish it)
 * - Placing a box (would confirm placement)
 * - Painting a surface (would finish it)
 * - Measuring (would complete measurement)
 */
function _shouldBarrelTapConfirm() {
    // Line/polygon in progress
    if ((state.currentTool === 'line' || state.currentTool === 'polygon') && 
        state.tempPoints.length > 0) {
        return true;
    }
    
    // Box placement in progress
    if (state.isBoxPlacementMode || state.boxEditUnlocked !== null) {
        return true;
    }
    
    // Surface painting in progress
    if (state.currentTool === 'surface' && state.paintedFaces.size > 0) {
        return true;
    }
    
    // Multi-point measurement in progress
    if (state.currentTool === 'measure' && state.measurePoints.length >= 2) {
        return true;
    }
    
    return false;
}

function _handlePointerUp(e) {
    // If cutting plane consumed the pointerdown, just release
    if (_cuttingPlaneConsumed) {
        onCuttingPlanePointerUp(e);
        _cuttingPlaneConsumed = false;
        return;
    }

    const dx = e.clientX - _pointerDownX;
    const dy = e.clientY - _pointerDownY;
    const distSq = dx * dx + dy * dy;
    const duration = Date.now() - _pointerDownTime;

    // Pen on glass wobbles more than a mouse on a desk — use a
    // larger movement threshold for pen so taps aren't rejected.
    const isPen = e.pointerType === 'pen';
    const clickDistThreshold = isPen ? 144 : 9;   // 12px vs 3px radius
    const isClick = distSq <= clickDistThreshold && duration < 600;

    if (isClick) {
        const now = Date.now();
        const tapDx = e.clientX - _lastTapX;
        const tapDy = e.clientY - _lastTapY;
        const tapDistSq = tapDx * tapDx + tapDy * tapDy;

        // Pen double-tap: wider timing window (600ms) and larger
        // spatial tolerance (50px radius) because the user lifts the
        // pen between taps and the second tap lands slightly offset.
        // These generous thresholds help with Apple Pencil on iPad.
        const dblTapTime = isPen ? 600 : 300;
        const dblTapDist = isPen ? 2500 : 400;

        if (now - _lastTapTime < dblTapTime && tapDistSq < dblTapDist) {
            onCanvasDoubleTap(e);
            _lastTapTime = 0;
        } else {
            onCanvasTap(e);
            _lastTapTime = now;
            _lastTapX = e.clientX;
            _lastTapY = e.clientY;
        }
    }

    onCanvasPointerUp(e);
}

// ============ Touch Handling: Tap Detection + Two-Finger Box Rotation ============

// Finger tap detection state (separate from pen/mouse)
let _touchDownX = 0;
let _touchDownY = 0;
let _touchDownTime = 0;
let _touchDownPointerId = -1;
let _lastFingerTapTime = 0;
let _lastFingerTapX = 0;
let _lastFingerTapY = 0;
let _touchWasDrag = false;

function _handleTouchDown(e) {
    _activeTouches.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY
    });

    // Record first finger down for tap detection (only single-finger taps)
    if (_activeTouches.size === 1) {
        _touchDownX = e.clientX;
        _touchDownY = e.clientY;
        _touchDownTime = Date.now();
        _touchDownPointerId = e.pointerId;
        _touchWasDrag = false;
    }

    // Check for two-finger gesture on box
    if (_activeTouches.size === 2 && state.boxEditUnlocked !== null) {
        _touchWasDrag = true; // Two fingers = not a tap
        const ann = state.annotations.find(a => a.id === state.boxEditUnlocked);
        if (ann && ann.type === 'box') {
            _startBoxRotationGesture(ann);
        }
    }

    // More than one finger means no tap
    if (_activeTouches.size > 1) {
        _touchWasDrag = true;
    }
}

function _handleTouchMove(e) {
    if (!_activeTouches.has(e.pointerId)) return;
    _activeTouches.get(e.pointerId).x = e.clientX;
    _activeTouches.get(e.pointerId).y = e.clientY;

    // Check if finger moved too far for a tap (10px threshold)
    if (e.pointerId === _touchDownPointerId && !_touchWasDrag) {
        const dx = e.clientX - _touchDownX;
        const dy = e.clientY - _touchDownY;
        if (dx * dx + dy * dy > 100) {
            _touchWasDrag = true;
        }
    }

    if (_isRotatingBoxWithGesture && _activeTouches.size === 2) {
        e.stopPropagation(); // Prevent OrbitControls during gesture
        _updateBoxRotationGesture();
    }
}

function _handleTouchUp(e) {
    _activeTouches.delete(e.pointerId);

    if (_activeTouches.size < 2 && _isRotatingBoxWithGesture) {
        _endBoxRotationGesture();
    }

    // Single-finger tap detection: short duration, no drag, no multi-touch
    if (e.pointerId === _touchDownPointerId && !_touchWasDrag && _activeTouches.size === 0) {
        const duration = Date.now() - _touchDownTime;
        const dx = e.clientX - _touchDownX;
        const dy = e.clientY - _touchDownY;
        const distSq = dx * dx + dy * dy;

        if (distSq <= 100 && duration < 400) {
            // Tap detected — check for double-tap
            const now = Date.now();
            const tapDx = e.clientX - _lastFingerTapX;
            const tapDy = e.clientY - _lastFingerTapY;
            const tapDistSq = tapDx * tapDx + tapDy * tapDy;

            if (now - _lastFingerTapTime < 350 && tapDistSq < 625) {
                // Double-tap
                onCanvasDoubleTap(e);
                _lastFingerTapTime = 0;
            } else {
                // Single tap
                onCanvasTap(e);
                _lastFingerTapTime = now;
                _lastFingerTapX = e.clientX;
                _lastFingerTapY = e.clientY;
            }
        }
    }
}

function _startBoxRotationGesture(ann) {
    const touches = Array.from(_activeTouches.values());
    _isRotatingBoxWithGesture = true;
    _boxGestureStartAngle = Math.atan2(
        touches[1].y - touches[0].y,
        touches[1].x - touches[0].x
    );
    _boxGestureStartRotation = ann.boxData.rotation
        ? { ...ann.boxData.rotation }
        : { x: 0, y: 0, z: 0 };

    state.selectedBoxAnnotation = ann;
    // Disable OrbitControls during box rotation
    state.controls.enabled = false;
}

function _updateBoxRotationGesture() {
    if (!state.selectedBoxAnnotation) return;

    const touches = Array.from(_activeTouches.values());
    const currentAngle = Math.atan2(
        touches[1].y - touches[0].y,
        touches[1].x - touches[0].x
    );
    const deltaAngle = currentAngle - _boxGestureStartAngle;

    // Apply rotation around Y axis (vertical in screen space)
    state.selectedBoxAnnotation.boxData.rotation = {
        x: _boxGestureStartRotation.x,
        y: _boxGestureStartRotation.y + deltaAngle,
        z: _boxGestureStartRotation.z
    };
    renderAnnotations();
}

function _endBoxRotationGesture() {
    _isRotatingBoxWithGesture = false;
    state.selectedBoxAnnotation = null;
    state.controls.enabled = true;
}

// ============ Popup Backdrop (click-outside-to-close for viewport popups) ============

function setupPopupBackdrop() {
    const backdrop = document.getElementById('popup-backdrop');
    if (!backdrop) return;

    const metadataPopup = document.getElementById('metadata-popup');
    const popupsToWatch = [dom.annotationPopup, dom.groupPopup, metadataPopup];

    // Use MutationObserver to auto-show/hide backdrop when any viewport popup toggles visibility
    const observer = new MutationObserver(() => {
        const anyVisible = popupsToWatch.some(p => p && p.classList.contains('visible'));
        backdrop.classList.toggle('visible', anyVisible);
    });

    popupsToWatch.forEach(popup => {
        if (popup) {
            observer.observe(popup, { attributes: true, attributeFilter: ['class'] });
        }
    });

    // Click on backdrop closes whichever viewport popup is open
    backdrop.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (dom.annotationPopup.classList.contains('visible')) {
            dom.annotationPopup.classList.remove('visible');
            clearTempDrawing();
            state.editingAnnotation = null;
            state.editingModelInfo = false;
            state.isAddingEntry = false;
            state.editingEntryId = null;
            hideInlineGroupForm();
            restoreToolHelp();
            state.controls.enabled = true;
        }

        if (dom.groupPopup.classList.contains('visible')) {
            dom.groupPopup.classList.remove('visible');
            state.editingGroup = null;
        }

        if (metadataPopup && metadataPopup.classList.contains('visible')) {
            closeMetadataPopup();
        }
    });
}

// ============ Sidebar Toggle (Phase 3) ============

function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    const viewport = document.getElementById('viewport');

    if (!toggle) return;

    // Check if this is a touch device at all
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;
    if (!isCoarse) return; // Desktop — sidebar is always visible, toggle hidden via CSS

    // Listen for transition end to trigger resize at the right moment
    sidebar.addEventListener('transitionend', (e) => {
        // Only react to the transform transition (not opacity etc.)
        if (e.propertyName === 'transform') {
            window.dispatchEvent(new Event('resize'));
        }
    });

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isCollapsed = sidebar.classList.toggle('collapsed');
        toggle.textContent = isCollapsed ? '\u25B6' : '\u25C0';

        // Update viewport class for CSS transition
        if (viewport) {
            viewport.classList.toggle('sidebar-collapsed', isCollapsed);
        }

        // Fallback resize in case transitionend doesn't fire (e.g., reduced motion)
        setTimeout(() => window.dispatchEvent(new Event('resize')), 350);
    });

    // Auto-collapse on touch devices (start collapsed)
    function autoCollapse() {
        if (!sidebar.classList.contains('collapsed')) {
            sidebar.classList.add('collapsed');
            toggle.textContent = '\u25B6';
            // Also update viewport class
            if (viewport) {
                viewport.classList.add('sidebar-collapsed');
            }
            // Immediate resize on initial load
            requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
        }
    }

    // Start collapsed on tablet
    autoCollapse();
}

// ============ Virtual Keyboard Handling (Phase 4) ============

function setupVirtualKeyboardHandling() {
    if (!window.visualViewport) return;

    let lastKeyboardHeight = 0;

    window.visualViewport.addEventListener('resize', () => {
        const popup = document.getElementById('annotation-popup');
        if (!popup.classList.contains('visible')) return;

        // Check if keyboard is likely visible
        const keyboardHeight = window.innerHeight - window.visualViewport.height;

        if (keyboardHeight > 100) {
            // Keyboard visible - adjust popup
            const availableHeight = window.visualViewport.height;
            popup.style.maxHeight = `${availableHeight * 0.7}px`;
            popup.style.bottom = '0';

            // Scroll focused input into view if it's inside the popup
            const focusedEl = document.activeElement;
            if (focusedEl && popup.contains(focusedEl) && 
                (focusedEl.tagName === 'INPUT' || focusedEl.tagName === 'TEXTAREA')) {
                // Small delay to let layout settle
                setTimeout(() => {
                    focusedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            }

            lastKeyboardHeight = keyboardHeight;
        } else if (lastKeyboardHeight > 100) {
            // Keyboard just hidden - reset all styles
            popup.style.maxHeight = '';
            popup.style.bottom = '';
            lastKeyboardHeight = 0;
        }
    });

    // Also handle scroll event to keep input visible during typing
    window.visualViewport.addEventListener('scroll', () => {
        const popup = document.getElementById('annotation-popup');
        const focusedEl = document.activeElement;
        
        if (popup.classList.contains('visible') && focusedEl && popup.contains(focusedEl)) {
            // Ensure popup stays visible
            popup.style.bottom = '0';
        }
    });
}
