// ---------- the GraphQL HTTP edge — POST/GET /graphql/{g} ----------
//
// The Worker-side handler that turns a GraphQL-over-HTTP request into a spec-shaped JSON response
// (`docs/2026-08-07-graphql-front-end-plan.md` §5). It runs in the Worker, not the DO (§5·1, locked):
// translation needs no store, and the one store touch — reflecting the schema — crosses the ordinary
// executor seam exactly as a Gremlin query does. The flow is §5·4's:
//
//   reflect schema (run mogwai.schema) → build the graphql-js schema → parse+validate the document
//     → introspection? answer via graphql-js : translate to Gremlin, run, shape as {data}.
//
// graphql-js OWNS parse, validation and introspection (§7·4 — it is the authoritative artefact, the role
// `Gremlin.g4` plays for Gremlin); we own only TRANSLATION of a data query to Gremlin. So a syntax error,
// an unknown field, a wrong argument type, an unknown operationName — all come back as spec-shaped GraphQL
// errors with the status code the GraphQL-over-HTTP audit (§7·1) requires, and `__schema`/`__type`/root
// `__typename` are answered without touching the store. This is what makes the audit's MUSTs pass and
// introspection (§7·3) work; the previous hand-rolled edge did neither.
//
// CONTENT NEGOTIATION is the other half of the audit. GraphQL-over-HTTP defines two response media types
// with DIFFERENT error semantics: `application/graphql-response+json` (the modern one) uses 4xx for a
// parse/validation failure; `application/json` (the legacy transport) uses 200 with `{errors}`. The
// client's `Accept` chooses; we honour it (`negotiate`), because the audit grades both.
import { ioc, StreamReader } from '../io.ts';
import {
  parse, validate, specifiedRules, execute as gqlExecute, getOperationAST, Kind,
  type DocumentNode, type OperationDefinitionNode, type GraphQLError, type GraphQLSchema,
} from 'graphql';
import { buildSchema, translate, GraphQLTranslationError, type Translation, type ResponseShape } from './translate.ts';
import { buildGraphQLSchema } from './sdl.ts';
import type { SchemaRow } from './schema.ts';

/** The async executor surface this edge needs — exactly the `framedAsync` the router already hands a
 *  Gremlin query (`src/api.ts` `RemoteExecutor`), narrowed to the one method so the edge cannot reach
 *  for a store. `Framed` is `{buf, bulk}`; the edge only reads `buf` (a GraphQL result is a set, and a
 *  reflected schema / a projected row each arrive at bulk 1). */
export interface GraphQLExecutor {
  framedAsync(gremlin: string, params: Record<string, unknown>): Promise<readonly { readonly buf: Buffer }[]>;
}

/** The GraphQL-over-HTTP request parameters (the spec names exactly these four; all other top-level names
 *  are reserved — §5·3). Now that graphql-js parses/validates, `operationName` and a `variables` map are
 *  first-class (the audit MUSTs them); `extensions` carries the scoped explain flag. A JSON `null` for any
 *  of the three optional params is treated as ABSENT (the audit's "MUST allow null {…}" — a null is not a
 *  malformed value, it is the caller declining to supply one). */
interface GraphQLRequest {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
  readonly extensions?: unknown;
}

/** The scoped explain key (§5·3) — an implementer-namespaced `extensions` entry, the spec's RECOMMENDED
 *  extension mechanism, so a top-level `?explain` (non-conformant) is never introduced. */
const EXPLAIN_KEY = 'mogwai:explain';

const JSON_MT = 'application/json';
const GRAPHQL_RESPONSE_MT = 'application/graphql-response+json';

/** Which response media type to use, from the request's `Accept` (GraphQL-over-HTTP §content negotiation).
 *  `application/graphql-response+json` is preferred when the client accepts it (and its 4xx-on-failure
 *  semantics with it); `application/json`, `*​/*`, or a missing/other Accept falls back to `application/json`
 *  (legacy transport, 200-on-failure). Parsed loosely — the audit sends bare media types and comma lists,
 *  never q-values that reorder these two — so a substring test is exactly right and simpler than a full
 *  Accept parse. */
function negotiate(accept: string | null): { mediaType: string; useResponseJson: boolean } {
  if (accept && accept.includes(GRAPHQL_RESPONSE_MT)) return { mediaType: GRAPHQL_RESPONSE_MT, useResponseJson: true };
  return { mediaType: JSON_MT, useResponseJson: false };
}

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

/**
 * COMPLETE a translated row against the keys the document asked for — GraphQL's `CompleteValue`, and the
 * one place the two contracts are reconciled.
 *
 * A Gremlin `project()` OMITS a key whose `by()` produced nothing (`ProjectStep.map`'s `ifProductive`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:66`),
 * so a selected property that this vertex does not carry is simply not in the row. GraphQL requires the
 * opposite: **every selected field has an entry**, and a nullable field that resolved to nothing is
 * `null`. Measured before this: `{ reptile { name venomous } }` over the zoo graph returned
 * `{"name":"atlas"}` for the reptile with no `venomous` property, where the reference returns
 * `{"name":"atlas","venomous":null}`. A missing key is a different JSON document from a null one, and a
 * typed client reading `data.reptile[0].venomous` cannot tell "absent" from "null" — so this is a
 * conformance defect, not a cosmetic one.
 *
 * Rebuilding in `shape.keys` order rather than patching the gaps also gives the spec's OTHER requirement
 * on this object for free: response keys appear in the order the selection asked for them.
 *
 * A LIST maps element-wise (a to-many edge field), and an object recurses through `shape.children`. A key
 * the shape does not know is passed through untouched rather than dropped — the shape is the authority on
 * what must be PRESENT, never a filter, so an extra key would be a translator bug to surface rather than
 * hide.
 */
function complete(value: unknown, shape: ResponseShape): unknown {
  if (Array.isArray(value)) return value.map((v) => complete(v, shape));
  if (value === null || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of shape.keys) {
    const child = shape.children.get(key);
    const present = Object.prototype.hasOwnProperty.call(row, key);
    out[key] = present ? (child ? complete(row[key], child) : row[key]) : null;
  }
  // Anything the shape did not name, kept as-is (see above).
  for (const [key, v] of Object.entries(row)) if (!(key in out)) out[key] = v;
  return out;
}

/** The graph's reflected schema rows, fetched by running `mogwai.schema` across the executor and decoding
 *  each map row (the row shape IS `SchemaRow`). This is the first of §5·4's two round trips; both the
 *  native `GraphSchema` (for translation) and the graphql-js schema (for parse/validate/introspection) are
 *  built from these same rows. */
async function reflectRows(executor: GraphQLExecutor): Promise<SchemaRow[]> {
  const framed = await executor.framedAsync("g.call('mogwai.schema')", {});
  const rows: SchemaRow[] = [];
  for (const f of framed) rows.push(toJson(await decode(f.buf)) as SchemaRow);
  return rows;
}

/** A spec-shaped GraphQL error body from graphql-js errors (or plain messages). The `errors` list carries
 *  each error's `message`, and — for a graphql-js error that has them — `locations`; a translation refusal
 *  is a bare message. */
const errorBody = (errs: readonly (GraphQLError | { message: string })[]) => ({
  errors: errs.map((e) => ('locations' in e && e.locations ? { message: e.message, locations: e.locations } : { message: e.message })),
});

/** A JSON `Response` at the negotiated media type, always UTF-8 (the audit's "MUST use utf-8 encoding when
 *  responding"). Status defaults to 200; the caller passes 400 for a malformed transport, or the negotiated
 *  4xx for a `graphql-response+json` parse/validation failure. */
const respond = (body: unknown, mediaType: string, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': `${mediaType}; charset=utf-8` } });

/** A field selection is INTROSPECTION-ONLY when every root field is a meta-field (`__schema`/`__type`/
 *  `__typename`). Such an operation is answered by graphql-js directly — it needs no store, no translation,
 *  and the reflected schema IS the answer (§7·3). A MIXED operation (introspection + data) is refused: our
 *  translator has no meta-fields at the root, and executing the two halves in two engines and merging is
 *  out of this cut's scope. The audit's canonical `{ __typename }` probe is introspection-only, so it is
 *  served here, which is what turns "MUST allow string {query}" green. */
function isIntrospectionOnly(op: OperationDefinitionNode): boolean {
  const roots = op.selectionSet.selections;
  return roots.length > 0 && roots.every((s) => s.kind === Kind.FIELD && s.name.value.startsWith('__'));
}

/**
 * Execute one already-parsed GraphQL request — the shared core POST and GET both reach.
 *
 * The pipeline is graphql-js-owned up to the point of data execution: parse (syntax), reflect + build the
 * schema, validate (fields/args/types), select the operation (respecting `operationName`). An introspection
 * operation is then answered by graphql-js; a data operation is translated to Gremlin, run, and shaped.
 *
 * Error → status mapping follows the negotiated media type (`useResponseJson`): under
 * `application/graphql-response+json`, a document parse/validation failure is 4xx; under `application/json`,
 * it is 200 with `{errors}` (legacy transport). A missing `query` is always a 400 (a transport error, not a
 * GraphQL execution error). An execution/translation failure of a well-formed, valid document is a 200 with
 * `{errors}` under both media types — the request was answerable-looking, the operation failed.
 */
async function execute(executor: GraphQLExecutor, req: GraphQLRequest, accept: string | null): Promise<Response> {
  const { mediaType, useResponseJson } = negotiate(accept);
  const failStatus = useResponseJson ? 400 : 200;

  if (typeof req.query !== 'string')
    return respond(errorBody([{ message: 'a GraphQL request must carry a string `query`' }]), mediaType, 400);
  // A JSON null is ABSENT (audit: "MUST allow null {variables/operationName/extensions}"). A supplied
  // `variables`/`extensions` must be a JSON object; `operationName` a string. A wrong type is a bad
  // request (400) — malformed transport, not a GraphQL error.
  const variables = req.variables == null ? {} : req.variables;
  if (typeof variables !== 'object' || Array.isArray(variables))
    return respond(errorBody([{ message: '`variables` must be an object' }]), mediaType, 400);
  if (req.operationName != null && typeof req.operationName !== 'string')
    return respond(errorBody([{ message: '`operationName` must be a string' }]), mediaType, 400);
  const operationName = (req.operationName as string | undefined) ?? undefined;
  const extensions = req.extensions == null ? {} : req.extensions;
  if (typeof extensions !== 'object' || Array.isArray(extensions))
    return respond(errorBody([{ message: '`extensions` must be an object' }]), mediaType, 400);
  const explain = (extensions as Record<string, unknown>)[EXPLAIN_KEY] === true;

  // 1. Parse (syntax). A syntax error is a document PARSE failure — 4xx under graphql-response+json, 200
  //    otherwise. graphql-js owns the grammar and the error shape.
  let doc: DocumentNode;
  try { doc = parse(req.query); }
  catch (e) { return respond(errorBody([e as GraphQLError]), mediaType, failStatus); }

  // 2. Reflect + build both schemas from the same rows (§5·4 round trip 1).
  const rows = await reflectRows(executor);
  const gqlSchema: GraphQLSchema = buildGraphQLSchema(buildSchema(rows));

  // 3. Validate against the reflected schema. A validation error is a document VALIDATION failure — same
  //    status rule as a parse failure. graphql-js runs the spec's ~20 rules, which we do not reimplement.
  const validationErrors = validate(gqlSchema, doc, specifiedRules);
  if (validationErrors.length) return respond(errorBody(validationErrors), mediaType, failStatus);

  // 4. Select the operation. graphql-js resolves `operationName` (and errors if it is required and absent,
  //    or names a missing operation) — the audit's "MUST allow {operationName}".
  const op = getOperationAST(doc, operationName);
  if (!op) {
    const msg = operationName ? `no operation named '${operationName}'` : 'the document must contain a single operation, or name one via operationName';
    return respond(errorBody([{ message: msg }]), mediaType, failStatus);
  }
  if (op.operation !== 'query')
    return respond(errorBody([{ message: `only 'query' operations are supported yet, not '${op.operation}'` }]), mediaType);

  // 5a. Introspection is answered by graphql-js — no store, the reflected schema is the answer (§7·3).
  if (isIntrospectionOnly(op)) {
    const result = await gqlExecute({ schema: gqlSchema, document: doc, variableValues: variables as Record<string, unknown>, operationName });
    return respond(result, mediaType);
  }

  // 5b. A data operation → translate to Gremlin, run, shape under the root field's key.
  let translation: Translation;
  let rootKey: string;
  try {
    translation = translate(req.query, buildSchema(rows), variables as Record<string, unknown>);
    rootKey = translation.rootKey;
  } catch (e) {
    // A translation refusal is a request-level GraphQL error: well-formed, valid-looking transport, an
    // operation this cut cannot lower. GraphQL's contract puts that under `{errors}` with a 200.
    const message = e instanceof GraphQLTranslationError ? e.message : `translation failed: ${(e as Error).message}`;
    return respond(errorBody([{ message }]), mediaType);
  }

  const ext = explain ? { extensions: { [EXPLAIN_KEY]: { gremlin: translation.gremlin } } } : {};
  try {
    const framed = await executor.framedAsync(translation.gremlin, translation.params);
    const data: unknown[] = [];
    // COMPLETE each row against the document's response keys — a `project()` omits an unproductive key,
    // GraphQL requires it present as `null` (`complete`).
    for (const f of framed) data.push(complete(toJson(await decode(f.buf)), translation.shape));
    return respond({ data: { [rootKey]: data }, ...ext }, mediaType);
  } catch (e) {
    return respond({ ...errorBody([{ message: `execution failed: ${(e as Error).message}` }]), ...ext }, mediaType);
  }
}

/**
 * `POST /graphql/{g}` — the request is the JSON body (`{query, variables, operationName, extensions}`).
 * The audit's "SHOULD respond with 4xx if content-type is not supplied on POST" and "MUST accept
 * application/json POST": a POST without a `Content-Type` is a 4xx; a body that is not valid JSON is a 400.
 */
export async function handlePost(executor: GraphQLExecutor, req: Request): Promise<Response> {
  const accept = req.headers.get('Accept');
  const { mediaType } = negotiate(accept);
  const contentType = req.headers.get('Content-Type');
  if (!contentType || !contentType.includes(JSON_MT))
    return respond(errorBody([{ message: 'POST requests must have a Content-Type of application/json' }]), mediaType, 400);
  let parsed: GraphQLRequest;
  try { parsed = JSON.parse(await req.text()) as GraphQLRequest; }
  catch { return respond(errorBody([{ message: 'POST body must be valid JSON' }]), mediaType, 400); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return respond(errorBody([{ message: 'POST body must be a JSON object' }]), mediaType, 400);
  return execute(executor, parsed, accept);
}

/**
 * `GET /graphql/{g}?query=…` — GraphQL-over-HTTP's GET form, which is what the verb is FOR (and what
 * `graphql-http`'s audit grades), not a browser page. `variables`/`extensions` are JSON-encoded
 * query-string params per the spec; a malformed one is a 400. There is deliberately NO server-rendered
 * HTML here: the endpoint is the product, and reflecting the untrusted path/query into a page is a
 * surface with no payoff (it was, briefly, and it was reflected XSS — deleted rather than escaped).
 */
export function handleGet(executor: GraphQLExecutor, req: Request): Promise<Response> {
  const accept = req.headers.get('Accept');
  const { mediaType } = negotiate(accept);
  const p = new URL(req.url).searchParams;
  const jsonParam = (name: string): unknown => {
    const raw = p.get(name);
    if (raw == null) return undefined;
    try { return JSON.parse(raw); } catch { throw new Error(`\`${name}\` must be JSON-encoded`); }
  };
  let parsed: GraphQLRequest;
  try {
    parsed = { query: p.get('query') ?? undefined, operationName: p.get('operationName') ?? undefined,
      variables: jsonParam('variables'), extensions: jsonParam('extensions') };
  } catch (e) {
    return Promise.resolve(respond(errorBody([{ message: (e as Error).message }]), mediaType, 400));
  }
  return execute(executor, parsed, accept);
}
