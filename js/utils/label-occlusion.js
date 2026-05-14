// js/utils/label-occlusion.js - Label visibility based on model occlusion
import * as THREE from 'three';
import { state } from '../state.js';

// Reusable objects to avoid GC pressure
const _raycaster = new THREE.Raycaster();
const _direction = new THREE.Vector3();
const _labelWorldPos = new THREE.Vector3();
const _lastCameraPos = new THREE.Vector3();
const _lastCameraTarget = new THREE.Vector3();

// Throttling state
let _lastUpdateTime = 0;
let _updateScheduled = false;
let _rafId = null;
let _timeoutId = null;

// Cached label sprites — rebuilt on forceUpdate, avoids full scene graph traversal
let _cachedLabelSprites = null;

// Configuration
const UPDATE_INTERVAL_MS = 300;  // Throttle interval during camera movement
const CAMERA_MOVE_THRESHOLD = 0.0001; // Minimum squared-distance camera must move to trigger update
const OCCLUSION_THRESHOLD_RATIO = 0.15; // Intersection must be at least this ratio closer to camera than annotation
                                        // e.g., 0.15 means ignore intersections within 15% of the annotation distance

/**
 * Checks if a label position is occluded by the model when viewed from the camera.
 * Uses BVH-accelerated raycasting for performance.
 * 
 * To handle uneven surfaces (where the annotation center might be in a small
 * depression), we use a threshold: an annotation is only considered occluded
 * if the intersection is significantly closer to the camera than the annotation.
 * Minor surface variations near the annotation point are ignored.
 * 
 * @param {THREE.Vector3} labelPosition - World position of the label
 * @returns {boolean} True if the label is occluded (should be hidden)
 */
function isLabelOccluded(labelPosition) {
    if (!state.currentModel || state.modelMeshes.length === 0) {
        return false;
    }

    const cameraPosition = state.camera.position;
    
    // Get the label's world position
    _labelWorldPos.copy(labelPosition);
    
    // Direction from camera to label
    _direction.subVectors(_labelWorldPos, cameraPosition).normalize();
    
    // Distance from camera to label
    const distanceToLabel = cameraPosition.distanceTo(_labelWorldPos);
    
    // Calculate the threshold distance - intersections must be at least this much
    // closer to the camera to count as occlusion. This handles uneven surfaces
    // where the annotation center might be slightly behind nearby geometry.
    const thresholdDistance = distanceToLabel * (1 - OCCLUSION_THRESHOLD_RATIO);
    
    // Set up raycaster - cast all the way to the annotation
    _raycaster.set(cameraPosition, _direction);
    _raycaster.far = distanceToLabel;
    _raycaster.firstHitOnly = true; // BVH optimization: stop at first hit
    
    // Cast ray against all model meshes
    const intersects = _raycaster.intersectObjects(state.modelMeshes, false);
    
    // Only consider occluded if the intersection is significantly closer
    // (beyond the threshold) - not just barely in front of the annotation
    if (intersects.length > 0) {
        const intersectionDistance = intersects[0].distance;
        return intersectionDistance < thresholdDistance;
    }
    
    return false;
}

/**
 * Builds the cached array of label sprites from the annotation objects group.
 * Called once when labels change, avoids repeated full scene graph traversal.
 */
function rebuildLabelCache() {
    _cachedLabelSprites = [];
    
    state.annotationObjects.traverse((child) => {
        if (child.isSprite && child.userData.annotationId !== undefined) {
            _cachedLabelSprites.push(child);
        }
    });
}

/**
 * Updates visibility of all annotation labels based on occlusion.
 * Labels that are behind the model (from camera's perspective) are hidden.
 * 
 * Skipped entirely when BVH is unavailable (large models without acceleration
 * would cause severe frame drops from brute-force raycasting).
 */
function updateAllLabelVisibility() {
    // Skip occlusion when BVH is not available — raycasting would be too expensive
    if (!state.bvhAvailable) {
        return;
    }
    
    if (!state.annotationObjects || !state.currentModel) {
        return;
    }

    // Rebuild cache if invalidated
    if (!_cachedLabelSprites) {
        rebuildLabelCache();
    }
    
    // Nothing to check
    if (_cachedLabelSprites.length === 0) {
        return;
    }

    for (const sprite of _cachedLabelSprites) {
        const ann = state.annotations.find(a => a.id === sprite.userData.annotationId);
        if (!ann) {
            sprite.visible = false;
            continue;
        }
        
        const group = state.groups.find(g => g.id === ann.groupId);
        if (!group || !group.visible) {
            sprite.visible = false;
            continue;
        }
        
        // Get the reference position for occlusion check
        // Use the stored reference position or fall back to sprite position
        const checkPosition = sprite.userData.occlusionCheckPosition || sprite.position;
        
        // Check occlusion and set visibility
        const occluded = isLabelOccluded(checkPosition);
        sprite.visible = !occluded;
    }
}

/**
 * Checks whether the camera has moved enough to justify a new occlusion pass.
 * Prevents wasted work during tiny damping oscillations near rest.
 */
function hasCameraMovedEnough() {
    const camPos = state.camera.position;
    const target = state.controls.target;
    
    const posDelta = _lastCameraPos.distanceToSquared(camPos);
    const targetDelta = _lastCameraTarget.distanceToSquared(target);
    
    if (posDelta > CAMERA_MOVE_THRESHOLD || targetDelta > CAMERA_MOVE_THRESHOLD) {
        _lastCameraPos.copy(camPos);
        _lastCameraTarget.copy(target);
        return true;
    }
    return false;
}

/**
 * Schedules a throttled label visibility update.
 * Uses requestAnimationFrame to batch updates and avoid blocking.
 * Skips update if camera has barely moved (damping micro-oscillations).
 */
function scheduleUpdate() {
    // Skip entirely when BVH is not available
    if (!state.bvhAvailable) return;
    
    if (_updateScheduled) return;
    
    // Don't bother if camera hasn't moved meaningfully
    if (!hasCameraMovedEnough()) return;
    
    const now = performance.now();
    const timeSinceLastUpdate = now - _lastUpdateTime;
    
    if (timeSinceLastUpdate >= UPDATE_INTERVAL_MS) {
        // Enough time has passed, update immediately on next frame
        _updateScheduled = true;
        _rafId = requestAnimationFrame(() => {
            updateAllLabelVisibility();
            _lastUpdateTime = performance.now();
            _updateScheduled = false;
        });
    } else {
        // Schedule update after remaining throttle time
        _updateScheduled = true;
        const delay = UPDATE_INTERVAL_MS - timeSinceLastUpdate;
        _timeoutId = setTimeout(() => {
            _rafId = requestAnimationFrame(() => {
                updateAllLabelVisibility();
                _lastUpdateTime = performance.now();
                _updateScheduled = false;
            });
        }, delay);
    }
}

/**
 * Forces an immediate update of label visibility.
 * Also invalidates the label cache so it's rebuilt on next pass.
 * Use when annotations are re-rendered (labels added/removed).
 */
function forceUpdate() {
    // Cancel any pending scheduled update
    if (_rafId !== null) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
    }
    if (_timeoutId !== null) {
        clearTimeout(_timeoutId);
        _timeoutId = null;
    }
    _updateScheduled = false;
    
    // Invalidate cache — labels may have changed
    _cachedLabelSprites = null;
    
    updateAllLabelVisibility();
    _lastUpdateTime = performance.now();
}

/**
 * Sets up the controls change listener for occlusion updates.
 * Should be called after OrbitControls is initialized.
 */
function initLabelOcclusionUpdates() {
    if (!state.controls) {
        console.warn('Controls not initialized, cannot set up label occlusion');
        return;
    }
    
    // Initialize camera tracking positions
    _lastCameraPos.copy(state.camera.position);
    _lastCameraTarget.copy(state.controls.target);
    
    // Listen for camera changes (OrbitControls fires 'change' on camera movement)
    state.controls.addEventListener('change', scheduleUpdate);
    
    // Also update when ViewHelper animates the camera
    if (state.viewHelper) {
        state.viewHelper.addEventListener('change', scheduleUpdate);
    }
}

/**
 * Cleanup function to remove event listeners.
 */
function disposeLabelOcclusionUpdates() {
    if (state.controls) {
        state.controls.removeEventListener('change', scheduleUpdate);
    }
    if (state.viewHelper) {
        state.viewHelper.removeEventListener('change', scheduleUpdate);
    }
    if (_rafId !== null) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
    }
    if (_timeoutId !== null) {
        clearTimeout(_timeoutId);
        _timeoutId = null;
    }
}

export {
    initLabelOcclusionUpdates,
    disposeLabelOcclusionUpdates,
    forceUpdate as forceOcclusionUpdate,
    scheduleUpdate as scheduleOcclusionUpdate
};
