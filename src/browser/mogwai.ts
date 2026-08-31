// The page bootstrap — the ONE script a consuming page includes:
//
//   <script type="module" src="/path/to/mogwai.js"></script>
//
// It registers the Service Worker (the HTTP edge) and installs this tab's WorkerFactory (which spawns a
// dedicated Worker per graph). Both sibling scripts — `service-worker.js` and `worker.js` — are resolved
// RELATIVE to this bundle (`import.meta.url`, threaded through `installMogwai`), so the three files ship
// together in one directory (a GitHub-release zip: `mogwai.js`, `service-worker.js`, `worker.js`) and find
// each other wherever they are dropped, no root-path assumption.
//
// For programmatic control (custom URLs, an explicit SW scope, or the returned WorkerFactory disposer),
// import `installMogwai` from `worker-factory.ts` and call it yourself instead of loading this entry.
import { installMogwai } from './worker-factory.ts';

void installMogwai();
