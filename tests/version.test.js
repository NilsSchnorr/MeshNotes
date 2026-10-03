// tests/version.test.js - Release version guard
// APP_VERSION in js/state.js, CACHE in sw.js, CITATION.cff and the newest
// CHANGELOG.md section must name the same release, so a missed bump fails.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

function match(src, re, what) {
    const m = src.match(re);
    assert.ok(m, `${what} not found`);
    return m[1];
}

const appVersion = match(read('js/state.js'), /export const APP_VERSION = '([^']+)';/, 'APP_VERSION in js/state.js');
const cache = match(read('sw.js'), /const CACHE = '([^']+)';/, 'CACHE in sw.js');
const citation = read('CITATION.cff');
const changelog = read('CHANGELOG.md');

test('APP_VERSION is a semantic version', () => {
    assert.match(appVersion, /^\d+\.\d+\.\d+$/);
});

test('the service worker cache is named after APP_VERSION', () => {
    assert.equal(cache, `meshnotes-v${appVersion}`);
});

test('CITATION.cff names APP_VERSION', () => {
    assert.equal(match(citation, /^version: (\S+)$/m, 'version in CITATION.cff'), appVersion);
});

test('the newest CHANGELOG.md section is APP_VERSION, with the CITATION.cff date and a link', () => {
    const [, version, date] = changelog.match(/^## \[([^\]]+)\] — (\d{4}-\d{2}-\d{2})$/m) || [];
    assert.equal(version, appVersion, 'newest changelog heading');
    assert.equal(match(citation, /^date-released: "([^"]+)"$/m, 'date-released in CITATION.cff'), date);
    assert.ok(changelog.includes(`\n[${appVersion}]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v${appVersion}\n`),
        'link reference for the newest changelog section');
});
