// The page bootstrap — the ONE script a consuming page includes:
//
//   <script type="module" src="/path/to/mogwai.js">
//     { "httpAllowlist": ["backup.example"] }
//   </script>
//
// It registers the Service Worker (the HTTP edge) and installs this tab's WorkerFactory (which spawns a
// dedicated Worker per graph). Both sibling scripts — `service-worker.js` and `worker.js` — are resolved
// RELATIVE to this bundle (`import.meta.url`, threaded through `installMogwai`), so the three files ship
// together in one directory (a GitHub-release zip: `mogwai.js`, `service-worker.js`, `worker.js`) and find
// each other wherever they are dropped, no root-path assumption.
//
// CONFIG rides the SAME tag: a `src` script's inline text is inert (not executed) but still readable via
// the DOM, so a page can drop a JSON config INSIDE this tag and it lifts-and-shifts to a Worker's
// `env.CONFIG` or a Bun `--config` unchanged (one `MogwaiConfig` shape — src/config.ts). The config
// reaches each graph Worker at boot (its allowlisted Http seam for io()/federate over http).
//
// For programmatic control (custom URLs, an explicit SW scope, the config object, or the returned
// WorkerFactory disposer), import `installMogwai` from `worker-factory.ts` and call it yourself instead.
import { installMogwai } from './worker-factory.ts';
import { configFromBrowser, type MogwaiConfig } from '../config.ts';

/** Read this bootstrap's own inline JSON config, if any. We find our OWN `<script>` tag by matching its
 *  resolved `src` to this module's URL (falling back to the filename), so there is nothing to hardcode;
 *  its inert inner text is parsed as the config. Absent or unparseable ⇒ deny-all defaults. */
function readInlineConfig(): MogwaiConfig {
  const here = import.meta.url;
  const hereFile = new URL(here).pathname.split('/').pop();
  const own = Array.from(document.scripts).find(
    (s) => s.src && (s.src === here || new URL(s.src, document.baseURI).pathname.split('/').pop() === hereFile),
  );
  const text = own?.textContent?.trim();
  if (text) {
    try {
      return configFromBrowser(JSON.parse(text));
    } catch {
      /* inline text is not JSON — fall through to defaults */
    }
  }
  return configFromBrowser(undefined);
}

void installMogwai({ config: readInlineConfig() });
