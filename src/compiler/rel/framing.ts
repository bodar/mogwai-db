import { perRowColumnOf, type ListOf, type MapOf, type ScalarType } from '../../sql/kernel/render.ts';
import type { Rel } from '../../rel/rel.ts';
import { compilerNull, type Expr } from '../../rel/expr.ts';
import type { ColMeta } from '../../rel/types.ts';
import type { Elem } from '../elem.ts';
import type { VariantArm } from './variant.ts';

// ---------- what the framing layer must build over a result relation ----------
//
// The shape half of a lowering, in its own leaf so that everything which PRODUCES a relation for the
// fold can name it without reaching into `lower.ts`. That is not a tidiness move: `lower.ts` is the
// fold itself, so a producer that lives outside it — a service contributing a `call()` result — would
// otherwise have to import the fold while the fold imports the producer's type. This module is the
// bottom of that DAG: it imports only `render.ts`, `Elem` and `ColMeta`, and nothing imports it back.
//
// **It stays INTERNAL to the fold, and that boundary is unchanged by living here.** What crosses to
// `execute.ts` is a `Shape` (`RelLowering.shape`), because the byte framers need exactly one fact and
// the plan's result relation IS the rows they frame. `RelFraming` is the larger question — an arm
// merge and a retype need to know what a relation HOLDS (member encodings, key/value sides, the
// scalar type channel) — so two vocabularies for two questions. The thing that rule guards against is
// concrete and was measured: the translator that used to cross that boundary (`layoutOf`/
// `LAYOUT_FIELD`, `Channels`→`TraverserLayout`) needed a case per channel role and THREW when it
// lacked one, which is what blocked the path channel.

/**
 * WHAT THE FRAMING LAYER MUST BUILD over the result relation — the shape half of a lowering.
 *
 * Shape does not enter the NODE SET (§2) — but this LOWERING both knows it and says so, which is what
 * `RelFraming` is. A lowering hands back a relation plus the minimum needed to build that relation's
 * payload projection and pick its `Shape`. Deliberately a union rather than a widened record: an element
 * stream has no scalar type and a scalar stream has no element kind, and pretending otherwise is how a
 * shape vocabulary starts leaking into `src/rel/`, which is the boundary that matters.
 *
 * It grows one arm per stream kind the spine learns, and every consumer switches on it TOTALLY, so a
 * shape this route learns to produce is a compile error until its projection and its `Shape` are
 * declared. Per §6·3 that projection belongs here.
 */
export type RelFraming =
  | { readonly kind: 'elements'; readonly elem: Elem }
  /** A BOUND element — a federated subgraph / barrier `call()`'s awaited rows, landed by `foreign.ts`.
   *  The wire shape is an ordinary vertex/edge (the framers cannot tell, and must not). Under id-carry
   *  (locked 2026-08-22) this is an id-carrying stream EXACTLY like `elements`, and it frames through the
   *  same `source.leafPayload` seam — `BoundGraph` REJOINS the landed relation by id to reconstitute the
   *  (id, label, props[, src, tgt]) tuple, where `BaseGraph` reads the base tables. So the two arms are
   *  byte-identical at the leaf; this stays its own arm only to ROUTE the step vocabulary a bound element
   *  may continue with (`continueAs` → the narrow `detachedTail` vs the full `elementTail`), which is a
   *  real coverage limit, not a payload-representation difference. (Historical: before id-carry a detached
   *  relation carried its own payload; that model is gone.) */
  | { readonly kind: 'detached'; readonly elem: Elem }
  /** `productiveNull` says a NULL result is a REAL value rather than the framer's signal to emit
   *  nothing. It is the `ProductiveByStrategy` fact, and it reaches here from the LIST whose members
   *  a local reducer collapsed: nothing was dropped, so an all-null collection reduces to a null
   *  that `MaxLocalStep` genuinely emits (`NumberHelper.max(null,null)` returns null and the step
   *  splits on it — `gremlin-core/.../util/NumberHelper.java`, `.../step/map/MaxLocalStep.java:45`).
   *  Without it the framer's "a null scalar is no result" rule silently eats a correct answer. */
  | { readonly kind: 'scalar'; readonly type: ScalarType; readonly result?: 'value' | 'count' | 'number'; readonly productiveNull?: boolean }
  /** A traverser whose VALUE is a collection — one JSONB `list` column per row (§ the list
   *  vocabulary, `list.ts`). `of` describes the MEMBER encoding, which is what the framing layer
   *  needs to know how to expand each one; `set` is a framing marker only (a SET frames differently,
   *  the member substrate is shared). */
  | { readonly kind: 'list'; readonly of: ListOf; readonly set?: boolean }
  /** A traverser whose value is a PATH — the LIST arm's relation exactly (one JSONB `list` column of
   *  typed-tree positions), and only the wire form differs (`framePath` over the same per-member buffers).
   *  `scalars` says every position is a `by()`-projected value rather than an element, which is what decides
   *  whether the path may RE-ENTER the list vocabulary: a member op decodes to a scalar stream, and that
   *  stream has no element arm (see `pathPositions`). It is a required field, not an optional marker — a
   *  path always knows the answer, and defaulting it either way is how a wrong shape gets framed. */
  | { readonly kind: 'path'; readonly of: ListOf; readonly scalars: boolean }
  /** A traverser whose VALUE is a MAP — one JSONB `map` column per row holding an ordered
   *  `[[keyNode, valNode], …]` pairs array, which is the same self-describing tree a stored map
   *  property uses. The LIST arm's twin, deliberately: `keyOf`/`valOf` describe each side's shape for
   *  the framing layer exactly as `of` does for a list, and a pairs ARRAY rather than a JSON object is
   *  what keeps the entry order ours to state and lets a key be something other than a string.
   *
   *  Its static KEY FACT (`MapKeyFacts`) bounds `map.containsKey(k)` at compile time, which is what
   *  `select(k)` needs to resolve TinkerPop's map-key-then-side-effect-then-label precedence
   *  (`Scoping.getScopeValue`,
   *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135`).
   *  It is a sound MAY set — see `MapKeyFacts`. */
  | ({ readonly kind: 'map'; readonly keyOf: MapOf; readonly valOf: MapOf } & MapKeyFacts)
  /** ONE ENTRY of a map, as the traverser — what `unfold()` over a map produces. A separate arm from
   *  `map` and not a one-entry map value, because the two sides are their own COLUMNS here: that is
   *  what makes `select(Column.keys)` after it a column read rather than a second JSON walk, and it is
   *  also the wire's own distinction (a Map.Entry frames as a size-1 GraphBinary MAP — TinkerPop's
   *  `MapEntrySerializer`, TINKERPOP-3104 — while a map value frames as the whole map). */
  | { readonly kind: 'mapEntry'; readonly keyOf: MapOf; readonly valOf: MapOf }
  /** THE RECORD — a map whose KEYS ARE KNOWN AT COMPILE TIME, so its fields are still addressable
   *  columns rather than an opaque blob. `project('a','b')` and `select('a','b')` produce it.
   *
   *  It is a SEPARATE arm from `map` and the difference is the whole reason the shape exists: a map
   *  value is one JSONB column and a step after it can only re-enter through JSON, while a record's
   *  field is a relation of its own shape — so `project(…).select('a')` re-roots to an ELEMENT stream,
   *  `order().by(__.select('b'))` sorts on a column, and a field keeps the `vtype` its value arrived
   *  with. Collapsing the two would mean re-deriving each field's shape out of a blob that no longer
   *  records it, which is the lossy discard §6·7 names.
   *
   *  A record BECOMES a map (`recordValue`, `record.ts`) at the one boundary that needs a value — the
   *  wire, a list member, a group key. One direction only: nothing turns a map back into a record. */
  | { readonly kind: 'record'; readonly fields: readonly RecordField[] }
  /** A traverser that IS a property — `properties()`, not `values()`. A VertexProperty on a vertex
   *  (its own id, its own meta-properties) and a Property on an edge, which is neither an Element
   *  nor able to carry meta; `ownerElem` is what decides that, and it is required because the two
   *  differ in the payload's columns rather than only in their values. */
  | { readonly kind: 'property'; readonly ownerElem: Elem }
  /** NOTHING to frame. A write whose Gremlin result is no traverser at all (`drop()`, and `iterate()`
   *  over any of them) ends on a statement with an empty `RETURNING`, so the plan's result relation
   *  has no columns and there is no shape to interpret. It is an arm of this union rather than an
   *  absent framing because `spine.ts` switches TOTALLY: "there is nothing here" has to be something
   *  the lowering can SAY. */
  /** A branch whose arms have DIFFERENT SHAPES — a per-row tagged union (`compiler/rel/variant.ts`).
   *  `arms` is the complete declared vocabulary, which is what the wire's `vk` dispatch needs: a row
   *  whose tag names an arm the shape did not declare is a throw at the framer, not an inference. It
   *  is a framing rather than a node-set question for §6·3's reason — the algebra builds the VALUE
   *  (one `Union` over re-projected arms) and `execute.ts` frames it. */
  | { readonly kind: 'variant'; readonly arms: readonly VariantArm[] }
  /** A per-row SELF-DESCRIBING TYPED NODE — each row is one `{t,v}` envelope, framed by the ONE
   *  `frameTypedNode` rule (`execute.ts`). Produced by `unfold()` over a MIXED-member collection
   *  (`ListOf.mixed`): its members are heterogeneous self-describing nodes, so each frames by its own
   *  tag — a vertex, an edge, a scalar leaf. It is the member-level tagged union framed the member way,
   *  distinct from `variant` (a per-row union framed through vk-columns) because a self-describing
   *  envelope carries the per-member scalar TYPE that `variant`'s single static scalar arm cannot.
   *  Terminal, exactly as `variant` is. */
  | { readonly kind: 'typedNode' }
  | { readonly kind: 'discard' };

/**
 * A MAP'S STATIC KEY FACT — what every row's map MAY hold.
 *
 * `keys` is a SOUND MAY upper bound: no row's map holds a string key outside it. It is LOAD-BEARING, not
 * advisory — a `select(k)` whose `k` is outside it skips the entry read and answers from the next scope (a
 * side effect, a path label), so a `keys` that is too NARROW is a wrong answer. A writer may DROP it
 * (`undefined` = any key possible: a stored map property, `valueMap()` all-keys, `group()`), never narrow
 * it. A transformer that only REMOVES entries (a local entry slice) keeps it as an upper bound.
 *
 * There is deliberately no MUST (held) set: a key a row MAY hold beside a same-named side-effect constant
 * or path label is a collision the QUERY TEXT names, so a reader declines on it (§17 "Map scope") rather
 * than build a per-row entry-or-scope read (`Scoping.getScopeValue`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135`).
 * A merge of several streams goes through ONE meet (`meetMapKeyFacts`, reached from `meetFraming` in
 * `lower/branch.ts` and from an alias history's join).
 */
export interface MapKeyFacts {
  readonly keys?: readonly string[];
}

/**
 * MAY A ROW'S MAP HOLD `key`? — the ONE reading of the key fact every map-first reader makes (`mapTail`'s
 * `select(k)` and keyed `dedup(k)`, `format('%{k}')`/`math` and a `by(__.select(k))` over a map host).
 * `false` means NO row does, so the next scope answers for every row; `true` means some row may, so a
 * reader whose next scope could also name `key` declines.
 */
export const mayHoldKey = (facts: MapKeyFacts, key: string): boolean => !facts.keys || facts.keys.includes(key);

/** A map's key fact carried from one description to the next — a framing, a host, an alias entry. */
export const mapKeyFacts = (from: MapKeyFacts): MapKeyFacts => (from.keys ? { keys: from.keys } : {});

/** The key fact of a map LITERAL — its string keys. A non-string key (a `T`/`Direction` token) makes the
 *  MAY set something this vocabulary does not spell, so `keys` is then left unknown. */
export const literalKeyFacts = (keys: readonly unknown[]): MapKeyFacts =>
  keys.every((key) => typeof key === 'string') ? { keys: keys as readonly string[] } : {};

/**
 * THE MEET of several streams' key facts — what a stream holding ANY of their rows may claim: the UNION
 * of the MAY sets, unknown if any side is unknown (an absent upper bound is the top). Compile-time lattice
 * algebra per node, the way Calcite's `RelMetadataQuery` answers a `Union`'s metadata from its inputs'.
 */
export const meetMapKeyFacts = (facts: readonly MapKeyFacts[]): MapKeyFacts =>
  facts.every((fact) => fact.keys) ? { keys: [...new Set(facts.flatMap((fact) => fact.keys!))] } : {};

/**
 * A RELATION AND WHAT IT HOLDS — the pair every producer in the fold hands back, and the smallest
 * complete answer to "I lowered this; what is it?".
 *
 * Named because it was spelled inline fourteen times, and an anonymous shape repeated that often is a
 * concept the code has not admitted to having: a tail function, a record/projector/sack read, a
 * service's `relation` contribution and a `cap()` all return exactly this and mean exactly the same
 * thing by it. `Tail` is this plus the facts that are NOT about the relation (its aliases, its
 * pending statements), which is why it extends this rather than restating it.
 */
export interface FramedRel {
  readonly rel: Rel;
  readonly framing: RelFraming;
}

/**
 * ONE FIELD of a record — its Gremlin key, the COLUMN PREFIX its payload rides under, and what that
 * payload IS.
 *
 * `framing` is RECURSIVE on purpose: a field is a stream of its own shape, so a record of records
 * (`group().by(__.project(…))`, `project('a').by(__.project('b'))`) needs no second vocabulary. The
 * prefix composes the same way — a nested field's column is `<outer>_<inner>_<name>`.
 *
 * `optional` says the field may be ABSENT on a row, which is `project()`'s productivity rule and not a
 * nullability note: TinkerPop OMITS the key whose `by()` produced nothing (`ProjectStep.map` —
 * `ifProductive(p -> end.put(projectKey, p))`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:66`)
 * and leaves the traverser. A field that CANNOT be unproductive (a token, the traverser itself,
 * anything under `ProductiveByStrategy`) says so, and the map assembly then spends no `CASE` on it.
 */
export interface RecordField {
  readonly key: string;
  readonly prefix: string;
  readonly framing: RelFraming;
  readonly optional: boolean;
  /** The field IS the same-named path label's last value (an un-modulated `select(k1, k2, …)` of labels),
   *  so a scope read of its name answers the same from the record or from the path. */
  readonly mirrorsAlias?: true;
}

/**
 * IS THIS FIELD PRESENT on a row — its FIRST payload column's non-nullness (a rowid for an element, `v`
 * for a value, `list`/`map` for a collection), or `null` where the framing has no payload to read. A
 * NULL value is an ABSENT one: presence is value nullness (a deliberate divergence — the reference keeps a
 * by() that produced a literal null as a key mapping to null). `read` names a column under the field's
 * prefix already applied. The one spelling every reader of an optional field shares — the map assembly,
 * the field re-entry, a `by(__.select(<field>))` — so they cannot disagree about which rows have the key.
 */
export function fieldPresence(field: RecordField, read: (column: string) => Expr): Expr | null {
  const first = framingCols(field.framing)?.[0];
  return first ? { kind: 'binary', op: 'is not', left: read(fieldCol(field.prefix, first.name)), right: compilerNull() } : null;
}

/** The key fact of a record COLLAPSED to a map (`recordToMap`): it MAY hold every field. */
export const recordKeyFacts = (fields: readonly RecordField[]): MapKeyFacts => ({ keys: fields.map((field) => field.key) });

/** A record's field by KEY, or `undefined`. Here rather than in `record.ts` because the by()
 *  vocabulary needs it too — `Scoping.getScopeValue` tries the traverser's own MAP before the path
 *  labels, so `by(__.select('b'))` over a record must ask this first — and `record.ts` imports
 *  `modulator.ts`, so the lookup cannot live on that side of the DAG. */
export const fieldNamed = (fields: readonly RecordField[], key: string): RecordField | undefined =>
  fields.find((field) => field.key === key);

/** A record field's column, under its prefix. The ONE spelling, because the builder, the field
 *  re-entry and the map assembly must agree, and a prefix composed three ways is three chances to
 *  disagree. */
export const fieldCol = (prefix: string, name: string): string => `${prefix}_${name}`;

/**
 * THE PAYLOAD COLUMNS A FRAMING'S RELATION CARRIES — the naming convention every tail loop already
 * assumes, stated ONCE.
 *
 * It was implicit knowledge spread across the fold: `elementTail` knows an element relation's payload is
 * `id`, `scalarTail` knows a value's is `v` (plus a type column), `listTail` knows a list's is `list`.
 * That is fine while a relation holds exactly one traverser shape — and false the moment a RECORD holds
 * N of them side by side, because then something has to say how wide each field is. Deriving it from
 * the framing rather than from the relation is what lets a field be re-entered as an ordinary stream:
 * the rename back to canonical names is this list, applied in reverse.
 *
 * `null` for a shape that cannot be a field. A PROPERTY is a multi-column payload whose builder lives in
 * `plan.ts` and whose columns are not this convention; a DISCARD has no payload at all. Both are
 * declines rather than omissions — the switch is total, so a shape that becomes reachable as a field is
 * a compile error here until its columns are declared.
 */
export function framingCols(framing: RelFraming): readonly ColMeta[] | null {
  switch (framing.kind) {
    case 'elements': return [{ name: 'id', type: 'int', nullable: true }];
    case 'scalar': {
      // The SAME rule `scalarPayload` (`lower.ts`) applies at the wire, and it is stated here rather
      // than there because a record field needs it too: a numeric reducer's class is its `vt` column (a
      // Gremlin type name, `reducer.ts` `REDUCED_TYPE`), a stored value's is its `vtype` column, and a
      // static/unknown tag needs no column at all.
      const typeCol = framing.result === 'number' ? 'vt' : perRowColumnOf(framing.type);
      return [
        { name: 'v', type: 'any', nullable: true },
        ...(typeCol ? [{ name: typeCol, type: 'text' as const, nullable: true }] : []),
      ];
    }
    case 'list': case 'path': return [{ name: 'list', type: 'json', nullable: true }];
    case 'map': return [{ name: 'map', type: 'json', nullable: true }];
    case 'mapEntry': return [{ name: 'mk', type: 'json', nullable: true }, { name: 'mv', type: 'json', nullable: true }];
    case 'record': {
      const nested: ColMeta[] = [];
      for (const field of framing.fields) {
        const cols = framingCols(field.framing);
        if (!cols) return null;
        for (const column of cols) nested.push({ ...column, name: fieldCol(field.prefix, column.name), nullable: true });
      }
      return nested;
    }
    // A VARIANT has no fixed payload — its columns depend on which arms it declares, and a record
    // field needs a shape it can name in advance. Declining keeps `project().by(<mixed branch>)` an
    // honest gap rather than a field whose width varies by row.
    // A DETACHED element is not a field either: its payload is the whole landed tuple rather than the
    // `id` an element field carries, and nothing correlates back to it — a barrier's rows exist only
    // after the segment boundary, so no expression inside one plan can name them.
    // A per-row TYPED NODE is not a fixed-width field either — its payload is one opaque `{t,v}`
    // envelope whose shape varies by row, exactly the reason `variant` declines.
    case 'detached': case 'variant': case 'typedNode': case 'property': case 'discard': return null;
  }
}
