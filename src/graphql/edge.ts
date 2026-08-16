// ---------- the GraphQL HTTP edge — POST/GET /graphql/{g} ----------
//
// The Worker-side handler that turns a GraphQL-over-HTTP request into a Gremlin run and a
// spec-shaped JSON response (`docs/2026-08-07-graphql-front-end-plan.md` §5). It runs in the Worker,
// not the DO (§5·1, locked): translation needs no store, and the one store touch — reflecting the
// schema — crosses the ordinary executor seam exactly as a Gremlin query does. The flow is §5·4's:
//
//   reflect schema (run mogwai.schema) → translate document → run the Gremlin → shape as {data}.
//
// Two DO round trips for now (schema, then the query) — the honest, correct, no-invalidation first
// cut §5·4 prescribes; a compare-and-swap against a write counter is the later optimisation, not a
// correctness fix.
import { ioc, StreamReader } from '../io.ts';
import { buildSchema, translate, GraphQLTranslationError, type Translation } from './translate.ts';
import type { SchemaRow } from './schema.ts';

/** The async executor surface this edge needs — exactly the `framedAsync` the router already hands a
 *  Gremlin query (`src/api.ts` `RemoteExecutor`), narrowed to the one method so the edge cannot reach
 *  for a store. `Framed` is `{buf, bulk}`; the edge only reads `buf` (a GraphQL result is a set, and a
 *  reflected schema / a projected row each arrive at bulk 1). */
export interface GraphQLExecutor {
  framedAsync(gremlin: string, params: Record<string, unknown>): Promise<readonly { readonly buf: Buffer }[]>;
}

/** The four GraphQL-over-HTTP request parameters (the spec names exactly these; all other top-level
 *  names are reserved — §5·3). This cut reads `query` + the scoped explain flag and REFUSES a request
 *  that carries `variables` or `operationName` (fail closed — see `execute`, which will not
 *  accept-and-ignore them); `extensions` is read only for the explain key. */
interface GraphQLRequest {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
  readonly extensions?: Record<string, unknown>;
}

/** The scoped explain key (§5·3) — an implementer-namespaced `extensions` entry, the spec's RECOMMENDED
 *  extension mechanism, so a top-level `?explain` (non-conformant) is never introduced. */
const EXPLAIN_KEY = 'mogwai:explain';

/** Decode a GraphBinary buffer to its JS value through the client's own reader (the inbound decode
 *  `wire.ts` uses, run in reverse). Async only in signature over a complete buffer. */
const decode = (buf: Buffer): Promise<unknown> => ioc.anySerializer.deserialize(StreamReader.fromBuffer(buf));

/**
 * A decoded GraphBinary value → plain JSON for the `{data}` envelope. The translated query only ever
 * produces `project().by()` MAPS of scalars and nested lists-of-maps (every leaf is `values(k)`), so
 * the shapes here are exactly Map / Array / scalar — a Map becomes an object, an array recurses, a
 * scalar passes through. A `bigint` (a `count()` Long) narrows to a JS number for JSON (GraphQL `Int`
 * is 32-bit and JSON has no bigint); a value that genuinely overflows is out of this cut's scope.
 */
function toJson(v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, val]) => [String(k), toJson(val)]));
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === 'bigint') return Number(v);
  return v;
}

/** The graph's reflected schema, fetched by running `mogwai.schema` across the executor and decoding
 *  each map row (the row shape IS `SchemaRow`). This is the first of §5·4's two round trips. */
async function reflect(executor: GraphQLExecutor): Promise<ReturnType<typeof buildSchema>> {
  const framed = await executor.framedAsync("g.call('mogwai.schema')", {});
  const rows: SchemaRow[] = [];
  for (const f of framed) rows.push(toJson(await decode(f.buf)) as SchemaRow);
  return buildSchema(rows);
}

/** A spec-shaped GraphQL error list body. GraphQL-over-HTTP returns errors under `errors` with a
 *  `message`; a request-level failure (a bad document, a translation refusal) carries no `data`. */
const errors = (...messages: string[]) => ({ errors: messages.map((message) => ({ message })) });

/** A JSON `Response` at the GraphQL-over-HTTP media type. Always HTTP 200 for an executed document
 *  (GraphQL puts field/execution errors in the body, like the Gremlin edge puts them on the trailer);
 *  a MALFORMED request (not JSON, no `query`) is a 400, which the audit suite checks. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

/**
 * Execute one already-parsed GraphQL request — the shared core POST and GET both reach. The document is
 * translated against the freshly-reflected schema, run, and the result rows shaped under the root field's
 * response key as `{data: {<root>: […]}}`.
 *
 * The root response key is the query's own root field name/alias — GraphQL keys `data` by the selection,
 * and `translate` rooted the traversal at exactly that field. The result is always a LIST here (a graph
 * root is a set of vertices); single-object roots are a later schema refinement.
 *
 * Errors map to their layer: a missing `query` is a 400 (a transport error the audit suite asserts); a
 * translation refusal or an execution failure is a 200 with `{errors}` and no `data` (GraphQL's own
 * contract — the request was well-formed, the operation failed).
 */
async function execute(executor: GraphQLExecutor, req: GraphQLRequest): Promise<Response> {
  if (typeof req.query !== 'string')
    return jsonResponse(errors('a GraphQL request must carry a string `query`'), 400);
  // REFUSE what this cut cannot honour rather than accept-and-ignore it — a request carrying `variables`
  // or naming an `operationName` would otherwise be silently mistranslated (the translator drops both),
  // which is a wrong answer, not a partial one. `variables !== undefined` covers an empty `{}` too: a
  // client that sends the field expects it to matter.
  if (req.variables !== undefined)
    return jsonResponse(errors('query variables are not supported yet'));
  if (req.operationName != null)
    return jsonResponse(errors('operationName is not supported yet (send a single-operation document)'));

  const explain = req.extensions?.[EXPLAIN_KEY] === true;
  let translation: Translation;
  let rootKey: string;
  try {
    const schema = await reflect(executor);
    translation = translate(req.query, schema);
    // The response key is the root field's alias-or-name — `translate` rooted the query there. Parsing
    // it out of the query once more would be a second recognizer; instead the translator hands it back.
    rootKey = translation.rootKey;
  } catch (e) {
    // A translation refusal is a GraphQL request-level error: well-formed transport, unanswerable
    // operation. 200 with `{errors}` and no data is GraphQL's own contract for that.
    const message = e instanceof GraphQLTranslationError ? e.message : `translation failed: ${(e as Error).message}`;
    return jsonResponse(errors(message));
  }

  const ext = explain ? { extensions: { [EXPLAIN_KEY]: { gremlin: translation.gremlin } } } : {};
  try {
    const framed = await executor.framedAsync(translation.gremlin, translation.params);
    const rows: unknown[] = [];
    for (const f of framed) rows.push(toJson(await decode(f.buf)));
    return jsonResponse({ data: { [rootKey]: rows }, ...ext });
  } catch (e) {
    return jsonResponse({ ...errors(`execution failed: ${(e as Error).message}`), ...ext });
  }
}

/**
 * `POST /graphql/{g}` — the request is the JSON body (`{query, variables, operationName, extensions}`).
 * A body that is not valid JSON is a 400, the transport error the audit suite asserts.
 */
export async function handlePost(executor: GraphQLExecutor, body: string): Promise<Response> {
  let req: GraphQLRequest;
  try { req = JSON.parse(body) as GraphQLRequest; }
  catch { return jsonResponse(errors('POST body must be valid JSON'), 400); }
  return execute(executor, req);
}

/**
 * `GET /graphql/{g}?query=…` — GraphQL-over-HTTP's GET form, which is what the verb is FOR (and what
 * `graphql-http`'s audit grades), not a browser page. `variables`/`extensions` are JSON-encoded
 * query-string params per the spec; a malformed one is a 400. There is deliberately NO server-rendered
 * HTML here: the endpoint is the product, and reflecting the untrusted path/query into a page is a
 * surface with no payoff (it was, briefly, and it was reflected XSS — deleted rather than escaped).
 */
export function handleGet(executor: GraphQLExecutor, url: URL): Promise<Response> {
  const p = url.searchParams;
  const jsonParam = (name: string): unknown => {
    const raw = p.get(name);
    if (raw == null) return undefined;
    try { return JSON.parse(raw); } catch { throw new GraphQLTranslationError(`\`${name}\` must be JSON-encoded`); }
  };
  let req: GraphQLRequest;
  try {
    req = { query: p.get('query') ?? undefined, operationName: p.get('operationName') ?? undefined,
      variables: jsonParam('variables'), extensions: jsonParam('extensions') as Record<string, unknown> | undefined };
  } catch (e) {
    return Promise.resolve(jsonResponse(errors((e as Error).message), 400));
  }
  return execute(executor, req);
}
