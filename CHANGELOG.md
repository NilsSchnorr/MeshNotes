# Changelog

All notable changes to MeshNotes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


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

### Standards

- W3C Web Annotation Data Model (JSON-LD)
- IIIF 3D-aligned selectors
- Z-up coordinate export for interoperability with photogrammetry/archaeology tools
- Apache-2.0 license


[1.0.0]: https://github.com/NilsSchnorr/MeshNotes/releases/tag/v1.0.0
