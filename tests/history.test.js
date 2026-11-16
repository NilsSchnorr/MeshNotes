// tests/history.test.js - Name and group history of annotations and its merge rules (js/annotation-tools/history.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    recordNameChange, recordGroupChange, lastChangeTime, importedFieldWins, mergeName, mergeGroup,
    touchAnnotation, annotationTimes, laterTime, earlierTime
} from '../js/annotation-tools/history.js';

const T1 = '2026-11-01T09:00:00.000Z';
const T2 = '2026-11-02T09:00:00.000Z';
const T3 = '2026-11-03T09:00:00.000Z';

const groups = [
    { id: 1, uuid: 'g1', name: 'Phase I' },
    { id: 2, uuid: 'g2', name: 'Phase II' }
];

test('a rename or a move records the value left, when and by whom; no change records nothing', () => {
    const ann = { name: 'Wall', groupId: 1 };
    assert.equal(recordNameChange(ann, 'Wall', { now: T2 }), false);
    assert.equal(recordGroupChange(ann, 1, groups, { now: T2 }), false);
    assert.equal('nameVersions' in ann || 'groupVersions' in ann, false);

    assert.equal(recordNameChange(ann, 'Wall 3', { now: T2, changedBy: 'Bob' }), true);
    assert.equal(recordGroupChange(ann, 2, groups, { now: T2, changedBy: 'Bob' }), true);
    assert.deepEqual(ann.nameVersions, [{ value: 'Wall', savedAt: T2, changedBy: 'Bob' }]);
    assert.deepEqual(ann.groupVersions, [{ groupUuid: 'g1', groupName: 'Phase I', savedAt: T2, changedBy: 'Bob' }]);

    // A group no longer known (and no author) gives an entry with nulls and no changedBy.
    const lost = { name: 'x', groupId: 99 };
    recordGroupChange(lost, 1, groups, { now: T3 });
    assert.deepEqual(lost.groupVersions, [{ groupUuid: null, groupName: null, savedAt: T3 }]);
});

test('the newer recorded change wins, a tie keeps the local copy, and without records the entries decide', () => {
    assert.equal(lastChangeTime(undefined), 0);
    assert.equal(lastChangeTime([{ savedAt: T1 }, { savedAt: T3 }, { savedAt: T2 }]), Date.parse(T3));
    assert.equal(importedFieldWins([], [], true), true);
    assert.equal(importedFieldWins([], [], false), false);
    assert.equal(importedFieldWins([{ savedAt: T2 }], [{ savedAt: T3 }], false), true);
    assert.equal(importedFieldWins([{ savedAt: T3 }], [{ savedAt: T2 }], true), false);
    assert.equal(importedFieldWins([{ savedAt: T2 }], [{ savedAt: T2 }], true), false);
    assert.equal(importedFieldWins([], [{ savedAt: T1 }], false), true);
});

test('two renames: the later one wins in both directions, and the other name is kept in the history', () => {
    const a = { name: 'Wall A', nameVersions: [{ value: 'Wall', savedAt: T2, changedBy: 'Alice' }] };
    const b = { name: 'Wall B', nameVersions: [{ value: 'Wall', savedAt: T3, changedBy: 'Bob' }] };
    const aImportsB = mergeName(a, b, false);
    const bImportsA = mergeName(b, a, true);
    assert.equal(aImportsB.value, 'Wall B');
    assert.equal(aImportsB.importedWins, true);
    assert.equal(bImportsA.value, 'Wall B');
    assert.equal(bImportsA.importedWins, false);
    const expected = [
        { value: 'Wall', savedAt: T2, changedBy: 'Alice' },
        { value: 'Wall', savedAt: T3, changedBy: 'Bob' },
        { value: 'Wall A', savedAt: T3, changedBy: 'Bob' }
    ];
    assert.deepEqual(aImportsB.versions, expected);
    assert.deepEqual(bImportsA.versions, expected);
    // Merging the result again changes nothing.
    const again = mergeName({ name: 'Wall B', nameVersions: expected }, b, false);
    assert.deepEqual(again.versions, expected);
    assert.equal(again.value, 'Wall B');
});

test('a rename on one side only wins over an unchanged copy, whatever the entries say', () => {
    const local = { name: 'Wall' };
    const imported = { name: 'Wall 3', nameVersions: [{ value: 'Wall', savedAt: T2 }] };
    const r = mergeName(local, imported, false);
    assert.equal(r.value, 'Wall 3');
    assert.deepEqual(r.versions, [{ value: 'Wall', savedAt: T2 }]);   // the loser is already recorded
});

test('without records on either side, the entries decide and no history is invented', () => {
    const r = mergeName({ name: 'Old' }, { name: 'New' }, true);
    assert.equal(r.value, 'New');
    assert.deepEqual(r.versions, []);
});

test('group: the later move wins; the losing group is kept by uuid and name at the winning time', () => {
    const local = { groupId: 1, groupVersions: [{ groupUuid: 'g2', groupName: 'Phase II', savedAt: T2, changedBy: 'Alice' }] };
    const imported = { groupId: 2, groupVersions: [{ groupUuid: 'g2', groupName: 'Phase II', savedAt: T2, changedBy: 'Alice' }, { groupUuid: 'g1', groupName: 'Phase I', savedAt: T3, changedBy: 'Bob' }] };
    const r = mergeGroup(local, imported, groups, false);
    assert.equal(r.value, 2);
    assert.deepEqual(r.versions, imported.groupVersions);   // the local value g1 is already the T3 entry
});

test('group history: an unknown entry (older file) and a known one at the same time are one change', () => {
    const known = [{ groupUuid: 'g1', groupName: 'Phase I', savedAt: T2 }];
    const unknown = [{ groupUuid: null, groupName: null, savedAt: T2 }];
    assert.deepEqual(mergeGroup({ groupId: 2, groupVersions: known }, { groupId: 2, groupVersions: unknown }, groups, false).versions, known);
    assert.deepEqual(mergeGroup({ groupId: 2, groupVersions: unknown }, { groupId: 2, groupVersions: known }, groups, false).versions, known);
});

// ---- Change times (annotation format section 5, erratum of 2026-11-16) ----

test('touchAnnotation keeps the later time', () => {
    const ann = {};
    touchAnnotation(ann, T2);
    assert.equal(ann.modified, T2);
    touchAnnotation(ann, T1);
    assert.equal(ann.modified, T2, 'an earlier change does not move modified back');
    touchAnnotation(ann, T3);
    assert.equal(ann.modified, T3);
    touchAnnotation(null, T3);   // no annotation: nothing happens
});

test('laterTime and earlierTime take the set value when only one is set', () => {
    assert.equal(laterTime(T1, T2), T2);
    assert.equal(laterTime(T2, undefined), T2);
    assert.equal(laterTime(undefined, T1), T1);
    assert.equal(laterTime(undefined, 'not a date'), undefined);
    assert.equal(earlierTime(T1, T2), T1);
    assert.equal(earlierTime(undefined, T2), T2);
});

test('annotationTimes: created stored or from the oldest entry; modified is the latest change of any kind', () => {
    const entry = (timestamp, modified) => ({ timestamp, ...(modified ? { modified } : {}) });
    // Before 1.6.6: no stored times; the entries give both, as the export did.
    assert.deepEqual(annotationTimes({ entries: [entry(T1), entry(T2)] }), { created: T1, modified: T2 });
    // Nothing changed after creation: no modified.
    assert.deepEqual(annotationTimes({ created: T1, entries: [entry(T1)] }), { created: T1, modified: undefined });
    // The oldest entry deleted: created stays.
    assert.deepEqual(annotationTimes({ created: T1, modified: T3, entries: [entry(T2)] }), { created: T1, modified: T3 });
    // No entry left: created stays, nothing is made up.
    assert.deepEqual(annotationTimes({ created: T1, entries: [] }), { created: T1, modified: undefined });
    assert.deepEqual(annotationTimes({ entries: [] }), { created: undefined, modified: undefined });
    // A rename or a move counts, through the history.
    assert.equal(annotationTimes({ created: T1, entries: [entry(T1)], nameVersions: [{ value: 'Old', savedAt: T2 }] }).modified, T2);
    assert.equal(annotationTimes({ created: T1, entries: [entry(T1)], groupVersions: [{ groupUuid: 'g1', groupName: 'A', savedAt: T3 }] }).modified, T3);
    // An entry edit counts.
    assert.equal(annotationTimes({ created: T1, entries: [entry(T1, T3)] }).modified, T3);
});
