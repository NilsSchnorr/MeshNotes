// js/export/import-json.js - W3C and legacy annotation import with merge support
import { state } from '../state.js';
import { generateUUID, generateInternalId, showStatus, sessionHasWork } from '../utils/helpers.js';
import { convertFromW3CAnnotation, pointFromZUp, creatorToAuthor, normalizeLinks } from './w3c-format.js';
import { mergeName, mergeGroup, laterTime, earlierTime } from '../annotation-tools/history.js';
import { normalizeSurfaceFaces, FACE_ORDER, FACE_ORDER_FILE } from '../annotation-tools/face-order.js';
import { updateModelInfoDisplay } from '../annotation-tools/data.js';
import { updateMetadataDisplay } from '../metadata/metadata-ui.js';
import { normalizeMetadata } from '../metadata/templates.js';
import { updateGroupsList } from '../annotation-tools/groups.js';
import { renderAnnotations } from '../annotation-tools/render.js';
import { reprojectAllAnnotations } from '../annotation-tools/projection.js';
import {
    alignmentsFromJsonLd, mergeAlignments, resolveAlignmentRef,
    surveyPointMergeSource, manualPlacementMergeRule, planRefinePlacement, MERGE_SOURCE
} from '../survey/alignment.js';
import {
    applyReplacement, applyReplacementChunked, replacementSummary, SURFACE_CHUNK_SIZE
} from '../survey/survey-import.js';

export function importAnnotations(file, onComplete) {
    const reader = new FileReader();
    reader.onload = (e) => {
        let data;
        try {
            data = JSON.parse(e.target.result);
        } catch (error) {
            console.error('Import error:', error);
            showStatus('Error importing file');
            if (typeof onComplete === 'function') onComplete({ viewState: null });
            return;
        }
        importAnnotationData(data, onComplete);
    };
    reader.readAsText(file);
}

/**
 * Imports an already parsed annotation file (W3C collection or legacy
 * format); importAnnotations() after reading the file. Used directly where
 * the file was parsed first, e.g. for the up-axis check of a manual import.
 * @param {Object} data - the parsed JSON
 * @param {Function} [onComplete] - called with { viewState }
 */
export function importAnnotationData(data, onComplete) {
    let viewState = null;
    try {
        // Check if this is W3C format (has @context and type: AnnotationCollection)
        if (data['@context'] && data.type === 'AnnotationCollection') {
            importW3CAnnotations(data);
            // Surface any "see what I see" snapshot to the caller. Only the
            // share/direct load path acts on it; manual import ignores it.
            viewState = data['meshnotes:viewState'] || null;
        }
        // Legacy format support (old MeshNotes format)
        else if (data.groups && data.annotations) {
            importLegacyAnnotations(data);
        }
        else {
            showStatus('Invalid annotation file format');
        }
    } catch (error) {
        console.error('Import error:', error);
        showStatus('Error importing file');
    }
    if (typeof onComplete === 'function') onComplete({ viewState });
}

// ============ Stored up-axis ============

function normaliseUpAxis(value) {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return v === 'y-up' || v === 'z-up' ? v : null;
}

/**
 * The up-axis the model was loaded with when the annotation file was made:
 * 'y-up' or 'z-up', from modelSource's meshnotes:modelUpAxis (MeshNotes 1.6.6
 * and later). Older files fall back to the one their survey alignments
 * recorded (the default alignment first). null when the file does not say;
 * the caller then keeps its own default.
 * @param {Object} data - a parsed AnnotationCollection
 * @returns {'y-up'|'z-up'|null}
 */
export function storedModelUpAxis(data) {
    if (!data || typeof data !== 'object') return null;
    const fromSource = normaliseUpAxis(data.modelSource && data.modelSource['meshnotes:modelUpAxis']);
    if (fromSource) return fromSource;
    const alignments = Array.isArray(data['meshnotes:alignments']) ? data['meshnotes:alignments'] : [];
    const def = data['meshnotes:defaultAlignment'];
    const defId = typeof def === 'string' ? def : (def && (def.id || def['@id']));
    const ordered = [
        ...alignments.filter(a => a && a.id === defId),
        ...alignments.filter(a => a && a.id !== defId)
    ];
    for (const a of ordered) {
        const axis = normaliseUpAxis(a['meshnotes:modelUpAxis']);
        if (axis) return axis;
    }
    return null;
}

/**
 * storedModelUpAxis() of an annotation file or blob not read yet; null when
 * it cannot be read or parsed (the import itself reports that).
 * @param {Blob} file
 * @returns {Promise<'y-up'|'z-up'|null>}
 */
export async function readStoredUpAxis(file) {
    try {
        return storedModelUpAxis(JSON.parse(await file.text()));
    } catch (e) {
        return null;
    }
}

/**
 * Imports a W3C Web Annotation Collection with intelligent merge support:
 * merges it into the session (mergeW3CCollection), moves the survey points
 * that the alignment merge left at the losing fit (decisions 2 and 5), then
 * refreshes the sidebar and the scene and reports the result in the status line.
 *
 * The move snaps each point to the surface. Up to SURFACE_CHUNK_SIZE points
 * move synchronously, before this function returns; more run in chunks per
 * frame after it has returned (result.replacement is then a Promise), and
 * the sidebar, scene and status line refresh again when they are done (a
 * point changed meanwhile, e.g. by a second import, keeps the newer state:
 * see applyReplacementChunked). The importAnnotations() callers do not depend on that: autosave restores and
 * share loads start from an empty session, so nothing is replaced or kept
 * and nothing moves, and a manual import passes no callback. No other
 * import path moves or snaps points.
 * @param {Object} data - Parsed W3C AnnotationCollection JSON-LD
 * @returns {Object} the mergeW3CCollection() result, plus `replacement`: the
 *   applyReplacement() figures, a Promise of them for a chunked run, or
 *   null when no point had to move
 */
function importW3CAnnotations(data) {
    const result = mergeW3CCollection(data);

    // Fit points follow the alignment that won the merge.
    const { moves, alignmentCount, chunked } = importReplacementPlan(result);
    result.replacement = null;
    if (moves.length > 0 && !chunked) result.replacement = applyReplacement({ moves });

    // Re-project imported annotations onto current model surface
    reprojectAllAnnotations();

    updateGroupsList();
    renderAnnotations();

    if (!chunked) {
        showStatus(importStatusText(result, replacementSummary(result.replacement, { alignmentCount })));
        return result;
    }

    // The first chunk runs at once, so its progress line is the first one shown.
    const session = state.annotations;
    result.replacement = applyReplacementChunked({ moves }, {
        onProgress: (done, total) => showStatus(`Moving survey points to the newer alignment: ${done} of ${total}`)
    }).then(stats => {
        // Loading another model clears the session at once but replaces
        // state.currentModel only after parsing, so the run can end after
        // the clear: none of its points is left, nothing to refresh or report.
        if (state.annotations !== session && !moves.some(m => state.annotations.includes(m.annotation))) return stats;
        updateGroupsList();
        renderAnnotations();
        showStatus(importStatusText(result, replacementSummary(stats, { alignmentCount })));
        return stats;
    }).catch(error => {
        // An AbortError means the new model replaced the old one between two
        // chunks; its session was cleared before that, nothing left to report.
        console.warn('Import: survey points not moved:', error);
        if (!error || error.name !== 'AbortError') {
            showStatus(importStatusText(result, 'survey points not moved to the newer alignment'));
        }
        return null;
    });
    return result;
}

/**
 * The survey point moves an import runs after mergeW3CCollection (decisions
 * 2 and 5) and whether they run in chunks (more than SURFACE_CHUNK_SIZE).
 * @param {Object} result - a mergeW3CCollection() result
 * @returns {{moves: Object[], alignmentCount: number, chunked: boolean}}
 *   alignmentCount = alignments with at least one point to move
 */
export function importReplacementPlan(result) {
    const moves = realignMoves(result.realign);
    return {
        moves,
        alignmentCount: result.realign.filter(r => r.plan.count > 0).length,
        chunked: moves.length > SURFACE_CHUNK_SIZE
    };
}

/**
 * Import status line, e.g. 'Import: 2 added, 1 alignment updated, 3 survey
 * points moved to the newer alignment (largest 0.042 m)'.
 * @param {Object} result - a mergeW3CCollection() result
 * @param {string} [extra] - appended part (replacementSummary()), '' for none
 * @returns {string}
 */
export function importStatusText(result, extra = '') {
    const parts = [];
    if (result.added > 0) parts.push(`${result.added} added`);
    if (result.merged > 0) parts.push(`${result.merged} merged`);
    if (result.unchanged > 0) parts.push(`${result.unchanged} unchanged`);
    const alignmentPart = (n, verb) => {
        if (n > 0) parts.push(`${n} alignment${n !== 1 ? 's' : ''} ${verb}`);
    };
    alignmentPart(result.alignments.added.length, 'added');
    alignmentPart(result.alignments.replaced.length, 'updated');
    const unchecked = (result.surfaceFaces && result.surfaceFaces.unchecked) || 0;
    if (unchecked > 0) {
        parts.push(`${unchecked} surface region${unchecked !== 1 ? 's' : ''} could not be checked on this device`);
    }
    if (extra) parts.push(extra);
    return `Import: ${parts.join(', ') || 'nothing to import'}`;
}

/**
 * Merges a W3C Web Annotation Collection into the session state.
 * Uses UUID-based duplicate detection: existing annotations are updated
 * (entries merged by UUID, newer timestamps win; name and group each follow
 * the newer recorded change, see history.js), new annotations are added.
 * Also imports groups, survey alignments and model info with the same merge
 * strategy. The sidebar, scene and status refresh is left to the caller
 * (importW3CAnnotations); the model-info and metadata panels still refresh
 * here when the file carries them.
 * @param {Object} data - Parsed W3C AnnotationCollection JSON-LD
 * Surface face numbers are brought into file order before the merge
 * (normalizeSurfaceFaces() in face-order.js): a file whose modelSource says
 * meshnotes:faceOrder "file" is taken as it is, older files are checked
 * region by region against the loaded model.
 * @returns {{added: number, merged: number, unchanged: number,
 *            alignments: {added: string[], replaced: string[], kept: string[], skipped: number},
 *            realign: Array<{uuid: string, kind: 'replaced'|'kept', previous: Object, alignment: Object, plan: Object}>,
 *            surfaceFaces: {converted: number, unchecked: number}}}
 *   surfaceFaces: surface regions of the file renumbered from the order of
 *   MeshNotes before 1.6.6, and regions that could not be checked.
 *   alignments: uuid lists from mergeAlignments(), skipped = unusable alignment
 *   nodes. realign: survey points left at the fit of the alignment copy that
 *   lost the merge, per alignment whose two copies hold different fits, as
 *   planRefinePlacement(points, previous, alignment): plan.moves = points with
 *   placement 'fit' (from = old fitted position, to = new one, storage
 *   coordinates, not snapped), plan.manual = hand-moved points (never moved).
 *   kind 'replaced' (decision 2): the file's copy was newer; the points are
 *   those that kept their local position (held only in this session, or held
 *   on both sides with the local copy winning through the entries rule and
 *   neither copy hand-moved); previous = the local alignment before the
 *   import. kind 'kept' (decision 5): the local copy won; the points are
 *   those placed from the file (new ones, or held on both sides with the
 *   imported copy winning and neither copy hand-moved); previous = the
 *   file's copy under the local id. alignment = the winner in
 *   state.alignments. Nothing is moved here: importW3CAnnotations() applies
 *   the plans (realignMoves() + applyReplacement() in survey-import.js).
 */
export function mergeW3CCollection(data) {
    // Import W3C Web Annotation Collection format with merge support
    // A file imported into a session without work continues the file's
    // record: the session takes its collection id (annotation format section
    // 3). Into a session with work, the session keeps its own record.
    const startsRecord = !sessionHasWork();
    const groupIdMap = {};
    let addedCount = 0;
    let mergedCount = 0;
    let skippedCount = 0;

    // Detect coordinate system of imported file
    // Files with upAxis 'Z' (or 'z') contain Z-up coordinates that need
    // transformation to Three.js Y-up space.
    const importedUpAxis = ((data.modelSource && data.modelSource.upAxis) || data['upAxis'] || data['meshnotes:upAxis'] || '').toString().toUpperCase();
    // upAxis is only a SHOULD-level member, but v1 selector coordinates are
    // normatively Z-up ([SEL] §3) — so when it is absent, a declared v1
    // conformance or the presence of modern meshnotes:* selectors implies
    // Z-up. Only files explicitly marked otherwise, or true legacy files
    // with neither marker, are treated as already Y-up.
    const conformsToV1 = (data['dcterms:conformsTo'] || '').toString().includes('meshnotes.org/spec/annotation/v1');
    const hasV1Selectors = !!(data.first && Array.isArray(data.first.items) && data.first.items.some(a => {
        const sel = a && a.target && a.target.selector;
        return sel && typeof sel.type === 'string' && sel.type.indexOf('meshnotes:') === 0;
    }));
    const needsTransform = (importedUpAxis === 'Z') || (importedUpAxis === '' && (conformsToV1 || hasV1Selectors));

    // Surface face numbers: files from 1.6.6 on declare file order; older
    // files are checked region by region (face-order.js).
    const facesDeclared = !!(data.modelSource && data.modelSource['meshnotes:faceOrder'] === FACE_ORDER_FILE);
    const surfaceFaces = { converted: 0, unchecked: 0 };

    // Helper: transform all coordinates in an annotation from Z-up to Three.js Y-up
    function transformAnnotationCoords(ann) {
        if (!needsTransform) return;
        ann.points = ann.points.map(p => pointFromZUp(p));
        // Also transform box center for box annotations
        if (ann.boxData && ann.boxData.center) {
            ann.boxData.center = pointFromZUp(ann.boxData.center);
        }
    }

    // Helper: get effective timestamp for an entry (modified or created)
    function entryTimestamp(entry) {
        return entry.modified || entry.timestamp || entry.created || '';
    }

    // Helper: merge version histories, avoiding duplicates by savedAt timestamp
    function mergeVersionHistories(existingVersions, importedVersions) {
        if (!importedVersions || importedVersions.length === 0) return;
        if (!existingVersions) existingVersions = [];
        
        const existingTimestamps = new Set(existingVersions.map(v => v.savedAt));
        
        importedVersions.forEach(importedVersion => {
            // Only add if we don't have a version with this exact timestamp
            if (!existingTimestamps.has(importedVersion.savedAt)) {
                existingVersions.push({ ...importedVersion });
                existingTimestamps.add(importedVersion.savedAt);
            }
        });
        
        // Sort versions chronologically
        existingVersions.sort((a, b) => (a.savedAt || '').localeCompare(b.savedAt || ''));
        
        return existingVersions;
    }

    // Helper: merge entries from imported annotation into existing annotation
    function mergeEntries(existingEntries, importedEntries) {
        let entriesAdded = 0;
        let entriesUpdated = 0;

        importedEntries.forEach(importedEntry => {
            // Match by UUID first, then fall back to content match
            // (content match handles old exports without entry UUIDs)
            let existingEntry = existingEntries.find(e => e.uuid === importedEntry.uuid);
            if (!existingEntry) {
                existingEntry = existingEntries.find(e =>
                    e.description === importedEntry.description &&
                    e.author === importedEntry.author &&
                    e.timestamp === importedEntry.timestamp
                );
            }

            if (!existingEntry) {
                // New entry - add it (including any version history)
                existingEntries.push(importedEntry);
                entriesAdded++;
            } else {
                // Existing entry - merge version histories first
                if (importedEntry.versions && importedEntry.versions.length > 0) {
                    if (!existingEntry.versions) existingEntry.versions = [];
                    mergeVersionHistories(existingEntry.versions, importedEntry.versions);
                }
                
                // Check if imported version is newer
                const existingTime = entryTimestamp(existingEntry);
                const importedTime = entryTimestamp(importedEntry);

                if (importedTime > existingTime) {
                    // Imported version is newer - update content
                    existingEntry.description = importedEntry.description;
                    // The language travels with the text it tags.
                    existingEntry.language = importedEntry.language;
                    existingEntry.author = importedEntry.author;
                    // The ORCID follows the author as a pair — keeping the old
                    // identifier with a new name would misattribute it.
                    existingEntry.authorOrcid = importedEntry.authorOrcid;
                    existingEntry.modified = importedEntry.modified;
                    existingEntry.links = importedEntry.links || [];
                    entriesUpdated++;
                }
                // else: local version is same or newer, skip content update
                // (but version histories were still merged above)
            }
        });

        // Sort entries chronologically
        existingEntries.sort((a, b) => {
            const timeA = a.timestamp || '';
            const timeB = b.timestamp || '';
            return timeA.localeCompare(timeB);
        });

        return { entriesAdded, entriesUpdated };
    }

    // Merge model info entries
    const importedModelInfo = data['modelInfo'] || data['meshnotes:modelInfo'];
    if (importedModelInfo && importedModelInfo.body) {
        const bodies = Array.isArray(importedModelInfo.body)
            ? importedModelInfo.body
            : [importedModelInfo.body];

        const importedEntries = bodies.map((body) => {
            const { name: miAuthor, orcid: miAuthorOrcid } = creatorToAuthor(body.creator);
            const entry = {
                id: generateInternalId(),
                uuid: body['meshnotes:entryUuid'] || generateUUID(),
                description: body.value || '',
                author: miAuthor,
                authorOrcid: miAuthorOrcid,
                timestamp: body.created || new Date().toISOString(),
                modified: body.modified || undefined,
                language: body.language || undefined,
                links: normalizeLinks(body['schema:url'])
            };
            
            // Include version history if present
            if (body['meshnotes:versions'] && body['meshnotes:versions'].length > 0) {
                entry.versions = body['meshnotes:versions'].map(v => ({
                    description: v.value || '',
                    author: creatorToAuthor(v.creator).name,
                    authorOrcid: creatorToAuthor(v.creator).orcid,
                    links: normalizeLinks(v['schema:url']),
                    savedAt: v['meshnotes:savedAt']
                }));
            }
            
            return entry;
        });

        mergeEntries(state.modelInfo.entries, importedEntries);
        updateModelInfoDisplay();
    }

    // Import metadata report (replace with confirmation)
    const importedMetadata = data['metadata'] || data['meshnotes:metadata'];
    if (importedMetadata && importedMetadata.sections) {
        const { filled } = (() => {
            let total = 0, filled = 0;
            if (state.modelInfo.metadata && state.modelInfo.metadata.sections) {
                for (const s of state.modelInfo.metadata.sections) {
                    for (const f of s.fields) { total++; if (f.value && f.value.trim()) filled++; }
                    if (s.customFields) for (const f of s.customFields) { total++; if (f.value && f.value.trim()) filled++; }
                }
            }
            return { total, filled };
        })();

        let doImport = true;
        if (filled > 0) {
            doImport = confirm('Imported file contains metadata. Replace current metadata?');
        }
        if (doImport) {
            state.modelInfo.metadata = normalizeMetadata(importedMetadata);
            updateMetadataDisplay();
        }
    }

    // Import groups - match by UUID first, then by name
    if (data['meshnotes:groups']) {
        data['meshnotes:groups'].forEach(importedGroup => {
            const groupUuid = importedGroup['meshnotes:uuid'];
            const groupName = importedGroup['schema:name'] || importedGroup.name || 'Imported Group';

            // Try to find existing group by UUID first, then by name
            let existing = null;
            if (groupUuid) {
                existing = state.groups.find(g => g.uuid === groupUuid);
            }
            if (!existing) {
                existing = state.groups.find(g => g.name === groupName);
            }

            if (!existing) {
                // New group - create it
                const newGroupId = generateInternalId();
                const newGroup = {
                    id: newGroupId,
                    uuid: groupUuid || generateUUID(),
                    name: groupName,
                    color: importedGroup['schema:color'] || importedGroup.color || '#4CAF50',
                    visible: importedGroup['meshnotes:visible'] !== false,
                    opacity: importedGroup['meshnotes:opacity'] !== undefined ? importedGroup['meshnotes:opacity'] : 1.0
                };
                // Sidebar flags, set only when the file has a non-default
                // value (labels hidden, collapsed); absent means the default.
                if (importedGroup['meshnotes:labelsVisible'] === false) newGroup.labelsVisible = false;
                if (importedGroup['meshnotes:collapsed'] === true) newGroup.collapsed = true;
                if (typeof importedGroup.modified === 'string') newGroup.modified = importedGroup.modified;
                // Map both internal ID and UUID for annotation lookup
                groupIdMap[importedGroup.id] = newGroupId;
                if (groupUuid) groupIdMap['uuid:' + groupUuid] = newGroupId;
                state.groups.push(newGroup);
            } else {
                // Existing group - map IDs. Name and colour follow the copy
                // edited more recently (modified; a tie, or no date in the
                // file, keeps the local ones). Visibility, opacity and the
                // sidebar flags (labelsVisible, collapsed) keep their local
                // state: they are how this user views the group.
                if (timeOf(importedGroup.modified) > timeOf(existing.modified)) {
                    existing.name = groupName;
                    existing.color = importedGroup['schema:color'] || importedGroup.color || existing.color;
                    existing.modified = importedGroup.modified;
                }
                groupIdMap[importedGroup.id] = existing.id;
                if (groupUuid) groupIdMap['uuid:' + groupUuid] = existing.id;
            }
        });
    }

    // Survey alignments: read after the groups and before the annotations,
    // so survey points resolve their alignment through the merged list.
    // mergeAlignments() decides per uuid (the newer modified wins, a tie keeps
    // the local copy; a replacing copy keeps the local id) from the alignments
    // as they were before this import, and returns the uuid -> id map for
    // every alignment of the merged list. A file without alignments (v1.5
    // and older) leaves state.alignments as it is.
    const previousAlignments = state.alignments;
    // The fit flags are not stored in the file: they are recomputed with the
    // current residual-warning setting.
    const readAlignments = alignmentsFromJsonLd(data, {
        generateId: generateInternalId, generateUuid: generateUUID, residualWarn: state.surveyResidualWarn
    });
    const alignmentMerge = mergeAlignments(previousAlignments, readAlignments.alignments);
    if (readAlignments.alignments.length > 0) state.alignments = alignmentMerge.alignments;
    if (readAlignments.skipped.length > 0) {
        console.warn(`Import: ${readAlignments.skipped.length} unusable survey alignment(s) skipped`);
    }
    // The file's default alignment is adopted only when the session has none
    // (or its default no longer exists); a local choice is never overridden.
    if (!state.alignments.some(a => a.id === state.defaultAlignmentId)) {
        state.defaultAlignmentId = resolveAlignmentRef(data['meshnotes:defaultAlignment'], alignmentMerge.idMap);
    }
    // Uuids whose position this import settled: new points, positions taken
    // from the file, and points hand-moved on either side (decision 1).
    const settledUuids = new Set();
    // Survey points whose position and survey block now come from the file:
    // new points, and points held on both sides whose imported copy won
    // with neither copy hand-moved (decision 5 checks them against 'kept'
    // alignments).
    const fromFileUuids = new Set();

    // Import annotations from first page with merge
    if (data.first && data.first.items) {
        data.first.items.forEach(w3cAnn => {
            const importedAnn = convertFromW3CAnnotation(w3cAnn, groupIdMap, alignmentMerge.idMap);

            // Transform coordinates from Z-up to Three.js Y-up if needed
            transformAnnotationCoords(importedAnn);

            // Face numbers in file order before anything compares them; needs
            // the centroid in the storage frame, hence after the transform.
            if (importedAnn.type === 'surface') {
                const order = normalizeSurfaceFaces(importedAnn, { declared: facesDeclared });
                if (order === FACE_ORDER.CONVERTED) surfaceFaces.converted++;
                else if (order === FACE_ORDER.UNCHECKED) surfaceFaces.unchecked++;
            }

            // If no group assigned, use default
            if (!importedAnn.groupId) {
                if (state.groups.length === 0) {
                    state.groups.push({ id: generateInternalId(), uuid: generateUUID(), name: 'Default', color: '#4CAF50', visible: true, opacity: 1.0 });
                }
                importedAnn.groupId = state.groups[0].id;
            }

            // Check if annotation with same UUID already exists
            const existingAnn = state.annotations.find(a => a.uuid === importedAnn.uuid);

            if (!existingAnn) {
                // New annotation - add it
                state.annotations.push(importedAnn);
                settledUuids.add(importedAnn.uuid);
                if (importedAnn.survey) fromFileUuids.add(importedAnn.uuid);
                addedCount++;
            } else {
                // Existing annotation - merge
                // Determine which version is newer by latest entry timestamp
                const existingLatest = existingAnn.entries.length > 0
                    ? Math.max(...existingAnn.entries.map(e => new Date(entryTimestamp(e)).getTime() || 0))
                    : 0;
                const importedLatest = importedAnn.entries.length > 0
                    ? Math.max(...importedAnn.entries.map(e => new Date(entryTimestamp(e)).getTime() || 0))
                    : 0;

                // Adopt the frozen annotation-level creator when the local
                // annotation predates the field; an already-present creator
                // is never overwritten (it is frozen at creation).
                if (existingAnn.creator === undefined && importedAnn.creator !== undefined) {
                    existingAnn.creator = importedAnn.creator;
                    existingAnn.creatorOrcid = importedAnn.creatorOrcid;
                }

                // Made at the earlier, last changed at the later of the two
                // times (an absent time takes the other copy's).
                const created = earlierTime(existingAnn.created, importedAnn.created);
                const modified = laterTime(existingAnn.modified, importedAnn.modified);
                if (created) existingAnn.created = created;
                if (modified) existingAnn.modified = modified;

                // Name and group are decided each on its own, independent of
                // the entries: the copy whose latest recorded rename or move is
                // newer wins, a tie keeps the local copy, and the losing value
                // is kept in the history, so no name or group is lost
                // (history.js). Without a recorded change on either side
                // (files without history), the entries rule decides as before.
                const entriesNewer = importedLatest > existingLatest;
                const nameMerge = mergeName(existingAnn, importedAnn, entriesNewer);
                const groupMerge = mergeGroup(existingAnn, importedAnn, state.groups, entriesNewer);
                const nameOrGroupChanged = nameMerge.value !== existingAnn.name ||
                    groupMerge.value !== existingAnn.groupId;
                existingAnn.name = nameMerge.value;
                existingAnn.groupId = groupMerge.value;
                if (nameMerge.versions.length > 0) existingAnn.nameVersions = nameMerge.versions;
                if (groupMerge.versions.length > 0) existingAnn.groupVersions = groupMerge.versions;

                // The geometry follows the entries rule, except for survey points
                // held on both sides: their position, survey block and lock
                // follow the alignment that won the merge ('imported' or
                // 'local'), whatever the entries say. A copy moved by hand on
                // either side (placement 'manual'), or two copies on different
                // alignments, fall back to the entries rule ('entries'). Other
                // annotations always get 'entries', i.e. the old behaviour.
                const positionSource = surveyPointMergeSource(existingAnn, importedAnn, alignmentMerge);
                const takeImportedPosition = positionSource === MERGE_SOURCE.IMPORTED ||
                    (positionSource === MERGE_SOURCE.ENTRIES && entriesNewer);
                if (takeImportedPosition) {
                    existingAnn.points = importedAnn.points;
                    if (importedAnn.faceData) {
                        existingAnn.faceData = importedAnn.faceData;
                        // The check of the face order goes with the faces.
                        if (importedAnn.faceOrderUnchecked) existingAnn.faceOrderUnchecked = true;
                        else delete existingAnn.faceOrderUnchecked;
                    }
                    if (importedAnn.boxData) existingAnn.boxData = importedAnn.boxData;
                    if (importedAnn.projectedEdges) existingAnn.projectedEdges = importedAnn.projectedEdges;
                    // The lock goes with the position (absent = unlocked).
                    // A copy without a survey block next to a local one keeps
                    // the local survey block and lock: older versions drop
                    // both when they re-export a file.
                    if (importedAnn.survey || !existingAnn.survey) {
                        if (importedAnn.locked === true) existingAnn.locked = true;
                        else if (existingAnn.locked !== undefined) existingAnn.locked = false;
                    }
                    if (importedAnn.survey) existingAnn.survey = importedAnn.survey;
                }
                const handMoved = !!(existingAnn.survey && importedAnn.survey &&
                    manualPlacementMergeRule(existingAnn.survey, importedAnn.survey));
                if (takeImportedPosition || handMoved) {
                    settledUuids.add(existingAnn.uuid);
                }
                if (takeImportedPosition && importedAnn.survey && !handMoved) {
                    fromFileUuids.add(existingAnn.uuid);
                }

                // Merge body entries (including their version histories)
                const result = mergeEntries(existingAnn.entries, importedAnn.entries);

                if (result.entriesAdded > 0 || result.entriesUpdated > 0 ||
                    positionSource === MERGE_SOURCE.IMPORTED || nameOrGroupChanged) {
                    mergedCount++;
                } else {
                    skippedCount++;
                }
            }
        });
    }

    // Fit points follow the alignment that won the merge. Points left at the
    // losing copy's fit are listed like a refine, so the caller can move the
    // 'fit' ones to the winning fit and snap them; hand-moved ones never move.
    // An alignment whose two copies hold the same fit (e.g. only renamed)
    // lists nothing.
    const realign = [];
    // Decision 2, alignments the file replaced: survey points that kept their
    // local position, i.e. points only this session holds, and points held on
    // both sides whose local copy won through the entries rule (the imported
    // copy detached, on another alignment or without a survey block).
    const keptLocal = state.annotations.filter(a => a.survey && !settledUuids.has(a.uuid));
    alignmentMerge.replaced.forEach(uuid => {
        const previous = previousAlignments.find(a => a.uuid === uuid);
        const alignment = state.alignments.find(a => a.uuid === uuid);
        if (!previous || !alignment || sameFit(previous, alignment)) return;
        const plan = planRefinePlacement(keptLocal, previous, alignment);
        if (plan.count > 0 || plan.manualCount > 0) realign.push({ uuid, kind: 'replaced', previous, alignment, plan });
    });
    // Decision 5, alignments whose local copy won ('kept'): survey points
    // placed from the file's older copy (see fromFileUuids). The file's copy
    // stands for the old fit, under the local id its points resolved to.
    const fromFile = state.annotations.filter(a => a.survey && fromFileUuids.has(a.uuid));
    alignmentMerge.kept.forEach(uuid => {
        const fileCopy = readAlignments.alignments.find(a => a.uuid === uuid);
        const alignment = state.alignments.find(a => a.uuid === uuid);
        if (!fileCopy || !alignment || sameFit(fileCopy, alignment)) return;
        const previous = { ...fileCopy, id: alignment.id };
        const plan = planRefinePlacement(fromFile, previous, alignment);
        if (plan.count > 0 || plan.manualCount > 0) realign.push({ uuid, kind: 'kept', previous, alignment, plan });
    });

    if (startsRecord && isCollectionId(data.id)) state.collectionId = data.id;

    return {
        added: addedCount,
        merged: mergedCount,
        unchanged: skippedCount,
        alignments: {
            added: alignmentMerge.added,
            replaced: alignmentMerge.replaced,
            kept: alignmentMerge.kept,
            skipped: readAlignments.skipped.length
        },
        realign,
        surfaceFaces
    };
}

// A MeshNotes collection id: urn:meshnotes:collection:{uuid}.
function isCollectionId(id) {
    return typeof id === 'string' && /^urn:meshnotes:collection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// Milliseconds of an ISO timestamp, 0 when missing or unreadable.
function timeOf(s) {
    const t = typeof s === 'string' ? Date.parse(s) : NaN;
    return Number.isNaN(t) ? 0 : t;
}

// Two copies of an alignment hold the same fit: no fitted position differs.
function sameFit(a, b) {
    const same = (x, y) => Array.isArray(x) && Array.isArray(y) &&
        x.length === y.length && x.every((v, i) => v === y[i]);
    return same(a.rotation, b.rotation) && same(a.translation, b.translation);
}

/**
 * The moves of a mergeW3CCollection() result's realign list (decisions 2
 * and 5), joined into one list for applyReplacement() /
 * applyReplacementChunked() in survey-import.js.
 * @param {Array<{plan: {moves: object[]}}>} realign
 * @returns {Array<{annotation, from, to, displacement, changedAt}>}
 */
export function realignMoves(realign) {
    // Each move carries the time of the winning fit, so the moved point's
    // modified becomes that time (survey-import.js finishReplacement()).
    return (realign || []).flatMap(r => r.plan.moves.map(m => ({ ...m, changedAt: r.alignment && r.alignment.modified })));
}

function importLegacyAnnotations(data) {
    // Import legacy MeshNotes format (for backward compatibility)
    console.warn('Importing legacy format - consider re-exporting to W3C format');

    // Import model info if present
    if (data.modelInfo && data.modelInfo.entries) {
        data.modelInfo.entries.forEach(entry => {
            state.modelInfo.entries.push({
                ...entry,
                id: generateInternalId(),
                uuid: entry.uuid || generateUUID()
            });
        });
        updateModelInfoDisplay();
    }

    // Import metadata if present (legacy format)
    if (data.modelInfo && data.modelInfo.metadata && data.modelInfo.metadata.sections) {
        state.modelInfo.metadata = normalizeMetadata(data.modelInfo.metadata);
        updateMetadataDisplay();
    }

    // Merge groups (avoid duplicates by name)
    data.groups.forEach(importedGroup => {
        const existing = state.groups.find(g => g.name === importedGroup.name);
        if (!existing) {
            const newGroupId = generateInternalId();
            const newGroup = {
                ...importedGroup,
                id: newGroupId,
                uuid: importedGroup.uuid || generateUUID(),
                opacity: importedGroup.opacity !== undefined ? importedGroup.opacity : 1.0
            };

            data.annotations.forEach(ann => {
                if (ann.groupId === importedGroup.id) {
                    ann.groupId = newGroupId;
                }
            });

            state.groups.push(newGroup);
        } else {
            data.annotations.forEach(ann => {
                if (ann.groupId === importedGroup.id) {
                    ann.groupId = existing.id;
                }
            });
        }
    });

    // Add annotations with new IDs
    data.annotations.forEach(ann => {
        const newAnn = {
            ...ann,
            id: generateInternalId(),
            uuid: ann.uuid || generateUUID()
        };
        // Ensure entries have UUIDs
        if (newAnn.entries) {
            newAnn.entries = newAnn.entries.map(entry => ({
                ...entry,
                uuid: entry.uuid || generateUUID()
            }));
        }
        state.annotations.push(newAnn);
    });

    // Re-project imported annotations onto current model surface
    reprojectAllAnnotations();

    updateGroupsList();
    renderAnnotations();
    showStatus(`Imported ${data.annotations.length} annotations (legacy format)`);
}
