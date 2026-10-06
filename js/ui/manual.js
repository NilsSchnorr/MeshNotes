// js/ui/manual.js - The Manual window: opening it at a place, and its text search
//
// The chapters of the Manual are collapsed blocks (.manual-item), and the
// browser's own find-in-page does not open them. The search field above the
// chapters does: it shows only the chapters that contain the search text,
// opens them and marks every match. Emptying the field puts the chapters back
// the way they were.
//
// Nothing here touches the document while the module loads, so findMatches()
// can be tested without a browser.

/** Shorter search texts are ignored: one letter matches nearly everywhere. */
export const MANUAL_SEARCH_MIN_LENGTH = 2;

const HIT_CLASS = 'manual-search-hit';
const CURRENT_CLASS = 'current';
const HIDDEN_CLASS = 'manual-search-hidden';
const INPUT_DELAY_MS = 120;

// Chapters and whether each was open before the search began; null while no
// search is showing its result
let savedExpanded = null;
// The <mark> elements of the current result, in reading order
let hits = [];
let currentHit = -1;
let inputTimer = null;

/**
 * Finds every occurrence of a search text in a piece of text, ignoring case.
 * The search text is taken literally, except that any run of white space in
 * it matches any run of white space (the Manual's text wraps in the HTML).
 * @param {string} text
 * @param {string} query
 * @returns {Array<[number, number]>} start and end offset of each match
 */
export function findMatches(text, query) {
    const q = (query || '').trim();
    if (q.length < MANUAL_SEARCH_MIN_LENGTH || !text) return [];
    const pattern = q.split(/\s+/)
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
    return [...text.matchAll(new RegExp(pattern, 'gi'))].map(m => [m.index, m.index + m[0].length]);
}

function searchElements() {
    return {
        content: document.getElementById('manual-modal-content'),
        input: document.getElementById('manual-search-input'),
        count: document.getElementById('manual-search-count'),
        prev: document.getElementById('manual-search-prev'),
        next: document.getElementById('manual-search-next')
    };
}

// What the search shows or hides as a whole: every chapter, and every section
// without chapters (Quick Start)
function searchBlocks(content) {
    const blocks = [];
    content.querySelectorAll('section').forEach(section => {
        const items = section.querySelectorAll('.manual-item');
        if (items.length > 0) blocks.push(...items);
        else blocks.push(section);
    });
    return blocks;
}

function setExpanded(item, expanded) {
    const header = item.querySelector('.manual-item-header');
    const content = item.querySelector('.manual-item-content');
    if (header) header.classList.toggle('expanded', expanded);
    if (content) content.classList.toggle('expanded', expanded);
}

function isExpanded(item) {
    const content = item.querySelector('.manual-item-content');
    return !!content && content.classList.contains('expanded');
}

// Wraps every match inside a block in a <mark>; returns how many there are.
// A match has to lie within one piece of text, so a search text that runs
// across a change of formatting (bold into plain) is not found.
function markMatches(block, query) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
        // The chapter's arrow is not text to search
        if (!walker.currentNode.parentElement.closest('.toggle-icon')) nodes.push(walker.currentNode);
    }
    let found = 0;
    for (const node of nodes) {
        const text = node.nodeValue;
        const matches = findMatches(text, query);
        if (matches.length === 0) continue;
        const pieces = document.createDocumentFragment();
        let position = 0;
        for (const [start, end] of matches) {
            if (start > position) pieces.append(text.slice(position, start));
            const mark = document.createElement('mark');
            mark.className = HIT_CLASS;
            mark.textContent = text.slice(start, end);
            pieces.append(mark);
            position = end;
        }
        if (position < text.length) pieces.append(text.slice(position));
        node.replaceWith(pieces);
        found += matches.length;
    }
    return found;
}

function removeMarks(content) {
    const marks = content.querySelectorAll(`mark.${HIT_CLASS}`);
    if (marks.length === 0) return;
    marks.forEach(mark => mark.replaceWith(mark.textContent));
    content.normalize();   // join the pieces of text again
}

// Shows every block again and gives the chapters back their state from
// before the search
function showAllChapters(content) {
    searchBlocks(content).forEach(block => {
        block.classList.remove(HIDDEN_CLASS);
        // Leave no empty class attribute behind on a block that had none
        if (block.getAttribute('class') === '') block.removeAttribute('class');
    });
    if (savedExpanded) {
        savedExpanded.forEach((expanded, item) => setExpanded(item, expanded));
        savedExpanded = null;
    }
}

function showCount(text, noMatch = false) {
    const { count, prev, next } = searchElements();
    count.textContent = text;
    count.classList.toggle('no-match', noMatch);
    prev.disabled = next.disabled = hits.length === 0;
}

function goToHit(index) {
    if (hits.length === 0) return;
    if (currentHit >= 0) hits[currentHit].classList.remove(CURRENT_CLASS);
    currentHit = (index + hits.length) % hits.length;
    hits[currentHit].classList.add(CURRENT_CLASS);
    hits[currentHit].scrollIntoView({ block: 'center' });
    showCount(`${currentHit + 1} of ${hits.length}`);
}

/**
 * Searches the Manual and shows the result: chapters without a match are
 * hidden, the others are opened and their matches marked, and the first
 * match is scrolled into view. A search text shorter than
 * MANUAL_SEARCH_MIN_LENGTH ends the search; a search text without any match
 * leaves all chapters in place.
 * @param {string} query
 * @returns {number} the number of matches
 */
export function searchManual(query) {
    const { content } = searchElements();
    removeMarks(content);
    hits = [];
    currentHit = -1;

    const active = (query || '').trim().length >= MANUAL_SEARCH_MIN_LENGTH;
    const blocks = searchBlocks(content);
    const found = active ? blocks.map(block => markMatches(block, query)) : [];
    const total = found.reduce((sum, n) => sum + n, 0);

    if (total === 0) {
        showAllChapters(content);
        showCount(active ? 'No matches' : '', active);
        return 0;
    }

    if (!savedExpanded) {
        savedExpanded = new Map();
        content.querySelectorAll('.manual-item').forEach(item => savedExpanded.set(item, isExpanded(item)));
    }
    blocks.forEach((block, i) => {
        block.classList.toggle(HIDDEN_CLASS, found[i] === 0);
        if (savedExpanded.has(block)) setExpanded(block, found[i] > 0 || savedExpanded.get(block));
    });

    hits = [...content.querySelectorAll(`mark.${HIT_CLASS}`)];
    goToHit(0);
    return total;
}

/** Empties the search field and shows the whole Manual again. */
export function clearManualSearch() {
    const { input } = searchElements();
    clearTimeout(inputTimer);
    if (input) input.value = '';
    searchManual('');
}

/**
 * Opens the Manual at one place: shows the Manual, expands the chapter the
 * target belongs to and scrolls the target to the top of the Manual window.
 * A search that is showing its result is ended first, because it could be
 * hiding that chapter.
 * @param {string} targetId - id of a chapter (.manual-item) or of an element
 *   inside one, e.g. a sub-headline
 */
export function openManualItem(targetId) {
    const target = document.getElementById(targetId);
    const item = target && target.closest('.manual-item');
    if (!item) return;
    clearManualSearch();
    // Visible and expanded first: a hidden element has no position to scroll to
    document.getElementById('manual-overlay').classList.add('visible');
    setExpanded(item, true);
    target.scrollIntoView({ block: 'start' });
}

/** Wires up the search field of the Manual. Called once at start-up. */
export function initManualSearch() {
    const { input, prev, next } = searchElements();
    const overlay = document.getElementById('manual-overlay');
    if (!input || !overlay) return;

    const searchNow = () => {
        clearTimeout(inputTimer);
        inputTimer = null;
        searchManual(input.value);
    };

    input.addEventListener('input', () => {
        clearTimeout(inputTimer);
        inputTimer = setTimeout(searchNow, INPUT_DELAY_MS);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (inputTimer) searchNow();                       // typed and pressed Enter at once
            else goToHit(currentHit + (e.shiftKey ? -1 : 1));
        } else if (e.key === 'Escape' && input.value) {
            // The first Escape empties the field; only the next one closes
            // the Manual (the general Escape handling on the document)
            e.stopPropagation();
            clearManualSearch();
        }
    });

    prev.addEventListener('click', () => goToHit(currentHit - 1));
    next.addEventListener('click', () => goToHit(currentHit + 1));

    // Ctrl+F / Cmd+F with the Manual open goes to this field, because the
    // browser's own search does not open the chapters. Pressed again with the
    // field focused, it reaches the browser as usual.
    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key || '').toLowerCase() !== 'f') return;
        if (!overlay.classList.contains('visible') || document.activeElement === input) return;
        e.preventDefault();
        input.focus();
        input.select();
    });
}
