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
    state.brightness = value;
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
            // Handle both single materials and material arrays (multi-material meshes)
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
                mat.transparent = true;
                mat.opacity = state.modelOpacity;
                mat.depthWrite = state.modelOpacity > 0.9;
                mat.needsUpdate = true;
            });
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

/**
 * Builds a size-slider setter.
 *
 * Every marker/label size slider has the same shape — map the raw slider
 * position to a multiplier, store it on `state`, update the numeric readout,
 * persist the raw value — so they are generated from one factory rather than
 * written out five times.
 *
 * None of these re-render: renderAnnotations() lives downstream of this module
 * and importing it here would close a dependency cycle. The event listener that
 * calls the setter is responsible for re-rendering.
 *
 * @param {string} stateKey    Property on `state` holding the multiplier.
 * @param {string} storageKey  localStorage key holding the raw slider value.
 * @param {string} domValueKey Property on `dom` for the numeric readout span.
 * @returns {(value: number) => void}
 */
function makeSizeSetter(stateKey, storageKey, domValueKey) {
    return function (value) {
        state[stateKey] = sliderToMultiplier(value);
        dom[domValueKey].textContent = formatMultiplier(state[stateKey]);
        localStorage.setItem(storageKey, value);
    };
}

// ============ Marker Size Controls ============
// One setter per marker class. 'meshnotes_pointSize' keeps its original key so
// a user's existing preference survives the split (see loadSavedSettings() in
// main.js, which seeds the three new keys from it when they are absent).

export const setPointSize = makeSizeSetter(
    'pointSizeMultiplier', 'meshnotes_pointSize', 'pointSizeValue');

export const setVertexSize = makeSizeSetter(
    'vertexSizeMultiplier', 'meshnotes_vertexSize', 'vertexSizeValue');

export const setBoxHandleSize = makeSizeSetter(
    'boxHandleSizeMultiplier', 'meshnotes_boxHandleSize', 'boxHandleSizeValue');

export const setMeasureMarkerSize = makeSizeSetter(
    'measureMarkerSizeMultiplier', 'meshnotes_measureMarkerSize', 'measureMarkerSizeValue');

// ============ Text Size Control ============

export const setTextSize = makeSizeSetter(
    'textSizeMultiplier', 'meshnotes_textSize', 'textSizeValue');

// ============ Selection Callout Opacity ============

/**
 * Sets the opacity of the annotation selection callout.
 *
 * Written to a CSS custom property on the document root rather than to the
 * element itself, so it applies live even when the callout is already on
 * screen, and so selection-callout.js needs to know nothing about settings.
 *
 * @param {number} value Percentage, 20–100.
 */
export function setCalloutOpacity(value) {
    state.calloutOpacity = value / 100;
    dom.calloutOpacityValue.textContent = `${value}%`;
    document.documentElement.style.setProperty('--ac-opacity', state.calloutOpacity);
    localStorage.setItem('meshnotes_calloutOpacity', value);
}

/**
 * Turns the annotation selection callout on or off.
 *
 * Only the panel is affected. Selecting an annotation still centres the camera
 * and emphasises the geometry; with the callout off the annotation's name stays
 * on its 3D label sprite, which is where it lived before the callout existed.
 *
 * The opacity slider is meaningless while the callout is off, so it is disabled
 * and dimmed rather than left as a live control with no effect.
 *
 * @param {boolean} enabled
 */
export function setCalloutEnabled(enabled) {
    state.calloutEnabled = enabled;
    dom.calloutEnabledToggle.checked = enabled;
    dom.calloutOpacitySlider.disabled = !enabled;
    dom.calloutOpacityRow.classList.toggle('row-disabled', !enabled);
    localStorage.setItem('meshnotes_calloutEnabled', enabled ? 'true' : 'false');
}

// ============ Light Mode Controls ============

export function toggleLightMode() {
    state.lightFollowsCamera = !state.lightFollowsCamera;

    if (state.lightFollowsCamera) {
        dom.lightToggle.textContent = 'Follows Camera';
        dom.lightToggle.classList.add('active');
        dom.lightDirectionRow.classList.remove('visible');
        // Restore normal light intensity
        state.dirLight1.intensity = 0.96 * (state.brightness / 100);
        updateLightFromCamera();
    } else {
        dom.lightToggle.textContent = 'Fixed Direction';
        dom.lightToggle.classList.remove('active');
        dom.lightDirectionRow.classList.add('visible');
        // Boost light intensity 1.5x for better raking light shadow visibility
        state.dirLight1.intensity = 0.96 * (state.brightness / 100) * 1.5;
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

export function setDefaultAuthorOrcid(orcid) {
    state.defaultAuthorOrcid = (orcid || '').trim();
    localStorage.setItem('meshnotes_defaultAuthorOrcid', state.defaultAuthorOrcid);
}

export function setDefaultLanguage(lang) {
    state.defaultLanguage = lang || '';
    localStorage.setItem('meshnotes_defaultLanguage', state.defaultLanguage);
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
    state.vertexSizeMultiplier = 1.0;
    state.boxHandleSizeMultiplier = 1.0;
    state.measureMarkerSizeMultiplier = 1.0;
    state.textSizeMultiplier = 1.0;
    state.calloutOpacity = 1.0;
    state.calloutEnabled = true;
    state.defaultAuthor = '';
    state.defaultAuthorOrcid = '';
    state.defaultLanguage = '';
    state.measurementUnit = 'units';
    state.measurementLineColor = '#AA8101';
    state.measurementPointColor = '#FFFFFF';
    state.meshColor = '#888888';
    state.wireframeColor = '#AA8101';
    state.backgroundColor = '#041D31';
    state.pdfTitle = '';
    state.pdfInstitution = '';
    state.pdfProject = '';
    state.pdfAccentColor = '#AA8101';
    state.pdfPageSize = 'a4';
    state.pdfOrientation = 'portrait';
    state.pdfDpi = 150;
    state.pdfCameraDistance = 1.0;
    state.pdfCameraAngle = 60;
    state.screenshotQuality = 2;
    state.platePngWidth = 4000;
    state.platePdfDpi = 300;
    state.plateCellShape = 'net';
    state.surveyLockImported = SURVEY_SETTING_DEFAULTS.lockImported;
    state.surveyLabelsOffAbove = SURVEY_SETTING_DEFAULTS.labelsOffAbove;
    state.surveyResidualWarn = SURVEY_SETTING_DEFAULTS.residualWarn;
    state.surveySurfaceWarn = SURVEY_SETTING_DEFAULTS.surfaceWarn;
    state.surveySurfaceLimit = SURVEY_SETTING_DEFAULTS.surfaceLimit;
    state.surveyPdfSummary = SURVEY_SETTING_DEFAULTS.pdfSummary;
    state.surveyDotSize = SURVEY_DOT_SIZE.default;
    // The remembered survey column mappings have no state copy: the key sweep
    // above clears them.
    
    // Reset UI elements
    dom.pointSizeSlider.value = 100;
    dom.pointSizeValue.textContent = '×1.0';
    dom.vertexSizeSlider.value = 100;
    dom.vertexSizeValue.textContent = '×1.0';
    dom.boxHandleSizeSlider.value = 100;
    dom.boxHandleSizeValue.textContent = '×1.0';
    dom.measureMarkerSizeSlider.value = 100;
    dom.measureMarkerSizeValue.textContent = '×1.0';
    dom.textSizeSlider.value = 100;
    dom.textSizeValue.textContent = '×1.0';
    dom.calloutEnabledToggle.checked = true;
    dom.calloutOpacitySlider.disabled = false;
    dom.calloutOpacityRow.classList.remove('row-disabled');
    dom.calloutOpacitySlider.value = 100;
    dom.calloutOpacityValue.textContent = '100%';
    document.documentElement.style.setProperty('--ac-opacity', 1);
    dom.settingsDefaultAuthor.value = '';
    dom.settingsDefaultAuthorOrcid.value = '';
    dom.settingsDefaultLanguage.value = '';
    dom.settingsMeasurementUnit.value = 'units';
    dom.settingsMeasurementUnitCustom.value = '';
    dom.settingsMeasurementUnitCustom.style.display = 'none';
    dom.settingsMeasurementLineColor.value = '#AA8101';
    dom.settingsMeasurementPointColor.value = '#FFFFFF';
    dom.settingsMeshColor.value = '#888888';
    dom.settingsWireframeColor.value = '#AA8101';
    dom.settingsPdfTitle.value = '';
    dom.settingsPdfInstitution.value = '';
    dom.settingsPdfProject.value = '';
    dom.settingsPdfAccentColor.value = '#AA8101';
    dom.settingsPdfPageSize.value = 'a4';
    dom.settingsPdfOrientation.value = 'portrait';
    dom.settingsPdfDpi.value = '150';
    dom.settingsPdfCameraDistance.value = '1.0';
    dom.settingsPdfCameraDistanceValue.textContent = '×1.0';
    dom.settingsPdfCameraAngle.value = '60';
    dom.settingsPdfCameraAngleValue.textContent = '60°';
    dom.settingsScreenshotQuality.value = '2';
    dom.settingsPlatePngWidth.value = '4000';
    dom.settingsPlatePdfDpi.value = '300';
    dom.settingsPlateCellShape.value = 'net';
    dom.settingsSurveyLockImported.checked = SURVEY_SETTING_DEFAULTS.lockImported;
    dom.settingsSurveyLabelsOffAbove.value = String(SURVEY_SETTING_DEFAULTS.labelsOffAbove);
    dom.settingsSurveyResidualWarn.value = String(SURVEY_SETTING_DEFAULTS.residualWarn);
    dom.settingsSurveySurfaceWarn.value = String(SURVEY_SETTING_DEFAULTS.surfaceWarn);
    dom.settingsSurveySurfaceLimit.value = String(SURVEY_SETTING_DEFAULTS.surfaceLimit);
    dom.settingsSurveyPdfSummary.checked = SURVEY_SETTING_DEFAULTS.pdfSummary;
    showSurveyDotSize(SURVEY_DOT_SIZE.default);
    
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

// ============ Model Display Color Settings ============

export function setMeshColor(color) {
    state.meshColor = color;
    localStorage.setItem('meshnotes_meshColor', color);
    dom.settingsMeshColor.value = color;
}

export function setWireframeColor(color) {
    state.wireframeColor = color;
    localStorage.setItem('meshnotes_wireframeColor', color);
    dom.settingsWireframeColor.value = color;
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

export function setPdfCameraDistance(value) {
    state.pdfCameraDistance = parseFloat(value);
    localStorage.setItem('meshnotes_pdfCameraDistance', value);
    dom.settingsPdfCameraDistance.value = value;
    dom.settingsPdfCameraDistanceValue.textContent = `×${parseFloat(value).toFixed(1)}`;
}

export function setPdfCameraAngle(value) {
    state.pdfCameraAngle = parseInt(value);
    localStorage.setItem('meshnotes_pdfCameraAngle', value);
    dom.settingsPdfCameraAngle.value = value;
    dom.settingsPdfCameraAngleValue.textContent = `${value}°`;
}

// ============ Screenshot Settings ============

export function setScreenshotQuality(value) {
    state.screenshotQuality = parseInt(value);
    localStorage.setItem('meshnotes_screenshotQuality', value);
    dom.settingsScreenshotQuality.value = value;
}

// ============ Six-View Plate Settings ============

export function setPlatePngWidth(value) {
    state.platePngWidth = parseInt(value);
    localStorage.setItem('meshnotes_platePngWidth', value);
    dom.settingsPlatePngWidth.value = value;
}

export function setPlatePdfDpi(value) {
    state.platePdfDpi = parseInt(value);
    localStorage.setItem('meshnotes_platePdfDpi', value);
    dom.settingsPlatePdfDpi.value = value;
}

export function setPlateCellShape(value) {
    // Normalised so values stored by earlier builds ('viewport', 'fit',
    // 'square') resolve to one of the current options rather than leaving the
    // select blank.
    const shape = value === 'uniform' || value === 'square' ? 'uniform' : 'net';
    state.plateCellShape = shape;
    localStorage.setItem('meshnotes_plateCellShape', shape);
    dom.settingsPlateCellShape.value = shape;
}

// ============ Survey Import Settings ============
// Six visible options (Settings → Survey import). The survey modules read
// state.survey* when they use a value, never a copy taken at init, so a change
// applies to the next import, fit or report without a reload. Distances are
// stored in metres (state and localStorage) and shown in cm or m. The three
// thresholds and the label limit are selects with fixed options; a stored
// value that is not one of them falls back to the default, so the select never
// shows blank. The defaults mirror state.js and the constants in
// js/survey/rigid-fit.js and survey-import.js, which this module cannot import
// (tests/lighting.test.js checks that they agree).

export const SURVEY_SETTING_DEFAULTS = Object.freeze({
    lockImported: true,     // meshnotes_surveyLockImported
    labelsOffAbove: 50,     // meshnotes_surveyLabelsOffAbove (rows; 0 = never)
    residualWarn: 0.05,     // meshnotes_surveyResidualWarn (m)
    surfaceWarn: 0.10,      // meshnotes_surveySurfaceWarn (m)
    surfaceLimit: 0.5,      // meshnotes_surveySurfaceLimit (m)
    pdfSummary: true        // meshnotes_surveyPdfSummary
});

export const SURVEY_SETTING_OPTIONS = Object.freeze({
    labelsOffAbove: Object.freeze([0, 25, 50, 100, 200, 500]),
    residualWarn: Object.freeze([0.02, 0.03, 0.05, 0.1]),
    surfaceWarn: Object.freeze([0.05, 0.1, 0.2, 0.5]),
    surfaceLimit: Object.freeze([0.1, 0.25, 0.5, 1, 2])
});

/**
 * One of a select's fixed options for a stored or chosen value.
 * @param {string|number} value - the select value or the stored string
 * @param {number[]} options
 * @param {number} fallback - returned when value is not a number or not an option
 * @returns {number}
 */
export function surveySettingChoice(value, options, fallback) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    const match = options.find(o => Math.abs(o - n) < 1e-9);
    return match === undefined ? fallback : match;
}

// Writes a numeric survey setting to state, localStorage and its select. The
// option values in index.html are String(number), e.g. "0.1".
function setSurveyChoice(stateKey, storageKey, domKey, optionsKey, value) {
    const n = surveySettingChoice(value, SURVEY_SETTING_OPTIONS[optionsKey], SURVEY_SETTING_DEFAULTS[optionsKey]);
    state[stateKey] = n;
    localStorage.setItem(storageKey, String(n));
    dom[domKey].value = String(n);
}

/**
 * Whether imported survey points start locked.
 * @param {boolean} enabled
 */
export function setSurveyLockImported(enabled) {
    state.surveyLockImported = enabled;
    dom.settingsSurveyLockImported.checked = enabled;
    localStorage.setItem('meshnotes_surveyLockImported', enabled ? 'true' : 'false');
}

/**
 * A new import group gets its labels switched off when more points than this
 * are created (0 = never).
 * @param {string|number} value - one of SURVEY_SETTING_OPTIONS.labelsOffAbove
 */
export function setSurveyLabelsOffAbove(value) {
    setSurveyChoice('surveyLabelsOffAbove', 'meshnotes_surveyLabelsOffAbove',
        'settingsSurveyLabelsOffAbove', 'labelsOffAbove', value);
}

/**
 * Residual of a control point (m) above which the fit raises RESIDUAL_WARN.
 * @param {string|number} value - one of SURVEY_SETTING_OPTIONS.residualWarn
 */
export function setSurveyResidualWarn(value) {
    setSurveyChoice('surveyResidualWarn', 'meshnotes_surveyResidualWarn',
        'settingsSurveyResidualWarn', 'residualWarn', value);
}

/**
 * Distance (m) from the fitted position to the surface above which the
 * selection list and the import summary flag a point.
 * @param {string|number} value - one of SURVEY_SETTING_OPTIONS.surfaceWarn
 */
export function setSurveySurfaceWarn(value) {
    setSurveyChoice('surveySurfaceWarn', 'meshnotes_surveySurfaceWarn',
        'settingsSurveySurfaceWarn', 'surfaceWarn', value);
}

/**
 * Default distance limit (m) of the selection step and of the picking
 * preview. A limit changed in the selection dialog applies to that import only.
 * @param {string|number} value - one of SURVEY_SETTING_OPTIONS.surfaceLimit
 */
export function setSurveySurfaceLimit(value) {
    setSurveyChoice('surveySurfaceLimit', 'meshnotes_surveySurfaceLimit',
        'settingsSurveySurfaceLimit', 'surfaceLimit', value);
}

/**
 * Whether the PDF report prints the alignment summary section.
 * @param {boolean} enabled
 */
export function setSurveyPdfSummary(enabled) {
    state.surveyPdfSummary = enabled;
    dom.settingsSurveyPdfSummary.checked = enabled;
    localStorage.setItem('meshnotes_surveyPdfSummary', enabled ? 'true' : 'false');
}

// The Dot size slider of the picking panel and of the Alignment Manager's
// control-point view (not in the Settings pane): a multiplier on the
// screen-sized picking markers of js/survey/ui-alignment.js. It is separate
// from the Point Markers size, which scales annotation markers in model units
// over a far wider range. Both sliders show the one value, in percent.

export const SURVEY_DOT_SIZE = Object.freeze({ min: 0.4, max: 3, default: 1 });    // meshnotes_surveyDotSize

/**
 * The dot size multiplier for a slider or stored value, within the range.
 * @param {string|number} value - the multiplier (a slider value divided by 100)
 * @returns {number} the default when value is not a number
 */
export function surveyDotSizeChoice(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(n)) return SURVEY_DOT_SIZE.default;
    return Math.min(SURVEY_DOT_SIZE.max, Math.max(SURVEY_DOT_SIZE.min, Math.round(n * 100) / 100));
}

// Both sliders and their readouts
function showSurveyDotSize(multiplier) {
    const percent = String(Math.round(multiplier * 100));
    dom.surveyPickDotSize.value = percent;
    dom.surveyPickDotSizeValue.textContent = formatMultiplier(multiplier);
    dom.alignmentViewDotSize.value = percent;
    dom.alignmentViewDotSizeValue.textContent = formatMultiplier(multiplier);
}

/**
 * Size of the picking markers. Does not redraw them: the caller refreshes the
 * overlays (refreshSurveyOverlays in ui-alignment.js).
 * @param {string|number} value - the multiplier
 */
export function setSurveyDotSize(value) {
    const multiplier = surveyDotSizeChoice(value);
    state.surveyDotSize = multiplier;
    localStorage.setItem('meshnotes_surveyDotSize', String(multiplier));
    showSurveyDotSize(multiplier);
}

/**
 * Restores the six survey settings and the dot size from localStorage
 * (loadSavedSettings in main.js). Booleans follow the calloutEnabled pattern (any stored value other
 * than 'true' reads as off); numbers are restored only when they parse, and a
 * number that is not an option falls back to the default. A missing key
 * leaves the default from state.js.
 */
export function restoreSurveySettings() {
    const savedLock = localStorage.getItem('meshnotes_surveyLockImported');
    if (savedLock !== null) {
        setSurveyLockImported(savedLock === 'true');
    }
    const savedPdfSummary = localStorage.getItem('meshnotes_surveyPdfSummary');
    if (savedPdfSummary !== null) {
        setSurveyPdfSummary(savedPdfSummary === 'true');
    }
    const numeric = [
        ['meshnotes_surveyLabelsOffAbove', setSurveyLabelsOffAbove],
        ['meshnotes_surveyResidualWarn', setSurveyResidualWarn],
        ['meshnotes_surveySurfaceWarn', setSurveySurfaceWarn],
        ['meshnotes_surveySurfaceLimit', setSurveySurfaceLimit]
    ];
    for (const [key, setter] of numeric) {
        const saved = localStorage.getItem(key);
        if (saved !== null && Number.isFinite(parseFloat(saved))) {
            setter(saved);
        }
    }
    const savedDotSize = localStorage.getItem('meshnotes_surveyDotSize');
    if (savedDotSize !== null && Number.isFinite(parseFloat(savedDotSize))) {
        setSurveyDotSize(savedDotSize);
    }
}

// Remembered column mappings (not shown in Settings): the mapping used for a
// CSV header, keyed by headerSignature() from js/survey/column-mapping.js,
// newest first and at most SURVEY_MAPPINGS_MAX headers. Stored as JSON under
// a meshnotes_ key, so "Reset all settings" clears it with the other keys.
// This module must not import js/survey/* (see makeSizeSetter), so the
// mapping is copied here without validation; the mapping dialog checks it
// against the file (sanitizeMapping in survey-import.js).

const SURVEY_MAPPINGS_KEY = 'meshnotes_surveyMappings';
export const SURVEY_MAPPINGS_MAX = 20;

/**
 * All remembered column mappings, newest first.
 * @returns {Array<{signature: string, mapping: object, saved: string}>} an
 *   empty list when nothing is stored, the value is corrupt or storage is blocked
 */
export function getSurveyMappings() {
    try {
        const list = JSON.parse(localStorage.getItem(SURVEY_MAPPINGS_KEY) || '[]');
        if (!Array.isArray(list)) return [];
        return list.filter(e => e && typeof e.signature === 'string' && e.signature &&
            e.mapping && typeof e.mapping === 'object');
    } catch (e) {
        return [];
    }
}

/**
 * The remembered mapping for a header signature.
 * @param {string|null} signature - headerSignature(parsed.rawHeaders)
 * @returns {object|null} the stored mapping (column indices), or null
 */
export function getSurveyMapping(signature) {
    if (!signature) return null;
    const entry = getSurveyMappings().find(e => e.signature === signature);
    return entry ? entry.mapping : null;
}

/**
 * Remembers the mapping used for a header (called after an import). The
 * entry moves to the front; the oldest beyond SURVEY_MAPPINGS_MAX are dropped.
 * @param {string|null} signature - null (a file without a header) is not remembered
 * @param {object} mapping - { name, easting, northing, height, description, code, extras }
 */
export function saveSurveyMapping(signature, mapping) {
    if (!signature || !mapping) return;
    const entry = {
        signature,
        mapping: { ...mapping, extras: Array.isArray(mapping.extras) ? [...mapping.extras] : [] },
        saved: new Date().toISOString()
    };
    const list = [entry, ...getSurveyMappings().filter(e => e.signature !== signature)].slice(0, SURVEY_MAPPINGS_MAX);
    try {
        localStorage.setItem(SURVEY_MAPPINGS_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn('Could not remember the survey column mapping:', e);
    }
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
