// js/main.js - Application entry point
import { state, dom, initDomReferences } from './state.js';
import { initScene, initControls, addGrid, onWindowResize } from './core/scene.js';
import { initCameras, initViewHelper, updateViewHelperLabels } from './core/camera.js';
import { initLighting, updateLightFromCamera, setBackgroundColor, setMeasurementUnit } from './core/lighting.js';
import { setUpdateModelInfoDisplay } from './core/model-loader.js';
import { createDefaultGroup, updateGroupsList, setGroupCallbacks, initGroupsEventDelegation } from './annotation-tools/groups.js';
import { updateModelInfoDisplay, openAnnotationPopup, openAnnotationPopupForEdit } from './annotation-tools/data.js';
import { setEditingCallbacks, finishSurfacePainting, renderMeasurements } from './annotation-tools/editing.js';
import { updateMeasurementsDisplay } from './annotation-tools/editing.js';
import { renderAnnotations, setRenderCallbacks } from './annotation-tools/render.js';
import { setRenderAnnotations } from './annotation-tools/projection.js';
import { setupEventListeners, setTool } from './ui/event-listeners.js';
import { openGroupPopup } from './annotation-tools/groups.js';

// Wire up late-bound references to break circular dependencies
setUpdateModelInfoDisplay(updateModelInfoDisplay);
setRenderAnnotations(renderAnnotations);
setEditingCallbacks({
    openAnnotationPopup,
    openAnnotationPopupForEdit,
    finishSurfacePainting,
    setTool
});
setGroupCallbacks({
    openGroupPopup,
    openAnnotationPopupForEdit
});
setRenderCallbacks({
    renderMeasurements
});

function init() {
    // Initialize DOM references
    initDomReferences();

    // Scene setup
    initScene();
    initCameras();
    initControls();
    initLighting();
    addGrid();
    initViewHelper();
    updateViewHelperLabels();

    // Default data
    createDefaultGroup();
    updateGroupsList();
    updateMeasurementsDisplay();

    // Event listeners
    setupEventListeners();
    initGroupsEventDelegation(); // Set up delegated click/dblclick for annotation items
    window.addEventListener('resize', onWindowResize);

    // Start render loop
    animate();
}

function animate() {
    requestAnimationFrame(animate);

    state.controls.update();

    // Update light to follow camera if in that mode
    if (state.lightFollowsCamera) {
        updateLightFromCamera();
    }

    // Render main scene
    state.renderer.render(state.scene, state.camera);

    // Render ViewHelper
    if (state.viewHelper && state.viewHelperRenderer) {
        state.viewHelper.render(state.viewHelperRenderer);
    }

    // Update ViewHelper animation
    if (state.viewHelper) {
        const delta = state.clock.getDelta();
        if (state.viewHelper.animating) {
            state.viewHelper.update(delta);
        }
    }
}

/**
 * Converts slider value (25-600) to multiplier using exponential scaling.
 * Must match the formula in lighting.js for consistency.
 */
function sliderToMultiplier(sliderValue) {
    if (sliderValue <= 100) {
        return 0.25 * Math.pow(4, (sliderValue - 25) / 75);
    } else {
        return Math.pow(50, (sliderValue - 100) / 500);
    }
}

/**
 * Formats multiplier for display (e.g., "×2.5" or "×50").
 */
function formatMultiplier(multiplier) {
    if (multiplier < 10) {
        return `×${multiplier.toFixed(1)}`;
    } else {
        return `×${Math.round(multiplier)}`;
    }
}

// Load saved settings
function loadSavedSettings() {
    // Point size
    const savedPointSize = localStorage.getItem('meshnotes_pointSize');
    if (savedPointSize) {
        const sliderValue = parseInt(savedPointSize);
        dom.pointSizeSlider.value = sliderValue;
        state.pointSizeMultiplier = sliderToMultiplier(sliderValue);
        dom.pointSizeValue.textContent = formatMultiplier(state.pointSizeMultiplier);
    }

    // Text size
    const savedTextSize = localStorage.getItem('meshnotes_textSize');
    if (savedTextSize) {
        const sliderValue = parseInt(savedTextSize);
        dom.textSizeSlider.value = sliderValue;
        state.textSizeMultiplier = sliderToMultiplier(sliderValue);
        dom.textSizeValue.textContent = formatMultiplier(state.textSizeMultiplier);
    }
    
    // Background color
    const savedBackgroundColor = localStorage.getItem('meshnotes_backgroundColor');
    if (savedBackgroundColor) {
        setBackgroundColor(savedBackgroundColor);
    }
    
    // Default author
    const savedDefaultAuthor = localStorage.getItem('meshnotes_defaultAuthor');
    if (savedDefaultAuthor) {
        state.defaultAuthor = savedDefaultAuthor;
        dom.settingsDefaultAuthor.value = savedDefaultAuthor;
    }
    
    // Measurement unit
    const savedMeasurementUnit = localStorage.getItem('meshnotes_measurementUnit');
    if (savedMeasurementUnit) {
        state.measurementUnit = savedMeasurementUnit;
        // Use setMeasurementUnit to properly update the UI (handles custom values)
        setMeasurementUnit(savedMeasurementUnit);
    }
    
    // Measurement colors
    const savedMeasurementLineColor = localStorage.getItem('meshnotes_measurementLineColor');
    if (savedMeasurementLineColor) {
        state.measurementLineColor = savedMeasurementLineColor;
        dom.settingsMeasurementLineColor.value = savedMeasurementLineColor;
    }
    
    const savedMeasurementPointColor = localStorage.getItem('meshnotes_measurementPointColor');
    if (savedMeasurementPointColor) {
        state.measurementPointColor = savedMeasurementPointColor;
        dom.settingsMeasurementPointColor.value = savedMeasurementPointColor;
    }
    
    // PDF export settings
    const savedPdfTitle = localStorage.getItem('meshnotes_pdfTitle');
    if (savedPdfTitle) {
        state.pdfTitle = savedPdfTitle;
        dom.settingsPdfTitle.value = savedPdfTitle;
    }
    
    const savedPdfInstitution = localStorage.getItem('meshnotes_pdfInstitution');
    if (savedPdfInstitution) {
        state.pdfInstitution = savedPdfInstitution;
        dom.settingsPdfInstitution.value = savedPdfInstitution;
    }
    
    const savedPdfProject = localStorage.getItem('meshnotes_pdfProject');
    if (savedPdfProject) {
        state.pdfProject = savedPdfProject;
        dom.settingsPdfProject.value = savedPdfProject;
    }
    
    const savedPdfAccentColor = localStorage.getItem('meshnotes_pdfAccentColor');
    if (savedPdfAccentColor) {
        state.pdfAccentColor = savedPdfAccentColor;
        dom.settingsPdfAccentColor.value = savedPdfAccentColor;
    }
    
    const savedPdfPageSize = localStorage.getItem('meshnotes_pdfPageSize');
    if (savedPdfPageSize) {
        state.pdfPageSize = savedPdfPageSize;
        dom.settingsPdfPageSize.value = savedPdfPageSize;
    }
    
    const savedPdfOrientation = localStorage.getItem('meshnotes_pdfOrientation');
    if (savedPdfOrientation) {
        state.pdfOrientation = savedPdfOrientation;
        dom.settingsPdfOrientation.value = savedPdfOrientation;
    }
    
    const savedPdfDpi = localStorage.getItem('meshnotes_pdfDpi');
    if (savedPdfDpi) {
        state.pdfDpi = parseInt(savedPdfDpi);
        dom.settingsPdfDpi.value = savedPdfDpi;
    }
}

// Expose key variables for console debugging
window.meshnotesDebug = {
    getScene: () => state.scene,
    getModel: () => state.currentModel,
    getState: () => state,
    checkColors: () => {
        if (!state.currentModel) {
            console.log('No model loaded');
            return;
        }
        let report = { vertexColorsAttribute: [], vertexColorsWithData: [], materialColors: [], textures: [] };
        state.currentModel.traverse((child) => {
            if (child.isMesh) {
                const name = child.name || 'unnamed mesh';
                if (child.geometry.attributes.color) {
                    report.vertexColorsAttribute.push(name);
                    const colorAttr = child.geometry.attributes.color;
                    const count = colorAttr.count;
                    let hasRealColors = false;
                    const samplesToCheck = Math.min(50, count);
                    for (let i = 0; i < samplesToCheck; i++) {
                        const idx = Math.floor(i * count / samplesToCheck);
                        const r = colorAttr.getX(idx);
                        const g = colorAttr.getY(idx);
                        const b = colorAttr.getZ(idx);
                        if (r < 0.99 || g < 0.99 || b < 0.99) {
                            hasRealColors = true;
                            break;
                        }
                    }
                    if (hasRealColors) {
                        report.vertexColorsWithData.push(name);
                    }
                }
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach((mat, i) => {
                    if (mat.color && (mat.color.r !== 1 || mat.color.g !== 1 || mat.color.b !== 1)) {
                        report.materialColors.push(`${name}: rgb(${mat.color.r.toFixed(2)}, ${mat.color.g.toFixed(2)}, ${mat.color.b.toFixed(2)})`);
                    }
                    if (mat.map) {
                        report.textures.push(`${name}: has texture map`);
                    }
                });
            }
        });
        console.log('=== Model Color Report ===');
        console.log('Vertex color attribute exists:', report.vertexColorsAttribute.length > 0 ? report.vertexColorsAttribute : 'NONE');
        console.log('Vertex colors with actual data:', report.vertexColorsWithData.length > 0 ? report.vertexColorsWithData : 'NONE (all white)');
        console.log('Material Colors found:', report.materialColors.length > 0 ? report.materialColors : 'NONE');
        console.log('Textures found:', report.textures.length > 0 ? report.textures : 'NONE');
        console.log('hasVertexColors flag (enables Colors mode):', state.hasVertexColors);
        return report;
    }
};

// Start the application
init();
loadSavedSettings();
