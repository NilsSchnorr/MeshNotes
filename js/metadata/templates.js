// js/metadata/templates.js - Metadata report templates

/**
 * 3D Documentation metadata template.
 * Covers photogrammetry, structured light, LiDAR, and TLS workflows.
 * Each field has a key (label) and an optional hint (shown as placeholder).
 * Fields with multiline: true render as <textarea> instead of <input>.
 */
export const TEMPLATES = {
    '3d-documentation': {
        name: '3D Documentation',
        sections: [
            {
                title: 'General Information',
                fields: [
                    { key: 'Project Title', hint: '' },
                    { key: 'Project Description', hint: '', multiline: true },
                    { key: 'Documentation Purpose', hint: 'e.g., as part of a larger project, conservation, research' },
                    { key: 'Fieldwork Timeline', hint: 'Dates and times of documentation' },
                    { key: 'Location', hint: 'Country, city, building, coordinates' },
                    { key: 'Object', hint: 'Name and/or short description' },
                    { key: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                title: 'Object Context',
                fields: [
                    { key: 'Object Type / Classification', hint: 'e.g., vessel, coin, sculpture, architectural element' },
                    { key: 'Material', hint: 'e.g., marble, bronze, ceramic, mixed' },
                    { key: 'Dimensions', hint: 'Physical dimensions of the object (L × W × H), units' },
                    { key: 'Dating / Period', hint: 'e.g., 2nd c. BCE, La Tène D1, Augustan' },
                    { key: 'Find Spot / Provenance', hint: 'Site name, gazetteer URI (e.g., iDAI.gazetteer, Pleiades, GeoNames)' },
                    { key: 'Stratigraphic Context', hint: 'Excavation unit, SU number, trench, grid square' },
                    { key: 'Excavation / Project Reference', hint: 'Project name, campaign year, director' },
                    { key: 'Current Location', hint: 'Repository, museum, storeroom' },
                    { key: 'Inventory Number', hint: 'Collection or accession number' },
                    { key: 'Conservation State', hint: 'e.g., intact, fragmentary, restored, surface corrosion' },
                    { key: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                title: 'Capture Metadata',
                fields: [
                    { key: 'Documentation Method', hint: 'e.g., photogrammetry, structured light, LiDAR, TLS' },
                    { key: 'Capture Operator', hint: 'Name(s), role(s), contact if needed' },
                    { key: 'Instrument/Device', hint: 'Camera model or scanner model/brand' },
                    { key: 'Lens', hint: 'If applicable' },
                    { key: 'ISO', hint: 'If applicable' },
                    { key: 'f/', hint: 'If applicable' },
                    { key: 'mm', hint: 'If applicable' },
                    { key: 'Filter', hint: 'If applicable' },
                    { key: 'Color Card', hint: 'If applicable' },
                    { key: 'Scan Resolution / Point Spacing', hint: 'If applicable' },
                    { key: 'Working Distance', hint: 'If applicable' },
                    { key: 'Calibration', hint: 'e.g., lens calibration, scanner calibration before session' },
                    { key: 'Number of Captures', hint: 'Images, scans, or stations' },
                    { key: 'Registration Method', hint: 'e.g., target-based, cloud-to-cloud, chunk alignment' },
                    { key: 'Sun / Weather / Lighting', hint: 'e.g., high noon, indoor, overcast' },
                    { key: 'Technical Notes', hint: 'e.g., rotary table, fixed angles, scan overlap', multiline: true },
                    { key: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                title: 'Reference Metadata',
                fields: [
                    { key: 'Referenced by', hint: 'GPS, scalebars, GCPs, total station, etc.' },
                    { key: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                title: 'Processing Metadata',
                fields: [
                    { key: 'Image Preprocessing', hint: 'Only in exceptional cases' },
                    { key: 'Processing Operator', hint: 'Name(s), role(s), contact if needed' },
                    { key: 'Software(s)', hint: '' },
                    { key: 'Version(s)', hint: '' },
                    { key: 'Algorithm Parameters', hint: 'Not needed if processing report is available', multiline: true },
                    { key: 'Workflow Description', hint: 'Not needed if processing report is available', multiline: true },
                    { key: 'Model Details', hint: 'Coordinate system, scale, units, mesh density, texture resolution, file formats', multiline: true },
                    { key: 'Postprocessing Information', hint: 'Versions, iterations, changes during/after processing', multiline: true },
                    { key: 'Quality Summary', hint: 'e.g., polygon count, RMS error, completeness estimate, texture resolution', multiline: true },
                    { key: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                title: 'Paradata',
                fields: [
                    { key: 'Method Rationale', hint: 'Why was this capture method chosen? (e.g., object size, surface properties, time/budget, accuracy requirements)', multiline: true },
                    { key: 'Sources Consulted', hint: 'Publications, reports, excavation records, comparanda that informed decisions', multiline: true },
                    { key: 'Interpretive Decisions', hint: 'What is evidenced vs. hypothesised? Were conflicting sources resolved?', multiline: true },
                    { key: 'Known Limitations', hint: 'e.g., inaccessible areas, reflective surfaces, time constraints, incomplete coverage', multiline: true },
                    { key: 'Uncertainty Notes', hint: 'Per-region or general assessment of reliability and completeness', multiline: true },
                    { key: 'Additional Notes', hint: '', multiline: true }
                ]
            },
            {
                title: 'Legal',
                fields: [
                    { key: 'Project Lead', hint: 'Name(s), role(s), contact if needed' },
                    { key: 'Funding', hint: 'If applicable' },
                    { key: 'Copyright', hint: 'If applicable' },
                    { key: 'Acknowledgments', hint: 'If applicable', multiline: true }
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
 * @param {string} templateId - Template identifier
 * @returns {object|null} Metadata object with empty values, or null if template not found
 */
export function createEmptyMetadata(templateId = '3d-documentation') {
    const template = TEMPLATES[templateId];
    if (!template) return null;

    return {
        template: templateId,
        sections: template.sections.map(section => ({
            title: section.title,
            fields: section.fields.map(f => ({
                key: f.key,
                value: ''
            })),
            customFields: []
        }))
    };
}

/**
 * Looks up the template definition for a field to get its hint and multiline flag.
 * @param {string} templateId
 * @param {string} sectionTitle
 * @param {string} fieldKey
 * @returns {object|null} { hint, multiline } or null
 */
export function getFieldDefinition(templateId, sectionTitle, fieldKey) {
    const template = TEMPLATES[templateId];
    if (!template) return null;
    const section = template.sections.find(s => s.title === sectionTitle);
    if (!section) return null;
    const field = section.fields.find(f => f.key === fieldKey);
    return field || null;
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
