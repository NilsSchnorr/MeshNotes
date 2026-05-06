// js/viewer-main.js - Viewer mode entry point (read-only)
//
// Loads a shared model + annotations from URL parameters and displays them
// without any editing capabilities. Provides "Open in Editor" navigation.

import { state, dom, initDomReferences } from './state.js';
import { initScene, initControls, addGrid, onWindowResize } from './core/scene.js';
import { initCameras, initViewHelper, updateViewHelperLabels } from './core/camera.js';
import { initLighting, updateLightFromCamera } from './core/lighting.js';
import { setupLoadedModel, loadOBJModel, loadOBJPlain, loadPLYModel } from './core/model-loader.js';
import { setUpdateModelInfoDisplay } from './core/model-loader.js';
import { updateModelInfoDisplay } from './annotation-tools/data.js';
import { createDefaultGroup, updateGroupsList, setGroupCallbacks, initGroupsEventDelegation } from './annotation-tools/groups.js';
import { renderAnnotations, setRenderCallbacks } from './annotation-tools/render.js';
import { setRenderAnnotations } from './annotation-tools/projection.js';
import { importAnnotations } from './export/import-json.js';
import { initLabelOcclusionUpdates } from './utils/label-occlusion.js';
import { showStatus, toDisplayCoords } from './utils/helpers.js';
import {
    parseUrlParams,
    loadShareFiles,
    loadDirectFiles,
    buildEditorUrl,
    daysUntilExpiry,
    isShareExpired
} from './core/url-params.js';

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// Wire up late-bound references (same as main.js but without editing callbacks)
setUpdateModelInfoDisplay(updateModelInfoDisplay);
setRenderAnnotations(renderAnnotations);
setGroupCallbacks({
    openGroupPopup: () => {},  // No-op in viewer mode
    openAnnotationPopupForEdit: () => {}  // No-op in viewer mode
});
setRenderCallbacks({
    renderMeasurements: () => {}  // No measurements in viewer
});

// ─── DOM references ────────────────────────────────────────────
const viewerBanner = document.getElementById('viewer-banner');
const viewerLoading = document.getElementById('viewer-loading');
const viewerLoadingText = document.getElementById('viewer-loading-text');
const expiredOverlay = document.getElementById('expired-overlay');
const btnOpenEditor = document.getElementById('btn-open-editor');

// ─── Initialization ────────────────────────────────────────────
function init() {
    initDomReferences();

    initScene();
    initCameras();
    initControls();
    initLighting();
    addGrid();
    initViewHelper();
    updateViewHelperLabels();

    initLabelOcclusionUpdates();

    createDefaultGroup();
    updateGroupsList();

    // Set up sidebar click — single click navigates camera, no double-click editing
    initViewerGroupsDelegation();

    // Set up sliders panel events (brightness, opacity, camera toggle, flip, light)
    initViewerSliders();

    // "Open in Editor" button
    btnOpenEditor.addEventListener('click', () => {
        window.location.href = buildEditorUrl();
    });

    // Sidebar toggle
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            sidebarToggle.innerHTML = sidebar.classList.contains('collapsed') ? '&#9654;' : '&#9664;';
        });
    }

    // Search filtering (reuse existing search input)
    if (dom.searchInput) {
        dom.searchInput.addEventListener('input', () => {
            const query = dom.searchInput.value.toLowerCase().trim();
            filterAnnotations(query);
        });
    }

    window.addEventListener('resize', onWindowResize);

    animate();

    // Load content from URL parameters
    loadFromUrl();
}

// ─── Render loop ───────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);

    state.controls.update();

    if (state.lightFollowsCamera) {
        updateLightFromCamera();
    }

    state.renderer.render(state.scene, state.camera);

    if (state.viewHelper && state.viewHelperRenderer) {
        state.viewHelper.render(state.viewHelperRenderer);
    }

    if (state.viewHelper) {
        const delta = state.clock.getDelta();
        if (state.viewHelper.animating) {
            state.viewHelper.update(delta);
        }
    }
}

// ─── URL-based loading ─────────────────────────────────────────
async function loadFromUrl() {
    const config = parseUrlParams();

    if (config.mode === 'local') {
        // No URL params — show a message
        showStatus('No model specified. Use a share link or open MeshNotes to annotate.');
        if (dom.noGroups) {
            dom.noGroups.textContent = 'No model loaded. Open a share link to view annotations.';
        }
        return;
    }

    // Show loading spinner
    viewerLoading.classList.add('visible');

    try {
        if (config.mode === 'share') {
            await loadFromShare(config.shareId, config.focusAnnotation);
        } else if (config.mode === 'direct') {
            await loadFromDirect(config.modelUrl, config.annotationsUrl, config.focusAnnotation);
        }
    } catch (error) {
        console.error('Failed to load:', error);

        if (error.message === 'expired') {
            expiredOverlay.classList.add('visible');
        } else {
            showStatus('Error loading: ' + error.message);
            if (dom.noGroups) {
                dom.noGroups.textContent = 'Failed to load model. ' + error.message;
            }
        }
    } finally {
        viewerLoading.classList.remove('visible');
    }
}

async function loadFromShare(shareId, focusAnnotation) {
    viewerLoadingText.textContent = 'Fetching shared files...';

    const shareData = await loadShareFiles(shareId);

    // Check expiry
    if (shareData.manifest && isShareExpired(shareData.manifest)) {
        throw new Error('expired');
    }

    // Show expiry banner
    if (shareData.manifest) {
        const days = daysUntilExpiry(shareData.manifest);
        viewerBanner.innerHTML = `<span class="expiry">This share expires in ${days} day${days !== 1 ? 's' : ''}</span> · For permanent archival, export and upload to a DOI repository`;
        viewerBanner.classList.add('visible');
    }

    viewerLoadingText.textContent = 'Loading 3D model...';

    // Load model based on format
    await loadModelFromFiles(shareData);

    // Load annotations if present
    if (shareData.annotationFile) {
        viewerLoadingText.textContent = 'Loading annotations...';
        importAnnotationFile(shareData.annotationFile);
    }

    // Focus on specific annotation if requested
    if (focusAnnotation) {
        focusOnAnnotation(focusAnnotation);
    }
}

async function loadFromDirect(modelUrl, annotationsUrl, focusAnnotation) {
    viewerLoadingText.textContent = 'Fetching model from URL...';

    const directData = await loadDirectFiles(modelUrl, annotationsUrl);

    viewerLoadingText.textContent = 'Loading 3D model...';

    await loadModelFromFiles(directData);

    if (directData.annotationFile) {
        viewerLoadingText.textContent = 'Loading annotations...';
        importAnnotationFile(directData.annotationFile);
    }

    if (focusAnnotation) {
        focusOnAnnotation(focusAnnotation);
    }
}

// ─── Model loading (from File objects) ─────────────────────────
function loadModelFromFiles(data) {
    return new Promise((resolve, reject) => {
        const { modelFile, materialFiles, format } = data;
        const ext = modelFile.name.split('.').pop().toLowerCase();

        if (format === 'glb' || ext === 'glb' || ext === 'gltf') {
            loadGLBFromFile(modelFile).then(resolve).catch(reject);
        } else if (format === 'obj' || ext === 'obj') {
            // OBJ — load with materials if present
            loadOBJFromFile(modelFile, materialFiles).then(resolve).catch(reject);
        } else if (format === 'ply' || ext === 'ply') {
            // PLY — check for texture in material files
            const textureFile = materialFiles.find(f => {
                const e = f.name.split('.').pop().toLowerCase();
                return ['jpg', 'jpeg', 'png', 'tif', 'tiff'].includes(e);
            });
            loadPLYFromFile(modelFile, textureFile).then(resolve).catch(reject);
        } else if (format === 'stl' || ext === 'stl') {
            loadSTLFromFile(modelFile).then(resolve).catch(reject);
        } else {
            reject(new Error(`Unsupported format: ${ext}`));
        }
    });
}

function loadGLBFromFile(file) {
    return new Promise((resolve, reject) => {
        const loader = new GLTFLoader();
        const url = URL.createObjectURL(file);

        loader.load(
            url,
            (gltf) => {
                setupLoadedModel(gltf.scene, file.name, 'y-up');
                URL.revokeObjectURL(url);
                resolve();
            },
            undefined,
            (error) => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to parse GLB: ' + error.message));
            }
        );
    });
}

function loadOBJFromFile(objFile, materialFiles) {
    return new Promise((resolve, reject) => {
        const objUrl = URL.createObjectURL(objFile);

        let mtlFile = null;
        const textureFiles = [];

        if (materialFiles && materialFiles.length > 0) {
            for (const f of materialFiles) {
                const fExt = f.name.split('.').pop().toLowerCase();
                if (fExt === 'mtl') {
                    mtlFile = f;
                } else {
                    textureFiles.push(f);
                }
            }
        }

        const textureUrlMap = {};
        for (const tf of textureFiles) {
            textureUrlMap[tf.name] = URL.createObjectURL(tf);
        }

        if (mtlFile) {
            const mtlReader = new FileReader();
            mtlReader.onload = (e) => {
                const mtlText = e.target.result;
                const loadingManager = new THREE.LoadingManager();
                loadingManager.setURLModifier((url) => {
                    const fileName = url.split('/').pop().split('\\').pop();
                    if (textureUrlMap[fileName]) return textureUrlMap[fileName];
                    return url;
                });

                const mtlLoader = new MTLLoader(loadingManager);
                const materials = mtlLoader.parse(mtlText, '');
                materials.preload();

                const objLoader = new OBJLoader(loadingManager);
                objLoader.setMaterials(materials);

                objLoader.load(
                    objUrl,
                    (obj) => {
                        obj.traverse((child) => {
                            if (child.isMesh && child.material && child.material.map) {
                                child.material.map.colorSpace = THREE.SRGBColorSpace;
                            }
                        });
                        setupLoadedModel(obj, objFile.name, 'z-up');
                        URL.revokeObjectURL(objUrl);
                        Object.values(textureUrlMap).forEach(u => URL.revokeObjectURL(u));
                        resolve();
                    },
                    undefined,
                    (error) => {
                        URL.revokeObjectURL(objUrl);
                        Object.values(textureUrlMap).forEach(u => URL.revokeObjectURL(u));
                        reject(new Error('Failed to load OBJ: ' + error.message));
                    }
                );
            };
            mtlReader.onerror = () => reject(new Error('Failed to read MTL file'));
            mtlReader.readAsText(mtlFile);
        } else {
            // No MTL — plain OBJ, possibly with texture
            const objLoader = new OBJLoader();
            objLoader.load(
                objUrl,
                (obj) => {
                    const texUrls = Object.values(textureUrlMap);
                    if (texUrls.length > 0) {
                        const textureLoader = new THREE.TextureLoader();
                        const texture = textureLoader.load(texUrls[0]);
                        texture.colorSpace = THREE.SRGBColorSpace;
                        obj.traverse((child) => {
                            if (child.isMesh) {
                                child.material = new THREE.MeshStandardMaterial({
                                    map: texture, roughness: 0.7, metalness: 0.0
                                });
                            }
                        });
                    }
                    setupLoadedModel(obj, objFile.name, 'z-up');
                    URL.revokeObjectURL(objUrl);
                    Object.values(textureUrlMap).forEach(u => URL.revokeObjectURL(u));
                    resolve();
                },
                undefined,
                (error) => {
                    URL.revokeObjectURL(objUrl);
                    reject(new Error('Failed to load OBJ: ' + error.message));
                }
            );
        }
    });
}

function loadPLYFromFile(plyFile, textureFile) {
    return new Promise((resolve, reject) => {
        const loader = new PLYLoader();
        const url = URL.createObjectURL(plyFile);

        loader.load(
            url,
            (geometry) => {
                geometry.computeVertexNormals();
                const hasColors = !!geometry.attributes.color;
                const hasUVs = !!geometry.attributes.uv;

                let material;
                if (textureFile && hasUVs) {
                    const texUrl = URL.createObjectURL(textureFile);
                    const textureLoader = new THREE.TextureLoader();
                    const texture = textureLoader.load(texUrl, () => URL.revokeObjectURL(texUrl));
                    texture.colorSpace = THREE.SRGBColorSpace;
                    texture.flipY = true;
                    material = new THREE.MeshStandardMaterial({
                        map: texture, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide
                    });
                } else {
                    material = new THREE.MeshStandardMaterial({
                        roughness: 0.7, metalness: 0.0,
                        vertexColors: hasColors,
                        color: hasColors ? 0xffffff : 0xcccccc,
                        side: THREE.DoubleSide
                    });
                }

                const mesh = new THREE.Mesh(geometry, material);
                const group = new THREE.Group();
                group.add(mesh);
                setupLoadedModel(group, plyFile.name, 'z-up');
                URL.revokeObjectURL(url);
                resolve();
            },
            undefined,
            (error) => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load PLY: ' + error.message));
            }
        );
    });
}

function loadSTLFromFile(stlFile) {
    return new Promise((resolve, reject) => {
        const loader = new STLLoader();
        const url = URL.createObjectURL(stlFile);

        loader.load(
            url,
            (geometry) => {
                geometry.computeVertexNormals();
                const hasColors = !!geometry.attributes.color;

                const material = new THREE.MeshStandardMaterial({
                    roughness: 0.7,
                    metalness: 0.0,
                    vertexColors: hasColors,
                    color: hasColors ? 0xffffff : 0xcccccc,
                    side: THREE.DoubleSide
                });

                const mesh = new THREE.Mesh(geometry, material);
                const group = new THREE.Group();
                group.add(mesh);
                setupLoadedModel(group, stlFile.name, 'z-up');
                URL.revokeObjectURL(url);
                resolve();
            },
            undefined,
            (error) => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load STL: ' + error.message));
            }
        );
    });
}

// ─── Annotation import (from File object) ──────────────────────
function importAnnotationFile(file) {
    // Use the existing import function which reads from a File
    importAnnotations(file);
}

// ─── Focus on annotation by UUID ───────────────────────────────
function focusOnAnnotation(uuid) {
    const ann = state.annotations.find(a => a.uuid === uuid);
    if (!ann || !ann.points || ann.points.length === 0) return;

    const center = new THREE.Vector3();
    ann.points.forEach(p => {
        const dp = toDisplayCoords(p);
        center.add(new THREE.Vector3(dp.x, dp.y, dp.z));
    });
    center.divideScalar(ann.points.length);

    state.controls.target.copy(center);
    state.camera.position.set(
        center.x + state.modelBoundingSize * 0.8,
        center.y + state.modelBoundingSize * 0.8,
        center.z + state.modelBoundingSize * 0.8
    );
    state.controls.update();

    // Highlight in sidebar
    state.selectedAnnotation = ann.id;
    updateGroupsList();
}

// ─── Viewer-specific sidebar click delegation ──────────────────
function initViewerGroupsDelegation() {
    // Single click: navigate camera to annotation
    // No double-click editing in viewer mode
    dom.groupsContainer.addEventListener('click', (e) => {
        const item = e.target.closest('.annotation-item');
        if (!item) return;

        const id = parseInt(item.dataset.id);
        const ann = state.annotations.find(a => a.id === id);
        if (!ann || !ann.points || ann.points.length === 0) return;

        state.selectedAnnotation = id;

        // Navigate camera
        const center = new THREE.Vector3();
        ann.points.forEach(p => {
            const dp = toDisplayCoords(p);
            center.add(new THREE.Vector3(dp.x, dp.y, dp.z));
        });
        center.divideScalar(ann.points.length);
        state.controls.target.copy(center);
        state.controls.update();

        // Update selection highlight
        dom.groupsContainer.querySelectorAll('.annotation-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
    });

    // Group visibility toggle
    dom.groupsContainer.addEventListener('click', (e) => {
        const action = e.target.dataset.action || e.target.closest('[data-action]')?.dataset.action;
        if (action !== 'visibility') return;

        const groupItem = e.target.closest('.group-item');
        if (!groupItem) return;

        const groupId = parseInt(groupItem.dataset.id);
        const group = state.groups.find(g => g.id === groupId);
        if (group) {
            group.visible = !group.visible;
            updateGroupsList();
            renderAnnotations();
        }
    });
}

// ─── Viewer-specific slider setup ──────────────────────────────
function initViewerSliders() {
    // Import needed functions inline to avoid circular deps
    import('./core/lighting.js').then(({ setBrightness, setModelOpacity, toggleLightMode, setFixedLightAzimuth, setFixedLightElevation }) => {
        // Brightness
        dom.brightnessSlider?.addEventListener('input', (e) => {
            setBrightness(parseInt(e.target.value));
            dom.brightnessValue.textContent = e.target.value + '%';
        });

        // Model opacity
        dom.opacitySlider?.addEventListener('input', (e) => {
            setModelOpacity(parseInt(e.target.value));
            dom.opacityValue.textContent = e.target.value + '%';
        });

        // Light toggle
        dom.lightToggle?.addEventListener('click', () => {
            toggleLightMode();
        });

        // Light direction sliders
        dom.lightAzimuthSlider?.addEventListener('input', (e) => {
            setFixedLightAzimuth(parseInt(e.target.value));
            dom.lightAzimuthValue.textContent = e.target.value + '°';
        });
        dom.lightElevationSlider?.addEventListener('input', (e) => {
            setFixedLightElevation(parseInt(e.target.value));
            dom.lightElevationValue.textContent = e.target.value + '°';
        });
    });

    // Camera toggle (perspective/orthographic)
    dom.cameraToggle?.addEventListener('click', () => {
        import('./core/camera.js').then(({ toggleCamera }) => {
            toggleCamera();
        });
    });

    // Flip toggle
    dom.flipToggle?.addEventListener('click', () => {
        import('./utils/helpers.js').then(({ toggleFlip }) => {
            if (typeof toggleFlip === 'function') {
                toggleFlip();
            } else {
                // Manual flip toggle if not exported from helpers
                state.isFlipped = !state.isFlipped;
                dom.flipToggle.classList.toggle('active', state.isFlipped);
                if (state.currentModel) {
                    const flipAngle = state.isFlipped ? Math.PI : 0;
                    const baseRotX = state.modelUpAxis === 'z-up' ? -Math.PI / 2 : 0;
                    state.currentModel.rotation.x = baseRotX;
                    state.currentModel.rotation.z = flipAngle;
                    state.currentModel.updateMatrixWorld(true);
                    renderAnnotations();
                }
            }
        });
    });

    // Sliders panel minimize toggle
    const panelToggle = document.getElementById('sliders-panel-toggle');
    const panelContent = document.getElementById('sliders-panel-content');
    if (panelToggle && panelContent) {
        panelToggle.addEventListener('click', () => {
            panelContent.classList.toggle('collapsed');
            panelToggle.textContent = panelContent.classList.contains('collapsed') ? '▲' : '▼';
        });
    }
}

// ─── Search filtering ──────────────────────────────────────────
function filterAnnotations(query) {
    if (!query) {
        dom.groupsContainer.querySelectorAll('.group-item, .annotation-item').forEach(el => {
            el.style.display = '';
        });
        return;
    }

    dom.groupsContainer.querySelectorAll('.annotation-item').forEach(item => {
        const name = item.querySelector('.name')?.textContent?.toLowerCase() || '';
        item.style.display = name.includes(query) ? '' : 'none';
    });

    // Hide empty groups
    dom.groupsContainer.querySelectorAll('.group-item').forEach(group => {
        const visibleItems = group.querySelectorAll('.annotation-item:not([style*="display: none"])');
        group.style.display = visibleItems.length > 0 ? '' : 'none';
    });
}

// ─── Start ─────────────────────────────────────────────────────
init();
