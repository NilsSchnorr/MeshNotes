// tests/support/survey-samples.js - Made-up alignments, survey points and sessions for the format tests
// Pure (alignment.js only), so it can be imported statically before app-env.js
// loads the app modules.
import * as AL from '../../js/survey/alignment.js';

export const T1 = '2026-10-01T09:00:00.000Z';
export const T2 = '2026-10-02T09:00:00.000Z';
export const T3 = '2026-10-03T09:00:00.000Z';
export const T5 = '2026-10-05T09:00:00.000Z';

// Control-point positions in the export frame, at most 6 decimals, so the
// WKT of modelPosition round-trips exactly.
const MODEL_POINTS = [
    [-8.412, 3.115, -1.204], [6.25, 7.5, 0.4], [9.125, -6.75, 1.1],
    [-5.5, -8.25, 0.2], [0.75, 0.5, 2.3]
];
const SHIFT = [512000, 4123000, 58];

// Survey = Rz(heading) * p + SHIFT for every control point (an exact fit).
export function controlPoints(headingDeg = 90) {
    const a = headingDeg * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    return MODEL_POINTS.map(([x, y, z], i) => AL.makeControlPoint({
        label: `GCP${i + 1}`,
        csvRow: i + 2,
        enabled: true,
        modelPosition: { x, y, z },
        surveyed: { e: c * x - s * y + SHIFT[0], n: s * x + c * y + SHIFT[1], h: z + SHIFT[2] }
    }));
}

export function makeAlignment({ id, uuid, headingDeg = 90, now = T1, name = 'Trench 3' }) {
    return AL.createAlignment({
        id, uuid, name, crsLabel: 'EPSG:32635', heightColumn: 'Elevation',
        modelSha256: 'abc123', modelUpAxis: 'y-up',
        controlPoints: controlPoints(headingDeg),
        creator: 'Test Person', now
    });
}

// A refined copy (new fit, old one kept in versions), under another session id.
export function refined(alignment, { id = alignment.id, headingDeg, now }) {
    return AL.refineAlignment({ ...alignment, id }, { controlPoints: controlPoints(headingDeg), now });
}

/**
 * A survey point annotation placed at its fitted position (storage frame).
 * importedAt equals the first entry's timestamp, as the reader restores it.
 */
export function surveyAnnotation({
    id, uuid, alignment, s, groupId = 1, name = uuid, locked = true,
    placement = 'fit', entryTime = T1, entryModified, surfaceDistance = 0.012, position
}) {
    const entry = { id: id + 1000, uuid: `${uuid}-e1`, description: 'Code: GCP', author: 'Test Person', timestamp: entryTime, links: [] };
    if (entryModified) entry.modified = entryModified;
    const ann = {
        id, uuid, type: 'point', name, groupId,
        points: [position || AL.surveyToStorage(alignment, s)],
        entries: [entry],
        survey: {
            alignmentId: alignment ? alignment.id : null,
            e: s.e, n: s.n, h: s.h,
            raw: { e: String(s.e), n: String(s.n), h: String(s.h) },
            columns: { e: 'Easting', n: 'Northing', h: 'Elevation' },
            attributes: { 'Solution status': 'FIX', 'Averaging start': '2026-09-30 10:12:00', Code: 'GCP' },
            source: { fileName: 'trench3.csv', fileSha256: 'f00d', row: 5, importedAt: entryTime },
            placement,
            surfaceDistance
        }
    };
    if (locked) ann.locked = true;
    return ann;
}

// A plain annotation without survey data.
export function plainAnnotation({ id, uuid, groupId = 1, type = 'point', entryTime = T1, locked = false }) {
    const ann = {
        id, uuid, type, name: `Plain ${uuid}`, groupId,
        points: [{ x: 0.5, y: 1.25, z: -0.75 }],
        entries: [{ id: id + 1000, uuid: `${uuid}-e1`, description: 'A note', author: 'Test Person', timestamp: entryTime, links: [] }]
    };
    if (type === 'box') ann.boxData = { center: { x: 0.5, y: 1.25, z: -0.75 }, size: { x: 1, y: 2, z: 0.5 }, rotation: { x: 0, y: 0.3, z: 0 } };
    if (locked) ann.locked = true;
    return ann;
}

export const group = (id, uuid, name, extra = {}) => ({ id, uuid, name, color: '#4CAF50', visible: true, opacity: 1.0, ...extra });

export const modelDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
