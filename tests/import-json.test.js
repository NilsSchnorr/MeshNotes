// tests/import-json.test.js - JSON-LD export and import of alignments, survey points, lock and group flags, and the merge rules
// (plan: Unit tests > Alignment and format; loads the browser modules through tests/support/app-env.js
// and drives mergeW3CCollection, the data part of the import, without a DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/app-env.js';
import {
    T1, T2, T3, T5, makeAlignment, refined, surveyAnnotation, plainAnnotation, group, modelDist
} from './support/survey-samples.js';
import * as AL from '../js/survey/alignment.js';

const { state } = await import('../js/state.js');
const { buildAnnotationJSON } = await import('../js/export/export-json.js');
const { mergeW3CCollection } = await import('../js/export/import-json.js');

const UA = 'aaaaaaaa-0000-4000-8000-000000000001';
const UB = 'bbbbbbbb-0000-4000-8000-000000000002';

const clone = (v) => structuredClone(v);

// Puts a session into the shared state (as a model load plus edits would).
function setSession({ groups = [], annotations = [], alignments = [], defaultAlignmentId = null, frameOrigin = null } = {}) {
    state.modelFileName = 'trench3.glb';
    state.modelHash = 'abc123';
    state.modelFrameOrigin = frameOrigin;
    state.modelInfo = { entries: [], metadata: null };
    state.groups = groups;
    state.annotations = annotations;
    state.alignments = alignments;
    state.defaultAlignmentId = defaultAlignmentId;
}

// The JSON-LD another session would export.
function exportSession(session) {
    setSession(clone(session));
    return JSON.parse(buildAnnotationJSON());
}

const byUuid = (uuid) => state.annotations.find(a => a.uuid === uuid);
const near = (a, b) => modelDist(a, b) < 1e-6;

test('buildAnnotationJSON writes alignments, default alignment, frame origin and group flags, and an autosave restore brings them back', () => {
    const a = refined(makeAlignment({ id: 101, uuid: UA, now: T1 }), { headingDeg: 90.4, now: T2 });
    const b = makeAlignment({ id: 102, uuid: UB, headingDeg: 30, now: T3, name: 'Wall' });
    const s1 = { e: 512003.25, n: 4123007.5, h: 58.75 };
    const p1 = surveyAnnotation({ id: 1, uuid: 'p1', alignment: a, s: s1, groupId: 2 });
    const p2 = surveyAnnotation({ id: 2, uuid: 'p2', alignment: a, s: { e: 512001, n: 4123002, h: 59 }, groupId: 2, locked: false, placement: 'manual' });
    p2.survey.alignmentId = null;   // detached
    const n1 = plainAnnotation({ id: 3, uuid: 'n1' });
    const box = plainAnnotation({ id: 4, uuid: 'box1', type: 'box', locked: true });
    setSession({
        groups: [group(1, 'g1', 'Default'), group(2, 'g2', 'trench3.csv', { collapsed: true, labelsVisible: false })],
        annotations: [p1, p2, n1, box],
        alignments: [a, b],
        defaultAlignmentId: b.id,
        frameOrigin: { x: 12.5, y: -3.25, z: 0.125 }
    });
    const before = clone({ p1, p2, n1, box });
    const text = buildAnnotationJSON();
    const json = JSON.parse(text);

    // Collection level, right after the groups.
    const keys = Object.keys(json);
    const g = keys.indexOf('meshnotes:groups');
    assert.deepEqual(keys.slice(g, g + 3), ['meshnotes:groups', 'meshnotes:alignments', 'meshnotes:defaultAlignment']);
    assert.deepEqual(json['meshnotes:alignments'], JSON.parse(JSON.stringify(AL.alignmentsToJsonLd([a, b])['meshnotes:alignments'])));
    assert.equal(json['meshnotes:defaultAlignment'], `urn:meshnotes:alignment:${UB}`);
    assert.equal(json.modelSource['meshnotes:frameOrigin'], 'POINT Z (12.5 -3.25 0.125)');
    // Flags only where they differ from the default.
    assert.equal('meshnotes:labelsVisible' in json['meshnotes:groups'][0], false);
    assert.equal('meshnotes:collapsed' in json['meshnotes:groups'][0], false);
    assert.equal(json['meshnotes:groups'][1]['meshnotes:labelsVisible'], false);
    assert.equal(json['meshnotes:groups'][1]['meshnotes:collapsed'], true);
    // Short number lists on one line, like the box rotation.
    assert.match(text, /"meshnotes:translation": \[[^\]\n]+\]/);
    assert.match(text, /"meshnotes:residual": \[[^\]\n]+\]/);
    const items = json.first.items;
    assert.equal(items[0]['meshnotes:locked'], true);
    assert.equal(items[0]['meshnotes:surveyedPosition']['meshnotes:alignment'], `urn:meshnotes:alignment:${UA}`);
    assert.equal('meshnotes:alignment' in items[1]['meshnotes:surveyedPosition'], false);
    assert.equal('meshnotes:locked' in items[2] || 'meshnotes:surveyedPosition' in items[2], false);
    assert.equal(items[3]['meshnotes:locked'], true);

    // Same model reloaded: the session is cleared, the autosave blob is imported.
    setSession({ frameOrigin: { x: 12.5, y: -3.25, z: 0.125 } });
    const result = mergeW3CCollection(clone(json));
    assert.deepEqual(result.alignments, { added: [UA, UB], replaced: [], kept: [], skipped: 0 });
    assert.deepEqual(result.realign, []);
    assert.equal(result.added, 4);
    assert.deepEqual({ ...state.alignments[0], id: a.id }, a);
    assert.deepEqual({ ...state.alignments[1], id: b.id }, b);
    const [ra, rb] = state.alignments;
    assert.equal(state.defaultAlignmentId, rb.id);
    assert.equal('collapsed' in state.groups[0] || 'labelsVisible' in state.groups[0], false);
    assert.equal(state.groups[1].collapsed, true);
    assert.equal(state.groups[1].labelsVisible, false);

    const rp1 = byUuid('p1');
    assert.equal(rp1.locked, true);
    assert.deepEqual(rp1.survey, { ...before.p1.survey, alignmentId: ra.id });
    assert.ok(near(rp1.points[0], before.p1.points[0]));
    assert.equal(rp1.groupId, state.groups[1].id);
    assert.deepEqual(byUuid('p2').survey, before.p2.survey);
    assert.equal('locked' in byUuid('p2'), false);
    assert.equal('locked' in byUuid('n1') || 'survey' in byUuid('n1'), false);
    assert.equal(byUuid('box1').locked, true);

    // A second round gives the same survey members.
    const again = JSON.parse(buildAnnotationJSON());
    assert.deepEqual(again['meshnotes:alignments'], json['meshnotes:alignments']);
    assert.equal(again['meshnotes:defaultAlignment'], json['meshnotes:defaultAlignment']);
    const surveyMembers = (item) => [item['meshnotes:locked'], item['meshnotes:surveyedPosition']];
    assert.deepEqual(again.first.items.map(surveyMembers), items.map(surveyMembers));
});

test('a v1.5-shaped file imports exactly as before', () => {
    const c = makeAlignment({ id: 103, uuid: UA, now: T1 });
    const local = surveyAnnotation({ id: 1, uuid: 'p1', alignment: c, s: { e: 512003.25, n: 4123007.5, h: 58.75 } });
    const alignments = [c];
    setSession({ groups: [group(1, 'g1', 'Default')], annotations: [local], alignments, defaultAlignmentId: c.id });
    const localBefore = clone(local);

    // Shaped like a v1.5.1 export, plus a member from some future version.
    const v15 = {
        '@context': ['http://www.w3.org/ns/anno.jsonld', 'https://meshnotes.org/ns/context-v1.jsonld'],
        type: 'AnnotationCollection',
        id: 'urn:meshnotes:collection:00000000-0000-4000-8000-0000000000ff',
        generator: { type: 'Software', name: 'MeshNotes', 'schema:version': '1.5.1' },
        'dcterms:conformsTo': 'https://meshnotes.org/spec/annotation/v1/',
        modelSource: { type: 'Dataset', 'schema:name': 'trench3.glb', upAxis: 'Z' },
        'meshnotes:groups': [{ id: 7, 'meshnotes:uuid': 'g7', 'schema:name': 'Finds', 'schema:color': '#ff0000', 'meshnotes:visible': true, 'meshnotes:opacity': 1 }],
        'meshnotes:futureThing': { a: 1 },
        total: 1,
        first: {
            type: 'AnnotationPage',
            items: [{
                type: 'Annotation',
                id: 'urn:meshnotes:annotation:n1',
                created: T1,
                'schema:name': 'Sherd',
                target: { selector: { type: 'meshnotes:PointSelector', 'meshnotes:wkt': 'POINT Z (1 2 3)' } },
                body: [{ type: 'TextualBody', value: 'Rim', created: T1, 'meshnotes:entryUuid': 'n1-e1' }],
                'meshnotes:groupUuid': 'g7',
                annotationType: 'point',
                'meshnotes:somethingNew': true
            }]
        }
    };
    const result = mergeW3CCollection(clone(v15));
    assert.equal(result.added, 1);
    assert.deepEqual(result.alignments, { added: [], replaced: [], kept: [], skipped: 0 });
    assert.deepEqual(result.realign, []);
    assert.equal(state.alignments, alignments);         // not even replaced by a copy
    assert.equal(state.defaultAlignmentId, c.id);
    assert.deepEqual(Object.keys(state.groups[1]).sort(), ['color', 'id', 'name', 'opacity', 'uuid', 'visible']);
    const n1 = byUuid('n1');
    assert.deepEqual(Object.keys(n1).sort(), ['entries', 'groupId', 'id', 'name', 'points', 'type', 'uuid']);
    assert.deepEqual(n1.points[0], { x: 1, y: 3, z: -2 });   // Z-up file -> Y-up storage
    assert.deepEqual(local, localBefore);

    // The same survey point re-exported by v1.5.x (no survey block, no lock),
    // with a newer entry and a moved position: the entries rule moves it as
    // before, and the local survey data and lock stay (v1.5.x drops both).
    const reexport = clone(v15);
    reexport.first.items = [{
        type: 'Annotation',
        id: 'urn:meshnotes:annotation:p1',
        created: T1,
        'schema:name': 'Renamed in 1.5',
        target: { selector: { type: 'meshnotes:PointSelector', 'meshnotes:wkt': 'POINT Z (4 5 6)' } },
        body: [{ type: 'TextualBody', value: 'Code: GCP', created: T1, modified: T3, 'meshnotes:entryUuid': 'p1-e1' }],
        annotationType: 'point'
    }];
    mergeW3CCollection(reexport);
    assert.equal(local.name, 'Renamed in 1.5');
    assert.deepEqual(local.points[0], { x: 4, y: 6, z: -5 });
    assert.deepEqual(local.survey, localBefore.survey);
    assert.equal(local.locked, true);
});

test('merge: a newer alignment with the same uuid wins and survey points follow it; local-only points are reported', () => {
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const b = makeAlignment({ id: 102, uuid: UB, headingDeg: 30, now: T5 });
    const s1 = { e: 512003.25, n: 4123007.5, h: 58.75 };
    const s2 = { e: 512004.5, n: 4123001.25, h: 58.5 };
    const s3 = { e: 511998.75, n: 4123003, h: 58.25 };
    const s4 = { e: 512000.5, n: 4122999.5, h: 59.125 };
    const s5 = { e: 512002, n: 4123004, h: 58 };
    const s6 = { e: 512001.5, n: 4123005.5, h: 58.5 };
    const s7 = { e: 511999.25, n: 4123000.75, h: 59.25 };

    // Another session refined A later (T2) and holds an older fit of B (T3).
    const a2 = refined(a, { id: 501, headingDeg: 90.5, now: T2 });
    const bOld = makeAlignment({ id: 502, uuid: UB, headingDeg: 29, now: T3 });
    const file = exportSession({
        groups: [group(1, 'g1', 'Default'), group(2, 'g2', 'trench3.csv', { collapsed: true })],
        annotations: [
            surveyAnnotation({ id: 1, uuid: 'p1', alignment: a2, s: s1, locked: false, surfaceDistance: 0.034 }),
            surveyAnnotation({ id: 2, uuid: 'p2', alignment: bOld, s: s2, name: 'Renamed', entryModified: T3 }),
            surveyAnnotation({ id: 5, uuid: 'p5', alignment: a2, s: s5 }),
            surveyAnnotation({ id: 6, uuid: 'p6', alignment: null, s: s6, position: { x: 4, y: 5, z: 6 } }),
            surveyAnnotation({ id: 7, uuid: 'p7', alignment: a2, s: s7 })
        ],
        alignments: [a2, bOld],
        defaultAlignmentId: 501
    });

    // This session: A at T1, B at T5, a local default, two points only here.
    const p1 = surveyAnnotation({ id: 11, uuid: 'p1', alignment: a, s: s1 });
    const p2 = surveyAnnotation({ id: 12, uuid: 'p2', alignment: b, s: s2 });
    const p3 = surveyAnnotation({ id: 13, uuid: 'p3', alignment: a, s: s3 });
    const p4 = surveyAnnotation({ id: 14, uuid: 'p4', alignment: a, s: s4, placement: 'manual', position: { x: 1, y: 2, z: 3 } });
    const p6 = surveyAnnotation({ id: 16, uuid: 'p6', alignment: a, s: s6 });
    const p7 = surveyAnnotation({ id: 17, uuid: 'p7', alignment: a, s: s7, locked: false });
    setSession({
        groups: [group(1, 'g1', 'Default'), group(2, 'g2', 'trench3.csv')],
        annotations: [p1, p2, p3, p4, p6, p7],
        alignments: [a, b],
        defaultAlignmentId: b.id
    });
    const before = clone({ p2, p3, p4, p6 });

    const result = mergeW3CCollection(file);
    assert.deepEqual(result.alignments, { added: [], replaced: [UA], kept: [UB], skipped: 0 });
    assert.equal(state.alignments.length, 2);
    assert.equal(state.alignments[0].id, a.id);                       // the local id stays
    assert.deepEqual(state.alignments[0].rotation, a2.rotation);
    // B: the local fit stays; the older imported fit joins its history.
    assert.equal(state.alignments[1].id, b.id);
    assert.deepEqual(state.alignments[1].rotation, b.rotation);
    assert.equal(state.alignments[1].modified, T5);
    assert.deepEqual(state.alignments[1].versions.map(v => v.rotation), [bOld.rotation]);
    assert.equal(state.defaultAlignmentId, b.id);                     // the local choice stays
    assert.equal(state.groups[1].collapsed, undefined);               // existing group keeps its flags

    // p1: the imported alignment is newer, so position, survey block and
    // lock come from the file, although the entries are the same age.
    assert.ok(near(p1.points[0], AL.surveyToStorage(a2, s1)));
    assert.equal(p1.survey.surfaceDistance, 0.034);
    assert.equal(p1.survey.alignmentId, a.id);
    assert.equal(p1.locked, false);
    // p2: the local alignment is newer, so position and survey stay, while
    // the newer entries still bring the name.
    assert.equal(p2.name, 'Renamed');
    assert.deepEqual(p2.points, before.p2.points);
    assert.deepEqual(p2.survey, before.p2.survey);
    assert.equal(p2.locked, true);
    // p7: unlocked here, locked in the file on the newer alignment: locked.
    assert.ok(near(p7.points[0], AL.surveyToStorage(a2, s7)));
    assert.equal(p7.locked, true);
    // p6: detached over there, entries the same age: the local copy stays,
    // still a 'fit' point of A at the old fit's position.
    assert.deepEqual(p6.points, before.p6.points);
    assert.deepEqual(p6.survey, before.p6.survey);
    assert.equal(result.merged, 3);
    // p5: new, linked to the local id of A.
    assert.equal(result.added, 1);
    assert.equal(byUuid('p5').survey.alignmentId, a.id);

    // p3 and p4 exist only here, p6 kept its local position: reported for
    // the caller, not moved.
    assert.deepEqual(p3.points, before.p3.points);
    assert.deepEqual(p4.points, before.p4.points);
    assert.equal(result.realign.length, 1);
    const { uuid, previous, alignment, plan } = result.realign[0];
    assert.equal(uuid, UA);
    assert.equal(previous, a);
    assert.equal(alignment, state.alignments[0]);
    assert.deepEqual(plan.moves.map(m => m.annotation.uuid), ['p3', 'p6']);
    assert.ok(near(plan.moves[0].from, before.p3.points[0]));
    assert.ok(near(plan.moves[0].to, AL.surveyToStorage(a2, s3)));
    assert.ok(plan.maxDisplacement > 0.01);
    assert.deepEqual(plan.manual.map(m => m.uuid), ['p4']);
});

test('merge: a survey point moved by hand on either side follows the entries rule', () => {
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const a2 = refined(a, { id: 501, headingDeg: 90.5, now: T2 });
    const s = (k) => ({ e: 512000 + k, n: 4123000 + k, h: 58 + k / 4 });
    const moved = { x: 0.25, y: 0.5, z: 0.75 };

    const file = exportSession({
        groups: [group(1, 'g1', 'Default')],
        annotations: [
            // q1: placed by the newer fit, entries not newer.
            surveyAnnotation({ id: 1, uuid: 'q1', alignment: a2, s: s(1) }),
            // q2: moved by hand over there, entries newer.
            surveyAnnotation({ id: 2, uuid: 'q2', alignment: a2, s: s(2), placement: 'manual', position: moved, locked: false, entryModified: T3 }),
            // q3: placed by the newer fit, entries newer.
            surveyAnnotation({ id: 3, uuid: 'q3', alignment: a2, s: s(3), entryModified: T3 })
        ],
        alignments: [a2]
    });
    const q1 = surveyAnnotation({ id: 11, uuid: 'q1', alignment: a, s: s(1), placement: 'manual', position: { x: 1, y: 1, z: 1 } });
    const q2 = surveyAnnotation({ id: 12, uuid: 'q2', alignment: a, s: s(2) });
    const q3 = surveyAnnotation({ id: 13, uuid: 'q3', alignment: a, s: s(3), placement: 'manual', position: { x: 2, y: 2, z: 2 } });
    setSession({ groups: [group(1, 'g1', 'Default')], annotations: [q1, q2, q3], alignments: [a] });
    const before = clone({ q1 });

    const result = mergeW3CCollection(file);
    assert.deepEqual(result.alignments.replaced, [UA]);
    // q1: hand-moved here and the entries are not newer: nothing changes.
    assert.deepEqual(q1.points, before.q1.points);
    assert.deepEqual(q1.survey, before.q1.survey);
    // q2: hand-moved over there with newer entries: that copy wins.
    assert.ok(near(q2.points[0], moved));
    assert.equal(q2.survey.placement, 'manual');
    assert.equal(q2.locked, false);
    // q3: hand-moved here, but the imported entries are newer: the file wins.
    assert.ok(near(q3.points[0], AL.surveyToStorage(a2, s(3))));
    assert.equal(q3.survey.placement, 'fit');
    // All three exist on both sides, so none is left for the caller.
    assert.deepEqual(result.realign, []);
});
