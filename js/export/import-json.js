// js/export/import-json.js - W3C and legacy annotation import with merge support
import { state } from '../state.js';
import { generateUUID, showStatus } from '../utils/helpers.js';
import { convertFromW3CAnnotation, pointFromZUp } from './w3c-format.js';
import { updateModelInfoDisplay } from '../annotation-tools/data.js';
import { updateGroupsList } from '../annotation-tools/groups.js';
import { renderAnnotations } from '../annotation-tools/render.js';
import { reprojectAllAnnotations } from '../annotation-tools/projection.js';

export function importAnnotations(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);

            // Check if this is W3C format (has @context and type: AnnotationCollection)
            if (data['@context'] && data.type === 'AnnotationCollection') {
                importW3CAnnotations(data);
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
    };
    reader.readAsText(file);
}

/**
 * Imports a W3C Web Annotation Collection with intelligent merge support.
 * Uses UUID-based duplicate detection: existing annotations are updated
 * (entries merged by UUID, newer timestamps win), new annotations are added.
 * Also imports groups and model info with the same merge strategy.
 * @param {Object} data - Parsed W3C AnnotationCollection JSON-LD
 */
function importW3CAnnotations(data) {
    // Import W3C Web Annotation Collection format with merge support
    const groupIdMap = {};
    let addedCount = 0;
    let mergedCount = 0;
    let skippedCount = 0;

    // Detect coordinate system of imported file
    // Files with upAxis 'Z' (or 'z') contain Z-up coordinates that need
    // transformation to Three.js Y-up space. Legacy files (upAxis 'Y',
    // 'y', or missing) are already in Y-up space and need no transform.
    const importedUpAxis = (data['upAxis'] || data['meshnotes:upAxis'] || '').toString().toUpperCase();
    const needsTransform = (importedUpAxis === 'Z');

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
                    existingEntry.author = importedEntry.author;
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

        const importedEntries = bodies.map((body, idx) => {
            const entry = {
                id: Date.now() + idx + Math.floor(Math.random() * 1000),
                uuid: body['meshnotes:entryUuid'] || generateUUID(),
                description: body.value || '',
                author: body.creator ? body.creator.name : '',
                timestamp: body.created || new Date().toISOString(),
                modified: body.modified || undefined,
                links: body['schema:url'] || []
            };
            
            // Include version history if present
            if (body['meshnotes:versions'] && body['meshnotes:versions'].length > 0) {
                entry.versions = body['meshnotes:versions'].map(v => ({
                    description: v.value || '',
                    author: v.creator ? v.creator.name : '',
                    links: v['schema:url'] || [],
                    savedAt: v['meshnotes:savedAt']
                }));
            }
            
            return entry;
        });

        mergeEntries(state.modelInfo.entries, importedEntries);
        updateModelInfoDisplay();
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
                const newGroupId = Date.now() + Math.floor(Math.random() * 10000);
                const newGroup = {
                    id: newGroupId,
                    uuid: groupUuid || generateUUID(),
                    name: groupName,
                    color: importedGroup['schema:color'] || importedGroup.color || '#4CAF50',
                    visible: importedGroup['meshnotes:visible'] !== false
                };
                // Map both internal ID and UUID for annotation lookup
                groupIdMap[importedGroup.id] = newGroupId;
                if (groupUuid) groupIdMap['uuid:' + groupUuid] = newGroupId;
                state.groups.push(newGroup);
            } else {
                // Existing group - map IDs
                groupIdMap[importedGroup.id] = existing.id;
                if (groupUuid) groupIdMap['uuid:' + groupUuid] = existing.id;
            }
        });
    }

    // Import annotations from first page with merge
    if (data.first && data.first.items) {
        data.first.items.forEach(w3cAnn => {
            const importedAnn = convertFromW3CAnnotation(w3cAnn, groupIdMap);

            // Transform coordinates from Z-up to Three.js Y-up if needed
            transformAnnotationCoords(importedAnn);

            // If no group assigned, use default
            if (!importedAnn.groupId) {
                if (state.groups.length === 0) {
                    state.groups.push({ id: Date.now(), uuid: generateUUID(), name: 'Default', color: '#4CAF50', visible: true });
                }
                importedAnn.groupId = state.groups[0].id;
            }

            // Check if annotation with same UUID already exists
            const existingAnn = state.annotations.find(a => a.uuid === importedAnn.uuid);

            if (!existingAnn) {
                // New annotation - add it
                state.annotations.push(importedAnn);
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

                // Update metadata (name, group, geometry) if imported version is newer
                if (importedLatest > existingLatest) {
                    existingAnn.name = importedAnn.name;
                    existingAnn.groupId = importedAnn.groupId;
                    existingAnn.points = importedAnn.points;
                    if (importedAnn.faceData) existingAnn.faceData = importedAnn.faceData;
                    if (importedAnn.boxData) existingAnn.boxData = importedAnn.boxData;
                    if (importedAnn.projectedEdges) existingAnn.projectedEdges = importedAnn.projectedEdges;
                }

                // Merge body entries (including their version histories)
                const result = mergeEntries(existingAnn.entries, importedAnn.entries);

                if (result.entriesAdded > 0 || result.entriesUpdated > 0) {
                    mergedCount++;
                } else {
                    skippedCount++;
                }
            }
        });
    }

    // Re-project imported annotations onto current model surface
    reprojectAllAnnotations();

    updateGroupsList();
    renderAnnotations();

    // Build status message
    const parts = [];
    if (addedCount > 0) parts.push(`${addedCount} added`);
    if (mergedCount > 0) parts.push(`${mergedCount} merged`);
    if (skippedCount > 0) parts.push(`${skippedCount} unchanged`);
    showStatus(`Import: ${parts.join(', ') || 'nothing to import'}`);
}

function importLegacyAnnotations(data) {
    // Import legacy MeshNotes format (for backward compatibility)
    console.warn('Importing legacy format - consider re-exporting to W3C format');

    // Import model info if present
    if (data.modelInfo && data.modelInfo.entries) {
        data.modelInfo.entries.forEach(entry => {
            state.modelInfo.entries.push({
                ...entry,
                id: Date.now() + Math.floor(Math.random() * 10000),
                uuid: entry.uuid || generateUUID()
            });
        });
        updateModelInfoDisplay();
    }

    // Merge groups (avoid duplicates by name)
    data.groups.forEach(importedGroup => {
        const existing = state.groups.find(g => g.name === importedGroup.name);
        if (!existing) {
            const newGroupId = Date.now() + Math.floor(Math.random() * 10000);
            const newGroup = {
                ...importedGroup,
                id: newGroupId,
                uuid: importedGroup.uuid || generateUUID()
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
    let idOffset = 0;
    data.annotations.forEach(ann => {
        idOffset++;
        const newAnn = {
            ...ann,
            id: Date.now() + idOffset,
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
