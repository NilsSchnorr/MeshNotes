#!/usr/bin/env bash
#
# vendor-libs.sh — Download all third-party front-end libraries into ./vendor/
# so MeshNotes loads them from its own origin instead of public CDNs
# (no visitor IP is sent to unpkg / cdnjs / Google before any interaction).
#
# Run ONCE from anywhere inside the repo:
#     bash tools/vendor-libs.sh
#
# Re-run to re-fetch or update (bump the version pins below first, and keep
# them in sync with index.html, viewer.html and js/core/model-loader.js).
#
# Requires: curl (preinstalled on macOS and most Linux).
# After running, commit ./vendor/ — GitHub Pages serves only committed files.

set -euo pipefail

# ── Pinned versions (MUST match the importmap + setDecoderPath in the app) ──
THREE_VER="0.160.0"
BVH_VER="0.8.0"
JSPDF_VER="2.5.1"
PDFLIB_VER="1.17.1"

THREE_BASE="https://unpkg.com/three@${THREE_VER}"
BVH_URL="https://unpkg.com/three-mesh-bvh@${BVH_VER}/build/index.module.js"
JSPDF_URL="https://cdnjs.cloudflare.com/ajax/libs/jspdf/${JSPDF_VER}/jspdf.umd.min.js"
PDFLIB_URL="https://unpkg.com/pdf-lib@${PDFLIB_VER}/dist/pdf-lib.min.js"

# Resolve repo root as the parent of this script's directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

echo "Vendoring third-party libraries into ${ROOT}/vendor/"
echo ""

fetch() {  # fetch <url> <destination-relative-to-root>
  local url="$1" dest="$2"
  mkdir -p "$(dirname "${dest}")"
  echo "  -> ${dest}"
  curl -fSL --retry 3 -o "${dest}" "${url}"
}

# ── three.js core ───────────────────────────────────────────────────────────
fetch "${THREE_BASE}/build/three.module.js" "vendor/three/build/three.module.js"

# ── three.js add-ons (exact import closure used by MeshNotes) ───────────────
#    If you later import a NEW three/addons/* module, add it to this list
#    and re-run the script.
JSM=(
  controls/OrbitControls.js
  helpers/ViewHelper.js
  lines/Line2.js
  lines/LineGeometry.js
  lines/LineMaterial.js
  lines/LineSegments2.js
  lines/LineSegmentsGeometry.js
  loaders/DRACOLoader.js
  loaders/GLTFLoader.js
  loaders/MTLLoader.js
  loaders/OBJLoader.js
  loaders/PLYLoader.js
  loaders/STLLoader.js
  libs/meshopt_decoder.module.js
  utils/BufferGeometryUtils.js
)
for f in "${JSM[@]}"; do
  fetch "${THREE_BASE}/examples/jsm/${f}" "vendor/three/examples/jsm/${f}"
done

# ── Draco decoder (fetched at runtime by DRACOLoader; r160-matched build) ───
#    DRACOLoader.setDecoderPath('vendor/draco/') expects these three files.
for f in draco_decoder.js draco_decoder.wasm draco_wasm_wrapper.js; do
  fetch "${THREE_BASE}/examples/jsm/libs/draco/gltf/${f}" "vendor/draco/${f}"
done

# ── three-mesh-bvh (single bundled ES module) ───────────────────────────────
fetch "${BVH_URL}" "vendor/three-mesh-bvh/index.module.js"

# ── jsPDF (UMD global, <script> tag) ────────────────────────────────────────
fetch "${JSPDF_URL}" "vendor/jspdf/jspdf.umd.min.js"

# ── pdf-lib (UMD global, <script> tag) ──────────────────────────────────────
fetch "${PDFLIB_URL}" "vendor/pdf-lib/pdf-lib.min.js"

echo ""
echo "Done. Review ./vendor/, then commit it:"
echo "    git add vendor && git commit -m 'Self-host front-end libraries (Three.js, BVH, jsPDF, pdf-lib, Draco)'"
