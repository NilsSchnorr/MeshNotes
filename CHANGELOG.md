# Changelog

All notable changes to MeshNotes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [1.5.1] — 2026-10-01

A small release. Orthographic screenshots now carry their scale bar in a strip below the image, so it can no longer cover the model, and the annotation callout introduced in 1.5.0 can be switched off.

### Added

- **Option to switch off the annotation callout** — a new **Show callout when an annotation is selected** checkbox under **Settings → Viewport → Annotation Callout** turns the callout panel off. With it off, a selected annotation keeps its name on its label in the model, as it did before 1.5.0; selecting still centres the camera and emphasises the annotation. The opacity slider is disabled while the callout is off. The choice is remembered between sessions, and changing it clears the current selection.

### Changed

- **Screenshot scale bar moved into a strip below the image** — orthographic screenshots used to draw the scale bar as an overlay in the bottom-left corner of the image, where it covered the model whenever the view was zoomed in far enough. The image is now extended downwards by a strip in the background colour, and the scale bar sits bottom-left in that strip, so it never overlaps the model at any zoom level. Screenshots with a scale bar are therefore slightly taller than the viewport; screenshots without one (perspective mode) keep the viewport's exact size. The bar's length and value are calculated exactly as before. This applies to the Screenshot export; the view image in the PDF report is unchanged.
- **Larger scale bar on screenshots** — the screenshot scale bar is drawn at 1.5 times its previous size: a thicker rule and end ticks, and larger value and caption text, so it stays legible once a screenshot is scaled down onto a page or slide. Scale bars on the six-view plate, the PDF report and cutting-plane profiles keep their size.
- **Surface-following line and polygon edges** — edges of line and polygon annotations that are projected onto the model surface are now sampled according to their length instead of with a fixed 30 samples per edge. Long edges get up to 256 samples and follow the relief more closely, short edges are no longer oversampled, and sample spacing never goes finer than the model's average triangle edge. The projected path is then lightly smoothed along the surface to remove per-triangle jitter, and re-spaced evenly to at most 64 points per edge for display, which keeps redrawing cheap while a vertex is being dragged.
- **Manual** — *Screenshots & Scalebar* describes the strip below the image; *Tips* and the *Settings* walkthrough cover switching the callout off.

### Internal

- `js/annotation-tools/projection.js` keeps sampling density and output density as separate budgets (`SAMPLE_SPACING_RELATIVE`, `MIN_SEGMENTS`, `MAX_SEGMENTS`, `MAX_OUTPUT_POINTS`, `SMOOTHING_ROUNDS`). An explicit segment count from the caller still wins, so the drawing preview and live drag re-projection keep their fixed, cheap budgets. Scratch vectors are now reused across samples instead of allocated per sample, and each mesh's inverse world and normal matrices are derived once per projection call rather than once per sample.
- New `appendViewportScalebarStrip()` in `js/export/scalebar.js` builds the extended screenshot canvas; `drawViewportScalebar()` remains for the PDF report's overlay. The screenshot bar size is a single constant, `SCREENSHOT_BAR_SIZE`.
- The callout setting is held in `state.calloutEnabled` and persisted as `meshnotes_calloutEnabled`; `setCalloutEnabled()` lives in `js/core/lighting.js` alongside `setCalloutOpacity()`.


## [1.5.0] — 2026-09-08

This release reorganises the Settings panel, adds a callout that surfaces an annotation's details in the viewport when it is selected, and splits marker sizing into separate controls per marker class.

### Added

- **Annotation callout** — selecting an annotation in the sidebar list now raises a small panel beside it in the viewport showing its name, type, group and most recent entry, along with a **Details** button that opens the full annotation for editing. The annotation itself is emphasised in the model at the same time: its markers grow, lines thicken, surface and box fills become more opaque, and its colour brightens towards white, so the annotation under discussion is unambiguous even in a crowded scene. The 3D name label is hidden while the callout is up, since the callout already carries the name and two copies a few pixels apart read as a rendering fault. Click the same sidebar entry again, or press <kbd>Esc</kbd>, to clear the selection; opening the annotation editor supersedes the callout rather than showing both. Selection is driven from the sidebar list only — clicking a marker in the 3D view does not raise the callout. A **Callout Opacity** setting (20–100%, under Viewport) controls how much of the model shows through the panel, and applies immediately, including while the callout is on screen.
- **Separate marker size controls** — the single Point Size slider has been replaced by four independent multipliers: **Point Markers**, **Line & Polygon Vertices**, **Box Corner Handles** (under Viewport) and **Marker Size** for measurement points (under Measurements). Each marker class already had its own base size, so the balance between them was fixed; splitting the controls means a detailed polygon can carry small vertices while standalone points stay prominent, or box corners can be kept large enough to grab on a model where the annotation markers are deliberately small. All four default to ×1.0, which reproduces the previous rendering exactly, and an existing Point Size preference is carried over to all four on first launch rather than being reset.

### Changed

- **Settings panel reorganised** — the settings are now grouped into four categories listed down the left-hand side (**Identity**, **Viewport**, **Measure**, **Export**) instead of one long scrolling list, with each group carrying a short note explaining what its settings affect and where they apply. The categories are reachable with the arrow keys as well as the mouse, and the panel can be dragged clear of the model by its title bar, holding its position for the rest of the session.
- **Manual** — *Tips* documents selecting an annotation and the callout; the *Settings* walkthrough covers the four categories, the callout opacity setting and the separate marker size sliders; *Texture & Display Controls* describes the four size sliders in place of the single Point Size slider.

### Fixed

- **Two modules were missing from the offline precache** — `selection-callout.js` and `selection-highlight.js` were not listed in the service worker's precache set. Because activating a new service worker deletes every older cache, a client that activated this version while offline would have found both modules absent and the app unable to start. Both are now precached; the full module list is verified against the source tree.

### Internal

- New modules `js/annotation-tools/selection-callout.js` (the HTML overlay, anchored from `state.annotationAnchors`) and `js/annotation-tools/selection-highlight.js` (material and scale emphasis, with the original values stored per object so the effect can be reversed without a full rebuild). Selection emphasis mutates objects already in the scene rather than re-running `renderAnnotations()`, which would otherwise dispose and rebuild every annotation — including surface meshes that walk `faceData` — on each sidebar click.
- The five marker and label size sliders are now generated from one `makeSizeSetter()` factory in `js/core/lighting.js`, and restored by one `restoreSizeSlider()` helper in `js/main.js`, replacing five near-identical copies of the same setter and loader.


## [1.4.2] — 2026-08-26

A bug-fix release. Very large models now build their raycasting acceleration structure successfully, restoring label occlusion, surface painting and annotation picking at photogrammetry scale.

### Fixed

- **Acceleration structure failed to build on very large models** — annotation picking, surface painting and label occlusion all rely on a spatial index (BVH) built once when a model loads. On large models that build failed: the bundled `three-mesh-bvh` library requested four times the memory it actually needed for one intermediate buffer, and past a certain size the browser refused the allocation. MeshNotes caught the failure and carried on without acceleration, so nothing crashed and no error was shown — but every click had to test every triangle in the model, and label occlusion switched itself off entirely. On a 27.2-million-face model the library asked for 2.43 GB in a single block where 622 MB was required. The bundled library has been updated to the upstream release that corrects this; that model now builds its index in about eleven seconds and all tools behave normally. Models that already loaded correctly are unaffected.

### Internal

- Vendored `three-mesh-bvh` updated 0.8.0 → 0.8.2. The vendored copy is byte-identical to the published upstream release; no local patch. Beyond the allocation fix the only difference is barycentric-coordinate data added to intersection results, which is inert on three.js r160 and unused by MeshNotes.
- New `vendor/VERSIONS.md` records every vendored library with its exact upstream version and a verified SHA-256 checksum, plus an upgrade procedure. Nothing previously identified which release each vendored copy came from — `pdf-lib` in particular carries no version string at all — which made diagnosing this issue slower than it should have been.
- The reasoning recorded at the BVH build block in `js/core/model-loader.js` was corrected: it claimed a model too large for the BVH would be too large for the GPU as well, which this model disproved by rendering perfectly while the index build failed. GPU capacity and a single contiguous host-side allocation are independent limits, and the surrounding `try`/`catch` — not a face-count ceiling — is what keeps the failure survivable.


## [1.4.1] — 2026-08-26

A bug-fix release. It removes a crash that could take down the browser tab when a very large model was switched to Wireframe display, and sharpens the manual's guidance on large files.

### Fixed

- **Browser tab crash when switching a very large model to Wireframe** — wireframe display cannot reuse a model's existing triangle data; a separate set of edge data has to be built alongside it, holding six entries per face. Past roughly 22 million faces this exceeds a hard limit in the browser's JavaScript engine, and the resulting error was raised from inside the render loop, so it repeated on every frame: the viewport froze on the last drawn image while the console filled, until the tab stopped responding. Wireframe is now withdrawn above 12 million faces, below the point where it becomes unreliable — the display button cycles Texture → Colors → Mesh → Texture instead, and the status bar names both the limit and the model's face count. Every other display mode remains available at any model size, and models under the limit are unaffected. Observed with a 27.2-million-face model.
- **Shared views could force an unavailable display mode** — a share link or restored view captured on a smaller model carried its display mode over verbatim, so opening one against a model past the wireframe limit reproduced the same crash. Wireframe now falls back to Mesh in that case, matching the existing fallback for Colors on models without vertex color data.
- **A single rendering error no longer brings down the session** — the render loop queued its next frame before drawing the current one, so any exception raised during a frame repeated indefinitely rather than surfacing once. Rendering now stops after the first failure and reports it in the status bar, leaving the page responsive so work in progress can still be exported before reloading.

### Changed

- **Manual — large files.** *Loading a Model* and *Model Preparation & Format Guide* now advise converting models above roughly 1 GB to GLB before loading, and say plainly that OBJ and PLY are the least reliable formats at that scale: OBJ stores geometry as plain text, and PLY is uncompressed, so both are substantially larger than the equivalent GLB for the same mesh. The format comparison list carries the same caution, and a new *File size* note explains that the practical ceiling depends on machine, browser, and available memory rather than sitting at a fixed value.
- **Manual — wireframe limit.** *Texture & Display Controls* documents why Wireframe is unavailable on very large models and what the display button does instead.

### Internal

- `WIREFRAME_FACE_LIMIT` and `isWireframeSupported()` added to `js/core/model-loader.js`, with the underlying engine limit and the reasoning behind the chosen value recorded at the definition. The model's total face count is now kept in `state.modelFaceCount` instead of remaining a local during model setup.


## [1.4.0] — 2026-07-28

This release adds a dedicated six-view plate export for publication figures, and unifies the scale bar across every output.

### Added

- **Six-View Plate export (PNG / PDF)** — renders the model from all six axis directions and arranges them in the unfolded-cube net used for object plates (`Back | Left | Front | Right`, with Top and Bottom above and below Front). Framing is derived from the model's bounding box, not from the viewport, so the object is shown as large as possible while all six views stay at one shared scale — which is what makes the single scale bar below the block valid. The same model always produces the same plate, and two objects exported the same way are directly comparable. PNG output has a transparent background for direct placement in figures; PDF output fits the block to the page using the existing PDF page-size and orientation settings, with the scale bar drawn as vector lines.
- **Six-View Plate settings** — cell shape (fit to object, or square) and PNG plate width (2000 / 4000 / 8000 px).

### Changed

- **Scale bar redrawn as an "I-beam"** everywhere — a thin rule with a tick at each end and the length centred below it, replacing the alternating black/white bar on a translucent panel. This matches the scale bar the cutting-plane profile export already used, so screenshots, profiles, plates and the PDF report are now consistent. The bar is drawn bare in black or white, whichever contrasts with the background, which also lets it sit on transparent exports.
- **Axis Views page of the PDF report** now shares one implementation with the plate export, and follows the same net order and orientation. Each cell is rendered at its final size instead of being cropped from the viewport, and the tighter bounding-box fit means the model fills considerably more of each cell than before.
- **Line thickness in high-resolution exports** now scales with the image. Annotation and measurement lines previously kept their on-screen pixel width during tiled rendering, so 2x and 4x screenshots came out with proportionally thinner lines.
- Renderer is created with `alpha: true` to allow transparent exports. No visible change in normal use.

### Fixed

- **Scale bar too short in PDF reports** — screenshots in the report are upscaled by the DPI setting, but the scale bar was drawn at the unscaled device-pixel ratio, making it roughly 2x too short at 150 DPI and 4x too short at 300 DPI. Screenshots taken with the Screenshot button were never affected.
- **Top and Bottom views rotated 180 degrees** in the report's axis-views page — their up-vectors were mirrored relative to the four side views, so the unfolded cube did not fold back into a cube. Visible only on clearly asymmetric objects.

### Internal

- New modules `js/export/scalebar.js` (one scale-bar geometry, canvas and jsPDF renderers), `js/export/render-capture.js` (tiled off-screen rendering at arbitrary resolution), `js/export/views-plate.js` (net layout and plate output), and `js/export/pdf-layout.js` (page geometry shared by the PDF exports).
- Camera pose save/restore moved to `js/core/camera.js` as `saveCameraPose()` / `restoreCameraPose()`, replacing a private copy in `pdf-report.js`.


## [1.3.1] — 2026-07-20

### Fixed

- **Specification pages hijacked by the offline service worker** — in browsers that had previously loaded the app, navigating to any other page on the site (notably the published format specifications under `meshnotes.org/spec/`) was answered with the cached app shell instead of the requested page, which then rendered unstyled and with broken icons because its relative asset URLs do not resolve at those paths. The service worker now serves the cached app shell only for the app's own URL; all other pages are fetched from the network and cached afterwards, making the specifications readable offline as well. First-time visitors and browsers without the service worker were never affected, and no annotation data was involved.


## [1.3.0] — 2026-06-30

This release makes MeshNotes installable and fully usable offline, and adds automatic local recovery of in-progress annotation work — aimed at fieldwork on tablets with no reliable connection.

### Added

- **Offline use / installable app (PWA)** — a service worker caches the full application on first visit, so MeshNotes runs without a network connection once loaded. On tablets it can be added to the home screen (iPad Safari: Share → Add to Home Screen) and launched full-screen; only the optional Share upload needs the internet.
- **Automatic crash & eviction recovery** — while annotating, the current annotations are continuously backed up to the browser's local storage (IndexedDB). If the app is closed or reloaded — including when a tablet discards it from memory in the background — reopening the same model offers to restore the last session. The backup is bound to the model by its SHA-256 hash and is cleared automatically after a manual JSON-LD export.
- **Update prompt** — when a newer version has been deployed, a small "new version available" banner offers to reload, so an open session is never reloaded unexpectedly.

### Changed

- **Manual and Legal / Data policy** updated to document offline / home-screen use, the local autosave-and-restore behavior, and the recommendation to export before closing when working offline. The local-storage disclosure now also covers the IndexedDB annotation backup, in addition to display preferences and share-link history.


## [1.2.0] — 2026-06-08

This release overhauls the metadata and export backend for standards conformance and interoperability, and makes structured metadata documentation a first-class feature.

### Added

- **Structured Metadata Report** — the metadata form is now a structured, machine-readable record (replacing the previous free-text block), organized into seven sections: General Information, Object Context, Capture, Reference, Processing, Paradata, and Legal.
- **Subject kind** selector — declares what the documented subject is (movable object, feature, building, site, landscape, or mixed), setting the CIDOC CRM root class used on export.
- **Authority URI fields** — optional links to controlled vocabularies (Getty AAT, PeriodO, gazetteers) on Object Type, Material, Dating/Period, Location, and Find Spot.
- **Published format specifications** — versioned, citable specifications for the annotation, selector, and metadata formats at `meshnotes.org/spec/`, each with a JSON Schema, plus a resolvable JSON-LD context and a CIDOC CRM / CRMdig crosswalk (with a LIDO mapping) for the metadata.
- **ORCID** identification for authors, recorded on exported annotation entries.
- **Model integrity in exports** — a SHA-256 hash of the model file, the up-axis, and the unit are recorded so annotations can be reliably bound to the correct model.
- **Per-model metadata safeguard** — loading a new model (or refreshing the page) now warns when annotations, metadata, or model information would be cleared, offering to export the work as JSON-LD, discard it, or cancel.
- **PDF metadata export** — the fillable metadata PDF and the metadata pages of the report now include the Subject kind (an interactive dropdown in the form), any authority URIs, and a conformance note.

### Changed

- **Standards-conformant annotation export** — geometry is now stored in namespaced MeshNotes selectors with coordinates encoded as 3D WKT and a `dcterms:conformsTo` pointer, replacing the previously mislabeled 2D selector types; box rotation is stored as a quaternion; the `@context` is a resolvable URL.
- **Metadata is now per-model** and resets when a new model is loaded (guarded by the safeguard dialog above), rather than persisting silently across loads.
- **Annotation body language** is taken from the browser locale instead of being hardcoded to English.
- **All third-party libraries are self-hosted** under `vendor/` with no third-party CDN requests; the Legal / Data policy was updated accordingly.
- **Manual and About** expanded to document the standards, the Subject kind / Object Type fields, and the published specifications.

### Fixed

- Metadata filled in before loading a model is no longer silently discarded when the model loads.
- Corrected the two conformance issues from the format review: non-conformant 2D selector labeling on 3D geometry, and the opaque metadata block.


## [1.1.0] — 2026-05-15

### Added

- **Cutting Plane** — extract cross-section profiles from 3D models. Activate via the Measure tool's *Spawn Plane* button to place a camera-aligned cutting plane. Adjust its position with left-drag, tilt with right-drag, and swing with Ctrl+left-drag. The intersection with the model is previewed live and can be exported as a vector SVG or as a PNG with scale bar.


## [1.0.0] — 2026-05-13

Initial public release.

### Features

- **Annotation types** — points, lines, polygons, surface painting (BVH-accelerated), and 3D boxes with drag-to-resize and rotation (Shift for 15° snap)
- **Multi-entry annotations** — multiple users can add observations to the same feature with individual timestamps and version history
- **Groups** — organize annotations with customizable colors, per-group opacity, and visibility toggles
- **Draggable points** — reposition annotation markers without recreating them
- **Surface projection** — line and polygon edges projected onto the model surface, with per-annotation toggle and dual-threshold fallback
- **Search** — filter annotations by name in the sidebar
- **Measurement tools** — straight-line distances or multi-point paths (Ctrl+click) with configurable units; click a value to copy to clipboard
- **Flip View** — 180° visual model rotation for inspecting reverse sides (coins, artifacts); coordinate-space-safe
- **Model Information** — free-form notes about the entire model with multi-entry support
- **Metadata Report** — structured fillable metadata form (General Information, Capture, Reference, Processing, Legal) with fillable PDF (pdf-lib) and JSON round-trip
- **W3C Web Annotation export/import** — JSON-LD format with IIIF 3D-aligned selectors, UUID-based collaborative merging, and backward compatibility with legacy .json files
- **PDF reports** — customizable page size, orientation, DPI, and accent color with auto-captured screenshots and axis views
- **Screenshots** — PNG at selectable quality (1×, 2×, 4×) with optional scalebar in orthographic mode
- **Display modes** — Texture, Vertex Colors, Mesh, and Wireframe with configurable colors
- **Display controls** — brightness, model opacity, point size, text size, and background color (presets or custom)
- **Light controls** — camera-linked or fixed direction lighting with horizontal/vertical sliders for raking light analysis
- **Sharing** — upload to meshnotes.org for 90-day ephemeral links, or use permanent self-hosted links via DOI-minting repositories
- **Tablet support** — optimized for iPad with Apple Pencil (stylus for annotation, fingers for navigation, collapsible sidebar)
- **Label occlusion** — BVH-accelerated raycasting hides labels behind the model
- **Compression support** — DRACO and Meshopt decompression for GLB/GLTF files
- **Settings** — default author, measurement units/colors, screenshot quality, PDF options, display colors, background color
- **View Helper** — click axis circles to snap camera to standard view directions

### Supported formats

- GLB / GLTF (recommended)
- OBJ (with optional MTL and textures)
- PLY (with optional texture)
- STL (ASCII and binary, including per-face color)

### Standards

- W3C Web Annotation Data Model (JSON-LD)
- IIIF 3D-aligned selectors
- Z-up coordinate export for interoperability with photogrammetry/archaeology tools
- Apache-2.0 license


[1.5.1]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.5.1
[1.5.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.5.0
[1.4.2]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.4.2
[1.4.1]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.4.1
[1.4.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.4.0
[1.3.1]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.3.1
[1.3.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.3.0
[1.2.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.2.0
[1.1.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.1.0
[1.0.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.0.0
