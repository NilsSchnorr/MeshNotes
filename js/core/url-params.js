// js/core/url-params.js - URL parameter parsing and share loading
// 
// Handles three URL modes:
//   1. Ephemeral share:  ?share=abc123 [&annotation=uuid]
//   2. Direct URLs:      ?model=URL&annotations=URL [&annotation=uuid]
//   3. No params:        Normal editor with local file loading
//
// Imported by main.js (index.html, the editor).

const SHARE_API_BASE = '/api/share';

/**
 * Parse URL parameters and return a structured config object.
 * Call this once on page load.
 * 
 * @returns {Object} config with:
 *   - mode: 'share' | 'direct' | 'local'
 *   - shareId: string | null (only if mode === 'share')
 *   - modelUrl: string | null (only if mode === 'direct')
 *   - annotationsUrl: string | null (only if mode === 'direct')
 *   - focusAnnotation: string | null (UUID to navigate to after load)
 */
export function parseUrlParams() {
    const params = new URLSearchParams(window.location.search);

    const shareId = params.get('share');
    const modelUrl = params.get('model');
    const annotationsUrl = params.get('annotations');
    const focusAnnotation = params.get('annotation');

    if (shareId) {
        return {
            mode: 'share',
            shareId,
            modelUrl: null,
            annotationsUrl: null,
            focusAnnotation: focusAnnotation || null
        };
    }

    if (modelUrl) {
        return {
            mode: 'direct',
            shareId: null,
            // Note: URLSearchParams.get() already percent-decodes. Do NOT
            // decode again — URLs containing literal %xx (presigned URLs,
            // encoded filenames) would be corrupted by a second decode.
            modelUrl: modelUrl,
            annotationsUrl: annotationsUrl || null,
            focusAnnotation: focusAnnotation || null
        };
    }

    return {
        mode: 'local',
        shareId: null,
        modelUrl: null,
        annotationsUrl: null,
        focusAnnotation: focusAnnotation || null
    };
}

/**
 * Fetch the manifest for an ephemeral share.
 * Returns the manifest object or throws on error.
 * 
 * @param {string} shareId 
 * @returns {Promise<Object>} manifest with: shareId, format, files, hasAnnotations, createdAt, expiresAt
 */
export async function fetchShareManifest(shareId) {
    const url = `${SHARE_API_BASE}/${shareId}/manifest.json`;
    const response = await fetch(url);

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('expired');
        }
        throw new Error(`Failed to fetch share manifest: ${response.status}`);
    }

    return response.json();
}

/**
 * Fetch a single file from an ephemeral share as a Blob.
 * 
 * @param {string} shareId 
 * @param {string} filename 
 * @returns {Promise<Blob>}
 */
export async function fetchShareFile(shareId, filename) {
    const url = `${SHARE_API_BASE}/${shareId}/${encodeURIComponent(filename)}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to fetch file "${filename}": ${response.status}`);
    }

    return response.blob();
}

const MODEL_FORMATS = ['glb', 'gltf', 'obj', 'ply', 'stl'];

const extensionOf = (name) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
};

/**
 * The file name a download URL carries, or null. Zenodo's working form
 * .../files/<name>/content gives <name>; any other URL whose last path part
 * has an extension gives that part. Both percent-decoded. Figshare's
 * ndownloader.figshare.com/files/<id> carries none.
 * @param {string} url
 * @returns {string|null}
 */
export function fileNameFromUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    let path;
    try {
        path = new URL(url).pathname;
    } catch (e) {
        path = url.split('#')[0].split('?')[0];
    }
    const decode = (part) => { try { return decodeURIComponent(part); } catch (e) { return part; } };
    const parts = path.split('/').filter(Boolean);
    const n = parts.length;
    if (n >= 3 && parts[n - 1] === 'content' && parts[n - 3] === 'files') {
        return decode(parts[n - 2]) || null;
    }
    const last = n > 0 ? decode(parts[n - 1]) : '';
    return extensionOf(last) ? last : null;
}

/**
 * The name a model loaded from a direct link gets: the name in its URL, else
 * the model name the link's annotation file records (modelSource
 * schema:name) when its extension fits the format, else model.<format>.
 * @param {{modelUrl: string, format: string, storedName?: string|null}} options
 * @returns {string}
 */
export function modelFileNameFor({ modelUrl, format, storedName = null }) {
    const fromUrl = fileNameFromUrl(modelUrl);
    if (fromUrl) return fromUrl;
    const fits = format === 'glb' ? ['glb', 'gltf'] : [format];
    if (typeof storedName === 'string' && storedName.trim() && fits.includes(extensionOf(storedName))) {
        return storedName.trim();
    }
    return `model.${format === 'glb' ? 'glb' : format}`;
}

// modelSource schema:name of an annotation file, or null.
async function storedModelName(blob) {
    try {
        const data = JSON.parse(await blob.text());
        const name = data && data.modelSource && data.modelSource['schema:name'];
        return typeof name === 'string' ? name : null;
    } catch (e) {
        return null;
    }
}

/**
 * Fetch a file from a direct URL as a Blob.
 * Used for DOI / long-term share links.
 * 
 * @param {string} url 
 * @returns {Promise<Blob>}
 */
export async function fetchDirectFile(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    return response.blob();
}

/**
 * Convert a Blob to a File object (needed by the existing Three.js loaders).
 * 
 * @param {Blob} blob 
 * @param {string} filename 
 * @returns {File}
 */
export function blobToFile(blob, filename) {
    return new File([blob], filename, { type: blob.type });
}

/**
 * Load all files for an ephemeral share and return them as File objects.
 * Groups them by role: model files, annotation file, and the manifest.
 * 
 * @param {string} shareId 
 * @returns {Promise<Object>} with:
 *   - manifest: the manifest object
 *   - modelFile: File (the main model file: .glb, .obj, or .ply)
 *   - materialFiles: File[] (MTL and texture files for OBJ, or texture for PLY)
 *   - annotationFile: File | null (the JSON-LD file)
 *   - format: 'glb' | 'obj' | 'ply'
 */
export async function loadShareFiles(shareId) {
    const manifest = await fetchShareManifest(shareId);

    const modelExtensions = ['glb', 'obj', 'ply', 'stl'];
    const annotationExtensions = ['jsonld', 'json'];

    let modelFile = null;
    const materialFiles = [];
    let annotationFile = null;

    // Fetch all files in parallel
    const filePromises = manifest.files.map(async (filename) => {
        const blob = await fetchShareFile(shareId, filename);
        const file = blobToFile(blob, filename);
        const ext = filename.split('.').pop().toLowerCase();

        return { file, ext, filename };
    });

    const fetchedFiles = await Promise.all(filePromises);

    for (const { file, ext } of fetchedFiles) {
        if (modelExtensions.includes(ext)) {
            modelFile = file;
        } else if (annotationExtensions.includes(ext)) {
            annotationFile = file;
        } else {
            // MTL, JPG, PNG, TIF etc. — material/texture files
            materialFiles.push(file);
        }
    }

    if (!modelFile) {
        throw new Error('Share does not contain a model file');
    }

    return {
        manifest,
        modelFile,
        materialFiles,
        annotationFile,
        format: manifest.format || modelFile.name.split('.').pop().toLowerCase()
    };
}

/**
 * Load model and annotation files from direct URLs.
 * The model URL may point to a single file (GLB, PLY) or the main OBJ file.
 * For OBJ, additional material URLs can be provided via ?mtl=URL&texture=URL params.
 * 
 * @param {string} modelUrl 
 * @param {string|null} annotationsUrl 
 * @returns {Promise<Object>} same shape as loadShareFiles return value
 */
export async function loadDirectFiles(modelUrl, annotationsUrl) {
    // Determine format from URL or ?format= parameter
    const params = new URLSearchParams(window.location.search);
    const formatParam = params.get('format');
    
    // The file name in the URL (Zenodo's .../files/<name>/content included).
    const urlExt = extensionOf(fileNameFromUrl(modelUrl));

    // Priority: explicit format param > URL extension > default to glb
    let format;
    if (formatParam && MODEL_FORMATS.includes(formatParam)) {
        format = formatParam === 'gltf' ? 'glb' : formatParam;
    } else if (urlExt && MODEL_FORMATS.includes(urlExt)) {
        format = ['glb', 'gltf'].includes(urlExt) ? 'glb' : urlExt;
    } else {
        format = 'glb'; // Default assumption
    }

    // Fetch model
    const modelBlob = await fetchDirectFile(modelUrl);

    // Fetch annotations if provided
    let annotationFile = null;
    let storedName = null;
    if (annotationsUrl) {
        const annFilename = fileNameFromUrl(annotationsUrl) || 'annotations.jsonld';
        const annBlob = await fetchDirectFile(annotationsUrl);
        annotationFile = blobToFile(annBlob, annFilename);
        storedName = await storedModelName(annBlob);
    }

    // The model keeps its real name: from the URL, else from the annotation
    // file, else model.<format> (modelFileNameFor()). Everything that shows or
    // writes the model's name reads it from this file.
    const modelFile = blobToFile(modelBlob, modelFileNameFor({ modelUrl, format, storedName }));

    // For OBJ, check for optional mtl/texture params
    const materialFiles = [];

    const mtlUrl = params.get('mtl');
    if (mtlUrl) {
        // params.get() already decoded the value — use it as-is.
        const mtlFilename = fileNameFromUrl(mtlUrl) || mtlUrl.split('/').pop().split('?')[0];
        const mtlBlob = await fetchDirectFile(mtlUrl);
        materialFiles.push(blobToFile(mtlBlob, mtlFilename));
    }

    const textureUrl = params.get('texture');
    if (textureUrl) {
        const texFilename = fileNameFromUrl(textureUrl) || textureUrl.split('/').pop().split('?')[0];
        const texBlob = await fetchDirectFile(textureUrl);
        materialFiles.push(blobToFile(texBlob, texFilename));
    }

    return {
        manifest: null,
        modelFile,
        materialFiles,
        annotationFile,
        format
    };
}

/**
 * Build a share URL for an ephemeral share.
 * Points to the editor (index.html) — the viewer is a future addition.
 * 
 * @param {string} shareId 
 * @param {string|null} focusAnnotationUuid - optional annotation UUID to focus on load
 * @returns {string}
 */
export function buildShareUrl(shareId, focusAnnotationUuid = null) {
    let url = `${window.location.origin}/?share=${shareId}`;
    if (focusAnnotationUuid) {
        url += `&annotation=${encodeURIComponent(focusAnnotationUuid)}`;
    }
    return url;
}

/**
 * Build a share URL for a direct/DOI share.
 * Points to the editor (index.html) — the viewer is a future addition.
 * 
 * @param {string} modelUrl 
 * @param {string|null} annotationsUrl 
 * @param {string|null} format - 'glb', 'obj', or 'ply' (needed when URL has no file extension)
 * @returns {string}
 */
export function buildDirectUrl(modelUrl, annotationsUrl, format) {
    let url = `${window.location.origin}/?model=${encodeURIComponent(modelUrl)}`;
    if (annotationsUrl) {
        url += `&annotations=${encodeURIComponent(annotationsUrl)}`;
    }
    if (format) {
        url += `&format=${format}`;
    }
    return url;
}

/**
 * Build an editor URL from the current viewer URL params.
 * Used by the "Open in Editor" button in the viewer (future).
 * 
 * @returns {string}
 */
export function buildEditorUrl() {
    return `${window.location.origin}/${window.location.search}`;
}

/**
 * Check if a share has expired based on manifest data.
 * 
 * @param {Object} manifest 
 * @returns {boolean}
 */
export function isShareExpired(manifest) {
    if (!manifest || !manifest.expiresAt) return false;
    return new Date(manifest.expiresAt) < new Date();
}

/**
 * Calculate days remaining until share expires.
 * 
 * @param {Object} manifest 
 * @returns {number} days remaining (0 if expired)
 */
export function daysUntilExpiry(manifest) {
    if (!manifest || !manifest.expiresAt) return 0;
    const diff = new Date(manifest.expiresAt) - new Date();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
