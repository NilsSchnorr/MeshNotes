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
