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
        const invMatrix = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
        const localCenter = point.clone().applyMatrix4(invMatrix);

        const scale = new THREE.Vector3();
        mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
        const avgScale = (scale.x + scale.y + scale.z) / 3;
        const localRadius = brushRadius / avgScale;

        const localRadiusSq = localRadius * localRadius;

        geometry.boundsTree.shapecast({
            intersectsBounds: (box) => {
                const closestPoint = new THREE.Vector3();
                box.clampPoint(localCenter, closestPoint);
                return closestPoint.distanceToSquared(localCenter) <= localRadiusSq;
            },
            intersectsTriangle: (triangle, triIndex) => {
                const faceCenter = new THREE.Vector3()
                    .addVectors(triangle.a, triangle.b)
                    .add(triangle.c)
                    .divideScalar(3);

                if (faceCenter.distanceToSquared(localCenter) <= localRadiusSq) {
                    const faceId = `${meshIndex}_${triIndex}`;
                    if (state.isErasingMode) {
                        state.paintedFaces.delete(faceId);
                    } else {
                        state.paintedFaces.add(faceId);
                    }
                }
                return false;
            }
        });
    } else {
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
                const faceId = `${meshIndex}_${i}`;
                if (state.isErasingMode) {
                    state.paintedFaces.delete(faceId);
                } else {
                    state.paintedFaces.add(faceId);
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

export function updateSurfaceHighlight() {
    if (state.surfaceHighlightMesh) {
        state.annotationObjects.remove(state.surfaceHighlightMesh);
        state.surfaceHighlightMesh.geometry.dispose();
        state.surfaceHighlightMesh.material.dispose();
        state.surfaceHighlightMesh = null;
    }

    if (state.paintedFaces.size === 0) return;

    const facesByMesh = new Map();
    state.paintedFaces.forEach(faceId => {
        const [meshIdx, faceIdx] = faceId.split('_');
        if (!facesByMesh.has(meshIdx)) {
            facesByMesh.set(meshIdx, []);
        }
        facesByMesh.set(meshIdx, [...facesByMesh.get(meshIdx), parseInt(faceIdx)]);
    });

    const vertices = [];

    facesByMesh.forEach((faceIndices, meshIdx) => {
        const mesh = state.modelMeshes[parseInt(meshIdx)];
        if (!mesh) return;

        const geometry = mesh.geometry;
        const position = geometry.attributes.position;

        faceIndices.forEach(faceIdx => {
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

            const vA = new THREE.Vector3().fromBufferAttribute(position, a);
            const vB = new THREE.Vector3().fromBufferAttribute(position, b);
            const vC = new THREE.Vector3().fromBufferAttribute(position, c);

            vA.applyMatrix4(mesh.matrixWorld);
            vB.applyMatrix4(mesh.matrixWorld);
            vC.applyMatrix4(mesh.matrixWorld);

            vertices.push(vA.x, vA.y, vA.z);
            vertices.push(vB.x, vB.y, vB.z);
            vertices.push(vC.x, vC.y, vC.z);
        });
    });

    if (vertices.length === 0) return;

    const highlightGeometry = new THREE.BufferGeometry();
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    highlightGeometry.computeVertexNormals();

    const color = state.groups.length > 0 ? state.groups[0].color : '#EDC040';

    const highlightMaterial = new THREE.MeshBasicMaterial({
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

    state.surfaceHighlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
    state.surfaceHighlightMesh.renderOrder = 999;
    state.annotationObjects.add(state.surfaceHighlightMesh);
}

export function finishSurfacePainting(event) {
    if (state.paintedFaces.size === 0) {
        showStatus('No surface painted');
        clearTempSurface();
        return;
    }

    const center = new THREE.Vector3();
    let count = 0;

    state.paintedFaces.forEach(faceId => {
        const [meshIdx, faceIdx] = faceId.split('_');
        const mesh = state.modelMeshes[parseInt(meshIdx)];
        if (!mesh) return;

        const geometry = mesh.geometry;
        const position = geometry.attributes.position;
        const idx = parseInt(faceIdx);

        let a, b, c;
        if (geometry.index) {
            a = geometry.index.getX(idx * 3);
            b = geometry.index.getX(idx * 3 + 1);
            c = geometry.index.getX(idx * 3 + 2);
        } else {
            a = idx * 3;
            b = idx * 3 + 1;
            c = idx * 3 + 2;
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

        center.add(faceCenter);
        count++;
    });

    center.divideScalar(count);

    const faceData = Array.from(state.paintedFaces);

    _openAnnotationPopup(event, 'surface', [center], faceData);

    if (state.surfaceHighlightMesh) {
        state.annotationObjects.remove(state.surfaceHighlightMesh);
        state.surfaceHighlightMesh.geometry.dispose();
        state.surfaceHighlightMesh.material.dispose();
        state.surfaceHighlightMesh = null;
    }
    state.paintedFaces.clear();
    state.isPaintingSurface = false;
}

export function clearTempSurface() {
    state.paintedFaces.clear();
    state.isPaintingSurface = false;
    state.surfaceHighlightDirty = false;
    if (state.surfaceHighlightRAF) {
        cancelAnimationFrame(state.surfaceHighlightRAF);
        state.surfaceHighlightRAF = null;
    }
    if (state.surfaceHighlightMesh) {
        state.annotationObjects.remove(state.surfaceHighlightMesh);
        state.surfaceHighlightMesh.geometry.dispose();
        state.surfaceHighlightMesh.material.dispose();
        state.surfaceHighlightMesh = null;
    }
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
        state.measurePoints.push(point);
        addMeasureMarker(point);

        if (state.measurePoints.length === 2) {
            const dist = state.measurePoints[0].distanceTo(state.measurePoints[1]);

            updateMeasureLine();

            const midpoint = new THREE.Vector3().addVectors(state.measurePoints[0], state.measurePoints[1]).multiplyScalar(0.5);
            const labelText = `${dist.toFixed(3)} units`;
            const label = createScaledTextSprite(labelText, '#AA8101', midpoint, 0.5);
            state.annotationObjects.add(label);

            const measurementId = state.measurements.length + 1;
            state.measurements.push({
                id: measurementId,
                distance: dist,
                markers: [...state.measureMarkers],
                line: state.measureLine,
                label: label
            });

            updateMeasurementsDisplay();

            state.measurePoints = [];
            state.measureMarkers = [];
            state.measureLine = null;
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
        state.isErasingMode = event.shiftKey;
        state.controls.enabled = false;

        const hitInfo = getIntersectionWithFace(event);
        if (hitInfo) {
            paintAtPoint(hitInfo.point, hitInfo.mesh, hitInfo.faceIndex);
        }
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
        state.isErasingMode = event.shiftKey;
        const hitInfo = getIntersectionWithFace(event);
        if (hitInfo) {
            paintAtPoint(hitInfo.point, hitInfo.mesh, hitInfo.faceIndex);
        }
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

function updateMeasureLine() {
    if (state.measureLine) {
        state.annotationObjects.remove(state.measureLine);
    }

    if (state.measurePoints.length !== 2) return;

    const positions = [
        state.measurePoints[0].x, state.measurePoints[0].y, state.measurePoints[0].z,
        state.measurePoints[1].x, state.measurePoints[1].y, state.measurePoints[1].z
    ];

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

export function updateMeasurementsDisplay() {
    if (state.measurements.length === 0) {
        dom.measurementsList.innerHTML = '<div style="color: #888;">No measurements yet</div>';
    } else {
        dom.measurementsList.innerHTML = state.measurements.map(m => `
            <div class="measurement-item">
                <span class="label">Distance ${m.id}:</span>
                <span class="value">${m.distance.toFixed(3)} units</span>
            </div>
        `).join('');
    }
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
