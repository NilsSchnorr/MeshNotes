// js/main.js - Application entry point
import { state, dom, initDomReferences, APP_VERSION } from './state.js';
import { initScene, initControls, addGrid, onWindowResize } from './core/scene.js';
import { initCameras, initViewHelper, updateViewHelperLabels } from './core/camera.js';
import { initLighting, updateLightFromCamera, setBackgroundColor, setMeasurementUnit, setScreenshotQuality } from './core/lighting.js';
import { setUpdateModelInfoDisplay, loadModel, loadOBJModel, loadPLYModel, loadSTLModel } from './core/model-loader.js';
import { createDefaultGroup, updateGroupsList, setGroupCallbacks, initGroupsEventDelegation } from './annotation-tools/groups.js';
import { updateModelInfoDisplay, openAnnotationPopup, openAnnotationPopupForEdit } from './annotation-tools/data.js';
import { setEditingCallbacks, renderMeasurements } from './annotation-tools/editing.js';
import { updateMeasurementsDisplay } from './annotation-tools/editing.js';
import { renderAnnotations, setRenderCallbacks } from './annotation-tools/render.js';
import { setRenderAnnotations } from './annotation-tools/projection.js';
import { setupEventListeners, setTool } from './ui/event-listeners.js';
import { openGroupPopup } from './annotation-tools/groups.js';
import { initLabelOcclusionUpdates } from './utils/label-occlusion.js';
import { showStatus, toDisplayCoords } from './utils/helpers.js';
import { importAnnotations } from './export/import-json.js';
import { applyViewState } from './export/view-state.js';
import { openAnnotationShareDialog } from './export/share.js';
import { initMetadata, updateMetadataDisplay } from './metadata/metadata-ui.js';
import { parseUrlParams, loadShareFiles, loadDirectFiles, isShareExpired, daysUntilExpiry } from './core/url-params.js';
import * as THREE from 'three';
import { loadIcons, initIcons } from './ui/icons.js';

// Wire up late-bound references to break circular dependencies
setUpdateModelInfoDisplay(updateModelInfoDisplay);
setRenderAnnotations(renderAnnotations);
setEditingCallbacks({
    openAnnotationPopup,
    setTool
});
setGroupCallbacks({
    openGroupPopup,
    openAnnotationPopupForEdit,
    openAnnotationShare: openAnnotationShareDialog
});
setRenderCallbacks({
    renderMeasurements
});

function init() {
    // Initialize DOM references
    initDomReferences();

    // Display app version in About modal
    const versionEl = document.getElementById('app-version');
    if (versionEl) versionEl.textContent = 'v' + APP_VERSION;

    // Scene setup
    initScene();
    initCameras();
    initControls();
    initLighting();
    addGrid();
    initViewHelper();
    updateViewHelperLabels();

    // Set up label occlusion updates (hides labels when annotations are behind the model)
    initLabelOcclusionUpdates();

    // Default data
    createDefaultGroup();
    updateGroupsList();
    updateMeasurementsDisplay();
    initMetadata();
    updateMetadataDisplay();

    // Event listeners
    setupEventListeners();
    initGroupsEventDelegation(); // Set up delegated click/dblclick for annotation items
    window.addEventListener('resize', onWindowResize);

    // Load SVG icons and inject into DOM (non-blocking)
    loadIcons().then(() => initIcons());

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

// ============ URL Parameter Auto-Loading ============

/**
 * Check URL parameters and auto-load shared model + annotations.
 * Called after init() and loadSavedSettings().
 */
async function loadFromUrlParams() {
    const config = parseUrlParams();

    if (config.mode === 'local') return; // No URL params — normal editor usage

    dom.loading.classList.add('visible');

    try {
        let shareData;

        if (config.mode === 'share') {
            shareData = await loadShareFiles(config.shareId);

            // Check expiry
            if (shareData.manifest && isShareExpired(shareData.manifest)) {
                dom.loading.classList.remove('visible');
                showStatus('This share has expired (90-day limit reached)');
                return;
            }

            // Show expiry info (hold for 10 seconds so it's readable)
            if (shareData.manifest) {
                const days = daysUntilExpiry(shareData.manifest);
                showStatus(`Shared model loaded · expires in ${days} day${days !== 1 ? 's' : ''}`, 10);
            }
        } else if (config.mode === 'direct') {
            shareData = await loadDirectFiles(config.modelUrl, config.annotationsUrl);
        }

        const { modelFile, materialFiles, annotationFile, format } = shareData;
        const ext = modelFile.name.split('.').pop().toLowerCase();

        // Load model using existing loaders, bypassing file-input dialogs
        if (format === 'glb' || ext === 'glb' || ext === 'gltf') {
            // loadModel handles GLB directly without showing a dialog
            loadModel(modelFile);
        } else if (format === 'obj' || ext === 'obj') {
            // Call loadOBJModel directly with materials, skipping the OBJ dialog
            loadOBJModel(modelFile, materialFiles, 'z-up');
        } else if (format === 'ply' || ext === 'ply') {
            // Find texture file among materials
            const textureFile = materialFiles.find(f => {
                const e = f.name.split('.').pop().toLowerCase();
                return ['jpg', 'jpeg', 'png', 'tif', 'tiff'].includes(e);
            }) || null;
            loadPLYModel(modelFile, textureFile, 'z-up');
        } else if (format === 'stl' || ext === 'stl') {
            loadSTLModel(modelFile, 'z-up');
        } else {
            throw new Error(`Unsupported format: ${ext}`);
        }

        // Import annotations once the model finishes loading
        if (annotationFile) {
            waitForModel(() => {
                // Run focus / view restore only after the import completes, so
                // the annotation exists by the time we look it up.
                importAnnotations(annotationFile, ({ viewState }) => {
                    if (viewState) {
                        // "See what I see": restore the author's exact view, then
                        // select/open the focused annotation without moving the camera.
                        applyViewState(viewState);
                        if (config.focusAnnotation) {
                            focusOnAnnotation(config.focusAnnotation, { moveCamera: false });
                        }
                    } else if (config.focusAnnotation) {
                        // No saved view — fall back to auto-framing the annotation.
                        focusOnAnnotation(config.focusAnnotation);
                    }
                });
            });
        } else if (config.focusAnnotation) {
            waitForModel(() => {
                focusOnAnnotation(config.focusAnnotation);
            });
        }

    } catch (error) {
        console.error('URL parameter loading failed:', error);
        dom.loading.classList.remove('visible');

        if (error.message === 'expired') {
            showStatus('This share has expired (90-day limit reached)');
        } else {
            showStatus('Failed to load shared model: ' + error.message);
        }
    }
}

/**
 * Poll for model to finish loading, then run callback.
 * The existing loaders use async callbacks internally, so we poll
 * for state.currentModel to become non-null.
 */
function waitForModel(callback, maxAttempts = 50) {
    let attempts = 0;
    const check = () => {
        attempts++;
        if (state.currentModel) {
            // Small delay to let setupLoadedModel finish completely
            setTimeout(callback, 100);
        } else if (attempts < maxAttempts) {
            setTimeout(check, 200); // Check every 200ms, up to 10 seconds
        } else {
            console.warn('Timed out waiting for model to load');
        }
    };
    setTimeout(check, 200);
}

/**
 * Navigate camera to focus on a specific annotation by UUID, select it, and
 * open its detail popup. Pass { moveCamera: false } when a restored view has
 * already positioned the camera ("see what I see").
 */
function focusOnAnnotation(uuid, { moveCamera = true } = {}) {
    const ann = state.annotations.find(a => a.uuid === uuid);
    if (!ann) {
        showStatus('The highlighted annotation is no longer available');
        return;
    }

    if (moveCamera && ann.points && ann.points.length > 0) {
        const center = new THREE.Vector3();
        ann.points.forEach(p => {
            const dp = toDisplayCoords(p);
            center.add(new THREE.Vector3(dp.x, dp.y, dp.z));
        });
        center.divideScalar(ann.points.length);

        state.controls.target.copy(center);
        state.camera.position.set(
            center.x + state.modelBoundingSize * 0.8,
            center.y + state.modelBoundingSize * 0.8,
            center.z + state.modelBoundingSize * 0.8
        );
        state.controls.update();
    }

    // Select it and open its detail popup so the shared annotation "pops up".
    state.selectedAnnotation = ann.id;
    updateGroupsList();
    openAnnotationPopupForEdit(ann);
}

// ============ Slider Utilities ============

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
    
    // Default author ORCID
    const savedDefaultAuthorOrcid = localStorage.getItem('meshnotes_defaultAuthorOrcid');
    if (savedDefaultAuthorOrcid) {
        state.defaultAuthorOrcid = savedDefaultAuthorOrcid;
        dom.settingsDefaultAuthorOrcid.value = savedDefaultAuthorOrcid;
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
    
    // Model display colors
    const savedMeshColor = localStorage.getItem('meshnotes_meshColor');
    if (savedMeshColor) {
        state.meshColor = savedMeshColor;
        dom.settingsMeshColor.value = savedMeshColor;
    }
    
    const savedWireframeColor = localStorage.getItem('meshnotes_wireframeColor');
    if (savedWireframeColor) {
        state.wireframeColor = savedWireframeColor;
        dom.settingsWireframeColor.value = savedWireframeColor;
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
    
    const savedPdfCameraDistance = localStorage.getItem('meshnotes_pdfCameraDistance');
    if (savedPdfCameraDistance) {
        state.pdfCameraDistance = parseFloat(savedPdfCameraDistance);
        dom.settingsPdfCameraDistance.value = savedPdfCameraDistance;
        dom.settingsPdfCameraDistanceValue.textContent = `×${parseFloat(savedPdfCameraDistance).toFixed(1)}`;
    }
    
    const savedPdfCameraAngle = localStorage.getItem('meshnotes_pdfCameraAngle');
    if (savedPdfCameraAngle) {
        state.pdfCameraAngle = parseInt(savedPdfCameraAngle);
        dom.settingsPdfCameraAngle.value = savedPdfCameraAngle;
        dom.settingsPdfCameraAngleValue.textContent = `${savedPdfCameraAngle}°`;
    }
    
    // Screenshot quality
    const savedScreenshotQuality = localStorage.getItem('meshnotes_screenshotQuality');
    if (savedScreenshotQuality) {
        setScreenshotQuality(savedScreenshotQuality);
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
loadFromUrlParams();
