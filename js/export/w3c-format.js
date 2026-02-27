// js/export/w3c-format.js - W3C Web Annotation format conversion
import { state } from '../state.js';
import { generateUUID, getModelMimeType } from '../utils/helpers.js';

// ============ Coordinate Transforms ============

/**
 * Transforms a point from Three.js Y-up world space to Z-up export space.
 * MeshNotes always exports in Z-up coordinates for interoperability with
 * photogrammetry/archaeology tools (Agisoft, CloudCompare, Blender, etc.).
 *
 * The model was rotated -90 deg around X on load (Z-up -> Y-up), so the
 * inverse transform converts back: (x, y, z)_threejs -> (x, -z, y)_zup
 * @param {{x: number, y: number, z: number}} p - Point in Three.js Y-up space
 * @returns {{x: number, y: number, z: number}} Point in Z-up space
 */
export function pointToZUp(p) {
    return { x: p.x, y: -p.z, z: p.y };
}

/**
 * Transforms a point from Z-up import space to Three.js Y-up world space.
 * Inverse of pointToZUp: (x, y, z)_zup -> (x, z, -y)_threejs
 * @param {{x: number, y: number, z: number}} p - Point in Z-up space
 * @returns {{x: number, y: number, z: number}} Point in Three.js Y-up space
 */
export function pointFromZUp(p) {
    return { x: p.x, y: p.z, z: -p.y };
}

// ============ Selector Formatting ============

/**
 * Converts an annotation's geometry into a W3C Web Annotation selector.
 * All coordinates are transformed to Z-up space for export.
 * Uses FragmentSelector with IIIF 3D conformance for point/line/polygon types,
 * and a custom MeshNotes surface selector for painted face annotations.
 * @see https://www.w3.org/TR/annotation-model/#fragment-selector
 * @param {Object} ann - Internal annotation object with type and points/faceData
 * @returns {Object} W3C-compliant selector object
 */
export function formatPointsAsSelector(ann) {
    // Create W3C-compliant selector for 3D geometry
    // All coordinates are transformed from Three.js Y-up to Z-up for export
    if (ann.type === 'point') {
        const p = pointToZUp(ann.points[0]);
        return {
            type: 'PointSelector',
            refinedBy: {
                type: 'FragmentSelector',
                conformsTo: 'https://github.com/IIIF/3d',
                value: `point=${p.x},${p.y},${p.z}`
            }
        };
    } else if (ann.type === 'line') {
        const coords = ann.points.map(p => { const z = pointToZUp(p); return `${z.x},${z.y},${z.z}`; }).join(';');
        return {
            type: 'SvgSelector',
            refinedBy: {
                type: 'FragmentSelector',
                conformsTo: 'https://github.com/IIIF/3d',
                value: `polyline=${coords}`
            }
        };
    } else if (ann.type === 'polygon') {
        const coords = ann.points.map(p => { const z = pointToZUp(p); return `${z.x},${z.y},${z.z}`; }).join(';');
        return {
            type: 'SvgSelector',
            refinedBy: {
                type: 'FragmentSelector',
                conformsTo: 'https://github.com/IIIF/3d',
                value: `polygon=${coords}`
            }
        };
    } else if (ann.type === 'surface' && ann.faceData) {
        // Face indices don't need transformation, only the centroid point
        const centroid = ann.points.length > 0 ? pointToZUp(ann.points[0]) : null;
        return {
            type: 'FragmentSelector',
            conformsTo: 'https://github.com/IIIF/3d',
            value: `faces=${ann.faceData.join(',')}`,
            refinedBy: centroid ? {
                type: 'PointSelector',
                value: `centroid=${centroid.x},${centroid.y},${centroid.z}`
            } : undefined
        };
    } else if (ann.type === 'box' && ann.boxData) {
        // Box: center, size, and rotation (Euler angles in radians)
        const center = pointToZUp(ann.boxData.center);
        const size = ann.boxData.size;
        const rot = ann.boxData.rotation || { x: 0, y: 0, z: 0 };
        // Size stays the same, rotation needs Y/Z swap for Z-up coordinate system
        return {
            type: 'FragmentSelector',
            conformsTo: 'https://github.com/IIIF/3d',
            value: `box=${center.x},${center.y},${center.z};${size.x},${size.z},${size.y};${rot.x},${rot.z},${rot.y}`
        };
    }
    return null;
}

// ============ Selector Parsing ============

export function parseSelector(selector, ann) {
    // Parse W3C selector back to internal format
    if (!selector) return;

    // Get main selector value - check direct value first, then refinedBy
    // (Surface annotations have value at top level, others have it in refinedBy)
    let fragmentValue = null;
    if (selector.value) {
        fragmentValue = selector.value;
    } else if (selector.refinedBy && selector.refinedBy.value) {
        fragmentValue = selector.refinedBy.value;
    }

    if (!fragmentValue) return;

    // Parse point=x,y,z
    if (fragmentValue.startsWith('point=')) {
        const coords = fragmentValue.replace('point=', '').split(',').map(Number);
        if (coords.length === 3) {
            ann.points = [{ x: coords[0], y: coords[1], z: coords[2] }];
            ann.type = 'point';
        }
    }
    // Parse polyline=x1,y1,z1;x2,y2,z2;...
    else if (fragmentValue.startsWith('polyline=')) {
        const pointsStr = fragmentValue.replace('polyline=', '').split(';');
        ann.points = pointsStr.map(p => {
            const coords = p.split(',').map(Number);
            return { x: coords[0], y: coords[1], z: coords[2] };
        });
        ann.type = 'line';
    }
    // Parse polygon=x1,y1,z1;x2,y2,z2;...
    else if (fragmentValue.startsWith('polygon=')) {
        const pointsStr = fragmentValue.replace('polygon=', '').split(';');
        ann.points = pointsStr.map(p => {
            const coords = p.split(',').map(Number);
            return { x: coords[0], y: coords[1], z: coords[2] };
        });
        ann.type = 'polygon';
    }
    // Parse faces=0_1,0_2,...
    else if (fragmentValue.startsWith('faces=')) {
        ann.faceData = fragmentValue.replace('faces=', '').split(',');
        ann.type = 'surface';
        ann.points = [];
        // Check for centroid in refinedBy
        if (selector.refinedBy && selector.refinedBy.value && selector.refinedBy.value.startsWith('centroid=')) {
            const coords = selector.refinedBy.value.replace('centroid=', '').split(',').map(Number);
            if (coords.length === 3) {
                ann.points = [{ x: coords[0], y: coords[1], z: coords[2] }];
            }
        }
    }
    // Parse box=cx,cy,cz;sx,sy,sz;rx,ry,rz
    else if (fragmentValue.startsWith('box=')) {
        const parts = fragmentValue.replace('box=', '').split(';');
        if (parts.length >= 2) {
            const centerCoords = parts[0].split(',').map(Number);
            const sizeCoords = parts[1].split(',').map(Number);
            const rotCoords = parts.length >= 3 ? parts[2].split(',').map(Number) : [0, 0, 0];

            ann.type = 'box';
            // Center point for compatibility with other annotation types
            ann.points = [{ x: centerCoords[0], y: centerCoords[1], z: centerCoords[2] }];
            // Box-specific data (size swapped back from Z-up to Y-up)
            ann.boxData = {
                center: { x: centerCoords[0], y: centerCoords[1], z: centerCoords[2] },
                size: { x: sizeCoords[0], y: sizeCoords[2], z: sizeCoords[1] },
                rotation: { x: rotCoords[0], y: rotCoords[2], z: rotCoords[1] }
            };
        }
    }
    // Parse centroid for surface types
    else if (fragmentValue.startsWith('centroid=')) {
        const coords = fragmentValue.replace('centroid=', '').split(',').map(Number);
        if (coords.length === 3) {
            ann.points = [{ x: coords[0], y: coords[1], z: coords[2] }];
        }
    }
}

// ============ W3C Annotation Conversion ============

/**
 * Converts an internal annotation to the W3C Web Annotation JSON-LD format.
 * Includes annotation metadata, group info, geometry selector, and all entries
 * (mapped to oa:TextualBody with author/timestamp/links).
 * @see https://www.w3.org/TR/annotation-model/
 * @param {Object} ann - Internal annotation object
 * @param {Object} group - The group this annotation belongs to (for color/name)
 * @returns {Object} W3C Web Annotation JSON-LD object
 */
export function convertToW3CAnnotation(ann, group) {
    // Convert internal annotation to W3C Web Annotation format
    const w3cAnn = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: `urn:meshnotes:annotation:${ann.uuid || generateUUID()}`,
        motivation: ann.type === 'surface' ? 'tagging' : 'describing',
        created: ann.entries && ann.entries.length > 0 ? ann.entries[0].timestamp : new Date().toISOString(),
        modified: ann.entries && ann.entries.length > 1 ? ann.entries[ann.entries.length - 1].timestamp : undefined,
        'schema:name': ann.name || 'Unnamed',
        target: {
            type: 'SpecificResource',
            source: {
                id: `urn:meshnotes:model:${state.modelFileName || 'unknown'}`,
                type: 'Dataset',
                format: getModelMimeType()
            },
            selector: formatPointsAsSelector(ann)
        }
    };

    // Add styleClass for group color
    if (group) {
        w3cAnn.target.styleClass = `group-${group.id}`;
    }

    // Convert entries to body array
    if (ann.entries && ann.entries.length > 0) {
        w3cAnn.body = ann.entries.map(entry => {
            const body = {
                type: 'TextualBody',
                value: entry.description || '',
                format: 'text/plain',
                language: 'en',
                'meshnotes:entryUuid': entry.uuid
            };

            if (entry.author) {
                body.creator = {
                    type: 'Person',
                    name: entry.author
                };
            }

            if (entry.timestamp) {
                body.created = entry.timestamp;
            }

            if (entry.modified) {
                body.modified = entry.modified;
            }

            // Store links as custom property
            if (entry.links && entry.links.length > 0) {
                body['schema:url'] = entry.links;
            }
            
            // Include version history if present
            if (entry.versions && entry.versions.length > 0) {
                body['meshnotes:versions'] = entry.versions.map(v => ({
                    value: v.description || '',
                    creator: v.author ? { type: 'Person', name: v.author } : undefined,
                    'schema:url': v.links && v.links.length > 0 ? v.links : undefined,
                    'meshnotes:savedAt': v.savedAt
                }));
            }

            return body;
        });
    }

    // Store internal ID mapping for round-trip
    w3cAnn['meshnotes:internalId'] = ann.id;
    w3cAnn['meshnotes:groupId'] = ann.groupId;
    w3cAnn['meshnotes:groupUuid'] = group ? group.uuid : undefined;
    w3cAnn['annotationType'] = ann.type;
    if (ann.surfaceProjection === false) {
        w3cAnn['surfaceProjection'] = false;
    }
    
    // Include name version history if present
    if (ann.nameVersions && ann.nameVersions.length > 0) {
        w3cAnn['meshnotes:nameVersions'] = ann.nameVersions.map(v => ({
            value: v.value,
            'meshnotes:savedAt': v.savedAt
        }));
    }
    
    // Include group version history if present
    if (ann.groupVersions && ann.groupVersions.length > 0) {
        w3cAnn['meshnotes:groupVersions'] = ann.groupVersions.map(v => ({
            groupId: v.groupId,
            'meshnotes:savedAt': v.savedAt
        }));
    }

    return w3cAnn;
}

export function convertFromW3CAnnotation(w3cAnn, groupIdMap) {
    // Convert W3C Web Annotation back to internal format
    // Extract persistent UUID from W3C id (urn:meshnotes:annotation:{uuid})
    let importedUuid = null;
    if (w3cAnn.id && w3cAnn.id.startsWith('urn:meshnotes:annotation:')) {
        importedUuid = w3cAnn.id.replace('urn:meshnotes:annotation:', '');
    }
    const ann = {
        id: Date.now() + Math.floor(Math.random() * 10000),
        uuid: importedUuid || generateUUID(),
        type: w3cAnn['annotationType'] || w3cAnn['meshnotes:annotationType'] || 'point',
        name: w3cAnn['schema:name'] || 'Unnamed',
        groupId: null,
        points: [],
        entries: []
    };

    // Map group - try UUID first, then internal ID
    const origGroupUuid = w3cAnn['meshnotes:groupUuid'];
    const origGroupId = w3cAnn['meshnotes:groupId'];
    if (origGroupUuid && groupIdMap['uuid:' + origGroupUuid]) {
        ann.groupId = groupIdMap['uuid:' + origGroupUuid];
    } else if (origGroupId && groupIdMap[origGroupId]) {
        ann.groupId = groupIdMap[origGroupId];
    }

    // Restore surface projection setting (default true for line/polygon)
    if (w3cAnn['surfaceProjection'] === false || w3cAnn['meshnotes:surfaceProjection'] === false) {
        ann.surfaceProjection = false;
    }

    // Parse selector to get points/faceData
    if (w3cAnn.target && w3cAnn.target.selector) {
        parseSelector(w3cAnn.target.selector, ann);
    }

    // Convert body to entries
    if (w3cAnn.body) {
        const bodies = Array.isArray(w3cAnn.body) ? w3cAnn.body : [w3cAnn.body];
        ann.entries = bodies.map((body, idx) => {
            const entry = {
                id: Date.now() + idx + Math.floor(Math.random() * 1000),
                uuid: body['meshnotes:entryUuid'] || generateUUID(),
                description: body.value || '',
                author: body.creator ? body.creator.name : '',
                timestamp: body.created || w3cAnn.created || new Date().toISOString(),
                modified: body.modified || undefined,
                links: body['schema:url'] || []
            };
            
            // Restore version history if present
            if (body['meshnotes:versions'] && body['meshnotes:versions'].length > 0) {
                entry.versions = body['meshnotes:versions'].map(v => ({
                    description: v.value || '',
                    author: v.creator ? v.creator.name : '',
                    links: v['schema:url'] || [],
                    savedAt: v['meshnotes:savedAt']
                }));
            }
            
            return entry;
        });
    }
    
    // Restore name version history if present
    if (w3cAnn['meshnotes:nameVersions'] && w3cAnn['meshnotes:nameVersions'].length > 0) {
        ann.nameVersions = w3cAnn['meshnotes:nameVersions'].map(v => ({
            value: v.value,
            savedAt: v['meshnotes:savedAt']
        }));
    }
    
    // Restore group version history if present
    if (w3cAnn['meshnotes:groupVersions'] && w3cAnn['meshnotes:groupVersions'].length > 0) {
        ann.groupVersions = w3cAnn['meshnotes:groupVersions'].map(v => ({
            groupId: v.groupId,
            savedAt: v['meshnotes:savedAt']
        }));
    }

    return ann;
}
