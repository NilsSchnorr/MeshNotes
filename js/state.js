// js/state.js - Central state management
import * as THREE from 'three';

// ============ Application State ============
export const state = {
    // Scene
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    perspectiveCamera: null,
    orthographicCamera: null,
    isOrthographic: false,

    // ViewHelper
    viewHelper: null,
    viewHelperRenderer: null,
    clock: new THREE.Clock(),

    // Lighting & Background
    ambientLight: null,
    dirLight1: null,
    dirLight2: null,
    lightFollowsCamera: true,
    fixedLightAzimuth: 0,
    fixedLightElevation: 45,
    backgroundColor: '#041D31',

    // Model
    currentModel: null,
    modelFileName: '',
    originalMaterials: new Map(),
    displayMode: 'texture', // 'texture', 'vertexColors', 'gray', 'wireframe'
    hasVertexColors: false,
    modelOpacity: 1.0,
    modelMeshes: [],
    modelBoundingSize: 1,
    modelUpAxis: 'z-up', // 'y-up' or 'z-up'

    // UI Multipliers
    pointSizeMultiplier: 1.0,
    textSizeMultiplier: 1.0,
    
    // User preferences
    defaultAuthor: '',
    measurementUnit: 'units',
    measurementLineColor: '#AA8101',
    measurementPointColor: '#FFFFFF',
    
    // PDF export settings
    pdfTitle: '',
    pdfInstitution: '',
    pdfProject: '',
    pdfAccentColor: '#AA8101',
    pdfPageSize: 'a4',
    pdfOrientation: 'portrait',
    pdfDpi: 150,

    // Tools
    currentTool: null, // 'point', 'line', 'polygon', 'surface', 'box', 'measure'
    tempPoints: [],
    tempProjectedEdges: [],
    tempLine: null,

    // Surface projection settings
    surfaceProjectionEnabled: true,
    projectionDeviationRelative: 0.20,
    projectionDeviationAbsolute: 0.03,

    // Measurements
    measurePoints: [],
    measureMarkers: [],
    measureLine: null,
    measureLabel: null,  // Live distance label during multi-point measurement
    measurements: [],
    isMultiPointMeasure: false,  // Whether currently in multi-point measurement mode

    // Data
    groups: [],
    annotations: [],
    selectedAnnotation: null,
    editingAnnotation: null,

    // Model Information
    modelInfo: { entries: [] },
    editingModelInfo: false,

    // Point dragging
    isDraggingPoint: false,
    draggedAnnotation: null,
    draggedPointIndex: -1,
    draggedMarker: null,
    wasDragging: false,
    pendingPointPosition: null,

    // Surface painting
    isPaintingSurface: false,
    surfaceBrushSize: 5,
    paintedFaces: new Set(),       // Set<number> - numeric encoded face IDs
    surfaceHighlightMesh: null,
    surfaceHighlightDirty: false,
    surfaceHighlightRAF: null,
    isErasingMode: false,
    pendingFaces: [],               // Faces added since last highlight update
    needsFullHighlightRebuild: false, // Flag: erase occurred, need full rebuild
    highlightVertexCount: 0,        // Current vertex count in highlight buffer

    // Box annotation
    selectedBoxAnnotation: null,
    isManipulatingBox: false,
    boxManipulationMode: null,
    boxDragStartMouse: null,
    boxDragStartData: null,
    activeBoxHandle: null,
    boxHandleObjects: [],
    
    // Box placement mode (new box creation workflow)
    pendingBoxData: null,        // Temporary box data during placement
    isBoxPlacementMode: false,   // True while placing a new box
    pendingBoxClickPosition: null, // Original click position for popup
    boxEditUnlocked: null,       // ID of box currently unlocked for editing

    // Three.js annotation objects
    annotationObjects: new THREE.Group(),

    // Pending files (for dialogs)
    pendingObjFile: null,
    pendingPlyFile: null,

    // UI state
    pendingLinks: [],
    editingGroup: null,
    editingEntryId: null,
    isAddingEntry: false,
    confirmCallback: null,
    scalebarConfirmCallback: null,
    scalebarNoSwitchCallback: null,

    // Popup dragging
    isDraggingPopup: false,
    popupDragOffsetX: 0,
    popupDragOffsetY: 0,
};

// ============ DOM Elements ============
export const dom = {};

export function initDomReferences() {
    // Canvas & file inputs
    dom.canvas = document.getElementById('canvas');
    dom.fileInput = document.getElementById('file-input');
    dom.importInput = document.getElementById('import-input');
    dom.objMaterialInput = document.getElementById('obj-material-input');
    dom.plyTextureInput = document.getElementById('ply-texture-input');

    // Dialogs
    dom.objDialogOverlay = document.getElementById('obj-dialog-overlay');
    dom.objLoadPlain = document.getElementById('obj-load-plain');
    dom.objAddMaterials = document.getElementById('obj-add-materials');
    dom.plyDialogOverlay = document.getElementById('ply-dialog-overlay');
    dom.plyLoadPlain = document.getElementById('ply-load-plain');
    dom.plyAddTexture = document.getElementById('ply-add-texture');

    // Toolbar buttons
    dom.btnLoad = document.getElementById('btn-load');
    dom.btnTexture = document.getElementById('btn-texture');
    dom.btnPoint = document.getElementById('btn-point');
    dom.btnLine = document.getElementById('btn-line');
    dom.btnPolygon = document.getElementById('btn-polygon');
    dom.btnSurface = document.getElementById('btn-surface');
    dom.btnBox = document.getElementById('btn-box');
    dom.btnMeasure = document.getElementById('btn-measure');
    dom.btnScreenshot = document.getElementById('btn-screenshot');
    dom.btnExport = document.getElementById('btn-export');
    dom.btnExportPdf = document.getElementById('btn-export-pdf');
    dom.btnImport = document.getElementById('btn-import');
    dom.btnAddGroup = document.getElementById('btn-add-group');

    // Brush controls
    dom.brushDisplay = document.getElementById('brush-display');
    dom.brushSlider = document.getElementById('brush-slider');
    dom.brushValue = document.getElementById('brush-value');

    // Annotation popup
    dom.annotationPopup = document.getElementById('annotation-popup');
    dom.popupTitle = document.getElementById('popup-title');
    dom.annName = document.getElementById('ann-name');
    dom.annGroup = document.getElementById('ann-group');
    
    // Inline group creation
    dom.btnAddGroupInline = document.getElementById('btn-add-group-inline');
    dom.inlineNewGroupForm = document.getElementById('inline-new-group-form');
    dom.inlineGroupName = document.getElementById('inline-group-name');
    dom.inlineGroupColor = document.getElementById('inline-group-color');
    dom.btnCancelInlineGroup = document.getElementById('btn-cancel-inline-group');
    dom.btnSaveInlineGroup = document.getElementById('btn-save-inline-group');
    dom.surfaceProjectionToggle = document.getElementById('surface-projection-toggle');
    dom.annSurfaceProjection = document.getElementById('ann-surface-projection');
    dom.annDescription = document.getElementById('ann-description');
    dom.annAuthor = document.getElementById('ann-author');
    dom.annLinks = document.getElementById('ann-links');
    dom.annNewLink = document.getElementById('ann-new-link');
    dom.btnAddLink = document.getElementById('btn-add-link');
    dom.btnPopupSave = document.getElementById('btn-popup-save');
    dom.btnPopupCancel = document.getElementById('btn-popup-cancel');
    dom.btnPopupDelete = document.getElementById('btn-popup-delete');

    // Entries
    dom.entriesContainer = document.getElementById('entries-container');
    dom.entriesList = document.getElementById('entries-list');
    dom.btnAddEntry = document.getElementById('btn-add-entry');
    dom.newEntryForm = document.getElementById('new-entry-form');

    // Confirm dialogs
    dom.confirmOverlay = document.getElementById('confirm-overlay');
    dom.confirmMessage = document.getElementById('confirm-message');
    dom.confirmOk = document.getElementById('confirm-ok');
    dom.confirmCancel = document.getElementById('confirm-cancel');

    // Annotation clear dialog
    dom.annotationClearOverlay = document.getElementById('annotation-clear-overlay');
    dom.annotationClearCancel = document.getElementById('annotation-clear-cancel');
    dom.annotationClearDiscard = document.getElementById('annotation-clear-discard');
    dom.annotationClearExport = document.getElementById('annotation-clear-export');

    // Scalebar confirm
    dom.scalebarConfirmOverlay = document.getElementById('scalebar-confirm-overlay');
    dom.scalebarNoSwitch = document.getElementById('scalebar-no-switch');
    dom.scalebarSwitch = document.getElementById('scalebar-switch');

    // Model info
    dom.modelInfoItem = document.getElementById('model-info-item');
    dom.modelInfoSubtitle = document.getElementById('model-info-subtitle');
    dom.modelStats = document.getElementById('model-stats');
    dom.faceCountDisplay = document.getElementById('face-count');

    // Group popup
    dom.groupPopup = document.getElementById('group-popup');
    dom.groupPopupTitle = document.getElementById('group-popup-title');
    dom.groupName = document.getElementById('group-name');
    dom.groupColor = document.getElementById('group-color');
    dom.btnGroupSave = document.getElementById('btn-group-save');
    dom.btnGroupCancel = document.getElementById('btn-group-cancel');
    dom.btnGroupDelete = document.getElementById('btn-group-delete');

    // Sidebar
    dom.groupsContainer = document.getElementById('groups-container');
    dom.noGroups = document.getElementById('no-groups');
    dom.searchInput = document.getElementById('search-input');

    // Measurements
    dom.measurementDisplay = document.getElementById('measurement-display');
    dom.measurementsList = document.getElementById('measurements-list');

    // Tool Help Panel
    dom.toolHelp = document.getElementById('tool-help');
    dom.toolHelpTitle = document.getElementById('tool-help-title');
    dom.toolHelpContent = document.getElementById('tool-help-content');

    // Status & loading
    dom.loading = document.getElementById('loading');
    dom.status = document.getElementById('status');

    // Sliders
    dom.brightnessSlider = document.getElementById('brightness-slider');
    dom.brightnessValue = document.getElementById('brightness-value');
    dom.opacitySlider = document.getElementById('opacity-slider');
    dom.opacityValue = document.getElementById('opacity-value');
    dom.lightToggle = document.getElementById('light-toggle');
    dom.lightDirectionRow = document.getElementById('light-direction-row');
    dom.lightAzimuthSlider = document.getElementById('light-azimuth-slider');
    dom.lightAzimuthValue = document.getElementById('light-azimuth-value');
    dom.lightElevationSlider = document.getElementById('light-elevation-slider');
    dom.lightElevationValue = document.getElementById('light-elevation-value');
    dom.pointSizeSlider = document.getElementById('point-size-slider');
    dom.pointSizeValue = document.getElementById('point-size-value');
    dom.textSizeSlider = document.getElementById('text-size-slider');
    dom.textSizeValue = document.getElementById('text-size-value');
    dom.backgroundColorPicker = document.getElementById('background-color-picker');
    dom.slidersPanel = document.getElementById('sliders-panel');
    dom.slidersPanelToggle = document.getElementById('sliders-panel-toggle');

    // Modals
    dom.aboutOverlay = document.getElementById('about-overlay');
    dom.btnAbout = document.getElementById('btn-about');
    dom.aboutModalClose = document.getElementById('about-modal-close');
    dom.btnDownloadManual = document.getElementById('btn-download-manual');
    dom.legalOverlay = document.getElementById('legal-overlay');
    dom.btnLegal = document.getElementById('btn-legal');
    dom.legalModalClose = document.getElementById('legal-modal-close');
    
    // Settings modal
    dom.btnSettings = document.getElementById('btn-settings');
    dom.settingsOverlay = document.getElementById('settings-overlay');
    dom.settingsModalClose = document.getElementById('settings-modal-close');
    dom.settingsDefaultAuthor = document.getElementById('settings-default-author');
    dom.settingsMeasurementUnit = document.getElementById('settings-measurement-unit');
    dom.settingsMeasurementUnitCustom = document.getElementById('settings-measurement-unit-custom');
    dom.settingsMeasurementLineColor = document.getElementById('settings-measurement-line-color');
    dom.settingsMeasurementPointColor = document.getElementById('settings-measurement-point-color');
    dom.settingsPdfTitle = document.getElementById('settings-pdf-title');
    dom.settingsPdfInstitution = document.getElementById('settings-pdf-institution');
    dom.settingsPdfProject = document.getElementById('settings-pdf-project');
    dom.settingsPdfAccentColor = document.getElementById('settings-pdf-accent-color');
    dom.settingsPdfPageSize = document.getElementById('settings-pdf-page-size');
    dom.settingsPdfOrientation = document.getElementById('settings-pdf-orientation');
    dom.settingsPdfDpi = document.getElementById('settings-pdf-dpi');
    dom.settingsResetAll = document.getElementById('settings-reset-all');
    
    // Camera toggle (now in sliders panel)
    dom.cameraToggle = document.getElementById('camera-toggle');
}
