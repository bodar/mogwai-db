import { q, value, raw, type Relation } from '../../sql/kernel/q.ts';
import { propertyFts, vertexProperties, edgeProperties, nodes, edges, labels } from '../../sql/schema.ts';
import { sqlElem, storedValueExpr, type Elem } from '../../compiler/plan/plan.ts';
import { PROPERTY_PAYLOAD, toPropertyStream, type PropertyStream } from '../../compiler/steps/context/stream.ts';
import type { Carried } from '../../compiler/steps/context/context.ts';
import type { Service, ServiceCallCtx, CallParams } from '../spi/types.ts';

// ---------- tinker.search — full-text search over property values (pure, Start) ----------
//
// g.call("tinker.search", {search: "term"}).element() finds every property whose VALUE
// contains `term` (case-insensitively) and yields it as a PropertyStream — .element()
// then walks each match to its owner element (reusing the existing propertyElement tail).
// Backed by the property_fts trigram index (Step 6): the kind='value' rows hold each
// property's logical toString(), which is exactly what TinkerPop's `.*(term).*` matches
// (a collection ["a","brave"] matches "brave" via its "[a, brave]" toString). Matching only
// kind='value' (not jsonkey/jsonleaf) keeps one row per matched property — the nested rows
// exist for the finer-grained JSON search capability, not for tinker.search's owner walk.
//
// Divergences, both documented + consistent with the TextP predicates:
//   - CASE-INSENSITIVE (TinkerPop's is case-sensitive) — that is what lets the trigram
//     index serve LIKE '%term%'. The reference graphs are single-case, so conformance holds.
//   - INDEX-ONLY, fail closed: a term < 3 chars is below the trigram floor and a `regex`
//     param has no index-only implementation — both THROW a clear deferral. No scan, no JS.
//   - type default Vertex; explicit Edge searches edge properties; VertexProperty (meta-
//     property search) yields empty on the reference graphs (a static, documented gap).

/** The trigram floor: a substring pattern needs ≥3 non-wildcard chars to be index-answered.
 *  A shorter MATCH returns empty SILENTLY, so we guard with an explicit throw (never a
 *  silent wrong-empty). Shared conceptually with the TextP predicate (Step 8). */
const TRIGRAM_FLOOR = 3;

/** Search `type` → the owner_elem scope we search, or 'vertexproperty' (empty on the
 *  reference graphs). Default Vertex (matches TinkerGraph's reference impl). */
function ownerScopeOf(params: CallParams): Elem | 'vertexproperty' {
  const t = params.type;
  const raw = (typeof t === 'string' ? t
    : t && typeof t === 'object' && 'elementName' in t ? String((t as { elementName: unknown }).elementName)
    : 'Vertex').toLowerCase();
  if (raw === 'vertex') return 'vertex';
  if (raw === 'edge') return 'edge';
  if (raw === 'vertexproperty') return 'vertexproperty';
  throw new Error(`tinker.search: unsupported type '${raw}' (expected Vertex, Edge, or VertexProperty)`);
}

/** The `search` term — a required string param. A `regex` param fails closed (no index-only
 *  path). Below the trigram floor also fails closed. Returns the LIKE-escaped `%term%`. */
function searchPattern(params: CallParams): string {
  if (params.regex !== undefined)
    throw new Error('tinker.search: regex matching is not supported (no index-only implementation; not scanned or evaluated in JS)');
  const term = params.search;
  if (typeof term !== 'string' || term.length === 0)
    throw new Error('tinker.search requires a non-empty string `search` param');
  if (term.length < TRIGRAM_FLOOR)
    throw new Error(`tinker.search: a term shorter than ${TRIGRAM_FLOOR} characters cannot be served by the trigram index (fails closed — no table scan)`);
  // LIKE-escape %/_/\ in the user term, then wrap %…% for a substring match.
  return `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

/** The empty PropertyStream (type=VertexProperty, or a genuinely unmatched scope): a
 *  PROPERTY_PAYLOAD CTE with no rows. */
function emptyProperties(ctx: ServiceCallCtx, ownerElem: Elem): PropertyStream {
  const carried: Carried = { aliases: new Map(), origins: [] };
  // The column names are the fixed PROPERTY_PAYLOAD list (SQL identifiers, never user data),
  // so a raw `NULL AS <col>` projection with a WHERE 0 guard yields the empty relation.
  const proj = raw(PROPERTY_PAYLOAD.map((c) => `NULL AS ${c}`).join(', '));
  const rel = ctx.q.cte(q`SELECT ${proj} WHERE 0`, [...PROPERTY_PAYLOAD]);
  return toPropertyStream({ q: ctx.q, params: ctx.compileParams, carried }, rel, ownerElem);
}

/** Build the matched-properties PropertyStream for a node/edge scope. Joins property_fts
 *  (kind='value', the searched scope, text LIKE %term%) back to the property table for the
 *  full payload (pk/pv/pvtype/meta) and to the owner + its label. */
function searchProperties(ctx: ServiceCallCtx, ownerElem: Elem, pattern: string): PropertyStream {
  const carried: Carried = { aliases: new Map(), origins: [] };
  const f = propertyFts.as('f');
  const likeMatch = q`${f.c.text} LIKE ${value(pattern)} ESCAPE ${value('\\')}`;
  const scope = q`${f.c.owner_elem}=${value(sqlElem(ownerElem))} AND ${f.c.kind}=${value('value')} AND ${likeMatch}`;
  let body;
  if (ownerElem === 'vertex') {
    const vp = vertexProperties.as('vp');
    const nd = nodes.as('n');
    const l = labels.as('l');
    // vpid = the VertexProperty id; owner = the vertex; pmeta = its meta bag.
    body = q`SELECT ${vp.c.id} AS vpid, ${nd.c.id} AS owner, ${l.c.name} AS ownerLabel, ${vp.c.key} AS pk, ${storedValueExpr(vp.c.value, vp.c.vtype)} AS pv, ${vp.c.vtype} AS pvtype, json(${vp.c.meta}) AS pmeta
      FROM ${f} JOIN ${vp} ON ${vp.c.id}=${f.c.pid} JOIN ${nd} ON ${nd.c.id}=${vp.c.node} JOIN ${l} ON ${l.c.id}=${nd.c.label} WHERE ${scope}`;
  } else {
    const ep = edgeProperties.as('ep');
    const ed = edges.as('e');
    const l = labels.as('l');
    // An edge Property has no id/meta/multi → vpid/pmeta NULL, mirroring lowerProperties.
    body = q`SELECT NULL AS vpid, ${ed.c.id} AS owner, ${l.c.name} AS ownerLabel, ${ep.c.key} AS pk, ${storedValueExpr(ep.c.value, ep.c.vtype)} AS pv, ${ep.c.vtype} AS pvtype, NULL AS pmeta
      FROM ${f} JOIN ${ep} ON ${ep.c.id}=${f.c.pid} JOIN ${ed} ON ${ed.c.id}=${ep.c.edge} JOIN ${l} ON ${l.c.id}=${ed.c.label} WHERE ${scope}`;
  }
  const rel: Relation = ctx.q.cte(body, [...PROPERTY_PAYLOAD]);
  return toPropertyStream({ q: ctx.q, params: ctx.compileParams, carried }, rel, ownerElem);
}

export const searchService: Service = {
  name: 'tinker.search',
  type: 'start',
  describeParams: () => ({ search: 'string (substring, ≥3 chars, case-insensitive)', type: 'Vertex | Edge | VertexProperty (default Vertex)' }),
  resolve: (ctx: ServiceCallCtx) => ({
    kind: 'stream',
    build: (c) => {
      const scope = ownerScopeOf(c.params);
      const pattern = searchPattern(c.params);
      // VertexProperty (meta-property) search is empty on the reference graphs — a static,
      // documented gap. Return an empty vertex-owner PropertyStream so .element() is empty.
      if (scope === 'vertexproperty') return emptyProperties(c, 'vertex');
      return searchProperties(c, scope, pattern);
    },
  }),
};
