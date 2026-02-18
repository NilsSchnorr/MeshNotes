// js/ui/event-listeners.js
import { state, dom } from '../state.js';
import { showStatus, filterAnnotations, toggleManualItem } from '../utils/helpers.js';
import { loadModel, toggleTexture, loadOBJModel, loadOBJPlain, loadPLYModel } from '../core/model-loader.js';
import { toggleCamera } from '../core/camera.js';
import { setBrightness, setModelOpacity, toggleLightMode, setLightAzimuth, setLightElevation, setPointSize, setTextSize } from '../core/lighting.js';
import { onCanvasClick, onCanvasDblClick, onCanvasMouseDown, onCanvasMouseMove, onCanvasMouseUp, clearTempDrawing, clearAllMeasurements } from '../annotation-tools/editing.js';
import { openGroupPopup, saveGroup, deleteGroup, updateGroupsList, createDefaultGroup } from '../annotation-tools/groups.js';
import { saveAnnotation, deleteAnnotation, addLink, showAddEntryForm, hideConfirm, hideScalebarConfirm, openModelInfoPopup, updateModelInfoDisplay } from '../annotation-tools/data.js';
import { takeScreenshot } from '../export/screenshot.js';
import { exportAnnotations } from '../export/export-json.js';
import { exportPdfReport } from '../export/pdf-report.js';
import { importAnnotations } from '../export/import-json.js';
import { downloadManualAsPdf } from '../export/pdf-manual.js';
import { renderAnnotations } from '../annotation-tools/render.js';

export function setTool(tool) {
    state.currentTool = tool;

    // Update button states
    const toolButtons = [dom.btnPoint, dom.btnLine, dom.btnPolygon, dom.btnSurface, dom.btnBox, dom.btnMeasure];
    toolButtons.forEach(btn => btn.classList.remove('active'));

    if (tool === 'point') dom.btnPoint.classList.add('active');
    else if (tool === 'line') dom.btnLine.classList.add('active');
    else if (tool === 'polygon') dom.btnPolygon.classList.add('active');
    else if (tool === 'surface') dom.btnSurface.classList.add('active');
    else if (tool === 'box') dom.btnBox.classList.add('active');
    else if (tool === 'measure') dom.btnMeasure.classList.add('active');

    // Show/hide brush controls
    if (tool === 'surface') {
        dom.brushDisplay.classList.add('visible');
    } else {
        dom.brushDisplay.classList.remove('visible');
    }

    // Show/hide measurement display
    if (tool === 'measure') {
        dom.measurementDisplay.classList.add('visible');
    } else if (!tool) {
        dom.measurementDisplay.classList.remove('visible');
    }

    updateInstructions(tool);
}

function updateInstructions(tool) {
    const instructions = {
        point: 'Click on model to place point. Press Esc to cancel.',
        line: 'Click to add points. Double-click to finish line. Press Esc to cancel.',
        polygon: 'Click to add points. Double-click to close polygon. Press Esc to cancel.',
        surface: 'Click or drag to paint faces. Hold Shift to erase. Double-click to finish. Press Esc to cancel.',
        box: 'Click on model to place box. Press Esc to cancel.',
        measure: 'Click two points to measure distance. Press Esc to clear measurements.'
    };

    if (tool && instructions[tool]) {
        showStatus(instructions[tool]);
    }
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
    state.modelInfo = { entries: [] };

    // Close any open popups
    dom.annotationPopup.classList.remove('visible');
    dom.groupPopup.classList.remove('visible');
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

/**
 * Wraps loadModel() with a check for existing annotations.
 * If annotations exist, prompts the user to export, clear, or cancel.
 */
function handleModelLoad(file) {
    if (state.annotations.length === 0) {
        loadModel(file);
        return;
    }

    // Store file reference and show the three-option dialog
    const pendingFile = file;

    // Update message with annotation count
    const count = state.annotations.length;
    document.getElementById('annotation-clear-message').textContent =
        `You have ${count} annotation${count !== 1 ? 's' : ''} from the current model. What would you like to do?`;

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
    dom.btnLoad.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) handleModelLoad(e.target.files[0]);
        dom.fileInput.value = '';
    });

    // OBJ dialog
    let pendingObjUpAxis = 'z-up';
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

    // Toolbar buttons
    dom.btnTexture.addEventListener('click', toggleTexture);
    dom.btnPoint.addEventListener('click', () => setTool('point'));
    dom.btnLine.addEventListener('click', () => setTool('line'));
    dom.btnPolygon.addEventListener('click', () => setTool('polygon'));
    dom.btnSurface.addEventListener('click', () => setTool('surface'));
    dom.btnBox.addEventListener('click', () => setTool('box'));
    dom.btnMeasure.addEventListener('click', () => setTool('measure'));
    dom.btnScreenshot.addEventListener('click', takeScreenshot);
    dom.btnExport.addEventListener('click', exportAnnotations);
    dom.btnExportPdf.addEventListener('click', exportPdfReport);
    dom.btnImport.addEventListener('click', () => dom.importInput.click());
    dom.importInput.addEventListener('change', (e) => {
        if (e.target.files[0]) importAnnotations(e.target.files[0]);
    });

    // Brush size slider
    dom.brushSlider.addEventListener('input', (e) => {
        state.surfaceBrushSize = parseFloat(e.target.value);
        dom.brushValue.textContent = state.surfaceBrushSize + '%';
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

    // Annotation popup
    dom.btnPopupSave.addEventListener('click', saveAnnotation);
    dom.btnPopupCancel.addEventListener('click', () => {
        dom.annotationPopup.classList.remove('visible');
        clearTempDrawing();
        state.editingAnnotation = null;
        state.editingModelInfo = false;
        state.isAddingEntry = false;
        state.editingEntryId = null;
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

    // Confirmation dialog
    dom.confirmOk.addEventListener('click', () => {
        if (state.confirmCallback) state.confirmCallback();
        hideConfirm();
    });
    dom.confirmCancel.addEventListener('click', hideConfirm);
    dom.confirmOverlay.addEventListener('click', (e) => {
        if (e.target === dom.confirmOverlay) hideConfirm();
    });

    // Annotation clear dialog - click overlay to dismiss
    dom.annotationClearOverlay.addEventListener('click', (e) => {
        if (e.target === dom.annotationClearOverlay) hideAnnotationClearDialog();
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

    // Canvas events
    dom.canvas.addEventListener('click', onCanvasClick);
    dom.canvas.addEventListener('dblclick', onCanvasDblClick);
    dom.canvas.addEventListener('mousedown', onCanvasMouseDown);
    dom.canvas.addEventListener('mousemove', onCanvasMouseMove);
    dom.canvas.addEventListener('mouseup', onCanvasMouseUp);

    // Prevent context menu when right-clicking on boxes (for rotation)
    dom.canvas.addEventListener('contextmenu', (e) => {
        if (state.isManipulatingBox && state.boxManipulationMode === 'rotate') {
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

    // Sliders panel toggle
    dom.slidersPanelToggle.addEventListener('click', () => {
        dom.slidersPanel.classList.toggle('collapsed');
        dom.slidersPanelToggle.textContent = dom.slidersPanel.classList.contains('collapsed') ? '\u25B2' : '\u25BC';
    });

    // Popup dragging
    dom.popupTitle.addEventListener('mousedown', (e) => {
        state.isDraggingPopup = true;
        // Store offset between mouse and popup's current CSS left/top
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

    // Camera toggle
    dom.cameraToggle.addEventListener('click', toggleCamera);

    // Manual items - event delegation for dynamically generated content
    document.addEventListener('click', (e) => {
        const header = e.target.closest('.manual-item-header');
        if (header) {
            toggleManualItem(header);
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (dom.annotationClearOverlay.classList.contains('visible')) {
                hideAnnotationClearDialog();
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

            if (dom.legalOverlay.classList.contains('visible')) {
                dom.legalOverlay.classList.remove('visible');
                return;
            }

            if (dom.scalebarConfirmOverlay.classList.contains('visible')) {
                hideScalebarConfirm();
                return;
            }

            dom.annotationPopup.classList.remove('visible');
            dom.groupPopup.classList.remove('visible');
            state.isAddingEntry = false;
            state.editingEntryId = null;
            state.editingModelInfo = false;

            if (state.currentTool === 'measure') {
                clearAllMeasurements();
                showStatus('Measurements cleared');
            }

            setTool(null);
            clearTempDrawing();
        }
    });
}
