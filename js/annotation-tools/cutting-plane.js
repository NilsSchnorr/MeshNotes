// js/annotation-tools/cutting-plane.js — Cutting plane profile extraction tool
import * as THREE from 'three';
import { state, dom } from '../state.js';
import { showStatus } from '../utils/helpers.js';

// ============ Reusable Objects (avoid GC pressure) ============
const _planeNormal = new THREE.Vector3();
const _planePoint = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _intersectPoint = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();

// ============ Constants ============
const PLANE_COLOR = 0x4A90D9;
const PLANE_OPACITY = 0.25;
const PLANE_EDGE_COLOR = 0x4A90D9;
const INTERSECTION_COLOR = 0xFF4444;
const INTERSECTION_LINE_WIDTH = 3;
const SNAP_ANGLE_DEG = 15;

// ============ Module State ============
let planeGroup = null;          // THREE.Group holding plane mesh + outline
let planeMesh = null;           // The semi-transparent plane mesh
let planeOutline = null;        // Wireframe outline of the plane
let intersectionLines = null;   // THREE.LineSegments showing the cut preview
let planeNormal = new THREE.Vector3(0, 0, 1);  // Current plane normal
let planeCenter = new THREE.Vector3(0, 0, 0);  // Current plane center position
let planeSize = 1;              // Plane size (based on model bounding box)

// Drag/rotate state
let isDragging = false;
let isRotating = false;
let isSwinging = false;
let dragStartMouse = new THREE.Vector2();
let dragStartPlaneCenter = new THREE.Vector3();
let rotateStartMouse = new THREE.Vector2();
let rotateStartNormal = new THREE.Vector3();
let rotateStartUp = new THREE.Vector3();
let rotateStartRight = new THREE.Vector3();
let swingStartMouse = new THREE.Vector2();
let swingStartNormal = new THREE.Vector3();

// ============ Public API ============

/**
 * Spawn a cutting plane in the scene, aligned to the current camera view.
 * The plane is perpendicular to the camera's viewing direction.
 */
export function spawnCuttingPlane() {
    if (planeGroup) {
        removeCuttingPlane();
    }

    if (!state.currentModel) {
        showStatus('Load a model first');
        return;
    }

    // Compute model bounding box
    const box = new THREE.Box3().setFromObject(state.currentModel);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    planeSize = Math.max(size.x, size.y, size.z) * 1.5;

    // Get camera forward direction (the plane normal)
    const camera = state.camera;
    planeNormal.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    planeCenter.copy(center);

    // Create plane group
    planeGroup = new THREE.Group();
    planeGroup.name = 'CuttingPlane';

    // Create semi-transparent plane mesh
    const planeGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    const planeMat = new THREE.MeshBasicMaterial({
        color: PLANE_COLOR,
        transparent: true,
        opacity: PLANE_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    planeMesh = new THREE.Mesh(planeGeo, planeMat);
    planeGroup.add(planeMesh);

    // Create wireframe outline
    const outlineGeo = new THREE.EdgesGeometry(planeGeo);
    const outlineMat = new THREE.LineBasicMaterial({
        color: PLANE_EDGE_COLOR,
        transparent: true,
        opacity: 0.6,
    });
    planeOutline = new THREE.LineSegments(outlineGeo, outlineMat);
    planeGroup.add(planeOutline);

    // Orient the plane perpendicular to camera
    _orientPlane();

    // Add to scene
    state.scene.add(planeGroup);
    state.cuttingPlaneActive = true;

    // Compute initial intersection preview
    updateIntersectionPreview();

    // Update button state
    _updateButtonStates();

    showStatus('Cutting plane spawned — drag to move, right-drag to rotate');
}

/**
 * Remove the cutting plane from the scene.
 */
export function removeCuttingPlane() {
    if (planeGroup) {
        // Dispose geometries and materials
        planeGroup.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        state.scene.remove(planeGroup);
        planeGroup = null;
        planeMesh = null;
        planeOutline = null;
    }

    if (intersectionLines) {
        if (intersectionLines.geometry) intersectionLines.geometry.dispose();
        if (intersectionLines.material) intersectionLines.material.dispose();
        state.scene.remove(intersectionLines);
        intersectionLines = null;
    }

    state.cuttingPlaneActive = false;
    isDragging = false;
    isRotating = false;
    isSwinging = false;

    _updateButtonStates();
}

/**
 * Toggle the cutting plane on/off.
 */
export function toggleCuttingPlane() {
    if (state.cuttingPlaneActive) {
        removeCuttingPlane();
        showStatus('Cutting plane removed');
    } else {
        spawnCuttingPlane();
    }
}

/**
 * Extract the profile: compute full intersection, show preview overlay.
 */
export function extractProfile() {
    if (!state.cuttingPlaneActive || !state.currentModel) {
        showStatus('Spawn a cutting plane first');
        return;
    }

    // Compute intersection segments
    const segments = computeIntersection();
    if (segments.length === 0) {
        showStatus('No intersection found — move the plane through the model');
        return;
    }

    // Project to 2D
    const { points2D, segments2D, width, height, minU, minV, maxU, maxV } = projectTo2D(segments);

    // Show preview overlay
    showProfilePreview(segments2D, width, height, minU, minV, maxU, maxV);
}

// ============ Pointer Event Handlers ============

/**
 * Handle pointer down on canvas — check if clicking on the cutting plane.
 * @param {PointerEvent} e
 * @returns {boolean} true if the event was consumed (plane interaction started)
 */
export function onCuttingPlanePointerDown(e) {
    if (!state.cuttingPlaneActive || !planeMesh) return false;

    const rect = dom.canvas.getBoundingClientRect();
    _mouse.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
    );

    _raycaster.setFromCamera(_mouse, state.camera);
    const hits = _raycaster.intersectObject(planeMesh, false);

    if (hits.length === 0) return false;

    // Right button → rotate (tilt)
    if (e.button === 2) {
        isRotating = true;
        isDragging = false;
        isSwinging = false;
        rotateStartMouse.set(e.clientX, e.clientY);
        rotateStartNormal.copy(planeNormal);
        // Compute local axes for rotation
        const camera = state.camera;
        rotateStartUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
        rotateStartRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
        state.controls.enabled = false;
        e.preventDefault();
        return true;
    }

    // Ctrl/Cmd + left button → swing (rotate around world vertical axis)
    if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
        isSwinging = true;
        isDragging = false;
        isRotating = false;
        swingStartMouse.set(e.clientX, e.clientY);
        swingStartNormal.copy(planeNormal);
        state.controls.enabled = false;
        e.preventDefault();
        return true;
    }

    // Left button → translate along normal
    if (e.button === 0) {
        isDragging = true;
        isRotating = false;
        isSwinging = false;
        dragStartMouse.set(e.clientX, e.clientY);
        dragStartPlaneCenter.copy(planeCenter);
        state.controls.enabled = false;
        e.preventDefault();
        return true;
    }

    return false;
}

/**
 * Handle pointer move during cutting plane interaction.
 * @param {PointerEvent} e
 * @returns {boolean} true if the event was consumed
 */
export function onCuttingPlanePointerMove(e) {
    if (!state.cuttingPlaneActive) return false;

    if (isDragging) {
        _handleDragMove(e);
        return true;
    }

    if (isRotating) {
        _handleRotateMove(e);
        return true;
    }

    if (isSwinging) {
        _handleSwingMove(e);
        return true;
    }

    return false;
}

/**
 * Handle pointer up — finish dragging/rotating.
 * @param {PointerEvent} e
 * @returns {boolean} true if the event was consumed
 */
export function onCuttingPlanePointerUp(e) {
    if (!state.cuttingPlaneActive) return false;

    if (isDragging || isRotating || isSwinging) {
        isDragging = false;
        isRotating = false;
        isSwinging = false;
        state.controls.enabled = true;
        return true;
    }

    return false;
}

// ============ Internal: Drag & Rotate ============

function _handleDragMove(e) {
    // Translate the plane along its normal based on mouse delta projected onto screen-space normal
    const camera = state.camera;
    const rect = dom.canvas.getBoundingClientRect();

    // Project plane normal to screen space to determine drag direction
    const screenCenter = planeCenter.clone().project(camera);
    const screenNormalTip = planeCenter.clone().add(planeNormal).project(camera);
    const screenDir = new THREE.Vector2(
        (screenNormalTip.x - screenCenter.x) * rect.width * 0.5,
        -(screenNormalTip.y - screenCenter.y) * rect.height * 0.5
    );
    const screenDirLen = screenDir.length();
    if (screenDirLen < 0.001) return;
    screenDir.normalize();

    // Mouse delta
    const dx = e.clientX - dragStartMouse.x;
    const dy = e.clientY - dragStartMouse.y;

    // Project mouse delta onto screen-space normal direction
    const projection = dx * screenDir.x + dy * screenDir.y;

    // Scale: how much world-space distance per pixel
    const worldPerPixel = planeSize / Math.max(rect.width, rect.height);
    const displacement = projection * worldPerPixel * 2;

    planeCenter.copy(dragStartPlaneCenter).addScaledVector(planeNormal, displacement);
    _orientPlane();
    updateIntersectionPreview();
}

function _handleRotateMove(e) {
    const dx = e.clientX - rotateStartMouse.x;
    const dy = e.clientY - rotateStartMouse.y;
    const sensitivity = 0.005;

    // Rotate normal around screen-space axes
    const rotY = new THREE.Quaternion().setFromAxisAngle(rotateStartUp, -dx * sensitivity);
    const rotX = new THREE.Quaternion().setFromAxisAngle(rotateStartRight, -dy * sensitivity);

    planeNormal.copy(rotateStartNormal);
    planeNormal.applyQuaternion(rotY);
    planeNormal.applyQuaternion(rotX);
    planeNormal.normalize();

    _orientPlane();
    updateIntersectionPreview();
}

function _handleSwingMove(e) {
    const dx = e.clientX - swingStartMouse.x;
    const sensitivity = 0.005;
    const angle = dx * sensitivity;

    // Compute the plane's local up axis from its starting orientation.
    // This is the axis the left/right edges pivot around.
    const localUp = new THREE.Vector3(0, 1, 0);
    const startQuat = new THREE.Quaternion();
    startQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), swingStartNormal);
    localUp.applyQuaternion(startQuat).normalize();

    const swingQuat = new THREE.Quaternion().setFromAxisAngle(localUp, angle);
    planeNormal.copy(swingStartNormal).applyQuaternion(swingQuat).normalize();

    _orientPlane();
    updateIntersectionPreview();
}

// ============ Internal: Plane Geometry ============

function _orientPlane() {
    if (!planeGroup) return;

    // Position the group at the plane center
    planeGroup.position.copy(planeCenter);

    // Orient the plane so its face normal matches planeNormal
    // PlaneGeometry faces along +Z by default
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), planeNormal);

    planeGroup.quaternion.copy(quaternion);
}

// ============ Triangle-Plane Intersection ============

/**
 * Compute all intersection line segments between the cutting plane and the model.
 * @returns {Array<{start: THREE.Vector3, end: THREE.Vector3}>} Array of line segments
 */
function computeIntersection() {
    const segments = [];
    const plane = new THREE.Plane();
    plane.setFromNormalAndCoplanarPoint(planeNormal, planeCenter);

    state.modelMeshes.forEach(mesh => {
        const geometry = mesh.geometry;
        if (!geometry) return;

        const posAttr = geometry.attributes.position;
        if (!posAttr) return;

        const index = geometry.index;
        const matrixWorld = mesh.matrixWorld;

        const triCount = index ? index.count / 3 : posAttr.count / 3;

        for (let i = 0; i < triCount; i++) {
            // Get vertex indices
            let i0, i1, i2;
            if (index) {
                i0 = index.getX(i * 3);
                i1 = index.getX(i * 3 + 1);
                i2 = index.getX(i * 3 + 2);
            } else {
                i0 = i * 3;
                i1 = i * 3 + 1;
                i2 = i * 3 + 2;
            }

            // Get vertices in world space
            _v0.fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld);
            _v1.fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld);
            _v2.fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld);

            // Signed distances from the plane
            const d0 = plane.distanceToPoint(_v0);
            const d1 = plane.distanceToPoint(_v1);
            const d2 = plane.distanceToPoint(_v2);

            // Classify vertices (true = front/on, false = behind)
            const eps = 1e-8;
            const s0 = d0 > eps ? 1 : (d0 < -eps ? -1 : 0);
            const s1 = d1 > eps ? 1 : (d1 < -eps ? -1 : 0);
            const s2 = d2 > eps ? 1 : (d2 < -eps ? -1 : 0);

            // Skip if all on same side
            if (s0 === s1 && s1 === s2 && s0 !== 0) continue;
            // Skip degenerate (all on plane)
            if (s0 === 0 && s1 === 0 && s2 === 0) continue;

            // Find intersection points on edges that cross the plane
            const intersectionPoints = [];

            _tryEdgeIntersection(_v0, _v1, d0, d1, s0, s1, intersectionPoints);
            _tryEdgeIntersection(_v1, _v2, d1, d2, s1, s2, intersectionPoints);
            _tryEdgeIntersection(_v2, _v0, d2, d0, s2, s0, intersectionPoints);

            if (intersectionPoints.length >= 2) {
                segments.push({
                    start: intersectionPoints[0].clone(),
                    end: intersectionPoints[1].clone()
                });
            }
        }
    });

    return segments;
}

/**
 * Check if an edge crosses the plane, and if so, compute the intersection point.
 */
function _tryEdgeIntersection(vA, vB, dA, dB, sA, sB, result) {
    // Edge crosses if signs differ
    if (sA !== 0 && sB !== 0 && sA !== sB) {
        const t = dA / (dA - dB);
        const point = new THREE.Vector3().lerpVectors(vA, vB, t);
        result.push(point);
    }
    // Vertex on plane: include it if the other vertex is off-plane
    else if (sA === 0 && sB !== 0) {
        result.push(vA.clone());
    }
    else if (sB === 0 && sA !== 0) {
        result.push(vB.clone());
    }
}

// ============ Intersection Preview ============

/**
 * Update the real-time intersection preview lines in the 3D scene.
 */
export function updateIntersectionPreview() {
    // Remove old preview
    if (intersectionLines) {
        if (intersectionLines.geometry) intersectionLines.geometry.dispose();
        if (intersectionLines.material) intersectionLines.material.dispose();
        state.scene.remove(intersectionLines);
        intersectionLines = null;
    }

    if (!state.cuttingPlaneActive || !state.currentModel) return;

    const segments = computeIntersection();
    if (segments.length === 0) return;

    // Build geometry from segments
    const positions = [];
    for (const seg of segments) {
        positions.push(seg.start.x, seg.start.y, seg.start.z);
        positions.push(seg.end.x, seg.end.y, seg.end.z);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
        color: INTERSECTION_COLOR,
        linewidth: INTERSECTION_LINE_WIDTH,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
    });

    intersectionLines = new THREE.LineSegments(geo, mat);
    intersectionLines.renderOrder = 999;
    state.scene.add(intersectionLines);
}

// ============ 2D Projection ============

/**
 * Project 3D intersection segments onto the cutting plane's local 2D coordinate system.
 * Returns 2D segments plus bounding info.
 */
function projectTo2D(segments) {
    // Build local coordinate system on the plane, respecting yaw.
    // Use the plane group's actual local axes so the 2D output
    // reflects how the user oriented the plane visually.
    let uAxis, vAxis;

    if (planeGroup) {
        // PlaneGeometry local X = right, local Y = up
        uAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(planeGroup.quaternion).normalize();
        vAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(planeGroup.quaternion).normalize();
    } else {
        // Fallback: derive from normal (no yaw)
        const up = new THREE.Vector3(0, 1, 0);
        if (Math.abs(planeNormal.dot(up)) > 0.99) {
            up.set(1, 0, 0);
        }
        uAxis = new THREE.Vector3().crossVectors(up, planeNormal).normalize();
        vAxis = new THREE.Vector3().crossVectors(planeNormal, uAxis).normalize();
    }

    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;

    const segments2D = [];

    for (const seg of segments) {
        const sOff = seg.start.clone().sub(planeCenter);
        const eOff = seg.end.clone().sub(planeCenter);

        const su = sOff.dot(uAxis);
        const sv = sOff.dot(vAxis);
        const eu = eOff.dot(uAxis);
        const ev = eOff.dot(vAxis);

        segments2D.push({ su, sv, eu, ev });

        minU = Math.min(minU, su, eu);
        maxU = Math.max(maxU, su, eu);
        minV = Math.min(minV, sv, ev);
        maxV = Math.max(maxV, sv, ev);
    }

    const width = maxU - minU;
    const height = maxV - minV;

    return { segments2D, width, height, minU, minV, maxU, maxV };
}

// ============ SVG Generation ============

/**
 * Generate an SVG string of the profile with a scale bar.
 */
function generateSVG(segments2D, width, height, minU, minV, maxU, maxV) {
    const unit = state.measurementUnit || 'units';
    const margin = 40;
    const scaleBarMargin = 30;

    // Target width for the SVG (in pixels)
    const targetWidth = 800;
    const scale = (targetWidth - 2 * margin) / (width || 1);
    const svgWidth = targetWidth;
    const svgHeight = Math.ceil(height * scale) + 2 * margin + scaleBarMargin;

    // Transform: flip V axis (SVG y grows downward)
    function toSVG(u, v) {
        const x = margin + (u - minU) * scale;
        const y = margin + (maxV - v) * scale;
        return { x, y };
    }

    // Build path data from segments
    let pathData = '';
    for (const seg of segments2D) {
        const s = toSVG(seg.su, seg.sv);
        const e = toSVG(seg.eu, seg.ev);
        pathData += `M${s.x.toFixed(2)},${s.y.toFixed(2)} L${e.x.toFixed(2)},${e.y.toFixed(2)} `;
    }

    // Scale bar
    const scaleBarLength = _niceScaleBarLength(width);
    const scaleBarPx = scaleBarLength * scale;
    const scaleBarY = svgHeight - scaleBarMargin + 5;
    const scaleBarX = margin;

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="white"/>
  
  <!-- Profile outline -->
  <path d="${pathData}" fill="none" stroke="#222222" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  
  <!-- Scale bar -->
  <line x1="${scaleBarX}" y1="${scaleBarY}" x2="${scaleBarX + scaleBarPx}" y2="${scaleBarY}" stroke="#333333" stroke-width="2"/>
  <line x1="${scaleBarX}" y1="${scaleBarY - 4}" x2="${scaleBarX}" y2="${scaleBarY + 4}" stroke="#333333" stroke-width="2"/>
  <line x1="${scaleBarX + scaleBarPx}" y1="${scaleBarY - 4}" x2="${scaleBarX + scaleBarPx}" y2="${scaleBarY + 4}" stroke="#333333" stroke-width="2"/>
  <text x="${scaleBarX + scaleBarPx / 2}" y="${scaleBarY + 16}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#333333">${scaleBarLength} ${unit}</text>
  
  <!-- Model name -->
  <text x="${svgWidth - margin}" y="${svgHeight - scaleBarMargin + 18}" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="#888888">${_escapeXml(state.modelFileName || 'Unknown model')}</text>
</svg>`;

    return svg;
}

/**
 * Compute a "nice" scale bar length (e.g., 1, 2, 5, 10, 20, 50, 100...).
 */
function _niceScaleBarLength(totalWidth) {
    // Target the scale bar to be roughly 1/4 to 1/3 of the profile width
    const target = totalWidth * 0.25;
    if (target <= 0) return 1;

    const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
    const normalized = target / magnitude;

    let nice;
    if (normalized < 1.5) nice = 1;
    else if (normalized < 3.5) nice = 2;
    else if (normalized < 7.5) nice = 5;
    else nice = 10;

    return nice * magnitude;
}

function _escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============ Profile Preview Overlay ============

/**
 * Show the profile preview overlay with SVG/PNG download options.
 */
function showProfilePreview(segments2D, width, height, minU, minV, maxU, maxV) {
    const overlay = document.getElementById('profile-preview-overlay');
    const container = document.getElementById('profile-preview-container');
    const svgString = generateSVG(segments2D, width, height, minU, minV, maxU, maxV);

    // Display the SVG in the preview
    container.innerHTML = svgString;

    // Store data for download buttons
    overlay._svgString = svgString;
    overlay._segments2D = segments2D;
    overlay._dims = { width, height, minU, minV, maxU, maxV };

    overlay.classList.add('visible');
}

/**
 * Close the profile preview overlay.
 */
export function closeProfilePreview() {
    const overlay = document.getElementById('profile-preview-overlay');
    overlay.classList.remove('visible');
}

/**
 * Download the profile as SVG.
 */
export function downloadProfileSVG() {
    const overlay = document.getElementById('profile-preview-overlay');
    const svgString = overlay._svgString;
    if (!svgString) return;

    const filename = _profileFilename('svg');
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    _downloadBlob(blob, filename);
    showStatus(`Profile saved as ${filename}`);
}

/**
 * Download the profile as PNG.
 */
export function downloadProfilePNG() {
    const overlay = document.getElementById('profile-preview-overlay');
    const svgString = overlay._svgString;
    if (!svgString) return;

    // Parse SVG dimensions
    const widthMatch = svgString.match(/width="(\d+)"/);
    const heightMatch = svgString.match(/height="(\d+)"/);
    const svgWidth = widthMatch ? parseInt(widthMatch[1]) : 800;
    const svgHeight = heightMatch ? parseInt(heightMatch[1]) : 600;

    // Render SVG to canvas, then export as PNG
    const canvas = document.createElement('canvas');
    const dpr = 2; // High-res export
    canvas.width = svgWidth * dpr;
    canvas.height = svgHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const img = new Image();
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, svgWidth, svgHeight);
        ctx.drawImage(img, 0, 0, svgWidth, svgHeight);
        URL.revokeObjectURL(url);

        canvas.toBlob(blob => {
            const filename = _profileFilename('png');
            _downloadBlob(blob, filename);
            showStatus(`Profile saved as ${filename}`);
        }, 'image/png');
    };

    img.onerror = () => {
        URL.revokeObjectURL(url);
        showStatus('Error generating PNG');
    };

    img.src = url;
}

function _profileFilename(ext) {
    const modelName = state.modelFileName
        ? state.modelFileName.replace(/\.[^/.]+$/, '')
        : 'profile';
    return `${modelName}_profile.${ext}`;
}

function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============ Button State Management ============

function _updateButtonStates() {
    const spawnBtn = document.getElementById('btn-spawn-plane');
    const extractBtn = document.getElementById('btn-extract-profile');

    if (spawnBtn) {
        spawnBtn.textContent = state.cuttingPlaneActive ? 'Remove Plane' : 'Spawn Plane';
    }
    if (extractBtn) {
        extractBtn.disabled = !state.cuttingPlaneActive;
    }
}

// ============ Cleanup ============

/**
 * Full cleanup — call when switching tools or clearing the scene.
 */
export function cleanupCuttingPlane() {
    removeCuttingPlane();
    closeProfilePreview();
}
