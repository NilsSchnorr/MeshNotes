// tests/support/app-env.js - Lets Node tests load browser app modules (Three.js, state.js)
// Import it first, then load app modules with a dynamic import(): static
// imports are resolved before any module code runs, so they would miss the
// hook. It registers the import-map resolve hook (import-map-hooks.js) and
// stubs the one browser global touched at import time (helpers.js sets
// window.toggleManualItem). Nothing else is stubbed, so tests may call only
// the data functions, never code that reaches the DOM.
// Needs Node 18.19+ or 20.6+ (module.register); developed on Node 22.
import { register } from 'node:module';

register('./import-map-hooks.js', import.meta.url);
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
