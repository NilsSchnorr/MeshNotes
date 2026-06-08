// js/metadata/templates.js - Metadata report templates

/**
 * 3D Documentation metadata template.
 * Covers photogrammetry, structured light, LiDAR, and TLS workflows.
 *
 * Each field has a stable `id` (the permanent machine identifier, never
 * changed once published) and a `label` (the human-readable display name,
 * freely editable/translatable). Storage and export key on `id`; the label
 * travels alongside for readability. `hint` is shown as a placeholder, and
 * fields with `multiline: true` render as <textarea> instead of <input>.
 *
 * All fields are optional — a blank field simply carries an empty value.
 */
export const TEMPLATES = {
    '3d-documentation': {
        name: '3D Documentation',
        sections: [
            {
                id: 'general',
                title: 'General Information',
                fields: [
                    { id: 'project_title', label: 'Project Title', hint: '' },
                    { id: 'project_description', label: 'Project Description', hint: '', multiline: true },
                    { id: 'documentation_purpose', label: 'Documentation Purpose', hint: 'e.g., as part of a larger project, conservation, research' },
                    { id: 'fieldwork_timeline', label: 'Fieldwork Timeline', hint: 'Dates and times of documentation' },
                    { id: 'location', label: 'Location', hint: 'Country, city, building, coordinates' },
                    { id: 'object', label: 'Object', hint: 'Name and/or short description' },
                    { id: 'additional_notes', label: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                id: 'object_context',
                title: 'Object Context',
                fields: [
                    { id: 'object_type', label: 'Object Type / Classification', hint: 'e.g., vessel, coin, sculpture, architectural element' },
                    { id: 'material', label: 'Material', hint: 'e.g., marble, bronze, ceramic, mixed' },
                    { id: 'dimensions', label: 'Dimensions', hint: 'Physical dimensions of the object (L × W × H), units' },
                    { id: 'dating_period', label: 'Dating / Period', hint: 'e.g., 2nd c. BCE, La Tène D1, Augustan' },
                    { id: 'find_spot', label: 'Find Spot / Provenance', hint: 'Site name, gazetteer URI (e.g., iDAI.gazetteer, Pleiades, GeoNames)' },
                    { id: 'stratigraphic_context', label: 'Stratigraphic Context', hint: 'Excavation unit, SU number, trench, grid square' },
                    { id: 'excavation_reference', label: 'Excavation / Project Reference', hint: 'Project name, campaign year, director' },
                    { id: 'current_location', label: 'Current Location', hint: 'Repository, museum, storeroom' },
                    { id: 'inventory_number', label: 'Inventory Number', hint: 'Collection or accession number' },
                    { id: 'conservation_state', label: 'Conservation State', hint: 'e.g., intact, fragmentary, restored, surface corrosion' },
                    { id: 'additional_notes', label: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                id: 'capture',
                title: 'Capture Metadata',
                fields: [
                    { id: 'documentation_method', label: 'Documentation Method', hint: 'e.g., photogrammetry, structured light, LiDAR, TLS' },
                    { id: 'capture_operator', label: 'Capture Operator', hint: 'Name(s), role(s), contact if needed' },
                    { id: 'instrument', label: 'Instrument/Device', hint: 'Camera model or scanner model/brand' },
                    { id: 'lens', label: 'Lens', hint: 'If applicable' },
                    { id: 'iso', label: 'ISO', hint: 'If applicable' },
                    { id: 'aperture', label: 'f/', hint: 'If applicable' },
                    { id: 'focal_length', label: 'mm', hint: 'If applicable' },
                    { id: 'filter', label: 'Filter', hint: 'If applicable' },
                    { id: 'color_card', label: 'Color Card', hint: 'If applicable' },
                    { id: 'scan_resolution', label: 'Scan Resolution / Point Spacing', hint: 'If applicable' },
                    { id: 'working_distance', label: 'Working Distance', hint: 'If applicable' },
                    { id: 'calibration', label: 'Calibration', hint: 'e.g., lens calibration, scanner calibration before session' },
                    { id: 'number_of_captures', label: 'Number of Captures', hint: 'Images, scans, or stations' },
                    { id: 'registration_method', label: 'Registration Method', hint: 'e.g., target-based, cloud-to-cloud, chunk alignment' },
                    { id: 'lighting_conditions', label: 'Sun / Weather / Lighting', hint: 'e.g., high noon, indoor, overcast' },
                    { id: 'technical_notes', label: 'Technical Notes', hint: 'e.g., rotary table, fixed angles, scan overlap', multiline: true },
                    { id: 'additional_notes', label: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                id: 'reference',
                title: 'Reference Metadata',
                fields: [
                    { id: 'referenced_by', label: 'Referenced by', hint: 'GPS, scalebars, GCPs, total station, etc.' },
                    { id: 'additional_notes', label: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                id: 'processing',
                title: 'Processing Metadata',
                fields: [
                    { id: 'image_preprocessing', label: 'Image Preprocessing', hint: 'Only in exceptional cases' },
                    { id: 'processing_operator', label: 'Processing Operator', hint: 'Name(s), role(s), contact if needed' },
                    { id: 'software', label: 'Software(s)', hint: '' },
                    { id: 'versions', label: 'Version(s)', hint: '' },
                    { id: 'algorithm_parameters', label: 'Algorithm Parameters', hint: 'Not needed if processing report is available', multiline: true },
                    { id: 'workflow_description', label: 'Workflow Description', hint: 'Not needed if processing report is available', multiline: true },
                    { id: 'model_details', label: 'Model Details', hint: 'Coordinate system, scale, units, mesh density, texture resolution, file formats', multiline: true },
                    { id: 'postprocessing_information', label: 'Postprocessing Information', hint: 'Versions, iterations, changes during/after processing', multiline: true },
                    { id: 'quality_summary', label: 'Quality Summary', hint: 'e.g., polygon count, RMS error, completeness estimate, texture resolution', multiline: true },
                    { id: 'additional_notes', label: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                id: 'paradata',
                title: 'Paradata',
                fields: [
                    { id: 'method_rationale', label: 'Method Rationale', hint: 'Why was this capture method chosen? (e.g., object size, surface properties, time/budget, accuracy requirements)', multiline: true },
                    { id: 'sources_consulted', label: 'Sources Consulted', hint: 'Publications, reports, excavation records, comparanda that informed decisions', multiline: true },
                    { id: 'interpretive_decisions', label: 'Interpretive Decisions', hint: 'What is evidenced vs. hypothesised? Were conflicting sources resolved?', multiline: true },
                    { id: 'known_limitations', label: 'Known Limitations', hint: 'e.g., inaccessible areas, reflective surfaces, time constraints, incomplete coverage', multiline: true },
                    { id: 'uncertainty_notes', label: 'Uncertainty Notes', hint: 'Per-region or general assessment of reliability and completeness', multiline: true },
                    { id: 'additional_notes', label: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                id: 'legal',
                title: 'Legal',
                fields: [
                    { id: 'project_lead', label: 'Project Lead', hint: 'Name(s), role(s), contact if needed' },
                    { id: 'funding', label: 'Funding', hint: 'If applicable' },
                    { id: 'copyright', label: 'Copyright', hint: 'If applicable' },
                    { id: 'acknowledgments', label: 'Acknowledgments', hint: 'If applicable', multiline: true }
                ]
            }
        ]
    }
};

/**
 * The Data Management guideline text.
 * Static, non-editable — included in PDF downloads and displayed in MeshNotes.
 */
export const DATA_MANAGEMENT_GUIDELINE = `Project File Management Structure:
(Needs to be executed at the beginning of the project since relocating folders later on is not recommended)

YYYY-MM-DD_Project (folder)
\t- 01_Processing (folder)
\t\t- software data (e.g. .psx and .files; saved as "YYYY-MM-DD_Project")
\t- 02_Images (folder)
\t\t- images (Usually .jpg, if needed also raw)
\t- 03_Data (folder)
\t\t- external data (GPS-references, etc.)
\t\t- metadata-report (this document)
\t\t- processing-report (e.g. Agisoft report)
\t- 04_Exports (folder)
\t\t- final models
\t\t- other exported data`;

/**
 * Creates an empty metadata object from a template.
 * Fields carry their stable id and current display label; values start empty.
 * @param {string} templateId - Template identifier
 * @returns {object|null} Metadata object with empty values, or null if template not found
 */
export function createEmptyMetadata(templateId = '3d-documentation') {
    const template = TEMPLATES[templateId];
    if (!template) return null;

    return {
        template: templateId,
        sections: template.sections.map(section => ({
            id: section.id,
            title: section.title,
            fields: section.fields.map(f => ({
                id: f.id,
                label: f.label,
                value: ''
            })),
            customFields: []
        }))
    };
}

/**
 * Looks up the template definition for a field by stable ids, returning its
 * current label, hint and multiline flag.
 * @param {string} templateId
 * @param {string} sectionId
 * @param {string} fieldId
 * @returns {object|null} { label, hint, multiline } or null
 */
export function getFieldDefinition(templateId, sectionId, fieldId) {
    const template = TEMPLATES[templateId];
    if (!template) return null;
    const section = template.sections.find(s => s.id === sectionId);
    if (!section) return null;
    const field = section.fields.find(f => f.id === fieldId);
    return field || null;
}

/**
 * Normalizes any metadata object (current or legacy) into the current
 * id-keyed structure, preserving all values.
 *
 * Legacy files (pre-2a) keyed sections by their English title and fields by
 * their English label (the old `key`). This maps those back to stable ids via
 * the template. Any section or field that cannot be matched is preserved as a
 * custom field so that no user data is ever lost. New (id-keyed) files pass
 * through unchanged apart from being completed against the current template.
 *
 * @param {object} raw - A metadata object in any version's shape
 * @returns {object} A metadata object in the current structure
 */
export function normalizeMetadata(raw) {
    const templateId = (raw && raw.template) || '3d-documentation';
    const result = createEmptyMetadata(templateId);
    if (!result) return raw || null;
    if (!raw || !Array.isArray(raw.sections)) return result;

    // Forward-compatibility: preserve a declared conformance target if present.
    if (raw['dcterms:conformsTo']) result['dcterms:conformsTo'] = raw['dcterms:conformsTo'];

    const template = TEMPLATES[templateId];

    const pushCustom = (targetSection, label, value, uri) => {
        if (!targetSection.customFields) targetSection.customFields = [];
        const entry = { label: label || 'Field', value: value || '' };
        if (uri) entry.uri = uri;
        targetSection.customFields.push(entry);
    };

    for (const rawSection of raw.sections) {
        // Match section by stable id first, then by title/label (legacy).
        let target = result.sections.find(s =>
            (rawSection.id && s.id === rawSection.id) ||
            (rawSection.title && s.title === rawSection.title) ||
            (rawSection.label && s.title === rawSection.label)
        );

        if (!target) {
            // Unknown section: preserve everything as a standalone section of
            // custom fields so nothing is lost.
            const preserved = {
                id: rawSection.id || 'imported_' + (rawSection.title || rawSection.label || 'section')
                    .toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
                title: rawSection.title || rawSection.label || 'Imported Section',
                fields: [],
                customFields: []
            };
            for (const rf of (rawSection.fields || [])) {
                pushCustom(preserved, rf.label || rf.key || rf.id, rf.value, rf.uri);
            }
            for (const cf of (rawSection.customFields || [])) {
                pushCustom(preserved, cf.label || cf.key, cf.value, cf.uri);
            }
            result.sections.push(preserved);
            continue;
        }

        const tplSection = template.sections.find(s => s.id === target.id) || null;

        for (const rawField of (rawSection.fields || [])) {
            // Resolve the field id: explicit id, else map label/key -> id.
            let fieldId = rawField.id;
            if (!fieldId && tplSection) {
                const label = rawField.label || rawField.key;
                const tplField = tplSection.fields.find(f => f.label === label || f.id === label);
                fieldId = tplField ? tplField.id : null;
            }

            const value = rawField.value || '';
            const uri = rawField.uri;

            const tf = fieldId ? target.fields.find(f => f.id === fieldId) : null;
            if (tf) {
                tf.value = value;
                if (uri) tf.uri = uri;
            } else {
                // Unmatched template field -> preserve as custom.
                pushCustom(target, rawField.label || rawField.key || rawField.id, value, uri);
            }
        }

        // Carry custom fields (legacy `key` -> `label`).
        for (const cf of (rawSection.customFields || [])) {
            pushCustom(target, cf.label || cf.key, cf.value, cf.uri);
        }
    }

    return result;
}

/**
 * Returns the total number of fields and the number of filled fields.
 * @param {object} metadata - The metadata object from state
 * @returns {{ total: number, filled: number }}
 */
export function getMetadataStats(metadata) {
    if (!metadata || !metadata.sections) return { total: 0, filled: 0 };
    let total = 0;
    let filled = 0;
    for (const section of metadata.sections) {
        for (const field of section.fields) {
            total++;
            if (field.value && field.value.trim()) filled++;
        }
        if (section.customFields) {
            for (const field of section.customFields) {
                total++;
                if (field.value && field.value.trim()) filled++;
            }
        }
    }
    return { total, filled };
}
