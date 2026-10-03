// tests/lighting.test.js - Survey import settings: the six visible options and the remembered column mappings
// The settings module touches localStorage only when a function is called, so
// a small in-memory stand-in is enough. Loads the browser module through
// tests/support/app-env.js (lighting.js imports Three.js and state.js). The
// setters also write their Settings control, so the dom references they use
// are filled with plain stand-in objects.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/app-env.js';

class MemoryStorage {
    constructor() { this.map = new Map(); }
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
    setItem(key, value) { this.map.set(key, String(value)); }
    removeItem(key) { this.map.delete(key); }
    get length() { return this.map.size; }
    key(i) { return [...this.map.keys()][i] ?? null; }
}
globalThis.localStorage = new MemoryStorage();

const {
    getSurveyMappings, getSurveyMapping, saveSurveyMapping, SURVEY_MAPPINGS_MAX,
    SURVEY_SETTING_DEFAULTS, SURVEY_SETTING_OPTIONS, surveySettingChoice,
    setSurveyLockImported, setSurveyLabelsOffAbove, setSurveyResidualWarn, setSurveySurfaceWarn,
    setSurveySurfaceLimit, setSurveyPdfSummary, restoreSurveySettings, resetAllSettings
} = await import('../js/core/lighting.js');
const { state, dom } = await import('../js/state.js');
const { RESIDUAL_WARN_DEFAULT, SURFACE_WARN_DEFAULT, SELECTION_LIMIT_DEFAULT } = await import('../js/survey/rigid-fit.js');
const { LABELS_OFF_ABOVE_DEFAULT } = await import('../js/survey/survey-import.js');

// The state defaults as state.js declares them, before any test changes them.
const STATE_DEFAULTS = {
    lockImported: state.surveyLockImported,
    labelsOffAbove: state.surveyLabelsOffAbove,
    residualWarn: state.surveyResidualWarn,
    surfaceWarn: state.surveySurfaceWarn,
    surfaceLimit: state.surveySurfaceLimit,
    pdfSummary: state.surveyPdfSummary
};

// Every dom reference lighting.js uses gets a stand-in element, so the
// setters and resetAllSettings() can run; setBackgroundColor() (called by the
// reset) also needs a scene and document.querySelectorAll.
const fakeElement = () => ({
    value: '', checked: false, textContent: '', disabled: false, style: {},
    classList: { toggle() {}, add() {}, remove() {} }
});
const lightingSource = readFileSync(new URL('../js/core/lighting.js', import.meta.url), 'utf8');
for (const [, key] of lightingSource.matchAll(/\bdom\.(\w+)/g)) {
    if (!dom[key]) dom[key] = fakeElement();
}
state.scene = {};
globalThis.document ??= { querySelectorAll: () => [], documentElement: { style: { setProperty() {} } } };

const SURVEY_KEYS = {
    lockImported: 'meshnotes_surveyLockImported',
    labelsOffAbove: 'meshnotes_surveyLabelsOffAbove',
    residualWarn: 'meshnotes_surveyResidualWarn',
    surfaceWarn: 'meshnotes_surveySurfaceWarn',
    surfaceLimit: 'meshnotes_surveySurfaceLimit',
    pdfSummary: 'meshnotes_surveyPdfSummary'
};

function surveyState() {
    return {
        lockImported: state.surveyLockImported,
        labelsOffAbove: state.surveyLabelsOffAbove,
        residualWarn: state.surveyResidualWarn,
        surfaceWarn: state.surveySurfaceWarn,
        surfaceLimit: state.surveySurfaceLimit,
        pdfSummary: state.surveyPdfSummary
    };
}

function surveyControls() {
    return {
        lockImported: dom.settingsSurveyLockImported.checked,
        labelsOffAbove: dom.settingsSurveyLabelsOffAbove.value,
        residualWarn: dom.settingsSurveyResidualWarn.value,
        surfaceWarn: dom.settingsSurveySurfaceWarn.value,
        surfaceLimit: dom.settingsSurveySurfaceLimit.value,
        pdfSummary: dom.settingsSurveyPdfSummary.checked
    };
}

function setSurveyStateToDefaults() {
    Object.assign(state, {
        surveyLockImported: true, surveyLabelsOffAbove: 50, surveyResidualWarn: 0.05,
        surveySurfaceWarn: 0.10, surveySurfaceLimit: 0.5, surveyPdfSummary: true
    });
}

const KEY = 'meshnotes_surveyMappings';
const mapping = (easting) => ({ name: 0, easting, northing: easting + 1, height: easting + 2, description: null, code: null, extras: [9] });

beforeEach(() => { globalThis.localStorage = new MemoryStorage(); });

test('a mapping is remembered per header signature, newest first', () => {
    assert.deepEqual(getSurveyMappings(), []);
    assert.equal(getSurveyMapping('name|easting|northing'), null);

    const m = mapping(1);
    saveSurveyMapping('name|easting|northing', m);
    saveSurveyMapping('punkt|rechtswert|hochwert', mapping(4));
    assert.deepEqual(getSurveyMappings().map(e => e.signature), ['punkt|rechtswert|hochwert', 'name|easting|northing']);
    assert.deepEqual(getSurveyMapping('name|easting|northing'), m);
    assert.notEqual(getSurveyMapping('name|easting|northing').extras, m.extras);    // stored as a copy

    // Saving again replaces the entry and moves it to the front.
    saveSurveyMapping('name|easting|northing', mapping(2));
    assert.deepEqual(getSurveyMappings().map(e => e.signature), ['name|easting|northing', 'punkt|rechtswert|hochwert']);
    assert.equal(getSurveyMapping('name|easting|northing').easting, 2);
    assert.equal(typeof getSurveyMappings()[0].saved, 'string');

    // A file without a header (signature null) is not remembered.
    saveSurveyMapping(null, mapping(1));
    assert.equal(getSurveyMappings().length, 2);
    assert.equal(getSurveyMapping(null), null);
});

test('at most 20 headers are kept; the oldest go first', () => {
    assert.equal(SURVEY_MAPPINGS_MAX, 20);
    for (let i = 0; i < 25; i++) saveSurveyMapping(`header ${i}`, mapping(i));
    const list = getSurveyMappings();
    assert.equal(list.length, 20);
    assert.equal(list[0].signature, 'header 24');
    assert.equal(list[19].signature, 'header 5');
    assert.equal(getSurveyMapping('header 4'), null);
});

test('a corrupt or blocked store reads as empty and never throws', () => {
    localStorage.setItem(KEY, '{not json');
    assert.deepEqual(getSurveyMappings(), []);
    saveSurveyMapping('a|b|c', mapping(1));      // overwrites the corrupt value
    assert.equal(getSurveyMapping('a|b|c').easting, 1);

    localStorage.setItem(KEY, JSON.stringify({ signature: 'x' }));
    assert.deepEqual(getSurveyMappings(), []);
    localStorage.setItem(KEY, JSON.stringify([null, { signature: 'a' }, { signature: '', mapping: {} }, { signature: 'ok', mapping: { easting: 1 } }]));
    assert.deepEqual(getSurveyMappings().map(e => e.signature), ['ok']);

    globalThis.localStorage = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); }
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.deepEqual(getSurveyMappings(), []);
        assert.doesNotThrow(() => saveSurveyMapping('a|b|c', mapping(1)));
    } finally {
        console.warn = warn;
    }
});

// ============ The six visible survey settings ============

test('survey setting defaults agree with state.js, the survey constants and the Settings pane', () => {
    assert.deepEqual(STATE_DEFAULTS, { ...SURVEY_SETTING_DEFAULTS });
    assert.equal(SURVEY_SETTING_DEFAULTS.residualWarn, RESIDUAL_WARN_DEFAULT);
    assert.equal(SURVEY_SETTING_DEFAULTS.surfaceWarn, SURFACE_WARN_DEFAULT);
    assert.equal(SURVEY_SETTING_DEFAULTS.surfaceLimit, SELECTION_LIMIT_DEFAULT);
    assert.equal(SURVEY_SETTING_DEFAULTS.labelsOffAbove, LABELS_OFF_ABOVE_DEFAULT);

    // index.html: each select lists exactly the options, as String(number),
    // with the default selected; both checkboxes start checked.
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const selects = {
        labelsOffAbove: 'settings-survey-labels-off-above',
        residualWarn: 'settings-survey-residual-warn',
        surfaceWarn: 'settings-survey-surface-warn',
        surfaceLimit: 'settings-survey-surface-limit'
    };
    for (const [key, id] of Object.entries(selects)) {
        const block = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`));
        assert.ok(block, id);
        const options = [...block[1].matchAll(/<option value="([^"]*)"( selected)?>/g)];
        assert.deepEqual(options.map(m => m[1]), SURVEY_SETTING_OPTIONS[key].map(String), id);
        assert.deepEqual(options.filter(m => m[2]).map(m => m[1]), [String(SURVEY_SETTING_DEFAULTS[key])], id);
        assert.ok(SURVEY_SETTING_OPTIONS[key].includes(SURVEY_SETTING_DEFAULTS[key]), key);
    }
    assert.match(html, /<input type="checkbox" id="settings-survey-lock-imported" checked>/);
    assert.match(html, /<input type="checkbox" id="settings-survey-pdf-summary" checked>/);
});

test('surveySettingChoice accepts only the listed options', () => {
    const opts = SURVEY_SETTING_OPTIONS.residualWarn;
    assert.equal(surveySettingChoice('0.03', opts, 0.05), 0.03);
    assert.equal(surveySettingChoice(0.1, opts, 0.05), 0.1);
    assert.equal(surveySettingChoice('0.10', opts, 0.05), 0.1);
    assert.equal(surveySettingChoice('0.07', opts, 0.05), 0.05);
    assert.equal(surveySettingChoice('abc', opts, 0.05), 0.05);
    assert.equal(surveySettingChoice('', opts, 0.05), 0.05);
    assert.equal(surveySettingChoice(null, opts, 0.05), 0.05);
    assert.equal(surveySettingChoice(NaN, opts, 0.05), 0.05);
    assert.equal(surveySettingChoice('0', SURVEY_SETTING_OPTIONS.labelsOffAbove, 50), 0);
});

test('the survey setters write state (metres), localStorage and the Settings control', () => {
    setSurveyLockImported(false);
    setSurveyLabelsOffAbove('200');
    setSurveyResidualWarn('0.02');
    setSurveySurfaceWarn('0.5');
    setSurveySurfaceLimit('2');
    setSurveyPdfSummary(false);
    assert.deepEqual(surveyState(), {
        lockImported: false, labelsOffAbove: 200, residualWarn: 0.02, surfaceWarn: 0.5, surfaceLimit: 2, pdfSummary: false
    });
    assert.deepEqual(surveyControls(), {
        lockImported: false, labelsOffAbove: '200', residualWarn: '0.02', surfaceWarn: '0.5', surfaceLimit: '2', pdfSummary: false
    });
    assert.deepEqual(Object.fromEntries(Object.entries(SURVEY_KEYS).map(([k, key]) => [k, localStorage.getItem(key)])), {
        lockImported: 'false', labelsOffAbove: '200', residualWarn: '0.02', surfaceWarn: '0.5', surfaceLimit: '2', pdfSummary: 'false'
    });

    setSurveyLockImported(true);
    setSurveyPdfSummary(true);
    setSurveyLabelsOffAbove(0);                 // 0 = never hide
    assert.equal(localStorage.getItem(SURVEY_KEYS.lockImported), 'true');
    assert.equal(localStorage.getItem(SURVEY_KEYS.pdfSummary), 'true');
    assert.equal(state.surveyLabelsOffAbove, 0);
    assert.equal(dom.settingsSurveyLabelsOffAbove.value, '0');

    // A value that is not one of the options falls back to the default.
    setSurveyResidualWarn('0.07');
    setSurveySurfaceWarn('far');
    setSurveySurfaceLimit(-1);
    setSurveyLabelsOffAbove('51');
    assert.equal(state.surveyResidualWarn, 0.05);
    assert.equal(state.surveySurfaceWarn, 0.1);
    assert.equal(state.surveySurfaceLimit, 0.5);
    assert.equal(state.surveyLabelsOffAbove, 50);
    assert.equal(localStorage.getItem(SURVEY_KEYS.surfaceWarn), '0.1');
    assert.equal(dom.settingsSurveySurfaceLimit.value, '0.5');
});

test('restoreSurveySettings: missing keys keep the defaults, stored values come back', () => {
    setSurveyStateToDefaults();
    restoreSurveySettings();
    assert.deepEqual(surveyState(), { ...SURVEY_SETTING_DEFAULTS });
    assert.equal(localStorage.length, 0);           // nothing written for missing keys

    localStorage.setItem(SURVEY_KEYS.lockImported, 'false');
    localStorage.setItem(SURVEY_KEYS.labelsOffAbove, '0');
    localStorage.setItem(SURVEY_KEYS.residualWarn, '0.1');
    localStorage.setItem(SURVEY_KEYS.surfaceWarn, '0.05');
    localStorage.setItem(SURVEY_KEYS.surfaceLimit, '0.25');
    localStorage.setItem(SURVEY_KEYS.pdfSummary, 'false');
    restoreSurveySettings();
    assert.deepEqual(surveyState(), {
        lockImported: false, labelsOffAbove: 0, residualWarn: 0.1, surfaceWarn: 0.05, surfaceLimit: 0.25, pdfSummary: false
    });
    assert.deepEqual(surveyControls(), {
        lockImported: false, labelsOffAbove: '0', residualWarn: '0.1', surfaceWarn: '0.05', surfaceLimit: '0.25', pdfSummary: false
    });
});

test('restoreSurveySettings: invalid stored values', () => {
    setSurveyStateToDefaults();
    localStorage.setItem(SURVEY_KEYS.labelsOffAbove, 'lots');        // not a number: skipped
    localStorage.setItem(SURVEY_KEYS.residualWarn, '');              // empty: skipped
    localStorage.setItem(SURVEY_KEYS.surfaceWarn, '0.15');           // not an option: the default
    localStorage.setItem(SURVEY_KEYS.surfaceLimit, '5');             // not an option: the default
    localStorage.setItem(SURVEY_KEYS.lockImported, 'yes');           // calloutEnabled pattern: only 'true' is on
    localStorage.setItem(SURVEY_KEYS.pdfSummary, 'true');
    restoreSurveySettings();
    assert.deepEqual(surveyState(), {
        lockImported: false, labelsOffAbove: 50, residualWarn: 0.05, surfaceWarn: 0.1, surfaceLimit: 0.5, pdfSummary: true
    });
    assert.equal(localStorage.getItem(SURVEY_KEYS.surfaceWarn), '0.1');     // corrected in storage
    assert.equal(localStorage.getItem(SURVEY_KEYS.surfaceLimit), '0.5');
    assert.equal(localStorage.getItem(SURVEY_KEYS.labelsOffAbove), 'lots'); // a skipped value is left alone
});

test('resetAllSettings restores the six survey defaults and forgets the mappings', () => {
    setSurveyLockImported(false);
    setSurveyLabelsOffAbove(500);
    setSurveyResidualWarn(0.1);
    setSurveySurfaceWarn(0.2);
    setSurveySurfaceLimit(1);
    setSurveyPdfSummary(false);
    saveSurveyMapping('name|easting|northing', mapping(1));
    localStorage.setItem('other_app_key', 'kept');

    resetAllSettings();
    assert.deepEqual(surveyState(), { ...SURVEY_SETTING_DEFAULTS });
    assert.deepEqual(surveyControls(), {
        lockImported: true, labelsOffAbove: '50', residualWarn: '0.05', surfaceWarn: '0.1', surfaceLimit: '0.5', pdfSummary: true
    });
    for (const key of Object.values(SURVEY_KEYS)) assert.equal(localStorage.getItem(key), null, key);
    assert.deepEqual(getSurveyMappings(), []);
    assert.equal(localStorage.getItem('other_app_key'), 'kept');
});
