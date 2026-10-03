// tests/support/import-map-hooks.js - Module resolve hook that applies index.html's import map in Node
// Registered by app-env.js; Node runs it on its module-loader thread. The map
// is read from index.html itself, so 'three', 'three/addons/...' and
// 'three-mesh-bvh' resolve to the same vendored files as in the browser, with
// no dependency and no second copy of the map to keep in sync.
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);

function readImportMap() {
    const html = readFileSync(new URL('index.html', ROOT), 'utf8');
    const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('import map not found in index.html');
    return JSON.parse(m[1]).imports || {};
}

const IMPORTS = readImportMap();
// Prefix entries ("three/addons/"), longest first, as the import map spec matches them.
const PREFIXES = Object.keys(IMPORTS).filter(k => k.endsWith('/')).sort((a, b) => b.length - a.length);

export async function resolve(specifier, context, nextResolve) {
    if (Object.prototype.hasOwnProperty.call(IMPORTS, specifier) && !specifier.endsWith('/')) {
        return { url: new URL(IMPORTS[specifier], ROOT).href, shortCircuit: true };
    }
    const prefix = PREFIXES.find(p => specifier.startsWith(p));
    if (prefix) {
        return { url: new URL(IMPORTS[prefix] + specifier.slice(prefix.length), ROOT).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
