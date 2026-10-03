// js/utils/coords.js - Pure coordinate helpers (WKT formatting/parsing, Y-up <-> Z-up)
// No Three.js or DOM imports, so the helpers load in Node for unit tests.
// Moved out of js/export/w3c-format.js, which re-exports pointToZUp/pointFromZUp.

// ============ WKT helpers ============

// Formats a number for WKT output without exponential notation.
// 6 decimals is sub-micron at metre scale; trailing zeros are trimmed.
export function wktNum(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    const s = n.toFixed(6).replace(/\.?0+$/, '');
    return (s === '' || s === '-0') ? '0' : s;
}

// Builds a WKT "POINT Z (x y z)" string from a {x,y,z} point.
export function wktPointZ(p) {
    return `POINT Z (${wktNum(p.x)} ${wktNum(p.y)} ${wktNum(p.z)})`;
}

// Parses the first parenthesised coordinate triple of a WKT string into {x,y,z}.
// Tolerates an optional leading CRS URI, e.g. "<...> POINT Z (...)".
export function parsePointZ(wkt) {
    if (typeof wkt !== 'string') return null;
    const m = wkt.match(/\(([^()]*)\)/);
    if (!m) return null;
    const n = m[1].trim().split(/[\s,]+/).map(Number);
    if (n.length < 3 || n.some(isNaN)) return null;
    return { x: n[0], y: n[1], z: n[2] };
}

// Parses a WKT POINT / LINESTRING / POLYGON (Z) string into { type, points }.
// Coordinates are returned as stored (Z-up); frame conversion happens later.
export function parseWKT(wkt) {
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
