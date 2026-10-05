// js/state.js - Central state management
import * as THREE from 'three';

// ============ Version ============
export const APP_VERSION = '1.6.1';

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
    brightness: 100,            // 0-300 (slider %); setBrightness() is the sole writer
    fixedLightAzimuth: 0,
    fixedLightElevation: 45,
    backgroundColor: '#041D31',

    // Model
    isFlipped: false,
    currentModel: null,
    modelFileName: '',
    originalMaterials: new Map(),
    displayMode: 'texture', // 'texture', 'vertexColors', 'mesh', 'wireframe'
    hasVertexColors: false,
    modelOpacity: 1.0,
    modelMeshes: [],
    modelFaceCount: 0,         // Total triangle count across all meshes of the current model
    modelBoundingSize: 1,
    modelUpAxis: 'z-up', // 'y-up' or 'z-up'
    webglContextLost: false,
    bvhAvailable: false,        // Whether BVH acceleration is available for current model
    loadedModelFiles: [],       // Original File objects for model export
    modelHash: null,            // SHA-256 hex of the primary model file (for annotation/model binding)
    modelHashPending: false,    // true while that hash is being computed (null hash = not known yet)
    modelFrameOrigin: null,     // Centring offset {x, y, z} in the Z-up export frame (exported + origin = model scene coords)

    // UI Multipliers
    // Marker size is split by marker class so each can be tuned on its own —
    // e.g. small vertices on a dense polygon while standalone points stay
    // large. All four default to 1.0, which reproduces the single-slider
    // rendering exactly: the per-class base factors in render.js / measure.js
    // already carry the intended relative balance.
    pointSizeMultiplier: 1.0,          // point annotations
    vertexSizeMultiplier: 1.0,         // line & polygon vertices
    boxHandleSizeMultiplier: 1.0,      // box corner handles (saved and pending)
    measureMarkerSizeMultiplier: 1.0,  // measurement markers
    textSizeMultiplier: 1.0,
    
    // User preferences
    defaultAuthor: '',
    defaultAuthorOrcid: '',
    defaultLanguage: '',      // BCP-47 tag stamped on new entries; '' = browser default
    measurementUnit: 'units',
    measurementLineColor: '#AA8101',
    measurementPointColor: '#FFFFFF',
    
    // Model display colors
    meshColor: '#888888',
    wireframeColor: '#AA8101',
    
    // PDF export settings
    pdfTitle: '',
    pdfInstitution: '',
    pdfProject: '',
    pdfAccentColor: '#AA8101',
    pdfPageSize: 'a4',
    pdfOrientation: 'portrait',
    pdfDpi: 150,
    pdfCameraDistance: 1.0,
    pdfCameraAngle: 60,

    // Screenshot settings
    screenshotQuality: 2, // Multiplier: 1 = standard, 2 = high, 4 = ultra

    // Six-view plate settings
    platePngWidth: 4000,        // Total plate width in px for the PNG export
    platePdfDpi: 300,           // Render resolution for the PDF plate
    plateCellShape: 'net',      // 'net' = per-face cells (tight), 'uniform' = equal cells

    // Survey import settings (meshnotes_survey* keys). Read from state when
    // used, never copied at init: the settings are restored after init().
    // Distances are in metres.
    surveyLockImported: true,   // imported points start locked
    surveyLabelsOffAbove: 50,   // hide an import's labels above this many points (0 = never)
    surveySurfaceWarn: 0.10,    // flag points whose fitted position is farther from the surface
    surveySurfaceLimit: 0.5,    // default distance limit of the selection step
    surveyResidualWarn: 0.05,   // residual warning of the fit
    surveyPdfSummary: true,     // the PDF report prints an alignment summary section

    // Tools
    currentTool: null, // 'point', 'line', 'polygon', 'surface', 'box', 'measure', 'survey-pick' (picking panel open)
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
    alignments: [],             // Survey alignments of this model (exported and autosaved)
    defaultAlignmentId: null,   // Internal id of the alignment preselected for imports (exported)
    surveySession: null,        // Control-point picking in progress (never saved); shape in survey/ui-alignment.js
    selectedAnnotation: null,
    editingAnnotation: null,

    // Model Information
    modelInfo: { entries: [], metadata: null },
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
    surfaceStrokeHistory: [],       // Array of { added: Set<number>, removed: Set<number> }
    currentStrokeAdded: null,       // Faces added in current stroke
    currentStrokeRemoved: null,     // Faces removed (erased) in current stroke

    // Cutting plane
    cuttingPlaneActive: false,

    // Box annotation
    selectedBoxAnnotation: null,
    isManipulatingBox: false,
    isRotatingBoxGesture: false,  // two-finger box rotation in progress (touch)
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

    // Survey picking overlays (pick and preview markers, residual lines),
    // drawn by survey/ui-alignment.js. A group of its own, so
    // renderAnnotations() never clears it; added to the scene in main.js.
    surveyOverlay: new THREE.Group(),

    // Anchor point (display coords) per annotation id, filled by
    // renderAnnotations(). Used to position the selection callout; it is the
    // same position the label-occlusion pass checks against, so it is already
    // flip-aware and already correct per annotation type.
    annotationAnchors: new Map(),

    // Opacity of the selection callout, 0.2–1.0 (see setCalloutOpacity).
    calloutOpacity: 1.0,

    // Whether the selection callout is raised at all (Settings → Viewport).
    // When false, selecting an annotation still centres the camera and
    // emphasises the geometry, but the name stays on its 3D label sprite
    // instead of moving into the callout panel.
    calloutEnabled: true,

    // Pending files (for dialogs)
    pendingObjFile: null,
    pendingPlyFile: null,
    pendingStlFile: null,

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

    // Note: Two-finger box rotation gesture state is managed locally in
    // event-listeners.js to keep the gesture handling self-contained.
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
    dom.stlDialogOverlay = document.getElementById('stl-dialog-overlay');
    dom.stlLoadBtn = document.getElementById('stl-load-btn');

    // Toolbar buttons
    dom.btnLoad = document.getElementById('btn-load');
    dom.btnImportMenu = document.getElementById('btn-import-menu');
    dom.importDropdown = document.getElementById('import-dropdown');
    dom.btnTexture = document.getElementById('btn-texture');
    dom.btnPoint = document.getElementById('btn-point');
    dom.btnLine = document.getElementById('btn-line');
    dom.btnPolygon = document.getElementById('btn-polygon');
    dom.btnSurface = document.getElementById('btn-surface');
    dom.btnBox = document.getElementById('btn-box');
    dom.btnMeasure = document.getElementById('btn-measure');
    dom.btnScreenshot = document.getElementById('btn-screenshot');
    dom.screenshotDropdown = document.getElementById('screenshot-dropdown');
    dom.screenshotDropdownMenu = document.getElementById('screenshot-dropdown-menu');
    dom.btnScreenshotSingle = document.getElementById('btn-screenshot-single');
    dom.btnExportViews = document.getElementById('btn-export-views');
    dom.plateFormatOverlay = document.getElementById('plate-format-overlay');
    dom.plateFormatPng = document.getElementById('plate-format-png');
    dom.plateFormatPdf = document.getElementById('plate-format-pdf');
    dom.plateFormatDialogClose = document.getElementById('plate-format-dialog-close');
    dom.btnExport = document.getElementById('btn-export');
    dom.btnExportJsonld = document.getElementById('btn-export-jsonld');
    dom.btnExportPdf = document.getElementById('btn-export-pdf');
    dom.btnExportModel = document.getElementById('btn-export-model');
    dom.exportDropdown = document.getElementById('export-dropdown');
    dom.exportDropdownMenu = document.getElementById('export-dropdown-menu');
    dom.btnImport = document.getElementById('btn-import');
    dom.btnImportSurvey = document.getElementById('btn-import-survey');
    dom.surveyCsvInput = document.getElementById('survey-csv-input');
    dom.btnShare = document.getElementById('btn-share');
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
    dom.annLockedRow = document.getElementById('ann-locked-row');
    dom.annLocked = document.getElementById('ann-locked');
    dom.annLockedHint = document.getElementById('ann-locked-hint');
    dom.annSurveyBlock = document.getElementById('ann-survey-block');
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

    // Refresh confirm dialog
    dom.refreshConfirmOverlay = document.getElementById('refresh-confirm-overlay');
    dom.refreshConfirmCancel = document.getElementById('refresh-confirm-cancel');
    dom.refreshConfirmRefresh = document.getElementById('refresh-confirm-refresh');
    dom.refreshConfirmExport = document.getElementById('refresh-confirm-export');

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
    dom.groupOpacity = document.getElementById('group-opacity');
    dom.groupOpacityValue = document.getElementById('group-opacity-value');
    dom.btnGroupSave = document.getElementById('btn-group-save');
    dom.btnGroupCancel = document.getElementById('btn-group-cancel');
    dom.btnGroupDelete = document.getElementById('btn-group-delete');
    dom.groupLabelsVisible = document.getElementById('group-labels-visible');

    // Group delete dialog (move or delete the group's annotations)
    dom.groupDeleteOverlay = document.getElementById('group-delete-overlay');
    dom.groupDeleteMessage = document.getElementById('group-delete-message');
    dom.groupDeleteTarget = document.getElementById('group-delete-target');
    dom.groupDeleteCancel = document.getElementById('group-delete-cancel');
    dom.groupDeleteAnnotations = document.getElementById('group-delete-annotations');
    dom.groupDeleteMove = document.getElementById('group-delete-move');

    // Survey CSV import: column mapping dialog (Step A)
    dom.surveyMappingOverlay = document.getElementById('survey-mapping-overlay');
    dom.surveyMappingFile = document.getElementById('survey-mapping-file');
    dom.surveyMappingClose = document.getElementById('survey-mapping-close');
    dom.surveyMappingEncoding = document.getElementById('survey-mapping-encoding');
    dom.surveyMappingDelimiter = document.getElementById('survey-mapping-delimiter');
    dom.surveyMappingDecimal = document.getElementById('survey-mapping-decimal');
    dom.surveyMappingHeader = document.getElementById('survey-mapping-header');
    dom.surveyMappingCounts = document.getElementById('survey-mapping-counts');
    dom.surveyMappingPreview = document.getElementById('survey-mapping-preview');
    dom.surveyMappingPreset = document.getElementById('survey-mapping-preset');
    dom.surveyMapName = document.getElementById('survey-map-name');
    dom.surveyMapEasting = document.getElementById('survey-map-easting');
    dom.surveyMapNorthing = document.getElementById('survey-map-northing');
    dom.surveyMapHeight = document.getElementById('survey-map-height');
    dom.surveyMapDescription = document.getElementById('survey-map-description');
    dom.surveyMapCode = document.getElementById('survey-map-code');
    dom.surveyMappingExtrasHint = document.getElementById('survey-mapping-extras-hint');
    dom.surveyMappingExtras = document.getElementById('survey-mapping-extras');
    dom.surveyMappingTarget = document.getElementById('survey-mapping-target');
    dom.surveyMappingGroup = document.getElementById('survey-mapping-group');
    dom.surveyMappingTargetInfo = document.getElementById('survey-mapping-target-info');
    dom.surveyMappingNewFields = document.getElementById('survey-mapping-new-fields');
    dom.surveyMappingNewName = document.getElementById('survey-mapping-new-name');
    dom.surveyMappingNewCrs = document.getElementById('survey-mapping-new-crs');
    dom.surveyMappingIssues = document.getElementById('survey-mapping-issues');
    dom.surveyMappingCancel = document.getElementById('survey-mapping-cancel');
    dom.surveyMappingContinue = document.getElementById('survey-mapping-continue');

    // Survey CSV import: selection step and summary (Step D)
    dom.surveySelectOverlay = document.getElementById('survey-select-overlay');
    dom.surveySelectSubtitle = document.getElementById('survey-select-subtitle');
    dom.surveySelectClose = document.getElementById('survey-select-close');
    dom.surveySelectSummary = document.getElementById('survey-select-summary');
    dom.surveySelectLimit = document.getElementById('survey-select-limit');
    dom.surveySelectProgress = document.getElementById('survey-select-progress');
    dom.surveySelectNomatch = document.getElementById('survey-select-nomatch');
    dom.surveySelectNomatchText = document.getElementById('survey-select-nomatch-text');
    dom.surveySelectSwap = document.getElementById('survey-select-swap');
    dom.surveySelectNewAlignment = document.getElementById('survey-select-new-alignment');
    dom.surveySelectRemap = document.getElementById('survey-select-remap');
    dom.surveySelectShowRows = document.getElementById('survey-select-show-rows');
    dom.surveySelectTableWrap = document.getElementById('survey-select-table-wrap');
    dom.surveySelectAll = document.getElementById('survey-select-all');
    dom.surveySelectRows = document.getElementById('survey-select-rows');
    dom.surveySelectBack = document.getElementById('survey-select-back');
    dom.surveySelectCancel = document.getElementById('survey-select-cancel');
    dom.surveySelectImportAll = document.getElementById('survey-select-import-all');
    dom.surveySelectImport = document.getElementById('survey-select-import');
    dom.surveySummaryOverlay = document.getElementById('survey-summary-overlay');
    dom.surveySummarySubtitle = document.getElementById('survey-summary-subtitle');
    dom.surveySummaryClose = document.getElementById('survey-summary-close');
    dom.surveySummaryFigures = document.getElementById('survey-summary-figures');
    dom.surveySummaryDetails = document.getElementById('survey-summary-details');
    dom.surveySummaryCopy = document.getElementById('survey-summary-copy');
    dom.surveySummaryOk = document.getElementById('survey-summary-ok');

    // Survey CSV import: picking panel (Step B) and review (Step C)
    dom.surveyPickPanel = document.getElementById('survey-pick-panel');
    dom.surveyPickHeader = document.getElementById('survey-pick-header');
    dom.surveyPickTitle = document.getElementById('survey-pick-title');
    dom.surveyPickSubtitle = document.getElementById('survey-pick-subtitle');
    dom.surveyPickClose = document.getElementById('survey-pick-close');
    dom.surveyPickInstructions = document.getElementById('survey-pick-instructions');
    dom.surveyPickSearch = document.getElementById('survey-pick-search');
    dom.surveyPickCounts = document.getElementById('survey-pick-counts');
    dom.surveyPickRows = document.getElementById('survey-pick-rows');
    dom.surveyPickSelected = document.getElementById('survey-pick-selected');
    dom.surveyPickSelectedText = document.getElementById('survey-pick-selected-text');
    dom.surveyPickAnnotation = document.getElementById('survey-pick-annotation');
    dom.surveyPickIssues = document.getElementById('survey-pick-issues');
    dom.surveyPickFit = document.getElementById('survey-pick-fit');
    dom.surveyPickLevel = document.getElementById('survey-pick-level');
    dom.surveyPickLevelHint = document.getElementById('survey-pick-level-hint');
    dom.surveyPickUndo = document.getElementById('survey-pick-undo');
    dom.surveyPickCancel = document.getElementById('survey-pick-cancel');
    dom.surveyPickReview = document.getElementById('survey-pick-review');
    dom.surveyReviewOverlay = document.getElementById('survey-review-overlay');
    dom.surveyReviewSubtitle = document.getElementById('survey-review-subtitle');
    dom.surveyReviewClose = document.getElementById('survey-review-close');
    dom.surveyReviewVerdict = document.getElementById('survey-review-verdict');
    dom.surveyReviewFigures = document.getElementById('survey-review-figures');
    dom.surveyReviewLevel = document.getElementById('survey-review-level');
    dom.surveyReviewCompare = document.getElementById('survey-review-compare');
    dom.surveyReviewLevelHint = document.getElementById('survey-review-level-hint');
    dom.surveyReviewIssues = document.getElementById('survey-review-issues');
    dom.surveyReviewRows = document.getElementById('survey-review-rows');
    dom.surveyReviewBack = document.getElementById('survey-review-back');
    dom.surveyReviewCancel = document.getElementById('survey-review-cancel');
    dom.surveyReviewAccept = document.getElementById('survey-review-accept');

    // Survey alignments: status chip, Alignment Manager, refine preview,
    // delete dialog and the read-only control-point view
    dom.alignmentChip = document.getElementById('alignment-chip');
    dom.alignmentManagerOverlay = document.getElementById('alignment-manager-overlay');
    dom.alignmentManagerSubtitle = document.getElementById('alignment-manager-subtitle');
    dom.alignmentManagerClose = document.getElementById('alignment-manager-close');
    dom.alignmentManagerEmpty = document.getElementById('alignment-manager-empty');
    dom.alignmentManagerList = document.getElementById('alignment-manager-list');
    dom.alignmentManagerOk = document.getElementById('alignment-manager-ok');
    dom.alignmentRefineOverlay = document.getElementById('alignment-refine-overlay');
    dom.alignmentRefineSubtitle = document.getElementById('alignment-refine-subtitle');
    dom.alignmentRefineClose = document.getElementById('alignment-refine-close');
    dom.alignmentRefineText = document.getElementById('alignment-refine-text');
    dom.alignmentRefineFigures = document.getElementById('alignment-refine-figures');
    dom.alignmentRefineManual = document.getElementById('alignment-refine-manual');
    dom.alignmentRefineProgress = document.getElementById('alignment-refine-progress');
    dom.alignmentRefineKeep = document.getElementById('alignment-refine-keep');
    dom.alignmentRefineMove = document.getElementById('alignment-refine-move');
    dom.alignmentDeleteOverlay = document.getElementById('alignment-delete-overlay');
    dom.alignmentDeleteMessage = document.getElementById('alignment-delete-message');
    dom.alignmentDeleteDialogClose = document.getElementById('alignment-delete-dialog-close');
    dom.alignmentDeleteCancel = document.getElementById('alignment-delete-cancel');
    dom.alignmentDeletePoints = document.getElementById('alignment-delete-points');
    dom.alignmentDeleteDetach = document.getElementById('alignment-delete-detach');
    dom.alignmentViewPanel = document.getElementById('alignment-view-panel');
    dom.alignmentViewSubtitle = document.getElementById('alignment-view-subtitle');
    dom.alignmentViewClose = document.getElementById('alignment-view-close');
    dom.alignmentViewVerdict = document.getElementById('alignment-view-verdict');
    dom.alignmentViewFigures = document.getElementById('alignment-view-figures');
    dom.alignmentViewIssues = document.getElementById('alignment-view-issues');
    dom.alignmentViewRows = document.getElementById('alignment-view-rows');
    dom.alignmentViewBack = document.getElementById('alignment-view-back');

    // Sidebar
    dom.groupsContainer = document.getElementById('groups-container');
    dom.noGroups = document.getElementById('no-groups');
    dom.searchInput = document.getElementById('search-input');

    // Measurements
    dom.measurePanels = document.getElementById('measure-panels');
    dom.measurementDisplay = document.getElementById('measurement-display');
    dom.measurementsList = document.getElementById('measurements-list');
    dom.cuttingPlaneDisplay = document.getElementById('cutting-plane-display');

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
    dom.vertexSizeSlider = document.getElementById('vertex-size-slider');
    dom.vertexSizeValue = document.getElementById('vertex-size-value');
    dom.boxHandleSizeSlider = document.getElementById('box-handle-size-slider');
    dom.boxHandleSizeValue = document.getElementById('box-handle-size-value');
    // Lives in the Measurements settings pane, but is the same kind of control
    // as the three above and is driven by the same setter factory.
    dom.measureMarkerSizeSlider = document.getElementById('measure-marker-size-slider');
    dom.measureMarkerSizeValue = document.getElementById('measure-marker-size-value');
    dom.textSizeSlider = document.getElementById('text-size-slider');
    dom.textSizeValue = document.getElementById('text-size-value');
    dom.calloutEnabledToggle = document.getElementById('callout-enabled-toggle');
    dom.calloutOpacityRow = document.getElementById('callout-opacity-row');
    dom.calloutOpacitySlider = document.getElementById('callout-opacity-slider');
    dom.calloutOpacityValue = document.getElementById('callout-opacity-value');
    dom.backgroundColorPicker = document.getElementById('background-color-picker');
    dom.slidersPanel = document.getElementById('sliders-panel');
    dom.slidersPanelToggle = document.getElementById('sliders-panel-toggle');

    // Modals
    dom.aboutOverlay = document.getElementById('about-overlay');
    dom.btnAbout = document.getElementById('btn-about');
    dom.aboutModalClose = document.getElementById('about-modal-close');
    dom.manualOverlay = document.getElementById('manual-overlay');
    dom.btnManual = document.getElementById('btn-manual');
    dom.manualModalClose = document.getElementById('manual-modal-close');
    dom.btnDownloadManual = document.getElementById('btn-download-manual');
    dom.legalOverlay = document.getElementById('legal-overlay');
    dom.btnLegal = document.getElementById('btn-legal');
    dom.legalModalClose = document.getElementById('legal-modal-close');
    
    // Settings modal
    dom.btnSettings = document.getElementById('btn-settings');
    dom.settingsOverlay = document.getElementById('settings-overlay');
    dom.settingsModalClose = document.getElementById('settings-modal-close');
    dom.settingsRailItems = Array.from(document.querySelectorAll('.settings-rail-item'));
    dom.settingsPanes = Array.from(document.querySelectorAll('.settings-pane'));
    dom.settingsDefaultAuthor = document.getElementById('settings-default-author');
    dom.settingsDefaultAuthorOrcid = document.getElementById('settings-default-author-orcid');
    dom.settingsDefaultLanguage = document.getElementById('settings-default-language');
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
    dom.settingsPdfCameraDistance = document.getElementById('settings-pdf-camera-distance');
    dom.settingsPdfCameraDistanceValue = document.getElementById('settings-pdf-camera-distance-value');
    dom.settingsPdfCameraAngle = document.getElementById('settings-pdf-camera-angle');
    dom.settingsPdfCameraAngleValue = document.getElementById('settings-pdf-camera-angle-value');
    dom.settingsMeshColor = document.getElementById('settings-mesh-color');
    dom.settingsWireframeColor = document.getElementById('settings-wireframe-color');
    dom.settingsResetAll = document.getElementById('settings-reset-all');
    dom.settingsScreenshotQuality = document.getElementById('settings-screenshot-quality');
    dom.settingsPlatePngWidth = document.getElementById('settings-plate-png-width');
    dom.settingsPlatePdfDpi = document.getElementById('settings-plate-pdf-dpi');
    dom.settingsPlateCellShape = document.getElementById('settings-plate-cell-shape');
    dom.settingsSurveyLockImported = document.getElementById('settings-survey-lock-imported');
    dom.settingsSurveyLabelsOffAbove = document.getElementById('settings-survey-labels-off-above');
    dom.settingsSurveyResidualWarn = document.getElementById('settings-survey-residual-warn');
    dom.settingsSurveySurfaceWarn = document.getElementById('settings-survey-surface-warn');
    dom.settingsSurveySurfaceLimit = document.getElementById('settings-survey-surface-limit');
    dom.settingsSurveyPdfSummary = document.getElementById('settings-survey-pdf-summary');
    
    // Camera toggle and flip toggle (now in sliders panel)
    dom.cameraToggle = document.getElementById('camera-toggle');
    dom.flipToggle = document.getElementById('flip-toggle');
}
