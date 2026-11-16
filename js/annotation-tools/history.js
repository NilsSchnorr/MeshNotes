// js/annotation-tools/history.js - Name and group history of annotations, its merge, and change times
// Pure: no Three.js, state or DOM, so it loads in Node tests.
//
// Change times (touchAnnotation, annotationTimes): an annotation stores when it
// was made (ann.created) and its latest change (ann.modified) beside the times
// its entries and its name and group history carry already; the export writes
// the latest of all of them as the W3C `modified` (annotation format section 5,
// erratum of 2026-11-16).
//
// An annotation keeps the values its name and group had before each change:
//   ann.nameVersions:  [{ value, savedAt, changedBy?, changedByOrcid? }]
//   ann.groupVersions: [{ groupUuid, groupName, savedAt, changedBy?, changedByOrcid? }]
// savedAt is when that value was replaced and changedBy who replaced it (the
// session's author name; changedByOrcid only when it came in with an imported
// file, otherwise the ORCID is resolved at export like an entry author's).
// The group is kept by uuid and by the name it had then, so the entry stays
// readable after the group is renamed or deleted. groupUuid and groupName are
// null for entries read from files written before MeshNotes 1.6.6, which held a
// session-internal group number that cannot be resolved.
//
// The time of the current value is the last savedAt; an annotation whose name
// or group never changed has none. A merge decides name and group each on its
// own by that time (mergeName, mergeGroup), independent of the entries.

// Milliseconds of an ISO timestamp, 0 when missing or unreadable.
function timeValue(s) {
    const t = typeof s === 'string' ? Date.parse(s) : NaN;
    return Number.isNaN(t) ? 0 : t;
}

const orNull = (v) => (typeof v === 'string' && v ? v : null);

// The optional changedBy members of a new history entry.
function changer(changedBy, changedByOrcid) {
    const out = {};
    if (typeof changedBy === 'string' && changedBy) out.changedBy = changedBy;
    if (typeof changedByOrcid === 'string' && changedByOrcid) out.changedByOrcid = changedByOrcid;
    return out;
}

// ISO timestamp from a Date, an ISO string or epoch milliseconds; now when absent.
function isoTime(now) {
    if (now instanceof Date) return now.toISOString();
    if (typeof now === 'string' && now) return now;
    if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString();
    return new Date().toISOString();
}

/**
 * Time of the latest change recorded in a history: the last savedAt, in
 * milliseconds. 0 when there is none (unchanged since creation).
 * @param {Array<{savedAt}>} [versions]
 * @returns {number}
 */
export function lastChangeTime(versions) {
    let t = 0;
    for (const v of versions || []) t = Math.max(t, timeValue(v && v.savedAt));
    return t;
}

// The entry of the latest change (the last savedAt), or null.
function latestEntry(versions) {
    let best = null;
    for (const v of versions || []) {
        if (v && (!best || timeValue(v.savedAt) > timeValue(best.savedAt))) best = v;
    }
    return best;
}

// ============ Recording a change ============

/**
 * Records the current name before a rename. Nothing happens when the name
 * stays the same.
 * @param {object} ann
 * @param {string} newName
 * @param {{now?, changedBy?: string, changedByOrcid?: string}} [options]
 * @returns {boolean} true when a history entry was added
 */
export function recordNameChange(ann, newName, { now, changedBy, changedByOrcid } = {}) {
    const oldName = ann.name || '';
    if (oldName === newName) return false;
    if (!ann.nameVersions) ann.nameVersions = [];
    ann.nameVersions.push({ value: oldName, savedAt: isoTime(now), ...changer(changedBy, changedByOrcid) });
    return true;
}

/**
 * The history entry for a group the annotation leaves: its uuid and its
 * name at that moment.
 * @param {object|null} group - the group left (null when unknown)
 * @param {string} savedAt
 * @param {{changedBy?, changedByOrcid?}} [by]
 */
export function groupVersionEntry(group, savedAt, { changedBy, changedByOrcid } = {}) {
    return {
        groupUuid: orNull(group && group.uuid),
        groupName: group && typeof group.name === 'string' ? group.name : null,
        savedAt,
        ...changer(changedBy, changedByOrcid)
    };
}

/**
 * Records the current group before the annotation moves to another one.
 * Nothing happens when the group stays the same.
 * @param {object} ann
 * @param {*} newGroupId - session id of the new group
 * @param {object[]} groups - state.groups, still holding the group left
 * @param {{now?, changedBy?: string, changedByOrcid?: string}} [options]
 * @returns {boolean} true when a history entry was added
 */
export function recordGroupChange(ann, newGroupId, groups, { now, changedBy, changedByOrcid } = {}) {
    if (ann.groupId === newGroupId) return false;
    const left = (groups || []).find(g => g.id === ann.groupId) || null;
    if (!ann.groupVersions) ann.groupVersions = [];
    ann.groupVersions.push(groupVersionEntry(left, isoTime(now), { changedBy, changedByOrcid }));
    return true;
}

// ============ Merge ============

const nameKey = (v) => `${v.savedAt}|${v.value}`;

// Union of two name histories, oldest first; an entry in both is kept once.
function uniteNameVersions(local, imported) {
    const out = (local || []).map(v => ({ ...v }));
    const keys = new Set(out.map(nameKey));
    for (const v of imported || []) {
        if (!v || keys.has(nameKey(v))) continue;
        keys.add(nameKey(v));
        out.push({ ...v });
    }
    return sortByTime(out);
}

const isUnknownGroup = (v) => !v.groupUuid && v.groupName === null;

// Union of two group histories, oldest first. An entry in both is kept once.
// An entry whose group is unknown (a file from before 1.6.6, or written by a
// version that dropped the group on re-export) is the same change as a known
// entry with the same savedAt: the known one stays.
function uniteGroupVersions(local, imported) {
    const out = (local || []).map(v => ({ ...v }));
    for (const v of imported || []) {
        if (!v) continue;
        const sameTime = out.filter(o => o.savedAt === v.savedAt);
        if (sameTime.some(o => o.groupUuid === v.groupUuid && o.groupName === v.groupName)) continue;
        if (isUnknownGroup(v) && sameTime.length > 0) continue;
        const unknown = sameTime.find(isUnknownGroup);
        if (unknown && !isUnknownGroup(v)) {
            out[out.indexOf(unknown)] = { ...v };
            continue;
        }
        out.push({ ...v });
    }
    return sortByTime(out);
}

function sortByTime(list) {
    return list
        .map((v, i) => ({ v, i }))
        .sort((a, b) => (timeValue(a.v.savedAt) - timeValue(b.v.savedAt)) || (a.i - b.i))
        .map(x => x.v);
}

/**
 * Who wins one field of an annotation held in both sessions: the copy whose
 * latest recorded change is newer; a tie keeps the local copy. When neither
 * copy records a change (files without history), the entries rule decides,
 * as it did before histories took part in the merge.
 * @returns {boolean} true when the imported copy wins
 */
export function importedFieldWins(localVersions, importedVersions, entriesNewer) {
    const tL = lastChangeTime(localVersions);
    const tI = lastChangeTime(importedVersions);
    if (tL === 0 && tI === 0) return !!entriesNewer;
    return tI > tL;
}

// The losing copy's value goes into the history, superseded at the time of
// the winning change and by its author, so no value is lost. Without a
// winning change on record (the entries rule decided), nothing is added.
function supersededAt(winnerVersions) {
    const last = latestEntry(winnerVersions);
    if (!last) return null;
    return { savedAt: last.savedAt, by: { changedBy: last.changedBy, changedByOrcid: last.changedByOrcid } };
}

/**
 * Merges the name of an annotation held in both sessions.
 * @param {{name, nameVersions?}} local
 * @param {{name, nameVersions?}} imported
 * @param {boolean} entriesNewer - the imported copy has the newer entries
 * @returns {{value: string, versions: object[], importedWins: boolean}}
 */
export function mergeName(local, imported, entriesNewer) {
    const importedWins = importedFieldWins(local.nameVersions, imported.nameVersions, entriesNewer);
    const versions = uniteNameVersions(local.nameVersions, imported.nameVersions);
    const value = importedWins ? imported.name : local.name;
    const loser = importedWins ? local.name : imported.name;
    const at = supersededAt(importedWins ? imported.nameVersions : local.nameVersions);
    if (loser !== value && at) {
        const entry = { value: loser || '', savedAt: at.savedAt, ...changer(at.by.changedBy, at.by.changedByOrcid) };
        if (!versions.some(v => nameKey(v) === nameKey(entry))) versions.push(entry);
    }
    return { value, versions: sortByTime(versions), importedWins };
}

/**
 * Merges the group of an annotation held in both sessions. Both group ids
 * are session ids of the merged session (the imported one already resolved
 * through the group map).
 * @param {{groupId, groupVersions?}} local
 * @param {{groupId, groupVersions?}} imported
 * @param {object[]} groups - state.groups after the group import
 * @param {boolean} entriesNewer
 * @returns {{value: *, versions: object[], importedWins: boolean}}
 */
export function mergeGroup(local, imported, groups, entriesNewer) {
    const importedWins = importedFieldWins(local.groupVersions, imported.groupVersions, entriesNewer);
    const versions = uniteGroupVersions(local.groupVersions, imported.groupVersions);
    const value = importedWins ? imported.groupId : local.groupId;
    const loser = importedWins ? local.groupId : imported.groupId;
    const at = supersededAt(importedWins ? imported.groupVersions : local.groupVersions);
    if (loser !== value && at) {
        const group = (groups || []).find(g => g.id === loser) || null;
        const entry = groupVersionEntry(group, at.savedAt, at.by);
        const united = uniteGroupVersions(versions, [entry]);
        return { value, versions: united, importedWins };
    }
    return { value, versions, importedWins };
}

// ============ Change times ============

/**
 * Records a change to an annotation: ann.modified becomes `now` unless it
 * already holds a later time. Used for changes that no entry and no name or
 * group history records: geometry, lock, surface projection, a deleted
 * entry, a survey point placed again by its alignment or detached from it.
 * @param {object} ann
 * @param {Date|string|number} [now] - when the change was made; now when absent
 */
export function touchAnnotation(ann, now) {
    if (!ann) return;
    const iso = isoTime(now);
    if (timeValue(iso) > timeValue(ann.modified)) ann.modified = iso;
}

/**
 * The later of two ISO times, the one that is set when only one is.
 * @param {string|undefined} a
 * @param {string|undefined} b
 * @returns {string|undefined}
 */
export function laterTime(a, b) {
    if (!timeValue(a)) return timeValue(b) ? b : undefined;
    if (!timeValue(b)) return a;
    return timeValue(b) > timeValue(a) ? b : a;
}

/**
 * The earlier of two ISO times, the one that is set when only one is.
 * @param {string|undefined} a
 * @param {string|undefined} b
 * @returns {string|undefined}
 */
export function earlierTime(a, b) {
    if (!timeValue(a)) return timeValue(b) ? b : undefined;
    if (!timeValue(b)) return a;
    return timeValue(b) < timeValue(a) ? b : a;
}

/**
 * When an annotation was made and last changed, for the export.
 * created: the stored ann.created; for annotations from before 1.6.6, the
 * oldest entry; undefined when neither is known.
 * modified: the latest of ann.modified, every entry's created and modified
 * time and the last change in the name and group history; undefined when it
 * is not later than created (nothing changed after creation).
 * @param {object} ann
 * @returns {{created: string|undefined, modified: string|undefined}}
 */
export function annotationTimes(ann) {
    const entries = (ann && ann.entries) || [];
    let created = timeValue(ann && ann.created) ? ann.created : undefined;
    if (!created) {
        for (const e of entries) created = earlierTime(created, e && e.timestamp);
    }
    let modified = timeValue(ann && ann.modified) ? ann.modified : undefined;
    for (const e of entries) {
        modified = laterTime(modified, e && e.timestamp);
        modified = laterTime(modified, e && e.modified);
    }
    const lastName = latestEntry(ann && ann.nameVersions);
    const lastGroup = latestEntry(ann && ann.groupVersions);
    modified = laterTime(modified, lastName && lastName.savedAt);
    modified = laterTime(modified, lastGroup && lastGroup.savedAt);
    if (modified && created && timeValue(modified) <= timeValue(created)) modified = undefined;
    return { created, modified };
}
