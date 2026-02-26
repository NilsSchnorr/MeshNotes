// js/ui/event-listeners.js
import { state, dom } from '../state.js';
import { showStatus, filterAnnotations, toggleManualItem } from '../utils/helpers.js';
import { loadModel, toggleTexture, loadOBJModel, loadOBJPlain, loadPLYModel } from '../core/model-loader.js';
import { toggleCamera } from '../core/camera.js';
import { setBrightness, setModelOpacity, toggleLightMode, setLightAzimuth, setLightElevation, setPointSize, setTextSize, setBackgroundColor, setDefaultAuthor, setMeasurementUnit, setMeasurementLineColor, setMeasurementPointColor, setPdfTitle, setPdfInstitution, setPdfProject, setPdfAccentColor, setPdfPageSize, setPdfOrientation, setPdfDpi, resetAllSettings } from '../core/lighting.js';
import { onCanvasTap, onCanvasDoubleTap, onCanvasPointerDown, onCanvasPointerMove, onCanvasPointerUp, clearTempDrawing, clearAllMeasurements, undoLastPoint } from '../annotation-tools/editing.js';
import { setCanvasTouchAction } from '../input/pointer-manager.js';
import { openGroupPopup, saveGroup, deleteGroup, updateGroupsList, createDefaultGroup, createGroupInline, showInlineGroupForm, hideInlineGroupForm } from '../annotation-tools/groups.js';
import { saveAnnotation, deleteAnnotation, addLink, showAddEntryForm, hideConfirm, hideScalebarConfirm, openModelInfoPopup, updateModelInfoDisplay } from '../annotation-tools/data.js';
import { takeScreenshot } from '../export/screenshot.js';
import { exportAnnotations } from '../export/export-json.js';
import { exportPdfReport } from '../export/pdf-report.js';
import { importAnnotations } from '../export/import-json.js';
import { downloadManualAsPdf } from '../export/pdf-manual.js';
import { renderAnnotations } from '../annotation-tools/render.js';
import { showToolHelp, restoreToolHelp, clearBoxEditState } from './tool-help.js';

// Re-export for modules that import from here
export { hideToolHelp, restoreToolHelp, hideAllToolPanels, showBoxEditHelp, clearBoxEditState } from './tool-help.js';

export function setTool(tool) {
    // If a box was unlocked, lock it and update visual feedback
    const hadUnlockedBox = state.boxEditUnlocked !== null;

    state.currentTool = tool;

    // Update touch-action: always allow finger navigation
    setCanvasTouchAction(true);

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

    // Inline group creation in annotation popup
    dom.btnAddGroupInline.addEventListener('click', showInlineGroupForm);
    dom.btnSaveInlineGroup.addEventListener('click', createGroupInline);
    dom.btnCancelInlineGroup.addEventListener('click', hideInlineGroupForm);
    dom.inlineGroupName.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createGroupInline();
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
        hideInlineGroupForm();
        // Restore tool help if a tool is still active
        restoreToolHelp();
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

    // Canvas pointer events with capture phase interception for stylus/tablet support
    setupCanvasPointerEvents();

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

    // Camera toggle (now in sliders panel header)
    dom.cameraToggle.addEventListener('click', toggleCamera);
    
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
    
    // Settings: Reset All
    dom.settingsResetAll.addEventListener('click', () => {
        if (confirm('Reset all settings to their default values?\n\nThis will clear your saved preferences for point size, text size, background color, default author, and measurement unit.')) {
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
        // Undo last point with Ctrl+Z (Cmd+Z on Mac) for line/polygon tools
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            // Only trigger if we're in line/polygon mode and not in a text input
            const activeElement = document.activeElement;
            const isTextInput = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
            
            if (!isTextInput && (state.currentTool === 'line' || state.currentTool === 'polygon') && state.tempPoints.length > 0) {
                e.preventDefault();
                undoLastPoint();
                return;
            }
        }
        
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

            if (dom.settingsOverlay.classList.contains('visible')) {
                dom.settingsOverlay.classList.remove('visible');
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
            hideInlineGroupForm();

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

    // Set initial touch-action
    setCanvasTouchAction(true);
}

// ============ Pointer Events with Capture Phase Interception ============

// Click/double-tap detection state
let _pointerDownX = 0;
let _pointerDownY = 0;
let _pointerDownTime = 0;
let _lastTapTime = 0;
let _lastTapX = 0;
let _lastTapY = 0;

// Two-finger box rotation gesture state
const _activeTouches = new Map();
let _isRotatingBoxWithGesture = false;
let _boxGestureStartAngle = 0;
let _boxGestureStartRotation = null;

function setupCanvasPointerEvents() {
    const canvas = dom.canvas;

    // Capture phase: intercept pen events before OrbitControls
    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'pen') {
            e.stopPropagation();
            _handlePointerDown(e);
        } else if (e.pointerType === 'mouse') {
            // Desktop mouse: handle normally (existing behavior)
            _handlePointerDown(e);
        } else if (e.pointerType === 'touch') {
            // Track touch for two-finger box rotation gesture
            _handleTouchDown(e);
        }
        // 'touch' events: let OrbitControls handle for navigation
    }, { capture: true });

    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'pen') {
            e.stopPropagation();
            onCanvasPointerMove(e);
        } else if (e.pointerType === 'mouse') {
            onCanvasPointerMove(e);
        } else if (e.pointerType === 'touch') {
            _handleTouchMove(e);
        }
        // 'touch' events: OrbitControls handles navigation
    }, { capture: true });

    canvas.addEventListener('pointerup', (e) => {
        if (e.pointerType === 'pen') {
            e.stopPropagation();
            _handlePointerUp(e);
        } else if (e.pointerType === 'mouse') {
            _handlePointerUp(e);
        } else if (e.pointerType === 'touch') {
            _handleTouchUp(e);
        }
    }, { capture: true });

    // Pointer cancel (finger lifted, pen out of range, etc.)
    canvas.addEventListener('pointercancel', (e) => {
        if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
            _handlePointerUp(e);
        } else if (e.pointerType === 'touch') {
            _handleTouchUp(e);
        }
    }, { capture: true });
}

function _handlePointerDown(e) {
    _pointerDownX = e.clientX;
    _pointerDownY = e.clientY;
    _pointerDownTime = Date.now();
    onCanvasPointerDown(e);
}

function _handlePointerUp(e) {
    const dx = e.clientX - _pointerDownX;
    const dy = e.clientY - _pointerDownY;
    const distSq = dx * dx + dy * dy;
    const duration = Date.now() - _pointerDownTime;

    // Click detection: same threshold as existing code (distSq <= 9)
    const isClick = distSq <= 9 && duration < 500;

    if (isClick) {
        // Double-tap detection
        const now = Date.now();
        const tapDx = e.clientX - _lastTapX;
        const tapDy = e.clientY - _lastTapY;
        const tapDistSq = tapDx * tapDx + tapDy * tapDy;

        if (now - _lastTapTime < 300 && tapDistSq < 400) {
            // Double-tap detected
            onCanvasDoubleTap(e);
            _lastTapTime = 0; // Reset to prevent triple-tap
        } else {
            // Single tap
            onCanvasTap(e);
            _lastTapTime = now;
            _lastTapX = e.clientX;
            _lastTapY = e.clientY;
        }
    }

    onCanvasPointerUp(e);
}

// ============ Two-Finger Box Rotation Gesture (Phase 2) ============

function _handleTouchDown(e) {
    _activeTouches.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY
    });

    // Check for two-finger gesture on box
    if (_activeTouches.size === 2 && state.boxEditUnlocked !== null) {
        const ann = state.annotations.find(a => a.id === state.boxEditUnlocked);
        if (ann && ann.type === 'box') {
            _startBoxRotationGesture(ann);
        }
    }
}

function _handleTouchMove(e) {
    if (!_activeTouches.has(e.pointerId)) return;
    _activeTouches.get(e.pointerId).x = e.clientX;
    _activeTouches.get(e.pointerId).y = e.clientY;

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

// ============ Sidebar Toggle (Phase 3) ============

function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    const viewport = document.getElementById('viewport');

    if (!toggle) return;

    toggle.addEventListener('click', () => {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        viewport.classList.toggle('sidebar-expanded', !isCollapsed);
        toggle.textContent = isCollapsed ? '\u25B6' : '\u25C0';

        // Trigger resize for Three.js canvas
        window.dispatchEvent(new Event('resize'));
    });

    // Auto-collapse on small touch screens
    function checkAutoCollapse() {
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        const isNarrow = window.innerWidth < 1024;

        if (isTouch && isNarrow && !sidebar.classList.contains('collapsed')) {
            sidebar.classList.add('collapsed');
            viewport.classList.remove('sidebar-expanded');
            toggle.textContent = '\u25B6';
        }
    }

    window.addEventListener('resize', checkAutoCollapse);
    checkAutoCollapse();
}

// ============ Virtual Keyboard Handling (Phase 4) ============

function setupVirtualKeyboardHandling() {
    if (!window.visualViewport) return;

    window.visualViewport.addEventListener('resize', () => {
        const popup = document.getElementById('annotation-popup');
        if (!popup.classList.contains('visible')) return;

        // Check if keyboard is likely visible
        const keyboardHeight = window.innerHeight - window.visualViewport.height;

        if (keyboardHeight > 100) {
            // Keyboard visible - adjust popup
            popup.style.maxHeight = `${window.visualViewport.height * 0.7}px`;
            popup.style.bottom = '0';
        } else {
            // Keyboard hidden - reset
            popup.style.maxHeight = '';
        }
    });
}
