// The browser build's `index.html` IS the API docs — the Scalar reference shell (`buildDocs`, src/docs.ts),
// served statically at the deploy root. It is BYTE-IDENTICAL to what the Service Worker serves at `/docs`,
// because both are built from the SAME two browser-relative args, kept in ONE place here so they cannot
// drift:
//   - `./scalar.js`    — the vendored Scalar UI (shipped beside index.html; no CDN).
//   - `./mogwai-db.js` — the ONE bootstrap: it registers the Service Worker (the local HTTP edge) and hosts
//     this tab's WorkerFactory (the graph data plane). Because the site root is now the docs itself (there
//     is no redirect hop), a fresh visit lands on a page the SW does not yet control; the shell (src/docs.ts)
//     DEFERS mounting Scalar until the SW takes control (the SW skipWaiting + clients.claim, so no reload is
//     needed), so the first `./openapi.json` fetch and the interactive "Test Request" fetches to
//     `gremlin/{g}` are served by the local edge.
// Keeping the shell in one place is what guarantees the static index and the SW-served `/docs` never drift.
import { buildDocs } from '../docs.ts';

/** The Scalar UI module + the bootstrap, both relative to the served page. The SW passes these to
 *  `makeRouter` (for its `/docs`); the packager + the sub-path e2e write the identical shell as `index.html`. */
export const BROWSER_SCALAR_URL = './scalar.js';
export const BROWSER_BOOT_SCRIPT = './mogwai-db.js';

/** The browser build's `index.html`: the docs shell, identical to the SW-served `/docs`. One source of
 *  truth for the packager (scripts/package.ts) and the sub-path e2e (test/browser/subpath-e2e.test.ts). */
export const BROWSER_INDEX_HTML = buildDocs(BROWSER_SCALAR_URL, BROWSER_BOOT_SCRIPT).DOCS_HTML;
