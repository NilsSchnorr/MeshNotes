// js/annotation-tools/editing.js
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { state, dom } from '../state.js';
import { showStatus } from '../utils/helpers.js';
import { getIntersection, getIntersectionFull, createScaledTextSprite } from '../core/scene.js';
import { projectEdgeToSurface, isProjectionAcceptable, computeProjectedEdges, recomputeAdjacentEdges } from './projection.js';
import { renderAnnotations } from './render.js';
import { updateGroupsList } from './groups.js';

// ============ Surface Painting Optimization Constants ============
// Encode meshIndex + faceIndex as a single number to avoid string allocation.
// Supports up to 10M faces per mesh, which exceeds any browser-renderable model.
const FACE_ID_MULTIPLIER = 10_000_000;
const INITIAL_HIGHLIGHT_CAPACITY = 10000; // faces

// Reusable objects to avoid per-frame allocation during painting and highlight updates.
// Safe because painting and highlight never run concurrently (single-threaded JS).
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _paintInvMatrix = new THREE.Matrix4();
const _paintLocalCenter = new THREE.Vector3();
const _paintScale = new THREE.Vector3();
const _paintDecompPos = new THREE.Vector3();
const _paintDecompQuat = new THREE.Quaternion();
const _paintClosestPoint = new THREE.Vector3();
const _paintFaceCenter = new THREE.Vector3();

// Module-level reference to the highlight buffer (avoids deep property access)
let _highlightBuffer = null;
let _highlightBufferCapacity = 0; // in floats
let _highlightMaterial = null;

// ============ Paint Loop (rAF-gated) ============
// Instead of running raycast + shapecast on every mousemove (60-120+ Hz),
// we store the latest mouse position and process it once per animation frame.
// This ensures we never do more computation than the screen can display.
const _paintRaycaster = new THREE.Raycaster();
const _paintMouse = new THREE.Vector2();
let _paintLoopRAF = null;
let _pendingPaintX = 0;
let _pendingPaintY = 0;
let _pendingPaintShift = false;
let _hasPendingPaint = false;
let _cachedCanvasRect = null;

// Fast raycast for painting: reuses raycaster, mouse vector, and cached canvas rect.
// Returns {point, faceIndex, mesh} or null.
function _paintRaycast(clientX, clientY) {
    if (!state.currentModel || !_cachedCanvasRect) return null;
    _paintMouse.x = ((clientX - _cachedCanvasRect.left) / _cachedCanvasRect.width) * 2 - 1;
    _paintMouse.y = -((clientY - _cachedCanvasRect.top) / _cachedCanvasRect.height) * 2 + 1;
    _paintRaycaster.setFromCamera(_paintMouse, state.camera);
    const intersects = _paintRaycaster.intersectObjects(state.modelMeshes, false);
    if (intersects.length > 0) {
        return {
            point: intersects[0].point, // no .clone() — paintAtPoint only reads it
            faceIndex: intersects[0].faceIndex,
            mesh: intersects[0].object
        };
    }
    return null;
}

// One tick of the paint loop: process the latest mouse position.
// The loop keeps running for the entire duration of a paint stroke (mousedown to mouseup).
// If no new mouse position has arrived since last frame, it's a no-op.
function _paintLoopTick() {
    _paintLoopRAF = null;
    if (!state.isPaintingSurface) return;

    // Process pending paint data if any
    if (_hasPendingPaint) {
        _hasPendingPaint = false;

        state.isErasingMode = _pendingPaintShift;
        const hitInfo = _paintRaycast(_pendingPaintX, _pendingPaintY);
        if (hitInfo) {
            paintAtPoint(hitInfo.point, hitInfo.mesh, hitInfo.faceIndex);
            // scheduleSurfaceHighlight() is called inside paintAtPoint,
            // but it schedules its own rAF which won't fire until next frame.
            // Force the highlight update now so paint + display happen in the same frame.
            if (state.surfaceHighlightDirty) {
                state.surfaceHighlightDirty = false;
                if (state.surfaceHighlightRAF) {
                    cancelAnimationFrame(state.surfaceHighlightRAF);
                    state.surfaceHighlightRAF = null;
                }
                updateSurfaceHighlight();
            }
        }
    }

    // Keep the loop alive while the mouse button is held
    _paintLoopRAF = requestAnimationFrame(_paintLoopTick);
}

function _startPaintLoop() {
    _cachedCanvasRect = dom.canvas.getBoundingClientRect();
    if (!_paintLoopRAF) {
        _paintLoopRAF = requestAnimationFrame(_paintLoopTick);
    }
}

function _stopPaintLoop() {
    if (_paintLoopRAF) {
        cancelAnimationFrame(_paintLoopRAF);
        _paintLoopRAF = null;
    }
    _hasPendingPaint = false;
    _cachedCanvasRect = null;
}

// Late-bound references (set from main.js to avoid circular deps)
let _openAnnotationPopup = null;
let _openAnnotationPopupForEdit = null;
let _finishSurfacePainting = null;
let _setTool = null;

export function setEditingCallbacks({ openAnnotationPopup, openAnnotationPopupForEdit, finishSurfacePainting, setTool }) {
    _openAnnotationPopup = openAnnotationPopup;
    _openAnnotationPopupForEdit = openAnnotationPopupForEdit;
    _finishSurfacePainting = finishSurfacePainting;
    _setTool = setTool;
}

export function getIntersectionWithFace(event) {
    if (!state.currentModel) return null;

    const rect = dom.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, state.camera);
    const intersects = raycaster.intersectObjects(state.modelMeshes, false);

    if (intersects.length > 0) {
        return {
            point: intersects[0].point.clone(),
            faceIndex: intersects[0].faceIndex,
            mesh: intersects[0].object
        };
    }
    return null;
}

export function paintAtPoint(point, mesh, faceIndex) {
    if (!mesh || !mesh.geometry) return;

    const brushRadius = (state.surfaceBrushSize / 100) * state.modelBoundingSize;
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const meshIndex = state.modelMeshes.indexOf(mesh);

    if (geometry.boundsTree) {
        _paintInvMatrix.copy(mesh.matrixWorld).invert();
        _paintLocalCenter.copy(point).applyMatrix4(_paintInvMatrix);

        mesh.matrixWorld.decompose(_paintDecompPos, _paintDecompQuat, _paintScale);
        const avgScale = (_paintScale.x + _paintScale.y + _paintScale.z) / 3;
        const localRadius = brushRadius / avgScale;

        const localRadiusSq = localRadius * localRadius;

        geometry.boundsTree.shapecast({
            intersectsBounds: (box) => {
                box.clampPoint(_paintLocalCenter, _paintClosestPoint);
                return _paintClosestPoint.distanceToSquared(_paintLocalCenter) <= localRadiusSq;
            },
            intersectsTriangle: (triangle, triIndex) => {
                _paintFaceCenter.x = (triangle.a.x + triangle.b.x + triangle.c.x) / 3;
                _paintFaceCenter.y = (triangle.a.y + triangle.b.y + triangle.c.y) / 3;
                _paintFaceCenter.z = (triangle.a.z + triangle.b.z + triangle.c.z) / 3;

                if (_paintFaceCenter.distanceToSquared(_paintLocalCenter) <= localRadiusSq) {
                    const faceId = meshIndex * FACE_ID_MULTIPLIER + triIndex;
                    if (state.isErasingMode) {
                        if (state.paintedFaces.has(faceId)) {
                            state.paintedFaces.delete(faceId);
                            state.needsFullHighlightRebuild = true;
                        }
                    } else {
                        if (!state.paintedFaces.has(faceId)) {
                            state.paintedFaces.add(faceId);
                            state.pendingFaces.push(faceId);
                        }
                    }
                }
                return false;
            }
        });
    } else {
        // Fallback for meshes without BVH (rare, but defensive)
        const faceCount = geometry.index
            ? geometry.index.count / 3
            : position.count / 3;

        for (let i = 0; i < faceCount; i++) {
            let a, b, c;
            if (geometry.index) {
                a = geometry.index.getX(i * 3);
                b = geometry.index.getX(i * 3 + 1);
                c = geometry.index.getX(i * 3 + 2);
            } else {
                a = i * 3;
                b = i * 3 + 1;
                c = i * 3 + 2;
            }

            const vA = new THREE.Vector3().fromBufferAttribute(position, a);
            const vB = new THREE.Vector3().fromBufferAttribute(position, b);
            const vC = new THREE.Vector3().fromBufferAttribute(position, c);
            vA.applyMatrix4(mesh.matrixWorld);
            vB.applyMatrix4(mesh.matrixWorld);
            vC.applyMatrix4(mesh.matrixWorld);

            const faceCenter = new THREE.Vector3()
                .addVectors(vA, vB)
                .add(vC)
                .divideScalar(3);

            if (faceCenter.distanceTo(point) <= brushRadius) {
                const faceId = meshIndex * FACE_ID_MULTIPLIER + i;
                if (state.isErasingMode) {
                    if (state.paintedFaces.has(faceId)) {
                        state.paintedFaces.delete(faceId);
                        state.needsFullHighlightRebuild = true;
                    }
                } else {
                    if (!state.paintedFaces.has(faceId)) {
                        state.paintedFaces.add(faceId);
                        state.pendingFaces.push(faceId);
                    }
                }
            }
        }
    }

    scheduleSurfaceHighlight();
}

export function scheduleSurfaceHighlight() {
    state.surfaceHighlightDirty = true;
    if (!state.surfaceHighlightRAF) {
        state.surfaceHighlightRAF = requestAnimationFrame(() => {
            state.surfaceHighlightRAF = null;
            if (state.surfaceHighlightDirty) {
                state.surfaceHighlightDirty = false;
                updateSurfaceHighlight();
            }
        });
    }
}

// Write a single face's world-space vertices into the highlight buffer at the given offset.
// Uses reusable _vA/_vB/_vC to avoid allocation.
function writeFaceToBuffer(faceId, floatOffset) {
    const meshIdx = Math.floor(faceId / FACE_ID_MULTIPLIER);
    const faceIdx = faceId % FACE_ID_MULTIPLIER;
    const mesh = state.modelMeshes[meshIdx];
    if (!mesh) return false;

    const geometry = mesh.geometry;
    const position = geometry.attributes.position;

    let a, b, c;
    if (geometry.index) {
        a = geometry.index.getX(faceIdx * 3);
        b = geometry.index.getX(faceIdx * 3 + 1);
        c = geometry.index.getX(faceIdx * 3 + 2);
    } else {
        a = faceIdx * 3;
        b = faceIdx * 3 + 1;
        c = faceIdx * 3 + 2;
    }

    _vA.fromBufferAttribute(position, a).applyMatrix4(mesh.matrixWorld);
    _vB.fromBufferAttribute(position, b).applyMatrix4(mesh.matrixWorld);
    _vC.fromBufferAttribute(position, c).applyMatrix4(mesh.matrixWorld);

    _highlightBuffer[floatOffset]     = _vA.x;
    _highlightBuffer[floatOffset + 1] = _vA.y;
    _highlightBuffer[floatOffset + 2] = _vA.z;
    _highlightBuffer[floatOffset + 3] = _vB.x;
    _highlightBuffer[floatOffset + 4] = _vB.y;
    _highlightBuffer[floatOffset + 5] = _vB.z;
    _highlightBuffer[floatOffset + 6] = _vC.x;
    _highlightBuffer[floatOffset + 7] = _vC.y;
    _highlightBuffer[floatOffset + 8] = _vC.z;

    return true;
}

// Ensure the highlight buffer has capacity for the given number of faces.
// Grows by doubling if needed, preserving existing data.
function ensureHighlightCapacity(neededFaces) {
    const neededFloats = neededFaces * 9; // 3 vertices × 3 components
    if (_highlightBuffer && _highlightBufferCapacity >= neededFloats) return;

    const newCapacity = Math.max(
        neededFloats,
        (_highlightBufferCapacity || INITIAL_HIGHLIGHT_CAPACITY * 9) * 2
    );
    const newBuffer = new Float32Array(newCapacity);

    // Copy existing data if we're growing
    if (_highlightBuffer && state.highlightVertexCount > 0) {
        newBuffer.set(_highlightBuffer.subarray(0, state.highlightVertexCount * 3));
    }

    _highlightBuffer = newBuffer;
    _highlightBufferCapacity = newCapacity;

    // Update the geometry's buffer attribute to point to the new array
    if (state.surfaceHighlightMesh) {
        const attr = new THREE.BufferAttribute(_highlightBuffer, 3);
        attr.setUsage(THREE.DynamicDrawUsage);
        state.surfaceHighlightMesh.geometry.setAttribute('position', attr);
    }
}

// Create or ensure the highlight mesh, material, and geometry exist.
function ensureHighlightMesh() {
    if (state.surfaceHighlightMesh) return;

    const initialFloats = INITIAL_HIGHLIGHT_CAPACITY * 9;
    _highlightBuffer = new Float32Array(initialFloats);
    _highlightBufferCapacity = initialFloats;
    state.highlightVertexCount = 0;

    const geometry = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(_highlightBuffer, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attr);
    geometry.setDrawRange(0, 0);

    const color = state.groups.length > 0 ? state.groups[0].color : '#EDC040';

    _highlightMaterial = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
    });

    state.surfaceHighlightMesh = new THREE.Mesh(geometry, _highlightMaterial);
    state.surfaceHighlightMesh.renderOrder = 999;
    state.surfaceHighlightMesh.frustumCulled = false;
    state.annotationObjects.add(state.surfaceHighlightMesh);
}

// Full rebuild: write ALL painted faces into the buffer from scratch.
// Used after erasing or when the buffer needs compacting.
function rebuildHighlightFull() {
    ensureHighlightCapacity(state.paintedFaces.size);
    state.highlightVertexCount = 0;

    let floatOffset = 0;
    state.paintedFaces.forEach(faceId => {
        if (writeFaceToBuffer(faceId, floatOffset)) {
            floatOffset += 9;
            state.highlightVertexCount += 3;
        }
    });

    // Full re-upload to GPU (clear any partial update ranges first)
    const posAttr = state.surfaceHighlightMesh.geometry.attributes.position;
    posAttr.clearUpdateRanges();
    posAttr.needsUpdate = true;
    state.surfaceHighlightMesh.geometry.setDrawRange(0, state.highlightVertexCount);
    // Note: no computeVertexNormals() — highlight uses MeshBasicMaterial (unlit),
    // so normals are never read. Skipping saves O(vertexCount) per update.
}

// Incremental append: only write newly added faces to the end of the buffer.
// Uses addUpdateRange() to upload only the new data to the GPU.
function appendPendingFaces() {
    if (state.pendingFaces.length === 0) return;

    const totalNeeded = state.paintedFaces.size;
    ensureHighlightCapacity(totalNeeded);

    const startFloat = state.highlightVertexCount * 3;
    let floatOffset = startFloat;
    for (let i = 0; i < state.pendingFaces.length; i++) {
        if (writeFaceToBuffer(state.pendingFaces[i], floatOffset)) {
            floatOffset += 9;
            state.highlightVertexCount += 3;
        }
    }

    // Partial GPU upload: only transfer the newly appended region
    const newFloats = floatOffset - startFloat;
    const posAttr = state.surfaceHighlightMesh.geometry.attributes.position;
    posAttr.clearUpdateRanges();
    posAttr.addUpdateRange(startFloat, newFloats);
    posAttr.needsUpdate = true;
    state.surfaceHighlightMesh.geometry.setDrawRange(0, state.highlightVertexCount);
}

export function updateSurfaceHighlight() {
    // Nothing to display: hide mesh if it exists
    if (state.paintedFaces.size === 0) {
        if (state.surfaceHighlightMesh) {
            state.surfaceHighlightMesh.geometry.setDrawRange(0, 0);
            state.highlightVertexCount = 0;
        }
        state.pendingFaces = [];
        state.needsFullHighlightRebuild = false;
        return;
    }

    // Ensure the mesh/buffer infrastructure exists
    ensureHighlightMesh();

    // Update material color to match current first group
    const color = state.groups.length > 0 ? state.groups[0].color : '#EDC040';
    if (_highlightMaterial) {
        _highlightMaterial.color.set(color);
    }

    // Choose update strategy: full rebuild (after erase) or incremental append
    if (state.needsFullHighlightRebuild) {
        rebuildHighlightFull();
        state.needsFullHighlightRebuild = false;
        state.pendingFaces = [];
    } else if (state.pendingFaces.length > 0) {
        appendPendingFaces();
        state.pendingFaces = [];
    }
}

export function finishSurfacePainting(event) {
    if (state.paintedFaces.size === 0) {
        showStatus('No surface painted');
        clearTempSurface();
        return;
    }

    const center = new THREE.Vector3();
    let count = 0;

    // Compute center using reusable vectors
    state.paintedFaces.forEach(faceId => {
        const meshIdx = Math.floor(faceId / FACE_ID_MULTIPLIER);
        const faceIdx = faceId % FACE_ID_MULTIPLIER;
        const mesh = state.modelMeshes[meshIdx];
        if (!mesh) return;

        const geometry = mesh.geometry;
        const position = geometry.attributes.position;

        let a, b, c;
        if (geometry.index) {
            a = geometry.index.getX(faceIdx * 3);
            b = geometry.index.getX(faceIdx * 3 + 1);
            c = geometry.index.getX(faceIdx * 3 + 2);
        } else {
            a = faceIdx * 3;
            b = faceIdx * 3 + 1;
            c = faceIdx * 3 + 2;
        }

        _vA.fromBufferAttribute(position, a).applyMatrix4(mesh.matrixWorld);
        _vB.fromBufferAttribute(position, b).applyMatrix4(mesh.matrixWorld);
        _vC.fromBufferAttribute(position, c).applyMatrix4(mesh.matrixWorld);

        // Compute face center without allocating a new Vector3
        center.x += (_vA.x + _vB.x + _vC.x) / 3;
        center.y += (_vA.y + _vB.y + _vC.y) / 3;
        center.z += (_vA.z + _vB.z + _vC.z) / 3;
        count++;
    });

    center.divideScalar(count);

    // Convert numeric face IDs back to string format for annotation storage.
    // This preserves backward compatibility with existing JSON exports.
    const faceData = Array.from(state.paintedFaces).map(id => {
        const meshIdx = Math.floor(id / FACE_ID_MULTIPLIER);
        const faceIdx = id % FACE_ID_MULTIPLIER;
        return `${meshIdx}_${faceIdx}`;
    });

    _openAnnotationPopup(event, 'surface', [center], faceData);

    // Clean up highlight mesh and module-level buffer references
    if (state.surfaceHighlightMesh) {
        state.annotationObjects.remove(state.surfaceHighlightMesh);
        state.surfaceHighlightMesh.geometry.dispose();
        if (_highlightMaterial) {
            _highlightMaterial.dispose();
            _highlightMaterial = null;
        }
        state.surfaceHighlightMesh = null;
    }
    _highlightBuffer = null;
    _highlightBufferCapacity = 0;
    state.highlightVertexCount = 0;
    state.paintedFaces.clear();
    state.pendingFaces = [];
    state.needsFullHighlightRebuild = false;
    state.isPaintingSurface = false;
    _stopPaintLoop();
}

export function clearTempSurface() {
    state.paintedFaces.clear();
    state.pendingFaces = [];
    state.needsFullHighlightRebuild = false;
    state.highlightVertexCount = 0;
    state.isPaintingSurface = false;
    state.surfaceHighlightDirty = false;
    _stopPaintLoop();
    if (state.surfaceHighlightRAF) {
        cancelAnimationFrame(state.surfaceHighlightRAF);
        state.surfaceHighlightRAF = null;
    }
    if (state.surfaceHighlightMesh) {
        state.annotationObjects.remove(state.surfaceHighlightMesh);
        state.surfaceHighlightMesh.geometry.dispose();
        if (_highlightMaterial) {
            _highlightMaterial.dispose();
            _highlightMaterial = null;
        }
        state.surfaceHighlightMesh = null;
    }
    _highlightBuffer = null;
    _highlightBufferCapacity = 0;
}

/**
 * Undo the last point placed during line or polygon drawing.
 * Removes the last point and its corresponding projected edge, then updates the visual.
 * @returns {boolean} True if a point was removed, false if no points to undo.
 */
export function undoLastPoint() {
    if (state.tempPoints.length === 0) {
        return false;
    }
    
    // Remove the last point
    state.tempPoints.pop();
    
    // Remove the last projected edge if it exists
    // Note: tempProjectedEdges[i] corresponds to the edge from tempPoints[i] to tempPoints[i+1]
    // So when we remove the last point, we should remove the edge that ended at that point
    if (state.tempProjectedEdges.length > 0 && state.tempProjectedEdges.length >= state.tempPoints.length) {
        state.tempProjectedEdges.pop();
    }
    
    // Update the visual representation
    updateTempLine();
    
    // Provide feedback
    const remaining = state.tempPoints.length;
    if (remaining === 0) {
        showStatus('All points removed. Click to start again.');
    } else {
        showStatus(`Point removed. ${remaining} point${remaining !== 1 ? 's' : ''} remaining.`);
    }
    
    return true;
}

export function clearTempDrawing() {
    state.tempPoints = [];
    state.tempProjectedEdges = [];
    if (state.tempLine) {
        if (state.tempLine.geometry) state.tempLine.geometry.dispose();
        if (state.tempLine.material) state.tempLine.material.dispose();
        state.annotationObjects.remove(state.tempLine);
        state.tempLine = null;
    }
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
    clearTempSurface();
}

export function updateTempLine() {
    if (state.tempLine) {
        state.annotationObjects.remove(state.tempLine);
    }

    if (state.tempPoints.length < 2) return;

    const positions = [];

    if (state.surfaceProjectionEnabled && state.modelMeshes.length > 0) {
        for (let i = 0; i < state.tempPoints.length - 1; i++) {
            let edgePoints;
            if (i < state.tempProjectedEdges.length && state.tempProjectedEdges[i]) {
                edgePoints = state.tempProjectedEdges[i];
            } else {
                const projected = projectEdgeToSurface(state.tempPoints[i], state.tempPoints[i + 1], 20);
                const straightFallback = [
                    { x: state.tempPoints[i].x, y: state.tempPoints[i].y, z: state.tempPoints[i].z },
                    { x: state.tempPoints[i + 1].x, y: state.tempPoints[i + 1].y, z: state.tempPoints[i + 1].z }
                ];
                if (projected && isProjectionAcceptable(projected, state.tempPoints[i], state.tempPoints[i + 1])) {
                    edgePoints = projected;
                } else {
                    edgePoints = straightFallback;
                }
                if (i < state.tempPoints.length - 2) {
                    state.tempProjectedEdges[i] = edgePoints;
                }
            }
            const startIdx = (i === 0) ? 0 : 1;
            for (let j = startIdx; j < edgePoints.length; j++) {
                positions.push(edgePoints[j].x, edgePoints[j].y, edgePoints[j].z);
            }
        }
    } else {
        state.tempPoints.forEach(p => positions.push(p.x, p.y, p.z));
    }

    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    const material = new LineMaterial({
        color: 0xEDC040,
        linewidth: 3,
        resolution: new THREE.Vector2(window.innerWidth - 320, window.innerHeight - 50),
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
    });

    state.tempLine = new Line2(geometry, material);
    state.annotationObjects.add(state.tempLine);
}

export function onCanvasClick(event) {
    if (state.wasDragging) {
        state.wasDragging = false;
        return;
    }

    if (!state.currentTool || !state.currentModel) return;

    const point = getIntersection(event);
    if (!point) return;

    if (state.currentTool === 'point') {
        const pointToUse = state.pendingPointPosition || point;
        state.pendingPointPosition = null;
        if (!pointToUse) return;
        _openAnnotationPopup(event, 'point', [pointToUse]);
        _setTool(null);
    } else if (state.currentTool === 'line') {
        state.tempPoints.push(point);
        updateTempLine();
    } else if (state.currentTool === 'polygon') {
        state.tempPoints.push(point);
        updateTempLine();
    } else if (state.currentTool === 'measure') {
        const isCtrlHeld = event.ctrlKey || event.metaKey;
        
        // Multi-point measurement logic:
        // - Ctrl+click: add point and continue (multi-point mode)
        // - Click without Ctrl when 2+ points exist: finalize measurement
        // - Click without Ctrl when 0-1 points: normal add point behavior
        
        if (state.measurePoints.length >= 2 && !isCtrlHeld && !state.isMultiPointMeasure) {
            // Normal two-point measurement completed on second click
            state.measurePoints.push(point);
            addMeasureMarker(point);
            finalizeMeasurement();
        } else if (state.measurePoints.length >= 2 && !isCtrlHeld && state.isMultiPointMeasure) {
            // Finalizing multi-point measurement (Ctrl released)
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
    } else if (state.currentTool === 'surface') {
        state.isErasingMode = event.shiftKey;
        const hitInfo = getIntersectionWithFace(event);
        if (hitInfo) {
            paintAtPoint(hitInfo.point, hitInfo.mesh, hitInfo.faceIndex);
        }
    } else if (state.currentTool === 'box') {
        const defaultSize = state.modelBoundingSize * 0.15;
        const boxData = {
            center: { x: point.x, y: point.y, z: point.z },
            size: { x: defaultSize, y: defaultSize, z: defaultSize },
            rotation: { x: 0, y: 0, z: 0 }
        };
        _openAnnotationPopup(event, 'box', [point], boxData);
        _setTool(null);
    }
}

export function onCanvasDblClick(event) {
    if (!state.currentModel) return;

    if (state.currentTool === 'line' && state.tempPoints.length >= 2) {
        _openAnnotationPopup(event, 'line', [...state.tempPoints]);
        _setTool(null);
    } else if (state.currentTool === 'polygon' && state.tempPoints.length >= 3) {
        _openAnnotationPopup(event, 'polygon', [...state.tempPoints]);
        _setTool(null);
    } else if (state.currentTool === 'surface' && state.paintedFaces.size > 0) {
        finishSurfacePainting(event);
        _setTool(null);
    }
}

export function onCanvasMouseDown(event) {
    if (state.currentTool === 'point' && state.currentModel && event.button === 0) {
        state.pendingPointPosition = getIntersection(event);
        return;
    }

    if (state.currentTool === 'surface' && state.currentModel && event.button === 0) {
        state.isPaintingSurface = true;
        state.controls.enabled = false;

        // Store the initial paint position and start the rAF-gated paint loop.
        // This ensures the first click paints immediately on the next frame,
        // and subsequent mousemoves are coalesced to one paint per frame.
        _pendingPaintX = event.clientX;
        _pendingPaintY = event.clientY;
        _pendingPaintShift = event.shiftKey;
        _hasPendingPaint = true;
        _startPaintLoop();
        return;
    }

    if (!state.currentModel || state.currentTool) return;

    const rect = dom.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, state.camera);

    const markerObjects = state.annotationObjects.children.filter(obj =>
        obj.userData.isAnnotationMarker && obj.isMesh
    );

    const intersects = raycaster.intersectObjects(markerObjects);

    if (intersects.length > 0) {
        const marker = intersects[0].object;
        const annId = marker.userData.annotationId;
        const pointIndex = marker.userData.pointIndex;

        if (marker.userData.isBoxHandle) {
            const ann = state.annotations.find(a => a.id === annId);
            if (ann && ann.type === 'box') {
                state.selectedBoxAnnotation = ann;
                state.isManipulatingBox = true;
                state.boxManipulationMode = 'resize';
                state.activeBoxHandle = marker.userData.handleIndex;
                state.boxDragStartMouse = { x: event.clientX, y: event.clientY };
                state.boxDragStartData = JSON.parse(JSON.stringify(ann.boxData));
                state.controls.enabled = false;
                dom.canvas.style.cursor = 'nwse-resize';
                return;
            }
        }

        state.draggedAnnotation = state.annotations.find(a => a.id === annId);
        if (state.draggedAnnotation) {
            state.isDraggingPoint = true;
            state.draggedPointIndex = pointIndex;
            state.draggedMarker = marker;
            state.controls.enabled = false;
            dom.canvas.style.cursor = 'grabbing';
        }
    }

    if (!state.isDraggingPoint && !state.isManipulatingBox) {
        const boxObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isBoxBody && obj.isMesh
        );
        const boxIntersects = raycaster.intersectObjects(boxObjects);

        if (boxIntersects.length > 0) {
            const boxMesh = boxIntersects[0].object;
            const annId = boxMesh.userData.annotationId;
            const ann = state.annotations.find(a => a.id === annId);

            if (ann && ann.type === 'box') {
                state.selectedBoxAnnotation = ann;
                state.isManipulatingBox = true;
                state.boxDragStartMouse = { x: event.clientX, y: event.clientY };
                state.boxDragStartData = JSON.parse(JSON.stringify(ann.boxData));
                state.controls.enabled = false;

                if (event.button === 2) {
                    state.boxManipulationMode = 'rotate';
                    dom.canvas.style.cursor = 'ew-resize';
                } else {
                    state.boxManipulationMode = 'move';
                    dom.canvas.style.cursor = 'move';
                }
            }
        }
    }
}

export function onCanvasMouseMove(event) {
    const rect = dom.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    if (state.isPaintingSurface && state.currentTool === 'surface' && state.currentModel) {
        // Just store the latest position — the rAF paint loop will process it.
        // This coalesces multiple mousemove events into one paint per frame.
        _pendingPaintX = event.clientX;
        _pendingPaintY = event.clientY;
        _pendingPaintShift = event.shiftKey;
        _hasPendingPaint = true;
        return;
    }

    if (state.isDraggingPoint && state.draggedMarker && state.currentModel) {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        const intersects = raycaster.intersectObject(state.currentModel, true);

        if (intersects.length > 0) {
            const newPos = intersects[0].point;
            state.draggedMarker.position.copy(newPos);

            if (state.draggedAnnotation && state.draggedPointIndex >= 0) {
                state.draggedAnnotation.points[state.draggedPointIndex] = {
                    x: newPos.x,
                    y: newPos.y,
                    z: newPos.z
                };

                if (state.draggedAnnotation.projectedEdges && state.draggedAnnotation.surfaceProjection) {
                    recomputeAdjacentEdges(state.draggedAnnotation, state.draggedPointIndex);
                }

                renderAnnotations();

                const markers = state.annotationObjects.children.filter(obj =>
                    obj.userData.isAnnotationMarker &&
                    obj.userData.annotationId === state.draggedAnnotation.id &&
                    obj.userData.pointIndex === state.draggedPointIndex
                );
                if (markers.length > 0) {
                    state.draggedMarker = markers[0];
                }
            }
        }
        return;
    }

    if (state.isManipulatingBox && state.selectedBoxAnnotation && state.boxDragStartData) {
        const deltaX = event.clientX - state.boxDragStartMouse.x;
        const deltaY = event.clientY - state.boxDragStartMouse.y;

        if (state.boxManipulationMode === 'move') {
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, state.camera);

            const startCenter = new THREE.Vector3(
                state.boxDragStartData.center.x,
                state.boxDragStartData.center.y,
                state.boxDragStartData.center.z
            );
            const cameraDir = new THREE.Vector3();
            state.camera.getWorldDirection(cameraDir);
            const movePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, startCenter);

            const intersection = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(movePlane, intersection)) {
                state.selectedBoxAnnotation.boxData.center = {
                    x: intersection.x,
                    y: intersection.y,
                    z: intersection.z
                };
                state.selectedBoxAnnotation.points[0] = { ...state.selectedBoxAnnotation.boxData.center };
                renderAnnotations();
            }
        } else if (state.boxManipulationMode === 'resize') {
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, state.camera);

            const corners = [
                [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
                [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
                [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5],
                [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]
            ];

            const draggedCornerFactors = corners[state.activeBoxHandle];
            const oppositeIndex = 7 - state.activeBoxHandle;
            const oppositeCornerFactors = corners[oppositeIndex];

            const startCenter = new THREE.Vector3(
                state.boxDragStartData.center.x,
                state.boxDragStartData.center.y,
                state.boxDragStartData.center.z
            );
            const startSize = state.boxDragStartData.size;
            const startRotation = state.boxDragStartData.rotation || { x: 0, y: 0, z: 0 };
            const euler = new THREE.Euler(startRotation.x, startRotation.y, startRotation.z);

            const oppositeCornerLocal = new THREE.Vector3(
                oppositeCornerFactors[0] * startSize.x,
                oppositeCornerFactors[1] * startSize.y,
                oppositeCornerFactors[2] * startSize.z
            );
            oppositeCornerLocal.applyEuler(euler);
            const fixedCorner = oppositeCornerLocal.add(startCenter);

            const draggedCornerLocal = new THREE.Vector3(
                draggedCornerFactors[0] * startSize.x,
                draggedCornerFactors[1] * startSize.y,
                draggedCornerFactors[2] * startSize.z
            );
            draggedCornerLocal.applyEuler(euler);
            const draggedCornerWorld = draggedCornerLocal.clone().add(startCenter);

            const cameraDir = new THREE.Vector3();
            state.camera.getWorldDirection(cameraDir);
            const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, draggedCornerWorld);

            const newCornerPos = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(dragPlane, newCornerPos)) {
                const newCenter = new THREE.Vector3().addVectors(fixedCorner, newCornerPos).multiplyScalar(0.5);

                const diagonal = new THREE.Vector3().subVectors(newCornerPos, fixedCorner);
                const inverseEuler = new THREE.Euler(-startRotation.x, -startRotation.y, -startRotation.z, 'ZYX');
                diagonal.applyEuler(inverseEuler);

                const newSize = {
                    x: Math.max(0.01, Math.abs(diagonal.x)),
                    y: Math.max(0.01, Math.abs(diagonal.y)),
                    z: Math.max(0.01, Math.abs(diagonal.z))
                };

                state.selectedBoxAnnotation.boxData.center = {
                    x: newCenter.x,
                    y: newCenter.y,
                    z: newCenter.z
                };
                state.selectedBoxAnnotation.boxData.size = newSize;
                state.selectedBoxAnnotation.points[0] = { ...state.selectedBoxAnnotation.boxData.center };
                renderAnnotations();
            }
        } else if (state.boxManipulationMode === 'rotate') {
            const rotationSpeed = 0.01;
            let rotX = (state.boxDragStartData.rotation?.x || 0) + deltaY * rotationSpeed;
            let rotY = (state.boxDragStartData.rotation?.y || 0) + deltaX * rotationSpeed;
            let rotZ = state.boxDragStartData.rotation?.z || 0;

            if (event.shiftKey) {
                const snapAngle = Math.PI / 12;
                rotX = Math.round(rotX / snapAngle) * snapAngle;
                rotY = Math.round(rotY / snapAngle) * snapAngle;
            }

            state.selectedBoxAnnotation.boxData.rotation = {
                x: rotX,
                y: rotY,
                z: rotZ
            };
            renderAnnotations();
        }
        return;
    }

    if (!state.currentTool && state.currentModel) {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        const markerObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isAnnotationMarker && obj.isMesh
        );

        const markerIntersects = raycaster.intersectObjects(markerObjects);

        if (markerIntersects.length > 0) {
            const hitMarker = markerIntersects[0].object;
            if (hitMarker.userData.isBoxHandle) {
                dom.canvas.style.cursor = 'nwse-resize';
            } else {
                dom.canvas.style.cursor = 'grab';
            }
            return;
        }

        const boxObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isBoxBody && obj.isMesh
        );
        const boxIntersects = raycaster.intersectObjects(boxObjects);

        if (boxIntersects.length > 0) {
            dom.canvas.style.cursor = 'move';
        } else {
            dom.canvas.style.cursor = 'default';
        }
    }
}

export function onCanvasMouseUp(event) {
    if (state.isPaintingSurface) {
        state.isPaintingSurface = false;
        state.controls.enabled = true;
        _stopPaintLoop();
    }

    if (state.isDraggingPoint) {
        state.wasDragging = true;

        if (state.draggedAnnotation && state.draggedAnnotation.surfaceProjection &&
            (state.draggedAnnotation.type === 'line' || state.draggedAnnotation.type === 'polygon')) {
            state.draggedAnnotation.projectedEdges = computeProjectedEdges(
                state.draggedAnnotation.points,
                state.draggedAnnotation.type === 'polygon'
            );
        }

        state.isDraggingPoint = false;
        state.draggedAnnotation = null;
        state.draggedPointIndex = -1;
        state.draggedMarker = null;
        state.controls.enabled = true;
        dom.canvas.style.cursor = 'default';

        renderAnnotations();
        updateGroupsList();
        showStatus('Point moved');
    }

    if (state.isManipulatingBox) {
        state.wasDragging = true;

        const statusMsg = state.boxManipulationMode === 'move' ? 'Box moved' :
                          state.boxManipulationMode === 'resize' ? 'Box resized' :
                          state.boxManipulationMode === 'rotate' ? 'Box rotated' : 'Box updated';

        state.isManipulatingBox = false;
        state.selectedBoxAnnotation = null;
        state.boxManipulationMode = null;
        state.boxDragStartMouse = null;
        state.boxDragStartData = null;
        state.activeBoxHandle = null;
        state.controls.enabled = true;
        dom.canvas.style.cursor = 'default';

        renderAnnotations();
        updateGroupsList();
        showStatus(statusMsg);
    }
}

function addMeasureMarker(point) {
    const geometry = new THREE.SphereGeometry(0.01, 16, 16);
    const material = new THREE.MeshBasicMaterial({
        color: 0xFFFFFF,
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
 * Calculate individual segment distances for a path.
 * @param {THREE.Vector3[]} points - Array of points
 * @returns {number[]} Array of segment distances
 */
function calculateSegmentDistances(points) {
    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
        segments.push(points[i].distanceTo(points[i + 1]));
    }
    return segments;
}

/**
 * Updates the measurement line to connect all current measurement points.
 * Supports both two-point and multi-point measurements.
 */
function updateMeasureLine() {
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
        color: 0xAA8101,
        linewidth: 3,
        resolution: new THREE.Vector2(window.innerWidth - 320, window.innerHeight - 50),
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
function updateLiveMeasurementLabel() {
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
    let labelText;
    if (numSegments > 1) {
        labelText = `${totalDist.toFixed(3)} (${numSegments} seg)`;
    } else {
        labelText = `${totalDist.toFixed(3)} units`;
    }
    
    state.measureLabel = createScaledTextSprite(labelText, '#AA8101', lastPoint, 0.5);
    state.annotationObjects.add(state.measureLabel);
}

/**
 * Finalizes the current measurement, storing it and resetting state for next measurement.
 */
function finalizeMeasurement() {
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
    let labelText;
    if (numSegments > 1) {
        labelText = `${totalDist.toFixed(3)} (${numSegments} seg)`;
    } else {
        labelText = `${totalDist.toFixed(3)} units`;
    }

    const label = createScaledTextSprite(labelText, '#AA8101', labelPosition, 0.5);
    state.annotationObjects.add(label);

    // Store measurement with all points
    const measurementId = state.measurements.length + 1;
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

export function updateMeasurementsDisplay() {
    if (state.measurements.length === 0) {
        dom.measurementsList.innerHTML = '<div style="color: #888;">No measurements yet</div>';
    } else {
        dom.measurementsList.innerHTML = state.measurements.map(m => {
            const segmentBreakdown = buildSegmentBreakdown(m);
            return `
            <div class="measurement-item" data-measurement-id="${m.id}">
                <div class="measurement-main">
                    <span class="label">Distance ${m.id}:</span>
                    <span class="value" data-copy-value="${m.distance.toFixed(3)}">${m.distance.toFixed(3)} units</span>
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
                const copyValue = valueEl.dataset.copyValue + ' units';
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

export function clearAllMeasurements() {
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
                color: 0xFFFFFF,
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
            color: 0xAA8101,
            linewidth: 3,
            resolution: new THREE.Vector2(window.innerWidth - 320, window.innerHeight - 50),
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
        let labelText;
        if (numSegments > 1) {
            labelText = `${m.distance.toFixed(3)} (${numSegments} seg)`;
        } else {
            labelText = `${m.distance.toFixed(3)} units`;
        }
        
        const label = createScaledTextSprite(labelText, '#AA8101', labelPosition, 0.5);
        state.annotationObjects.add(label);
        m.label = label;
    });
}
