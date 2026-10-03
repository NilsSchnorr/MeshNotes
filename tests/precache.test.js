// tests/precache.test.js - Offline boot guard for the service worker
// Every app module and UI icon must be in PRECACHE in sw.js, otherwise an
// offline start fails. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readPrecache() {
    const src = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    const m = src.match(/const PRECACHE = \[([\s\S]*?)\];/);
    assert.ok(m, 'PRECACHE array not found in sw.js');
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function listFiles(dir, ext) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(full, ext));
        else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
}

const toUrl = (file) => './' + relative(ROOT, file).split(sep).join('/');

test('every module under js/ is precached', () => {
    const precache = new Set(readPrecache());
    const missing = listFiles(join(ROOT, 'js'), '.js').map(toUrl).filter(u => !precache.has(u));
    assert.deepEqual(missing, []);
});

test('every icon in ICON_FILES is precached', () => {
    const precache = new Set(readPrecache());
    const src = readFileSync(join(ROOT, 'js/ui/icons.js'), 'utf8');
    const block = src.match(/const ICON_FILES = \{([\s\S]*?)\};/);
    assert.ok(block, 'ICON_FILES not found in js/ui/icons.js');
    const icons = [...block[1].matchAll(/'([^']+\.svg)'/g)].map(x => './icons/' + x[1]);
    assert.ok(icons.length > 0);
    assert.deepEqual(icons.filter(u => !precache.has(u)), []);
});

test('every precached path exists and is listed once', () => {
    const precache = readPrecache();
    const missing = precache.filter(u => u !== './' && !existsSync(join(ROOT, u)));
    assert.deepEqual(missing, []);
    const dupes = precache.filter((u, i) => precache.indexOf(u) !== i);
    assert.deepEqual(dupes, []);
});
