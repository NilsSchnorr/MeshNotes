// tools/bvh-bench.mjs - Cost of the indirect BVH build (MeshNotes 1.6.6, item 7)
// Compares the in-place build MeshNotes used before 1.6.6 with the indirect
// build of BVH_OPTIONS on synthetic bumpy grids, indexed and without an index:
// build time, memory added, 1,000 raycasts, 200 brush shapecasts and 1,000
// nearest-point queries. Not part of the app and not precached.
//
// Run from the repository root:
//   node --max-old-space-size=8192 tools/bvh-bench.mjs            (1M and 5M triangles)
//   node --max-old-space-size=8192 tools/bvh-bench.mjs 1 5 15     (sizes in millions)
// --expose-gc gives steadier memory figures.
import '../tests/support/app-env.js';

const THREE = await import('three');
const { computeBoundsTree, acceleratedRaycast } = await import('three-mesh-bvh');
const { BVH_OPTIONS } = await import('../js/annotation-tools/face-order.js');

const sizes = process.argv.slice(2).map(Number).filter(n => n > 0);
const MILLIONS = sizes.length ? sizes : [1, 5];
const SIZE = 10;

function grid(triangles, indexed) {
    const n = Math.round(Math.sqrt(triangles / 2));
    let g = new THREE.PlaneGeometry(SIZE, SIZE, n, n);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, 0.3 * Math.sin(pos.getX(i) * 3.1) * Math.cos(pos.getY(i) * 2.3));
    if (!indexed) g = g.toNonIndexed();
    return g;
}

const gc = () => { if (globalThis.gc) globalThis.gc(); };
const memory = () => { const m = process.memoryUsage(); return m.arrayBuffers + m.heapUsed; };
const ms = (t0) => performance.now() - t0;

// A fixed pseudo-random sequence, so both builds get the same queries.
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function queries(mesh) {
    const rnd = lcg(42);
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    let t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
        raycaster.set(new THREE.Vector3((rnd() - 0.5) * SIZE, (rnd() - 0.5) * SIZE, 5), new THREE.Vector3(0, 0, -1));
        raycaster.intersectObject(mesh, false);
    }
    const ray = ms(t0);

    const bvh = mesh.geometry.boundsTree;
    const radius = 0.01 * SIZE, r2 = radius * radius;
    const centre = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
    let hits = 0;
    t0 = performance.now();
    for (let i = 0; i < 200; i++) {
        centre.set((rnd() - 0.5) * SIZE, (rnd() - 0.5) * SIZE, 0);
        bvh.shapecast({
            intersectsBounds: (box) => box.distanceToPoint(centre) <= radius,
            intersectsTriangle: (tri) => {
                c.copy(tri.a).add(tri.b).add(tri.c).divideScalar(3);
                if (c.distanceToSquared(centre) <= r2) hits++;
                return false;
            }
        });
    }
    const brush = ms(t0);

    const target = {};
    t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
        p.set((rnd() - 0.5) * SIZE, (rnd() - 0.5) * SIZE, (rnd() - 0.5) * 2);
        bvh.closestPointToPoint(p, target);
    }
    const nearest = ms(t0);
    return { ray, brush, nearest, hits };
}

function run(triangles, indexed, options) {
    const geometry = grid(triangles, indexed);
    gc();
    const before = memory();
    const t0 = performance.now();
    geometry.boundsTree = computeBoundsTree.call(geometry, options);
    const build = ms(t0);
    gc();
    const added = memory() - before;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.raycast = acceleratedRaycast;
    const q = queries(mesh);
    return { build, added, ...q };
}

const fmt = (v, d = 0) => v.toFixed(d).padStart(8);
// Warm-up, so neither build pays for the compiler alone.
for (const options of [{}, BVH_OPTIONS]) { run(2e5, true, options); run(2e5, false, options); }
console.log('triangles  index    build      ms   added MB  1000 rays ms  200 brush ms  1000 nearest ms');
for (const m of MILLIONS) {
    const triangles = Math.round(m * 1e6);
    for (const indexed of [true, false]) {
        for (const [label, options] of [['in place', {}], ['indirect', BVH_OPTIONS]]) {
            const r = run(triangles, indexed, options);
            console.log(`${String(m + 'M').padStart(9)}  ${(indexed ? 'yes' : 'no').padEnd(5)}  ${label.padEnd(8)} ${fmt(r.build)} ${fmt(r.added / 1048576, 1)}  ${fmt(r.ray, 1)}      ${fmt(r.brush, 1)}      ${fmt(r.nearest, 1)}`);
        }
    }
}
