// js/export/export-json.js - W3C Web Annotation Collection export
import { state } from '../state.js';
import { generateUUID, getModelMimeType, showStatus } from '../utils/helpers.js';
import { convertToW3CAnnotation } from './w3c-format.js';

/**
 * Exports all annotations as a W3C Web Annotation Collection (JSON-LD).
 * Includes group definitions (as CssStylesheet), model info, and all annotations
 * converted to W3C format. Downloads as a .json file.
 * @see https://www.w3.org/TR/annotation-model/#collections
 */
export function exportAnnotations() {
    // Create W3C Web Annotation Collection
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
            {
                'meshnotes': 'https://github.com/NilsSchnorr/MeshNotes#',
                'schema': 'http://schema.org/',
                'upAxis': 'meshnotes:upAxis',
                'modelSource': 'meshnotes:modelSource',
                'annotationType': 'meshnotes:annotationType',
                'surfaceProjection': 'meshnotes:surfaceProjection',
                'modelInfo': 'meshnotes:modelInfo'
            }
        ],
        type: 'AnnotationCollection',
        id: collectionId,
        label: `MeshNotes: ${state.modelFileName || 'Annotations'}`,
        generator: {
            type: 'Software',
            name: 'MeshNotes',
            'schema:version': '2.0',
            homepage: 'https://github.com/NilsSchnorr/MeshNotes'
        },
        generated: new Date().toISOString(),

        // Coordinate system: MeshNotes always exports Z-up coordinates
        // for interoperability with photogrammetry/archaeology tools
        'upAxis': 'Z',

        // Target model
        'modelSource': {
            id: `urn:meshnotes:model:${state.modelFileName || 'unknown'}`,
            type: 'Dataset',
            'schema:name': state.modelFileName,
            format: getModelMimeType()
        },

        // Stylesheet for group colors
        stylesheet: stylesheet,

        // Groups metadata (custom extension)
        'meshnotes:groups': state.groups.map(g => ({
            id: g.id,
            'meshnotes:uuid': g.uuid,
            'schema:name': g.name,
            'schema:color': g.color,
            'meshnotes:visible': g.visible
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
                    creator: entry.author ? { type: 'Person', name: entry.author } : undefined,
                    created: entry.timestamp,
                    modified: entry.modified || undefined,
                    'schema:url': entry.links && entry.links.length > 0 ? entry.links : undefined
                };
                
                // Include version history if present
                if (entry.versions && entry.versions.length > 0) {
                    bodyObj['meshnotes:versions'] = entry.versions.map(v => ({
                        value: v.description || '',
                        creator: v.author ? { type: 'Person', name: v.author } : undefined,
                        'schema:url': v.links && v.links.length > 0 ? v.links : undefined,
                        'meshnotes:savedAt': v.savedAt
                    }));
                }
                
                return bodyObj;
            })
        } : undefined,

        // Annotations
        total: w3cAnnotations.length,
        first: {
            type: 'AnnotationPage',
            items: w3cAnnotations
        }
    };

    // Clean up undefined values
    const cleanJSON = JSON.stringify(collection, (key, value) => {
        if (value === undefined) return undefined;
        return value;
    }, 2);

    const blob = new Blob([cleanJSON], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.download = `meshnotes-${state.modelFileName || 'export'}-${Date.now()}.jsonld`;
    link.href = url;
    link.click();

    URL.revokeObjectURL(url);
    showStatus('W3C annotations exported');
}
