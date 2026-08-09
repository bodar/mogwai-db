import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { perRowColumn, type Shape } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/step.ts';
import { and, carriedCols, eq, mapNode, meta, typedNode, typeOf, EMPTY_ARRAY, type Minter } from './build.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { elementNode } from './element.ts';
import { fieldCol, framingCols, type RecordField, type RelFraming } from './framing.ts';
import { MAP_COL, mapPayload } from './map.ts';
import { byField, modulations } from './modulator.ts';
import { aliasGuard, aliasPresent, aliasProjection, liveAliases, readFraming, readProjection, selectSpec, type AliasRead } from './alias.ts';
import type { AliasMap } from '../plan/alias.ts';
import type { ColMeta } from '../../rel/types.ts';

/**
 * THE RECORD SHAPE — a map whose KEYS ARE KNOWN AT COMPILE TIME, carried as columns.
 *
 * The ninth vocabulary module on `build.ts`, and the MAP module's other twin: `map.ts` owns a map that
 * is a VALUE (a barrier's result, one opaque JSONB column), and this owns a map whose fields are still
 * addressable. `project('a','b')` and multi-label `select('a','b')` produce it, and `valueMap()` is the
 * next caller.
 *
 * ## Why a record is not "a map built per row"
 *
 * It was tempting to make `project()` the same `mapOfGroups` blob without the aggregate, and that is a
 * lossy discard of exactly the §6·7 kind. A map value is one column: everything the fields WERE —
 * an element's rowid, a stored value's `vtype`, a count's `long` — has been expanded into the payload
 * tree and cannot be read back out as a stream. But `project()` is a MAP STEP, not a barrier, and the
 * chain continues:
 *
 * - `project('a','b').by('name').by(__.in().count()).select('a')` re-roots to a VALUE stream;
 * - `project('v','n').by().by('name').select('v')` re-roots to a VERTEX stream, which is only possible
 *   while the field is still a rowid;
 * - `order().by(__.select('b'))` sorts on a field, which wants a column and not a JSON extraction.
 *
 * So the record carries one prefixed column-set per field (`framingCols`, `framing.ts`) and BECOMES a
 * map exactly once, at the boundary that needs a value — the wire here, and later a list member or a
 * group key. One direction only: nothing turns a map back into a record, because the information is
 * genuinely gone by then.
 *
 * ## What the wire sees is the map the map module already frames
 *
 * `recordValue` builds `[[key, valueNode], …]` — the SAME self-describing pairs array `mapOfGroups`
 * emits, so the framing arm is the existing `mapValue` `Shape` and `execute.ts` needed nothing new.
 * An element field rides as a `{t:'vertex', v:{…}}` member for the reason `group()`'s collecting value
 * does: the typed tree is self-describing, so `frameTypedNode` walks an element at any depth by the one
 * rule it already has.
 *
 * ## Productivity is per FIELD, and `project` and `select` disagree about it
 *
 * `ProjectStep.map` OMITS the key whose `by()` was unproductive and keeps the traverser
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:66`
 * — `ifProductive(p -> end.put(projectKey, p))`), so an all-unproductive `project()` still emits an
 * EMPTY map. `SelectStep.processNextStart` does the opposite: it `break`s out of the key loop and
 * returns `EmptyTraverser`, dropping the traverser entirely
 * (`.../step/map/SelectStep.java:74-81`). Same substrate, two host rules — which is why the omission is
 * recorded on the FIELD (`RecordField.optional`) and the drop is the host's own `Filter`.
 */

/** The prefix a field's columns ride under. Positional rather than derived from the key, because a
 *  Gremlin key is arbitrary text and a column name is not — `project('a b','$x')` is legal Gremlin. */
const prefixAt = (index: number): string => `f${index}`;

/** Compose an OUTER prefix with an inner column name. A record nested inside a record has its fields'
 *  columns at `<outer>_<inner>_<name>`, which is exactly what `framingCols`' recursive arm declares —
 *  so the reader composes the same way or it reads a column that is not there. */
const qualify = (at: string, name: string): string => (at ? fieldCol(at, name) : name);

/**
 * `project(keys…)`'s FIELDS — each slot's payload expressions, keyed by the field's prefixed column
 * name, plus what each field IS. `null` declines.
 *
 * The half `recordOf` and `recordNode` share, and the split is the record's two physical forms: this
 * answers what the fields ARE, and the caller decides whether they become COLUMNS of a relation (a
 * `project()` in the chain, whose fields stay addressable) or a MAP NODE assembled on the spot (a
 * `project()` inside a `by()`, which has no row to name). Spelling the `by()` ring, the key checks and
 * the field loop twice is how the two forms would start disagreeing about which key is omitted when.
 *
 * The `by()` RING CYCLES, which is upstream's and not a convenience: `TraversalRing.next()` is
 * `(current + 1) % size` and an EMPTY ring yields `null`, which `TraversalUtil.produce` reads as the
 * traverser itself (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalRing.java:41-48`).
 * So `project('a','b','c').by('name')` gives all three fields the same `by('name')`, and a bare
 * `project('a','b')` gives both the traverser.
 */
function recordFields(
  step: IRStep, host: ChildHost | null, hostFraming: RelFraming, hostCol: (name: string) => Expr,
  child: ChildSeam, fresh: Minter,
): { readonly fields: readonly RecordField[]; readonly exprs: ReadonlyMap<string, Expr> } | null {
  if (step.optionArms) return null;
  const keys = (step.args ?? []).map((a) => a.value);
  if (!keys.length || keys.some((key) => typeof key !== 'string')) return null;
  // `ProjectStep`'s own constructor raises `keys must be unique in ProjectStep`. That is a refusal on
  // the traversal's TEXT and belongs to the Pass tier (§6·5); until it lives there, declining hands the
  // traversal to the spine that raises today rather than answering a map with a key written twice.
  if (new Set(keys as string[]).size !== keys.length) return null;

  const bys = modulations(step, keys.length, child);
  if (!bys) return null;

  const fields: RecordField[] = [];
  const exprs = new Map<string, Expr>();
  for (const [index, key] of (keys as readonly string[]).entries()) {
    const by = bys.length ? bys[index % bys.length]! : { key: { kind: 'identity' } as const };
    const built = byField(step, by, host, hostFraming, hostCol, fresh, child);
    if (!built) return null;
    const prefix = prefixAt(index);
    for (const [name, expr] of built.exprs) exprs.set(fieldCol(prefix, name), expr);
    fields.push({ key, prefix, framing: built.framing, optional: built.optional });
  }
  return { fields, exprs };
}

/**
 * A `project()` INSIDE A `by()` — the record's PAIRS ARRAY over the HOST traverser, or `null` to
 * decline.
 *
 * The pairs array and not the `{t:'map', v:…}` node around it, deliberately: that is exactly what a
 * map-framed RELATION carries in its `map` column (`recordToMap`, `mapOfGroups`), so `RelFraming`'s
 * `map` arm means ONE thing whether the value came from a column or from a correlated read, and the
 * envelope is added by whichever consumer needs a member (`byNode`, `fieldNode`).
 *
 * This is the §6·6 answer to "the algebra cannot express a record-keyed group". It can, and always
 * could: a record BECOMES a map at the one boundary that needs a value, and a group KEY is exactly
 * such a boundary (this module's own header named it). What was missing was not a node kind but a
 * route — `child.scalar` was never handed a `project()` body, so `MapOf`'s `elem` tag looked like the
 * blocker when the blocker was that nothing asked.
 *
 * So `g.E().group().by(__.project('o','l','i').by(__.outV().values('name')).by(__.label()).by(__.inV().values('name')))`
 * groups by that map, and the fields keep their own encodings: an element field is a
 * `{t:'vertex', v:{…}}` member, a stored value keeps its `vtype`, an unproductive slot omits its key.
 *
 * ## The GROUP BY term is the map's JSON text, and that is `Map.equals` exactly
 *
 * `GroupStep` keys a `HashMap` on the produced Map, so two traversers group together iff their maps
 * have the same keys bound to equal values. The pairs array is built in `project()`'s own key order
 * with each value under its own encoding, so equal maps produce identical text and unequal ones do
 * not — an omitted key shortens the array, which is the different key SET it is. A JSON key is not a
 * cheap grouping term, and there is no cheaper one available: unlike an element key there is no rowid
 * that stands for the whole value.
 */
export function recordNode(
  step: IRStep, host: ChildHost, hostFraming: RelFraming, hostCol: (name: string) => Expr,
  child: ChildSeam, fresh: Minter,
): Expr | null {
  const built = recordFields(step, host, hostFraming, hostCol, child, fresh);
  if (!built) return null;
  return recordPairs((column) => {
    const expr = built.exprs.get(column);
    // A field column with no expression is a `framingCols`/`byField` disagreement inside this module,
    // not a traversal this route cannot express — the same invariant `recordOf` throws on.
    if (!expr) throw new Error(`RelIR lowering: record field column ${column} has no expression`);
    return expr;
  }, built.fields, fresh);
}

/**
 * `project(keys…)` — the record, built. `null` declines.
 *
 * The `by()` RING CYCLES, which is upstream's and not a convenience: `TraversalRing.next()` is
 * `(current + 1) % size` and an EMPTY ring yields `null`, which `TraversalUtil.produce` reads as the
 * traverser itself (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalRing.java:41-48`).
 * So `project('a','b','c').by('name')` gives all three fields the same `by('name')`, and a bare
 * `project('a','b')` gives both the traverser.
 *
 * `host` is nullable because a bare `by()` needs no `ChildHost` at all — the identity arm reads the
 * host RELATION's payload columns. A traverser shape with no `ChildHost` (a list) therefore still
 * projects itself, and only a property/token/child `by()` over one declines.
 */
export function recordOf(
  input: Rel, host: ChildHost | null, hostFraming: RelFraming, step: IRStep,
  child: ChildSeam, fresh: Minter,
): { readonly rel: Rel; readonly fields: readonly RecordField[] } | null {
  const built = recordFields(step, host, hostFraming, (name) => col(input.id, name), child, fresh);
  if (!built) return null;
  const { fields, exprs } = built;

  // The declared type comes from `framingCols` and the expressions are looked UP by it, rather than
  // both being built in parallel from the same loop. The two must agree in ORDER as well as in name,
  // and a `Project` whose exprs and declared type disagree is the join-width class of defect that
  // surfaces three nodes later — so the authority that the field re-entry and the map assembly read is
  // also the authority the builder emits against.
  const cols = framingCols({ kind: 'record', fields });
  if (!cols) return null;
  const payload = cols.map((column) => {
    const expr = exprs.get(column.name);
    if (!expr) throw new Error(`RelIR lowering: record field column ${column.name} has no expression`);
    return [column.name, expr] as const;
  });
  return {
    rel: make.project({
      id: fresh('rc'), input, channels: input.channels,
      type: typeOf(...cols, ...carriedCols(input.channels)),
      exprs: [...payload, ...input.channels.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
    }),
    fields,
  };
}

/**
 * HOW A RECORD'S PAYLOAD IS READ, by the canonical column name `framingCols` declares.
 *
 * The map assembly below is written against this and not against a `Rel`, because the record has two
 * physical forms and only one meaning. A record RELATION holds its payload in prefixed columns, so the
 * read is `col(rel, …)`. A record built inside a `by()` — `group().by(__.project('o','l','i'))` — never
 * becomes a relation at all: each field is a correlated EXPRESSION over the host traverser, and there
 * is no row to name. Spelling the assembly twice would be two chances to disagree about the one thing
 * a record's map form must get right (which key is omitted when, and in what order), so it is spelled
 * once over the accessor and each caller supplies its own reader.
 */
type FieldRead = (column: string) => Expr;

/** A record RELATION's reader — the prefixed columns, at whatever nesting depth `at` names. */
const readingRel = (rel: Rel, at: string): FieldRead => (column) => col(rel.id, qualify(at, column));

/** Is this field PRESENT on this row? The first payload column answers it for every shape — a rowid
 *  for an element, `v` for a value, `list`/`map` for a collection — which is the same convention
 *  `aliasPresent` reads and the reason a field's columns are declared nullable. */
function presence(read: FieldRead, field: RecordField): Expr | null {
  const cols = framingCols(field.framing);
  const first = cols?.[0];
  if (!first) return null;
  return { kind: 'binary', op: 'is not', left: read(fieldCol(field.prefix, first.name)), right: compilerNull() };
}

/**
 * ONE FIELD as a self-describing `{t,v}` node — the map value's side, or `null` to decline.
 *
 * TOTAL over `RelFraming`, so a shape that becomes reachable as a field is a compile error here until
 * its member encoding is declared. The declines are not omissions: a LIST field would need the list
 * module's member encoding (`ListOf`) threaded to this position, and no `by()` can produce one yet
 * (`byField`'s arms are element/value only), so the arm arrives with its producer rather than being
 * guessed at now.
 */
function fieldNode(read: FieldRead, field: RecordField, fresh: Minter): Expr | null {
  const own = (name: string): Expr => read(fieldCol(field.prefix, name));
  const framing = field.framing;
  switch (framing.kind) {
    // A VARIANT field would be a mixed branch inside a `project()` slot. `byField` cannot produce one
    // (its arms are element/value only) and `framingCols` declines a variant outright, so this is
    // unreachable rather than a gap — stated so the switch stays TOTAL, which is what makes the next
    // framing arm a compile error here instead of a silent fallthrough.
    case 'variant': return null;
    case 'elements': return elementNode(own('id'), framing.elem, fresh);
    case 'scalar': {
      // The tag rides where the type does: a numeric reducer's is the aggregate's runtime `typeof` in
      // `vt`, a stored value's is its `vtype` column, a cast's is one compile-time token, and an
      // unknown type is a NULL tag the framer reads as "infer from the value".
      const tag = framing.result === 'number' ? own('vt')
        : framing.type.kind === 'perRow' ? own(perRowColumn(framing.type, 'recordValue'))
          : framing.type.kind === 'static' ? compilerText(framing.type.type)
            : compilerNull('text');
      return typedNode(own('v'), tag);
    }
    case 'record': {
      // A NESTED record composes the accessor rather than a prefix string: its own fields' columns sit
      // under `<this field's prefix>_<inner prefix>_<name>`, which is exactly `framingCols`' recursive
      // arm, so composing the read is the same rule read from the other end.
      const nested = recordPairs((column) => own(column), framing.fields, fresh);
      return nested && mapNode(nested);
    }
    // A MAP field is a record that has ALREADY spent its fields — `by(__.project(…))` inside a
    // `project()` slot, or a map-valued child. Its column holds the pairs array, so the member is that
    // array under the same envelope the record arm above adds. One encoding, two producers.
    case 'map': return mapNode(own('map'));
    case 'list': case 'path': case 'mapEntry': case 'property': case 'discard': return null;
  }
}

/**
 * THE RECORD AS A MAP VALUE — `[[key, valueNode], …]`, or `null` to decline.
 *
 * An OPTIONAL field is appended conditionally rather than emitted as a null entry, because the two are
 * observably different maps: TinkerPop's `project()` omits the key, and a `[key, null]` entry is what a
 * PRODUCTIVE null looks like under `ProductiveByStrategy`. `json_insert(acc, '$[#]', …)` appends, and
 * SQLite carries the JSON subtype through it, so the pair goes in as JSON rather than as a quoted
 * string — the same trap `mapOfGroups`' `json()` wrapping documents.
 *
 * Where NO field is optional — every `by()` a token or the traverser itself, or the whole step under
 * `ProductiveByStrategy` — the accumulator collapses to a single `json_array(…)` and the `CASE` chain
 * costs nothing.
 */
function recordPairs(read: FieldRead, fields: readonly RecordField[], fresh: Minter): Expr | null {
  const pairs: { readonly pair: Expr; readonly present: Expr | null }[] = [];
  for (const field of fields) {
    const node = fieldNode(read, field, fresh);
    if (!node) return null;
    const present = field.optional ? presence(read, field) : null;
    if (field.optional && !present) return null;
    // The KEY is a bare string, not a `{t,v}` node: `frameTypedNode` reads a non-object member as an
    // inferred value, which for a project key is exactly the String it must be. Tagging it would be a
    // second encoding of the one thing about a record that is never in question.
    pairs.push({ pair: { kind: 'json-array', items: [compilerText(field.key), node], binary: false }, present });
  }
  if (pairs.every((entry) => !entry.present))
    return { kind: 'json-array', items: pairs.map((entry) => entry.pair), binary: false };
  let acc: Expr = EMPTY_ARRAY;
  for (const { pair, present } of pairs) {
    const appended: Expr = { kind: 'call', fn: 'json_insert', args: [acc, compilerText('$[#]'), pair] };
    acc = present ? { kind: 'case', whens: [[present, appended]], else: acc } : appended;
  }
  return acc;
}

/** The record relation with its fields COLLAPSED into the one `map` column the map vocabulary reads —
 *  channels intact, because the caller still has to sort by the emission order. */
export function recordToMap(rel: Rel, fields: readonly RecordField[], fresh: Minter): Rel | null {
  const value = recordPairs(readingRel(rel, ''), fields, fresh);
  return value && make.project({
    id: fresh('rm'), input: rel, channels: rel.channels,
    type: typeOf(meta(MAP_COL, 'json', true), ...carriedCols(rel.channels)),
    // `jsonb()` for `mapOfGroups`' reason: the column is the relational JSONB form and `mapPayload`'s
    // `json()` is what turns it back into the text the framer parses.
    exprs: [[MAP_COL, { kind: 'call', fn: 'jsonb', args: [value] }],
      ...rel.channels.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
  });
}

/** THE RECORD PAYLOAD — the record collapsed to a map value and framed as one. It reaches the wire
 *  through `mapPayload` rather than through a projection of its own, because by that point the two
 *  shapes ARE one: a `mapValue` row is a `map` JSONB column, and a record that has spent its fields is
 *  exactly that. */
export function recordPayload(
  rel: Rel, fields: readonly RecordField[], fresh: Minter,
): { readonly rel: Rel; readonly shape: Shape } | null {
  const mapped = recordToMap(rel, fields, fresh);
  return mapped && mapPayload(mapped, fresh);
}

/**
 * ONE FIELD, RE-ENTERED AS A STREAM OF ITS OWN SHAPE — `project('a','b').select('a')`.
 *
 * The rename is `framingCols` applied in reverse: the field's prefixed columns come back under their
 * canonical names and whichever tail loop owns `field.framing` takes the rest of the chain, exactly as
 * `selectOne` hands an alias read to `continueAs`. That is the whole payoff of keeping a record's
 * fields as columns — there is no decoding step and no shape to re-derive.
 *
 * An ABSENT field DROPS the traverser, which is `select()`'s rule everywhere: a key that is not in the
 * map has no value to emit, and TinkerPop's `SelectOneStep` filters rather than raising
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java`
 * — an unproductive scope value yields no traverser). A field that cannot be absent needs no filter.
 */
export function recordField(
  rel: Rel, field: RecordField, fresh: Minter,
): { readonly rel: Rel; readonly framing: RelFraming } | null {
  const cols = framingCols(field.framing);
  if (!cols) return null;
  const present = field.optional ? presence(readingRel(rel, ''), field) : null;
  if (field.optional && !present) return null;
  const source = present
    ? make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: present })
    : rel;
  // `framingCols` already names the CANONICAL columns; the record relation holds them under the
  // field's prefix, so the rename is that one composition applied in reverse. The nullability stays
  // whatever the field carried: after the presence filter the first column is in fact non-null, and
  // saying so buys nothing while claiming it wrongly is a checker violation.
  return {
    rel: make.project({
      id: fresh('rf'), input: source, channels: source.channels,
      type: typeOf(...cols, ...carriedCols(source.channels)),
      exprs: [...cols.map((column) => [column.name, col(source.id, fieldCol(field.prefix, column.name))] as const),
        ...source.channels.map((channel) => [channel.col, col(source.id, channel.col)] as const)],
    }),
    framing: field.framing,
  };
}

/**
 * `select(keys…)` AT EVERY ARITY — ONE lowering, because it is one question asked N times.
 *
 * TinkerPop splits it across two step classes (`SelectOneStep` and `SelectStep`) and the split is real
 * but SMALL: read each label's history at the `Pop` the call names, apply the `by()` ring to what came
 * back, and package the results — as the value itself for one key, as a RECORD for several. Writing
 * that twice is how a modulated `select('a').by('name')` ends up supported and `select('a','b')
 * .by('name')` does not, which is exactly where this route was.
 *
 * **A MISSING KEY DROPS THE TRAVERSER — every key, at every arity, and this is the asymmetry with
 * `project()`.** `SelectStep` breaks out of the key loop and returns `EmptyTraverser` when a `by()` is
 * unproductive, and catches `KeyNotFoundException` to the same answer
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectStep.java:74-84`),
 * where `ProjectStep` omits the key and keeps the traverser. So the drops are a CONJUNCTION applied
 * once to the input, and every field is `optional: false` by the time the record exists.
 *
 * The `by()` ring applies to the SELECTED value, not to the current traverser — which is what makes
 * `select('a','b').by('name')` two property reads off two different elements. `byField` is handed a
 * host built from the alias payload for exactly that reason.
 */
export function selectKeys(
  step: IRStep, rel: Rel, aliases: AliasMap, child: ChildSeam, fresh: Minter,
  host?: { readonly framing: RelFraming; readonly named: (label: string) => boolean },
): { readonly rel: Rel; readonly framing: RelFraming } | null {
  const spec = selectSpec(step);
  if (!spec) return null;
  const bys = modulations(step, spec.labels.length, child);
  if (!bys) return null;

  /**
   * AN UNRESOLVABLE KEY IS THE EMPTY RESULT, NOT A DECLINE — `Select.feature:578-596` pins
   * `g.V().select("a")` as empty and its `count()` as `0`. It follows from the same rule the header
   * states: `getScopeValue` throws `KeyNotFoundException` for a key that is in no scope, `SelectStep`
   * catches it to `EmptyTraverser`, and a drop applied to EVERY key is a conjunction over the input —
   * so ONE unresolvable key empties the stream whatever the others do.
   *
   * `named` is the caller's answer for the scopes this record builder cannot see: `getScopeValue` tries
   * the traverser's SIDE EFFECTS before the path labels, so a `withSideEffect` constant or a named
   * collection resolves where no `as()` bound anything, and treating those as empty would be a wrong
   * answer rather than a conservative one. A caller that does not pass a host keeps the old DECLINE,
   * which is why this is optional rather than a behaviour change at four call sites at once.
   */
  if (host && spec.labels.some((label) => !liveAliases(aliases, rel).has(label) && !host.named(label)))
    return {
      // §3.3's spelling of the empty relation: `Values` refuses to express one, so it is a false
      // `Filter` — and the framing is the HOST's, because a stream with no rows has no shape of its
      // own and inventing one would be a claim no row can support. `pathTail`'s non-matching `typeOf`
      // says the same thing the same way.
      rel: make.filter({ id: fresh('se'), input: rel, channels: rel.channels, type: rel.type, pred: eq(compilerInt(0), compilerInt(1)) }),
      framing: host.framing,
    };

  const fields: RecordField[] = [];
  const exprs = new Map<string, Expr>();
  const single: (readonly [ColMeta, Expr])[] = [];
  /** The columns whose NULL drops the traverser, named after the projection exists. */
  const required: string[] = [];
  const bound: string[] = [];

  for (const [index, label] of spec.labels.entries()) {
    const projected = aliasProjection(rel, aliases, label, spec.pop);
    if (!projected) return null;
    const payload = new Map(projected.payload.map(([column, expr]) => [column.name, expr] as const));
    if (aliasGuard(rel, projected.entry)) bound.push(projected.entry.col);
    const framing = readFraming(projected.read);
    const by = bys.length ? bys[index % bys.length]! : { key: { kind: 'identity' } as const };
    const built = byField(step, by, selectedHost(projected.read, payload, rel, aliases), framing,
      (name) => payload.get(name) ?? compilerNull(), fresh, child);
    if (!built) return null;
    const prefix = prefixAt(index);
    const only = spec.labels.length === 1;
    const cols = framingCols(built.framing);
    if (!cols) return null;
    for (const column of cols) {
      const expr = built.exprs.find(([name]) => name === column.name)?.[1];
      if (!expr) return null;
      const name = only ? column.name : fieldCol(prefix, column.name);
      if (only) single.push([column, expr]); else exprs.set(name, expr);
    }
    // The by()'s own productivity is a DROP, not an omission — named by the field's FIRST column,
    // which every shape has (a rowid, `v`, `list`, `map`).
    if (built.optional) required.push(only ? cols[0]!.name : fieldCol(prefix, cols[0]!.name));
    fields.push({ key: label, prefix, framing: built.framing, optional: false });
  }

  // ONE key is not a record: `SelectOneStep` yields the value itself, so the payload lands under its
  // canonical names and whichever tail loop owns that shape takes the rest of the chain.
  const framing: RelFraming = spec.labels.length === 1 ? fields[0]!.framing : { kind: 'record', fields };
  let payload = single;
  if (spec.labels.length > 1) {
    const cols = framingCols(framing);
    if (!cols) return null;
    payload = cols.map((column) => {
      const expr = exprs.get(column.name);
      if (!expr) throw new Error(`RelIR lowering: select field column ${column.name} has no expression`);
      return [column, expr] as const;
    });
  }
  const projected = readProjection(rel, payload, fresh);
  const guards = [
    ...bound.map((column) => aliasPresent(col(projected.id, column))),
    ...required.map((column) => ({ kind: 'binary', op: 'is not', left: col(projected.id, column), right: compilerNull() }) as Expr),
  ];
  const guard = guards.reduce<Expr | undefined>((left, right) => (left ? and(left, right) : right), undefined);
  return {
    rel: guard
      ? make.filter({ id: fresh('sf'), input: projected, channels: projected.channels, type: projected.type, pred: guard })
      : projected,
    framing,
  };
}

/**
 * The `by()` host for a SELECTED value — the label's own payload, not the current traverser.
 *
 * `null` for a LIST label, which has no `ChildHost` arm at all: a bare `by()` over one still works
 * (identity reads the host FRAMING's columns, which `byField` takes separately), and a property or
 * child `by()` over a collection declines, which is the honest answer until the by() vocabulary grows
 * a list host.
 */
function selectedHost(read: AliasRead, payload: ReadonlyMap<string, Expr>, rel: Rel, aliases: AliasMap): ChildHost | null {
  if (read.kind === 'element') return { kind: 'element', id: payload.get('id')!, elem: read.elem, row: { rel, aliases } };
  if (read.kind === 'list') return null;
  const vtype = payload.get('vtype');
  return { kind: 'scalar', value: payload.get('v')!, row: { rel, aliases }, ...(vtype ? { vtype } : {}) };
}
