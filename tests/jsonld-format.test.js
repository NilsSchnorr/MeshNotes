// tests/jsonld-format.test.js - JSON-LD validity of exports, the context's JSON literals and the stored up-axis
// Guards the 2026-11-16 errata: every node id is an IRI string, metadata and
// viewState are JSON literals, and modelSource records the load up-axis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/app-env.js';
import { T1, makeAlignment, surveyAnnotation, plainAnnotation, group } from './support/survey-samples.js';

const { state } = await import('../js/state.js');
const { buildAnnotationJSON } = await import('../js/export/export-json.js');
const { storedModelUpAxis } = await import('../js/export/import-json.js');
const { createEmptyMetadata } = await import('../js/metadata/templates.js');

const CONTEXT = JSON.parse(readFileSync(new URL('../ns/context-v1.jsonld', import.meta.url), 'utf8'))['@context'];
// Terms whose values are JSON literals: nothing inside them is a JSON-LD node.
const JSON_LITERALS = new Set(Object.keys(CONTEXT).filter(k => CONTEXT[k] && CONTEXT[k]['@type'] === '@json'));

const VIEW_STATE = {
    version: 1,
    camera: { orthographic: false, position: [1, 2, 3], target: [0, 0, 0], zoom: 1 },
    lighting: { followsCamera: true, azimuth: 0, elevation: 45, brightness: 100 },
    modelOpacity: 1, displayMode: 'texture', flipped: false
};

// A session with every kind of data the export writes.
function fullSession({ frameOrigin = { x: 12.5, y: -3.25, z: 0.125 }, upAxis = 'y-up' } = {}) {
    const a = makeAlignment({ id: 101, uuid: 'aaaaaaaa-0000-4000-8000-000000000001', now: T1 });
    const point = plainAnnotation({ id: 1, uuid: 'n1' });
    point.nameVersions = [{ value: 'Old', savedAt: T1, changedBy: 'Test Person' }];
    point.groupVersions = [{ groupUuid: 'g2', groupName: 'Finds', savedAt: T1 }];
    const metadata = createEmptyMetadata();
    metadata.sections[1].fields[0].value = 'skyphos';
    metadata.sections[1].fields[0].uri = 'http://vocab.getty.edu/aat/300043171';
    state.modelFileName = 'skyphos.glb';
    state.modelHash = 'abc123';
    state.modelFrameOrigin = frameOrigin;
    state.modelUpAxis = upAxis;
    state.modelInfo = { entries: [{ id: 50, uuid: 'mi1', description: 'Note', author: 'Test Person', timestamp: T1, links: [] }], metadata };
    state.groups = [group(1, 'g1', 'Default'), group(2, 'g2', 'Finds', { modified: T1 })];
    state.annotations = [
        point,
        plainAnnotation({ id: 2, uuid: 'b1', type: 'box', groupId: 2 }),
        surveyAnnotation({ id: 3, uuid: 'p1', alignment: a, s: { e: 512003.25, n: 4123007.5, h: 58.75 } })
    ];
    state.alignments = [a];
    state.defaultAlignmentId = a.id;
    return JSON.parse(buildAnnotationJSON({ viewState: VIEW_STATE }));
}

// Every id / @id outside the JSON literals, with its path.
function nodeIds(value, path = '$', out = []) {
    if (Array.isArray(value)) value.forEach((v, i) => nodeIds(v, `${path}[${i}]`, out));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (JSON_LITERALS.has(k)) continue;
            if (k === 'id' || k === '@id') out.push({ path: `${path}.${k}`, id: v });
            else nodeIds(v, `${path}.${k}`, out);
        }
    }
    return out;
}

test('every node id in an export is an absolute IRI string', () => {
    const json = fullSession();
    const ids = nodeIds(json);
    assert.ok(ids.length > 10);
    const bad = ids.filter(({ id }) => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(id));
    assert.deepEqual(bad, []);
    assert.deepEqual(json['meshnotes:groups'].map(g => g.id), ['urn:meshnotes:group:g1', 'urn:meshnotes:group:g2']);
});

test('the stylesheet class of a group is the styleClass of its annotations', () => {
    const json = fullSession();
    assert.equal(json.stylesheet.value, '.group-g1 { color: #4CAF50; }\n.group-g2 { color: #4CAF50; }');
    assert.deepEqual(json.first.items.map(a => a.target.styleClass), ['group-g1', 'group-g2', 'group-g1']);
});

test('the context declares metadata and viewState JSON literals, so processors keep them whole', () => {
    for (const term of ['metadata', 'meshnotes:metadata', 'meshnotes:viewState', 'meshnotes:rawValues', 'meshnotes:attributes']) {
        assert.ok(JSON_LITERALS.has(term), term);
    }
    assert.equal(CONTEXT.metadata['@id'], 'meshnotes:metadata');
    const json = fullSession();
    assert.equal(json.metadata.sections[1].fields[0].uri, 'http://vocab.getty.edu/aat/300043171');
    assert.deepEqual(json['meshnotes:viewState'], VIEW_STATE);
});

test('modelSource records the load up-axis while a model is loaded', () => {
    assert.equal(fullSession({ upAxis: 'y-up' }).modelSource['meshnotes:modelUpAxis'], 'y-up');
    assert.equal(fullSession({ upAxis: 'z-up' }).modelSource['meshnotes:modelUpAxis'], 'z-up');
    assert.equal('meshnotes:modelUpAxis' in fullSession({ frameOrigin: null }).modelSource, false);
    assert.equal(fullSession().modelSource.upAxis, 'Z');   // the exported frame, unchanged
});

test('the stored up-axis: modelSource first, then the alignments (default first), else unknown', () => {
    assert.equal(storedModelUpAxis({ modelSource: { 'meshnotes:modelUpAxis': 'Y-UP' } }), 'y-up');
    const alignments = [
        { id: 'urn:meshnotes:alignment:a', 'meshnotes:modelUpAxis': 'z-up' },
        { id: 'urn:meshnotes:alignment:b', 'meshnotes:modelUpAxis': 'y-up' }
    ];
    assert.equal(storedModelUpAxis({ modelSource: {}, 'meshnotes:alignments': alignments }), 'z-up');
    assert.equal(storedModelUpAxis({ 'meshnotes:alignments': alignments, 'meshnotes:defaultAlignment': 'urn:meshnotes:alignment:b' }), 'y-up');
    assert.equal(storedModelUpAxis({ modelSource: { 'meshnotes:modelUpAxis': 'y-up' }, 'meshnotes:alignments': alignments }), 'y-up');
    assert.equal(storedModelUpAxis({ modelSource: { upAxis: 'Z' } }), null);
    assert.equal(storedModelUpAxis({ modelSource: { 'meshnotes:modelUpAxis': 'x-up' } }), null);
    assert.equal(storedModelUpAxis(null), null);
    assert.equal(storedModelUpAxis(fullSession({ upAxis: 'y-up' })), 'y-up');
});

test('meshnotes:faceOrder needs no context entry: it expands through the meshnotes prefix', () => {
    assert.equal(CONTEXT.meshnotes, 'https://meshnotes.org/ns/');
    assert.equal(Object.prototype.hasOwnProperty.call(CONTEXT, 'meshnotes:faceOrder'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(CONTEXT, 'faceOrder'), false);
});
