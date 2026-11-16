// tests/w3c-format.test.js - Lock and surveyed position in the W3C annotation conversion
// (plan: Unit tests > Alignment and format; loads the browser module through tests/support/app-env.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/app-env.js';
import { T1, makeAlignment, surveyAnnotation, plainAnnotation, group, modelDist } from './support/survey-samples.js';
import { pointFromZUp } from '../js/utils/coords.js';

const { state } = await import('../js/state.js');
const { convertToW3CAnnotation, convertFromW3CAnnotation, formatPointsAsSelector } = await import('../js/export/w3c-format.js');

const roundTrip = (obj) => JSON.parse(JSON.stringify(obj));
const A = makeAlignment({ id: 101, uuid: 'aaaaaaaa-0000-4000-8000-000000000001' });
const G = group(1, 'g1', 'Default');
const GROUP_MAP = { 'uuid:g1': 1 };

state.modelFileName = 'trench3.glb';
state.alignments = [A];

test('an annotation with the lock and a surveyed position survives convertTo/convertFrom unchanged', () => {
    const ann = surveyAnnotation({ id: 1, uuid: 'p1', alignment: A, s: { e: 512003.25, n: 4123007.5, h: 58.75 } });
    const w3c = roundTrip(convertToW3CAnnotation(ann, G));

    // Next to annotationType, in this order; the selector is not touched.
    const keys = Object.keys(w3c);
    const at = keys.indexOf('annotationType');
    assert.deepEqual(keys.slice(at, at + 3), ['annotationType', 'meshnotes:locked', 'meshnotes:surveyedPosition']);
    assert.deepEqual(w3c.target.selector, roundTrip(formatPointsAsSelector(ann)));
    assert.equal(w3c['meshnotes:locked'], true);
    const sp = w3c['meshnotes:surveyedPosition'];
    assert.equal(sp.type, 'meshnotes:SurveyedPosition');
    assert.equal(sp['meshnotes:alignment'], `urn:meshnotes:alignment:${A.uuid}`);
    assert.equal(sp['meshnotes:easting'], 512003.25);
    assert.deepEqual(Object.keys(sp['meshnotes:rawValues']), ['Easting', 'Northing', 'Elevation']);
    assert.deepEqual(Object.keys(sp['meshnotes:attributes']), ['Solution status', 'Averaging start', 'Code']);

    const back = convertFromW3CAnnotation(w3c, GROUP_MAP, { [A.uuid]: A.id });
    assert.equal(back.locked, true);
    assert.deepEqual(back.survey, ann.survey);
    assert.deepEqual(Object.keys(back.survey.attributes), ['Solution status', 'Averaging start', 'Code']);
    assert.equal(back.uuid, 'p1');
    assert.equal(back.groupId, 1);
    // Points stay in the file's Z-up frame here (import-json converts them).
    assert.ok(modelDist(pointFromZUp(back.points[0]), ann.points[0]) < 1e-6);
});

test('the lock works on any annotation type, and an unlocked annotation without survey data gets no new members', () => {
    const box = plainAnnotation({ id: 2, uuid: 'b1', type: 'box', locked: true });
    const boxJson = roundTrip(convertToW3CAnnotation(box, G));
    assert.equal(boxJson['meshnotes:locked'], true);
    assert.equal('meshnotes:surveyedPosition' in boxJson, false);
    const boxBack = convertFromW3CAnnotation(boxJson, GROUP_MAP);
    assert.equal(boxBack.locked, true);
    assert.equal('survey' in boxBack, false);

    const plain = plainAnnotation({ id: 3, uuid: 'n1' });
    const plainJson = roundTrip(convertToW3CAnnotation(plain, G));
    assert.equal('meshnotes:locked' in plainJson, false);
    assert.equal('meshnotes:surveyedPosition' in plainJson, false);
    const plainBack = convertFromW3CAnnotation(plainJson, GROUP_MAP);
    assert.equal('locked' in plainBack, false);
    assert.equal('survey' in plainBack, false);
    assert.equal(convertFromW3CAnnotation({ ...plainJson, 'meshnotes:locked': false }, GROUP_MAP).locked, undefined);
});

test('a detached point or an unknown alignment writes no link and reads back detached', () => {
    const s = { e: 512001, n: 4123002, h: 59 };
    const detached = surveyAnnotation({ id: 4, uuid: 'p2', alignment: A, s, locked: false });
    detached.survey.alignmentId = null;
    const json = roundTrip(convertToW3CAnnotation(detached, G));
    assert.equal('meshnotes:locked' in json, false);
    assert.equal('meshnotes:alignment' in json['meshnotes:surveyedPosition'], false);
    assert.deepEqual(convertFromW3CAnnotation(json, GROUP_MAP, { [A.uuid]: A.id }).survey, detached.survey);

    // An alignment id that is no longer in state.alignments: no link either.
    const orphan = surveyAnnotation({ id: 5, uuid: 'p3', alignment: { ...A, id: 999 }, s });
    assert.equal('meshnotes:alignment' in roundTrip(convertToW3CAnnotation(orphan, G))['meshnotes:surveyedPosition'], false);

    // A link that no map resolves (or no map at all) reads as detached.
    const linked = roundTrip(convertToW3CAnnotation(surveyAnnotation({ id: 6, uuid: 'p4', alignment: A, s }), G));
    assert.equal(convertFromW3CAnnotation(linked, GROUP_MAP).survey.alignmentId, null);
    assert.equal(convertFromW3CAnnotation(linked, GROUP_MAP, { other: 7 }).survey.alignmentId, null);
    assert.equal(convertFromW3CAnnotation(linked, GROUP_MAP).survey.source.importedAt, T1);
});

// ---- created and modified (annotation format section 5, erratum of 2026-11-16) ----

const T2 = '2026-10-02T09:00:00.000Z';
const T3 = '2026-10-03T09:00:00.000Z';

test('created and modified are written from the stored times and read back', () => {
    const ann = { ...plainAnnotation({ id: 7, uuid: 'm1' }), created: T1, modified: T3 };
    const w3c = roundTrip(convertToW3CAnnotation(ann, G));
    assert.equal(w3c.created, T1);
    assert.equal(w3c.modified, T3);
    const back = convertFromW3CAnnotation(w3c, GROUP_MAP);
    assert.equal(back.created, T1);
    assert.equal(back.modified, T3);
});

test('deleting the oldest entry moves modified, not created; an annotation without entries keeps its created', () => {
    const ann = plainAnnotation({ id: 8, uuid: 'm2' });           // one entry at T1
    ann.created = T1;
    ann.entries.push({ id: 9, uuid: 'm2-e2', description: 'Later', author: 'B', timestamp: T2, links: [] });
    ann.entries.shift();                                           // the oldest entry deleted at T3
    ann.modified = T3;
    let w3c = roundTrip(convertToW3CAnnotation(ann, G));
    assert.equal(w3c.created, T1);
    assert.equal(w3c.modified, T3);

    ann.entries = [];
    w3c = roundTrip(convertToW3CAnnotation(ann, G));
    assert.equal(w3c.created, T1, 'not the export time');
    assert.equal(w3c.modified, T3);
});

test('an annotation from before 1.6.6 (no stored times) exports created and modified from its entries, as before', () => {
    const ann = plainAnnotation({ id: 10, uuid: 'm3' });
    ann.entries[0].modified = T2;
    const w3c = roundTrip(convertToW3CAnnotation(ann, G));
    assert.equal(w3c.created, T1);
    assert.equal(w3c.modified, T2);
    const untouched = roundTrip(convertToW3CAnnotation(plainAnnotation({ id: 11, uuid: 'm4' }), G));
    assert.equal(untouched.created, T1);
    assert.equal('modified' in untouched, false);
});
