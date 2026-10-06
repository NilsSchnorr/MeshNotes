// tests/share-dialog.test.js - Share dialog and Manual guard
// The Permanent share only builds a link from the URLs typed into the dialog,
// so its button must not wait for a loaded model. And the dialog's link into
// the Manual needs a place to open, in a chapter the PDF manual can pick up.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const html = read('index.html');
const count = (src, part) => src.split(part).length - 1;

function buttonTag(id) {
    const m = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(m, id);
    return m[0];
}

// The Manual chapter with the given title, from its opening tag up to the
// next chapter
function manualChapter(title) {
    const head = html.indexOf(`<span>${title}</span>`);
    assert.ok(head > 0, `chapter "${title}"`);
    const start = html.lastIndexOf('<div class="manual-item"', head);
    return html.slice(start, html.indexOf('<div class="manual-item"', head));
}

test('Generate Permanent Link is usable without a loaded model', () => {
    assert.doesNotMatch(buttonTag('longterm-generate-btn'), /\sdisabled\b/);
    // Nothing may tie the button to the model again
    assert.doesNotMatch(read('js/core/model-loader.js'), /longterm-generate-btn/);
});

test('Quick Share still waits for a loaded model', () => {
    assert.match(buttonTag('share-generate-btn'), /\sdisabled\b/);
    assert.match(read('js/core/model-loader.js'), /getElementById\('share-generate-btn'\)/);
});

test('the Share dialog link opens a place in the Sharing chapter', () => {
    const listeners = read('js/ui/event-listeners.js');
    const m = listeners.match(/getElementById\('longterm-manual-link'\)[\s\S]*?openManualItem\('([^']+)'\)/);
    assert.ok(m, 'listener of longterm-manual-link');
    assert.equal(count(html, 'id="longterm-manual-link"'), 1);
    assert.equal(count(html, `id="${m[1]}"`), 1);
    // openManualItem() expands the chapter around its target, so the target
    // has to sit inside one
    assert.equal(count(manualChapter('Sharing'), `id="${m[1]}"`), 1);
});

test('the Sharing chapter has both modes and stays readable for the PDF manual', () => {
    const chapter = manualChapter('Sharing');
    assert.match(chapter, /<h4[^>]*>Quick Share<\/h4>/);
    assert.match(chapter, /<h4[^>]*>Permanent Share<\/h4>/);
    // js/export/pdf-manual.js reads h4, p, ul and .limitation-note
    assert.doesNotMatch(chapter, /<(ol|pre|table|dl|h5)\b/);
    assert.equal(count(chapter, '<div'), count(chapter, '</div>'));
    // The one link form Zenodo serves to other websites, whatever the
    // placeholders for record and file are called
    assert.match(chapter, /https:\/\/zenodo\.org\/api\/records\/[^\s<"]+\/files\/[^\s<"]+\/content/);
});
