import { col, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Shape } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/step.ts';
import { carriedCols, meta, typedNode, typeOf, EMPTY_ARRAY, type Minter } from './build.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { elementNode } from './element.ts';
import { fieldCol, framingCols, type RecordField, type RelFraming } from './framing.ts';
import { MAP_COL, mapPayload } from './map.ts';
import { byField, modulations } from './modulator.ts';

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
    const built = byField(step, by, host, hostFraming, (name) => col(input.id, name), fresh, child);
    if (!built) return null;
    const prefix = prefixAt(index);
    for (const [name, expr] of built.exprs) exprs.set(fieldCol(prefix, name), expr);
    fields.push({ key, prefix, framing: built.framing, optional: built.optional });
  }

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

/** Is this field PRESENT on this row? The first payload column answers it for every shape — a rowid
 *  for an element, `v` for a value, `list`/`map` for a collection — which is the same convention
 *  `aliasPresent` reads and the reason a field's columns are declared nullable. */
function presence(rel: Rel, field: RecordField, at: string): Expr | null {
  const cols = framingCols(field.framing);
  const first = cols?.[0];
  if (!first) return null;
  return {
    kind: 'binary', op: 'is not',
    left: col(rel.id, qualify(at, fieldCol(field.prefix, first.name))), right: compilerNull(),
  };
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
function fieldNode(rel: Rel, field: RecordField, at: string, fresh: Minter): Expr | null {
  const own = (name: string): Expr => col(rel.id, qualify(at, fieldCol(field.prefix, name)));
  const framing = field.framing;
  switch (framing.kind) {
    case 'elements': return elementNode(own('id'), framing.elem, fresh);
    case 'scalar': {
      // The tag rides where the type does: a numeric reducer's is the aggregate's runtime `typeof` in
      // `vt`, a stored value's is its `vtype` column, a cast's is one compile-time token, and an
      // unknown type is a NULL tag the framer reads as "infer from the value".
      const tag = framing.result === 'number' ? own('vt')
        : framing.type.kind === 'perRow' ? own(framing.type.column)
          : framing.type.kind === 'static' ? compilerText(framing.type.type)
            : compilerNull('text');
      return typedNode(own('v'), tag);
    }
    case 'record': {
      const nested = recordValue(rel, framing.fields, qualify(at, field.prefix), fresh);
      return nested && { kind: 'json-object', entries: [['t', compilerText('map')], ['v', nested]], binary: false };
    }
    case 'list': case 'path': case 'map': case 'property': case 'discard': return null;
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
function recordValue(rel: Rel, fields: readonly RecordField[], at: string, fresh: Minter): Expr | null {
  const pairs: { readonly pair: Expr; readonly present: Expr | null }[] = [];
  for (const field of fields) {
    const node = fieldNode(rel, field, at, fresh);
    if (!node) return null;
    const present = field.optional ? presence(rel, field, at) : null;
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
  const value = recordValue(rel, fields, '', fresh);
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
  return mapped && mapPayload(mapped, { kind: 'scalar' }, { kind: 'scalar' }, fresh);
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
  const present = field.optional ? presence(rel, field, '') : null;
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

/** A record's field by KEY, or `undefined` — the lookup `select(key)` needs, kept beside the builder so
 *  the key vocabulary has one owner. */
export const fieldNamed = (fields: readonly RecordField[], key: string): RecordField | undefined =>
  fields.find((field) => field.key === key);
