# Changelog

All notable changes to MeshNotes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


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


[1.3.1]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.3.1
[1.3.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.3.0
[1.2.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.2.0
[1.1.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.1.0
[1.0.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.0.0
