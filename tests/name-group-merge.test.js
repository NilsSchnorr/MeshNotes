// tests/name-group-merge.test.js - Name and group of annotations, and groups, through export and merge
// (drives buildAnnotationJSON and mergeW3CCollection like tests/import-json.test.js, without a DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/app-env.js';
import { plainAnnotation, group } from './support/survey-samples.js';
import { recordNameChange, recordGroupChange } from '../js/annotation-tools/history.js';

const { state } = await import('../js/state.js');
const { buildAnnotationJSON } = await import('../js/export/export-json.js');
const { mergeW3CCollection } = await import('../js/export/import-json.js');

const T1 = '2026-11-01T09:00:00.000Z';
const T2 = '2026-11-02T09:00:00.000Z';
const T3 = '2026-11-03T09:00:00.000Z';
const T4 = '2026-11-04T09:00:00.000Z';
const clone = (v) => structuredClone(v);

function setSession({ groups, annotations }) {
    state.modelFileName = 'wall.glb';
    state.modelHash = 'abc123';
    state.modelFrameOrigin = null;
    state.modelInfo = { entries: [], metadata: null };
    state.groups = groups;
    state.annotations = annotations;
    state.alignments = [];
    state.defaultAlignmentId = null;
}

// The JSON-LD the session would export (the session is left in state).
function exportSession(session) {
    setSession(clone(session));
    return JSON.parse(buildAnnotationJSON());
}

// Imports a file into a fresh copy of a session; returns the merge result.
function importInto(session, file) {
    setSession(clone(session));
    return mergeW3CCollection(clone(file));
}

const wall = () => state.annotations.find(a => a.uuid === 'w3');
const wallOf = (session) => session.annotations.find(a => a.uuid === 'w3');
const groupUuid = () => state.groups.find(g => g.id === wall().groupId).uuid;

// Both sessions start from the same file: "Wall 3" in Phase I.
function base() {
    const ann = plainAnnotation({ id: 10, uuid: 'w3', groupId: 1, entryTime: T1 });
    ann.name = 'Wall 3';
    return { groups: [group(1, 'g1', 'Phase I'), group(2, 'g2', 'Phase II')], annotations: [ann] };
}

test('a move to another group reaches the other session, whoever imports whose file', () => {
    const a = base();
    const b = base();
    recordGroupChange(wallOf(b), 2, b.groups, { now: T2, changedBy: 'Bob' });
    wallOf(b).groupId = 2;
    const fileA = exportSession(a);
    const fileB = exportSession(b);

    // The file names the group left by uuid and name, with time and author.
    assert.deepEqual(fileB.first.items[0]['meshnotes:groupVersions'], [{
        'meshnotes:groupUuid': 'g1', 'meshnotes:groupName': 'Phase I', 'meshnotes:savedAt': T2,
        'meshnotes:changedBy': { type: 'Person', name: 'Bob' }
    }]);

    const r1 = importInto(a, fileB);
    assert.equal(groupUuid(), 'g2');
    assert.equal(r1.merged, 1);
    const historyInA = clone(wall().groupVersions);

    const r2 = importInto(b, fileA);
    assert.equal(groupUuid(), 'g2');
    assert.equal(r2.unchanged, 1);
    assert.deepEqual(wall().groupVersions, historyInA);

    // A newer entry in A's copy no longer undoes B's move (before 1.6.6 it did).
    const a2 = base();
    wallOf(a2).entries.push({ id: 99, uuid: 'w3-e2', description: 'Later note', author: 'Alice', timestamp: T3, links: [] });
    const fileA2 = exportSession(a2);
    importInto(b, fileA2);
    assert.equal(groupUuid(), 'g2');
    assert.equal(wall().entries.length, 2);
});

test('two renames: both sessions end with the later name, and the other name is kept', () => {
    const a = base();
    const b = base();
    recordNameChange(wallOf(a), 'Wall 3 (north)', { now: T2, changedBy: 'Alice' });
    wallOf(a).name = 'Wall 3 (north)';
    recordNameChange(wallOf(b), 'Wall 3a', { now: T3, changedBy: 'Bob' });
    wallOf(b).name = 'Wall 3a';
    const fileA = exportSession(a);
    const fileB = exportSession(b);

    importInto(a, fileB);
    const inA = clone(wall());
    importInto(b, fileA);
    const inB = clone(wall());
    assert.equal(inA.name, 'Wall 3a');
    assert.equal(inB.name, 'Wall 3a');
    assert.deepEqual(inA.nameVersions, inB.nameVersions);
    assert.deepEqual(inA.nameVersions.map(v => [v.value, v.savedAt, v.changedBy]), [
        ['Wall 3', T2, 'Alice'], ['Wall 3', T3, 'Bob'], ['Wall 3 (north)', T3, 'Bob']
    ]);

    // Exchanging the merged files again changes nothing.
    setSession({ groups: clone(a.groups), annotations: [clone(inA)] });
    const mergedA = JSON.parse(buildAnnotationJSON());
    importInto({ groups: clone(b.groups), annotations: [clone(inB)] }, mergedA);
    assert.deepEqual(wall().nameVersions, inB.nameVersions);
    assert.equal(wall().name, 'Wall 3a');
});

test('a group renamed and recoloured in one session reaches the other; visibility stays local', () => {
    const a = base();
    const b = base();
    Object.assign(b.groups[0], { name: 'Phase 1', color: '#ff0000', modified: T2, visible: false });
    const fileB = exportSession(b);
    assert.equal(fileB['meshnotes:groups'][0].id, 'urn:meshnotes:group:g1');
    assert.equal(fileB['meshnotes:groups'][0].modified, T2);
    assert.equal('modified' in fileB['meshnotes:groups'][1], false);

    importInto(a, fileB);
    const g1 = state.groups.find(g => g.uuid === 'g1');
    assert.deepEqual([g1.name, g1.color, g1.modified, g1.visible], ['Phase 1', '#ff0000', T2, true]);

    // The other way round, the unchanged copy does not undo the rename.
    const fileA = exportSession(a);
    importInto(b, fileA);
    const g1b = state.groups.find(g => g.uuid === 'g1');
    assert.deepEqual([g1b.name, g1b.color, g1b.visible], ['Phase 1', '#ff0000', false]);

    // A later local edit wins over an older one in the file.
    const c = base();
    Object.assign(c.groups[0], { name: 'Phase One', modified: T4 });
    importInto(c, fileB);
    assert.equal(state.groups.find(g => g.uuid === 'g1').name, 'Phase One');
});

test('a group history from before 1.6.6 reads as moves from an unknown group and is written without groupId', () => {
    const old = exportSession(base());
    old['meshnotes:groups'][0].id = 1;                       // numeric ids, as written before 1.6.6
    old['meshnotes:groups'][1].id = 2;
    old.first.items[0]['meshnotes:groupVersions'] = [{ groupId: 7, 'meshnotes:savedAt': T2 }];
    setSession({ groups: [], annotations: [] });
    mergeW3CCollection(clone(old));
    assert.deepEqual(wall().groupVersions, [{ groupUuid: null, groupName: null, savedAt: T2 }]);
    assert.equal(groupUuid(), 'g1');
    const again = JSON.parse(buildAnnotationJSON());
    assert.deepEqual(again.first.items[0]['meshnotes:groupVersions'], [{ 'meshnotes:savedAt': T2 }]);
});
