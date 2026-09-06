// The browser build's landing page (shipped as `index.html`). It is NOT a demo: this page IS a live
// mogwai-db instance. It includes the ONE bootstrap script (`mogwai-db.js`, which registers the service
// worker), waits until that worker CONTROLS the page, then hands off to the API reference (`/docs`) — the
// UI for a mogwai-db instance. Every URL is relative, so the page works whether the build is served at the
// origin root or under a sub-path (a GitHub Pages project site, `/{repo}/`).
//
// Exported as a plain string with no side effects so BOTH the packager (scripts/package.ts) and the
// browser e2e test (test/browser/subpath-e2e.test.ts) use the exact same page — one source of truth.
export const LANDING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mogwai-db</title>
<!-- Include this ONE script; it registers the service worker and installs the per-tab worker factory.
     mogwai-db.js resolves ./service-worker.js and ./worker.js relative to itself, so keep the four files
     (mogwai-db.js, service-worker.js, worker.js, sqlite3.wasm) together at any path — including a SUB-PATH
     deploy like a GitHub Pages project site (https://user.github.io/repo/). -->
<script type="module" src="./mogwai-db.js"></script>
<style>
  :root { color-scheme: light dark; --fg: #1a1a2e; --muted: #5b5b74; --bg: #fbfbfd; --accent: #6c4cd6; --line: #e6e6ef; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e8f0; --muted: #a0a0b8; --bg: #14141c; --accent: #b3a0ff; --line: #2a2a3a; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 34rem; }
  h1 { font-size: 2rem; margin: 0 0 .25rem; letter-spacing: -0.02em; }
  .tag { color: var(--muted); margin: 0 0 1.5rem; }
  p { margin: 0 0 1rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: color-mix(in srgb, var(--accent) 12%, transparent);
    padding: .1em .4em; border-radius: 4px; font-size: .9em; }
  a.button { display: inline-block; margin-top: .5rem; padding: .6rem 1.1rem; border-radius: 8px; text-decoration: none;
    background: var(--accent); color: #fff; font-weight: 600; }
  .status { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .9em; }
  .status[data-state="ready"] { color: var(--fg); }
</style>
</head>
<body>
<main>
  <h1>mogwai-db</h1>
  <p class="tag">A TinkerPop&nbsp;4 Gremlin graph database, compiled to SQLite/WASM, running entirely in your browser.</p>
  <p>This page <strong>is</strong> a live mogwai-db instance. A service worker is the local HTTP edge; each
     graph is an isolated SQLite database persisted in your browser's storage (OPFS). Any TinkerPop&nbsp;4
     client — or a plain <code>fetch</code> — talks to it at <code>gremlin/{graph}</code>, no server.</p>
  <p>The API reference is the interface. It opens automatically once the local edge is ready.</p>
  <a class="button" id="docs" href="./docs">Open the API reference →</a>
  <p class="status" id="status">Starting the local database…</p>
</main>
<script type="module">
  // mogwai-db.js registered the service worker; once it CONTROLS this page the whole HTTP surface — the
  // Gremlin API and these docs — is live and served locally. Then hand off to the docs, which are the UI.
  // The docs link is relative, so it resolves at any deploy path (root or a GitHub Pages sub-path).
  addEventListener('load', async () => {
    const status = document.getElementById('status');
    if (!navigator.serviceWorker) { status.textContent = 'This browser has no service worker support, so mogwai-db cannot run here.'; return; }
    // Wait until the SW controls this page — attach-before-check so the controllerchange event can't be missed.
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const done = () => { if (navigator.serviceWorker.controller) { navigator.serviceWorker.removeEventListener('controllerchange', done); resolve(); } };
        navigator.serviceWorker.addEventListener('controllerchange', done);
        done();
      });
    }
    status.dataset.state = 'ready';
    status.textContent = 'Local database ready — opening the API reference…';
    location.replace(new URL('docs', document.baseURI).toString());
  });
</script>
</body>
</html>
`;
