// js/annotation-tools/measure.js
// Measurement tool: point placement, distance calc, live + finalized labels,
// measurement list UI, and re-rendering of stored measurements.
// Extracted verbatim from editing.js (Phase 1 module split) - behaviour unchanged.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { state, dom } from '../state.js';
import { showStatus } from '../utils/helpers.js';
import { createScaledTextSprite, getViewportWidth, getViewportHeight } from '../core/scene.js';

// Monotonic id counter for measurements. Ids must stay unique for the
// lifetime of a session even across deletions (deriving the id from the
// array length caused duplicate ids after delete + add, so the ✕ button
// could remove the wrong measurement). Displayed numbering therefore keeps
// gaps after deletions; reset only on a full clear.
let _nextMeasurementId = 1;

/**
 * Undo the last measurement point placed during an in-progress measurement.
 * Removes the last point, its marker, and updates the measurement line/label.
 * @returns {boolean} True if a point was removed, false if no points to undo.
 */
export function undoLastMeasurePoint() {
    if (state.measurePoints.length === 0) {
        return false;
    }
    
    // Remove the last point
    state.measurePoints.pop();
    
    // Remove the last marker from the scene
    if (state.measureMarkers.length > 0) {
        const marker = state.measureMarkers.pop();
        if (marker.geometry) marker.geometry.dispose();
        if (marker.material) marker.material.dispose();
        state.annotationObjects.remove(marker);
    }
    
    // Update the line and label
    if (state.measurePoints.length >= 2) {
        updateMeasureLine();
        updateLiveMeasurementLabel();
    } else {
        // Less than 2 points — remove line and label
        if (state.measureLine) {
            if (state.measureLine.geometry) state.measureLine.geometry.dispose();
            if (state.measureLine.material) state.measureLine.material.dispose();
            state.annotationObjects.remove(state.measureLine);
            state.measureLine = null;
        }
        if (state.measureLabel) {
            if (state.measureLabel.material && state.measureLabel.material.map) {
                state.measureLabel.material.map.dispose();
            }
            if (state.measureLabel.material) state.measureLabel.material.dispose();
            state.annotationObjects.remove(state.measureLabel);
            state.measureLabel = null;
        }
    }
    
    // If we dropped below 2 points, exit multi-point mode
    if (state.measurePoints.length < 2) {
        state.isMultiPointMeasure = false;
    }
    
    const remaining = state.measurePoints.length;
    if (remaining === 0) {
        showStatus('All points removed. Click to start again.');
    } else {
        showStatus(`Point removed. ${remaining} point${remaining !== 1 ? 's' : ''} remaining.`);
    }
    
    return true;
}

export function addMeasureMarker(point) {
    const geometry = new THREE.SphereGeometry(0.01, 16, 16);
    const material = new THREE.MeshBasicMaterial({
        color: state.measurementPointColor,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        polygonOffsetUnits: -5
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(point);
    marker.renderOrder = 1000;

    if (state.currentModel) {
        const box = new THREE.Box3().setFromObject(state.currentModel);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        marker.scale.setScalar(Math.pow(maxDim, 0.8) * 0.05 * state.pointSizeMultiplier);
    }

    state.annotationObjects.add(marker);
    state.measureMarkers.push(marker);
}

/**
 * Calculate total distance along a path of points.
 * @param {THREE.Vector3[]} points - Array of points
 * @returns {number} Total distance
 */
function calculateTotalDistance(points) {
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
        total += points[i].distanceTo(points[i + 1]);
    }
    return total;
}

/**
 * Updates the measurement line to connect all current measurement points.
 * Supports both two-point and multi-point measurements.
 */
export function updateMeasureLine() {
    if (state.measureLine) {
        if (state.measureLine.geometry) state.measureLine.geometry.dispose();
        if (state.measureLine.material) state.measureLine.material.dispose();
        state.annotationObjects.remove(state.measureLine);
        state.measureLine = null;
    }

    if (state.measurePoints.length < 2) return;

    // Build positions array from all measurement points
    const positions = [];
    state.measurePoints.forEach(p => {
        positions.push(p.x, p.y, p.z);
    });

    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    const material = new LineMaterial({
        color: state.measurementLineColor,
        linewidth: 3,
        resolution: new THREE.Vector2(getViewportWidth(), getViewportHeight()),
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
    });

    state.measureLine = new Line2(geometry, material);
    state.annotationObjects.add(state.measureLine);
}

/**
 * Updates or creates the live measurement label showing current total distance.
 * Positioned at the midpoint of the last segment for visibility.
 */
export function updateLiveMeasurementLabel() {
    // Remove existing live label
    if (state.measureLabel) {
        if (state.measureLabel.material && state.measureLabel.material.map) {
            state.measureLabel.material.map.dispose();
        }
        if (state.measureLabel.material) state.measureLabel.material.dispose();
        state.annotationObjects.remove(state.measureLabel);
        state.measureLabel = null;
    }

    if (state.measurePoints.length < 2) return;

    const totalDist = calculateTotalDistance(state.measurePoints);
    const numSegments = state.measurePoints.length - 1;
    
    // Position label at the last point (endpoint of measurement)
    const lastPoint = state.measurePoints[state.measurePoints.length - 1];
    
    // Create label text showing total and segment count for multi-point
    const unit = state.measurementUnit || 'units';
    let labelText;
    if (numSegments > 1) {
        labelText = `${totalDist.toFixed(3)} ${unit} (${numSegments} seg)`;
    } else {
        labelText = `${totalDist.toFixed(3)} ${unit}`;
    }
    
    state.measureLabel = createScaledTextSprite(labelText, state.measurementLineColor, lastPoint, 0.5);
    state.annotationObjects.add(state.measureLabel);
}

/**
 * Finalizes the current measurement, storing it and resetting state for next measurement.
 */
export function finalizeMeasurement() {
    if (state.measurePoints.length < 2) return;

    const totalDist = calculateTotalDistance(state.measurePoints);
    const numSegments = state.measurePoints.length - 1;

    // Remove live label (will be replaced by final label)
    if (state.measureLabel) {
        if (state.measureLabel.material && state.measureLabel.material.map) {
            state.measureLabel.material.map.dispose();
        }
        if (state.measureLabel.material) state.measureLabel.material.dispose();
        state.annotationObjects.remove(state.measureLabel);
        state.measureLabel = null;
    }

    // Create final label at the midpoint of the entire path
    const midIndex = Math.floor(state.measurePoints.length / 2);
    let labelPosition;
    if (state.measurePoints.length === 2) {
        // Two points: midpoint between them
        labelPosition = new THREE.Vector3()
            .addVectors(state.measurePoints[0], state.measurePoints[1])
            .multiplyScalar(0.5);
    } else {
        // Multi-point: use middle point or midpoint between two middle points
        if (state.measurePoints.length % 2 === 1) {
            labelPosition = state.measurePoints[midIndex].clone();
        } else {
            labelPosition = new THREE.Vector3()
                .addVectors(state.measurePoints[midIndex - 1], state.measurePoints[midIndex])
                .multiplyScalar(0.5);
        }
    }

    // Create label text
    const unit = state.measurementUnit || 'units';
    let labelText;
    if (numSegments > 1) {
        labelText = `${totalDist.toFixed(3)} ${unit} (${numSegments} seg)`;
    } else {
        labelText = `${totalDist.toFixed(3)} ${unit}`;
    }

    const label = createScaledTextSprite(labelText, state.measurementLineColor, labelPosition, 0.5);
    state.annotationObjects.add(label);

    // Store measurement with all points
    const measurementId = _nextMeasurementId++;
    state.measurements.push({
        id: measurementId,
        distance: totalDist,
        segments: numSegments,
        // Store all point coordinates for re-rendering
        points: state.measurePoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
        markers: [...state.measureMarkers],
        line: state.measureLine,
        label: label
    });

    updateMeasurementsDisplay();

    // Reset for next measurement
    state.measurePoints = [];
    state.measureMarkers = [];
    state.measureLine = null;
    state.isMultiPointMeasure = false;
}

/**
 * Handle a measurement-tool tap: add a point (and continue in multi-point mode
 * with Ctrl/Cmd held), or finalize the measurement. Lifted verbatim from the
 * onCanvasTap measure branch in editing.js (router-thinning pass) - behaviour unchanged.
 * @param {PointerEvent|MouseEvent} event - the tap event (for Ctrl/Cmd detection).
 * @param {THREE.Vector3} point - the intersected world-space point.
 */
export function handleMeasureTap(event, point) {
    const isCtrlHeld = event.ctrlKey || event.metaKey;

    // Multi-point measurement logic:
    // - Ctrl+click: add point and continue (multi-point mode)
    // - Plain click with 2+ points in multi-point mode: finalize
    // - Plain click otherwise: add point (finalizes on the 2nd point)
    // Note: in normal two-point mode a measurement always finalizes (and
    // clears measurePoints) on the 2nd click inside the else-branch below,
    // so "2+ points outside multi-point mode" is unreachable by design.

    if (state.measurePoints.length >= 2 && !isCtrlHeld && state.isMultiPointMeasure) {
        // Finalizing multi-point measurement: the plain click is a pure
        // "done" gesture — its position is deliberately NOT added as a
        // point (consistent with double-tap-to-finish on touch).
        finalizeMeasurement();
    } else {
        // Add point to current measurement
        state.measurePoints.push(point);
        addMeasureMarker(point);

        // If Ctrl is held, we're in multi-point mode
        if (isCtrlHeld) {
            state.isMultiPointMeasure = true;
        }

        // Update visual with running distance if we have 2+ points
        if (state.measurePoints.length >= 2) {
            updateMeasureLine();
            updateLiveMeasurementLabel();

            // If not in multi-point mode (normal two-point), finalize
            if (!state.isMultiPointMeasure && !isCtrlHeld) {
                finalizeMeasurement();
            }
        }
    }
}

export function updateMeasurementsDisplay() {
    const unit = state.measurementUnit || 'units';
    if (state.measurements.length === 0) {
        dom.measurementsList.innerHTML = '<div style="color: #888;">No measurements yet</div>';
    } else {
        dom.measurementsList.innerHTML = state.measurements.map(m => {
            const segmentBreakdown = buildSegmentBreakdown(m);
            return `
            <div class="measurement-item" data-measurement-id="${m.id}">
                <div class="measurement-main">
                    <span class="label">Distance ${m.id}:</span>
                    <span class="value" data-copy-value="${m.distance.toFixed(3)}">${m.distance.toFixed(3)} ${unit}</span>
                    <button class="measurement-delete" data-delete-id="${m.id}" title="Delete this measurement">×</button>
                </div>
                ${segmentBreakdown}
            </div>
        `;
        }).join('');
        
        // Attach event listeners for delete buttons
        dom.measurementsList.querySelectorAll('.measurement-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.deleteId);
                deleteMeasurement(id);
            });
        });
        
        // Attach event listeners for click-to-copy on values
        dom.measurementsList.querySelectorAll('.value').forEach(valueEl => {
            valueEl.addEventListener('click', (e) => {
                e.stopPropagation();
                const copyValue = valueEl.dataset.copyValue + ' ' + unit;
                copyToClipboard(copyValue, valueEl);
            });
        });
    }
}

/**
 * Build segment breakdown HTML for multi-point measurements.
 * Shows individual segment distances in format: (1.234 + 2.345 + 3.456)
 * @param {Object} m - Measurement object with points array
 * @returns {string} HTML string for segment breakdown, or empty string for 2-point measurements
 */
function buildSegmentBreakdown(m) {
    if (!m.points || m.points.length <= 2) return '';
    
    const segments = [];
    for (let i = 0; i < m.points.length - 1; i++) {
        const p1 = new THREE.Vector3(m.points[i].x, m.points[i].y, m.points[i].z);
        const p2 = new THREE.Vector3(m.points[i + 1].x, m.points[i + 1].y, m.points[i + 1].z);
        segments.push(p1.distanceTo(p2).toFixed(3));
    }
    
    return `<div class="measurement-segments">(${segments.join(' + ')})</div>`;
}

/**
 * Delete a specific measurement by ID.
 * @param {number} id - The measurement ID to delete
 */
export function deleteMeasurement(id) {
    const index = state.measurements.findIndex(m => m.id === id);
    if (index === -1) return;
    
    const m = state.measurements[index];
    
    // Clean up 3D objects
    if (m.markers) {
        m.markers.forEach(marker => {
            if (marker.geometry) marker.geometry.dispose();
            if (marker.material) marker.material.dispose();
            state.annotationObjects.remove(marker);
        });
    }
    if (m.line) {
        if (m.line.geometry) m.line.geometry.dispose();
        if (m.line.material) m.line.material.dispose();
        state.annotationObjects.remove(m.line);
    }
    if (m.label) {
        if (m.label.material && m.label.material.map) m.label.material.map.dispose();
        if (m.label.material) m.label.material.dispose();
        state.annotationObjects.remove(m.label);
    }
    
    // Remove from array
    state.measurements.splice(index, 1);
    
    // Update display
    updateMeasurementsDisplay();
    showStatus(`Measurement #${id} deleted`);
}

/**
 * Copy text to clipboard and show feedback on the element.
 * @param {string} text - Text to copy
 * @param {HTMLElement} element - Element to show feedback on
 */
function copyToClipboard(text, element) {
    navigator.clipboard.writeText(text).then(() => {
        // Show copied feedback
        const originalText = element.textContent;
        element.classList.add('copied');
        element.textContent = 'Copied!';
        
        setTimeout(() => {
            element.textContent = originalText;
            element.classList.remove('copied');
        }, 1000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        showStatus('Failed to copy to clipboard');
    });
}

/**
 * Clear the in-progress (not-yet-finalized) measurement: its points, markers,
 * live line, live label, and multi-point flag. Shared by editing.js's
 * clearTempDrawing and by clearAllMeasurements (which additionally removes all
 * committed measurements afterwards).
 */
export function clearActiveMeasurement() {
    state.measurePoints = [];
    state.measureMarkers.forEach(m => {
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
        state.annotationObjects.remove(m);
    });
    state.measureMarkers = [];
    if (state.measureLine) {
        if (state.measureLine.geometry) state.measureLine.geometry.dispose();
        if (state.measureLine.material) state.measureLine.material.dispose();
        state.annotationObjects.remove(state.measureLine);
        state.measureLine = null;
    }
    // Clear live measurement label
    if (state.measureLabel) {
        if (state.measureLabel.material && state.measureLabel.material.map) {
            state.measureLabel.material.map.dispose();
        }
        if (state.measureLabel.material) state.measureLabel.material.dispose();
        state.annotationObjects.remove(state.measureLabel);
        state.measureLabel = null;
    }
    state.isMultiPointMeasure = false;
}

export function clearAllMeasurements() {
    clearActiveMeasurement();

    state.measurements.forEach(m => {
        m.markers.forEach(marker => {
            if (marker.geometry) marker.geometry.dispose();
            if (marker.material) marker.material.dispose();
            state.annotationObjects.remove(marker);
        });
        if (m.line) {
            if (m.line.geometry) m.line.geometry.dispose();
            if (m.line.material) m.line.material.dispose();
            state.annotationObjects.remove(m.line);
        }
        if (m.label) {
            if (m.label.material && m.label.material.map) m.label.material.map.dispose();
            if (m.label.material) m.label.material.dispose();
            state.annotationObjects.remove(m.label);
        }
    });
    state.measurements = [];
    _nextMeasurementId = 1; // Fresh numbering after a full clear

    updateMeasurementsDisplay();
}

/**
 * Re-creates the 3D objects for all stored measurements.
 * Called after renderAnnotations() clears annotationObjects to preserve measurements.
 * Supports both two-point and multi-point measurements.
 */
export function renderMeasurements() {
    if (state.measurements.length === 0) return;
    
    // Compute scaling factor based on model size
    let maxDim = 1;
    if (state.currentModel) {
        const box = new THREE.Box3().setFromObject(state.currentModel);
        const size = box.getSize(new THREE.Vector3());
        maxDim = Math.max(size.x, size.y, size.z);
    }
    
    state.measurements.forEach(m => {
        if (!m.points || m.points.length < 2) return;
        
        // Re-create markers for all measurement points
        const newMarkers = [];
        m.points.forEach(point => {
            const geometry = new THREE.SphereGeometry(0.01, 16, 16);
            const material = new THREE.MeshBasicMaterial({
                color: state.measurementPointColor,
                depthTest: true,
                polygonOffset: true,
                polygonOffsetFactor: -5,
                polygonOffsetUnits: -5
            });
            const marker = new THREE.Mesh(geometry, material);
            marker.position.set(point.x, point.y, point.z);
            marker.renderOrder = 1000;
            marker.scale.setScalar(Math.pow(maxDim, 0.8) * 0.05 * state.pointSizeMultiplier);
            state.annotationObjects.add(marker);
            newMarkers.push(marker);
        });
        m.markers = newMarkers;
        
        // Re-create line connecting all points
        const positions = [];
        m.points.forEach(p => {
            positions.push(p.x, p.y, p.z);
        });
        
        const lineGeometry = new LineGeometry();
        lineGeometry.setPositions(positions);
        
        const lineMaterial = new LineMaterial({
            color: state.measurementLineColor,
            linewidth: 3,
            resolution: new THREE.Vector2(getViewportWidth(), getViewportHeight()),
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4
        });
        
        const line = new Line2(lineGeometry, lineMaterial);
        state.annotationObjects.add(line);
        m.line = line;
        
        // Re-create label at appropriate position
        const numSegments = m.segments || (m.points.length - 1);
        const midIndex = Math.floor(m.points.length / 2);
        let labelPosition;
        
        if (m.points.length === 2) {
            // Two points: midpoint between them
            labelPosition = new THREE.Vector3(
                (m.points[0].x + m.points[1].x) / 2,
                (m.points[0].y + m.points[1].y) / 2,
                (m.points[0].z + m.points[1].z) / 2
            );
        } else {
            // Multi-point: use middle point or midpoint between two middle points
            if (m.points.length % 2 === 1) {
                const mp = m.points[midIndex];
                labelPosition = new THREE.Vector3(mp.x, mp.y, mp.z);
            } else {
                const p1 = m.points[midIndex - 1];
                const p2 = m.points[midIndex];
                labelPosition = new THREE.Vector3(
                    (p1.x + p2.x) / 2,
                    (p1.y + p2.y) / 2,
                    (p1.z + p2.z) / 2
                );
            }
        }
        
        // Create label text
        const unit = state.measurementUnit || 'units';
        let labelText;
        if (numSegments > 1) {
            labelText = `${m.distance.toFixed(3)} ${unit} (${numSegments} seg)`;
        } else {
            labelText = `${m.distance.toFixed(3)} ${unit}`;
        }
        
        const label = createScaledTextSprite(labelText, state.measurementLineColor, labelPosition, 0.5);
        state.annotationObjects.add(label);
        m.label = label;
    });
}
