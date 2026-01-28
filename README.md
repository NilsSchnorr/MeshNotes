# MeshNotes – 3D Annotation Tool for Research & Heritage

A browser-based tool for annotating 3D models with points, lines, polygons, and surfaces — designed for cultural heritage documentation.
You can either download the html file and documentation here or use the deployed version at: https://nilsschnorr.github.io/MeshNotes/


## About

**MeshNotes** allows teams to collaboratively mark and describe features on 3D models (photogrammetry, laser-scanning, structured light scanning, etc.) of archaeological sites, architecture, and artifacts (basically any kind of object).

![MeshNotes Screenshot 1](readmescreenshots/MNscreen1.png)

![MeshNotes Screenshot 2](readmescreenshots/MNscreen2.png)

Key features include:
- **Multi-entry annotations** — multiple users can add observations to the same feature with individual timestamps
- **Annotation types** — points, lines, polygons, and surface painting (surface painting works best on models under 500k faces)
- **Measurement tools** — measure distances directly on the model
- **Groups** — organize annotations with customizable colors and visibility toggles
- **Model Information** — add general notes about the entire model
- **Draggable points** — reposition annotation markers without recreating them
- **W3C Web Annotation export/import** — interoperable format (.jsonld) compatible with IIIF viewers and other annotation tools
- **PDF reports** — generate a PDF file for documentation/communication with auto-captured screenshots and all information gathered in the annotation process
- **Screenshots** — save the current view as a PNG image for documentation
- **Display controls** — adjust brightness, opacity, point size, text size, and toggle textures
- **Light controls** — camera-linked or fixed direction lighting with horizontal/vertical control for raking light analysis

The tool runs entirely in your browser — no installation or server required. Simply open the HTML file and start annotating. Your data stays on your computer unless you share the exported JSON file.

## Getting Started

1. Download and then open `index.html` in a modern web browser (Chrome, Firefox, Edge, or Safari - a chromium-based browser was used for most of the testing)
   Alternatively: use the deployed version of the same file on github pages: https://nilsschnorr.github.io/MeshNotes/
3. Click **Load GLB** to open a 3D model (`.glb` or `.gltf` format). This format is rather lightweight, has texture embedded and works best with the viewer architecture this tool uses (three.js)
4. Use the toolbar to add annotations
5. Export your work as JSON for backup/saving or team collaboration

### Converting Models

If your model is in OBJ or PLY format, convert it to GLB using [Blender](https://www.blender.org/) or [MeshLab](https://www.meshlab.net/) for best compatibility.

### Model Orientation

Ensure your model is oriented correctly (typically Y-up or Z-up) before exporting. The viewer's navigation is based on the model's original orientation and cannot be changed after loading. If your model appears upside down or sideways, re-export it with the correct orientation in your 3D software.

## Usage Tips

- **Single-click** an annotation in the sidebar to focus the camera on it
- **Double-click** to open it for editing
- **Drag annotation points** when no tool is active to reposition them
- **Surface tool**: Right-click and drag to rotate the view while painting — paint a continuous surface annotation from multiple angles (e.g., wrapping around a statue's arm)
- **Measurements** are displayed in "units" — the actual unit (meters, millimeters, etc.) depends on how your 3D model was created or exported
- **Camera toggle**: Click "Perspective/Orthographic" in the top-right to switch views — orthographic removes perspective distortion for accurate documentation
- **Fixed light direction**: Switch to fixed lighting mode and use the horizontal/vertical sliders for raking light analysis of surface details like tool marks or inscriptions
- Use the **opacity slider** to see annotations on the back side of the model
- Use the **point size** and **text size** sliders to adjust annotation visibility for your model's scale
- **Screenshots**: Click the Screenshot button to save the current view as a PNG image
- **Hide groups** before generating a PDF to exclude them from the report
- Press **Escape** to cancel drawing or clear measurements

## Export Format

MeshNotes exports annotations in the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) format (.jsonld). This standard format ensures:

- **Interoperability** with other annotation tools and viewers
- **Compatibility** with IIIF-based systems used in cultural heritage institutions
- **Future-proofing** through adherence to web standards
- **Extensibility** via custom namespaces for 3D-specific data

The export includes custom selectors for 3D geometry (points, polylines, polygons, and mesh faces) aligned with the emerging [IIIF 3D specifications](https://github.com/IIIF/3d). Legacy MeshNotes files (.json) can still be imported for backward compatibility.

## Dependencies

MeshNotes uses the following open-source libraries (loaded via CDN):

- [Three.js](https://threejs.org/) (MIT License) — 3D rendering
- [jsPDF](https://github.com/parallax/jsPDF) (MIT License) — PDF generation

## Author

**Nils Schnorr**  
Department of Classical Archaeology  
Saarland University, Saarbrücken, Germany

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
