// MeshNotes Icon Registry
// Loads SVG icons from the icons/ directory and provides them to the UI.
//
// Usage:
//   import { loadIcons, initIcons, getIcon } from './ui/icons.js';
//   await loadIcons();   // fetch all SVGs (call once at startup)
//   initIcons();         // inject into DOM elements with [data-icon] attribute
//   getIcon('point');    // get SVG markup string by name

// Icon name → SVG filename mapping
// Variant choices: texture-v2, surface-v2, model-info-v2
const ICON_FILES = {
    // Toolbar - main buttons
    import:         'load-model-import.svg',
    texture:        'texture-v2.svg',
    point:          'point.svg',
    line:           'line.svg',
    polygon:        'polygon.svg',
    surface:        'surface-v2.svg',
    box:            'box.svg',
    measure:        'measure.svg',
    screenshot:     'screnshot.svg',
    export:         'download.svg',
    share:          'share.svg',
    settings:       'settings.svg',

    // Toolbar - dropdown items
    model3d:        'wireframe.svg',
    jsonld:         'json-ship-upload.svg',
    jsonldExport:   'json-ship-download.svg',
    pdfExport:      'pdf-download.svg',
    modelExport:    'wireframe.svg',

    // Sidebar
    eyeOpen:        'eye-open.svg',
    eyeClosed:      'eye-closed.svg',
    edit:           'pen.svg',

    // Metadata popup
    jsonDownload:   'json-download.svg',
    pdfDownload:    'pdf-download.svg',
    jsonUpload:     'json-upload.svg',

    // Misc UI
    copy:           'upload.svg',
    manualDownload: 'pdf-download.svg',
    mesh:           'mesh.svg',
    wireframe:      'wireframe.svg',
    color:          'color.svg',
    modelInfo:      'model-info-v2.svg',
};

// Cache for loaded SVG markup
const iconCache = {};

/**
 * Determine the base path to the icons/ directory.
 * Works for both root deployment and subdirectory (e.g. GitHub Pages /MeshNotes/).
 */
function getIconBasePath() {
    const scriptEl = document.querySelector('script[type="importmap"]');
    // Default: icons are in icons/ relative to the page
    return 'icons/';
}

/**
 * Load all SVG icons from the icons/ directory.
 * Call once at startup before using getIcon() or initIcons().
 */
export async function loadIcons() {
    const basePath = getIconBasePath();
    const entries = Object.entries(ICON_FILES);

    const results = await Promise.allSettled(
        entries.map(async ([name, file]) => {
            const resp = await fetch(basePath + file);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            let svg = await resp.text();
            // Inject inline sizing so icons render correctly even without CSS
            svg = svg.replace('<svg ', '<svg width="1em" height="1em" ');
            iconCache[name] = svg;
        })
    );

    // Log any failures without breaking the app
    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            console.warn(`Icon load failed: ${entries[i][0]} (${entries[i][1]})`, result.reason);
        }
    });
}

/**
 * Get SVG markup for an icon by name.
 * Returns the SVG string, or empty string if not loaded/found.
 * @param {string} name - Icon key from ICON_FILES
 * @returns {string} SVG markup
 */
export function getIcon(name) {
    return iconCache[name] || '';
}

/**
 * Initialize icons in the DOM.
 * Finds all elements with a [data-icon] attribute and injects the corresponding
 * SVG before the element's text content.
 *
 * Example: <button data-icon="point">Point</button>
 *       → <button data-icon="point"><svg ...></svg> Point</button>
 */
export function initIcons() {
    document.querySelectorAll('[data-icon]').forEach(el => {
        const iconName = el.dataset.icon;
        const svg = getIcon(iconName);
        if (svg) {
            const text = el.textContent.trim();
            // Preserve child form elements (e.g. hidden file input inside upload label)
            const formChild = el.querySelector('input, select, textarea');
            el.innerHTML = svg + (text ? ' ' + text : '');
            if (formChild) el.appendChild(formChild);
        }
    });
}
