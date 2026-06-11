// js/export/w3c-format.js - W3C Web Annotation format conversion
import * as THREE from 'three';
import { state } from '../state.js';
import { generateUUID, generateInternalId, getModelMimeType } from '../utils/helpers.js';

// URI of the published MeshNotes 3D Selector Specification that every selector
// declares conformance to. See https://meshnotes.org/spec/selector/v1/
const SELECTOR_SPEC = 'https://meshnotes.org/spec/selector/v1/';

// ============ Author / ORCID helpers ============

// Normalizes a raw ORCID input (bare iD or full URL) to a canonical
// https://orcid.org/ URI, or returns undefined when it contains no
// well-formed 16-digit ORCID iD.
function normalizeOrcid(raw) {
    if (typeof raw !== 'string') return undefined;
    const m = raw.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i);
    return m ? `https://orcid.org/${m[1].toUpperCase()}` : undefined;
}

// Builds a W3C/schema creator object from an author name. An ORCID URI is
// attached when one is supplied (e.g. preserved from a prior import) or when
// the name matches the user's configured default author — the ORCID mapping
// rule: identifiers are only asserted for the local user's own entries.
export function authorToCreator(name, orcid) {
    if (!name) return undefined;
    const resolved = (typeof orcid === 'string' && orcid)
        ? orcid
        : (name === state.defaultAuthor ? normalizeOrcid(state.defaultAuthorOrcid) : undefined);
    const creator = { type: 'Person', name };
    if (resolved) creator.id = resolved;
    return creator;
}

// Extracts { name, orcid } from a W3C creator object on import. The ORCID is
// read from creator.id (or schema:identifier) only when it is an orcid.org URI.
export function creatorToAuthor(creator) {
    if (!creator) return { name: '', orcid: undefined };
    const rawId = creator.id || creator['schema:identifier'] || '';
    const orcid = (typeof rawId === 'string' && rawId.includes('orcid.org')) ? rawId : undefined;
    return { name: creator.name || '', orcid };
}

// Derives the annotation-level creator for annotations created before the
// frozen `creator` field existed: the author of the FIRST VERSION of the
// FIRST entry (entries and version histories are kept chronologically
// sorted), i.e. the person who originally created the annotation.
function deriveAnnotationCreator(ann) {
    if (!ann.entries || ann.entries.length === 0) return { name: '', orcid: undefined };
    const first = ann.entries[0];
    if (first.versions && first.versions.length > 0) {
        return { name: first.versions[0].author || '', orcid: first.versions[0].authorOrcid };
    }
    return { name: first.author || '', orcid: first.authorOrcid };
}

// ============ WKT + quaternion helpers ============

// Basis-change quaternion mapping the internal Three.js (Y-up) frame to the
// exported Z-up frame: a +90 deg rotation about X (matches pointToZUp).
function basisYupToZup() {
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
}

// Formats a number for WKT output without exponential notation.
// 6 decimals is sub-micron at metre scale; trailing zeros are trimmed.
function wktNum(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    const s = n.toFixed(6).replace(/\.?0+$/, '');
    return (s === '' || s === '-0') ? '0' : s;
}

// Builds a WKT "POINT Z (x y z)" string from a {x,y,z} point.
function wktPointZ(p) {
    return `POINT Z (${wktNum(p.x)} ${wktNum(p.y)} ${wktNum(p.z)})`;
}

// Parses the first parenthesised coordinate triple of a WKT string into {x,y,z}.
// Tolerates an optional leading CRS URI, e.g. "<...> POINT Z (...)".
function parsePointZ(wkt) {
    if (typeof wkt !== 'string') return null;
    const m = wkt.match(/\(([^()]*)\)/);
    if (!m) return null;
    const n = m[1].trim().split(/[\s,]+/).map(Number);
    if (n.length < 3 || n.some(isNaN)) return null;
    return { x: n[0], y: n[1], z: n[2] };
}

// Parses a WKT POINT / LINESTRING / POLYGON (Z) string into { type, points }.
// Coordinates are returned as stored (Z-up); frame conversion happens later.
function parseWKT(wkt) {
    if (typeof wkt !== 'string') return null;
    let s = wkt.trim();
    if (s.startsWith('<')) { const i = s.indexOf('>'); if (i >= 0) s = s.slice(i + 1).trim(); }
    const head = s.toUpperCase();
    const toPt = (pair) => { const n = pair.trim().split(/\s+/).map(Number); return { x: n[0], y: n[1], z: n[2] }; };
    if (head.startsWith('POINT')) {
        const p = parsePointZ(s);
        return p ? { type: 'point', points: [p] } : null;
    }
    if (head.startsWith('LINESTRING')) {
        const inner = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
        return { type: 'line', points: inner.split(',').map(toPt) };
    }
    if (head.startsWith('POLYGON')) {
        const inner = s.slice(s.indexOf('((') + 2, s.lastIndexOf('))'));
        let pts = inner.split(',').map(toPt);
        // Drop the OGC closing duplicate vertex for the internal model.
        if (pts.length > 1) {
            const a = pts[0], b = pts[pts.length - 1];
            if (a.x === b.x && a.y === b.y && a.z === b.z) pts = pts.slice(0, -1);
        }
        return { type: 'polygon', points: pts };
    }
    return null;
}

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
 * Converts an annotation's geometry into a MeshNotes 3D selector
 * (https://meshnotes.org/spec/selector/v1/). Linear geometry (point, polyline,
 * polygon) is encoded as WKT; surface and box are parametric. All coordinates
 * are transformed from the internal Three.js Y-up frame to the exported Z-up frame.
 * @param {Object} ann - Internal annotation object with type and points/faceData
 * @returns {Object|null} MeshNotes selector object
 */
export function formatPointsAsSelector(ann) {
    if (ann.type === 'point') {
        return {
            type: 'meshnotes:PointSelector',
            'dcterms:conformsTo': SELECTOR_SPEC,
            'meshnotes:wkt': wktPointZ(pointToZUp(ann.points[0]))
        };
    } else if (ann.type === 'line') {
        const coords = ann.points
            .map(p => { const z = pointToZUp(p); return `${wktNum(z.x)} ${wktNum(z.y)} ${wktNum(z.z)}`; })
            .join(', ');
        return {
            type: 'meshnotes:PolylineSelector',
            'dcterms:conformsTo': SELECTOR_SPEC,
            'meshnotes:wkt': `LINESTRING Z (${coords})`
        };
    } else if (ann.type === 'polygon') {
        const coordList = ann.points
            .map(p => { const z = pointToZUp(p); return `${wktNum(z.x)} ${wktNum(z.y)} ${wktNum(z.z)}`; });
        // Close the ring per OGC Simple Features: repeat the first vertex.
        if (coordList.length > 0) coordList.push(coordList[0]);
        return {
            type: 'meshnotes:PolygonSelector',
            'dcterms:conformsTo': SELECTOR_SPEC,
            'meshnotes:wkt': `POLYGON Z ((${coordList.join(', ')}))`
        };
    } else if (ann.type === 'surface' && ann.faceData) {
        const sel = {
            type: 'meshnotes:SurfaceSelector',
            'dcterms:conformsTo': SELECTOR_SPEC,
            'meshnotes:faces': ann.faceData
        };
        // Centroid is the durable, mesh-independent anchor for the region.
        if (ann.points.length > 0) {
            sel['meshnotes:centroid'] = wktPointZ(pointToZUp(ann.points[0]));
        }
        return sel;
    } else if (ann.type === 'box' && ann.boxData) {
        const center = pointToZUp(ann.boxData.center);
        const size = ann.boxData.size; // box-local extents, frame-invariant
        const e = ann.boxData.rotation || { x: 0, y: 0, z: 0 };
        // Orientation: q_zup = r * q_three, where r is the Y-up -> Z-up basis change.
        const qThree = new THREE.Quaternion().setFromEuler(new THREE.Euler(e.x, e.y, e.z, 'XYZ'));
        const qZ = basisYupToZup().multiply(qThree);
        return {
            type: 'meshnotes:BoxSelector',
            'dcterms:conformsTo': SELECTOR_SPEC,
            'meshnotes:center': wktPointZ(center),
            'meshnotes:size': `POINT Z (${wktNum(size.x)} ${wktNum(size.y)} ${wktNum(size.z)})`,
            'meshnotes:rotation': [
                Number(qZ.x.toFixed(8)), Number(qZ.y.toFixed(8)),
                Number(qZ.z.toFixed(8)), Number(qZ.w.toFixed(8))
            ]
        };
    }
    return null;
}

// ============ Selector Parsing ============

export function parseSelector(selector, ann) {
    if (!selector) return;

    const type = selector.type || '';

    // ---- MeshNotes 3D selectors v1 (WKT-hybrid) ----
    if (type === 'meshnotes:PointSelector' ||
        type === 'meshnotes:PolylineSelector' ||
        type === 'meshnotes:PolygonSelector') {
        const parsed = parseWKT(selector['meshnotes:wkt'] || selector['geo:asWKT']);
        if (parsed) { ann.type = parsed.type; ann.points = parsed.points; }
        return;
    }
    if (type === 'meshnotes:SurfaceSelector') {
        ann.type = 'surface';
        ann.faceData = selector['meshnotes:faces'] || [];
        ann.points = [];
        const c = parsePointZ(selector['meshnotes:centroid']);
        if (c) ann.points = [c];
        return;
    }
    if (type === 'meshnotes:BoxSelector') {
        ann.type = 'box';
        const center = parsePointZ(selector['meshnotes:center']) || { x: 0, y: 0, z: 0 };
        const size = parsePointZ(selector['meshnotes:size']) || { x: 0, y: 0, z: 0 };
        const q = Array.isArray(selector['meshnotes:rotation']) ? selector['meshnotes:rotation'] : [0, 0, 0, 1];
        // Inverse of export: q_three = r^-1 * q_zup, then back to Euler (XYZ).
        // New selectors are always Z-up, so the basis inverse always applies here.
        // normalize() guards against off-unit quaternions: our own 8-decimal
        // serialization is ~1e-8 off, and third-party files may be sloppier
        // (THREE treats a zero-length quaternion as identity).
        const qZ = new THREE.Quaternion(q[0] || 0, q[1] || 0, q[2] || 0, q[3] !== undefined ? q[3] : 1).normalize();
        const qThree = basisYupToZup().invert().multiply(qZ);
        const e = new THREE.Euler().setFromQuaternion(qThree, 'XYZ');
        // Center stays Z-up here; import-json.js converts it to Y-up with the points.
        ann.points = [center];
        ann.boxData = { center: center, size: size, rotation: { x: e.x, y: e.y, z: e.z } };
        return;
    }

    // ---- Legacy v1.0.0 selectors (string fragments) ----
    parseLegacySelector(selector, ann);
}

// Parses legacy v1.0.0 string-fragment selectors (the pre-1.0 spec used
// PointSelector/SvgSelector/FragmentSelector carrying point=/polyline=/polygon=/
// faces=/box= values). Retained so existing exports continue to import.
function parseLegacySelector(selector, ann) {
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
    // Annotation-level creator: frozen at creation. Annotations from before
    // the field existed (or imported from older files) fall back to the
    // author of the first version of the first entry.
    const creatorInfo = (ann.creator !== undefined)
        ? { name: ann.creator, orcid: ann.creatorOrcid }
        : deriveAnnotationCreator(ann);

    // modified = the latest change to any constituent entry (a later entry's
    // creation, or an edit to an existing entry); omitted when nothing
    // changed after creation. Matches the definition in the format spec.
    const created = ann.entries && ann.entries.length > 0 ? ann.entries[0].timestamp : new Date().toISOString();
    let modified;
    (ann.entries || []).forEach(entry => {
        [entry.timestamp, entry.modified].forEach(t => {
            if (t && t > created && (!modified || t > modified)) modified = t;
        });
    });

    // Convert internal annotation to W3C Web Annotation format
    const w3cAnn = {
        type: 'Annotation',
        id: `urn:meshnotes:annotation:${ann.uuid || generateUUID()}`,
        motivation: ann.type === 'surface' ? 'tagging' : 'describing',
        creator: authorToCreator(creatorInfo.name, creatorInfo.orcid),
        created: created,
        modified: modified,
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
        // Content language defaults to the authoring browser's language (BCP-47
        // primary subtag, e.g. 'de', 'en') rather than a hardcoded 'en'. Omitted
        // entirely if the environment exposes no language.
        const bodyLanguage = (typeof navigator !== 'undefined' && navigator.language)
            ? navigator.language.split('-')[0]
            : undefined;
        w3cAnn.body = ann.entries.map(entry => {
            const body = {
                type: 'TextualBody',
                value: entry.description || '',
                format: 'text/plain',
                language: bodyLanguage,
                'meshnotes:entryUuid': entry.uuid
            };

            const entryCreator = authorToCreator(entry.author, entry.authorOrcid);
            if (entryCreator) {
                body.creator = entryCreator;
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
                    creator: authorToCreator(v.author, v.authorOrcid),
                    'schema:url': v.links && v.links.length > 0 ? v.links : undefined,
                    'meshnotes:savedAt': v.savedAt
                }));
            }

            return body;
        });
    }

    // Contributors (derived afresh at export, never stored): everyone who
    // authored or edited an entry of this annotation, minus the annotation
    // creator. Standard DC term so generic consumers can read it; because it
    // is derived, it is deliberately not read back on import.
    const contributors = new Map(); // name -> orcid (first known orcid wins)
    (ann.entries || []).forEach(entry => {
        const consider = (name, orcid) => {
            if (!name || name === creatorInfo.name) return;
            if (!contributors.has(name) || (orcid && !contributors.get(name))) contributors.set(name, orcid);
        };
        consider(entry.author, entry.authorOrcid);
        (entry.versions || []).forEach(v => consider(v.author, v.authorOrcid));
    });
    if (contributors.size > 0) {
        w3cAnn['dcterms:contributor'] = Array.from(contributors, ([name, orcid]) => authorToCreator(name, orcid));
    }

    // Group reference for round-trip. The UUID is the durable, portable key;
    // the legacy numeric meshnotes:groupId and the ephemeral meshnotes:internalId
    // are no longer emitted (import resolves groups by UUID, with the numeric id
    // kept only as a fallback when reading older files).
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
        id: generateInternalId(),
        uuid: importedUuid || generateUUID(),
        type: w3cAnn['annotationType'] || w3cAnn['meshnotes:annotationType'] || 'point',
        name: w3cAnn['schema:name'] || 'Unnamed',
        groupId: null,
        points: [],
        entries: []
    };

    // Frozen annotation-level creator (absent in files from before the field
    // existed — the next export then derives it from the first version of
    // the first entry, which those files still carry).
    if (w3cAnn.creator) {
        const { name: annCreatorName, orcid: annCreatorOrcid } = creatorToAuthor(w3cAnn.creator);
        ann.creator = annCreatorName;
        ann.creatorOrcid = annCreatorOrcid;
    }

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
        ann.entries = bodies.map((body) => {
            const { name: entryAuthor, orcid: entryAuthorOrcid } = creatorToAuthor(body.creator);
            const entry = {
                id: generateInternalId(),
                uuid: body['meshnotes:entryUuid'] || generateUUID(),
                description: body.value || '',
                author: entryAuthor,
                authorOrcid: entryAuthorOrcid,
                timestamp: body.created || w3cAnn.created || new Date().toISOString(),
                modified: body.modified || undefined,
                links: body['schema:url'] || []
            };
            
            // Restore version history if present
            if (body['meshnotes:versions'] && body['meshnotes:versions'].length > 0) {
                entry.versions = body['meshnotes:versions'].map(v => ({
                    description: v.value || '',
                    author: creatorToAuthor(v.creator).name,
                    authorOrcid: creatorToAuthor(v.creator).orcid,
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
