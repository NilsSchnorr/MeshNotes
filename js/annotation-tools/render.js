// js/annotation-tools/render.js
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { state, dom } from '../state.js';
import { createScaledTextSprite } from '../core/scene.js';

// Late-bound reference to avoid circular dependency
// (editing.js imports from render.js, render.js needs renderMeasurements from editing.js)
let _renderMeasurements = null;

export function setRenderCallbacks({ renderMeasurements }) {
    _renderMeasurements = renderMeasurements;
}

export function renderAnnotations() {
    // Clear existing and dispose GPU resources
    while (state.annotationObjects.children.length > 0) {
        const child = state.annotationObjects.children[0];
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(m => m.dispose());
        }
        state.annotationObjects.remove(child);
    }

    const modelSize = state.currentModel ?
        new THREE.Box3().setFromObject(state.currentModel).getSize(new THREE.Vector3()) :
        new THREE.Vector3(1, 1, 1);
    const maxDim = Math.max(modelSize.x, modelSize.y, modelSize.z);
    const labelOffset = Math.pow(maxDim, 0.8) * 0.012;

    state.annotations.forEach(ann => {
        const group = state.groups.find(g => g.id === ann.groupId);
        if (!group || !group.visible) return;

        const color = new THREE.Color(group.color);
        let labelPosition;

        if (ann.type === 'point') {
            const geometry = new THREE.SphereGeometry(0.02, 16, 16);
            const material = new THREE.MeshBasicMaterial({ color });
            const marker = new THREE.Mesh(geometry, material);
            marker.position.set(ann.points[0].x, ann.points[0].y, ann.points[0].z);
            marker.scale.setScalar(Math.pow(maxDim, 0.8) * 0.025 * state.pointSizeMultiplier);
            marker.userData.annotationId = ann.id;
            marker.userData.pointIndex = 0;
            marker.userData.isAnnotationMarker = true;
            state.annotationObjects.add(marker);

            labelPosition = new THREE.Vector3(
                ann.points[0].x,
                ann.points[0].y + labelOffset,
                ann.points[0].z
            );
        } else if (ann.type === 'line' || ann.type === 'polygon') {
            const positions = [];

            if (ann.projectedEdges && ann.surfaceProjection && ann.projectedEdges.length > 0) {
                ann.projectedEdges.forEach((edge, edgeIdx) => {
                    const startIdx = (edgeIdx === 0) ? 0 : 1;
                    for (let j = startIdx; j < edge.length; j++) {
                        positions.push(edge[j].x, edge[j].y, edge[j].z);
                    }
                });
            } else {
                const points = ann.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
                if (ann.type === 'polygon' && points.length > 0) {
                    points.push(points[0].clone());
                }
                points.forEach(p => positions.push(p.x, p.y, p.z));
            }

            const lineGeometry = new LineGeometry();
            lineGeometry.setPositions(positions);

            const lineMaterial = new LineMaterial({
                color: color,
                linewidth: 3,
                resolution: new THREE.Vector2(window.innerWidth - 320, window.innerHeight - 50),
                polygonOffset: true,
                polygonOffsetFactor: -4,
                polygonOffsetUnits: -4
            });

            const line = new Line2(lineGeometry, lineMaterial);
            line.userData.annotationId = ann.id;
            state.annotationObjects.add(line);

            ann.points.forEach((p, index) => {
                const geometry = new THREE.SphereGeometry(0.02, 12, 12);
                const material = new THREE.MeshBasicMaterial({ color });
                const marker = new THREE.Mesh(geometry, material);
                marker.position.set(p.x, p.y, p.z);
                marker.scale.setScalar(Math.pow(maxDim, 0.8) * 0.018 * state.pointSizeMultiplier);
                marker.userData.annotationId = ann.id;
                marker.userData.pointIndex = index;
                marker.userData.isAnnotationMarker = true;
                state.annotationObjects.add(marker);
            });

            if (ann.type === 'polygon' && ann.points.length > 0) {
                const centroid = ann.points.reduce(
                    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }),
                    { x: 0, y: 0, z: 0 }
                );
                labelPosition = new THREE.Vector3(
                    centroid.x / ann.points.length,
                    centroid.y / ann.points.length + labelOffset,
                    centroid.z / ann.points.length
                );
            } else if (ann.points.length > 0) {
                labelPosition = new THREE.Vector3(
                    ann.points[0].x,
                    ann.points[0].y + labelOffset,
                    ann.points[0].z
                );
            }
        } else if (ann.type === 'surface' && ann.faceData) {
            const surfaceMesh = renderSurfaceAnnotation(ann, color);
            if (surfaceMesh) {
                surfaceMesh.userData.annotationId = ann.id;
                state.annotationObjects.add(surfaceMesh);
            }

            if (ann.points && ann.points.length > 0) {
                labelPosition = new THREE.Vector3(
                    ann.points[0].x,
                    ann.points[0].y + labelOffset,
                    ann.points[0].z
                );
            }
        } else if (ann.type === 'box' && ann.boxData) {
            const boxObjects = renderBoxAnnotation(ann, color, maxDim);
            if (boxObjects) {
                boxObjects.forEach(obj => {
                    obj.userData.annotationId = ann.id;
                    state.annotationObjects.add(obj);
                });
            }

            const center = ann.boxData.center;
            const size = ann.boxData.size;
            labelPosition = new THREE.Vector3(
                center.x,
                center.y + size.y / 2 + labelOffset,
                center.z
            );
        }

        if (ann.name && labelPosition) {
            const label = createScaledTextSprite(ann.name, group.color, labelPosition, 0.8);
            label.userData.annotationId = ann.id;
            state.annotationObjects.add(label);
        }
    });

    // Re-render measurements (they were cleared with annotation objects)
    if (_renderMeasurements) {
        _renderMeasurements();
    }

    updateAnnotationsPanel();
}

export function renderSurfaceAnnotation(ann, color) {
    if (!ann.faceData || ann.faceData.length === 0) return null;

    const facesByMesh = new Map();
    ann.faceData.forEach(faceId => {
        const [meshIdx, faceIdx] = faceId.split('_');
        if (!facesByMesh.has(meshIdx)) {
            facesByMesh.set(meshIdx, []);
        }
        facesByMesh.get(meshIdx).push(parseInt(faceIdx));
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

    if (vertices.length === 0) return null;

    const highlightGeometry = new THREE.BufferGeometry();
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    highlightGeometry.computeVertexNormals();

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

    const mesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
    mesh.renderOrder = 999;
    return mesh;
}

export function renderBoxAnnotation(ann, color, maxDim) {
    if (!ann.boxData) return null;

    const { center, size, rotation } = ann.boxData;
    const objects = [];
    
    // Check if this box is unlocked for editing
    const isUnlocked = state.boxEditUnlocked === ann.id;
    // Use white handles/edges when unlocked to indicate edit mode
    const edgeColor = isUnlocked ? new THREE.Color(0xffffff) : color;
    const handleColor = isUnlocked ? new THREE.Color(0xffffff) : color;

    const boxGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);

    // Fill uses group color regardless of unlock state
    const fillMaterial = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: isUnlocked ? 0.35 : 0.25,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false
    });

    const boxMesh = new THREE.Mesh(boxGeometry.clone(), fillMaterial);
    boxMesh.position.set(center.x, center.y, center.z);
    if (rotation) {
        boxMesh.rotation.set(rotation.x, rotation.y, rotation.z);
    }
    boxMesh.userData.isBoxBody = true;
    boxMesh.renderOrder = 1;
    objects.push(boxMesh);

    const edgesGeometry = new THREE.EdgesGeometry(boxGeometry);
    const edgesMaterial = new THREE.LineBasicMaterial({
        color: edgeColor,
        linewidth: 2,
        transparent: true,
        opacity: 1.0,
        depthTest: true,
        depthWrite: false
    });
    const wireframe = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    wireframe.position.copy(boxMesh.position);
    wireframe.rotation.copy(boxMesh.rotation);
    wireframe.renderOrder = 2;
    objects.push(wireframe);

    const corners = [
        [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
        [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5],
        [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]
    ];

    const handleGeometry = new THREE.SphereGeometry(0.02, 12, 12);

    corners.forEach((corner, index) => {
        const handleMaterial = new THREE.MeshBasicMaterial({
            color: handleColor,
            transparent: true,
            opacity: 1.0,
            depthTest: true,
            depthWrite: false
        });
        const handle = new THREE.Mesh(handleGeometry, handleMaterial);

        const localPos = new THREE.Vector3(
            corner[0] * size.x,
            corner[1] * size.y,
            corner[2] * size.z
        );

        if (rotation) {
            const euler = new THREE.Euler(rotation.x, rotation.y, rotation.z);
            localPos.applyEuler(euler);
        }
        handle.position.set(
            center.x + localPos.x,
            center.y + localPos.y,
            center.z + localPos.z
        );

        // Slightly larger handles when unlocked for better visibility
        const handleScale = isUnlocked ? 1.3 : 1.0;
        handle.scale.setScalar(Math.pow(maxDim, 0.8) * 0.018 * state.pointSizeMultiplier * handleScale);
        handle.userData.isBoxHandle = true;
        handle.userData.handleIndex = index;
        handle.userData.isAnnotationMarker = true;
        handle.renderOrder = 3;
        objects.push(handle);
    });

    return objects;
}

export function updateAnnotationsPanel() {
    // Panel content is now integrated into groups list
}
