// Self-describing HTTP surface: a hand-written OpenAPI 3.1 spec for the four
// verbs on the graph path, plus a tiny Scalar shell that renders it as an interactive
// reference. Both are served by the shared router (router.ts), so Bun and
// Cloudflare expose the same docs. No build step, no npm dep — Scalar loads from
// a CDN in the browser (pinned), so the Worker bundle is untouched.
//
// The graph-path prefix is configurable (router.ts owns the default, `gremlin`), so the
// docs are BUILT from the prefix the router is running — `buildDocs(prefix)` — and
// can never drift from the live route. The bare `/gremlin` endpoint is a fixed
// TinkerPop convention, independent of the prefix.
//
// The management verbs (PUT/GET/DELETE) are plain JSON and fully interactive in
// the "Test Request" panel. The gremlin POST accepts a JSON request body today,
// but its RESPONSE is GraphBinary (binary) — a readable JSON/GraphSON response is
// a planned improvement (see docs/2026-07-13-graphson-untyped-scope.md), so the
// try-it panel will show the request working (HTTP 200) with an unreadable body.

const VERSION = '0.1.0';

// Pinned so the rendered docs are reproducible; bump deliberately.
const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.62.5';

export function buildOpenApiSpec(pathPrefix: string) {
 const graphPath = `/${pathPrefix}/{graphId}`;
 return {
  openapi: '3.1.0',
  info: {
    title: 'mogwai-db',
    version: VERSION,
    description:
      'A TinkerPop 4 Gremlin server compiled onto SQLite. Each graph is addressed ' +
      `at \`${graphPath}\` and springs into existence on first access. \`POST\` runs a ` +
      'Gremlin traversal; `PUT`/`GET`/`DELETE` manage the graph lifecycle. All ' +
      'management verbs are idempotent and create-on-demand. A stock TinkerPop client ' +
      'may also POST to the bare `/gremlin` endpoint, naming the graph in the `g` field.',
  },
  servers: [{ url: '/', description: 'This server' }],
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
          'request may be JSON (shown here) or GraphBinary. The RESPONSE is always ' +
          'GraphBinary (`application/vnd.graphbinary-v4.0`) — a binary body the ' +
          '"Test Request" panel cannot render; a JSON/GraphSON response is a planned ' +
          'improvement. HTTP status is always 200; Gremlin errors ride the ' +
          'GraphBinary status trailer inside the body.',
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
            description: 'GraphBinary-framed result stream (binary).',
            content: { 'application/vnd.graphbinary-v4.0': { schema: { type: 'string', format: 'binary' } } },
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
        summary: 'Graph info (element counts)',
        description:
          'Return element counts for the graph, creating it empty on demand. Existence ' +
          'is not separately detectable (matching Durable Objects), so this never 404s ' +
          'on a well-formed id — a fresh graph reports zero counts.',
        responses: {
          '200': {
            description: 'Element counts.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    vertexCount: { type: 'integer' },
                    edgeCount: { type: 'integer' },
                  },
                },
                example: { id: 'demo', vertexCount: 6, edgeCount: 6 },
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
  },
 } as const;
}

// Minimal Scalar shell. Same-origin, so no proxyUrl (requests hit this server
// directly, never scalar.com's proxy). Prefix-independent — it just points at
// /openapi.json, which the router serves for the running prefix.
const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>mogwai-db API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${SCALAR_CDN}"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/openapi.json' })
    </script>
  </body>
</html>
`;

/** Build the self-describing surface for a given graph-path prefix. Returns the
 *  JSON the router serves at `/openapi.json` and the Scalar shell for `/docs`. */
export function buildDocs(pathPrefix: string) {
  return {
    OPENAPI_JSON: JSON.stringify(buildOpenApiSpec(pathPrefix)),
    DOCS_HTML,
  };
}
