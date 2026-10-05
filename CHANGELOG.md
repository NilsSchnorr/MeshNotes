# Changelog

All notable changes to MeshNotes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [1.6.2] — 2026-10-05

Two refinements of the survey CSV import: the markers shown while picking control points can be sized and no longer hide the picked spot, and accepting an alignment offers to set the display unit to metres.

### Added

- **Dot size slider for control-point picking** — the picking panel has a **Dot size** slider (×0.4 to ×3.0) for the markers drawn on the model while picking: the preview dots, the picks and the ring of the selected row. The Alignment Manager's control-point view has the same slider for its markers. Both show one setting, which is remembered in the browser (`meshnotes_surveyDotSize`) and set back to ×1.0 by **Reset All Settings**. Ctrl+Z still undoes the last pick while the slider has the focus.
- **Display unit question when an alignment is accepted** — a fit with the verdict Good or Check has an estimated scale within 5% of 1 against survey coordinates in metres, which confirms that the model is in metres. If the **Display unit** (Settings → Measurements) says something else, or is not set, accepting the alignment now first asks whether to set it to m. **Set to m** changes the unit and relabels the measurements already on the model; the other button keeps the unit, and the question is not asked again for that model until it is loaded again; closing the question or pressing Escape returns to the review without accepting. A custom unit that already says metres (meter, metre and their plurals) is not questioned, and a Poor fit never asks. The alignment is the same whatever the answer: the fit still has a fixed scale of 1, and the estimated scale is still only shown.

### Changed

- **Picks are drawn as a ring with a centre dot** — a pick used to be a filled disc drawn over the model, which hid the very spot it marks. It is now an open ring with a small centre dot, outlined dark, so the surface around the picked position stays visible. For the same reason a row whose pick is part of the fit no longer gets a cyan preview dot underneath: its residual line ends at the fitted position. In the control-point view the cyan dots of the fitted positions are smaller, so they sit inside the ring.
- **Picking markers no longer follow the Point Markers size** — they took the Point Markers multiplier, limited to ×0.5 to ×3.0. With a multiplier outside that range (the slider goes up to ×50) the markers stayed at the limit, and moving the slider changed nothing. Point Markers now sizes annotation markers only.

### Internal

- `js/core/lighting.js` gains `SURVEY_DOT_SIZE`, `surveyDotSizeChoice()` and `setSurveyDotSize()`; `restoreSurveySettings()` and `resetAllSettings()` handle the new key. The value lives in `state.surveyDotSize`.
- `js/survey/ui-alignment.js`: `spriteTexture()` takes the sprite kind (`dot`, `ring`, `pick`); the display-unit question (`shouldOfferMetres()`, `showUnitPrompt()`, `answerUnitPrompt()`) sits between the review's Accept button and `finishAccept()`, so the existing checks of the session and the loaded model still run after the answer. Models whose unit was kept are held in a `WeakSet`.
- `tests/lighting.test.js` gains four tests for the dot size (range, setter, restore and reset, and agreement with both sliders in `index.html`).
- No file format, specification or vendored library changed, and no new module was added, so the precache list is unchanged.


## [1.6.1] — 2026-10-05

A bug-fix release. Models with more than 10 million faces in a single mesh are now drawn in Firefox, where they loaded without any error but left the viewport empty.

### Fixed

- **Very large models stayed invisible in Firefox** — Firefox refuses any single WebGL draw call that addresses more than 30 million vertex ids (its `webgl.max-vert-ids-per-draw` setting, which a web page can neither read nor raise). A mesh is drawn with three ids per face in one call, so a mesh above 10 million faces went over that limit. The model loaded, reached the GPU and built its acceleration structure as usual, but Firefox dropped the draw on every frame and only wrote a warning to the console; for a 40-million-face model it read "Context's max indexCount is 30000000, but 120000000 requested". MeshNotes now draws every mesh above 4 million faces in several calls of at most 4 million faces each. The same split keeps wireframe mode, which addresses six ids per face, within the limit. Models up to 4 million faces are drawn exactly as before, and browsers without this limit only issue a few more draw calls; in Chromium the rendered image is pixel-identical to the previous version. Annotation files are unaffected: the faces of a model keep their numbering, so saved surface annotations stay on the same triangles.

### Internal

- `js/core/model-loader.js` gains `DRAW_CHUNK_FACES` (4,000,000), `chunkLargeDraws()` and `setMeshMaterial()`. A mesh above the chunk size gets geometry groups that all use material 0, and its material is wrapped in a one-element array, because Three.js issues one draw call per group only for an array material and falls back to a single call as soon as a single material is assigned. `applyDisplayMode()` therefore assigns materials through `setMeshMaterial()`; any new code that gives a model mesh a material has to do the same, otherwise the split is lost and only Firefox shows it.
- The split runs after the BVH build, on purpose. `three-mesh-bvh` builds one root per geometry group and sorts the index buffer inside each root, and surface annotations store their faces as positions in that sorted buffer (`meshnotes:faces`). Groups present during the build would renumber the faces of every large model and detach existing surface annotations from their triangles; added afterwards, they only cut the sorted buffer into ranges. A geometry that already has groups (a multi-material OBJ) is not split, because its BVH roots follow those groups.
- New `tests/draw-chunks.test.js` (eight tests) covers the group layout, non-indexed geometry, the material helper, the unchanged index buffer and raycast results after the split, with and without a BVH, and the renumbering that splitting before the build would cause.
- No vendored library changed.


## [1.6.0] — 2026-10-04

This release adds survey CSV import: the rows of a survey file, such as the export of a GNSS rover or a total station, become point annotations on the model, placed by a control-point alignment that is made, reviewed and saved inside MeshNotes. The model itself never moves, so existing annotations keep their positions. Alongside it come a position lock for every annotation, collapsible groups with a per-group label switch, and a choice between moving and deleting a group's annotations when the group is deleted. Files saved by this version carry new optional members; read the **Compatibility** notes below before passing files back and forth with MeshNotes 1.5.x or earlier.

### Added

- **Survey points (CSV) import** — a third item in the **Import ▾** menu, available once a model is loaded, turns the rows of a survey CSV file into point annotations. Encoding, delimiter, decimal separator and header row are detected, and each can be overridden; a preview of the first ten rows tints cells in the coordinate columns that are not numbers. The Name, Easting, Northing, Height, Description and Code columns are mapped automatically from common English, German and Turkish column names, or from the Auto, Emlid Flow, PENZD and PNEZD presets, and the mapping is remembered for each CSV header. Further columns, such as accuracy values or the solution status, can be kept as attributes; columns that may hold personal data, such as an author or a device serial number, are never ticked by default and raise a warning when ticked. The import needs metric, projected coordinates: it refuses values that look like latitude and longitude in degrees, and warns about Easting and Northing that appear to be swapped (with a Swap button), columns named X and Y, coordinates rounded to one decimal or none, and a height column that differs from the one an alignment was made with.
- **Control-point alignment made inside MeshNotes** — a new alignment is made by picking at least three CSV rows on the model (four or more are recommended), each with a click or tap where it was surveyed, or from the position of an existing point annotation. A rigid fit — rotation plus shift, with the scale fixed at 1 — is solved live while you pick: the panel shows the RMS, the largest residual, the estimated scale and the tilt, previews every row at its fitted position, and warns about picks in a line or bunched together, swapped Easting and Northing, a mirror image, a model turned on its side or upside down (usually the wrong up-axis at load time), a scale far from 1 (with a hint at millimetres, centimetres or feet), a pick that does not fit the others (found by leave-one-out), large residuals, and control points more than 2 km apart. A **Model is already level** checkbox switches to a level-only fit that turns about the vertical axis only; it is suggested when the full fit tilts the model by less than 0.5°, is never ticked automatically, and is saved with the alignment. The review step gives a **Good**, **Check** or **Poor** verdict (accepting a Poor fit asks for confirmation), the RMS of the full and the level-only fit side by side, the heading, and a table of residuals and leave-one-out errors per control point, where each point can be left out or re-picked. Picks can be undone with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd>, <kbd>Esc</kbd> works in stages and asks before discarding the session, and the annotation tools are disabled while the picking panel is open. The picking markers are drawn on screen only, never in screenshots or reports.
- **Selecting the points that lie on the model** — after the fit, or straight away when a file is imported into an alignment the model already has, every row is placed and its distance to the model surface is measured, in chunks with a progress line for large files. The dialog states how many rows lie on the model — for example "20 of 44 rows lie within 0.5 m of the model surface" — lists every row nearest first, and ticks the rows within the distance limit: 0.5 m by default, adjustable for each import. Single rows can be ticked or unticked, or every row imported. When no row lands near the surface, the dialog asks whether the coordinate system or the column mapping is wrong, and offers to swap Easting and Northing (only when that would land rows on the model), to make a new alignment, or to change the mapping. Rows already imported into the same alignment are recognised and skipped.
- **Imported survey points** — every imported row becomes an ordinary point annotation that sits on the model surface, at the surface point nearest to its fitted position. Its surveyed Easting, Northing and Height, the CSV values verbatim, the kept attributes, the source file and row, and the distance from the fitted position to the surface are stored beside it. Imported points start **locked** and go into their own group, named after the file, which starts collapsed and — above 50 points — with its labels off. The edit popup and the read-only panel of a shared annotation show a **Surveyed position** block, including "moved by hand" and the offset when an unlocked point has been dragged, and the selection callout shows one line with E, N and H. A copyable **import summary** lists the points imported, the rows left off the model or unticked, the rows skipped with their reason and row number, and warnings such as duplicate names or points far from the surface.
- **Alignment Manager and status chip** — a chip next to the face count shows whether the model has no alignment, one (with its RMS) or several. Clicking it opens the **Alignment Manager**, which lists each alignment with its verdict, coordinate system label, height column, fit type, control points, RMS, number of points and history. An alignment can be **viewed** (the read-only review table, with its picks and residuals drawn on the model), **renamed** and relabelled, **refined** (add, re-pick or leave out control points, or change the level option), **re-aligned from scratch**, **set as default** for the mapping step, or **deleted**. A refine or re-align keeps the previous fit in the alignment's history; when points would move, a preview shows how many and how far, and you choose to move them — onto the surface again — or to keep them where they are. Points moved by hand never move. Deleting an alignment that places points offers to detach them (they stay where they are and keep their surveyed coordinates) or to delete them too. An alignment made on a different model file (compared by SHA-256) or with the model loaded with another up-axis shows a binding warning in the manager and the mapping step, and can still be used.
- **Position lock for every annotation** — a **Locked** toggle in each annotation's edit popup protects its position: a locked point or line/polygon vertex cannot be dragged, and a locked box cannot be moved, resized or rotated; the camera orbits as usual instead. Name, group and entries stay editable, and a locked annotation can still be deleted. Locked annotations show a padlock in the sidebar. New annotations start unlocked; imported survey points start locked.
- **Collapsible groups** — each group in the sidebar has a chevron that collapses or expands its list, and the state is saved with the annotations. While a search term is active, collapsed groups are searched too.
- **Show labels per group** — a **Show labels** checkbox in the group popup switches the 3D name labels of all annotations in a group on or off; the markers stay visible.
- **Move or delete when deleting a group** — deleting a group that still holds annotations now asks whether to move them to a group you pick or to delete them together with the group; previously they were moved without asking. An empty group is deleted at once, and the last remaining group still cannot be deleted.
- **Survey import settings** — a fifth Settings category, **Survey import**, with six options: **Lock imported points** (on), **Hide labels of large imports** (above 50 points), **Residual warning** (5 cm), **Surface-distance warning** (10 cm), **Distance limit for selecting points on the model** (0.5 m) and **Include alignment summary in PDF report** (on). The column mappings remembered for each CSV header (up to 20) are kept as well, and **Reset All Settings** clears them with the rest. The RMS limits of the Good and Poor verdicts are fixed; among the settings, only the residual warning can turn Good into Check, so the PDF summary prints it next to the verdict.
- **Survey data in the PDF report** — a survey point's page carries one extra line with its surveyed coordinate, height column and coordinate system label ("detached" when it has lost its alignment, and "moved by hand" when that applies). An optional **Survey alignments** section after the metadata pages, listed at the end of the table of contents, summarises the alignments used by points in visible groups: fit type, control points, RMS, largest residual, estimated scale, tilt, heading, verdict, number of points, dates and any binding warning. The report otherwise keeps its structure of one page per visible annotation.
- **Survey data in the JSON-LD export** — alignments are written at collection level as `meshnotes:alignments`, each a `meshnotes:SurveyAlignment` with its fit, quality figures, frozen copies of its control points and the earlier fits in `meshnotes:alignmentVersions`, together with `meshnotes:defaultAlignment`. A survey point carries `meshnotes:surveyedPosition` next to `annotationType`, and a locked annotation `meshnotes:locked`. Groups carry `meshnotes:labelsVisible` and `meshnotes:collapsed` when they differ from the defaults, and `modelSource` records the offset by which the model was centred on load as `meshnotes:frameOrigin`. All of these are optional additions within version 1 of the format, described in the new section §10.1 of the annotation specification (dated 2026-10-04); `ns/context-v1.jsonld` gains six additive entries, while the selector specification and `schema.json` are unchanged.
- **Merging survey data** — when a JSON-LD file is imported, alignments are matched by their UUID. A different alignment is added; for the same alignment, the copy modified more recently wins and the other fit is kept in its history. Survey points placed by the fit always follow the alignment that won the merge: points that were placed with the other fit are moved to the winning fit and snapped to the surface again, and the status line reports how many moved and the largest move. Points moved by hand stay where they are; for them, as for every other annotation, the newer entries decide. Alignments are carried by the autosave and by share links as well; an unfinished picking session is never saved.

### Changed

- **Shared marker geometry** — all point markers now share one sphere geometry, and all line and polygon vertex markers another, kept across scene rebuilds. Previously every marker created its own geometry on every redraw, including every pointer move during a drag, which matters once an import adds hundreds of points. Each marker keeps its own material, so the selection emphasis and the size sliders behave as before.
- **Autosave fingerprint** — the change check of the idle autosave now also covers alignments and the default alignment, locks, points moved by hand, the collapse and label settings of groups, and every annotation coordinate, including box size and rotation. A refine, a lock change or a drag is therefore saved by the 30-second idle save instead of only when the page is hidden, and no autosave is written in the middle of a two-finger box rotation. A saved session that holds only alignments is offered for restore as well.
- **Search filter kept across sidebar rebuilds** — the sidebar search was dropped whenever the group list was rebuilt, for example after an import, a group edit or a deletion; it now stays applied. Hidden groups stay listed during a search, so their visibility button remains within reach.
- **Unsaved-work check covers alignments** — the warning before loading another model counts alignments, and loading another model clears them together with the annotations and groups.
- **Sidebar icons drawn after loading** — the group list is redrawn once the icon files have loaded, so its icons no longer depend on loading order (see Fixed).
- **Manual** — a new *Survey Points (CSV Import)* item covers the four import steps, what an imported point is, the Alignment Manager, saving and merging, and the limits of the method. *Groups*, *Editing Annotations*, *Moving Annotation Points*, *Export & Import*, *Collaborative Workflow*, *PDF Report* and the *Settings* walkthrough are updated for collapsing, labels, the delete dialog, the lock, the surveyed position, the survey data in the export and the new settings. The About panel and the README mention survey import.

### Fixed

- **Missing eye and edit icons on first load** — the groups listed at start-up, such as the default group, could appear without their visibility and edit icons, because the list was drawn before the icon files had loaded. The list is now drawn again once they are available.
- **Group changes reset an open annotation popup** — saving or deleting a group while an annotation popup was open switched the popup's group choice to the first group, so the annotation could be saved into the wrong group. The popup now keeps its choice, or, when that group was deleted and its annotations moved, follows them to their new group.
- **A click on a point marker could shift the point** — the slightest pointer movement between press and release on a point marker dragged the point to the surface under the cursor. Movement within the click radius (12 px for a pen, 3 px for a mouse or touch) is now ignored, so a click, or a slightly unsteady pen tap, leaves the point where it is.

### Compatibility

- **Files re-exported by MeshNotes 1.5.x or earlier lose survey data, alignments and locks.** Older versions rebuild each annotation from the fields they know. A 1.6.0 file opened in 1.5.x shows every point at its correct position, but exporting it again from that version drops the alignments and the default alignment, the surveyed positions, the locks, the collapse and label settings of groups and the frame origin. Point positions are kept. Keep survey work in 1.6.0 or later. When such a re-export is merged back into a 1.6.0 session, the survey data of points already in the session is kept, but an ordinary annotation whose entries were edited in the older version comes back unlocked.
- **Changing the lock does not change any timestamp.** On a merge, the lock follows the copy whose position wins: for an ordinary annotation the one with the newer entries, for a survey point the one that follows the winning alignment. For an ordinary annotation or a point moved by hand, a lock change on its own therefore only wins together with newer entries; for a survey point placed by the fit it only comes through with a newer copy of its alignment.
- MeshNotes 1.6.0 reads files from earlier versions unchanged.

### Internal

- New folder `js/survey/`. Pure modules with no DOM or Three.js imports: `linalg.js` (vector and matrix helpers, a Jacobi eigen-solver, quaternions), `rigid-fit.js` (Horn's closed-form quaternion fit, the level-only fit, conditioning, leave-one-out, mirror and swap detection, and all thresholds as named constants), `csv-parse.js` (decoding with BOM, strict UTF-8 and a Windows-1252/1254 fallback, RFC 4180 tokenising, delimiter, header and decimal detection), `column-mapping.js` (synonyms, presets, checks), `alignment.js` (alignment records and versions, the survey ↔ model transforms, row classification, duplicate rules, JSON-LD reading, writing and merging), `picking.js`, `manager.js` and `survey-display.js` (picking session, manager and display logic). Browser modules: `survey-import.js` (surface distances, snapping, creation), `ui-mapping.js`, `ui-alignment.js` and `ui-manager.js`, plus `js/annotation-tools/survey-block.js`. The CSV parser and the solver are hand-written; no dependency was added.
- The transform is `survey = R · p + t`, with `p` in the exported Z-up frame; the inverse subtracts first, in double precision, so large projected coordinates never reach the Three.js scene.
- `js/annotation-tools/projection.js` gains a nearest-surface-point query on the existing BVH (`nearestSurfacePoints()` and its flip-aware variant), with chunking left to the caller.
- The pure coordinate helpers (`wktNum`, `wktPointZ`, `parsePointZ`, `parseWKT`, `pointToZUp`, `pointFromZUp`) moved unchanged from `js/export/w3c-format.js` to the new `js/utils/coords.js`, so tests can load them without Three.js; `w3c-format.js` re-exports the two point converters for existing importers.
- The model loader keeps the centring offset as `state.modelFrameOrigin` and fires a model-replaced hook on every model setup. New state fields `alignments`, `defaultAlignmentId`, `surveySession` and the survey settings; the setters live in `js/core/lighting.js` beside the other settings setters.
- Picking and control-point markers live in their own scene group on a separate camera layer that only the on-screen render enables, so the annotation rebuild never clears them and screenshots, the plate and the PDF report never see them, without changes to the capture modules.
- The data part of the JSON-LD import is exported as `mergeW3CCollection()` from `js/export/import-json.js`, so it can be tested without a page. The PDF report now fills its table of contents last.
- New placeholder icons `chevron.svg`, `lock.svg` and `unlock.svg`; every new module and icon is in the service worker's precache list.
- New `package.json` (no dependencies, no build step) marks the code as ES modules for Node and defines the test command `npm test`, which runs `node --test tests/*.test.js`. The `tests/` folder holds one test file per pure module with small made-up CSV samples, a precache guard that fails when a module under `js/` or an icon is missing from the service worker's precache list, a version check that fails when `APP_VERSION`, the service worker cache name, `CITATION.cff` and the changelog disagree, and an import-map harness (`tests/support/`) that resolves the app's bare `three` imports through the import map in `index.html`, so the data functions of browser modules can be tested in Node. Running the tests needs Node.js 18.19 / 20.6 or later; the app itself still needs no build step.


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


[1.6.2]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.6.2
[1.6.1]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.6.1
[1.6.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.6.0
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
