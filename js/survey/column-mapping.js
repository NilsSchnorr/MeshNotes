// js/survey/column-mapping.js - Survey CSV column mapping: synonyms, presets, checks, records
// Pure: imports only csv-parse.js and rigid-fit.js (for MIN_CONTROL_POINTS), so it
// loads in Node tests. Storage of remembered mappings lives elsewhere.
//
// A mapping is { name, easting, northing, height, description, code, extras }:
// column indices (or null) into the parsed headers, and extras the columns
// kept as attributes. Rows are parseCsv() rows ({ row, line, cells }) or
// plain arrays of cells.
//
// Header matching works on normalised names (normaliseHeader): exact
// synonyms first, then synonyms wrapped in unit or coordinate-system words
// ("Easting UTM", "Höhe ü. NN"). Any other extra word blocks the match, so
// "Easting RMS" or "Base easting" is never a coordinate column. Longitude and
// Latitude are never mapped.

import { parseCsv, parseNumber, decimalPlaces, isNumberLike } from './csv-parse.js';
import { MIN_CONTROL_POINTS } from './rigid-fit.js';

// ============ Roles ============

export const MAPPING_ROLES = Object.freeze(['name', 'easting', 'northing', 'height', 'description', 'code']);
export const REQUIRED_ROLES = Object.freeze(['easting', 'northing', 'height']);
export const ROLE_LABELS = Object.freeze({
    name: 'Name', easting: 'Easting', northing: 'Northing', height: 'Height', description: 'Description', code: 'Code'
});

export function emptyMapping() {
    return { name: null, easting: null, northing: null, height: null, description: null, code: null, extras: [] };
}

// ============ Normalising ============

// Letters that have no decomposition into base letter plus accent.
const FOLD = { 'ı': 'i', 'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'đ': 'd', 'ł': 'l', 'œ': 'oe' };

// Words that may surround a synonym without changing its meaning: units,
// coordinate-system and datum words. A bracket group made only of these is
// dropped ("Elevation (m)"); other bracket groups stay as words, so
// "Easting (RMS)" does not become Easting.
const QUALIFIERS = new Set([
    'm', 'mm', 'cm', 'km', 'meter', 'meters', 'metre', 'metres', 'metr', 'ft', 'feet', 'usft',
    'deg', 'degree', 'degrees', 'grad', 'gon', 'dd',
    'utm', 'zone', 'epsg', 'wgs', 'wgs84', 'etrs', 'etrs89', 'itrf', 'tuks', 'tm', 'gk', 'grid', 'local', 'lokal',
    'proj', 'projected', 'plane', 'coord', 'coords', 'coordinate', 'coordinates', 'koordinate', 'koordinaten', 'koordinat',
    'value', 'values', 'wert', 'deger', 'degeri',
    'nn', 'nhn', 'dhhn', 'msl', 'amsl', 'asl', 'ortho', 'orthometric', 'geoid', 'egm', 'u', 'ue', 'uber', 'ueber'
]);
const QUALIFIER_CODE = /^(?:\d+[a-z]?|(?:utm|zone|epsg|tm|gk|itrf|dhhn|egm|etrs|wgs)\d+[a-z]*)$/;

function isQualifier(token) {
    return QUALIFIERS.has(token) || QUALIFIER_CODE.test(token);
}

function foldText(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[ıßæøđłœ]/g, c => FOLD[c]);
}

/**
 * Normalised header for matching: lowercase, diacritics removed (German
 * umlauts and Turkish letters included: "Höhe" -> "hohe", "Yukarı" ->
 * "yukari"), unit brackets dropped, spaces, underscores and punctuation
 * collapsed to single spaces.
 * @param {string} name
 * @returns {string} e.g. "Elevation (m)" -> "elevation", "Point_ID" -> "point id"
 */
export function normaliseHeader(name) {
    return foldText(name)
        .replace(/[([{]([^()[\]{}]*)[)\]}]/g, (m, inner) => {
            const tokens = inner.split(/[^a-z0-9]+/).filter(Boolean);
            return tokens.every(isQualifier) ? ' ' : ` ${inner} `;
        })
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const compact = (s) => s.replace(/ /g, '');

// The normalised header with qualifier words removed from both ends (at
// least one word is kept), compacted. "Easting UTM 35N" -> "easting".
function coreOf(norm) {
    const tokens = norm.split(' ').filter(Boolean);
    let a = 0, b = tokens.length;
    while (b - a > 1 && isQualifier(tokens[a])) a++;
    while (b - a > 1 && isQualifier(tokens[b - 1])) b--;
    return { core: tokens.slice(a, b).join(''), stripped: a > 0 || b < tokens.length, tokens };
}

// ============ Synonyms ============
// Normalised forms (see normaliseHeader), best first. They are compared
// without spaces, so "point id" also matches "PointID".

const SYNONYMS = {
    name: [
        'name', 'point name', 'point', 'point id', 'point no', 'point number', 'pt', 'pt id', 'pt no',
        'station', 'stn', 'label', 'id', 'no', 'nr', 'number',
        'punktname', 'punkt', 'punktnummer', 'punkt nr', 'pkt', 'pkt nr', 'bezeichnung', 'nummer',
        'nokta', 'nokta adi', 'nokta no', 'nokta numarasi', 'nokta ismi', 'ad', 'adi', 'isim', 'p'
    ],
    easting: [
        'easting', 'east', 'e', 'utm easting', 'utm east', 'utm e', 'east coordinate',
        'rechtswert', 'rechts', 'ostwert', 'ost', 'rw', 'rechtswert y', 'y rechtswert',
        'dogu', 'saga', 'saga deger', 'dogu deger', 'saga y', 'y saga',
        'x'
    ],
    northing: [
        'northing', 'north', 'n', 'utm northing', 'utm north', 'utm n', 'north coordinate',
        'hochwert', 'hoch', 'nordwert', 'nord', 'hw', 'hochwert x', 'x hochwert',
        'kuzey', 'yukari', 'yukari deger', 'kuzey deger', 'yukari x', 'x yukari',
        'y'
    ],
    description: [
        'description', 'desc', 'descr', 'remark', 'remarks', 'comment', 'comments', 'note', 'notes', 'info',
        'beschreibung', 'bemerkung', 'bemerkungen', 'kommentar', 'notiz',
        'aciklama', 'aciklamalar', 'not', 'notlar', 'yorum', 'd'
    ],
    code: [
        'code', 'feature code', 'point code', 'fcode', 'codes', 'feature',
        'punktcode', 'objektcode', 'kennung', 'punktart',
        'kod', 'kodu', 'nokta kodu'
    ]
};

// Height synonyms in tiers: Elevation > Height > Höhe > H > Z > ellipsoidal
// height (the last resort).
const HEIGHT_TIERS = [
    ['elevation', 'elev', 'orthometric height', 'ortho height', 'orthometric elevation'],
    ['height', 'ht', 'altitude', 'alt'],
    ['hohe', 'hoehe', 'normalhohe', 'normalhoehe', 'yukseklik', 'kot', 'kot degeri', 'rakim'],
    ['h'],
    ['z'],
    ['ellipsoidal height', 'ellipsoid height', 'ellipsoidal elevation', 'height above ellipsoid', 'ell height',
        'h ell', 'ellipsoidische hohe', 'ellipsoidische hoehe', 'elipsoid yuksekligi', 'elipsoidal yukseklik']
];
const ELLIPSOIDAL_TIER = HEIGHT_TIERS.length - 1;
const ELLIPSOID_WORD = /^(?:ell|ellips|elips)/;

const LATLON = {
    lat: ['latitude', 'lat', 'breite', 'breitengrad', 'geographische breite', 'enlem', 'phi'],
    lon: ['longitude', 'lon', 'long', 'lng', 'lange', 'langengrad', 'geographische lange', 'boylam', 'lambda']
};
const LATLON_WORDS = new Set(['latitude', 'longitude', 'lat', 'lon', 'lng', 'breite', 'breitengrad', 'lange', 'langengrad', 'enlem', 'boylam']);

// compact synonym -> { tier, rank }, per role
const INDEX = {};
for (const role of Object.keys(SYNONYMS)) {
    INDEX[role] = new Map();
    SYNONYMS[role].forEach((s, rank) => INDEX[role].set(compact(s), { tier: 0, rank }));
}
INDEX.height = new Map();
HEIGHT_TIERS.forEach((list, tier) => list.forEach((s, rank) => INDEX.height.set(compact(s), { tier, rank })));
for (const key of Object.keys(LATLON)) {
    INDEX[key] = new Map(LATLON[key].map((s, rank) => [compact(s), { tier: 0, rank }]));
}

// How a header matches a role: { tier, rank, exact } or null.
function matchRole(header, role) {
    const index = INDEX[role];
    const norm = normaliseHeader(header);
    if (!norm) return null;
    const hit = index.get(compact(norm));
    if (hit) return { ...hit, exact: true };
    const { core, stripped, tokens } = coreOf(norm);
    if (stripped && index.has(core)) return { ...index.get(core), exact: false };
    if (role === 'height' && tokens.some(t => ELLIPSOID_WORD.test(t))) {
        // "Height (ellipsoidal)", "Elevation ellipsoid": a height word plus an
        // ellipsoid word is the last resort.
        const rest = coreOf(tokens.filter(t => !ELLIPSOID_WORD.test(t)).join(' ')).core;
        if (rest && index.has(rest)) return { tier: ELLIPSOIDAL_TIER, rank: 0, exact: false };
    }
    return null;
}

/** True when the header names a known column (any role, or latitude/longitude). */
export function isKnownHeader(header) {
    return MAPPING_ROLES.some(role => matchRole(header, role)) || !!matchRole(header, 'lat') || !!matchRole(header, 'lon');
}

/** Columns named latitude and longitude: { lat, lon } indices or null. */
export function latLonColumns(headers) {
    const find = (key) => {
        const j = headers.findIndex(h => matchRole(h, key));
        return j >= 0 ? j : null;
    };
    return { lat: find('lat'), lon: find('lon') };
}

function coreName(header) {
    return coreOf(normaliseHeader(header)).core;
}

// "X" or "Y" (also "X coordinate", "Koordinate Y").
function isXYHeader(header) {
    const core = coreName(header);
    return core === 'x' || core === 'y';
}

// ============ Personal data and attributes ============

const PERSONAL_WORDS = new Set([
    'author', 'authors', 'surveyor', 'operator', 'observer', 'user', 'username', 'userid', 'creator', 'person',
    'email', 'mail', 'phone', 'telephone', 'serial', 'serialnumber', 'serialno', 'sn', 'imei',
    'autor', 'bearbeiter', 'vermesser', 'beobachter', 'benutzer', 'seriennummer', 'ersteller',
    'yazar', 'kullanici', 'olcen', 'seri', 'telefon'
]);
const PERSONAL_PHRASES = /\b(?:s n|created by|measured by|surveyed by|erstellt von|gemessen von|olcum yapan)\b/;

/**
 * True for columns that may hold personal data (Author, Device serial number,
 * Surveyor, Operator, User, Serial and similar). They are never suggested as
 * attributes, and ticking one gives a PERSONAL_DATA warning.
 */
export function isPersonalDataHeader(header) {
    const norm = normaliseHeader(header);
    if (!norm) return false;
    return norm.split(' ').some(t => PERSONAL_WORDS.has(t)) || PERSONAL_PHRASES.test(norm);
}

export function personalDataColumns(headers) {
    return headers.map((h, j) => (isPersonalDataHeader(h) ? j : -1)).filter(j => j >= 0);
}

// Attribute suggestions: accuracy (RMS), solution status, observation time.
const ACCURACY_WORDS = new Set([
    'rms', 'hrms', 'vrms', 'sigma', 'sd', 'sdev', 'std', 'stdev', 'stddev', 'precision', 'accuracy', 'cq',
    'genauigkeit', 'hassasiyet', 'dogruluk'
]);
const STATUS_WORDS = new Set(['solution', 'fix', 'status', 'losung', 'cozum', 'durum']);
const TIME_WORDS = new Set(['time', 'date', 'datetime', 'timestamp', 'utc', 'zeit', 'datum', 'uhrzeit', 'zeitstempel', 'tarih', 'saat', 'zaman']);
const TIME_NAMES = new Set(['averaging start', 'averaging end', 'start', 'end', 'observed', 'measured']);

function isAttributeHeader(header) {
    const norm = normaliseHeader(header);
    if (!norm || isPersonalDataHeader(header)) return false;
    const tokens = norm.split(' ');
    if (tokens.some(t => LATLON_WORDS.has(t))) return false;
    return tokens.some(t => ACCURACY_WORDS.has(t) || STATUS_WORDS.has(t) || TIME_WORDS.has(t)) || TIME_NAMES.has(norm);
}

const cellsOf = (r) => (Array.isArray(r) ? r : r.cells);

function cell(cells, j) {
    return j === null || j === undefined ? '' : (cells[j] ?? '');
}

function columnHasValues(rows, j) {
    return rows.some(r => cell(cellsOf(r), j).trim() !== '');
}

function columnHasNumbers(rows, j) {
    return rows.some(r => isNumberLike(cell(cellsOf(r), j).trim()));
}

/**
 * Columns suggested as attributes: accuracy (RMS, sigma, precision), solution
 * status and observation date/time columns such as "Averaging start". Never
 * a mapped column, a personal-data column or latitude/longitude; with rows,
 * only columns that hold a value.
 * @returns {number[]} column indices
 */
export function suggestAttributes(headers, mapping = emptyMapping(), rows = []) {
    const mapped = new Set(MAPPING_ROLES.map(r => mapping[r]).filter(j => j !== null && j !== undefined));
    return headers.map((h, j) => j).filter(j =>
        !mapped.has(j) && isAttributeHeader(headers[j]) && (!rows.length || columnHasValues(rows, j)));
}

// ============ Auto-mapping ============

const COORDINATE_ROLES = new Set(['easting', 'northing', 'height']);

/**
 * Columns matching a role, best first: (with rows, coordinate columns that
 * hold numbers first), then the height tier, exact before qualified matches,
 * synonym order, and the leftmost column.
 * @returns {number[]} column indices
 */
export function roleCandidates(headers, role, rows = []) {
    const list = [];
    headers.forEach((h, j) => {
        const m = matchRole(h, role);
        if (!m) return;
        const filled = COORDINATE_ROLES.has(role) && rows.length ? (columnHasNumbers(rows, j) ? 1 : 0) : 1;
        list.push({ j, filled, ...m });
    });
    list.sort((a, b) => (b.filled - a.filled) || (a.tier - b.tier) || (Number(b.exact) - Number(a.exact)) ||
        (a.rank - b.rank) || (a.j - b.j));
    return list.map(c => c.j);
}

function median(values) {
    if (!values.length) return null;
    const v = values.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Median count of integer digits of a column's numbers (512345.6 -> 6).
function medianIntDigits(rows, j, decimal) {
    const digits = [];
    for (const r of rows) {
        const v = parseNumber(cell(cellsOf(r), j), decimal);
        if (Number.isFinite(v)) digits.push(String(Math.trunc(Math.abs(v))).length);
    }
    return median(digits);
}

/**
 * Column order of a header-less file: 'pnezd' when the second column has
 * 7-digit and the third 6-digit numbers (northing before easting, as in UTM
 * north of about 1000 km), otherwise 'penzd'.
 */
export function guessHeaderlessOrder(rows, decimal = '.') {
    return medianIntDigits(rows, 1, decimal) === 7 && medianIntDigits(rows, 2, decimal) === 6 ? 'pnezd' : 'penzd';
}

function positionalMapping(order, columnCount) {
    const m = emptyMapping();
    const at = (j) => (j < columnCount ? j : null);
    m.name = at(0);
    m.easting = at(order === 'pnezd' ? 2 : 1);
    m.northing = at(order === 'pnezd' ? 1 : 2);
    m.height = at(3);
    m.description = at(4);
    return m;
}

/**
 * Suggested mapping from the headers (and, when given, the rows).
 * - Easting, northing and height are chosen first, then name, code and
 *   description; a column takes one role only.
 * - Height: Elevation > Height > Höhe > H > Z > Ellipsoidal height.
 * - Columns named R and H together are the German short headers Rechtswert
 *   and Hochwert: easting and northing (height is then Höhe, Z and so on).
 * - Columns named X and Y are taken as easting and northing, unless the
 *   numbers show a 7-digit X and a 6-digit Y (X = north, as in Turkish and
 *   German practice); checkMapping warns about X and Y either way.
 * - Without a header the columns are read as PENZD or PNEZD.
 * - extras are the suggested attribute columns.
 * @param {string[]} headers - parseCsv().headers
 * @param {Array} [rows]
 * @param {{hasHeader?: boolean, decimal?: '.'|','}} [options]
 * @returns {object} mapping
 */
export function autoMap(headers, rows = [], { hasHeader = true, decimal = '.' } = {}) {
    if (!hasHeader) return positionalMapping(guessHeaderlessOrder(rows, decimal), headers.length);
    const mapping = emptyMapping();
    const used = new Set();
    const rw = headers.findIndex(h => coreName(h) === 'r'), hw = headers.findIndex(h => coreName(h) === 'h');
    if (rw >= 0 && hw >= 0) {
        mapping.easting = rw; mapping.northing = hw;
        used.add(rw); used.add(hw);
    }
    for (const role of ['easting', 'northing', 'height', 'name', 'code', 'description']) {
        if (mapping[role] !== null) continue;
        const j = roleCandidates(headers, role, rows).find(c => !used.has(c));
        if (j !== undefined) { mapping[role] = j; used.add(j); }
    }
    if (rows.length && mapping.easting !== null && mapping.northing !== null &&
        isXYHeader(headers[mapping.easting]) && isXYHeader(headers[mapping.northing]) &&
        medianIntDigits(rows, mapping.easting, decimal) === 7 && medianIntDigits(rows, mapping.northing, decimal) === 6) {
        [mapping.easting, mapping.northing] = [mapping.northing, mapping.easting];
    }
    mapping.extras = suggestAttributes(headers, mapping, rows);
    return mapping;
}

/** The mapping with Easting and Northing exchanged (the Swap button). */
export function swapMappingEN(mapping) {
    return { ...mapping, easting: mapping.northing, northing: mapping.easting, extras: [...(mapping.extras || [])] };
}

// ============ Presets ============

export const PRESETS = Object.freeze([
    Object.freeze({ id: 'auto', label: 'Auto' }),
    Object.freeze({ id: 'emlid', label: 'Emlid Flow' }),
    Object.freeze({ id: 'penzd', label: 'PENZD (Point, E, N, Z, Description)', headerless: true }),
    Object.freeze({ id: 'pnezd', label: 'PNEZD (Point, N, E, Z, Description)', headerless: true }),
    Object.freeze({ id: 'custom', label: 'Custom' })
]);

const EMLID_COLUMNS = { name: 'name', easting: 'easting', northing: 'northing', height: 'elevation', description: 'description', code: 'code' };
const EMLID_EXTRAS = ['easting rms', 'northing rms', 'elevation rms', 'lateral rms', 'solution status', 'averaging start', 'averaging end'];
const EMLID_MARKERS = ['easting', 'northing', 'elevation', 'solution status'];

function emlidMapping(headers) {
    const norms = headers.map(normaliseHeader);
    const find = (n) => { const j = norms.indexOf(n); return j >= 0 ? j : null; };
    const m = emptyMapping();
    for (const role of MAPPING_ROLES) m[role] = find(EMLID_COLUMNS[role]);
    m.extras = EMLID_EXTRAS.map(find).filter(j => j !== null);
    return m;
}

/**
 * The preset that fits a parsed file: 'emlid' for an Emlid Flow header,
 * 'penzd' or 'pnezd' without a header, otherwise 'auto'.
 */
export function detectPreset(headers, rows = [], { hasHeader = true, decimal = '.' } = {}) {
    if (!hasHeader) return guessHeaderlessOrder(rows, decimal);
    const norms = new Set(headers.map(normaliseHeader));
    const emlid = EMLID_MARKERS.every(n => norms.has(n)) && (norms.has('averaging start') || norms.has('easting rms'));
    return emlid ? 'emlid' : 'auto';
}

/**
 * The mapping of a preset. 'auto' is autoMap(); 'emlid' takes the Emlid Flow
 * column names (height = Elevation) and its accuracy, status and time
 * columns as extras; 'penzd' and 'pnezd' are header-less column orders
 * (Point, E, N, Z, Description / Point, N, E, Z, Description).
 * @returns {object|null} mapping, or null for 'custom' (keep the current one)
 */
export function applyPreset(preset, headers, rows = [], options = {}) {
    switch (preset) {
        case 'auto': return autoMap(headers, rows, options);
        case 'emlid': return emlidMapping(headers);
        case 'penzd':
        case 'pnezd': return positionalMapping(preset, headers.length);
        case 'custom': return null;
        default: throw new RangeError(`column-mapping: unknown preset ${JSON.stringify(preset)}`);
    }
}

/**
 * parseCsv() with this module's header synonyms for header detection. This
 * is the parser entry point for the UI.
 */
export function parseSurveyCsv(input, options = {}) {
    return parseCsv(input, { ...options, headerTest: isKnownHeader });
}

/**
 * Key for remembered mappings: the normalised header names, trailing blank
 * ones dropped. null for files without a header.
 * @param {string[]|null} rawHeaders - parseCsv().rawHeaders
 */
export function headerSignature(rawHeaders) {
    if (!Array.isArray(rawHeaders)) return null;
    const names = rawHeaders.map(normaliseHeader);
    while (names.length && !names[names.length - 1]) names.pop();
    return names.length ? names.join('|') : null;
}

// ============ Records ============

export const SKIP_REASONS = Object.freeze({
    MISSING_VALUE: 'MISSING_VALUE',   // a coordinate cell is blank
    NOT_A_NUMBER: 'NOT_A_NUMBER'      // a coordinate cell is not a number
});

function isIndex(j, columnCount) {
    return Number.isInteger(j) && j >= 0 && (columnCount === undefined || j < columnCount);
}

function cleanText(s) {
    return s.replace(/\r\n?/g, '\n').trim();
}

function shorten(s, max = 40) {
    const t = s.trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Turns rows into point records.
 * @param {Array} rows - parseCsv().rows (or arrays of cells; row is then index + 1)
 * @param {object} mapping - easting, northing and height must be set
 * @param {{decimal?: '.'|',', headers?: string[]}} [options]
 * @returns {{valid: Array<{row, line, name, e, n, h, raw: {e, n, h}, columns: {e, n, h},
 *            description, code, attributes}>,
 *            skipped: Array<{row, line, name, reason, column, value, message}>}}
 *   raw holds the coordinate cells verbatim, columns their header names.
 *   name, description and code are trimmed, with line breaks as '\n' ('' when
 *   blank or unmapped; the importer names a blank one "file row N").
 *   attributes maps the header name of each extras column to its cell
 *   verbatim; blank cells are left out. A row with a blank or non-numeric
 *   coordinate is skipped.
 */
export function buildRecords(rows, mapping, { decimal = '.', headers = [] } = {}) {
    for (const role of REQUIRED_ROLES) {
        if (!isIndex(mapping[role])) throw new TypeError(`column-mapping: no column for ${role}`);
    }
    const colName = (j) => headers[j] ?? `Column ${j + 1}`;
    const columns = { e: colName(mapping.easting), n: colName(mapping.northing), h: colName(mapping.height) };
    const extras = (mapping.extras || []).filter(j => isIndex(j));
    const valid = [], skipped = [];

    rows.forEach((r, i) => {
        const cells = cellsOf(r);
        const row = Array.isArray(r) ? i + 1 : r.row;
        const line = Array.isArray(r) ? null : (r.line ?? null);
        const name = cleanText(cell(cells, mapping.name));
        const raw = { e: cell(cells, mapping.easting), n: cell(cells, mapping.northing), h: cell(cells, mapping.height) };
        const values = {};
        for (const k of ['e', 'n', 'h']) {
            const s = raw[k];
            if (s.trim() === '') {
                skipped.push({ row, line, name, reason: SKIP_REASONS.MISSING_VALUE, column: columns[k], value: s, message: `${columns[k]} is empty` });
                return;
            }
            const v = parseNumber(s, decimal);
            if (!Number.isFinite(v)) {
                skipped.push({ row, line, name, reason: SKIP_REASONS.NOT_A_NUMBER, column: columns[k], value: s, message: `${columns[k]} is not a number: "${shorten(s)}"` });
                return;
            }
            values[k] = v;
        }
        const attributes = {};
        for (const j of extras) {
            const v = cell(cells, j);
            if (v.trim() !== '') attributes[colName(j)] = v;
        }
        valid.push({
            row, line, name, e: values.e, n: values.n, h: values.h,
            raw, columns: { ...columns },
            description: cleanText(cell(cells, mapping.description)),
            code: cleanText(cell(cells, mapping.code)),
            attributes
        });
    });
    return { valid, skipped };
}

// ============ Checks ============

export const MAPPING_ERRORS = Object.freeze({
    MISSING_COLUMN: 'MISSING_COLUMN',     // easting, northing or height not chosen (roles)
    SAME_COLUMN: 'SAME_COLUMN',           // E, N and H are not three different columns
    LATLON_DEGREES: 'LATLON_DEGREES',     // values look like latitude/longitude in degrees
    LATLON_ONLY: 'LATLON_ONLY',           // E/N empty, latitude/longitude filled (Emlid without a projected system)
    TOO_FEW_ROWS: 'TOO_FEW_ROWS',         // fewer than MIN_CONTROL_POINTS valid rows for a new alignment
    NO_VALID_ROWS: 'NO_VALID_ROWS'        // no valid row at all (existing alignment)
});

export const MAPPING_WARNINGS = Object.freeze({
    SWAP_SUSPECTED: 'SWAP_SUSPECTED',     // 7-digit easting with 6-digit northing: offer Swap
    XY_COLUMNS: 'XY_COLUMNS',             // columns named X and Y: check which one is north
    ROUNDED: 'ROUNDED',                   // a coordinate column has one decimal or none (columns)
    PERSONAL_DATA: 'PERSONAL_DATA',       // personal-data columns ticked as attributes (columns)
    ROWS_SKIPPED: 'ROWS_SKIPPED',         // rows with a missing or non-numeric coordinate (count, rows)
    HEIGHT_COLUMN_MISMATCH: 'HEIGHT_COLUMN_MISMATCH'   // from heightColumnMismatch()
});

export const DEGREE_SPREAD = 0.05;  // in-range values with a spread below this read as degrees (3 or more rows)
export const DEGREE_DECIMALS = 5;   // ... and so do many decimals (median) with fewer rows,
export const DEGREE_SPREAD_WIDE = 1; // or together with a spread below this

function issue(code, message, details = {}) {
    return { code, message, ...details };
}

function listText(names) {
    const q = names.map(n => `"${n}"`);
    return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

// Latitude/longitude in degrees: (nearly) all values within ±180/±90 (either
// order) and a tiny spread, as a site spans well under 0.05 degrees. Many
// decimals count only with fewer than 3 rows or a spread under a degree: a
// local metric grid (0 to 90 m) exported with 6 decimals is not degrees.
function looksLikeDegrees(valid, decimal) {
    if (!valid.length) return false;
    const inRange = valid.filter(r =>
        (Math.abs(r.e) <= 180 && Math.abs(r.n) <= 90) || (Math.abs(r.e) <= 90 && Math.abs(r.n) <= 180));
    if (inRange.length < 0.9 * valid.length) return false;
    const decs = [];
    for (const r of inRange) decs.push(decimalPlaces(r.raw.e, decimal), decimalPlaces(r.raw.n, decimal));
    const manyDecimals = median(decs) >= DEGREE_DECIMALS;
    if (inRange.length < 3) return manyDecimals;
    const spread = (k) => {
        let lo = Infinity, hi = -Infinity;
        for (const r of inRange) { lo = Math.min(lo, r[k]); hi = Math.max(hi, r[k]); }
        return hi - lo;
    };
    const se = spread('e'), sn = spread('n');
    if (se < DEGREE_SPREAD && sn < DEGREE_SPREAD) return true;
    return manyDecimals && se < DEGREE_SPREAD_WIDE && sn < DEGREE_SPREAD_WIDE;
}

/**
 * Blocking errors and warnings for the mapping dialog (plan, Step A).
 * @param {{headers: string[], rows: Array, mapping: object, decimal?: '.'|',',
 *          newAlignment?: boolean, records?: object}} input
 *   newAlignment: the import creates a new alignment (needs 3 valid rows).
 *   records: a buildRecords() result to reuse.
 * @returns {{errors: object[], warnings: object[], valid: number, skipped: number}}
 *   Each item is { code, message, ...details } with codes from MAPPING_ERRORS
 *   and MAPPING_WARNINGS. Any error blocks the import.
 */
export function checkMapping({ headers, rows, mapping, decimal = '.', newAlignment = true, records = null }) {
    const errors = [], warnings = [];
    const n = headers.length;

    const missing = REQUIRED_ROLES.filter(r => !isIndex(mapping[r], n));
    if (missing.length) {
        const labels = missing.map(r => ROLE_LABELS[r]);
        const text = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
        errors.push(issue(MAPPING_ERRORS.MISSING_COLUMN, `Choose a column for ${text}.`, { roles: missing }));
    }
    const chosen = REQUIRED_ROLES.map(r => mapping[r]).filter(j => isIndex(j, n));
    const same = new Set(chosen).size < chosen.length;
    if (same) {
        errors.push(issue(MAPPING_ERRORS.SAME_COLUMN, 'Easting, Northing and Height must be three different columns.'));
    }

    const ll = latLonColumns(headers);
    let latLonOnly = false;
    if (ll.lat !== null && ll.lon !== null && columnHasNumbers(rows, ll.lat) && columnHasNumbers(rows, ll.lon)) {
        const empty = (j) => !isIndex(j, n) || !columnHasNumbers(rows, j);
        if (empty(mapping.easting) || empty(mapping.northing)) {
            latLonOnly = true;
            errors.push(issue(MAPPING_ERRORS.LATLON_ONLY,
                'Easting and Northing are empty, but Longitude and Latitude are filled. Survey import needs projected coordinates in metres. ' +
                'In Emlid Flow, give the project a projected coordinate system (for example a UTM zone) and export the points again.'));
        }
    }

    if (missing.length || same) return { errors, warnings, valid: 0, skipped: rows.length };

    const recs = records || buildRecords(rows, mapping, { decimal, headers });
    const valid = recs.valid;

    if (!latLonOnly) {
        if (newAlignment && valid.length < MIN_CONTROL_POINTS) {
            errors.push(issue(MAPPING_ERRORS.TOO_FEW_ROWS,
                `A new alignment needs at least ${MIN_CONTROL_POINTS} rows with valid coordinates; this file has ${valid.length}.`,
                { valid: valid.length, required: MIN_CONTROL_POINTS }));
        } else if (!valid.length) {
            errors.push(issue(MAPPING_ERRORS.NO_VALID_ROWS, 'No row has valid coordinates.'));
        }
    }
    if (looksLikeDegrees(valid, decimal)) {
        errors.push(issue(MAPPING_ERRORS.LATLON_DEGREES,
            'The coordinates look like latitude and longitude in degrees. Survey import needs projected coordinates in metres, such as UTM. ' +
            'Export the points in a projected coordinate system and import again.'));
    }

    if (valid.length) {
        const digits = (k) => median(valid.map(r => String(Math.trunc(Math.abs(r[k]))).length));
        const eDigits = digits('e'), nDigits = digits('n');
        if (eDigits === 7 && nDigits === 6) {
            warnings.push(issue(MAPPING_WARNINGS.SWAP_SUSPECTED, 'Easting has 7 digits and Northing 6. They may be swapped.',
                { eastingDigits: eDigits, northingDigits: nDigits }));
        }
    }
    if (isXYHeader(headers[mapping.easting]) || isXYHeader(headers[mapping.northing])) {
        warnings.push(issue(MAPPING_WARNINGS.XY_COLUMNS,
            'The coordinate columns are named X and Y. Check which one is north: in Turkish and German survey practice X is often north (Yukarı, Hochwert) and Y east.'));
    }
    if (valid.length) {
        const rounded = [];
        for (const k of ['e', 'n', 'h']) {
            let most = 0;
            for (const r of valid) most = Math.max(most, decimalPlaces(r.raw[k], decimal) ?? 0);
            if (most <= 1) rounded.push(valid[0].columns[k]);
        }
        if (rounded.length) {
            warnings.push(issue(MAPPING_WARNINGS.ROUNDED,
                `${listText(rounded)} ${rounded.length === 1 ? 'has' : 'have'} one decimal or none. The file may have been rounded, for example by Excel.`,
                { columns: rounded }));
        }
    }
    const personal = (mapping.extras || []).filter(j => isIndex(j, n) && isPersonalDataHeader(headers[j])).map(j => headers[j]);
    if (personal.length) {
        warnings.push(issue(MAPPING_WARNINGS.PERSONAL_DATA,
            `${listText(personal)} may hold personal data. Columns kept as attributes are stored with every point and exported. Untick them unless you need them.`,
            { columns: personal }));
    }
    if (recs.skipped.length && !latLonOnly) {
        const count = recs.skipped.length;
        warnings.push(issue(MAPPING_WARNINGS.ROWS_SKIPPED,
            `${count} ${count === 1 ? 'row has' : 'rows have'} a missing or non-numeric coordinate and will be skipped.`,
            { count, rows: recs.skipped.slice(0, 10).map(s => s.row) }));
    }
    return { errors, warnings, valid: valid.length, skipped: recs.skipped.length };
}

/**
 * Compares the chosen height column with the one an alignment was made with
 * (alignment.heightColumn). The dialog then asks: new alignment, or use anyway.
 * @returns {object|null} a HEIGHT_COLUMN_MISMATCH warning, or null when they
 *   match (normalised) or either is unknown. "Height (2)", parseCsv's name for
 *   a second "Height" column, is a different column.
 */
export function heightColumnMismatch(alignmentHeightColumn, heightHeader) {
    if (!alignmentHeightColumn || !heightHeader) return null;
    const key = (s) => {
        const copy = /\s\((\d+)\)$/.exec(String(s).trim());
        return `${normaliseHeader(s)}#${copy ? copy[1] : ''}`;
    };
    if (key(alignmentHeightColumn) === key(heightHeader)) return null;
    return issue(MAPPING_WARNINGS.HEIGHT_COLUMN_MISMATCH,
        `This alignment was made with the height column "${alignmentHeightColumn}", but "${heightHeader}" is chosen. Create a new alignment, or use it anyway.`,
        { expected: alignmentHeightColumn, actual: heightHeader });
}
