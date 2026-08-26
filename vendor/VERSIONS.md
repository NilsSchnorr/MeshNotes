# Vendored third-party libraries

All third-party runtime dependencies are self-hosted under `vendor/` rather than
loaded from a CDN. This is deliberate: it keeps MeshNotes free of third-party
network requests (GDPR), and makes the deployed app fully functional offline via
the service worker.

This file records exactly which upstream release each vendored copy corresponds
to. Every entry has been verified by SHA-256 against the published upstream
artefact — not by version string or by eye. Update this file whenever a
vendored library is added, upgraded, or patched.

Last verified: 2026-08-26

## Contents

| Library | Version | Licence | Upstream |
|---|---|---|---|
| three.js | r160 | MIT | https://github.com/mrdoob/three.js |
| three-mesh-bvh | 0.8.2 | MIT | https://github.com/gkjohnson/three-mesh-bvh |
| Draco (glTF variant) | as shipped with three r160 | Apache-2.0 | https://github.com/google/draco |
| jsPDF | 2.5.1 | MIT | https://github.com/parallax/jsPDF |
| pdf-lib | 1.17.1 | MIT | https://github.com/Hopding/pdf-lib |

## Verified checksums

SHA-256, against the upstream npm tarball for the stated version.

### three.js r160 — `vendor/three/`

Source: `three@0.160.0`, `build/three.module.js` and `examples/jsm/**`.

```
76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495  build/three.module.js
```

The `examples/jsm/` addons (OrbitControls, ViewHelper, BufferGeometryUtils,
meshopt_decoder, Line2 and friends, GLTFLoader, DRACOLoader, OBJLoader,
MTLLoader, PLYLoader, STLLoader) are taken unmodified from the same r160
distribution; `GLTFLoader.js` and `OrbitControls.js` were spot-checked and match.
Addons must always be upgraded together with the core build — three does not
guarantee cross-revision compatibility between them.

### three-mesh-bvh 0.8.2 — `vendor/three-mesh-bvh/`

Source: `three-mesh-bvh@0.8.2`, `build/index.module.js`.

```
2021fc6446ff8c4212df167e50d56916eec1d4c13e7b74c0473c9248de400a6a  index.module.js
```

Peer requirement is `three >= 0.159.0`, satisfied by r160.

**Do not downgrade below 0.8.2.** Versions 0.7.1 through 0.8.1 over-allocate the
triangle bounds buffer during BVH construction by a factor of four
(`triCount * 6 * 4` where only `triCount * 6` is ever written). On large models
this turns a manageable request into one that the browser refuses: a
27.19M-face model needed a single contiguous 2.43 GiB `ArrayBuffer` instead of
622 MiB, and the build failed with `RangeError: Array buffer allocation failed`.
MeshNotes catches that and continues without acceleration, so the only symptom
is silent degradation — no crash, no error shown to the user. Upstream fixed it
in 0.8.2 ("Unnecessarily large triangle bounds buffer used during BVH
construction"). See the comment at the BVH build block in
`js/core/model-loader.js`.

MeshNotes uses only `computeBoundsTree`, `disposeBoundsTree`,
`acceleratedRaycast` and `geometry.boundsTree.shapecast()`. There is no direct
`MeshBVH` construction and no use of serialized BVH data, which keeps the blast
radius of any future upgrade small. Note that 0.9.4 changed serialized-node
indexing and 0.9.x refactored the build internals substantially — worth knowing
before moving off the 0.8 line.

### Draco — `vendor/draco/`

Source: `three@0.160.0`, `examples/jsm/libs/draco/gltf/`.

```
8625489da79a805f4f2a7d511c3e52d8b4085608a9d2a4d5f4f9de5db0aea04f  draco_decoder.js
a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac  draco_decoder.wasm
8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6  draco_wasm_wrapper.js
```

This is the **glTF variant** (`libs/draco/gltf/`), not the default build — the
one targeted by the `KHR_draco_mesh_compression` extension, which is what
`GLTFLoader` needs. The vendored `README.md` is upstream's and describes both
variants; it does not itself indicate which one is present here. Loaded at
runtime by `DRACOLoader` from `vendor/draco/` (see `js/core/model-loader.js`),
so these files are fetched lazily rather than imported.

### jsPDF 2.5.1 — `vendor/jspdf/`

Source: `jspdf@2.5.1`, `dist/jspdf.umd.min.js`.

```
98ccf17aa10c20bb1301762618fcc9b6ab3a4e7f26b6071d64d0b41154df3875  jspdf.umd.min.js
```

Loaded as a classic script from `index.html`.

### pdf-lib 1.17.1 — `vendor/pdf-lib/`

Source: `pdf-lib@1.17.1`, `dist/pdf-lib.min.js`.

```
0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f  pdf-lib.min.js
```

The minified bundle carries no version string, so the hash above is the only
reliable identifier. Loaded as a classic script from `index.html`.

## Local modifications

None. Every vendored file is byte-identical to its upstream release.

If a local patch ever becomes necessary, record it here — what changed, why, and
against which upstream version — and add a header comment to the patched file.
An undocumented patch will be silently lost the next time the library is
upgraded.

## Upgrading

1. Fetch the upstream artefact for the target version (npm tarball is the
   canonical source for all of the above).
2. Replace the vendored file(s) and verify with `shasum -a 256`.
3. Update the version, checksum and "Last verified" date in this file.
4. Add the affected paths to `PRECACHE` in `sw.js` if new files appear, and bump
   `CACHE` — clients are served cache-first and will otherwise keep the old copy.
5. Note the change in `CHANGELOG.md`, including any user-visible effect.
