// tests/csv-parse.test.js - Survey CSV decoding, tokenising and detection (plan: Unit tests, CSV parser)
// All samples are made up; the fixtures are in tests/fixtures/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    parseCsv, decode, tokenize, detectDelimiter, detectDecimal, detectHeader,
    parseNumber, decimalPlaces, CSV_ERRORS, CSV_WARNINGS, CSV_NOTICES
} from '../js/survey/csv-parse.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const utf8 = (s) => new TextEncoder().encode(s);
const codes = (list) => list.map(x => x.code);

// ---- Plan: CSV parser tests ----

test('Emlid header with a trailing comma and rows longer than the header', () => {
    const p = parseCsv(fixture('emlid-style.csv'));
    assert.deepEqual(p.errors, []);
    assert.equal(p.encoding, 'utf-8');
    assert.equal(p.bom, false);
    assert.equal(p.delimiter, ',');
    assert.equal(p.decimal, '.');
    assert.equal(p.decimalAmbiguous, false);
    assert.equal(p.hasHeader, true);
    // 41 named columns; the trailing comma adds no name, the extra fields
    // become unnamed columns.
    assert.equal(p.rawHeaders.length, 42);
    assert.equal(p.rawHeaders[41], '');
    assert.equal(p.columnCount, 43);
    assert.equal(p.headers[0], 'Name');
    assert.equal(p.headers[40], 'Author');
    assert.equal(p.headers[41], 'Column 42');
    assert.equal(p.headers[42], 'Column 43');
    assert.ok(p.rows.every(r => r.cells.length === 43));
    assert.equal(p.rows[1].cells[41], 'extra-a');
    assert.deepEqual(p.rows[3].cells.slice(41), ['extra-b', 'extra-c']);
    assert.deepEqual(codes(p.notices), [CSV_NOTICES.EXTRA_FIELDS]);
    assert.equal(p.notices[0].count, 2);

    // Six records in eight physical lines: GCP_03's description has a line break.
    assert.equal(p.rows.length, 6);
    assert.deepEqual(p.rows.map(r => r.row), [2, 3, 4, 5, 6, 7]);
    assert.deepEqual(p.rows.map(r => r.line), [2, 3, 4, 6, 7, 8]);
    assert.equal(p.headerRow, 1);
    assert.equal(p.rows[0].cells[6], 'Wall corner, north side');
    assert.equal(p.rows[1].cells[6], 'Column base "B", east');
    assert.equal(p.rows[2].cells[6], 'Threshold\nwest end');
});

test('semicolon, CRLF and BOM with a quoted comma, doubled quotes, umlauts and typographic quotes', () => {
    const p = parseCsv(fixture('excel-semicolon.csv'));
    assert.deepEqual(p.errors, []);
    assert.equal(p.encoding, 'utf-8');
    assert.equal(p.bom, true);
    assert.equal(p.delimiter, ';');
    assert.equal(p.decimal, ',');
    assert.equal(p.hasHeader, true);
    assert.deepEqual(p.headers, ['Punkt', 'Rechtswert', 'Hochwert', 'Höhe', 'Beschreibung', 'Code']);
    assert.equal(p.rows[1].cells[4], 'Tür „Ost“, "alt"; Schwelle');
    assert.equal(p.rows[2].cells[4], 'Größe: 1,5 m');
    assert.equal(p.rows[3].cells[4], 'Öffnung ‚klein‘');
    // Excel's ;;;;; rows are skipped; row numbers keep counting them.
    assert.deepEqual(p.rows.map(r => r.row), [2, 3, 4, 6]);
    assert.equal(p.emptyRows, 1);
    assert.deepEqual(codes(p.notices), [CSV_NOTICES.EMPTY_ROWS]);
    assert.ok(p.rows.every(r => r.cells.every(c => !c.includes('\r'))));
});

test('decimal comma under a semicolon delimiter', () => {
    const p = parseCsv('Name;E;N;H\nA;512345,12;4123456,78;58,2\nB;512350,5;4123460,25;58,4\n');
    assert.equal(p.delimiter, ';');
    assert.equal(p.decimal, ',');
    assert.equal(p.decimalAmbiguous, false);
    assert.equal(parseNumber(p.rows[0].cells[1], p.decimal), 512345.12);
    assert.equal(parseNumber(p.rows[0].cells[3], p.decimal), 58.2);
    // A lone comma under a semicolon is a decimal comma, even with three digits after it.
    assert.equal(detectDecimal([['512,345']], ';').decimal, ',');
});

test('a quoted "512,345" in a comma file raises the ambiguity question', () => {
    const p = parseCsv('Name,E,N,H\nA,"512,345","412,345","58,123"\nB,"512,355","412,356","58,140"\n');
    assert.equal(p.delimiter, ',');
    assert.equal(p.decimal, '.');                 // the default until the user answers
    assert.equal(p.decimalAmbiguous, true);
    assert.equal(p.detected.decimalAmbiguous, true);
    assert.deepEqual(codes(p.warnings), [CSV_WARNINGS.DECIMAL_AMBIGUOUS]);
    assert.equal(p.warnings[0].example, '512,345');
    // Answering the question overrides the detection.
    const q = parseCsv('Name,E,N,H\nA,"512,345","412,345","58,123"\n', { decimal: ',' });
    assert.equal(q.decimal, ',');
    assert.equal(q.decimalAmbiguous, false);
    assert.deepEqual(q.warnings, []);
    // A comma that cannot group thousands is a decimal comma, not ambiguous.
    const r = parseCsv('Name,E,N,H\nA,"512345,12","4123456,78","58,2"\n');
    assert.equal(r.decimal, ',');
    assert.equal(r.decimalAmbiguous, false);
    // A leading zero never starts a thousands group.
    assert.equal(parseCsv('Name,E,N,H\nA,"500010,12","4100020,45","0,123"\n').decimal, ',');
    assert.equal(detectDecimal([['0,123']], ',').ambiguous, false);
    // With decimal points elsewhere in the file, the comma groups thousands.
    const s = parseCsv('Name,E,N,H\nA,"512,345",4123456.789,58.123\n');
    assert.equal(s.decimal, '.');
    assert.equal(s.decimalAmbiguous, false);
});

test('header-less PENZD file', () => {
    const p = parseCsv(fixture('penzd.csv'));
    assert.deepEqual(p.errors, []);
    assert.equal(p.hasHeader, false);
    assert.equal(p.rawHeaders, null);
    assert.equal(p.headerRow, null);
    assert.deepEqual(p.headers, ['Column 1', 'Column 2', 'Column 3', 'Column 4', 'Column 5']);
    assert.equal(p.rows.length, 4);
    assert.deepEqual(p.rows.map(r => r.row), [1, 2, 3, 4]);
    assert.deepEqual(p.rows[2].cells, ['3', '500018.540', '4100011.932', '50.877', '']);
    assert.deepEqual(codes(p.notices), [CSV_NOTICES.SHORT_ROWS]);
});

test(';;;; lines are skipped and do not disturb delimiter detection', () => {
    const text = 'Punkt;Rechtswert;Hochwert;Höhe\n;;;\nP1;500001,1;4100001,1;50,1\n;;;\n;;;\nP2;500002,2;4100002,2;50,2\n';
    const p = parseCsv(text);
    assert.equal(p.delimiter, ';');
    assert.deepEqual(p.rows.map(r => r.row), [3, 6]);
    assert.equal(p.emptyRows, 3);
    assert.equal(p.recordCount, 6);
});

test('tab-delimited file', () => {
    const p = parseCsv('Point\tEasting\tNorthing\tElevation\nT1\t500001.123\t4100001.456\t50.789\nT2\t500002.123\t4100002.456\t50.889\n');
    assert.equal(p.delimiter, '\t');
    assert.equal(p.hasHeader, true);
    assert.deepEqual(p.rows[1].cells, ['T2', '500002.123', '4100002.456', '50.889']);
});

test('pipe-delimited file, and a stray pipe in every line of a comma file', () => {
    const p = parseCsv('Point|Easting|Northing|Elevation\nP1|500001.123|4100001.456|50.789\nP2|500002.123|4100002.456|50.889\n');
    assert.equal(p.delimiter, '|');
    assert.deepEqual(p.rows[0].cells, ['P1', '500001.123', '4100001.456', '50.789']);
    // Two pipe fields cannot hold E, N and H; the five comma fields win.
    const c = parseCsv('Name,E,N,H,Desc|Code\nA,1.5,2.5,3.5,a|b\nB,1.5,2.5,3.5,c|d\n');
    assert.equal(c.delimiter, ',');
    assert.deepEqual(c.headers, ['Name', 'E', 'N', 'H', 'Desc|Code']);
});

test('a line break inside quotes stays in one field and one row', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
        const text = ['Name,E,N,H,Description', 'A,1,2,3,"first line' + eol + 'second line"', 'B,4,5,6,plain'].join(eol) + eol;
        const p = parseCsv(text);
        assert.equal(p.rows.length, 2, JSON.stringify(eol));
        assert.equal(p.rows[0].cells[4], 'first line' + eol + 'second line');
        assert.deepEqual(p.rows.map(r => r.row), [2, 3]);
        assert.deepEqual(p.rows.map(r => r.line), [2, 4]);
    }
});

test('an unterminated quote reports its line', () => {
    const text = 'Name,E,N,H,Description\nA,1,2,3,ok\nB,4,5,6,"never closed\nC,7,8,9,lost\n';
    const p = parseCsv(text);
    assert.deepEqual(codes(p.errors), [CSV_ERRORS.UNTERMINATED_QUOTE]);
    assert.equal(p.errors[0].line, 3);
    assert.equal(p.errors[0].row, 3);
    assert.match(p.errors[0].message, /line 3/);
    assert.equal(p.rows.length, 1);              // the rows before it stay visible in the preview
    // The line is where the quoted field starts, also after earlier line breaks in quotes.
    const t = tokenize('a,"x\ny"\nb,"open\nmore\n', ',');
    assert.equal(t.error.line, 3);
    assert.equal(t.records.length, 1);
});

test('a Windows-1252 file with "Höhe" decodes', () => {
    // "Punkt;Rechtswert;Hochwert;Höhe" with ö as the single byte 0xF6
    const bytes = new Uint8Array([...utf8('Punkt;Rechtswert;Hochwert;H'), 0xF6, ...utf8('he\r\nP1;1;2;3\r\n')]);
    const d = decode(bytes);
    assert.equal(d.encoding, 'windows-1252');
    assert.equal(d.notice.code, CSV_NOTICES.ENCODING_FALLBACK);
    const p = parseCsv(bytes);
    assert.equal(p.headers[3], 'Höhe');
    assert.equal(p.encoding, 'windows-1252');
    assert.deepEqual(codes(p.notices), [CSV_NOTICES.ENCODING_FALLBACK]);
});

// ---- Decoding ----

test('byte-order marks select UTF-8, UTF-16 LE and UTF-16 BE', () => {
    const text = 'Höhe;Doğu\n1;2\n';
    const le = new Uint8Array(2 + text.length * 2), be = new Uint8Array(2 + text.length * 2);
    le.set([0xFF, 0xFE]); be.set([0xFE, 0xFF]);
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        le[2 + 2 * i] = c & 0xFF; le[3 + 2 * i] = c >> 8;
        be[2 + 2 * i] = c >> 8; be[3 + 2 * i] = c & 0xFF;
    }
    assert.deepEqual(decode(le), { text, encoding: 'utf-16le', bom: true, notice: null, error: null });
    assert.deepEqual(decode(be), { text, encoding: 'utf-16be', bom: true, notice: null, error: null });
    assert.deepEqual(decode(new Uint8Array([0xEF, 0xBB, 0xBF, ...utf8(text)])), { text, encoding: 'utf-8', bom: true, notice: null, error: null });
    assert.deepEqual(decode(utf8(text).buffer), { text, encoding: 'utf-8', bom: false, notice: null, error: null });
    // UTF-16 LE without a byte-order mark is recognised by its zero bytes.
    const noBom = decode(le.subarray(2));
    assert.equal(noBom.encoding, 'utf-16le');
    assert.equal(noBom.text, text);
});

test('a non-UTF-8 file with Turkish letters is read as Windows-1254', () => {
    // "Nokta;Doğu;Kuzey;Yükseklik" in Windows-1254: ğ = 0xF0, ü = 0xFC
    const bytes = new Uint8Array([...utf8('Nokta;Do'), 0xF0, ...utf8('u;Kuzey;Y'), 0xFC, ...utf8('kseklik\n')]);
    const d = decode(bytes);
    assert.equal(d.encoding, 'windows-1254');
    assert.equal(d.text, 'Nokta;Doğu;Kuzey;Yükseklik\n');
    assert.equal(d.notice.encoding, 'windows-1254');
});

test('an explicit encoding wins over the detection', () => {
    const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...utf8('Höhe\n')]);
    const d = decode(bytes, { encoding: 'windows-1252' });
    assert.equal(d.encoding, 'windows-1252');
    assert.equal(d.text, 'ï»¿HÃ¶he\n');
    const p = parseCsv(bytes, { encoding: 'windows-1252' });
    assert.equal(p.encoding, 'windows-1252');
    assert.equal(p.detected.encoding, 'utf-8');
    assert.equal(decode(bytes, { encoding: 'utf-8' }).text, 'Höhe\n');
    assert.throws(() => decode(bytes, { encoding: 'no-such-encoding' }), RangeError);
});

test('binary files are refused', () => {
    const zip = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
    assert.equal(decode(zip).error.code, CSV_ERRORS.NOT_TEXT);
    const p = parseCsv(zip);
    assert.deepEqual(codes(p.errors), [CSV_ERRORS.NOT_TEXT]);
    assert.deepEqual(p.rows, []);
    assert.deepEqual(codes(parseCsv(new Uint8Array(0)).errors), [CSV_ERRORS.EMPTY_FILE]);
    // A few stray NUL bytes (padding) do not make a UTF-8 file binary.
    const padded = new Uint8Array([...utf8('Name,E,N,H\n1,500000.1,4100000.2,5.3\n'), 0, 0, 0, 0]);
    const d = decode(padded);
    assert.equal(d.error, null);
    assert.equal(d.encoding, 'utf-8');
    assert.equal(d.text, 'Name,E,N,H\n1,500000.1,4100000.2,5.3\n');
    assert.equal(parseCsv(padded).rows.length, 1);
});

// ---- Tokeniser ----

test('tokeniser follows RFC 4180 and keeps physical start lines', () => {
    const { records, error } = tokenize('a,"b,c","d""e"\r\n,,\r"f\r\ng",h\n', ',');
    assert.equal(error, null);
    assert.deepEqual(records, [
        { fields: ['a', 'b,c', 'd"e'], line: 1 },
        { fields: ['', '', ''], line: 2 },
        { fields: ['f\r\ng', 'h'], line: 3 }
    ]);
    // Spaces before an opening quote are ignored; quotes inside a field are literal.
    assert.deepEqual(tokenize('x, "y,z" ,5" pipe', ',').records[0].fields, ['x', 'y,z', '5" pipe']);
    assert.deepEqual(tokenize('a,b,', ',').records[0].fields, ['a', 'b', '']);
    assert.deepEqual(tokenize('', ',').records, []);
    assert.throws(() => tokenize('a b', ' '), RangeError);
});

test('10,000 rows parse in linear time', () => {
    const lines = ['Name,Easting,Northing,Elevation,Description'];
    for (let i = 0; i < 10000; i++) {
        lines.push(`P${i},${500000 + i * 0.123},${4100000 + i * 0.456},${50 + (i % 100) / 10},"Note ${i}, with ""quotes"" and a comma"`);
    }
    const bytes = utf8(lines.join('\r\n') + '\r\n');
    const t0 = performance.now();
    const p = parseCsv(bytes);
    const ms = performance.now() - t0;
    assert.equal(p.rows.length, 10000);
    assert.equal(p.rows[9999].row, 10001);
    assert.equal(p.rows[5].cells[4], 'Note 5, with "quotes" and a comma');
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
    // One row with a huge run of trailing delimiters stays linear too.
    const wide = lines.slice(0, 5001).join('\n') + '\nP,1,2,3,x' + ','.repeat(100000) + '\n';
    const t1 = performance.now();
    const w = parseCsv(wide);
    const ms1 = performance.now() - t1;
    assert.equal(w.columnCount, 5);
    assert.ok(ms1 < 1000, `took ${ms1.toFixed(0)} ms`);
});

// ---- Detection ----

test('a consistent semicolon beats a comma', () => {
    // Header-less with decimal commas: the comma splits every row into 4
    // fields, as consistently as the semicolon into 5.
    const text = '1;500001,123;4100001,456;50,123;Mauer\n2;500002,123;4100002,456;50,223;Tor\n3;500003,123;4100001,956;50,323;Ecke\n';
    const d = detectDelimiter(text);
    assert.equal(d.delimiter, ';');
    const comma = d.scores.find(s => s.delimiter === ',');
    assert.deepEqual([comma.mode, comma.consistency, comma.first], [4, 1, 4]);
    const p = parseCsv(text);
    assert.equal(p.decimal, ',');
    assert.deepEqual(p.rows[0].cells, ['1', '500001,123', '4100001,456', '50,123', 'Mauer']);
    // With a header that has no comma, the comma is not consistent at all.
    assert.equal(detectDelimiter('P;E;N;H\nA;500001,123;4100001,456;50,1\nB;500002,123;4100002,456;50,2\n').delimiter, ';');
    // A semicolon only inside some descriptions does not beat the comma.
    assert.equal(detectDelimiter('Name,E,N,H,Note\nA,1,2,3,x; y\nB,4,5,6,z\nC,7,8,9,w\n').delimiter, ',');
    // One column: comma by default, with a warning.
    const one = parseCsv('only\nnames\nhere\n');
    assert.equal(one.delimiter, ',');
    assert.ok(codes(one.warnings).includes(CSV_WARNINGS.SINGLE_COLUMN));
});

test('header detection by synonyms or by text over numbers', () => {
    const rows = [['Point', 'Value A', 'Value B'], ['P1', '1.5', '2.5'], ['P2', '3.5', '4.5']];
    assert.equal(detectHeader(rows), true);                                  // text over numbers
    assert.equal(detectHeader([['P1', 'x', 'y'], ['P2', 'u', 'v']]), false);
    assert.equal(detectHeader([['1', '500.1', '400.2'], ['2', '501.1', '401.2']]), false);
    const known = (name) => ['punkt', 'hohe'].includes(name.toLowerCase().replace('ö', 'o'));
    assert.equal(detectHeader([['Punkt', 'Höhe']], known), true);              // synonyms, no data rows needed
    assert.equal(detectHeader([['Punkt', 'Info']]), false);
    // A data row whose text cells happen to be synonyms is still data.
    const known2 = (name) => ['p', 'east'].includes(name.toLowerCase());
    assert.equal(detectHeader([['P', '500010.1', '4100020.4', '51.2', 'East']], known2), false);
    // The override wins.
    const p = parseCsv('Point,Value A,Value B\nP1,1.5,2.5\n', { hasHeader: false });
    assert.equal(p.hasHeader, false);
    assert.equal(p.detected.hasHeader, true);
    assert.equal(p.rows.length, 2);
    assert.deepEqual(p.rows.map(r => r.row), [1, 2]);
});

test('column names are unique and trailing empty columns are dropped', () => {
    const p = parseCsv('Name,Height,Height,,\nA,1,2,,\nB,3,4,,\n');
    assert.deepEqual(p.headers, ['Name', 'Height', 'Height (2)']);
    assert.equal(p.columnCount, 3);
    assert.deepEqual(p.rows[0].cells, ['A', '1', '2']);
    // A blank name in the middle becomes "Column N".
    assert.deepEqual(parseCsv('Name,,H\nA,1,2\n').headers, ['Name', 'Column 2', 'H']);
});

// ---- Numbers ----

test('parseNumber strips separators and reads both decimal conventions', () => {
    assert.equal(parseNumber('512345.123'), 512345.123);
    assert.equal(parseNumber('512345,123', ','), 512345.123);
    assert.equal(parseNumber(' 512 345.12 '), 512345.12);
    assert.equal(parseNumber('512 345,12', ','), 512345.12);       // NBSP
    assert.equal(parseNumber('512 345,12', ','), 512345.12);       // narrow NBSP
    assert.equal(parseNumber("512'345.12"), 512345.12);
    assert.equal(parseNumber('512’345.12'), 512345.12);
    assert.equal(parseNumber('+58.2'), 58.2);
    assert.equal(parseNumber('-58.2'), -58.2);
    assert.equal(parseNumber('−58,2', ','), -58.2);                // U+2212 minus
    assert.equal(parseNumber('1,234.5'), 1234.5);                      // both: the last one is decimal
    assert.equal(parseNumber('1.234,5', '.'), 1234.5);
    assert.equal(parseNumber('1.234.567,89', ','), 1234567.89);
    assert.equal(parseNumber('1,234', '.'), 1234);                      // groups of three: thousands
    assert.equal(parseNumber('1,234', ','), 1.234);
    assert.equal(parseNumber('58,2', '.'), 58.2);                       // cannot be a thousands group
    assert.equal(parseNumber('0,123', '.'), 0.123);
    assert.equal(parseNumber('512345.123', ','), 512345.123);
    assert.equal(parseNumber('.5'), 0.5);
    assert.equal(parseNumber('5.12E+05'), 512000);
    assert.equal(parseNumber('42'), 42);
    for (const bad of ['', '   ', '-', '.', 'abc', '12a', '1-2', '1.2.3', '12,34.5', null, undefined]) {
        assert.ok(Number.isNaN(parseNumber(bad)), JSON.stringify(bad));
    }
});

test('decimalPlaces counts the written decimals', () => {
    assert.equal(decimalPlaces('512345.100'), 3);
    assert.equal(decimalPlaces('512345,1', ','), 1);
    assert.equal(decimalPlaces('512345'), 0);
    assert.equal(decimalPlaces('5.12E+05'), 0);
    assert.equal(decimalPlaces('x'), null);
});
