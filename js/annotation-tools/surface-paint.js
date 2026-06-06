// js/annotation-tools/surface-paint.js
// Surface painting tool: brush raycasting, rAF-gated paint loop, painted-face
// highlight buffer/mesh, stroke finalization, and stroke undo.
// Extracted verbatim from editing.js (Phase 2 module split) - behaviour unchanged.
import * as THREE from 'three';
import { state, dom } from '../state.js';
import { showStatus, toStorageCoords } from '../utils/helpers.js';

// Late-bound callback (forwarded from editing.js setEditingCallbacks via setSurfacePaintCallbacks).
let _openAnnotationPopup = null;
let _setTool = null;
export function setSurfacePaintCallbacks({ openAnnotationPopup, setTool }) {
    _openAnnotationPopup = openAnnotationPopup;
    _setTool = setTool;
}

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

// Reusable vectors for the brush's normal-consistency filter.
// Prevents paint from bleeding through thin walls (e.g. inside of a vase when painting outside).
const _refNormal = new THREE.Vector3();
const _candidateNormal = new THREE.Vector3();
const _normalEdge1 = new THREE.Vector3();
const _normalEdge2 = new THREE.Vector3();
const _normalTmpA = new THREE.Vector3();
const _normalTmpB = new THREE.Vector3();
const _normalTmpC = new THREE.Vector3();

/**
 * Compute the local-space normal of a face on a mesh into the target vector.
 * Returns true on success, false if the face index is invalid.
 * Works with both indexed and non-indexed geometry.
 */
function _computeLocalFaceNormal(mesh, faceIndex, target) {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const index = geometry.index;
    if (!position || faceIndex == null || faceIndex < 0) return false;

    let a, b, c;
    if (index) {
        a = index.getX(faceIndex * 3);
        b = index.getX(faceIndex * 3 + 1);
        c = index.getX(faceIndex * 3 + 2);
    } else {
        a = faceIndex * 3;
        b = faceIndex * 3 + 1;
        c = faceIndex * 3 + 2;
    }

    _normalTmpA.fromBufferAttribute(position, a);
    _normalTmpB.fromBufferAttribute(position, b);
    _normalTmpC.fromBufferAttribute(position, c);

    _normalEdge1.subVectors(_normalTmpB, _normalTmpA);
    _normalEdge2.subVectors(_normalTmpC, _normalTmpA);
    target.crossVectors(_normalEdge1, _normalEdge2).normalize();
    return target.lengthSq() > 0;
}

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

export function _startPaintLoop() {
    _cachedCanvasRect = dom.canvas.getBoundingClientRect();
    if (!_paintLoopRAF) {
        _paintLoopRAF = requestAnimationFrame(_paintLoopTick);
    }
}

export function _stopPaintLoop() {
    if (_paintLoopRAF) {
        cancelAnimationFrame(_paintLoopRAF);
        _paintLoopRAF = null;
    }
    _hasPendingPaint = false;
    _cachedCanvasRect = null;
}

// Queue the latest pointer position for the paint loop to process on the next frame.
// Called by the pointer handlers in editing.js, which no longer own these module vars.
export function queuePaintInput(clientX, clientY, shift) {
    _pendingPaintX = clientX;
    _pendingPaintY = clientY;
    _pendingPaintShift = shift;
    _hasPendingPaint = true;
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

    // Reference normal at the hit face (local space). Used to reject faces on the
    // opposite side of thin walls (e.g. the inside of a vase when painting the outside).
    // Compared against each candidate face's local normal — both are in mesh-local space,
    // so the world transform doesn't need to be applied.
    const hasRefNormal = _computeLocalFaceNormal(mesh, faceIndex, _refNormal);

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
                    // Normal-consistency filter: skip faces facing the opposite direction
                    // from the hit face. Keeps the brush on one side of thin walls.
                    if (hasRefNormal) {
                        _normalEdge1.subVectors(triangle.b, triangle.a);
                        _normalEdge2.subVectors(triangle.c, triangle.a);
                        _candidateNormal.crossVectors(_normalEdge1, _normalEdge2).normalize();
                        if (_candidateNormal.dot(_refNormal) < 0) {
                            return false;
                        }
                    }

                    const faceId = meshIndex * FACE_ID_MULTIPLIER + triIndex;
                    if (state.isErasingMode) {
                        if (state.paintedFaces.has(faceId)) {
                            state.paintedFaces.delete(faceId);
                            state.needsFullHighlightRebuild = true;
                            if (state.currentStrokeRemoved) state.currentStrokeRemoved.add(faceId);
                        }
                    } else {
                        if (!state.paintedFaces.has(faceId)) {
                            state.paintedFaces.add(faceId);
                            state.pendingFaces.push(faceId);
                            if (state.currentStrokeAdded) state.currentStrokeAdded.add(faceId);
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
                // Normal-consistency filter (same intent as the BVH path).
                // Fallback path works in world space, so compare in world space too.
                if (hasRefNormal) {
                    _normalEdge1.subVectors(vB, vA);
                    _normalEdge2.subVectors(vC, vA);
                    _candidateNormal.crossVectors(_normalEdge1, _normalEdge2).normalize();
                    // _refNormal is in local space; transform it to world via the normal matrix.
                    // Cheap to do per-face since this path is the rare no-BVH fallback.
                    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
                    const refWorld = _refNormal.clone().applyMatrix3(nm).normalize();
                    if (_candidateNormal.dot(refWorld) < 0) continue;
                }

                const faceId = meshIndex * FACE_ID_MULTIPLIER + i;
                if (state.isErasingMode) {
                    if (state.paintedFaces.has(faceId)) {
                        state.paintedFaces.delete(faceId);
                        state.needsFullHighlightRebuild = true;
                        if (state.currentStrokeRemoved) state.currentStrokeRemoved.add(faceId);
                    }
                } else {
                    if (!state.paintedFaces.has(faceId)) {
                        state.paintedFaces.add(faceId);
                        state.pendingFaces.push(faceId);
                        if (state.currentStrokeAdded) state.currentStrokeAdded.add(faceId);
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

    // Convert centroid from world space to storage (non-flipped) space
    const storageCentroid = toStorageCoords(center);
    _openAnnotationPopup(event, 'surface', [storageCentroid], faceData);

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
    state.surfaceStrokeHistory = [];
    state.currentStrokeAdded = null;
    state.currentStrokeRemoved = null;
    _stopPaintLoop();
}

export function clearTempSurface() {
    state.paintedFaces.clear();
    state.pendingFaces = [];
    state.needsFullHighlightRebuild = false;
    state.highlightVertexCount = 0;
    state.isPaintingSurface = false;
    state.surfaceHighlightDirty = false;
    state.surfaceStrokeHistory = [];
    state.currentStrokeAdded = null;
    state.currentStrokeRemoved = null;
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
 * Undo the last paint stroke during surface annotation.
 * Reverses the last stroke by removing added faces and re-adding erased faces.
 * @returns {boolean} True if a stroke was undone, false if no strokes to undo.
 */
export function undoLastSurfaceStroke() {
    if (state.surfaceStrokeHistory.length === 0) {
        return false;
    }
    
    const stroke = state.surfaceStrokeHistory.pop();
    
    // Remove faces that were added in that stroke
    for (const faceId of stroke.added) {
        state.paintedFaces.delete(faceId);
    }
    
    // Re-add faces that were erased in that stroke
    for (const faceId of stroke.removed) {
        state.paintedFaces.add(faceId);
    }
    
    // Force a full rebuild of the highlight mesh
    state.needsFullHighlightRebuild = true;
    state.pendingFaces = [];
    scheduleSurfaceHighlight();
    
    const remaining = state.surfaceStrokeHistory.length;
    if (state.paintedFaces.size === 0) {
        showStatus('All strokes undone. Paint to start again.');
    } else {
        showStatus(`Stroke undone. ${remaining} stroke${remaining !== 1 ? 's' : ''} remaining.`);
    }
    
    return true;
}


/**
 * onCanvasTap (surface tool): paint (or erase, with Shift held) at the tapped
 * face. Lifted verbatim from the onCanvasTap surface branch (router-thinning).
 * @param {PointerEvent|MouseEvent} event
 */
export function handleSurfaceTap(event) {
    state.isErasingMode = event.shiftKey;
    const hitInfo = getIntersectionWithFace(event);
    if (hitInfo) {
        paintAtPoint(hitInfo.point, hitInfo.mesh, hitInfo.faceIndex);
    }
}

/**
 * onCanvasDoubleTap (surface tool): finalise the painted region into an
 * annotation and deactivate the tool.
 * @param {PointerEvent|MouseEvent} event
 */
export function handleSurfaceDoubleTap(event) {
    finishSurfacePainting(event);
    _setTool(null);
}
