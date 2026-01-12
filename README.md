# MeshNotes

A browser-based tool for annotating 3D models with points, lines, polygons, and surfaces — designed for cultural heritage documentation.

## About

**MeshNotes** allows teams to collaboratively mark and describe features on 3D models (photogrammetry, laser-scanning, structured light scanning, etc.) of archaeological sites, architecture, and artifacts (basically any king of object).

![MeshNotes Screenshot 1](readmescreenshots/MNscreen1.png)

![MeshNotes Screenshot 2](readmescreenshots/MNscreen2.png)

Key features include:
- **Multi-entry annotations** — multiple users can add observations to the same feature with individual timestamps
- **Annotation types** — points, lines, polygons, and surface painting (surface painting works only for objects up to about 1m faces)
- **Measurement tools** — measure distances directly on the model
- **Groups** — organize annotations with customizable colors and visibility toggles
- **Model Information** — add general notes about the entire model
- **Draggable points** — reposition annotation markers without recreating them
- **JSON export/import** — share annotations with team members
- **PDF reports** — generate a PDF file for documentation/communication with auto-captured screenshots and all information gathered in the annotation process
- **Display controls** — adjust brightness, opacity, and toggle textures

The tool runs entirely in your browser — no installation or server required. Simply open the HTML file and start annotating. Your data stays on your computer unless you share the exported JSON file.

## Getting Started

1. Download and then open `meshnotes.html` in a modern web browser (Chrome, Firefox, Edge, or Safari - a chromium-based browser was used for most of the testing)
2. Click **Load GLB** to open a 3D model (`.glb` or `.gltf` format). This format is rather lightweight, has texture embedded and works best with the viewer architecture this tool uses (three.js)
3. Use the toolbar to add annotations
4. Export your work as JSON for backup/saving or team collaboration

### Converting Models

If your model is in OBJ or PLY format, convert it to GLB using [Blender](https://www.blender.org/) or [MeshLab](https://www.meshlab.net/) for best compatibility.

## Usage Tips

- **Single-click** an annotation in the sidebar to focus the camera on it
- **Double-click** to open it for editing
- **Drag annotation points** when no tool is active to reposition them
- **Surface tool**: Right-click and drag to rotate the view while painting — paint a continuous surface annotation from multiple angles (e.g., wrapping around a statue's arm)
- Use the **opacity slider** to see annotations on the back side of the model
- **Hide groups** before generating a PDF to exclude them from the report
- Press **Escape** to cancel drawing or clear measurements

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
