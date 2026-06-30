// js/core/session-persistence.js
// Automatic crash / eviction recovery for in-progress annotation work.
//
// MeshNotes keeps the working set (annotations, groups, model info, metadata)
// in memory. On iPadOS in particular, Safari and home-screen web apps are
// discarded from memory when backgrounded under memory pressure and reloaded
// from scratch on return — silently, giving the user no chance to export. This
// module writes the working set to IndexedDB at the moment the app is hidden
// (the reliable pre-discard hook on iOS) and offers to restore it when the same
// model is reopened.
//
// The mesh itself is never stored (too large for browser storage, and it lives
// as a local file the user simply reopens); the SHA-256 model hash reunites the
// restored annotations with the reopened model.
//
// Everything rides on the existing export/import code, so the saved blob is a
// standard v1 JSON-LD AnnotationCollection — no new format and no new
// coordinate handling (export writes Z-up, import transforms back; the
// round-trip is identity).

import { state, APP_VERSION } from '../state.js';
import { buildAnnotationJSON } from '../export/export-json.js';
import { importAnnotations } from '../export/import-json.js';
import { parseUrlParams } from './url-params.js';
import { showStatus } from '../utils/helpers.js';

// ---- IndexedDB (single store, single "current session" slot) ----------------
// localStorage is unsuitable here: surface annotations serialize to large
// meshnotes:faces arrays that can exceed its ~5 MB quota. IndexedDB is
// disk-backed (so it survives a memory-pressure tab discard) and, in a
// home-screen PWA, exempt from Safari's idle-eviction window.
const DB_NAME = 'meshnotes';
const STORE = 'session';
const SLOT = 'current';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function idbDelete(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

// ---- Helpers ----------------------------------------------------------------

// Autosave is scoped to normal local editing. Share / direct-link views are
// online by definition and load their annotations from the link, so there is
// nothing to crash-recover there.
function isLocalSession() {
    try { return parseUrlParams().mode === 'local'; } catch (e) { return true; }
}

// Is there in-progress work worth protecting?
function hasWork() {
    if (state.annotations.length > 0) return true;
    if (state.modelInfo && state.modelInfo.entries && state.modelInfo.entries.length > 0) return true;
    const md = state.modelInfo && state.modelInfo.metadata;
    if (md && md.sections) {
        for (const s of md.sections) {
            for (const f of (s.fields || [])) if (f.value && String(f.value).trim()) return true;
            for (const f of (s.customFields || [])) if (f.value && String(f.value).trim()) return true;
        }
    }
    return false;
}

// A cheap structural + content fingerprint so the idle interval can skip
// serializing when nothing has changed since the last save. Catches add/remove
// of annotations, entries, and groups, plus in-place text edits (via length
// sums) without building the full JSON. Anything it misses is still captured by
// the on-hide flush.
function workSignature() {
    let entries = 0, textLen = 0;
    for (const a of state.annotations) {
        entries += a.entries ? a.entries.length : 0;
        if (a.entries) {
            for (const e of a.entries) textLen += (e.description ? e.description.length : 0);
        }
        textLen += a.name ? a.name.length : 0;
    }
    const mi = (state.modelInfo && state.modelInfo.entries) ? state.modelInfo.entries.length : 0;
    return [state.annotations.length, state.groups.length, entries, mi, textLen].join(':');
}

let _lastSavedSignature = null;
let _saving = false;

// ---- Save -------------------------------------------------------------------

async function flush() {
    if (_saving) return;
    if (!isLocalSession()) return;
    if (!state.modelHash) return;   // need the hash to bind / restore reliably
    if (!hasWork()) return;
    _saving = true;
    try {
        const jsonld = buildAnnotationJSON();
        await idbSet(SLOT, {
            schema: 1,
            savedAt: new Date().toISOString(),
            appVersion: APP_VERSION,
            modelHash: state.modelHash,
            modelFileName: state.modelFileName || '',
            annotationCount: state.annotations.length,
            jsonld
        });
        _lastSavedSignature = workSignature();
    } catch (e) {
        console.warn('Session autosave failed:', e);
    } finally {
        _saving = false;
    }
}

// Idle-time insurance that bounds loss if a hide event is ever missed
// mid-session. Skips while a tool interaction is in progress (so a large model
// is never serialized mid-stroke) and when nothing changed since the last save.
function flushIfIdle() {
    if (state.isPaintingSurface || state.isDraggingPoint || state.isManipulatingBox || state.isBoxPlacementMode) return;
    if (!hasWork()) return;
    if (workSignature() === _lastSavedSignature) return;
    flush();
}

// ---- Restore ----------------------------------------------------------------

// Fired (via model-loader's hash-ready hook) once a reopened model's hash is
// known. Offers to restore an autosaved session bound to this exact model — but
// only into a fresh workspace. If annotations are already present, nothing was
// lost, so we stay silent.
export async function maybeOfferRestore() {
    if (!isLocalSession()) return;
    if (!state.modelHash) return;
    if (state.annotations.length > 0) return;

    let rec = null;
    try { rec = await idbGet(SLOT); } catch (e) { return; }
    if (!rec || rec.modelHash !== state.modelHash) return;

    const ok = confirm(
        'Restore your last unsaved session for this model?\n\n' +
        'MeshNotes automatically saved your annotations before the app last ' +
        'closed. Click OK to restore them, or Cancel to start fresh.'
    );
    if (!ok) return; // keep the slot — a later reload can still recover it

    try {
        const blob = new Blob([rec.jsonld], { type: 'application/ld+json' });
        importAnnotations(blob, () => {
            showStatus('Session restored');
        });
        // Restored into the workspace; the next hide re-saves the live state.
        await idbDelete(SLOT);
        _lastSavedSignature = null;
    } catch (e) {
        console.warn('Session restore failed:', e);
    }
}

// Called after a successful manual JSON-LD export: the work is now safely in
// the user's hands, so the crash-recovery copy should not prompt later.
export async function clearSavedSession() {
    try {
        await idbDelete(SLOT);
        _lastSavedSignature = null;
    } catch (e) {
        /* ignore */
    }
}

// ---- Init -------------------------------------------------------------------

export function initSessionPersistence() {
    if (!('indexedDB' in window)) return; // no storage available — feature simply absent

    // Primary save: the moment before iOS can discard a backgrounded app.
    // visibilitychange -> hidden is the reliable pre-discard hook on iOS
    // (beforeunload is not), and pagehide is the belt-and-suspenders companion.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', () => { flush(); });

    // Insurance against a missed hide event mid-session.
    setInterval(flushIfIdle, 30000);
}
