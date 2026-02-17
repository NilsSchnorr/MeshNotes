// js/core/model-loader.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { state, dom } from '../state.js';
import { showStatus, updateFaceCountDisplay } from '../utils/helpers.js';
import { updateViewHelperLabels } from './camera.js';
import { setModelOpacity } from './lighting.js';

// Register BVH extensions for accelerated raycasting and spatial queries
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Late-bound reference to updateModelInfoDisplay (set by sidebar.js to avoid circular deps)
let _updateModelInfoDisplay = null;
export function setUpdateModelInfoDisplay(fn) {
    _updateModelInfoDisplay = fn;
}

export function loadModel(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'obj') {
        state.pendingObjFile = file;
        dom.objDialogOverlay.classList.add('visible');
        return;
    }

    if (ext === 'ply') {
        state.pendingPlyFile = file;
        dom.plyDialogOverlay.classList.add('visible');
        return;
    }

    // GLB/GLTF path
    dom.loading.classList.add('visible');
    state.modelFileName = file.name;

    // Reset model info for new model
    state.modelInfo = { entries: [] };
    if (_updateModelInfoDisplay) _updateModelInfoDisplay();

    const loader = new GLTFLoader();
    const url = URL.createObjectURL(file);

    loader.load(
        url,
        (gltf) => {
            console.log('GLB/GLTF file parsed, setting up model...');
            // glTF/GLB spec mandates Y-up, no user choice needed
            setupLoadedModel(gltf.scene, file.name, 'y-up');
            URL.revokeObjectURL(url);
        },
        (progress) => {
            // Progress callback for large files
            if (progress.lengthComputable) {
                const percent = Math.round((progress.loaded / progress.total) * 100);
                console.log(`Loading: ${percent}%`);
            }
        },
        (error) => {
            console.error('Error loading model:', error);
            dom.loading.classList.remove('visible');
            showStatus('Error loading model!');
        }
    );
}

export function disposeObject3D(obj) {
    if (!obj) return;
    obj.traverse((child) => {
        if (child.geometry) {
            if (child.geometry.boundsTree) {
                child.geometry.disposeBoundsTree();
            }
            child.geometry.dispose();
        }
        if (child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach(mat => {
                if (mat.map) mat.map.dispose();
                if (mat.normalMap) mat.normalMap.dispose();
                if (mat.roughnessMap) mat.roughnessMap.dispose();
                if (mat.metalnessMap) mat.metalnessMap.dispose();
                if (mat.aoMap) mat.aoMap.dispose();
                if (mat.emissiveMap) mat.emissiveMap.dispose();
                mat.dispose();
            });
        }
    });
}

export function setupLoadedModel(model, fileName, upAxis) {
    try {
        setupLoadedModelInternal(model, fileName, upAxis);
    } catch (error) {
        console.error('Critical error during model setup:', error);
        dom.loading.classList.remove('visible');
        showStatus('Error setting up model - check console for details');
    }
}

function setupLoadedModelInternal(model, fileName, upAxis) {
    // Store the model's original up-axis for coordinate transforms in export/import
    state.modelUpAxis = upAxis || 'y-up';

    if (state.currentModel) {
        // Dispose old model's GPU resources
        disposeObject3D(state.currentModel);
        state.scene.remove(state.currentModel);
        // Dispose cloned materials stored for display mode switching
        state.originalMaterials.forEach(mat => mat.dispose());
    }

    const grid = state.scene.getObjectByName('gridHelper');
    if (grid) state.scene.remove(grid);

    // If the model uses Z-up, rotate into Three.js Y-up space
    if (state.modelUpAxis === 'z-up') {
        model.rotation.x = -Math.PI / 2;
        model.updateMatrixWorld(true);
    }

    state.currentModel = model;
    state.scene.add(state.currentModel);

    state.originalMaterials.clear();
    state.modelMeshes = [];
    state.hasVertexColors = false;
    let totalFaces = 0;
    let bvhBuildFailed = false;
    
    // First pass: count faces, store materials, check vertex colors
    state.currentModel.traverse((child) => {
        if (child.isMesh) {
            state.originalMaterials.set(child.uuid, child.material.clone());
            state.modelMeshes.push(child);

            // Check for vertex colors
            if (child.geometry.attributes.color) {
                state.hasVertexColors = true;
            }

            // Count faces
            const geometry = child.geometry;
            if (geometry.index) {
                totalFaces += geometry.index.count / 3;
            } else if (geometry.attributes.position) {
                totalFaces += geometry.attributes.position.count / 3;
            }
        }
    });
    
    // Build BVH trees separately with error handling
    // BVH is required for surface tools and efficient raycasting
    const BVH_FACE_LIMIT = 5000000; // Skip BVH for extremely large models
    
    if (totalFaces > BVH_FACE_LIMIT) {
        console.warn(`Model has ${totalFaces.toLocaleString()} faces - skipping BVH for performance. Surface tools may be slower.`);
        showStatus(`Large model loaded (${(totalFaces/1000000).toFixed(1)}M faces) - some tools may be slower`);
        bvhBuildFailed = true;
    } else {
        for (const mesh of state.modelMeshes) {
            try {
                if (!mesh.geometry.boundsTree) {
                    mesh.geometry.computeBoundsTree();
                }
            } catch (error) {
                console.error('BVH computation failed for mesh:', mesh.name || 'unnamed', error);
                bvhBuildFailed = true;
                // Continue without BVH for this mesh - raycasting will still work, just slower
            }
        }
        
        if (bvhBuildFailed) {
            console.warn('BVH build failed for one or more meshes. Raycasting will use standard (slower) method.');
        }
    }

    // Display face count
    updateFaceCountDisplay(totalFaces);
    
    // Validate model has actual geometry
    if (state.modelMeshes.length === 0) {
        console.error('Model contains no meshes!');
        dom.loading.classList.remove('visible');
        showStatus('Error: Model contains no renderable geometry');
        return;
    }

    // Center and fit with validation
    const box = new THREE.Box3().setFromObject(state.currentModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    // Validate bounding box - can be empty or NaN for corrupt/empty models
    if (box.isEmpty() || !isFinite(size.x) || !isFinite(size.y) || !isFinite(size.z)) {
        console.error('Model has invalid bounding box:', { isEmpty: box.isEmpty(), size });
        dom.loading.classList.remove('visible');
        showStatus('Error: Model geometry is empty or invalid');
        return;
    }
    
    const maxDim = Math.max(size.x, size.y, size.z);
    
    // Guard against zero-size models (points only, or degenerate geometry)
    if (maxDim === 0 || !isFinite(maxDim)) {
        console.error('Model has zero or invalid size:', maxDim);
        state.modelBoundingSize = 1; // Use fallback size
    } else {
        state.modelBoundingSize = maxDim;
    }

    state.currentModel.position.sub(center);
    state.camera.position.set(state.modelBoundingSize * 1.5, state.modelBoundingSize * 1.5, state.modelBoundingSize * 1.5);
    state.controls.target.set(0, 0, 0);
    state.controls.update();
    
    console.log(`Model loaded: ${state.modelMeshes.length} meshes, ${totalFaces.toLocaleString()} faces, size: ${state.modelBoundingSize.toFixed(3)}`);

    // Enable tools
    dom.btnTexture.disabled = false;
    dom.btnPoint.disabled = false;
    dom.btnLine.disabled = false;
    dom.btnPolygon.disabled = false;
    dom.btnSurface.disabled = false;
    dom.btnBox.disabled = false;
    dom.btnMeasure.disabled = false;
    dom.btnScreenshot.disabled = false;
    dom.btnExport.disabled = false;
    dom.btnExportPdf.disabled = false;
    state.displayMode = 'texture';
    updateTextureButtonLabel();

    // Apply display mode to fix vertex color multiplicative issue on first load
    applyDisplayMode();

    if (state.hasVertexColors) {
        console.log('Vertex colors detected in model');
    }

    // Apply current opacity setting
    if (state.modelOpacity < 1.0) {
        setModelOpacity(parseInt(dom.opacitySlider.value));
    }

    dom.loading.classList.remove('visible');
    showStatus(`Loaded: ${fileName}`);

    // Update ViewHelper labels to match the model's coordinate system
    updateViewHelperLabels();
}

export function loadOBJModel(objFile, materialFiles, upAxis) {
    dom.loading.classList.add('visible');
    state.modelFileName = objFile.name;

    state.modelInfo = { entries: [] };
    if (_updateModelInfoDisplay) _updateModelInfoDisplay();

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
                if (textureUrlMap[fileName]) {
                    return textureUrlMap[fileName];
                }
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
                        if (child.isMesh && child.material) {
                            const mat = child.material;
                            if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
                        }
                    });
                    setupLoadedModel(obj, objFile.name, upAxis);
                    URL.revokeObjectURL(objUrl);
                    Object.values(textureUrlMap).forEach(u => URL.revokeObjectURL(u));
                },
                undefined,
                (error) => {
                    console.error('Error loading OBJ:', error);
                    dom.loading.classList.remove('visible');
                    showStatus('Error loading OBJ model!');
                }
            );
        };
        mtlReader.onerror = () => {
            console.error('Error reading MTL file');
            showStatus('MTL failed, loading OBJ without materials...');
            loadOBJPlain(objUrl, textureUrlMap, objFile.name, upAxis);
        };
        mtlReader.readAsText(mtlFile);
    } else if (textureFiles.length > 0) {
        loadOBJPlain(objUrl, textureUrlMap, objFile.name, upAxis);
    } else {
        loadOBJPlain(objUrl, {}, objFile.name, upAxis);
    }
}

export function loadOBJPlain(objUrl, textureUrlMap, fileName, upAxis) {
    const objLoader = new OBJLoader();

    objLoader.load(
        objUrl,
        (obj) => {
            const textureUrls = Object.values(textureUrlMap);
            if (textureUrls.length > 0) {
                const textureLoader = new THREE.TextureLoader();
                const texture = textureLoader.load(textureUrls[0]);
                texture.colorSpace = THREE.SRGBColorSpace;

                obj.traverse((child) => {
                    if (child.isMesh) {
                        child.material = new THREE.MeshStandardMaterial({
                            map: texture,
                            roughness: 0.7,
                            metalness: 0.0
                        });
                    }
                });
            }

            setupLoadedModel(obj, fileName, upAxis);
            URL.revokeObjectURL(objUrl);
            Object.values(textureUrlMap).forEach(u => URL.revokeObjectURL(u));
        },
        undefined,
        (error) => {
            console.error('Error loading OBJ:', error);
            dom.loading.classList.remove('visible');
            showStatus('Error loading OBJ model!');
        }
    );
}

export function loadPLYModel(plyFile, textureFile, upAxis) {
    dom.loading.classList.add('visible');
    state.modelFileName = plyFile.name;
    state.modelInfo = { entries: [] };
    if (_updateModelInfoDisplay) _updateModelInfoDisplay();

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
                const texture = textureLoader.load(texUrl, () => {
                    URL.revokeObjectURL(texUrl);
                });
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.flipY = true;

                material = new THREE.MeshStandardMaterial({
                    map: texture,
                    roughness: 0.7,
                    metalness: 0.0,
                    side: THREE.DoubleSide
                });
            } else if (textureFile && !hasUVs) {
                showStatus('Warning: PLY has no UV coordinates — texture ignored');
                material = new THREE.MeshStandardMaterial({
                    roughness: 0.7,
                    metalness: 0.0,
                    vertexColors: hasColors,
                    color: hasColors ? 0xffffff : 0xcccccc,
                    side: THREE.DoubleSide
                });
            } else {
                material = new THREE.MeshStandardMaterial({
                    roughness: 0.7,
                    metalness: 0.0,
                    vertexColors: hasColors,
                    color: hasColors ? 0xffffff : 0xcccccc,
                    side: THREE.DoubleSide
                });
            }

            const mesh = new THREE.Mesh(geometry, material);
            const group = new THREE.Group();
            group.add(mesh);

            setupLoadedModel(group, plyFile.name, upAxis);
            URL.revokeObjectURL(url);
        },
        undefined,
        (error) => {
            console.error('Error loading PLY:', error);
            dom.loading.classList.remove('visible');
            showStatus('Error loading PLY model!');
        }
    );
}

export function toggleTexture() {
    if (!state.currentModel) return;

    if (state.displayMode === 'texture') {
        state.displayMode = state.hasVertexColors ? 'vertexColors' : 'gray';
    } else if (state.displayMode === 'vertexColors') {
        state.displayMode = 'gray';
    } else if (state.displayMode === 'gray') {
        state.displayMode = 'wireframe';
    } else {
        state.displayMode = 'texture';
    }

    applyDisplayMode();
    updateTextureButtonLabel();

    const modeLabels = {
        'texture': 'Texture',
        'vertexColors': 'Vertex Colors',
        'gray': 'Gray',
        'wireframe': 'Wireframe'
    };
    showStatus(`Display: ${modeLabels[state.displayMode]}`);
}

export function applyDisplayMode() {
    if (!state.currentModel) return;

    state.currentModel.traverse((child) => {
        if (child.isMesh) {
            const original = state.originalMaterials.get(child.uuid);

            if (state.displayMode === 'texture') {
                if (original) {
                    child.material = original.clone();
                    child.material.vertexColors = false;
                }
            } else if (state.displayMode === 'vertexColors') {
                child.material = new THREE.MeshStandardMaterial({
                    vertexColors: true,
                    roughness: 0.7,
                    metalness: 0.0
                });
            } else if (state.displayMode === 'wireframe') {
                // Gold accent color: rgb(170, 129, 1)
                child.material = new THREE.MeshBasicMaterial({
                    color: 0xaa8101,
                    wireframe: true
                });
            } else {
                // Gray mode
                child.material = new THREE.MeshStandardMaterial({
                    color: 0x888888,
                    roughness: 0.7,
                    metalness: 0.0
                });
            }

            child.material.transparent = true;
            child.material.opacity = state.modelOpacity;
            child.material.depthWrite = state.modelOpacity > 0.9;
        }
    });
}

export function updateTextureButtonLabel() {
    const labels = {
        'texture': '🖼️ Texture',
        'vertexColors': '🎨 Colors',
        'gray': '⬜ Gray',
        'wireframe': '🔲 Wireframe'
    };
    dom.btnTexture.innerHTML = labels[state.displayMode] || '🖼️ Texture';
    dom.btnTexture.classList.toggle('active', state.displayMode !== 'texture');
}
