// js/export/export-json.js - W3C Web Annotation Collection export
import { state, APP_VERSION } from '../state.js';
import { generateUUID, getModelMimeType, showStatus } from '../utils/helpers.js';
import { convertToW3CAnnotation, authorToCreator } from './w3c-format.js';

/**
 * Builds the W3C Web Annotation Collection JSON string.
 * Reusable by both the download export and the share upload.
 * @returns {string} Clean JSON-LD string
 */
export function buildAnnotationJSON() {
    const collectionId = `urn:meshnotes:collection:${generateUUID()}`;

    // Convert groups to stylesheet
    const stylesheet = {
        type: 'CssStylesheet',
        value: state.groups.map(g => `.group-${g.id} { color: ${g.color}; }`).join('\n')
    };

    // Convert all annotations to W3C format
    const w3cAnnotations = state.annotations.map(ann => {
        const group = state.groups.find(g => g.id === ann.groupId);
        return convertToW3CAnnotation(ann, group);
    });

    // Build the W3C AnnotationCollection
    const collection = {
        '@context': [
            'http://www.w3.org/ns/anno.jsonld',
            'https://meshnotes.org/ns/context-v1.jsonld'
        ],
        type: 'AnnotationCollection',
        id: collectionId,
        label: `MeshNotes: ${state.modelFileName || 'Annotations'}`,
        generator: {
            type: 'Software',
            name: 'MeshNotes',
            'schema:version': APP_VERSION,
            homepage: 'https://meshnotes.org'
        },
        generated: new Date().toISOString(),

        // Format identity: the annotation-format version this file conforms to,
        // independent of the MeshNotes application version.
        'dcterms:conformsTo': 'https://meshnotes.org/spec/annotation/v1/',

        // Target model — canonical description of the annotated model.
        // Coordinate frame, unit, and integrity hash live here.
        'modelSource': {
            id: `urn:meshnotes:model:${state.modelFileName || 'unknown'}`,
            type: 'Dataset',
            'schema:name': state.modelFileName,
            format: getModelMimeType(),
            // MeshNotes always exports Z-up coordinates for interoperability
            // with photogrammetry/archaeology tools.
            'upAxis': 'Z',
            // Real-world unit of the coordinates, when the user declared one in
            // settings ('units' is the unset placeholder and is omitted).
            'unit': (state.measurementUnit && state.measurementUnit !== 'units') ? state.measurementUnit : undefined,
            // SHA-256 of the primary model file, binding annotations to this exact
            // mesh (omitted if not yet computed).
            'schema:sha256': state.modelHash || undefined
        },

        // Stylesheet for group colors
        stylesheet: stylesheet,

        // Groups metadata (custom extension)
        'meshnotes:groups': state.groups.map(g => ({
            id: g.id,
            'meshnotes:uuid': g.uuid,
            'schema:name': g.name,
            'schema:color': g.color,
            'meshnotes:visible': g.visible,
            'meshnotes:opacity': g.opacity !== undefined ? g.opacity : 1.0
        })),

        // Model information entries
        'modelInfo': state.modelInfo.entries.length > 0 ? {
            type: 'Annotation',
            motivation: 'describing',
            'schema:name': 'Model Information',
            body: state.modelInfo.entries.map(entry => {
                const bodyObj = {
                    type: 'TextualBody',
                    value: entry.description || '',
                    format: 'text/plain',
                    'meshnotes:entryUuid': entry.uuid,
                    creator: authorToCreator(entry.author, entry.authorOrcid),
                    created: entry.timestamp,
                    modified: entry.modified || undefined,
                    'schema:url': entry.links && entry.links.length > 0 ? entry.links : undefined
                };
                
                // Include version history if present
                if (entry.versions && entry.versions.length > 0) {
                    bodyObj['meshnotes:versions'] = entry.versions.map(v => ({
                        value: v.description || '',
                        creator: authorToCreator(v.author, v.authorOrcid),
                        'schema:url': v.links && v.links.length > 0 ? v.links : undefined,
                        'meshnotes:savedAt': v.savedAt
                    }));
                }
                
                return bodyObj;
            })
        } : undefined,

        // Metadata report
        'metadata': state.modelInfo.metadata || undefined,

        // Annotations
        total: w3cAnnotations.length,
        first: {
            type: 'AnnotationPage',
            items: w3cAnnotations
        }
    };

    // Serialize, stripping undefined values
    let json = JSON.stringify(collection, (key, value) => {
        if (value === undefined) return undefined;
        return value;
    }, 2);

    // Collapse the meshnotes:faces (often very long) and meshnotes:rotation
    // (4-number quaternion) arrays onto a single line for readability. Both
    // hold only simple tokens with no ']' inside, so matching up to the first
    // ']' is safe and won't catch nested arrays.
    json = json.replace(/("meshnotes:(?:faces|rotation)": \[)([^\]]*)(\])/g, (m, open, body, close) => {
        return open + body.replace(/\s+/g, ' ').trim() + close;
    });

    return json;
}

/**
 * Builds the annotation JSON-LD as a Blob (for upload/sharing).
 * @returns {Blob}
 */
export function buildAnnotationBlob() {
    const json = buildAnnotationJSON();
    return new Blob([json], { type: 'application/ld+json' });
}

/**
 * Exports all annotations as a W3C Web Annotation Collection (JSON-LD).
 * Downloads as a .jsonld file.
 * @see https://www.w3.org/TR/annotation-model/#collections
 */
export function exportAnnotations() {
    const json = buildAnnotationJSON();
    const blob = new Blob([json], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.download = `meshnotes-${state.modelFileName || 'export'}-${Date.now()}.jsonld`;
    link.href = url;
    link.click();

    URL.revokeObjectURL(url);
    showStatus('W3C annotations exported');
}
