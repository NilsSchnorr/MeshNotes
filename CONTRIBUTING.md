# Contributing to MeshNotes

Thank you for your interest in contributing to MeshNotes! This document explains how you can help.

## Reporting Bugs

If you find a bug, please open an [issue on GitHub](https://github.com/NilsSchnorr/MeshNotes/issues) with:

- A clear description of the problem
- Steps to reproduce it
- Your browser and operating system
- The 3D model format you were using (GLB, OBJ, PLY), if relevant
- A screenshot, if it helps illustrate the issue

## Suggesting Features

Feature suggestions are welcome as GitHub issues. Please describe:

- What you want to achieve (the use case)
- How you currently work around the missing feature, if applicable
- Whether the feature relates to a specific standard (W3C Web Annotation, IIIF 3D, CIDOC-CRM, etc.)

## Contributing Code

1. Fork the repository and create a branch from `main`
2. Make your changes — keep commits focused and well-described
3. Test your changes in at least Chrome and Firefox, with a real 3D model
4. Open a pull request with a clear description of what the change does and why

By submitting a pull request, you agree that your contribution is licensed under the same [Apache License 2.0](LICENSE) that covers MeshNotes.

### Code Style

- MeshNotes uses vanilla ES6 modules (no bundler, no framework)
- External libraries are loaded via CDN in the importmap — do not add npm/node dependencies
- Keep the tool browser-only with no server-side components
- All annotation data stays local — do not add network transmission of user data

## Questions

If you have questions about the project or want to discuss a contribution before starting, feel free to open an issue or contact [nils.schnorr@uni-saarland.de](mailto:nils.schnorr@uni-saarland.de).
