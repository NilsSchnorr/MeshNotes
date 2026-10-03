// js/core/model-loader.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { state, dom } from '../state.js';
import { getIcon } from '../ui/icons.js';
import { showStatus, updateFaceCountDisplay } from '../utils/helpers.js';
import { pointToZUp } from '../utils/coords.js';
import { updateViewHelperLabels } from './camera.js';
import { setModelOpacity } from './lighting.js';

// Set up decoders for compressed GLB/glTF files
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('vendor/draco/');

// Register BVH extensions for accelerated raycasting and spatial queries
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Face-count ceiling above which the wireframe display mode is unavailable.
//
// Three.js cannot reuse the triangle index buffer for wireframe rendering: it
// must build a separate line-index buffer, emitting 6 indices per face
// (three edges x two endpoints, undeduplicated) in updateWireframeAttribute().
// That buffer is accumulated into a plain JS array via push(), and V8 caps the
// backing store of a fast-mode array at roughly 134 million elements. Crossing
// it throws "RangeError: Invalid array length" from inside WebGLRenderer.render(),
// i.e. mid-frame, every frame, with no way to recover -- observed with a
// 27.19M-face model (27,194,950 x 6 = 163,169,700 entries).
//
// The engine cap alone would put the ceiling near 22.3M faces, but the typed
// array that follows (4 bytes per entry, plus an equal-sized GPU upload) makes
// anything approaching that unusable well before the RangeError: at 22M faces
// the index buffer alone is ~530 MB. The limit below is set lower so the mode
// is withdrawn while it is still merely slow rather than fatal, while staying
// clear of the photogrammetry scale MeshNotes targets.
//
// This is a single tunable number; raising it trades safety margin for reach.
export const WIREFRAME_FACE_LIMIT = 18000000;

/**
 * Whether wireframe display is safe for the currently loaded model.
 * @returns {boolean}
 */
export function isWireframeSupported() {
    return state.modelFaceCount <= WIREFRAME_FACE_LIMIT;
}

// Late-bound reference to updateModelInfoDisplay (set by sidebar.js to avoid circular deps)
let _updateModelInfoDisplay = null;
export function setUpdateModelInfoDisplay(fn) {
    _updateModelInfoDisplay = fn;
}

// One-shot completion hook for model setup. Used by the share/direct-link
// loader in main.js to start the annotation import exactly when setup
// (including the BVH build) finishes, instead of polling with a fixed
// timeout that large models can exceed. Consumed on success; cleared on
// setup failure so a stale hook can never fire against a later model.
let _onModelSetupComplete = null;
export function onceModelSetupComplete(callback) {
    _onModelSetupComplete = callback;
}

// Late-bound hook fired once the async model hash is known. Used by session
// persistence (set in main.js) to offer restoring an autosaved session for
// this exact model. Fires on every model load; the consumer decides whether to
// act (e.g. only into a fresh, share-free workspace).
let _onModelHashReady = null;
export function setModelHashReadyCallback(fn) {
    _onModelHashReady = fn;
}

// Counts model setups, so a hash that resolves after the next model was set
// up is dropped instead of being taken for that model's.
let _hashGeneration = 0;

// Late-bound hook fired when a new model is being set up, before it replaces
// the current one. Runs on every load path (file, share and direct links,
// which bypass the unsaved-work check), so work that belongs to the old model
// ends here: main.js closes the survey picking panel. A single slot: main.js
// composes everything that needs it.
let _onModelReplaced = null;
export function setModelReplacedCallback(fn) {
    _onModelReplaced = fn;
}

// Computes a SHA-256 hex digest of a File's bytes, used to bind exported
// annotations to the exact model they target. Returns null on failure.
async function computeModelHash(file) {
    try {
        const buf = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        console.warn('Model hash computation failed:', e);
        return null;
    }
}

export function loadModel(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    // Store file for model export
    state.loadedModelFiles = [file];

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

    if (ext === 'stl') {
        state.pendingStlFile = file;
        dom.stlDialogOverlay.classList.add('visible');
        return;
    }

    // GLB/GLTF path
    dom.loading.classList.add('visible');
    state.modelFileName = file.name;

    // Reset model info for new model
    state.modelInfo = { entries: [] };
    if (_updateModelInfoDisplay) _updateModelInfoDisplay();

    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.setMeshoptDecoder(MeshoptDecoder);
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
        _onModelSetupComplete = null; // Setup failed — don't fire the hook later against a different model
        console.error('Critical error during model setup:', error);
        dom.loading.classList.remove('visible');
        showStatus('Error setting up model - check console for details');
    }
}

function setupLoadedModelInternal(model, fileName, upAxis) {
    console.log(`setupLoadedModel: starting for "${fileName}" (upAxis: ${upAxis})`);
    console.time('setupLoadedModel');

    // The old model's picking session and the like end before it is replaced
    if (_onModelReplaced) _onModelReplaced();
    
    // Store the model's original up-axis for coordinate transforms in export/import
    state.modelUpAxis = upAxis || 'y-up';

    // Compute a SHA-256 of the primary model file for annotation/model binding.
    // Async: state.modelHash is populated when ready and read at export time.
    // (Skipped in viewer mode, where loadedModelFiles is not populated.)
    state.modelHash = null;
    // Cleared up front so a load that fails below never keeps the previous
    // model's centring offset (set again after the model is re-centred).
    state.modelFrameOrigin = null;
    const primaryModelFile = state.loadedModelFiles && state.loadedModelFiles[0];
    // While true, a null hash means "still hashing" (the Alignment Manager
    // says it is checking the model file); false with a null hash = unknown.
    state.modelHashPending = !!primaryModelFile;
    const hashGeneration = ++_hashGeneration;
    if (primaryModelFile) {
        computeModelHash(primaryModelFile).then(h => {
            if (hashGeneration !== _hashGeneration) return;     // another model was set up meanwhile
            state.modelHash = h;
            state.modelHashPending = false;
            if (_onModelHashReady) _onModelHashReady(h);
        });
    }
    
    // Reset flip state for new model
    state.isFlipped = false;
    if (dom.flipToggle) dom.flipToggle.classList.remove('active');

    if (state.currentModel) {
        // Dispose old model's GPU resources
        disposeObject3D(state.currentModel);
        state.scene.remove(state.currentModel);
        // Dispose cloned materials stored for display mode switching
        state.originalMaterials.forEach(mat => {
            const mats = Array.isArray(mat) ? mat : [mat];
            mats.forEach(m => m.dispose());
        });
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
    console.log('setupLoadedModel: model added to scene');

    state.originalMaterials.clear();
    state.modelMeshes = [];
    state.modelFaceCount = 0;
    state.hasVertexColors = false;
    let totalFaces = 0;
    let bvhBuildFailed = false;
    
    // First pass: count faces, store materials, check vertex colors
    state.currentModel.traverse((child) => {
        if (child.isMesh) {
            // child.material may be a single Material or an array (multi-material
            // meshes, e.g. OBJ objects with several usemtl groups). Clone
            // element-wise so multi-atlas models survive setup.
            state.originalMaterials.set(child.uuid, Array.isArray(child.material)
                ? child.material.map(m => m.clone())
                : child.material.clone());
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
    
    // Record the face count in state: the wireframe guard and any other
    // scale-dependent feature reads it from there rather than recounting.
    state.modelFaceCount = totalFaces;

    console.log(`setupLoadedModel: traversal complete — ${state.modelMeshes.length} meshes, ${totalFaces.toLocaleString()} faces, vertexColors: ${state.hasVertexColors}`);
    
    // Check WebGL context before proceeding with expensive operations
    const gl = state.renderer.getContext();
    if (gl.isContextLost()) {
        console.error('WebGL context was lost during model upload to GPU!');
        dom.loading.classList.remove('visible');
        showStatus('WebGL context lost — model too large for GPU.');
        _onModelSetupComplete = null; // Failure: don't fire the hook against a later model
        return;
    }
    console.log('setupLoadedModel: WebGL context OK after geometry upload');
    
    // Build BVH trees separately with error handling
    // BVH is required for surface tools and efficient raycasting.
    // DELIBERATE: the limit is disabled (Infinity). Without a BVH, every
    // raycast (annotation clicks, surface brush, box placement) brute-forces
    // all triangles, which is unusable at the 10M-face photogrammetry scale
    // MeshNotes targets. The trade-off — a one-time build at load (seconds,
    // behind the loading UI) plus index memory — is accepted.
    // (Historical value: 5000000.)
    //
    // A BVH build can fail INDEPENDENTLY of GPU capacity: it needs one
    // contiguous host-side ArrayBuffer, and that request can be refused while
    // the very same geometry uploads and renders without trouble. A
    // 27.19M-face model did exactly that against three-mesh-bvh 0.8.0, which
    // over-allocated the triangle bounds buffer 4x (2.43 GiB instead of
    // 622 MiB); upstream fixed it in 0.8.2, which is the vendored version.
    // So the try/catch below — not a face-count ceiling — is what makes this
    // safe: a failed build degrades to brute-force raycasting (and disables
    // label occlusion via state.bvhAvailable) instead of aborting the load.
    const BVH_FACE_LIMIT = Infinity;
    
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

    // Record BVH availability for features that depend on fast raycasting (e.g. label occlusion)
    state.bvhAvailable = !bvhBuildFailed;

    // Display face count
    updateFaceCountDisplay(totalFaces);
    
    // Validate model has actual geometry
    if (state.modelMeshes.length === 0) {
        console.error('Model contains no meshes!');
        dom.loading.classList.remove('visible');
        showStatus('Error: Model contains no renderable geometry');
        _onModelSetupComplete = null; // Failure: don't fire the hook against a later model
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
        _onModelSetupComplete = null; // Failure: don't fire the hook against a later model
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

    // Keep the centring offset in the Z-up export frame (full precision):
    // exported coordinate + modelFrameOrigin = the model's scene coordinate
    // in Z-up. Box3.setFromObject() uses matrixWorld, so glTF node transforms
    // are included. Kept for the export (meshnotes:frameOrigin), so a survey
    // fit can later be related to the model file's own coordinates.
    const frameOrigin = pointToZUp(center);
    state.modelFrameOrigin = { x: frameOrigin.x, y: frameOrigin.y, z: frameOrigin.z };
    
    // Update camera clipping planes based on model size
    // Near: small fraction of model size (but not too small to avoid z-fighting)
    // Far: large multiple of model size to ensure the entire scene is visible
    const nearPlane = Math.max(0.001, state.modelBoundingSize * 0.0001);
    const farPlane = state.modelBoundingSize * 100;
    
    state.perspectiveCamera.near = nearPlane;
    state.perspectiveCamera.far = farPlane;
    state.perspectiveCamera.updateProjectionMatrix();
    
    state.orthographicCamera.near = nearPlane;
    state.orthographicCamera.far = farPlane;
    state.orthographicCamera.updateProjectionMatrix();
    
    console.log(`setupLoadedModel: clipping planes set to near=${nearPlane.toFixed(4)}, far=${farPlane.toFixed(1)}`);
    
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
    if (dom.btnImportSurvey) dom.btnImportSurvey.disabled = false;   // Import > Survey points (CSV)
    // Enable share generate buttons (Share dialog itself is always accessible)
    const shareGenBtn = document.getElementById('share-generate-btn');
    const longtermGenBtn = document.getElementById('longterm-generate-btn');
    if (shareGenBtn) shareGenBtn.disabled = false;
    if (longtermGenBtn) longtermGenBtn.disabled = false;
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

    // Final WebGL context check after all setup is complete
    const glFinal = state.renderer.getContext();
    if (glFinal.isContextLost()) {
        console.error('WebGL context was lost during model setup! Model will not render.');
        showStatus('WebGL context lost during setup — model may be too large for GPU.');
    }
    
    dom.loading.classList.remove('visible');
    showStatus(`Loaded: ${fileName}`);

    // Update ViewHelper labels to match the model's coordinate system
    updateViewHelperLabels();
    
    console.timeEnd('setupLoadedModel');
    console.log(`setupLoadedModel: complete for "${fileName}"`);

    // Notify the one-shot completion hook (share/direct-link annotation import)
    if (_onModelSetupComplete) {
        const cb = _onModelSetupComplete;
        _onModelSetupComplete = null;
        cb();
    }
}

export function loadOBJModel(objFile, materialFiles, upAxis) {
    // Store files for model export
    state.loadedModelFiles = [objFile, ...(materialFiles || [])];

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
                    console.log('OBJ file parsed (with materials), setting up model...');
                    obj.traverse((child) => {
                        if (child.isMesh && child.material) {
                            const mats = Array.isArray(child.material) ? child.material : [child.material];
                            mats.forEach(mat => {
                                if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
                            });
                        }
                    });
                    setupLoadedModel(obj, objFile.name, upAxis);
                    URL.revokeObjectURL(objUrl);
                    Object.values(textureUrlMap).forEach(u => URL.revokeObjectURL(u));
                },
                (progress) => {
                    if (progress.lengthComputable) {
                        const percent = Math.round((progress.loaded / progress.total) * 100);
                        console.log(`Loading OBJ: ${percent}%`);
                    } else {
                        console.log(`Loading OBJ: ${(progress.loaded / 1024 / 1024).toFixed(1)} MB loaded...`);
                    }
                },
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
            console.log('OBJ file parsed (plain), setting up model...');
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
        (progress) => {
            if (progress.lengthComputable) {
                const percent = Math.round((progress.loaded / progress.total) * 100);
                console.log(`Loading OBJ: ${percent}%`);
            } else {
                console.log(`Loading OBJ: ${(progress.loaded / 1024 / 1024).toFixed(1)} MB loaded...`);
            }
        },
        (error) => {
            console.error('Error loading OBJ:', error);
            dom.loading.classList.remove('visible');
            showStatus('Error loading OBJ model!');
        }
    );
}

export function loadPLYModel(plyFile, textureFile, upAxis) {
    // Store files for model export
    state.loadedModelFiles = [plyFile, ...(textureFile ? [textureFile] : [])];

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

export function loadSTLModel(stlFile, upAxis) {
    // Store file for model export
    state.loadedModelFiles = [stlFile];

    dom.loading.classList.add('visible');
    state.modelFileName = stlFile.name;
    state.modelInfo = { entries: [] };
    if (_updateModelInfoDisplay) _updateModelInfoDisplay();

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

            setupLoadedModel(group, stlFile.name, upAxis);
            URL.revokeObjectURL(url);
        },
        undefined,
        (error) => {
            console.error('Error loading STL:', error);
            dom.loading.classList.remove('visible');
            showStatus('Error loading STL model!');
        }
    );
}

export function toggleTexture() {
    if (!state.currentModel) return;

    // Wireframe is skipped entirely on models past WIREFRAME_FACE_LIMIT: the
    // line-index buffer Three.js would have to build is large enough to abort
    // the render loop (see the constant's note). Mesh then cycles straight
    // back to Texture.
    const wireframeBlocked = !isWireframeSupported();

    if (state.displayMode === 'texture') {
        state.displayMode = state.hasVertexColors ? 'vertexColors' : 'mesh';
    } else if (state.displayMode === 'vertexColors') {
        state.displayMode = 'mesh';
    } else if (state.displayMode === 'mesh') {
        state.displayMode = wireframeBlocked ? 'texture' : 'wireframe';
    } else {
        state.displayMode = 'texture';
    }

    applyDisplayMode();
    updateTextureButtonLabel();

    const modeLabels = {
        'texture': 'Texture',
        'vertexColors': 'Vertex Colors',
        'mesh': 'Mesh',
        'wireframe': 'Wireframe'
    };

    if (wireframeBlocked && state.displayMode === 'texture') {
        const millions = (state.modelFaceCount / 1000000).toFixed(1);
        const limitMillions = (WIREFRAME_FACE_LIMIT / 1000000).toFixed(0);
        showStatus(`Display: Texture — Wireframe unavailable above ${limitMillions}M faces (model has ${millions}M)`);
    } else {
        showStatus(`Display: ${modeLabels[state.displayMode]}`);
    }
}

export function applyDisplayMode() {
    if (!state.currentModel) return;

    state.currentModel.traverse((child) => {
        if (child.isMesh) {
            const original = state.originalMaterials.get(child.uuid);

            // Dispose the material(s) about to be replaced. Materials only —
            // texture maps are shared by reference with the originalMaterials
            // snapshot (clone() shares maps) and are disposed on model swap,
            // so they must NOT be disposed here.
            const disposeCurrent = () => {
                const old = Array.isArray(child.material) ? child.material : [child.material];
                old.forEach(m => m.dispose());
            };

            if (state.displayMode === 'texture') {
                if (original) {
                    disposeCurrent();
                    // Original may be a material array (multi-material mesh).
                    if (Array.isArray(original)) {
                        child.material = original.map(m => {
                            const c = m.clone();
                            c.vertexColors = false;
                            return c;
                        });
                    } else {
                        child.material = original.clone();
                        child.material.vertexColors = false;
                    }
                }
            } else if (state.displayMode === 'vertexColors') {
                disposeCurrent();
                child.material = new THREE.MeshStandardMaterial({
                    vertexColors: true,
                    roughness: 0.7,
                    metalness: 0.0
                });
            } else if (state.displayMode === 'wireframe') {
                disposeCurrent();
                child.material = new THREE.MeshBasicMaterial({
                    color: new THREE.Color(state.wireframeColor),
                    wireframe: true
                });
            } else {
                // Mesh mode (solid color, no texture)
                disposeCurrent();
                child.material = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(state.meshColor),
                    roughness: 0.7,
                    metalness: 0.0
                });
            }

            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
                mat.transparent = true;
                mat.opacity = state.modelOpacity;
                mat.depthWrite = state.modelOpacity > 0.9;
            });
        }
    });
}

export function updateTextureButtonLabel() {
    const labels = {
        'texture': { icon: 'texture', text: 'Texture' },
        'vertexColors': { icon: 'color', text: 'Colors' },
        'mesh': { icon: 'mesh', text: 'Mesh' },
        'wireframe': { icon: 'wireframe', text: 'Wireframe' }
    };
    const mode = labels[state.displayMode] || labels['texture'];
    const svg = getIcon(mode.icon);
    dom.btnTexture.innerHTML = (svg ? `<span class="btn-texture-icon">${svg}</span>` : '') + `<span class="btn-texture-label">${mode.text}</span>`;
    // All display modes use default blue button background
    dom.btnTexture.classList.remove('active');
}
