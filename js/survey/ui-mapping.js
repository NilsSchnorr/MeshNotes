// js/survey/ui-mapping.js - The survey CSV mapping dialog (Step A): file settings, preview, columns, target and checks
// Opened from Import > Survey points (CSV). Reads the file, detects its format
// (each setting can be overridden), previews the first rows, maps the columns,
// chooses the target alignment and group, and lists the blocking errors and
// warnings. Continue builds an import job and hands it on:
// - existing alignment: importIntoAlignment(job), the selection step in ui-manager.js
// - new alignment: startNewAlignment(job), the picking panel in
//   ui-alignment.js (startNewAlignmentPending() is only the unwired default)
// Both callbacks are set from main.js (setSurveyMappingCallbacks), so this
// module imports no other survey UI. The dialog closes before a callback
// runs; reopenSurveyMapping(job) brings it back with the job's choices.
//
// Import job, the hand-off object (also what reopenSurveyMapping takes):
//   { file: { name, size, sha256 },   // sha256: hex of the CSV bytes, null without crypto.subtle
//     bytes,                          // the file's ArrayBuffer, to parse it again
//     overrides: { encoding, delimiter, decimal, hasHeader },  // 'auto' (hasHeader null) = detected
//     parsed,                         // parseSurveyCsv() result
//     decimal,                        // decimal separator used for the numbers
//     preset, mapping,                // column-mapping.js mapping (column indices)
//     signature,                      // headerSignature(parsed.rawHeaders), null without a header
//     records, skipped,               // buildRecords() valid and skipped rows
//     codeColumn, heightColumn,       // header names of the Code and Height columns (codeColumn may be null)
//     target: { kind: 'existing', alignmentId } | { kind: 'new', name, crsLabel },
//     group: { kind: 'new', name } | { kind: 'existing', groupId },
//     heightAccepted,                 // key of a height-column mismatch the user chose to use anyway
//     acceptedWarnings }              // messages for the summary (binding warnings, height mismatch)
//
// Cells, headers, the file name and messages that quote them come from the
// file: the dialog is built with createElement and textContent only.

import { state, dom } from '../state.js';
import { showStatus } from '../utils/helpers.js';
import { getSurveyMapping } from '../core/lighting.js';
import { DELIMITERS, DECIMALS, ENCODINGS, parseNumber } from './csv-parse.js';
import {
    parseSurveyCsv, autoMap, applyPreset, detectPreset, buildRecords, checkMapping, heightColumnMismatch,
    swapMappingEN, headerSignature, isPersonalDataHeader, emptyMapping,
    PRESETS, MAPPING_ROLES, REQUIRED_ROLES, MAPPING_WARNINGS
} from './column-mapping.js';
import { bindingWarnings, crsDisplayLabel } from './alignment.js';
import { MIN_CONTROL_POINTS } from './rigid-fit.js';
import { findAlignment, formatMetres } from './survey-display.js';
import { sha256Hex, fileBaseName, uniqueGroupName, sanitizeMapping } from './survey-import.js';

// Rows shown in the preview table
const PREVIEW_ROWS = 10;

// Short role names for the badges above the preview columns
const ROLE_BADGES = { name: 'Name', easting: 'E', northing: 'N', height: 'H', description: 'Description', code: 'Code' };

// The dialog's working state while it is open (see the job shape above, plus
// dialog-only fields: built, check, remembered, notice, newName, newCrs).
let _ctx = null;

// Late-bound next steps (main.js)
let _importIntoAlignment = null;
let _startNewAlignment = startNewAlignmentPending;

export function setSurveyMappingCallbacks({ importIntoAlignment, startNewAlignment } = {}) {
    if (importIntoAlignment) _importIntoAlignment = importIntoAlignment;
    if (startNewAlignment) _startNewAlignment = startNewAlignment;
}

// ============ Small helpers ============

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function fillSelect(select, options, value) {
    select.textContent = '';
    for (const o of options) {
        const option = document.createElement('option');
        option.value = o.value;
        option.textContent = o.label;
        select.appendChild(option);
    }
    select.value = value;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isIndex = (j) => Number.isInteger(j) && j >= 0;
const indexValue = (j) => (isIndex(j) ? String(j) : '');
const labelOf = (list, id) => (list.find(o => o.id === id) || {}).label || '';

function formatBytes(bytes) {
    if (!(bytes >= 0)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function roleSelects() {
    return {
        name: dom.surveyMapName,
        easting: dom.surveyMapEasting,
        northing: dom.surveyMapNorthing,
        height: dom.surveyMapHeight,
        description: dom.surveyMapDescription,
        code: dom.surveyMapCode
    };
}

// The alignment chosen as target, or null (new alignment, or it is gone).
function targetAlignment(ctx) {
    return ctx.target.kind === 'existing' ? findAlignment(state.alignments, ctx.target.alignmentId) : null;
}

// The default alignment, else the first one, else a new alignment.
function defaultTarget() {
    const preferred = findAlignment(state.alignments, state.defaultAlignmentId) || state.alignments[0] || null;
    return preferred ? { kind: 'existing', alignmentId: preferred.id } : { kind: 'new' };
}

// ============ Parsing and mapping ============

function parseInto(ctx) {
    const o = ctx.overrides;
    ctx.parsed = parseSurveyCsv(ctx.bytes, { encoding: o.encoding, delimiter: o.delimiter, decimal: o.decimal, hasHeader: o.hasHeader });
    ctx.decimal = ctx.parsed.decimal;
    ctx.signature = headerSignature(ctx.parsed.rawHeaders);
}

const headersKey = (parsed) => JSON.stringify([parsed.hasHeader, parsed.headers]);

// The preset that fits the file, replaced by the remembered mapping of the
// same header when there is one; then the target alignment's height column.
function applyInitialMapping(ctx) {
    const p = ctx.parsed;
    const options = { hasHeader: p.hasHeader, decimal: ctx.decimal };
    ctx.preset = detectPreset(p.headers, p.rows, options);
    ctx.mapping = applyPreset(ctx.preset, p.headers, p.rows, options) || autoMap(p.headers, p.rows, options);
    const remembered = sanitizeMapping(getSurveyMapping(ctx.signature), p.headers.length);
    ctx.remembered = !!remembered;
    if (remembered) {
        ctx.mapping = remembered;
        ctx.preset = 'custom';
    }
    preselectAlignmentHeight(ctx);
}

// When the target alignment's height column is in the file, it becomes the
// Height column (unless that column already has another role).
function preselectAlignmentHeight(ctx) {
    const a = targetAlignment(ctx);
    if (!a || !a.heightColumn) return;
    const j = ctx.parsed.headers.findIndex(h => !heightColumnMismatch(a.heightColumn, h));
    if (j < 0 || MAPPING_ROLES.some(role => ctx.mapping[role] === j)) return;
    ctx.mapping = { ...ctx.mapping, height: j, extras: ctx.mapping.extras.filter(x => x !== j) };
}

// Records and checks for the current choices.
function compute(ctx) {
    const p = ctx.parsed;
    const m = ctx.mapping;
    const n = p.headers.length;
    const chosen = REQUIRED_ROLES.map(role => m[role]);
    const ready = chosen.every(j => isIndex(j) && j < n) && new Set(chosen).size === chosen.length;
    ctx.built = ready ? buildRecords(p.rows, m, { decimal: ctx.decimal, headers: p.headers }) : null;
    ctx.check = n > 0
        ? checkMapping({ headers: p.headers, rows: p.rows, mapping: m, decimal: ctx.decimal, newAlignment: ctx.target.kind === 'new', records: ctx.built })
        : null;
}

// The height-column mismatch with the target alignment, or null.
function heightMismatch(ctx) {
    const a = targetAlignment(ctx);
    if (!a || !isIndex(ctx.mapping.height)) return null;
    const header = ctx.parsed.headers[ctx.mapping.height];
    const warning = heightColumnMismatch(a.heightColumn, header);
    return warning ? { ...warning, key: `${a.id}|${header}` } : null;
}

// Every message for the Checks list, and whether Continue is blocked.
function collectIssues(ctx) {
    const items = [];
    const p = ctx.parsed;
    let blocking = p.headers.length === 0 || !ctx.built;

    if (ctx.notice) items.push({ level: 'notice', text: ctx.notice });
    for (const e of p.errors) items.push({ level: 'error', text: e.message });
    if (ctx.check) for (const e of ctx.check.errors) items.push({ level: 'error', text: e.message });
    if (p.errors.length || (ctx.check && ctx.check.errors.length)) blocking = true;

    const a = targetAlignment(ctx);
    if (ctx.target.kind === 'existing' && !a) {
        items.push({ level: 'error', text: 'The chosen alignment no longer exists. Choose another one.' });
        blocking = true;
    }
    const mismatch = heightMismatch(ctx);
    if (mismatch && ctx.heightAccepted === mismatch.key) {
        items.push({ level: 'warning', text: `Using "${mismatch.actual}" anyway, although the alignment was made with "${mismatch.expected}".` });
    } else if (mismatch) {
        items.push({
            level: 'warning',
            text: mismatch.message,
            actions: [{ id: 'new-alignment', label: 'Create a new alignment' }, { id: 'use-anyway', label: 'Use anyway' }]
        });
        blocking = true;
    }
    if (a) {
        for (const w of bindingWarnings(a, { modelHash: state.modelHash, modelUpAxis: state.modelUpAxis })) {
            items.push({ level: 'warning', text: w.message });
        }
    }
    for (const w of p.warnings) items.push({ level: 'warning', text: w.message });
    if (ctx.check) {
        for (const w of ctx.check.warnings) {
            const item = { level: 'warning', text: w.message };
            if (w.code === MAPPING_WARNINGS.SWAP_SUSPECTED) item.actions = [{ id: 'swap', label: 'Swap Easting and Northing' }];
            items.push(item);
        }
    }
    if (ctx.remembered) items.push({ level: 'notice', text: 'The column mapping of your last import with the same header is preselected.' });
    for (const n of p.notices) items.push({ level: 'notice', text: n.message });
    if (!items.some(i => i.level === 'error' || i.level === 'warning')) {
        items.splice(ctx.notice ? 1 : 0, 0, { level: 'ok', text: 'No problems found.' });
    }
    return { items, blocking };
}

// ============ Rendering ============

function renderHeader() {
    const f = _ctx.file;
    dom.surveyMappingFile.textContent = [f.name, formatBytes(f.size)].filter(Boolean).join(' · ');
}

function renderFileSettings() {
    const ctx = _ctx;
    const d = ctx.parsed.detected;
    const auto = (label) => (label ? `Auto (${label})` : 'Auto');
    fillSelect(dom.surveyMappingEncoding,
        [{ value: 'auto', label: auto(labelOf(ENCODINGS, d.encoding) || d.encoding) }, ...ENCODINGS.map(o => ({ value: o.id, label: o.label }))],
        ctx.overrides.encoding);
    fillSelect(dom.surveyMappingDelimiter,
        [{ value: 'auto', label: auto(labelOf(DELIMITERS, d.delimiter)) }, ...DELIMITERS.map(o => ({ value: o.id, label: o.label }))],
        ctx.overrides.delimiter);
    const decimalAuto = labelOf(DECIMALS, d.decimal) + (d.decimalAmbiguous ? ', unsure' : '');
    fillSelect(dom.surveyMappingDecimal,
        [{ value: 'auto', label: auto(decimalAuto) }, ...DECIMALS.map(o => ({ value: o.id, label: o.label }))],
        ctx.overrides.decimal);
    dom.surveyMappingHeader.checked = ctx.parsed.hasHeader;
}

function renderRoleSelects() {
    const ctx = _ctx;
    const options = [{ value: '', label: '—' }, ...ctx.parsed.headers.map((h, j) => ({ value: String(j), label: h }))];
    for (const [role, select] of Object.entries(roleSelects())) fillSelect(select, options, indexValue(ctx.mapping[role]));
    fillSelect(dom.surveyMappingPreset, PRESETS.map(p => ({ value: p.id, label: p.label })), ctx.preset);
}

function renderCounts() {
    const ctx = _ctx;
    const p = ctx.parsed;
    const parts = [];
    if (p.rows.length) parts.push(`${plural(p.rows.length, 'data row')}, ${plural(p.columnCount, 'column')}`);
    if (ctx.built) {
        const skipped = ctx.built.skipped.length;
        parts.push(`${ctx.built.valid.length} with valid coordinates${skipped ? `, ${skipped} skipped` : ''}`);
    }
    if (p.rows.length > PREVIEW_ROWS) parts.push(`first ${PREVIEW_ROWS} shown`);
    dom.surveyMappingCounts.textContent = parts.join(' · ');
}

// The first rows with the mapped columns marked; cells of the Easting,
// Northing and Height columns that are not numbers are tinted.
function renderPreview() {
    const ctx = _ctx;
    const p = ctx.parsed;
    const m = ctx.mapping;
    const wrap = dom.surveyMappingPreview;
    const scroll = [wrap.scrollLeft, wrap.scrollTop];
    wrap.textContent = '';
    if (!p.headers.length) {
        wrap.appendChild(el('p', 'survey-hint', 'Nothing to preview.'));
        return;
    }
    const roles = new Map();
    for (const role of MAPPING_ROLES) {
        if (isIndex(m[role])) roles.set(m[role], [...(roles.get(m[role]) || []), role]);
    }
    const coordinate = new Set([m.easting, m.northing, m.height].filter(isIndex));

    const table = el('table', 'survey-table');
    const headRow = document.createElement('tr');
    headRow.appendChild(el('th', 'survey-num', 'Row'));
    p.headers.forEach((h, j) => {
        const th = el('th', roles.has(j) ? 'survey-col-mapped' : '');
        for (const role of roles.get(j) || []) th.appendChild(el('span', 'survey-role-badge', ROLE_BADGES[role]));
        th.appendChild(document.createTextNode(h));
        th.title = h;
        headRow.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const r of p.rows.slice(0, PREVIEW_ROWS)) {
        const tr = document.createElement('tr');
        tr.appendChild(el('td', 'survey-num', String(r.row)));
        r.cells.forEach((cell, j) => {
            const classes = [];
            if (roles.has(j)) classes.push('survey-col-mapped');
            if (coordinate.has(j) && Number.isNaN(parseNumber(cell, ctx.decimal))) classes.push('survey-cell-bad');
            const td = el('td', classes.join(' '), cell.replace(/\s*\r?\n\s*/g, ' ↵ '));
            if (cell) td.title = cell;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    [wrap.scrollLeft, wrap.scrollTop] = scroll;
}

// Checkboxes for the columns without a role. Personal-data columns are
// marked; checkMapping() warns when one is ticked.
function renderExtras() {
    const ctx = _ctx;
    const m = ctx.mapping;
    const mapped = new Set(MAPPING_ROLES.map(role => m[role]).filter(isIndex));
    const container = dom.surveyMappingExtras;
    container.textContent = '';
    let personal = 0;
    ctx.parsed.headers.forEach((h, j) => {
        if (mapped.has(j)) return;
        const label = el('label', 'survey-check-label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = String(j);
        box.checked = m.extras.includes(j);
        label.appendChild(box);
        label.appendChild(el('span', '', h));
        if (isPersonalDataHeader(h)) {
            label.appendChild(el('span', 'survey-tag', 'personal data'));
            personal++;
        }
        container.appendChild(label);
    });
    const hints = [];
    if (container.childElementCount) hints.push('Ticked columns are stored with every point and exported with it.');
    if (personal) hints.push('Columns that may hold personal data are not ticked by default.');
    if (isIndex(m.code)) hints.push('The Code column is kept as an attribute too.');
    dom.surveyMappingExtrasHint.textContent = hints.join(' ');
}

function renderTarget() {
    const ctx = _ctx;
    const list = state.alignments;
    const options = list.map(a => ({ value: String(a.id), label: `${a.name || 'Unnamed alignment'} (${crsDisplayLabel(a)})` }));
    options.push({ value: 'new', label: 'New alignment…' });
    const a = targetAlignment(ctx);
    fillSelect(dom.surveyMappingTarget, options, a ? String(a.id) : 'new');

    let info;
    if (a) {
        const enabled = (a.controlPoints || []).filter(cp => cp.enabled !== false).length;
        const parts = [`Height column: ${a.heightColumn || 'not recorded'}`, plural(enabled, 'control point')];
        if (a.quality && Number.isFinite(a.quality.rms)) parts.push(`RMS ${formatMetres(a.quality.rms)}`);
        if (a.id === state.defaultAlignmentId) parts.push('default');
        info = parts.join(' · ');
    } else if (list.length) {
        info = `A new alignment is made by picking at least ${MIN_CONTROL_POINTS} rows of the file as control points on the model.`;
    } else {
        info = `This model has no alignment yet. A new alignment is made by picking at least ${MIN_CONTROL_POINTS} rows of the file as control points on the model.`;
    }
    dom.surveyMappingTargetInfo.textContent = info;
    dom.surveyMappingNewFields.style.display = a ? 'none' : '';
    dom.surveyMappingNewName.value = ctx.newName;
    dom.surveyMappingNewCrs.value = ctx.newCrs;
}

function renderGroupSelect() {
    const ctx = _ctx;
    const base = fileBaseName(ctx.file.name);
    const options = [
        { value: 'new', label: `New group "${uniqueGroupName(base, state.groups)}"` },
        ...state.groups.map(g => ({ value: String(g.id), label: g.name || 'Unnamed group' }))
    ];
    const existing = ctx.group.kind === 'existing' && state.groups.some(g => g.id === ctx.group.groupId);
    fillSelect(dom.surveyMappingGroup, options, existing ? String(ctx.group.groupId) : 'new');
}

function renderIssues() {
    const ctx = _ctx;
    const { items, blocking } = collectIssues(ctx);
    const list = dom.surveyMappingIssues;
    list.textContent = '';
    for (const item of items) {
        const li = el('li', `survey-issue ${item.level}`);
        li.appendChild(el('span', 'survey-issue-text', item.text));
        for (const action of item.actions || []) {
            const button = el('button', 'btn-cancel btn-small', action.label);
            button.type = 'button';
            button.dataset.action = action.id;
            li.appendChild(button);
        }
        list.appendChild(li);
    }
    dom.surveyMappingContinue.disabled = blocking;
    dom.surveyMappingContinue.textContent = ctx.target.kind === 'new' ? 'Continue: pick control points' : 'Continue';
}

// Recomputes the records and checks, then redraws what depends on them.
function refresh({ preview = true, extras = true } = {}) {
    compute(_ctx);
    renderCounts();
    if (preview) renderPreview();
    if (extras) renderExtras();
    renderIssues();
}

function renderAll() {
    renderHeader();
    renderFileSettings();
    renderRoleSelects();
    renderTarget();
    renderGroupSelect();
    refresh();
}

// ============ Events ============

function reparse() {
    const ctx = _ctx;
    const before = headersKey(ctx.parsed);
    parseInto(ctx);
    if (headersKey(ctx.parsed) !== before) {
        ctx.heightAccepted = null;
        applyInitialMapping(ctx);
    }
    renderFileSettings();
    renderRoleSelects();
    refresh();
}

function onFormatSelectChange() {
    if (!_ctx) return;
    _ctx.overrides = {
        ..._ctx.overrides,
        encoding: dom.surveyMappingEncoding.value,
        delimiter: dom.surveyMappingDelimiter.value,
        decimal: dom.surveyMappingDecimal.value
    };
    reparse();
}

function onHeaderChange() {
    if (!_ctx) return;
    _ctx.overrides = { ..._ctx.overrides, hasHeader: dom.surveyMappingHeader.checked };
    reparse();
}

function onPresetChange() {
    const ctx = _ctx;
    if (!ctx) return;
    const p = ctx.parsed;
    const mapping = applyPreset(dom.surveyMappingPreset.value, p.headers, p.rows, { hasHeader: p.hasHeader, decimal: ctx.decimal });
    ctx.preset = dom.surveyMappingPreset.value;
    if (mapping) ctx.mapping = mapping;
    renderRoleSelects();
    refresh();
}

function onRoleChange(e) {
    const ctx = _ctx;
    if (!ctx) return;
    const role = e.target.dataset.role;
    const j = e.target.value === '' ? null : parseInt(e.target.value, 10);
    ctx.mapping = { ...ctx.mapping, [role]: j, extras: ctx.mapping.extras.filter(x => x !== j) };
    ctx.preset = 'custom';
    dom.surveyMappingPreset.value = 'custom';
    refresh();
}

function onExtrasChange(e) {
    const ctx = _ctx;
    if (!ctx || e.target.type !== 'checkbox') return;
    const j = parseInt(e.target.value, 10);
    const rest = ctx.mapping.extras.filter(x => x !== j);
    ctx.mapping = { ...ctx.mapping, extras: e.target.checked ? [...rest, j].sort((a, b) => a - b) : rest };
    ctx.preset = 'custom';
    dom.surveyMappingPreset.value = 'custom';
    // The preview and the checkboxes do not change, and redrawing them would
    // lose their scroll positions.
    refresh({ preview: false, extras: false });
}

function onTargetChange() {
    const ctx = _ctx;
    if (!ctx) return;
    const value = dom.surveyMappingTarget.value;
    const a = state.alignments.find(x => String(x.id) === value);
    ctx.notice = null;
    if (a || value === 'new') {
        ctx.target = a ? { kind: 'existing', alignmentId: a.id } : { kind: 'new' };
    } else {
        // The list can be older than the session (an import while the dialog
        // is open): an alignment that is gone is redrawn away, not read as 'new'.
        ctx.notice = 'That alignment no longer exists. The list has been updated.';
        if (ctx.target.kind !== 'new' && !targetAlignment(ctx)) ctx.target = defaultTarget();
    }
    preselectAlignmentHeight(ctx);
    renderTarget();
    renderGroupSelect();
    renderRoleSelects();
    refresh();
}

function onGroupChange() {
    const ctx = _ctx;
    if (!ctx) return;
    const value = dom.surveyMappingGroup.value;
    const g = state.groups.find(x => String(x.id) === value);
    ctx.group = g ? { kind: 'existing', groupId: g.id } : { kind: 'new' };
    // A group deleted while the dialog is open: redraw the list.
    if (!g && value !== 'new') renderGroupSelect();
}

function onIssueAction(e) {
    const button = e.target.closest('button[data-action]');
    const ctx = _ctx;
    if (!button || !ctx) return;
    const action = button.dataset.action;
    if (action === 'swap') {
        ctx.mapping = swapMappingEN(ctx.mapping);
        ctx.preset = 'custom';
        renderRoleSelects();
        refresh();
    } else if (action === 'new-alignment') {
        ctx.target = { kind: 'new' };
        renderTarget();
        refresh({ preview: false, extras: false });
    } else if (action === 'use-anyway') {
        const mismatch = heightMismatch(ctx);
        ctx.heightAccepted = mismatch ? mismatch.key : null;
        refresh({ preview: false, extras: false });
    }
}

// The import job for the current choices (see the shape at the top).
function buildJob(ctx) {
    const p = ctx.parsed;
    const m = ctx.mapping;
    const a = targetAlignment(ctx);
    const acceptedWarnings = [];
    if (a) {
        for (const w of bindingWarnings(a, { modelHash: state.modelHash, modelUpAxis: state.modelUpAxis })) acceptedWarnings.push(w.message);
    }
    const mismatch = heightMismatch(ctx);
    if (mismatch) acceptedWarnings.push(`Height column "${mismatch.actual}" used, although the alignment was made with "${mismatch.expected}".`);
    const base = fileBaseName(ctx.file.name);
    return {
        file: { ...ctx.file },
        bytes: ctx.bytes,
        overrides: { ...ctx.overrides },
        parsed: p,
        decimal: ctx.decimal,
        preset: ctx.preset,
        mapping: { ...m, extras: [...m.extras] },
        signature: ctx.signature,
        records: ctx.built.valid,
        skipped: ctx.built.skipped,
        codeColumn: isIndex(m.code) ? p.headers[m.code] : null,
        heightColumn: p.headers[m.height],
        target: a
            ? { kind: 'existing', alignmentId: a.id }
            : { kind: 'new', name: ctx.newName.trim() || base, crsLabel: ctx.newCrs.trim() },
        group: ctx.group.kind === 'existing' && state.groups.some(g => g.id === ctx.group.groupId)
            ? { kind: 'existing', groupId: ctx.group.groupId }
            : { kind: 'new', name: base },
        heightAccepted: ctx.heightAccepted,
        acceptedWarnings
    };
}

function continueImport() {
    const ctx = _ctx;
    if (!ctx) return;
    compute(ctx);
    if (collectIssues(ctx).blocking) {
        renderIssues();
        return;
    }
    if (!state.currentModel) {
        ctx.notice = 'Load a model before importing survey points.';
        renderIssues();
        return;
    }
    const job = buildJob(ctx);
    const next = job.target.kind === 'existing' ? _importIntoAlignment : _startNewAlignment;
    if (!next) return;
    closeSurveyMapping();
    next(job);
}

// ============ Opening and closing ============

export function initSurveyMapping() {
    dom.surveyMappingClose.addEventListener('click', closeSurveyMapping);
    dom.surveyMappingCancel.addEventListener('click', closeSurveyMapping);
    dom.surveyMappingContinue.addEventListener('click', continueImport);
    [dom.surveyMappingEncoding, dom.surveyMappingDelimiter, dom.surveyMappingDecimal]
        .forEach(select => select.addEventListener('change', onFormatSelectChange));
    dom.surveyMappingHeader.addEventListener('change', onHeaderChange);
    dom.surveyMappingPreset.addEventListener('change', onPresetChange);
    Object.values(roleSelects()).forEach(select => select.addEventListener('change', onRoleChange));
    dom.surveyMappingExtras.addEventListener('change', onExtrasChange);
    dom.surveyMappingTarget.addEventListener('change', onTargetChange);
    dom.surveyMappingGroup.addEventListener('change', onGroupChange);
    dom.surveyMappingNewName.addEventListener('input', () => { if (_ctx) _ctx.newName = dom.surveyMappingNewName.value; });
    dom.surveyMappingNewCrs.addEventListener('input', () => { if (_ctx) _ctx.newCrs = dom.surveyMappingNewCrs.value; });
    dom.surveyMappingIssues.addEventListener('click', onIssueAction);
}

function show() {
    renderAll();
    dom.surveyMappingOverlay.classList.add('visible');
    dom.surveyMappingOverlay.querySelector('.survey-dialog-body').scrollTop = 0;
    dom.surveyMappingClose.focus({ preventScroll: true });
}

/**
 * Reads a CSV file and opens the mapping dialog for it.
 * @param {File} file
 */
export async function openSurveyCsvFile(file) {
    if (!file) return;
    if (!state.currentModel) {
        showStatus('Load a model before importing survey points');
        return;
    }
    let bytes;
    try {
        bytes = await file.arrayBuffer();
    } catch (e) {
        console.error('Survey CSV could not be read:', e);
        showStatus('Could not read the file');
        return;
    }
    const sha256 = await sha256Hex(bytes);
    const ctx = {
        file: { name: file.name, size: file.size, sha256 },
        bytes,
        overrides: { encoding: 'auto', delimiter: 'auto', decimal: 'auto', hasHeader: null },
        parsed: null, decimal: '.', preset: 'auto', mapping: emptyMapping(), signature: null,
        target: defaultTarget(),
        group: { kind: 'new' },
        heightAccepted: null,
        remembered: false,
        notice: null,
        newName: fileBaseName(file.name),
        newCrs: ''
    };
    parseInto(ctx);
    _ctx = ctx;
    applyInitialMapping(ctx);
    show();
}

/**
 * Opens the dialog again with an import job's choices (Back from the
 * selection step, or a notice from a later step).
 * @param {object} job - see the shape at the top of this file
 * @param {{notice?: string|null}} [options] - notice: shown first in the Checks list
 */
export function reopenSurveyMapping(job, { notice = null } = {}) {
    if (!job) return;
    const isNew = job.target.kind === 'new';
    const ctx = {
        file: { ...job.file },
        bytes: job.bytes,
        overrides: { ...job.overrides },
        parsed: job.parsed,
        decimal: job.decimal,
        preset: job.preset,
        mapping: { ...job.mapping, extras: [...job.mapping.extras] },
        signature: job.signature,
        target: isNew ? { kind: 'new' } : { ...job.target },
        group: { ...job.group },
        heightAccepted: job.heightAccepted || null,
        remembered: false,
        notice,
        newName: isNew ? job.target.name : fileBaseName(job.file.name),
        newCrs: isNew ? job.target.crsLabel : ''
    };
    if (!isNew && !targetAlignment(ctx)) ctx.target = defaultTarget();
    _ctx = ctx;
    show();
}

export function isSurveyMappingOpen() {
    return dom.surveyMappingOverlay.classList.contains('visible');
}

export function closeSurveyMapping() {
    dom.surveyMappingOverlay.classList.remove('visible');
    _ctx = null;
}

// The model hash arrives after loading (state.modelHash is null until then):
// redraw the checks so a binding warning appears once it is known.
export function refreshSurveyMappingBinding() {
    if (_ctx && isSurveyMappingOpen()) renderIssues();
}

/**
 * Default of the new-alignment callback until main.js wires the picking
 * panel (ui-alignment.js startAlignmentPicking): reopens the dialog with the
 * job and says so.
 * @param {object} job
 */
export function startNewAlignmentPending(job) {
    const target = job.target.kind === 'new' ? job.target : { kind: 'new', name: fileBaseName(job.file.name), crsLabel: '' };
    reopenSurveyMapping({ ...job, target }, {
        notice: state.alignments.length
            ? 'Picking control points for a new alignment is not available yet. For now, choose an existing alignment of this model.'
            : 'Picking control points for a new alignment is not available yet, and this model has no alignment: survey points cannot be imported into it yet.'
    });
}
