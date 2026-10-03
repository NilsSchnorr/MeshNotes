// js/survey/csv-parse.js - Survey CSV decoding, tokenising and format detection
// Pure: no Three.js, state or DOM imports (TextDecoder only), so it loads in Node tests.
//
// parseCsv() is the entry point. The UI calls parseSurveyCsv() from
// column-mapping.js, which passes that module's header synonyms in as
// headerTest (column-mapping imports this module, not the other way round).
//
// Row numbers
// - row: the spreadsheet row number of a record, i.e. its 1-based position in
//   the file counting the header and empty rows. A quoted field with line
//   breaks stays one row, so the number matches what a spreadsheet shows. The
//   header is row 1 and the first data row is row 2; in a file without a
//   header the first record is row 1. Every place that names a CSV row uses
//   it (survey.source.row, the skipped-row list, "file row N" names).
// - line: the physical line where the record starts, for error messages.
//
// Problems come back as { code, message, ...details } in errors (blocking),
// warnings (the UI should ask or point it out) and notices (information).
// The codes are stable; the messages are English UI text. Bad arguments throw.

// ============ Options ============

export const DELIMITERS = Object.freeze([
    Object.freeze({ id: ',', label: 'Comma' }),
    Object.freeze({ id: ';', label: 'Semicolon' }),
    Object.freeze({ id: '\t', label: 'Tab' }),
    Object.freeze({ id: '|', label: 'Pipe' })
]);

export const DECIMALS = Object.freeze([
    Object.freeze({ id: '.', label: 'Point (1.5)' }),
    Object.freeze({ id: ',', label: 'Comma (1,5)' })
]);

// Encodings offered in the override dropdown. decode() accepts any label
// TextDecoder knows; these are the canonical names it returns.
export const ENCODINGS = Object.freeze([
    Object.freeze({ id: 'utf-8', label: 'UTF-8' }),
    Object.freeze({ id: 'windows-1252', label: 'Windows-1252 (Western European)' }),
    Object.freeze({ id: 'windows-1254', label: 'Windows-1254 (Turkish)' }),
    Object.freeze({ id: 'utf-16le', label: 'UTF-16 LE' }),
    Object.freeze({ id: 'utf-16be', label: 'UTF-16 BE' })
]);

export const DELIMITER_SAMPLE = 30;   // non-empty records read for delimiter detection
export const HEADER_SAMPLE = 20;      // records after the first compared for header detection
const CONSISTENT_SHARE = 0.9;         // share of sampled records with the most common field count
const MIN_SURVEY_COLUMNS = 3;         // E, N and H at least

// A consistent candidate wins in this order. Comma comes last because commas
// also appear as decimal separators and in free text.
const DELIMITER_PRIORITY = ['\t', ';', '|', ','];

// ============ Codes ============

export const CSV_ERRORS = Object.freeze({
    NOT_TEXT: 'NOT_TEXT',                     // binary file, e.g. an .xlsx
    EMPTY_FILE: 'EMPTY_FILE',
    UNTERMINATED_QUOTE: 'UNTERMINATED_QUOTE', // line: where the quoted field starts
    NO_DATA_ROWS: 'NO_DATA_ROWS'
});

export const CSV_WARNINGS = Object.freeze({
    DECIMAL_AMBIGUOUS: 'DECIMAL_AMBIGUOUS',   // e.g. "512,345" in a comma file: ask, default point
    SINGLE_COLUMN: 'SINGLE_COLUMN'            // only one column: the delimiter is probably wrong
});

export const CSV_NOTICES = Object.freeze({
    ENCODING_FALLBACK: 'ENCODING_FALLBACK',   // not UTF-8, read as Windows-1252/1254 (or UTF-16 without BOM)
    EXTRA_FIELDS: 'EXTRA_FIELDS',             // rows longer than the header: unnamed columns added
    SHORT_ROWS: 'SHORT_ROWS',                 // rows shorter than the header: padded with ''
    EMPTY_ROWS: 'EMPTY_ROWS'                  // empty rows (incl. Excel's ;;;; lines) skipped
});

function issue(code, message, details = {}) {
    return { code, message, ...details };
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ============ Decoding ============

function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('csv-parse: expected an ArrayBuffer, a typed array or a string');
}

function bomOf(b) {
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { encoding: 'utf-8', length: 3 };
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return { encoding: 'utf-16le', length: 2 };
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return { encoding: 'utf-16be', length: 2 };
    return null;
}

// NUL bytes mean UTF-16 without a byte-order mark (zeros at every other
// byte), or not a text file at all. A few stray NULs (padding in some device
// exports) are ignored: 'stray', and decode() drops them.
function sniffNul(b) {
    const n = Math.min(b.length, 4096);
    let even = 0, odd = 0;
    for (let i = 0; i < n; i++) {
        if (b[i] === 0) { if (i & 1) odd++; else even++; }
    }
    if (even + odd === 0) return null;
    const half = n / 2;
    if (odd >= 0.3 * half && even <= 0.02 * half) return 'utf-16le';
    if (even >= 0.3 * half && odd <= 0.02 * half) return 'utf-16be';
    if (even + odd <= Math.max(4, 0.01 * n)) return 'stray';
    return 'binary';
}

function dropNul(text) {
    return text.includes('\0') ? text.replace(/\0/g, '') : text;
}

// Windows-1254 (Turkish) differs from Windows-1252 only in a few letters.
// These bytes are Ğ İ Ş ğ ı ş there and rare Icelandic or Czech letters in
// Windows-1252. German umlauts are the same in both.
const TURKISH_BYTES = new Set([0xD0, 0xDD, 0xDE, 0xF0, 0xFD, 0xFE]);

function encodingLabel(enc) {
    const known = ENCODINGS.find(e => e.id === enc);
    return known ? known.label : enc;
}

/**
 * Decodes file bytes to text.
 * Order: an explicit encoding wins; then a byte-order mark (UTF-8, UTF-16
 * LE/BE); then strict UTF-8; otherwise Windows-1252 with a notice
 * (Windows-1254 when Turkish-only letters occur).
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{encoding?: string|null}} [options] - override, any TextDecoder label
 * @returns {{text: string, encoding: string|null, bom: boolean,
 *            notice: object|null, error: object|null}}
 *   error is a CSV_ERRORS.NOT_TEXT issue for binary files (text is then '').
 */
export function decode(input, { encoding = null } = {}) {
    const bytes = toBytes(input);
    const bom = bomOf(bytes);

    if (!isAuto(encoding)) {
        const enc = new TextDecoder(String(encoding)).encoding;   // throws RangeError for unknown labels
        const skip = bom && bom.encoding === enc ? bom.length : 0;
        return { text: new TextDecoder(enc).decode(bytes.subarray(skip)), encoding: enc, bom: skip > 0, notice: null, error: null };
    }
    if (bom) {
        return { text: new TextDecoder(bom.encoding).decode(bytes.subarray(bom.length)), encoding: bom.encoding, bom: true, notice: null, error: null };
    }

    const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
    const nul = sniffNul(bytes);
    if (zip || nul === 'binary') {
        return {
            text: '', encoding: null, bom: false, notice: null,
            error: issue(CSV_ERRORS.NOT_TEXT, 'This is not a text CSV file. Save the spreadsheet as CSV (comma- or semicolon-separated) and import that file.')
        };
    }
    if (nul && nul !== 'stray') {
        return {
            text: new TextDecoder(nul).decode(bytes), encoding: nul, bom: false, error: null,
            notice: issue(CSV_NOTICES.ENCODING_FALLBACK, `The file has no byte-order mark and was read as ${encodingLabel(nul)}. If letters look wrong, choose another encoding.`, { encoding: nul })
        };
    }

    try {
        return { text: dropNul(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8', bom: false, notice: null, error: null };
    } catch (e) {
        let enc = 'windows-1252';
        for (let i = 0; i < bytes.length; i++) {
            if (TURKISH_BYTES.has(bytes[i])) { enc = 'windows-1254'; break; }
        }
        return {
            text: dropNul(new TextDecoder(enc).decode(bytes)), encoding: enc, bom: false, error: null,
            notice: issue(CSV_NOTICES.ENCODING_FALLBACK, `The file is not UTF-8 and was read as ${encodingLabel(enc)}. If letters look wrong, choose another encoding.`, { encoding: enc })
        };
    }
}

// ============ Tokenising ============

const QUOTE = 34, LF = 10, CR = 13, SPACE = 32, TAB = 9;

function checkDelimiter(delimiter) {
    if (!DELIMITERS.some(d => d.id === delimiter)) {
        throw new RangeError(`csv-parse: unsupported delimiter ${JSON.stringify(delimiter)}`);
    }
    return delimiter;
}

function checkDecimal(decimal) {
    if (decimal !== '.' && decimal !== ',') throw new RangeError(`csv-parse: unsupported decimal separator ${JSON.stringify(decimal)}`);
    return decimal;
}

// Line breaks (CRLF, LF or CR, each counted once) in text[from, to).
function countBreaks(text, from, to) {
    let n = 0;
    for (let i = from; i < to; i++) {
        const c = text.charCodeAt(i);
        if (c === LF) n++;
        else if (c === CR) {
            n++;
            if (i + 1 < to && text.charCodeAt(i + 1) === LF) i++;
        }
    }
    return n;
}

export function isBlankRecord(fields) {
    for (const f of fields) if (f.trim() !== '') return false;
    return true;
}

/**
 * Splits text into records per RFC 4180, in one linear pass.
 * - A quote opens a quoted field only at the start of a field (spaces before
 *   it are ignored). Inside, a doubled quote is a quote, and delimiters and
 *   line breaks are literal. Text after the closing quote is kept unless it
 *   is only spaces. Quotes inside an unquoted field are literal.
 * - Records end at CRLF, LF or CR. A final line break adds no record.
 * - Empty records are returned too (the caller skips them), so the record
 *   index stays the spreadsheet row number.
 * @param {string} text
 * @param {string} delimiter - one of DELIMITERS
 * @param {{maxRecords?: number}} [options] - stop after this many non-empty records
 * @returns {{records: Array<{fields: string[], line: number}>, error: object|null}}
 *   line is the physical line where the record starts. On an unterminated
 *   quote, records holds the records before it and error is
 *   { code: UNTERMINATED_QUOTE, line, row }.
 */
export function tokenize(text, delimiter, { maxRecords = Infinity } = {}) {
    checkDelimiter(delimiter);
    const d = delimiter.charCodeAt(0);
    const len = text.length;
    const records = [];
    if (len === 0) return { records, error: null };

    let fields = [];
    let line = 1, recordLine = 1;
    let nonEmpty = 0;
    let i = 0;
    while (true) {
        let value;
        let j = i;
        while (j < len) {
            const c = text.charCodeAt(j);
            if (c === SPACE || (c === TAB && d !== TAB)) j++;
            else break;
        }
        if (j < len && text.charCodeAt(j) === QUOTE) {
            // Quoted field: jump from quote to quote.
            const startLine = line;
            let k = j + 1;
            value = '';
            while (true) {
                const q = text.indexOf('"', k);
                if (q === -1) {
                    const row = records.length + 1;
                    return {
                        records,
                        error: issue(CSV_ERRORS.UNTERMINATED_QUOTE, `A quoted field that starts on line ${startLine} is never closed. Check the quotation marks in that line.`, { line: startLine, row })
                    };
                }
                line += countBreaks(text, k, q);
                value += text.slice(k, q);
                if (text.charCodeAt(q + 1) === QUOTE) {
                    value += '"';
                    k = q + 2;
                } else {
                    k = q + 1;
                    break;
                }
            }
            let m = k;
            while (m < len) {
                const c = text.charCodeAt(m);
                if (c === d || c === LF || c === CR) break;
                m++;
            }
            if (m > k) {
                const tail = text.slice(k, m);
                if (tail.trim() !== '') value += tail;
            }
            i = m;
        } else {
            let m = i;
            while (m < len) {
                const c = text.charCodeAt(m);
                if (c === d || c === LF || c === CR) break;
                m++;
            }
            value = text.slice(i, m);
            i = m;
        }
        fields.push(value);

        if (i < len && text.charCodeAt(i) === d) { i++; continue; }

        // End of the record: a line break or the end of the text.
        records.push({ fields, line: recordLine });
        if (!isBlankRecord(fields)) nonEmpty++;
        fields = [];
        if (i >= len) break;
        i += (text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF) ? 2 : 1;
        line++;
        recordLine = line;
        if (i >= len || nonEmpty >= maxRecords) break;
    }
    return { records, error: null };
}

// ============ Delimiter detection ============

/**
 * Detects the delimiter from the first DELIMITER_SAMPLE non-empty records.
 * For each candidate: the most common field count (mode) and the share of
 * records that have it (consistency). A candidate is consistent when the
 * mode is at least 2, at least CONSISTENT_SHARE of the records have it and
 * the first record splits too; consistent candidates win in the order tab,
 * semicolon, pipe, comma, so a consistent semicolon beats a comma (decimal
 * commas). One with at least MIN_SURVEY_COLUMNS fields (name or E, N, H) goes
 * first, so a stray pipe in every line of a comma file does not win.
 * Otherwise the most consistent candidate with a mode of 2 or more wins, and
 * with none the delimiter is a comma.
 * @param {string} text
 * @returns {{delimiter: string, scores: Array<{delimiter, mode, consistency, first}>}}
 */
export function detectDelimiter(text) {
    const scores = DELIMITERS.map(({ id }) => {
        const { records } = tokenize(text, id, { maxRecords: DELIMITER_SAMPLE });
        const counts = records.filter(r => !isBlankRecord(r.fields)).map(r => r.fields.length);
        const tally = new Map();
        for (const c of counts) tally.set(c, (tally.get(c) || 0) + 1);
        let mode = 0, freq = 0;
        for (const [c, f] of tally) {
            if (f > freq || (f === freq && c > mode)) { mode = c; freq = f; }
        }
        return { delimiter: id, mode, consistency: counts.length ? freq / counts.length : 0, first: counts.length ? counts[0] : 0 };
    });
    const rank = (s) => DELIMITER_PRIORITY.indexOf(s.delimiter);
    const viable = scores.filter(s => s.mode >= 2);
    if (!viable.length) return { delimiter: ',', scores };
    const consistent = viable.filter(s => s.consistency >= CONSISTENT_SHARE && s.first >= 2);
    if (consistent.length) {
        const wide = (s) => (s.mode >= MIN_SURVEY_COLUMNS ? 0 : 1);
        consistent.sort((a, b) => (wide(a) - wide(b)) || (rank(a) - rank(b)));
        return { delimiter: consistent[0].delimiter, scores };
    }
    viable.sort((a, b) => (b.consistency - a.consistency) || (b.mode - a.mode) || (rank(a) - rank(b)));
    return { delimiter: viable[0].delimiter, scores };
}

// ============ Numbers ============

// Spaces (incl. NBSP U+00A0 and narrow NBSP U+202F, both matched by \s) and
// apostrophes (' and U+2019) are thousands separators and are dropped.
const NUMBER_STRIP = /[\s'’]/g;
// Digits with point/comma separators, an optional sign (+, -, U+2212 minus)
// and exponent. The lookahead keeps the match linear.
const NUMBERISH = /^[+\-−]?(?=[.,]*\d)[\d.,]+(?:[eE][+\-]?\d+)?$/;
// Thousands groups: "1,234", "12.345.678" (a leading 0 never starts a group, so "0,123" is a decimal).
const GROUPED = { '.': /^[1-9]\d{0,2}(?:\.\d{3})+$/, ',': /^[1-9]\d{0,2}(?:,\d{3})+$/ };
const DIGITS = /^\d*$/;

function countChar(s, ch) {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
    return n;
}

// Parses one number string. Returns { value, decimals } or null.
// decimals = digits after the decimal separator in plain notation.
function analyseNumber(str, decimal) {
    if (typeof str === 'number') return Number.isFinite(str) ? { value: str, decimals: null } : null;
    if (str === null || str === undefined) return null;
    let s = String(str).replace(NUMBER_STRIP, '');
    if (!NUMBERISH.test(s)) return null;

    let sign = 1;
    const c0 = s.charCodeAt(0);
    if (c0 === 43) s = s.slice(1);                               // +
    else if (c0 === 45 || c0 === 0x2212) { sign = -1; s = s.slice(1); }

    let exp = 0;
    const ei = s.search(/[eE]/);
    if (ei >= 0) { exp = parseInt(s.slice(ei + 1), 10); s = s.slice(0, ei); }

    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    let dec = null, group = null;
    if (lastDot >= 0 && lastComma >= 0) {
        // Both: the last one is the decimal separator.
        dec = lastDot > lastComma ? '.' : ',';
        group = dec === '.' ? ',' : '.';
    } else if (lastDot >= 0 || lastComma >= 0) {
        const c = lastDot >= 0 ? '.' : ',';
        const n = countChar(s, c);
        const grouped = GROUPED[c].test(s);
        if (c === decimal) {
            if (n === 1) dec = c;
            else if (grouped) group = c;
            else return null;
        } else if (grouped) {
            group = c;                       // "1,234" with a decimal point
        } else if (n === 1) {
            dec = c;                         // "58,2" cannot be a thousands group
        } else {
            return null;
        }
    }

    let intPart = s, frac = '';
    if (dec) {
        if (countChar(s, dec) !== 1) return null;
        const di = s.indexOf(dec);
        intPart = s.slice(0, di);
        frac = s.slice(di + 1);
    }
    if (group && intPart.includes(group)) {
        if (!GROUPED[group].test(intPart)) return null;
        intPart = intPart.split(group).join('');
    }
    if (!DIGITS.test(intPart) || !DIGITS.test(frac) || (intPart === '' && frac === '')) return null;
    const value = sign * Number(`${intPart || '0'}.${frac || '0'}e${exp}`);
    if (!Number.isFinite(value)) return null;
    return { value, decimals: Math.max(0, frac.length - exp) };
}

/**
 * Parses a number from a CSV cell.
 * Spaces, NBSP, narrow NBSP and apostrophes are stripped; + and - (also
 * U+2212) are accepted. When both '.' and ',' appear the last one is the
 * decimal separator. With one kind only, `decimal` decides; the other
 * character is read as a thousands separator when it groups digits in
 * threes ("1,234") and as the decimal separator when it cannot ("58,2").
 * @param {string} str
 * @param {'.'|','} [decimal='.']
 * @returns {number} NaN for blank or non-numeric input (never 0)
 */
export function parseNumber(str, decimal = '.') {
    const r = analyseNumber(str, decimal);
    return r ? r.value : NaN;
}

/**
 * Digits after the decimal separator as written ("512345.10" -> 2,
 * "5.1E+05" -> 0), or null when the cell is not a number. Used for the
 * rounding warning.
 */
export function decimalPlaces(str, decimal = '.') {
    const r = analyseNumber(str, decimal);
    return r ? r.decimals : null;
}

// Loose test: looks like a number in either decimal convention.
export function isNumberLike(str) {
    if (typeof str !== 'string') return typeof str === 'number' && Number.isFinite(str);
    return NUMBERISH.test(str.replace(NUMBER_STRIP, ''));
}

/**
 * Detects the decimal separator from the numeric columns of the data rows
 * (columns where at least half the filled cells look like numbers).
 * - A cell with both '.' and ',' votes for the last one.
 * - A lone comma votes for a decimal comma under a semicolon, tab or pipe
 *   delimiter. Under a comma delimiter (a quoted cell) it votes too unless it
 *   could be a thousands separator ("512,345"): such cells are unclear.
 * - A lone point votes for a decimal point unless it could be a thousands
 *   separator ("1.234"). Repeated separators that group digits in threes
 *   vote for the other character.
 * @param {Array<string[]|{cells: string[]}>} rows
 * @param {string} [delimiter=',']
 * @returns {{decimal: '.'|',', ambiguous: boolean, example: string|null,
 *            votes: {point: number, comma: number, unclear: number}}}
 *   ambiguous: the UI should ask; decimal is then '.' (the default) or the
 *   majority. example is a cell that made it ambiguous.
 */
export function detectDecimal(rows, delimiter = ',') {
    const cellsOf = (r) => (Array.isArray(r) ? r : r.cells);
    let columns = 0;
    for (const r of rows) columns = Math.max(columns, cellsOf(r).length);
    const filled = new Array(columns).fill(0), numeric = new Array(columns).fill(0);
    for (const r of rows) {
        const cells = cellsOf(r);
        for (let j = 0; j < cells.length; j++) {
            if (cells[j].trim() === '') continue;
            filled[j]++;
            if (isNumberLike(cells[j])) numeric[j]++;
        }
    }

    let point = 0, comma = 0, unclear = 0;
    let example = null, mixedExample = null;
    for (const r of rows) {
        const cells = cellsOf(r);
        for (let j = 0; j < cells.length; j++) {
            if (numeric[j] * 2 < filled[j] || !numeric[j]) continue;
            let s = cells[j].replace(NUMBER_STRIP, '');
            if (!NUMBERISH.test(s)) continue;
            s = s.replace(/^[+\-−]/, '').replace(/[eE].*$/, '');
            const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
            if (lastDot >= 0 && lastComma >= 0) {
                if (lastDot > lastComma) point++; else comma++;
                if (!mixedExample) mixedExample = cells[j].trim();
            } else if (lastComma >= 0) {
                if (countChar(s, ',') === 1) {
                    if (delimiter !== ',') comma++;
                    else if (GROUPED[','].test(s)) { unclear++; if (!example) example = cells[j].trim(); }
                    else comma++;
                } else if (GROUPED[','].test(s)) {
                    point++;
                }
            } else if (lastDot >= 0) {
                if (countChar(s, '.') === 1) {
                    if (!GROUPED['.'].test(s)) point++;
                } else if (GROUPED['.'].test(s)) {
                    comma++;
                }
            }
        }
    }
    const votes = { point, comma, unclear };
    if (comma > 0 && point === 0) return { decimal: ',', ambiguous: false, example: null, votes };
    if (point > 0 && comma === 0) return { decimal: '.', ambiguous: false, example: null, votes };
    if (point > 0 && comma > 0) return { decimal: comma > point ? ',' : '.', ambiguous: true, example: mixedExample, votes };
    return { decimal: '.', ambiguous: unclear > 0, example: unclear > 0 ? example : null, votes };
}

// ============ Header detection ============

/**
 * Decides whether the first non-empty record is a header.
 * - A cell that looks like a number: not a header.
 * - A cell recognised by headerTest, or a text cell in a column whose later
 *   values are mostly numbers: a header.
 * @param {string[][]} records - the non-empty records, in file order
 * @param {(name: string) => boolean} [headerTest] - e.g. column-mapping's isKnownHeader
 * @returns {boolean}
 */
export function detectHeader(records, headerTest = null) {
    if (!records.length) return false;
    const first = records[0].map(f => f.trim());
    if (first.some(f => f && isNumberLike(f))) return false;
    if (headerTest && first.some(f => f && headerTest(f))) return true;
    const sample = records.slice(1, 1 + HEADER_SAMPLE);
    for (let j = 0; j < first.length; j++) {
        if (!first[j]) continue;
        let filled = 0, numbers = 0;
        for (const r of sample) {
            const v = (r[j] || '').trim();
            if (!v) continue;
            filled++;
            if (isNumberLike(v)) numbers++;
        }
        if (numbers > 0 && numbers * 2 >= filled) return true;
    }
    return false;
}

// One unique, non-empty name per column: the header cell (whitespace
// collapsed), or "Column N" for a blank or missing one; repeats get " (2)".
function columnNames(rawHeaders, columnCount) {
    const used = new Set();
    const names = [];
    for (let j = 0; j < columnCount; j++) {
        const base = ((rawHeaders && rawHeaders[j]) || '').replace(/\s+/g, ' ').trim() || `Column ${j + 1}`;
        let name = base;
        for (let k = 2; used.has(name); k++) name = `${base} (${k})`;
        used.add(name);
        names.push(name);
    }
    return names;
}

// ============ Entry point ============

function isAuto(v) {
    return v === null || v === undefined || v === '' || v === 'auto';
}

/**
 * Parses a survey CSV for the mapping dialog.
 * Each setting is detected unless the option overrides it ('auto', null or
 * undefined mean detect). detected holds what detection chose, given the
 * overrides before it (encoding, then delimiter, then header and decimal).
 * @param {ArrayBuffer|Uint8Array|string} input - file bytes (preferred, for the
 *   encoding check) or already decoded text
 * @param {{encoding?, delimiter?, decimal?, hasHeader?: boolean|null,
 *          headerTest?: (name: string) => boolean}} [options]
 * @returns {{
 *   encoding: string|null, bom: boolean, delimiter: string, decimal: '.'|',',
 *   decimalAmbiguous: boolean, hasHeader: boolean,
 *   detected: {encoding, delimiter, decimal, decimalAmbiguous, hasHeader},
 *   headers: string[],          // one unique non-empty name per column
 *   rawHeaders: string[]|null,  // the header record, trimmed; null without header
 *   headerRow: number|null, headerLine: number|null,
 *   columnCount: number,
 *   rows: Array<{row: number, line: number, cells: string[]}>,  // data rows, cells padded to columnCount
 *   recordCount: number,        // records in the file, incl. header and empty ones
 *   emptyRows: number,          // empty records skipped before the last data row
 *   errors: object[], warnings: object[], notices: object[]
 * }}
 */
export function parseCsv(input, options = {}) {
    const { encoding = null, delimiter = null, decimal = null, hasHeader = null, headerTest = null } = options;
    const errors = [], warnings = [], notices = [];
    const result = {
        encoding: null, bom: false, delimiter: ',', decimal: '.', decimalAmbiguous: false, hasHeader: false,
        detected: { encoding: null, delimiter: ',', decimal: '.', decimalAmbiguous: false, hasHeader: false },
        headers: [], rawHeaders: null, headerRow: null, headerLine: null, columnCount: 0,
        rows: [], recordCount: 0, emptyRows: 0, errors, warnings, notices
    };

    let text;
    if (typeof input === 'string') {
        text = input;
        if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); result.bom = true; }
    } else {
        const auto = decode(input);
        const used = isAuto(encoding) ? auto : decode(input, { encoding });
        result.detected.encoding = auto.encoding;
        result.encoding = used.encoding;
        result.bom = used.bom;
        if (used.error) { errors.push(used.error); return result; }
        if (used.notice) notices.push(used.notice);
        text = used.text;
    }
    if (text.trim() === '') {
        errors.push(issue(CSV_ERRORS.EMPTY_FILE, 'The file is empty.'));
        return result;
    }

    // Delimiter and records
    const detectedDelimiter = detectDelimiter(text).delimiter;
    const delim = isAuto(delimiter) ? detectedDelimiter : checkDelimiter(delimiter);
    result.detected.delimiter = detectedDelimiter;
    result.delimiter = delim;
    const tok = tokenize(text, delim);
    if (tok.error) errors.push(tok.error);
    const records = tok.records;
    result.recordCount = records.length;
    const nonEmpty = [];
    records.forEach((r, idx) => {
        if (!isBlankRecord(r.fields)) nonEmpty.push({ row: idx + 1, line: r.line, fields: r.fields });
    });
    if (nonEmpty.length) result.emptyRows = nonEmpty[nonEmpty.length - 1].row - nonEmpty.length;

    // Header
    const detectedHeader = detectHeader(nonEmpty.map(r => r.fields), headerTest);
    const useHeader = isAuto(hasHeader) ? detectedHeader : !!hasHeader;
    result.detected.hasHeader = detectedHeader;
    result.hasHeader = useHeader;
    const headerRec = useHeader && nonEmpty.length ? nonEmpty[0] : null;
    const dataRecs = headerRec ? nonEmpty.slice(1) : nonEmpty;
    const rawHeaders = headerRec ? headerRec.fields.map(f => f.trim()) : null;
    let headerWidth = rawHeaders ? rawHeaders.length : 0;
    while (headerWidth > 0 && !rawHeaders[headerWidth - 1]) headerWidth--;   // trailing comma

    // Columns: the longest row decides; trailing columns with no name and
    // no value anywhere are dropped.
    // One pass from the end of each row, so it stays linear.
    let columnCount = headerWidth;
    for (const r of dataRecs) {
        let last = r.fields.length;
        while (last > columnCount && r.fields[last - 1].trim() === '') last--;
        columnCount = Math.max(columnCount, last);
    }

    let extra = 0, short = 0;
    const expected = rawHeaders ? headerWidth : columnCount;
    const rows = dataRecs.map(r => {
        const f = r.fields;
        if (rawHeaders && f.length > headerWidth && !isBlankRecord(f.slice(headerWidth))) extra++;
        if (f.length < expected) short++;
        let cells = f;
        if (f.length > columnCount) cells = f.slice(0, columnCount);
        else if (f.length < columnCount) cells = f.concat(new Array(columnCount - f.length).fill(''));
        return { row: r.row, line: r.line, cells };
    });

    result.rawHeaders = rawHeaders;
    result.headerRow = headerRec ? headerRec.row : null;
    result.headerLine = headerRec ? headerRec.line : null;
    result.columnCount = columnCount;
    result.headers = columnNames(rawHeaders, columnCount);
    result.rows = rows;

    // Decimal separator
    const dec = detectDecimal(rows, delim);
    result.detected.decimal = dec.decimal;
    result.detected.decimalAmbiguous = dec.ambiguous;
    result.decimal = isAuto(decimal) ? dec.decimal : checkDecimal(decimal);
    result.decimalAmbiguous = isAuto(decimal) && dec.ambiguous;
    if (result.decimalAmbiguous) {
        const ex = dec.example ? `"${dec.example}"` : 'Some numbers';
        warnings.push(issue(CSV_WARNINGS.DECIMAL_AMBIGUOUS, `${ex} can be read with a decimal point or a decimal comma. Check the decimal separator.`, { example: dec.example }));
    }

    if (columnCount === 1 && rows.length) {
        warnings.push(issue(CSV_WARNINGS.SINGLE_COLUMN, 'Only one column was found. Choose the delimiter by hand.'));
    }
    if (extra) {
        notices.push(issue(CSV_NOTICES.EXTRA_FIELDS, `${plural(extra, 'row')} ${extra === 1 ? 'has' : 'have'} more fields than the header. The extra fields are shown as unnamed columns.`, { count: extra }));
    }
    if (short) {
        notices.push(issue(CSV_NOTICES.SHORT_ROWS, `${plural(short, 'row')} ${short === 1 ? 'has' : 'have'} fewer fields than ${rawHeaders ? 'the header' : 'the longest row'}. The missing fields are left empty.`, { count: short }));
    }
    if (result.emptyRows) {
        notices.push(issue(CSV_NOTICES.EMPTY_ROWS, `${plural(result.emptyRows, 'empty row')} ${result.emptyRows === 1 ? 'was' : 'were'} skipped.`, { count: result.emptyRows }));
    }
    if (!rows.length && !tok.error) {
        errors.push(issue(CSV_ERRORS.NO_DATA_ROWS, 'The file has no data rows.'));
    }
    return result;
}
