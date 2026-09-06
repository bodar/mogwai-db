// Self-describing HTTP surface: a hand-written OpenAPI 3.1 spec for the four verbs on the graph path
// (plus the GraphQL edge and the replication control plane), and a tiny Scalar shell that renders it as
// an interactive reference. Both are served by the shared router (router.ts), so Bun, Cloudflare and the
// browser build expose the same docs. No build step, no npm dep in the Worker bundle — the Scalar UI module
// is a separate static asset each runtime SELF-HOSTS: the browser ships `./scalar.js` as a static sibling,
// and Bun/CF now serve it too via the AssetStore seam (src/assetstore.ts — Bun from a binary-embedded copy,
// CF from the Workers Static Assets binding). `SCALAR_CDN` below is only the FALLBACK default, used by a
// router wired with no AssetStore (bare test routers) — the pinned jsdelivr copy of the same version.
//
// The spec is REQUEST-DERIVED, not frozen at construction: the router builds it per request so that
//   - `servers[0].url` is the ABSOLUTE base the request actually arrived on (`buildOpenApiSpec`'s `baseUrl`
//     arg), so the paths below compose correctly under a root deploy (Bun/CF) AND a sub-path one (GitHub
//     Pages at `/mogwai-db/`), where the browser SW supplies the base it can no longer recover from the
//     already-stripped request; and
//   - `info.version` carries the real stamped version (`src/version.ts`), not a hardcoded constant.
// The graph-path prefix is likewise passed in (router.ts owns the default, `gremlin`), so the docs can
// never drift from the live route. The bare `/gremlin` endpoint is a fixed TinkerPop convention.
//
// The management verbs (PUT/OPTIONS/DELETE) and the GraphQL edge are plain JSON and fully interactive in
// the "Test Request" panel. Both gremlin data-plane verbs — POST (JSON/GraphBinary body) and the cacheable
// GET (`?gremlin=`) — RESPOND with GraphBinary (binary): the try-it panel shows the request working
// (HTTP 200) with an unreadable body. OPTIONS is the graph-metadata (element counts) verb GET used to be.

// The Scalar reference UI — the UMD `standalone.js`, the ONE self-contained file (the ES-module build
// dynamic-imports 180 sibling chunks). It defines `window.Scalar`. All three runtimes now SELF-HOST it and
// pass `./scalar.js`: the browser ships it beside the docs, Bun serves a binary-embedded copy, CF the
// Workers Static Assets binding (src/assetstore.ts + scripts/package.ts). The PINNED jsdelivr copy below is
// only the FALLBACK for a router with no AssetStore wired (bare test routers) — the SAME version we depend
// on (kept in sync with package.json's @scalar/api-reference); bump deliberately.
export const SCALAR_VERSION = '1.67.0';
const SCALAR_CDN = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`;

/** Build the OpenAPI 3.1 document. `baseUrl` is the ABSOLUTE origin (`servers[0].url`) the paths compose
 *  against — the request's own origin (Bun/CF), or the browser build's sub-path base; `version` is the
 *  stamped `src/version.ts` value. Both are passed in per request so neither is frozen at construction. */
export function buildOpenApiSpec(pathPrefix: string, baseUrl: string, version: string) {
 const graphPath = `/${pathPrefix}/{graphId}`;
 const graphqlPath = `/graphql/{graphId}`;
 return {
  openapi: '3.1.0',
  info: {
    title: 'mogwai-db',
    version,
    description:
      // The brand logo, made VISIBLE in the reference: Scalar renders `info.description` as markdown, so a
      // markdown image paints it at the top of the docs (the `x-logo` below is unrendered by Scalar 1.67).
      // Relative URL — composes under a GitHub Pages sub-path, resolving to the `/logo.png` the AssetStore
      // serves (Bun/CF) or the static sibling (browser).
      '![mogwai-db](./logo.png)\n\n' +
      'A TinkerPop 4 Gremlin server compiled onto SQLite. Each graph is addressed ' +
      `at \`${graphPath}\` and springs into existence on first access. \`POST\` (body) and ` +
      'the cacheable `GET` (`?gremlin=`) both run a Gremlin traversal; `OPTIONS` returns ' +
      'graph metadata (element counts); `PUT`/`DELETE` manage the graph lifecycle. All ' +
      'management verbs are idempotent and create-on-demand. A stock TinkerPop client ' +
      'may also POST to the bare `/gremlin` endpoint, naming the graph in the `g` field.',
    // The brand logo, carried as `x-logo` — the Redoc/Scalar convention on `info`. RELATIVE URL (like
    // `./openapi.json` and `./scalar.js`) so it composes under a GitHub Pages sub-path, resolving to the
    // `/logo.png` the AssetStore seam serves (Bun/CF) or the static sibling (browser build). NOTE: Scalar
    // 1.67 does not itself render `x-logo` (verified: no `x-logo`/`xLogo` in its standalone bundle; its only
    // branding config is `favicon`, which we set via the shell's `<link rel=icon>` instead) — so this is the
    // spec-level REFERENCE, future-proof for a Redoc/x-logo-aware consumer, not a header the docs paint today.
    'x-logo': { url: './logo.png', altText: 'mogwai-db' },
  },
  servers: [{ url: baseUrl, description: 'This server' }],
  paths: {
    [graphPath]: {
      parameters: [
        {
          name: 'graphId',
          in: 'path',
          required: true,
          description: 'Tenant/graph identifier. Any string; created on first use.',
          schema: { type: 'string' },
          example: 'demo',
        },
      ],
      post: {
        summary: 'Run a Gremlin traversal',
        description:
          'Execute a Gremlin traversal against the graph (created on demand). The ' +
          'request may be JSON (shown here) or GraphBinary. The response is content-' +
          'negotiated: GraphBinary (`application/vnd.graphbinary-v4.0`) by DEFAULT — ' +
          'the compact binary the real GLV clients get — or, when the request sends ' +
          '`Accept: application/json`, a readable UNTYPED-JSON array (this panel does ' +
          'that, so the result renders here). HTTP status is always 200; Gremlin ' +
          'errors ride the GraphBinary status trailer inside the body.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['gremlin'],
                properties: {
                  gremlin: { type: 'string', description: 'The Gremlin traversal string.' },
                  bindings: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Parameter bindings referenced by the traversal.',
                  },
                  g: {
                    type: 'string',
                    description: 'Optional traversal-source name (named graph within the tenant).',
                  },
                  batchSize: {
                    type: 'integer',
                    description: 'Optional. Results per response chunk (default 64). Paces the ' +
                      'chunked GraphBinary response; also accepted as resultIterationBatchSize.',
                  },
                },
              },
              examples: {
                count: { summary: 'Count vertices', value: { gremlin: 'g.V().count()' } },
                addVertex: {
                  summary: 'Add a vertex',
                  value: { gremlin: "g.addV('person').property('name','dan')" },
                },
                bound: {
                  summary: 'With bindings',
                  value: { gremlin: 'g.V().has(\"name\", name).values(\"age\")', bindings: { name: 'dan' } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description:
              'The result. Content-negotiated: a readable UNTYPED-JSON array when the request sent ' +
              '`Accept: application/json` (as this panel does), else the default GraphBinary stream (binary).',
            content: GREMLIN_RESULT_CONTENT,
          },
        },
      },
      put: {
        summary: 'Create the graph',
        description: 'Create the graph if it does not exist. Idempotent.',
        responses: {
          '201': {
            description: 'Created (or already existed).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, created: { type: 'boolean' } },
                },
                example: { id: 'demo', created: true },
              },
            },
          },
        },
      },
      get: {
        summary: 'Run a Gremlin read traversal (query string)',
        description:
          'Execute a read traversal built from the URL, the CACHEABLE counterpart to the ' +
          'POST body form (a GET is cacheable by any HTTP intermediary; a POST is not). The ' +
          'traversal comes from the required `gremlin` query parameter — no request body is ' +
          'read. The response is content-negotiated exactly as POST: GraphBinary ' +
          '(`application/vnd.graphbinary-v4.0`) by default, or a readable UNTYPED-JSON array ' +
          'when the request sends `Accept: application/json`. HTTP status always 200 with ' +
          'Gremlin errors on the GraphBinary status trailer. For graph metadata (element ' +
          'counts) use OPTIONS; a missing `gremlin` parameter is a 400.',
        parameters: [
          { name: 'gremlin', in: 'query', required: true, description: 'The Gremlin traversal string.', schema: { type: 'string' }, example: 'g.V().count()' },
          { name: 'bindings', in: 'query', required: false, description: 'JSON-encoded parameter bindings referenced by the traversal (a malformed value errors on the trailer).', schema: { type: 'string' } },
          { name: 'batchSize', in: 'query', required: false, description: 'Results per response chunk (default 64). Paces the chunked GraphBinary response.', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description:
              'The result. Content-negotiated: a readable UNTYPED-JSON array with `Accept: application/json`, ' +
              'else the default GraphBinary stream (binary).',
            content: GREMLIN_RESULT_CONTENT,
          },
          '400': {
            description: 'The required `gremlin` query parameter is absent.',
            content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
          },
        },
      },
      options: {
        summary: 'Graph metadata (element counts)',
        description:
          'Return element counts and the server version for the graph, creating it empty on ' +
          'demand. Existence is not separately detectable (matching Durable Objects), so this ' +
          'never 404s on a well-formed id — a fresh graph reports zero counts. This is the ' +
          'metadata verb the graph GET used to serve; GET now runs a read traversal.',
        responses: {
          '200': {
            description: 'Element counts and version. The `Allow` header lists the supported verbs.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    vertexCount: { type: 'integer' },
                    edgeCount: { type: 'integer' },
                    version: { type: 'string' },
                  },
                },
                example: { id: 'demo', vertexCount: 6, edgeCount: 6, version: '1.0.0' },
              },
            },
          },
        },
      },
      delete: {
        summary: 'Destroy the graph',
        description:
          'Delete the graph and all its storage. Idempotent — deleting an absent graph ' +
          'succeeds. Re-addressing the id afterward recreates it empty.',
        responses: { '204': { description: 'Destroyed (or already absent).' } },
      },
    },
    [graphqlPath]: {
      parameters: [
        {
          name: 'graphId',
          in: 'path',
          required: true,
          description: 'Tenant/graph identifier. Any string; created on first use.',
          schema: { type: 'string' },
          example: 'demo',
        },
      ],
      post: {
        summary: 'Run a GraphQL query (JSON body)',
        description:
          'GraphQL-over-HTTP against the graph, whose GraphQL schema is REFLECTED from the graph itself. ' +
          'The body is the standard `{query, variables, operationName, extensions}` object; only `query` ' +
          'is required. The response is a spec-shaped `{data}` / `{errors}` envelope. Two response media ' +
          'types are offered and the request `Accept` chooses: `application/graphql-response+json` (the ' +
          'modern one) returns 4xx for a parse/validation failure, while `application/json` (the legacy ' +
          'transport) returns 200 with `{errors}`; an execution failure of a valid document is always 200 ' +
          'with `{errors}`. A POST must carry `Content-Type: application/json`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string', description: 'The GraphQL document to execute.' },
                  variables: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Variable values referenced by the query. A JSON `null` means absent.',
                  },
                  operationName: {
                    type: 'string',
                    description: 'Selects the operation when the document defines more than one.',
                  },
                  extensions: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Reserved for implementer extensions (e.g. `mogwai:explain` to return the lowered Gremlin).',
                  },
                },
              },
              examples: {
                query: {
                  summary: 'Select fields off a type',
                  value: { query: '{ person { name age } }' },
                },
                introspection: {
                  summary: 'Introspect the reflected schema',
                  value: { query: '{ __schema { queryType { name } } }' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'A `{data}` (and/or `{errors}`) GraphQL envelope.', content: GRAPHQL_RESPONSE_CONTENT },
          '400': { description: 'Malformed transport (missing `Content-Type`, non-JSON body, or bad params).', content: GRAPHQL_RESPONSE_CONTENT },
        },
      },
      get: {
        summary: 'Run a GraphQL query (query string)',
        description:
          'The GET form of GraphQL-over-HTTP: `query` is a query-string parameter, and `variables` / ' +
          '`extensions` are JSON-ENCODED strings (a malformed one is a 400). Response semantics match the ' +
          'POST form (`Accept` selects the media type and its error-status behaviour).',
        parameters: [
          { name: 'query', in: 'query', required: true, description: 'The GraphQL document.', schema: { type: 'string' }, example: '{ person { name } }' },
          { name: 'variables', in: 'query', required: false, description: 'JSON-encoded variable map.', schema: { type: 'string' } },
          { name: 'operationName', in: 'query', required: false, description: 'Operation to select when the document has several.', schema: { type: 'string' } },
          { name: 'extensions', in: 'query', required: false, description: 'JSON-encoded implementer extensions.', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'A `{data}` (and/or `{errors}`) GraphQL envelope.', content: GRAPHQL_RESPONSE_CONTENT },
          '400': { description: 'Malformed transport (missing/JSON-invalid params).', content: GRAPHQL_RESPONSE_CONTENT },
        },
      },
    },
    '/_replicator': {
      get: {
        summary: 'List replication jobs',
        description:
          'List all persistent replication jobs (§9). Ongoing replication is a standalone job — a ' +
          '`{source, target, continuous, …}` document run by the worker-residency scheduler — kept in the ' +
          'top-level `_replicator` control plane. NOT per-graph.',
        responses: {
          '200': {
            description: 'The stored replication jobs.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { configs: { type: 'array', items: REPLICATION_CONFIG_SCHEMA } } },
              },
            },
          },
          '501': { description: 'This runtime has no replication registry configured.' },
        },
      },
      post: {
        summary: 'Create a replication job',
        description: 'Create a replication job (an `id` is generated if omitted). Idempotent per id.',
        requestBody: { required: true, content: { 'application/json': {
          schema: REPLICATION_CONFIG_INPUT_SCHEMA,
          examples: {
            pull: { summary: 'Continuously pull a remote graph', value: { source: 'https://peer.example/gremlin/prod', target: 'local', continuous: true } },
            push: { summary: 'One-shot push to a remote', value: { source: 'local', target: 'https://peer.example/gremlin/backup' } },
          },
        } } },
        responses: { '201': {
          description: 'Created.',
          content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, ok: { type: 'boolean' } } }, example: { id: 'job-1', ok: true } } },
        } },
      },
    },
    '/_replicator/{configId}': {
      parameters: [{ name: 'configId', in: 'path', required: true, description: 'Replication job id.', schema: { type: 'string' }, example: 'job-1' }],
      get: {
        summary: 'Get a replication job',
        responses: {
          '200': { description: 'The job.', content: { 'application/json': { schema: REPLICATION_CONFIG_SCHEMA } } },
          '404': { description: 'No such job.' },
        },
      },
      put: {
        summary: 'Create or replace a replication job',
        description: 'Upsert the job at `configId`. Idempotent.',
        requestBody: { required: true, content: { 'application/json': { schema: REPLICATION_CONFIG_INPUT_SCHEMA } } },
        responses: { '201': { description: 'Created or replaced.', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, ok: { type: 'boolean' } } } } } } },
      },
      delete: {
        summary: 'Delete a replication job',
        description: 'Delete the job. Idempotent — deleting an absent job succeeds.',
        responses: { '204': { description: 'Deleted (or already absent).' } },
      },
    },
    '/_scheduler/jobs': {
      get: {
        summary: 'Replication scheduler jobs',
        description: 'Per-config scheduler state: state, error count, last run info.',
        responses: { '200': { description: 'Scheduler jobs.', content: { 'application/json': { schema: { type: 'object', properties: { jobs: { type: 'array', items: { type: 'object' } } } } } } } },
      },
    },
    '/_scheduler/docs': {
      get: {
        summary: 'Replication jobs with scheduler state',
        description: 'Each replication job merged with its scheduler state.',
        responses: { '200': { description: 'Jobs + state.', content: { 'application/json': { schema: { type: 'object', properties: { docs: { type: 'array', items: { type: 'object' } } } } } } } },
      },
    },
    '/_scheduler/run': {
      post: {
        summary: 'Run due replications now',
        description:
          'Fire ONE scheduler tick immediately (at worker residency): claim due jobs and run them. The ' +
          'admin "run now" trigger — the Cron Trigger (CF) or the background interval (Bun/browser) does ' +
          'this on a schedule. Returns how many jobs ran plus per-job outcomes.',
        responses: {
          '200': { description: 'Tick result.', content: { 'application/json': { schema: { type: 'object', properties: { ran: { type: 'integer' }, outcomes: { type: 'array', items: { type: 'object' } } } } } } },
          '501': { description: 'This runtime has no scheduler configured.' },
        },
      },
    },
  },
 } as const;
}

// The gremlin data-plane result, offered at BOTH negotiated media types. `application/json` is listed
// FIRST so the Scalar "Test Request" panel selects it (and sends `Accept: application/json`), making the
// browser response readable out of the box; a real GLV client sends the GraphBinary Accept and gets the
// binary. The JSON body is an ARRAY of the (bulk-expanded) result values in untyped GraphSON element
// form (`src/untyped.ts`) — heterogeneous, so `items` is unconstrained.
const GREMLIN_RESULT_CONTENT = {
  'application/json': {
    schema: { type: 'array', items: {}, description: 'Result values as an untyped-JSON array (opt-in via `Accept: application/json`).' },
  },
  'application/vnd.graphbinary-v4.0': { schema: { type: 'string', format: 'binary' } },
} as const;

// The GraphQL `{data, errors}` envelope, offered at BOTH media types the GraphQL-over-HTTP spec defines
// (`application/graphql-response+json` — modern, 4xx on failure — and `application/json` — legacy, 200 on
// failure). Same body schema; the request `Accept` picks the media type and its error-status semantics.
const GRAPHQL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    data: { type: 'object', additionalProperties: true, nullable: true, description: 'The query result, keyed by root field.' },
    errors: {
      type: 'array',
      description: 'Present when the request errored; each carries a `message` and (for a document error) `locations`.',
      items: { type: 'object', properties: { message: { type: 'string' }, locations: { type: 'array', items: { type: 'object' } } } },
    },
    extensions: { type: 'object', additionalProperties: true, description: 'Implementer extensions (e.g. the lowered Gremlin under `mogwai:explain`).' },
  },
} as const;
const GRAPHQL_RESPONSE_CONTENT = {
  'application/json': { schema: GRAPHQL_RESPONSE_SCHEMA },
  'application/graphql-response+json': { schema: GRAPHQL_RESPONSE_SCHEMA },
} as const;

// A stored replication job (§9·2). `source`/`target` are graph refs — a local graph id or a remote
// `http(s)` graph URL. The INPUT form omits `id` (generated on POST, path-supplied on PUT).
const REPLICATION_CONFIG_INPUT_SCHEMA = {
  type: 'object',
  required: ['source', 'target'],
  properties: {
    source: { type: 'string', description: 'Source graph ref (local id or http(s) URL).' },
    target: { type: 'string', description: 'Target graph ref (local id or http(s) URL).' },
    continuous: { type: 'boolean', description: 'Keep syncing on a schedule (else run once).' },
    create_target: { type: 'boolean', description: 'Create the target if absent.' },
    filter: { type: 'string', description: 'Captured selector for filtered replication.' },
    checkpoint_interval: { type: 'integer', description: 'Continuous poll interval (ms).' },
    use_checkpoints: { type: 'boolean', description: 'Persist a resume checkpoint (default true).' },
  },
} as const;

const REPLICATION_CONFIG_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, ...REPLICATION_CONFIG_INPUT_SCHEMA.properties },
} as const;

// Minimal Scalar shell. Same-origin, so no proxyUrl (requests hit this server directly, never scalar.com's
// proxy). Prefix-independent — it points at `./openapi.json` RELATIVE to this page, so it resolves whether
// it is served at the origin root (Bun/CF) or under a sub-path (`/mogwai-db/` on a GitHub Pages project
// site) — the browser build's service worker serves `/openapi.json` at the same base. `scalarUrl` is the
// UMD standalone (defines `window.Scalar`): the CDN by default, or `./scalar.js` for the self-contained
// browser build. `bootScript`, when set, is loaded FIRST — the browser build passes `./mogwai-db.js` so
// THIS page also hosts the per-tab WorkerFactory (the graph data plane): the browser build serves this
// SAME shell as BOTH its site root (index.html) and `/docs`, so it is the tab the user is on and must host
// the Worker, or graph requests would have no Worker to route to. Bun/CF have real workers, pass no
// bootScript, and serve the shell at `/` + `/docs` alike.
function docsHtml(scalarUrl: string, bootScript?: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>mogwai-db API</title>
    <!-- RELATIVE href so it resolves under a GitHub Pages sub-path (\`/mogwai-db/favicon.ico\`), not only the
         origin root. Served from the AssetStore seam (src/assetstore.ts) on Bun/CF, the static sibling in the
         browser build — same as \`./scalar.js\` below. -->
    <link rel="icon" href="./favicon.ico" />${bootScript ? `\n    <script type="module" src="${bootScript}"></script>` : ''}
  </head>
  <body>
    <div id="app"></div>
    <script src="${scalarUrl}"></script>
    <script>
      // Mount Scalar. In the BROWSER build a Service Worker (booted by the head script above) is the local
      // HTTP edge that serves ./openapi.json and the interactive "Test Request" fetches, so on a fresh visit
      // — which lands BEFORE the SW controls the page — mount only once it takes control, or the first spec
      // fetch races ahead of control and 404s from the static host. The SW claims clients on activate
      // (skipWaiting + clients.claim), so this resolves with NO reload and no navigation. On a server (Bun/CF)
      // there is no SW for this origin, so the flag is false and we mount immediately.
      ;(async () => {
        const sw = navigator.serviceWorker;
        if (${bootScript ? 'true' : 'false'} && sw && !sw.controller) {
          await new Promise((res) => {
            const ready = () => { if (sw.controller) { sw.removeEventListener('controllerchange', ready); res(); } };
            sw.addEventListener('controllerchange', ready);
            ready(); // already controlled between the check and the attach
          });
        }
        Scalar.createApiReference('#app', { url: './openapi.json' });
      })();
    </script>
  </body>
</html>
`;
}

/** Build the static Scalar shell served at both `/` and `/docs`. Prefix- AND base-independent (it fetches `./openapi.json`
 *  relative to the page), so it is built ONCE at router construction, unlike the spec — which is
 *  request-derived (`buildOpenApiSpec`, served at `/openapi.json`). `scalarUrl` selects where the Scalar UI
 *  module loads from (the pinned CDN by default; the browser build passes `./scalar.js`); `bootScript`
 *  optionally boots the browser factory on the docs page (the browser build passes `./mogwai-db.js`). */
export function buildDocs(scalarUrl: string = SCALAR_CDN, bootScript?: string) {
  return { DOCS_HTML: docsHtml(scalarUrl, bootScript) };
}
