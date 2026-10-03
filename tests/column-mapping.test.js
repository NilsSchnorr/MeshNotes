// tests/column-mapping.test.js - Survey CSV column mapping, checks and records (plan: Unit tests, Column mapping)
// All samples are made up; the fixtures are in tests/fixtures/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    parseSurveyCsv, normaliseHeader, autoMap, applyPreset, detectPreset, roleCandidates, suggestAttributes,
    checkMapping, buildRecords, heightColumnMismatch, headerSignature, swapMappingEN, isKnownHeader,
    isPersonalDataHeader, personalDataColumns, latLonColumns, guessHeaderlessOrder, emptyMapping,
    MAPPING_ERRORS, MAPPING_WARNINGS, SKIP_REASONS, PRESETS
} from '../js/survey/column-mapping.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const codes = (list) => list.map(x => x.code);

// Parse + auto-map + check, as the mapping dialog does.
function run(input, { newAlignment = true, mapping = null } = {}) {
    const p = parseSurveyCsv(input);
    const m = mapping || autoMap(p.headers, p.rows, { hasHeader: p.hasHeader, decimal: p.decimal });
    const c = checkMapping({ headers: p.headers, rows: p.rows, mapping: m, decimal: p.decimal, newAlignment });
    return { p, m, c, name: (j) => (j === null ? null : p.headers[j]) };
}

function mappedNames({ m, name }) {
    return { name: name(m.name), easting: name(m.easting), northing: name(m.northing), height: name(m.height), description: name(m.description), code: name(m.code) };
}

// ---- Plan: Column mapping tests ----

test('the Emlid header maps E, N and H and leaves Easting RMS, Longitude and Latitude unmapped', () => {
    const r = run(fixture('emlid-style.csv'));
    assert.deepEqual(mappedNames(r), {
        name: 'Name', easting: 'Easting', northing: 'Northing', height: 'Elevation', description: 'Description', code: 'Code'
    });
    const mapped = new Set(Object.values(mappedNames(r)));
    for (const h of ['Easting RMS', 'Northing RMS', 'Longitude', 'Latitude', 'Ellipsoidal height', 'Base easting', 'Code description']) {
        assert.ok(!mapped.has(h), h);
    }
    // Suggested attributes: accuracy, solution status and observation time,
    // never the personal-data columns.
    assert.deepEqual(r.m.extras.map(r.name), [
        'Easting RMS', 'Northing RMS', 'Elevation RMS', 'Lateral RMS', 'Solution status', 'Averaging start', 'Averaging end'
    ]);
    assert.deepEqual(personalDataColumns(r.p.headers).map(r.name), ['Device serial number', 'Author']);
    assert.deepEqual(r.c.errors, []);
    // P-106 has no Easting: skipped and announced.
    assert.deepEqual(codes(r.c.warnings), [MAPPING_WARNINGS.ROWS_SKIPPED]);
    assert.deepEqual(r.c.warnings[0].rows, [7]);
    assert.equal(r.c.valid, 5);
    assert.equal(detectPreset(r.p.headers, r.p.rows), 'emlid');
    assert.deepEqual(applyPreset('emlid', r.p.headers), r.m);
});

test('a German header Punkt;Rechtswert;Hochwert;Höhe maps', () => {
    const r = run('Punkt;Rechtswert;Hochwert;Höhe\nP1;500001,234;4100001,567;50,123\nP2;500002,234;4100002,567;50,223\nP3;500004,234;4100001,067;50,323\n');
    assert.equal(r.p.hasHeader, true);
    assert.equal(r.p.decimal, ',');
    assert.deepEqual(mappedNames(r), { name: 'Punkt', easting: 'Rechtswert', northing: 'Hochwert', height: 'Höhe', description: null, code: null });
    assert.deepEqual(r.c.errors, []);
    assert.deepEqual(r.c.warnings, []);
    // The Excel fixture: BOM, CRLF, decimal comma, Beschreibung and Code.
    const x = run(fixture('excel-semicolon.csv'));
    assert.deepEqual(mappedNames(x), { name: 'Punkt', easting: 'Rechtswert', northing: 'Hochwert', height: 'Höhe', description: 'Beschreibung', code: 'Code' });
    assert.deepEqual(x.c.errors, []);
    const recs = buildRecords(x.p.rows, x.m, { decimal: x.p.decimal, headers: x.p.headers });
    assert.equal(recs.valid[1].e, 500130.012);
    assert.equal(recs.valid[1].description, 'Tür „Ost“, "alt"; Schwelle');
    assert.deepEqual(recs.valid.map(v => v.row), [2, 3, 4, 6]);
});

test('two height columns select Elevation', () => {
    for (const header of ['Name,E,N,Ellipsoidal height,Elevation', 'Name,E,N,Elevation,Ellipsoidal height', 'Name,E,N,Elevation (m),Height']) {
        const headers = header.split(',');
        const m = autoMap(headers);
        assert.equal(headers[m.height].startsWith('Elevation'), true, header);
    }
    // Priority Elevation > Height > Höhe > H > Z > Ellipsoidal height.
    const headers = ['Ellipsoidal height', 'Z', 'H', 'Höhe', 'Height', 'Elevation'];
    assert.deepEqual(roleCandidates(headers, 'height').map(j => headers[j]), headers.slice().reverse());
    const xyz = ['Point', 'X', 'Y', 'Ellipsoidal height', 'Z'];
    assert.equal(xyz[autoMap(xyz).height], 'Z');
    assert.equal(autoMap(['Point', 'E', 'N', 'Ellipsoidal height']).height, 3);   // the last resort
    // A height word with an ellipsoid word counts as ellipsoidal.
    const e = ['Name', 'E', 'N', 'Height (ellipsoidal)', 'Altitude'];
    assert.equal(e[autoMap(e).height], 'Altitude');
    // With rows, an empty Elevation column gives way to a filled one.
    const rows = [['A', '1', '2', '', '58.123'], ['B', '3', '4', '', '58.456']];
    assert.equal(autoMap(['Name', 'E', 'N', 'Elevation', 'Ellipsoidal height'], rows).height, 4);
});

test('degrees are detected and blocked', () => {
    const r = run('Name,Easting,Northing,Elevation\nA,27.00014012,37.04320115,52.1\nB,27.00023650,37.04316120,52.0\nC,27.00018380,37.04309700,51.9\n');
    assert.ok(codes(r.c.errors).includes(MAPPING_ERRORS.LATLON_DEGREES));
    // Few decimals but a spread of a few metres in degrees.
    const s = run('Name,E,N,H\nA,27.0001,37.0432,52.1\nB,27.0002,37.0431,52.0\nC,27.0003,37.0430,51.9\n');
    assert.ok(codes(s.c.errors).includes(MAPPING_ERRORS.LATLON_DEGREES));
    // A small local metric grid is not degrees.
    const local = run('Name,E,N,H\nA,12.345,45.678,1.234\nB,25.120,60.010,1.300\nC,40.004,30.333,0.950\n');
    assert.deepEqual(local.c.errors, []);
    // ... also when exported with 6 or more decimals (QField, CloudCompare).
    const six = run('Name,E,N,H\nA,12.345678,23.456789,1.234567\nB,45.123456,58.654321,1.334567\nC,19.345678,71.456789,1.434567\n');
    assert.deepEqual(six.c.errors, []);
    const ten = run('fid,x,y,z\n1,12.3456789012,45.6789123456,1.2345678901\n2,25.1200010000,60.0100020000,1.3000030000\n3,40.0040040000,30.3333330000,0.9500010000\n');
    assert.ok(!codes(ten.c.errors).includes(MAPPING_ERRORS.LATLON_DEGREES));
    // Real degrees over a few kilometres with many decimals are still blocked.
    const wide = run('Name,E,N,H\nA,27.0001401,37.0432012,52.1\nB,27.0602365,37.0931612,52.0\nC,27.1201838,37.0130970,51.9\n');
    assert.ok(codes(wide.c.errors).includes(MAPPING_ERRORS.LATLON_DEGREES));
});

test('the 7-digit/6-digit swap hint fires', () => {
    const r = run('Name,Easting,Northing,Elevation\nA,4100023.456,500012.345,52.118\nB,4100019.007,500020.901,52.064\nC,4100011.874,500016.220,51.902\n');
    assert.deepEqual(codes(r.c.warnings), [MAPPING_WARNINGS.SWAP_SUSPECTED]);
    assert.equal(r.c.warnings[0].eastingDigits, 7);
    // The Swap button exchanges the two columns and the hint goes away.
    const swapped = swapMappingEN(r.m);
    assert.equal(swapped.easting, r.m.northing);
    const c = checkMapping({ headers: r.p.headers, rows: r.p.rows, mapping: swapped, decimal: r.p.decimal });
    assert.deepEqual(c.warnings, []);
});

test('the rounding warning fires', () => {
    const r = run('Name,Easting,Northing,Elevation\nA,500012.3,4100023.5,52.118\nB,500020,4100019.0,52.064\nC,500016.2,4100011.9,51.902\n');
    assert.deepEqual(codes(r.c.warnings), [MAPPING_WARNINGS.ROUNDED]);
    assert.deepEqual(r.c.warnings[0].columns, ['Easting', 'Northing']);
    const h = run('Name,Easting,Northing,Elevation\nA,500012.345,4100023.456,52\nB,500020.901,4100019.007,52\nC,500016.220,4100011.874,51.9\n');
    assert.deepEqual(h.c.warnings[0].columns, ['Elevation']);
    // One value without its trailing zeros (52.100 -> 52.1) does not make a column rounded.
    const one = run('Name,Easting,Northing,Elevation\nA,500012.345,4100023.456,52.118\nB,500020.901,4100019.007,52.1\nC,500016.220,4100011.874,51.902\n');
    assert.deepEqual(one.c.warnings, []);
});

// ---- Further mapping cases ----

test('Turkish headers map', () => {
    const r = run('Nokta;Doğu;Kuzey;Yükseklik;Açıklama;Kod\nN1;500001,1;4100001,12;50,123;Duvar köşesi;DV\nN2;500002,2;4100002,23;50,223;;DV\nN3;500003,3;4100001,34;50,323;Eşik;ES\n');
    assert.deepEqual(mappedNames(r), { name: 'Nokta', easting: 'Doğu', northing: 'Kuzey', height: 'Yükseklik', description: 'Açıklama', code: 'Kod' });
    const headers = ['Nokta Adı', 'Sağa (Y)', 'Yukarı (X)', 'Kot'];
    const m = autoMap(headers);
    assert.deepEqual([m.name, m.easting, m.northing, m.height], [0, 1, 2, 3]);
});

test('German short headers R and H are Rechtswert and Hochwert', () => {
    const z = autoMap(['Punkt', 'R', 'H', 'Z']);
    assert.deepEqual([z.name, z.easting, z.northing, z.height], [0, 1, 2, 3]);
    const hoehe = autoMap(['Punkt', 'R', 'H', 'Höhe']);
    assert.deepEqual([hoehe.easting, hoehe.northing, hoehe.height], [1, 2, 3]);
    // H alone is still a height.
    assert.equal(autoMap(['Punkt', 'E', 'N', 'H']).height, 3);
});

test('normaliseHeader folds case, diacritics, punctuation and units', () => {
    assert.equal(normaliseHeader('Elevation (m)'), 'elevation');
    assert.equal(normaliseHeader('  Höhe [m ü. NN] '), 'hohe');
    assert.equal(normaliseHeader('Point_ID'), 'point id');
    assert.equal(normaliseHeader('YUKARI'), 'yukari');
    assert.equal(normaliseHeader('Yukarı'), 'yukari');
    assert.equal(normaliseHeader('Açıklama'), 'aciklama');
    assert.equal(normaliseHeader('İsim'), 'isim');
    assert.equal(normaliseHeader('Straße'), 'strasse');
    assert.equal(normaliseHeader('Easting (RMS)'), 'easting rms');     // not a unit: kept as a word
    assert.equal(normaliseHeader('Height (ellipsoidal)'), 'height ellipsoidal');
});

test('Easting RMS is never Easting, and qualifiers around a synonym are allowed', () => {
    assert.equal(autoMap(['Name', 'Easting RMS', 'Northing RMS', 'Elevation RMS']).easting, null);
    assert.equal(autoMap(['Name', 'Easting RMS', 'Northing', 'Elevation']).easting, null);
    assert.equal(autoMap(['Name', 'Base easting', 'Base northing', 'Base elevation']).height, null);
    const m = autoMap(['Pt', 'Easting UTM 35N', 'UTM Northing', 'Höhe ü. NN', 'Longitude', 'Latitude']);
    assert.deepEqual([m.name, m.easting, m.northing, m.height], [0, 1, 2, 3]);
    // An exact match beats a qualified one to its left.
    assert.deepEqual(roleCandidates(['Name', 'Easting UTM', 'Easting', 'Northing', 'Elevation'], 'easting'), [2, 1]);
    assert.equal(autoMap(['Name', 'Easting UTM', 'Easting', 'Northing', 'Elevation']).easting, 2);
    assert.equal(isKnownHeader('Longitude'), true);
    assert.deepEqual(latLonColumns(['Name', 'Lat (deg)', 'Long']), { lat: 1, lon: 2 });
    assert.deepEqual(latLonColumns(['Name', 'E', 'N']), { lat: null, lon: null });
    // Longitude and Latitude are never mapped, even as the only coordinates.
    const ll = autoMap(['Name', 'Longitude', 'Latitude', 'Elevation']);
    assert.deepEqual([ll.easting, ll.northing], [null, null]);
});

test('X and Y: GIS order by default, X as north when the digits say so, with a warning', () => {
    const gis = run('Point,X,Y,Z\nA,500012.345,4100023.456,52.118\nB,500020.901,4100019.007,52.064\nC,500016.220,4100011.874,51.902\n');
    assert.equal(gis.name(gis.m.easting), 'X');
    assert.deepEqual(codes(gis.c.warnings), [MAPPING_WARNINGS.XY_COLUMNS]);
    const tr = run('Point,X,Y,Z\nA,4100023.456,500012.345,52.118\nB,4100019.007,500020.901,52.064\nC,4100011.874,500016.220,51.902\n');
    assert.equal(tr.name(tr.m.easting), 'Y');
    assert.equal(tr.name(tr.m.northing), 'X');
    assert.deepEqual(codes(tr.c.warnings), [MAPPING_WARNINGS.XY_COLUMNS]);
});

test('presets: PENZD, PNEZD and header-less auto', () => {
    assert.deepEqual(PRESETS.map(p => p.id), ['auto', 'emlid', 'penzd', 'pnezd', 'custom']);
    const r = run(fixture('penzd.csv'));
    assert.equal(r.p.hasHeader, false);
    assert.deepEqual([r.m.name, r.m.easting, r.m.northing, r.m.height, r.m.description, r.m.code], [0, 1, 2, 3, 4, null]);
    assert.deepEqual(r.c.errors, []);
    assert.equal(detectPreset(r.p.headers, r.p.rows, { hasHeader: false }), 'penzd');

    const pn = parseSurveyCsv('1,4100020.456,500010.123,51.234,NW\n2,4100020.101,500018.877,51.198,NE\n3,4100011.932,500018.540,50.877,SE\n');
    assert.equal(guessHeaderlessOrder(pn.rows), 'pnezd');
    const m = autoMap(pn.headers, pn.rows, { hasHeader: false });
    assert.deepEqual([m.easting, m.northing], [2, 1]);
    assert.deepEqual(applyPreset('pnezd', pn.headers), m);
    assert.deepEqual(applyPreset('penzd', ['a', 'b', 'c', 'd']), { ...emptyMapping(), name: 0, easting: 1, northing: 2, height: 3 });
    assert.equal(applyPreset('custom', pn.headers), null);
    assert.throws(() => applyPreset('leica', pn.headers), RangeError);
});

// ---- Checks ----

test('Emlid export with blank Easting and Northing but filled Longitude and Latitude is blocked', () => {
    const r = run('Name,Code,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height\n' +
        'A,,,,52.1,,27.00014012,37.04320115,88.7\nB,,,,52.0,,27.00023650,37.04316120,88.6\nC,,,,51.9,,27.00018380,37.04309700,88.5\n');
    assert.deepEqual(codes(r.c.errors), [MAPPING_ERRORS.LATLON_ONLY]);
    assert.match(r.c.errors[0].message, /projected/);
});

test('missing and repeated coordinate columns block', () => {
    const headers = ['Name', 'E', 'N', 'H'];
    const rows = [['A', '500001.1', '4100001.1', '50.1']];
    const same = checkMapping({ headers, rows, mapping: { ...emptyMapping(), easting: 1, northing: 2, height: 2 } });
    assert.deepEqual(codes(same.errors), [MAPPING_ERRORS.SAME_COLUMN]);
    const missing = checkMapping({ headers, rows, mapping: { ...emptyMapping(), easting: 1 } });
    assert.deepEqual(codes(missing.errors), [MAPPING_ERRORS.MISSING_COLUMN]);
    assert.deepEqual(missing.errors[0].roles, ['northing', 'height']);
    assert.match(missing.errors[0].message, /Northing and Height/);
});

test('fewer than 3 valid rows block a new alignment only', () => {
    const text = 'Name,E,N,H\nA,500001.123,4100001.123,50.123\nB,500002.123,4100002.123,50.223\nC,,4100003.123,50.323\n';
    const r = run(text);
    assert.deepEqual(codes(r.c.errors), [MAPPING_ERRORS.TOO_FEW_ROWS]);
    assert.equal(r.c.errors[0].valid, 2);
    const existing = run(text, { newAlignment: false });
    assert.deepEqual(existing.c.errors, []);
    const none = run('Name,E,N,H\nA,x,y,z\n', { newAlignment: false });
    assert.deepEqual(codes(none.c.errors), [MAPPING_ERRORS.NO_VALID_ROWS]);
});

test('personal-data columns ticked as attributes give a warning', () => {
    const r = run(fixture('emlid-style.csv'));
    const author = r.p.headers.indexOf('Author'), serial = r.p.headers.indexOf('Device serial number');
    const m = { ...r.m, extras: [...r.m.extras, serial, author] };
    const c = checkMapping({ headers: r.p.headers, rows: r.p.rows, mapping: m, decimal: r.p.decimal });
    const w = c.warnings.find(x => x.code === MAPPING_WARNINGS.PERSONAL_DATA);
    assert.deepEqual(w.columns, ['Device serial number', 'Author']);
    for (const h of ['Surveyor', 'Operator', 'User name', 'Receiver S/N', 'Seriennummer', 'Bearbeiter', 'Kullanıcı']) {
        assert.equal(isPersonalDataHeader(h), true, h);
    }
    for (const h of ['Name', 'Device type', 'Point number', 'Solution status']) {
        assert.equal(isPersonalDataHeader(h), false, h);
    }
    assert.ok(!suggestAttributes(['Name', 'Author', 'Operator RMS', 'Fix time']).includes(1));
    assert.deepEqual(suggestAttributes(['Name', 'Author', 'Operator RMS', 'Fix time']), [3]);
});

test('height column mismatch with the alignment', () => {
    assert.equal(heightColumnMismatch('Elevation', 'Elevation (m)'), null);
    assert.equal(heightColumnMismatch(null, 'Elevation'), null);
    const w = heightColumnMismatch('Elevation', 'Ellipsoidal height');
    assert.equal(w.code, MAPPING_WARNINGS.HEIGHT_COLUMN_MISMATCH);
    assert.equal(w.expected, 'Elevation');
    assert.equal(w.actual, 'Ellipsoidal height');
    // A second column of the same name is a different column.
    const p = parseSurveyCsv('Name,E,N,Height,Height\nA,1,2,3,4\n');
    assert.equal(p.headers[4], 'Height (2)');
    assert.equal(heightColumnMismatch('Height', p.headers[4]).code, MAPPING_WARNINGS.HEIGHT_COLUMN_MISMATCH);
    assert.equal(heightColumnMismatch('Height (2)', 'Height (2)'), null);
});

// ---- Records ----

test('buildRecords turns rows into point records and lists skipped rows', () => {
    const r = run(fixture('emlid-style.csv'));
    const { valid, skipped } = buildRecords(r.p.rows, r.m, { decimal: r.p.decimal, headers: r.p.headers });
    assert.equal(valid.length, 5);
    const g1 = valid[0];
    assert.equal(g1.row, 2);
    assert.equal(g1.line, 2);
    assert.equal(g1.name, 'GCP_01');
    assert.deepEqual([g1.e, g1.n, g1.h], [500012.345, 4100023.456, 52.118]);
    assert.deepEqual(g1.raw, { e: '500012.345', n: '4100023.456', h: '52.118' });
    assert.deepEqual(g1.columns, { e: 'Easting', n: 'Northing', h: 'Elevation' });
    assert.equal(g1.description, 'Wall corner, north side');
    assert.equal(g1.code, 'GCP');
    assert.deepEqual(g1.attributes, {
        'Easting RMS': '0.008', 'Northing RMS': '0.009', 'Elevation RMS': '0.014', 'Lateral RMS': '0.012',
        'Solution status': 'FIX', 'Averaging start': '2025-07-01 09:12:03.0 UTC+03:00', 'Averaging end': '2025-07-01 09:13:03.0 UTC+03:00'
    });
    assert.equal(valid[2].description, 'Threshold\nwest end');
    assert.equal(valid[2].line, 4);
    assert.equal(valid[3].code, '');
    assert.equal(valid[4].name, '');                         // the importer names it "file row 6"
    assert.equal(valid[4].row, 6);
    assert.deepEqual(skipped, [{
        row: 7, line: 8, name: 'P-106', reason: SKIP_REASONS.MISSING_VALUE, column: 'Easting', value: '', message: 'Easting is empty'
    }]);

    const bad = buildRecords([['A', '12a', '2', '3']], { ...emptyMapping(), name: 0, easting: 1, northing: 2, height: 3 }, { headers: ['P', 'E', 'N', 'H'] });
    assert.equal(bad.skipped[0].reason, SKIP_REASONS.NOT_A_NUMBER);
    assert.equal(bad.skipped[0].row, 1);
    assert.equal(bad.skipped[0].message, 'E is not a number: "12a"');
    assert.throws(() => buildRecords([], emptyMapping()), TypeError);
});

test('headerSignature identifies the same header', () => {
    const a = parseSurveyCsv('Name,Easting,Northing,Elevation,\nA,1,2,3,\n');
    const b = parseSurveyCsv('name ; EASTING ; Northing ; Elevation (m)\nA;1;2;3\n');
    assert.equal(headerSignature(a.rawHeaders), 'name|easting|northing|elevation');
    assert.equal(headerSignature(a.rawHeaders), headerSignature(b.rawHeaders));
    assert.notEqual(headerSignature(a.rawHeaders), headerSignature(['Name', 'Northing', 'Easting', 'Elevation']));
    assert.equal(headerSignature(null), null);
    assert.equal(headerSignature(parseSurveyCsv(fixture('penzd.csv')).rawHeaders), null);
});
