// tests/manual-search.test.js - Search of the Manual
// findMatches() decides what the search field of the Manual finds; the rest
// of js/ui/manual.js works on the document and is checked in the browser.
// The markup and wiring the search needs are guarded here as well.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findMatches, MANUAL_SEARCH_MIN_LENGTH } from '../js/ui/manual.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const found = (text, query) => findMatches(text, query).map(([start, end]) => text.slice(start, end));

test('findMatches ignores case and returns every occurrence', () => {
    const text = 'Zenodo gives every upload a DOI. Upload both files to zenodo.';
    assert.deepEqual(found(text, 'zenodo'), ['Zenodo', 'zenodo']);
    assert.deepEqual(found(text, 'UPLOAD'), ['upload', 'Upload']);
    assert.deepEqual(findMatches(text, 'doi'), [[28, 31]]);
    assert.deepEqual(findMatches(text, 'heidata'), []);
});

test('findMatches takes the search text literally', () => {
    assert.deepEqual(found('ending in ?download=1 and (.jsonld)', '?download=1'), ['?download=1']);
    assert.deepEqual(found('ending in ?download=1 and (.jsonld)', '(.jsonld)'), ['(.jsonld)']);
    // A dot is a dot, not "any character"
    assert.deepEqual(found('model.glb modelXglb', 'model.glb'), ['model.glb']);
    assert.deepEqual(found('a\\b [x] 5^2 $1 {n} a|b', '[x]'), ['[x]']);
    assert.deepEqual(found('a\\b [x] 5^2 $1 {n} a|b', 'a\\b'), ['a\\b']);
});

test('findMatches lets white space in the search text match any white space', () => {
    const wrapped = 'the record\n            ID of the upload';
    assert.deepEqual(found(wrapped, 'record ID'), ['record\n            ID']);
    assert.deepEqual(found('record ID', 'record   ID'), ['record ID']);
    // Leading and trailing white space of the search text does not count
    assert.deepEqual(found('record ID', '  record ID '), ['record ID']);
    assert.deepEqual(found('recordID', 'record ID'), []);
});

test('findMatches ignores search texts that are too short', () => {
    assert.equal(MANUAL_SEARCH_MIN_LENGTH, 2);
    assert.deepEqual(findMatches('a banana', 'a'), []);
    assert.deepEqual(findMatches('a banana', ' a '), []);
    assert.deepEqual(findMatches('a banana', ''), []);
    assert.deepEqual(findMatches('a banana', undefined), []);
    assert.deepEqual(findMatches('', 'an'), []);
    assert.equal(findMatches('a banana', 'an').length, 2);
});

test('the Manual has its search bar between the header and the chapters', () => {
    const html = read('index.html');
    const header = html.indexOf('<div id="manual-modal-header">');
    const bar = html.indexOf('<div id="manual-search-bar">');
    const content = html.indexOf('<div id="manual-modal-content">');
    assert.ok(header > 0 && header < bar && bar < content, 'order of header, search bar and chapters');
    // Outside the scrolling chapters, so the PDF manual and the search itself
    // never read the bar as Manual text
    for (const id of ['manual-search-input', 'manual-search-count', 'manual-search-prev', 'manual-search-next']) {
        const at = html.indexOf(`id="${id}"`);
        assert.ok(at > bar && at < content, id);
        assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
    }
});

test('the search is started with the other listeners', () => {
    const listeners = read('js/ui/event-listeners.js');
    assert.match(listeners, /import \{[^}]*\binitManualSearch\b[^}]*\} from '\.\/manual\.js';/);
    assert.match(listeners, /^\s*initManualSearch\(\);$/m);
});
