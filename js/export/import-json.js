// js/export/import-json.js - W3C and legacy annotation import with merge support
import { state } from '../state.js';
import { generateUUID, generateInternalId, showStatus } from '../utils/helpers.js';
import { convertFromW3CAnnotation, pointFromZUp, creatorToAuthor, normalizeLinks } from './w3c-format.js';
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
        let viewState = null;
        try {
            const data = JSON.parse(e.target.result);

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
    };
    reader.readAsText(file);
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
    if (extra) parts.push(extra);
    return `Import: ${parts.join(', ') || 'nothing to import'}`;
}

/**
 * Merges a W3C Web Annotation Collection into the session state.
 * Uses UUID-based duplicate detection: existing annotations are updated
 * (entries merged by UUID, newer timestamps win), new annotations are added.
 * Also imports groups, survey alignments and model info with the same merge
 * strategy. The sidebar, scene and status refresh is left to the caller
 * (importW3CAnnotations); the model-info and metadata panels still refresh
 * here when the file carries them.
 * @param {Object} data - Parsed W3C AnnotationCollection JSON-LD
 * @returns {{added: number, merged: number, unchanged: number,
 *            alignments: {added: string[], replaced: string[], kept: string[], skipped: number},
 *            realign: Array<{uuid: string, kind: 'replaced'|'kept', previous: Object, alignment: Object, plan: Object}>}}
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
                // Map both internal ID and UUID for annotation lookup
                groupIdMap[importedGroup.id] = newGroupId;
                if (groupUuid) groupIdMap['uuid:' + groupUuid] = newGroupId;
                state.groups.push(newGroup);
            } else {
                // Existing group - map IDs. Its visibility, opacity and sidebar
                // flags (labelsVisible, collapsed) keep their local state.
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

                // Merge name version histories
                if (importedAnn.nameVersions && importedAnn.nameVersions.length > 0) {
                    if (!existingAnn.nameVersions) existingAnn.nameVersions = [];
                    mergeVersionHistories(existingAnn.nameVersions, importedAnn.nameVersions);
                }
                
                // Merge group version histories
                if (importedAnn.groupVersions && importedAnn.groupVersions.length > 0) {
                    if (!existingAnn.groupVersions) existingAnn.groupVersions = [];
                    mergeVersionHistories(existingAnn.groupVersions, importedAnn.groupVersions);
                }

                // Update metadata (name, group) if imported version is newer.
                // The geometry follows the same rule, except for survey points
                // held on both sides: their position, survey block and lock
                // follow the alignment that won the merge ('imported' or
                // 'local'), whatever the entries say. A copy moved by hand on
                // either side (placement 'manual'), or two copies on different
                // alignments, fall back to the entries rule ('entries'). Other
                // annotations always get 'entries', i.e. the old behaviour.
                const entriesNewer = importedLatest > existingLatest;
                const positionSource = surveyPointMergeSource(existingAnn, importedAnn, alignmentMerge);
                const takeImportedPosition = positionSource === MERGE_SOURCE.IMPORTED ||
                    (positionSource === MERGE_SOURCE.ENTRIES && entriesNewer);
                if (entriesNewer) {
                    existingAnn.name = importedAnn.name;
                    existingAnn.groupId = importedAnn.groupId;
                }
                if (takeImportedPosition) {
                    existingAnn.points = importedAnn.points;
                    if (importedAnn.faceData) existingAnn.faceData = importedAnn.faceData;
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
                    positionSource === MERGE_SOURCE.IMPORTED) {
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
        realign
    };
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
 * @returns {Array<{annotation, from, to, displacement}>}
 */
export function realignMoves(realign) {
    return (realign || []).flatMap(r => r.plan.moves);
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
