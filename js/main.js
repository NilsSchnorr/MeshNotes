// js/main.js - Application entry point
import { state, dom, initDomReferences } from './state.js';
import { initScene, initControls, addGrid, onWindowResize } from './core/scene.js';
import { initCameras, initViewHelper, updateViewHelperLabels } from './core/camera.js';
import { initLighting, updateLightFromCamera } from './core/lighting.js';
import { setUpdateModelInfoDisplay } from './core/model-loader.js';
import { createDefaultGroup, updateGroupsList, setGroupCallbacks } from './annotation-tools/groups.js';
import { updateModelInfoDisplay, openAnnotationPopup, openAnnotationPopupForEdit } from './annotation-tools/data.js';
import { setEditingCallbacks, finishSurfacePainting } from './annotation-tools/editing.js';
import { updateMeasurementsDisplay } from './annotation-tools/editing.js';
import { renderAnnotations } from './annotation-tools/render.js';
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

// Load saved slider settings
function loadSavedSettings() {
    const savedPointSize = localStorage.getItem('meshnotes_pointSize');
    if (savedPointSize) {
        dom.pointSizeSlider.value = savedPointSize;
        state.pointSizeMultiplier = parseInt(savedPointSize) / 100;
        dom.pointSizeValue.textContent = `${savedPointSize}%`;
    }

    const savedTextSize = localStorage.getItem('meshnotes_textSize');
    if (savedTextSize) {
        dom.textSizeSlider.value = savedTextSize;
        state.textSizeMultiplier = parseInt(savedTextSize) / 100;
        dom.textSizeValue.textContent = `${savedTextSize}%`;
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
