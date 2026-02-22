// js/core/lighting.js - Lighting setup and controls
import * as THREE from 'three';
import { state, dom } from '../state.js';

// ============ Lighting Initialization ============

export function initLighting() {
    state.ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
    state.scene.add(state.ambientLight);

    state.dirLight1 = new THREE.DirectionalLight(0xffffff, 0.96);
    state.dirLight1.position.set(5, 10, 7);
    state.dirLight1.target = new THREE.Object3D(); // Add target for camera-linked mode
    state.scene.add(state.dirLight1);
    state.scene.add(state.dirLight1.target);

    state.dirLight2 = new THREE.DirectionalLight(0xffffff, 0.48);
    state.dirLight2.position.set(-5, -5, -5);
    state.scene.add(state.dirLight2);
}

// ============ Brightness Control ============

export function setBrightness(value) {
    const factor = value / 100;
    state.ambientLight.intensity = 0.72 * factor;
    // Apply 1.5x boost when in fixed direction mode for better raking light effect
    const dirLightMultiplier = state.lightFollowsCamera ? 1.0 : 1.5;
    state.dirLight1.intensity = 0.96 * factor * dirLightMultiplier;
    state.dirLight2.intensity = 0.48 * factor;
    dom.brightnessValue.textContent = `${value}%`;
}

// ============ Opacity Control ============

export function setModelOpacity(value) {
    state.modelOpacity = value / 100;
    dom.opacityValue.textContent = `${value}%`;

    if (!state.currentModel) return;

    state.currentModel.traverse((child) => {
        if (child.isMesh) {
            child.material.transparent = true;
            child.material.opacity = state.modelOpacity;
            child.material.depthWrite = state.modelOpacity > 0.9;
            child.material.needsUpdate = true;
        }
    });
}

// ============ Point Size Control ============

/**
 * Converts slider value (25-600) to multiplier using exponential scaling.
 * This provides intuitive control where small movements have larger effect
 * at high values, allowing a huge effective range (0.25× to 50×).
 * 
 * Anchored at slider=100 → multiplier=1.0×
 * 
 * Lower range (25-100): 0.25× to 1.0× using formula 0.25 × 4^((slider-25)/75)
 * Upper range (100-600): 1.0× to 50× using formula 50^((slider-100)/500)
 * 
 * Example values:
 *   Slider 25  → 0.25×
 *   Slider 50  → 0.50×
 *   Slider 100 → 1.0×
 *   Slider 200 → 2.0×
 *   Slider 300 → 3.8×
 *   Slider 400 → 7.4×
 *   Slider 500 → 14.5×
 *   Slider 600 → 50×
 */
function sliderToMultiplier(sliderValue) {
    if (sliderValue <= 100) {
        // Exponential curve from 0.25× at slider=25 to 1.0× at slider=100
        return 0.25 * Math.pow(4, (sliderValue - 25) / 75);
    } else {
        // Exponential curve from 1.0× at slider=100 to 50× at slider=600
        return Math.pow(50, (sliderValue - 100) / 500);
    }
}

/**
 * Formats multiplier for display (e.g., "×2.5" or "×50").
 * Uses one decimal place for values under 10, whole numbers above.
 */
function formatMultiplier(multiplier) {
    if (multiplier < 10) {
        return `×${multiplier.toFixed(1)}`;
    } else {
        return `×${Math.round(multiplier)}`;
    }
}

export function setPointSize(value) {
    state.pointSizeMultiplier = sliderToMultiplier(value);
    dom.pointSizeValue.textContent = formatMultiplier(state.pointSizeMultiplier);
    localStorage.setItem('meshnotes_pointSize', value);
    // Note: renderAnnotations() will be called by the event listener
    // to avoid circular dependency, caller is responsible for re-rendering
}

// ============ Text Size Control ============

export function setTextSize(value) {
    state.textSizeMultiplier = sliderToMultiplier(value);
    dom.textSizeValue.textContent = formatMultiplier(state.textSizeMultiplier);
    localStorage.setItem('meshnotes_textSize', value);
    // Note: renderAnnotations() will be called by the event listener
    // to avoid circular dependency, caller is responsible for re-rendering
}

// ============ Light Mode Controls ============

export function toggleLightMode() {
    state.lightFollowsCamera = !state.lightFollowsCamera;

    if (state.lightFollowsCamera) {
        dom.lightToggle.textContent = 'Follows Camera';
        dom.lightToggle.classList.add('active');
        dom.lightDirectionRow.classList.remove('visible');
        // Restore normal light intensity
        state.dirLight1.intensity = 0.96 * (parseInt(dom.brightnessSlider.value) / 100);
        updateLightFromCamera();
    } else {
        dom.lightToggle.textContent = 'Fixed Direction';
        dom.lightToggle.classList.remove('active');
        dom.lightDirectionRow.classList.add('visible');
        // Boost light intensity 1.5x for better raking light shadow visibility
        state.dirLight1.intensity = 0.96 * (parseInt(dom.brightnessSlider.value) / 100) * 1.5;
        updateFixedLightDirection();
    }
}

export function updateLightFromCamera() {
    // Position light relative to camera direction
    const cameraDir = new THREE.Vector3();
    state.camera.getWorldDirection(cameraDir);

    // Light comes from camera direction (slightly above)
    const lightDistance = 10;
    const lightPos = state.camera.position.clone().sub(cameraDir.multiplyScalar(lightDistance));
    lightPos.y += 5; // Slightly above camera level

    state.dirLight1.position.copy(lightPos);
    state.dirLight1.target.position.copy(state.controls.target);
}

export function updateFixedLightDirection() {
    // Convert spherical coordinates to Cartesian
    const azimuthRad = (state.fixedLightAzimuth * Math.PI) / 180;
    const elevationRad = (state.fixedLightElevation * Math.PI) / 180;

    const distance = 10;

    // Spherical to Cartesian conversion
    // Elevation: 0 deg = horizon, 90 deg = straight up, -90 deg = straight down
    const y = Math.sin(elevationRad) * distance;
    const horizontalDist = Math.cos(elevationRad) * distance;
    const x = Math.sin(azimuthRad) * horizontalDist;
    const z = Math.cos(azimuthRad) * horizontalDist;

    state.dirLight1.position.set(x, y, z);
    state.dirLight1.target.position.set(0, 0, 0);
}

export function setLightAzimuth(value) {
    state.fixedLightAzimuth = value;
    dom.lightAzimuthValue.textContent = `${value}\u00B0`;
    if (!state.lightFollowsCamera) {
        updateFixedLightDirection();
    }
}

export function setLightElevation(value) {
    state.fixedLightElevation = value;
    dom.lightElevationValue.textContent = `${value}\u00B0`;
    if (!state.lightFollowsCamera) {
        updateFixedLightDirection();
    }
}

// ============ Background Color Control ============

export function setBackgroundColor(color) {
    state.backgroundColor = color;
    state.scene.background = new THREE.Color(color);
    dom.backgroundColorPicker.value = color;
    
    // Update preset button states
    document.querySelectorAll('.bg-preset').forEach(btn => {
        const btnColor = btn.dataset.color.toLowerCase();
        const selectedColor = color.toLowerCase();
        btn.classList.toggle('active', btnColor === selectedColor);
    });
    
    // Save to localStorage
    localStorage.setItem('meshnotes_backgroundColor', color);
}

// ============ User Preferences ============

export function setDefaultAuthor(name) {
    state.defaultAuthor = name;
    localStorage.setItem('meshnotes_defaultAuthor', name);
}

export function setMeasurementUnit(unit, isCustom = false) {
    state.measurementUnit = unit;
    localStorage.setItem('meshnotes_measurementUnit', unit);
    
    // Update the UI
    if (dom.settingsMeasurementUnit && dom.settingsMeasurementUnitCustom) {
        if (isCustom || !['units', 'mm', 'cm', 'm'].includes(unit)) {
            // It's a custom unit
            dom.settingsMeasurementUnit.value = 'custom';
            dom.settingsMeasurementUnitCustom.value = unit;
            dom.settingsMeasurementUnitCustom.style.display = 'block';
        } else {
            dom.settingsMeasurementUnit.value = unit;
            dom.settingsMeasurementUnitCustom.style.display = 'none';
        }
    }
}

// ============ Reset All Settings ============

export function resetAllSettings() {
    // Clear all MeshNotes localStorage items
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('meshnotes_')) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    
    // Reset state to defaults
    state.pointSizeMultiplier = 1.0;
    state.textSizeMultiplier = 1.0;
    state.defaultAuthor = '';
    state.measurementUnit = 'units';
    state.measurementLineColor = '#AA8101';
    state.measurementPointColor = '#FFFFFF';
    state.backgroundColor = '#041D31';
    state.pdfTitle = '';
    state.pdfInstitution = '';
    state.pdfProject = '';
    state.pdfAccentColor = '#AA8101';
    state.pdfPageSize = 'a4';
    state.pdfOrientation = 'portrait';
    state.pdfDpi = 150;
    
    // Reset UI elements
    dom.pointSizeSlider.value = 100;
    dom.pointSizeValue.textContent = '×1.0';
    dom.textSizeSlider.value = 100;
    dom.textSizeValue.textContent = '×1.0';
    dom.settingsDefaultAuthor.value = '';
    dom.settingsMeasurementUnit.value = 'units';
    dom.settingsMeasurementUnitCustom.value = '';
    dom.settingsMeasurementUnitCustom.style.display = 'none';
    dom.settingsMeasurementLineColor.value = '#AA8101';
    dom.settingsMeasurementPointColor.value = '#FFFFFF';
    dom.settingsPdfTitle.value = '';
    dom.settingsPdfInstitution.value = '';
    dom.settingsPdfProject.value = '';
    dom.settingsPdfAccentColor.value = '#AA8101';
    dom.settingsPdfPageSize.value = 'a4';
    dom.settingsPdfOrientation.value = 'portrait';
    dom.settingsPdfDpi.value = '150';
    
    // Reset background color
    setBackgroundColor('#041D31');
}

// ============ Measurement Settings ============

export function getMeasurementUnit() {
    return state.measurementUnit || 'units';
}

export function setMeasurementLineColor(color) {
    state.measurementLineColor = color;
    localStorage.setItem('meshnotes_measurementLineColor', color);
    dom.settingsMeasurementLineColor.value = color;
}

export function setMeasurementPointColor(color) {
    state.measurementPointColor = color;
    localStorage.setItem('meshnotes_measurementPointColor', color);
    dom.settingsMeasurementPointColor.value = color;
}

// ============ PDF Export Settings ============

export function setPdfTitle(title) {
    state.pdfTitle = title;
    localStorage.setItem('meshnotes_pdfTitle', title);
}

export function setPdfInstitution(institution) {
    state.pdfInstitution = institution;
    localStorage.setItem('meshnotes_pdfInstitution', institution);
}

export function setPdfProject(project) {
    state.pdfProject = project;
    localStorage.setItem('meshnotes_pdfProject', project);
}

export function setPdfAccentColor(color) {
    state.pdfAccentColor = color;
    localStorage.setItem('meshnotes_pdfAccentColor', color);
    dom.settingsPdfAccentColor.value = color;
}

export function setPdfPageSize(size) {
    state.pdfPageSize = size;
    localStorage.setItem('meshnotes_pdfPageSize', size);
    dom.settingsPdfPageSize.value = size;
}

export function setPdfOrientation(orientation) {
    state.pdfOrientation = orientation;
    localStorage.setItem('meshnotes_pdfOrientation', orientation);
    dom.settingsPdfOrientation.value = orientation;
}

export function setPdfDpi(dpi) {
    state.pdfDpi = parseInt(dpi);
    localStorage.setItem('meshnotes_pdfDpi', dpi);
    dom.settingsPdfDpi.value = dpi;
}

/**
 * Converts DPI setting to a render multiplier.
 * Based on assumed ~150mm image width on A4:
 * - 72 DPI = ~425px = 1× (screen quality)
 * - 150 DPI = ~886px = 2× (standard print)
 * - 300 DPI = ~1772px = 4× (high quality print)
 */
export function getDpiMultiplier() {
    const dpi = state.pdfDpi || 150;
    return dpi / 72; // 72 DPI is baseline (1×)
}
