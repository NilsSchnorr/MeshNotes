// tests/entry-edit.test.js - Saving an entry opened with Edit
// applyEntryEdit() in js/annotation-tools/data.js is the step both Save
// buttons of the annotation window run for an edited entry (Save Entry, and
// the window's own Save for an entry still open). It keeps the previous
// version before changing anything, counts a change of links alone as a
// change, and leaves an unchanged entry as it was. Loads the browser module
// through tests/support/app-env.js; the function touches no DOM.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/app-env.js';

const { applyEntryEdit } = await import('../js/annotation-tools/data.js');

function entry(overrides = {}) {
    return {
        id: 1,
        description: 'Chipped at the lip',
        author: 'A. Author',
        authorOrcid: '0000-0002-1825-0097',
        links: ['https://example.org/a'],
        timestamp: '2026-10-01T10:00:00.000Z',
        ...overrides
    };
}

const same = { description: 'Chipped at the lip', author: 'A. Author', links: ['https://example.org/a'] };

test('an edit that changes nothing leaves the entry as it was', () => {
    const e = entry();
    const before = structuredClone(e);
    assert.equal(applyEntryEdit(e, same), false);
    assert.deepEqual(e, before);
});

test('a new description is applied and the previous version kept', () => {
    const e = entry();
    assert.equal(applyEntryEdit(e, { ...same, description: 'Chipped at the lip, old break' }), true);
    assert.equal(e.description, 'Chipped at the lip, old break');
    assert.equal(e.versions.length, 1);
    assert.equal(e.versions[0].description, 'Chipped at the lip');
    assert.deepEqual(e.versions[0].links, ['https://example.org/a']);
    assert.ok(e.modified);
});

test('a change of links alone is a change, and the previous version keeps the old links', () => {
    const e = entry();
    const links = ['https://example.org/a', 'https://example.org/b'];
    assert.equal(applyEntryEdit(e, { ...same, links }), true);
    assert.deepEqual(e.links, links);
    assert.deepEqual(e.versions[0].links, ['https://example.org/a']);
});

test('the entry gets a copy of the links, not the draft itself', () => {
    const e = entry();
    const draft = ['https://example.org/b'];
    applyEntryEdit(e, { ...same, links: draft });
    draft.push('https://example.org/c');
    assert.deepEqual(e.links, ['https://example.org/b']);
});

test('a changed author drops the stored ORCID, an unchanged one keeps it', () => {
    const kept = entry();
    applyEntryEdit(kept, { ...same, description: 'Changed' });
    assert.equal(kept.authorOrcid, '0000-0002-1825-0097');

    const changed = entry();
    applyEntryEdit(changed, { ...same, author: 'B. Author' });
    assert.equal(changed.author, 'B. Author');
    assert.equal(changed.authorOrcid, undefined);
    assert.equal(changed.versions[0].authorOrcid, '0000-0002-1825-0097');
});

test('an entry that never had links gets no empty list', () => {
    const e = entry({ links: undefined });
    assert.equal(applyEntryEdit(e, { ...same, links: [], description: 'Changed' }), true);
    assert.equal(e.links, undefined);
});

test('removing the last link leaves an empty list', () => {
    const e = entry();
    assert.equal(applyEntryEdit(e, { ...same, links: [] }), true);
    assert.deepEqual(e.links, []);
    assert.deepEqual(e.versions[0].links, ['https://example.org/a']);
});
