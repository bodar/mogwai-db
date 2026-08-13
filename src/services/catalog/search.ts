import * as make from '../../rel/factory.ts';
import { col, compilerInt, compilerText } from '../../rel/expr.ts';
import { and, eq, meta, typeOf } from '../../compiler/rel/build.ts';
import { propertyJoin } from '../../compiler/rel/property.ts';
import { sqlElem, type Elem } from '../../compiler/plan/plan.ts';
import type { Service, RelCallSite, RelContribution, CallParams } from '../spi/types.ts';

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

/**
 * The matched properties as a RelIR relation — an FTS scan joined back to the property table for the
 * payload, which is `propertyJoin`'s caller-supplied ON in its second form: this producer has no
 * element input and matches the property's own id against the hit, where `properties()` matches the
 * owner. Both go through the one join so neither grows its own opinion of what a property row is.
 *
 * The scope predicate is `owner_elem` + `kind='value'` + the LIKE. Only `kind='value'` rows are
 * matched: they hold each property's logical toString(), which is exactly what TinkerPop's
 * `.*(term).*` matches, and the finer jsonkey/jsonleaf rows exist for a different capability — one
 * row per matched property is the contract `element()` walks.
 *
 * The term is a parsed LITERAL, so it inlines as a typed SQL literal and spends none of the DO's 100
 * parameters. A bind serves a user PARAMETER; this is a constant the compiler already holds.
 */
function searchProperties(site: RelCallSite, ownerElem: Elem, pattern: string, empty = false): RelContribution {
  const fts = make.scan({
    id: site.fresh('fts'), table: 'property_fts', alias: site.fresh('rf'), channels: [],
    type: typeOf(meta('owner_elem', 'text'), meta('pid', 'int'), meta('kind', 'text'), meta('text', 'text', true)),
  });
  const scoped = make.filter({
    id: site.fresh('ffl'), input: fts, channels: [], type: fts.type,
    pred: and(
      and(eq(col(fts.id, 'owner_elem'), compilerText(sqlElem(ownerElem))),
        eq(col(fts.id, 'kind'), compilerText('value'))),
      // SQLite's `like(pattern, subject, escape)` FUNCTION, not the infix operator — the algebra has
      // no node for an ESCAPE clause and §7 keeps the node set closed, so the function says it
      // instead. The same form `predicate.ts` emits for every TextP substring op.
      empty
        // THE EMPTY RELATION, spelled as the algebra spells one: a `Filter(false)` over something
        // (§3.3). `Values([])` is unrepresentable — it rendered as invalid SQL that only failed at the
        // database — and here there IS something to be over, so meta-property search yields no rows
        // rather than declining. Declining would be wrong: a decline raises `UnsupportedTraversal`,
        // leaving NOTHING answering a shape that should return empty.
        ? eq(compilerInt(0), compilerInt(1))
        : { kind: 'call', fn: 'like', args: [compilerText(pattern), col(fts.id, 'text'), compilerText('\\')] },
    ),
  });
  const rel = propertyJoin(scoped, ownerElem, (props) => eq(col(props, 'id'), col(scoped.id, 'pid')), site.fresh);
  return { kind: 'relation', rel, framing: { kind: 'property', ownerElem } };
}

export const searchService: Service = {
  name: 'tinker.search',
  type: 'start',
  describeParams: () => ({ search: 'string (substring, ≥3 chars, case-insensitive)', type: 'Vertex | Edge | VertexProperty (default Vertex)' }),
  resolve: () => ({
    kind: 'rel',
    buildRel: (c) => {
      const scope = ownerScopeOf(c.params);
      const pattern = searchPattern(c.params);
      // VertexProperty (meta-property) search is empty on the reference graphs — a static, documented
      // gap — so it yields the EMPTY relation rather than declining. See `searchProperties`.
      if (scope === 'vertexproperty') return searchProperties(c, 'vertex', pattern, true);
      return searchProperties(c, scope, pattern);
    },
  }),
};
