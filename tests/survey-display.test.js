// tests/survey-display.test.js - Text of the Surveyed position block, the callout line and the hand-move offset
// (plan: What an imported point shows; Edge cases: Unlocked survey point dragged)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SD from '../js/survey/survey-display.js';
import { surveyToStorage, UNSPECIFIED_CRS } from '../js/survey/alignment.js';
import { makeAlignment, surveyAnnotation, plainAnnotation } from './support/survey-samples.js';

// A made-up surveyed coordinate at UTM size (see survey-samples.js SHIFT).
const S = { e: 512003.25, n: 4122994.5, h: 59.125 };
const rowValue = (view, key) => (view.rows.find(r => r.key === key) || {}).value;

test('coordinates and distances use three decimals in metres', () => {
    assert.equal(SD.formatCoordinate(4123456.7891), '4123456.789');
    assert.equal(SD.formatCoordinate(62.3455, 2), '62.35');
    assert.equal(SD.formatMetres(0.1234), '0.123 m');
    assert.equal(SD.formatCoordinate(NaN), '—');
    assert.equal(SD.formatMetres(null), '—');
});

test('surface distance wording follows the sign (positive = above)', () => {
    assert.equal(SD.surfaceDistanceText(null), SD.NOT_MEASURED);
    assert.equal(SD.surfaceDistanceText(undefined), SD.NOT_MEASURED);
    assert.equal(SD.surfaceDistanceText(0.0234), '0.023 m above the surface');
    assert.equal(SD.surfaceDistanceText(-0.0234), '0.023 m below the surface');
    assert.equal(SD.surfaceDistanceText(0.0004), 'on the surface');
    assert.equal(SD.surfaceDistanceText(-0.0004), 'on the surface');
    assert.equal(SD.surfaceDistanceText(SD.ON_SURFACE_TOLERANCE), '0.001 m above the surface');
});

test('the callout line holds E, N and H, and is empty without a survey block', () => {
    assert.equal(SD.surveyCompactLine({ e: 512345.1234, n: 4123456.7896, h: 62.3449 }),
        'E 512345.123  N 4123456.790  H 62.345');
    assert.equal(SD.surveyCompactLine(null), '');
    assert.equal(SD.surveyCompactLine(undefined), '');
});

test('findAlignment resolves the internal id and treats null as detached', () => {
    const a = makeAlignment({ id: 7, uuid: 'al-7' });
    assert.equal(SD.findAlignment([a], 7), a);
    assert.equal(SD.findAlignment([a], 8), null);
    assert.equal(SD.findAlignment([a], null), null);
    assert.equal(SD.findAlignment(undefined, 7), null);
});

test('the hand-move offset is the storage distance to the fitted position', () => {
    const a = makeAlignment({ id: 1, uuid: 'al-1' });
    const fitted = surveyToStorage(a, S);
    assert.ok(SD.handMovedOffset(S, fitted, a) < 1e-9);
    const moved = { x: fitted.x + 0.3, y: fitted.y, z: fitted.z - 0.4 };
    assert.ok(Math.abs(SD.handMovedOffset(S, moved, a) - 0.5) < 1e-9);
    assert.equal(SD.handMovedOffset(S, moved, null), null, 'no alignment, no offset');
    assert.equal(SD.handMovedOffset(S, moved, { rotation: [0, 0, 0], translation: [0, 0, 0] }), null, 'unusable alignment');
    assert.equal(SD.handMovedOffset(S, null, a), null);
    assert.equal(SD.handMovedStatus(0.5), 'Moved by hand: 0.500 m from the surveyed position');
    assert.equal(SD.handMovedStatus(null), 'Moved by hand');
});

test('the block of a point placed by the fit', () => {
    const a = makeAlignment({ id: 1, uuid: 'al-1' });
    const ann = surveyAnnotation({ id: 10, uuid: 'p-10', alignment: a, s: S, surfaceDistance: -0.0234 });
    const before = JSON.stringify(ann);
    const view = SD.surveyedPositionView(ann, [a]);

    assert.equal(view.title, 'Surveyed position');
    assert.deepEqual(view.rows.map(r => r.key), ['e', 'n', 'h', 'crs', 'alignment', 'surface', 'source']);
    assert.equal(rowValue(view, 'e'), '512003.250 m');
    assert.equal(rowValue(view, 'n'), '4122994.500 m');
    assert.equal(rowValue(view, 'h'), '59.125 m (Elevation)');
    assert.equal(rowValue(view, 'crs'), 'EPSG:32635');
    assert.equal(rowValue(view, 'alignment'), 'Trench 3');
    assert.equal(rowValue(view, 'surface'), '0.023 m below the surface');
    assert.equal(rowValue(view, 'source'), 'trench3.csv, row 5');
    assert.equal(view.note, SD.FACE_NORMAL_NOTE);
    assert.equal(view.detached, false);
    assert.equal(view.movedByHand, false);
    assert.equal(view.offset, null);
    assert.equal(view.compact, 'E 512003.250  N 4122994.500  H 59.125');
    assert.deepEqual(view.attributes, [
        { key: 'Solution status', value: 'FIX' },
        { key: 'Averaging start', value: '2026-09-30 10:12:00' },
        { key: 'Code', value: 'GCP' }
    ]);
    assert.equal(JSON.stringify(ann), before, 'the annotation is not changed');
});

test('a hand-moved point shows its offset; a detached one shows no alignment', () => {
    const a = makeAlignment({ id: 1, uuid: 'al-1' });
    const fitted = surveyToStorage(a, S);
    const ann = surveyAnnotation({
        id: 11, uuid: 'p-11', alignment: a, s: S, placement: 'manual',
        position: { x: fitted.x, y: fitted.y + 0.12, z: fitted.z }
    });
    const view = SD.surveyedPositionView(ann, [a]);
    assert.equal(view.movedByHand, true);
    assert.ok(Math.abs(view.offset - 0.12) < 1e-9);
    assert.equal(rowValue(view, 'placement'), 'moved by hand, 0.120 m from the surveyed position');

    // The alignment is gone (or the point was detached): no offset, no label.
    const lost = SD.surveyedPositionView(ann, []);
    assert.equal(lost.detached, true);
    assert.equal(rowValue(lost, 'alignment'), SD.DETACHED);
    assert.equal(rowValue(lost, 'crs'), UNSPECIFIED_CRS);
    assert.equal(rowValue(lost, 'placement'), 'moved by hand');
    assert.equal(lost.offset, null);
});

test('missing pieces: no surface distance, empty label, no source, no attributes', () => {
    const a = { ...makeAlignment({ id: 1, uuid: 'al-1' }), crsLabel: '' };
    const ann = surveyAnnotation({ id: 12, uuid: 'p-12', alignment: a, s: S, surfaceDistance: null });
    ann.survey.attributes = {};
    ann.survey.source = { fileName: '', fileSha256: null, row: null, importedAt: null };
    ann.survey.columns = { e: null, n: null, h: null };
    const view = SD.surveyedPositionView(ann, [a]);
    assert.equal(rowValue(view, 'surface'), SD.NOT_MEASURED);
    assert.equal(view.note, null, 'no side, no face-normal note');
    assert.equal(rowValue(view, 'crs'), UNSPECIFIED_CRS);
    assert.equal(rowValue(view, 'h'), '59.125 m');
    assert.equal(rowValue(view, 'source'), undefined);
    assert.deepEqual(view.attributes, []);
});

test('annotations without a survey block get no block', () => {
    assert.equal(SD.surveyedPositionView(plainAnnotation({ id: 20, uuid: 'n-20' }), []), null);
    assert.equal(SD.surveyedPositionView(null, []), null);
});

test('PDF line: surveyed coordinate, height column and coordinate system in ASCII', () => {
    const a = makeAlignment({ id: 1, uuid: 'al-1' });
    const ann = surveyAnnotation({ id: 30, uuid: 'p-30', alignment: a, s: { e: 512345.1234, n: 4123456.7896, h: 62.3449 } });
    const line = SD.surveyReportLine(ann.survey, [a]);
    assert.equal(line, 'Surveyed: E 512345.123  N 4123456.790  H 62.345 m (Elevation), EPSG:32635');
    assert.match(line, /^[\x20-\x7e]*$/, 'printable ASCII only');

    // Moved by hand; an empty label reads as unspecified.
    ann.survey.placement = 'manual';
    assert.equal(SD.surveyReportLine(ann.survey, [{ ...a, crsLabel: '' }]),
        `Surveyed: E 512345.123  N 4123456.790  H 62.345 m (Elevation), ${UNSPECIFIED_CRS}, moved by hand`);
});

test('PDF line: a detached point or a lost alignment says detached; nothing throws', () => {
    const a = makeAlignment({ id: 1, uuid: 'al-1' });
    const ann = surveyAnnotation({ id: 31, uuid: 'p-31', alignment: null, s: S, placement: 'manual', position: { x: 1, y: 2, z: 3 } });
    assert.equal(SD.surveyReportLine(ann.survey, [a]), 'Surveyed: E 512003.250  N 4122994.500  H 59.125 m (Elevation), detached, moved by hand');

    const linked = surveyAnnotation({ id: 32, uuid: 'p-32', alignment: a, s: S });
    assert.equal(SD.surveyReportLine(linked.survey, []), 'Surveyed: E 512003.250  N 4122994.500  H 59.125 m (Elevation), detached');
    assert.equal(SD.surveyReportLine(linked.survey, null), 'Surveyed: E 512003.250  N 4122994.500  H 59.125 m (Elevation), detached');

    // Missing columns and unusable numbers still give an ASCII line.
    const odd = { alignmentId: 1, e: NaN, n: null, h: 59.125, columns: null };
    assert.equal(SD.surveyReportLine(odd, [a]), 'Surveyed: E n/a  N n/a  H 59.125 m, EPSG:32635');
    assert.equal(SD.surveyReportLine(null, [a]), '');
    assert.equal(SD.surveyReportLine(undefined, [a]), '');
});
