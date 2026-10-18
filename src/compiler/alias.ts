import { type Elem } from './elem.ts';
import { PER_ROW_ENVELOPE, type ListOf, type MapOf, type ScalarType } from '../sql/kernel/render.ts';

// ---------- the as() alias channel — COMPILE-TIME description ----------
//
// What the compiler knows about an as() label while building a plan: which column holds its per-
// traverser history, which shapes it has held, what type its scalar bindings carry. The RUNTIME
// history encoding (the JSONB tagged-entry array a label's column holds, and the SQL that appends to /
// reads from it) lives with the lowering that writes it — `src/compiler/rel/alias.ts`. These types are
// the shared vocabulary both the lowering and its consumers speak; they are a leaf module (no heavy
// deps) precisely so they can be imported that widely without a cycle.
//
// `SHAPE_K` is DATA rather than emission, and shared for the same reason `JAVA_WHITESPACE` is: the
// RelIR spine writes history entries under these exact `k` tags, and a second copy of the numbers would
// be a second chance for the two encodings to drift apart silently (build plan §6·6).

export type AliasShape = 'vertex' | 'edge' | 'value' | 'list' | 'map' | 'property';

/** The `k` tag each shape rides under in a history entry. */
export const SHAPE_K: Record<AliasShape, number> = { vertex: 0, edge: 1, value: 2, list: 3, map: 4, property: 5 };

// Elem ⊂ AliasShape now that both spell an element the same way.
export const elemShape = (elem: Elem): AliasShape => elem;

/** Bound as() labels: label → its carried column (a0, a1, … — user strings never enter SQL
 *  identifiers) + the SET of shapes the label has held across its bindings (a label's history can be
 *  heterogeneous, e.g. [vertex, string]). The column holds a JSONB history array; `shapes` is the
 *  compile-time summary a consumer uses to decide framing (homogeneous element → fast concrete path;
 *  heterogeneous/list → variant). */
export type AliasEntry = {
  col: string;
  shapes: ReadonlySet<AliasShape>;
  /** The scalar type channel after it has crossed into JSON history. A per-row stream no longer has its
   *  original relation column, so it is represented by the entry's own `t` field and restored into a
   *  fresh `vtype` column on select. */
  scalarType?: ScalarType;
  /** Member descriptor for a list value held in history. Deliberately alias-local: it says how to
   *  re-enter THIS JSON list, not what a Stream is. */
  listOf?: ListOf;
  /** Key/value shape for a MAP value held in history — how to re-enter THIS map's pairs array
   *  (`mapTail`'s `keyOf`/`valOf`, plus the static `keys` where the producer knew them), the `listOf`
   *  analogue one collection along. `keys` lets a `select(m).select(k)` resolve `k` against the map's
   *  compile-time key set (the map-key-vs-alias precedence). */
  mapOf?: { readonly keyOf: MapOf; readonly valOf: MapOf; readonly keys?: readonly string[] };
  /** Compile-time binding count along the traverser's path: 1 for a once-bound label, >1 after rebinds.
   *  `undefined` = dynamic depth (bound inside repeat()/a branch arm), where the count is only known at
   *  runtime and Pop must resolve via SQL. Lets Pop.all/mixed/first/last resolve statically for the
   *  common linear case. */
  binds?: number;
  /** Linear path position index this label attached to (the current element's position at bind time —
   *  `path.cols.length - 1`). Set only while path tracking is active on a linear chain, so
   *  path().from(l)/to(l) can resolve a label to a static position slice. A rebind overwrites with the
   *  latest; `undefined` = no path / dynamic position. */
  pathPos?: number;
  /** Owner element kind when the label holds a PropertyStream payload. */
  propertyElem?: Elem;
};
export type AliasMap = ReadonlyMap<string, AliasEntry>;

/**
 * A LABEL'S SCALAR TYPE IS AN ORDINARY `ScalarType` — §6·7's LAST coarsening, retired.
 *
 * It used to be its own three-arm union (`static` without `text`, a column-less `perRow`, `unknown`),
 * invented because a history entry has no relation COLUMN to name: the type rides in the entry's own
 * `t` field. That reason was real and the separate vocabulary was not the answer to it — a value that
 * states its own type inside a JSON document is exactly `PER_ROW_ENVELOPE`, which is what the carrier
 * union now spells. So the alias channel joins the one vocabulary and stops being the last place a
 * scalar type is described in its own words.
 */
export const aliasScalarTypeOf = (type: ScalarType): ScalarType =>
  type.kind === 'perRow' ? PER_ROW_ENVELOPE : type;

/**
 * ONE JOIN FOR A LABEL'S COMPILE-TIME DESCRIPTION — what a history that holds BOTH sides' entries may
 * claim about all of them. The two callers are the two ways one label comes to hold entries from more
 * than one binding: a REBIND appends to the history (`as('a')…as('a')`, `bindAliases`), and a BRANCH
 * merge unions arms that may each have bound it (`remapArmAliases`). Both ask the same question, so they
 * share this answer rather than each spelling its own (the rebind used to OVERWRITE the descriptor with
 * the last binding's, and the branch merge used to keep the INCOMING one, so `inject(3.5d).as('a')
 * .constant(1).as('a').select(first,'a')` framed the Double as an Integer — `[3i]`).
 *
 * The reference keeps each OBJECT as it was bound: `select(Pop.first/all, 'a')` reads it back off the
 * `Path` unchanged (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java`
 * via `Scoping.getScopeValue` → `Path.get(Pop, label)`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/ImmutablePath.java`).
 * So where the bindings DISAGREE on a scalar class the authority is each ENTRY's own recorded `t`
 * (`objectEntry`, `rel/history.ts`) — `PER_ROW_ENVELOPE`, the type a value states inside its own JSON —
 * which every reader (`select` first/last/all/mixed, a `by()` slot, a `where`/`order`/`groupCount` key)
 * already honours. An entry with NO tag (an `unknown` binding) is read the way a lone `unknown` binding
 * is — its class inferred from its own value, by the framer (`execute.ts` `vtypeToValueType(null)`) and by
 * every key alike (`familyKey`, `rel/build.ts`) — so the per-entry read never asks an entry to speak
 * for another.
 *
 * THE INVARIANT readers rely on: a shape the label holds whose descriptor is absent (`list` without
 * `listOf`, `map` without `mapOf`; `value` without `scalarType` is the same rule, though a scalar join is
 * always total) is a CONFLICT, and every reader DECLINES on it. Absence is sticky by construction — a
 * side that holds the shape with no descriptor joins to none — so a later rebind cannot restore an
 * authority the history no longer has.
 */
export function joinAliasEntry(left: AliasEntry, right: AliasEntry): Omit<AliasEntry, 'col' | 'binds' | 'pathPos'> {
  const same = <T>(a: T | undefined, b: T | undefined): T | undefined =>
    a !== undefined && JSON.stringify(a) === JSON.stringify(b) ? a : undefined;
  const scalar = (a: ScalarType | undefined, b: ScalarType | undefined): ScalarType | undefined =>
    !a || !b ? undefined : JSON.stringify(a) === JSON.stringify(b) ? a : PER_ROW_ENVELOPE;
  /** One descriptor, keyed by the shape it describes: joined where both sides hold that shape, the
   *  holder's own where one does. */
  const field = <T>(shape: AliasShape, a: T | undefined, b: T | undefined, join: (a: T | undefined, b: T | undefined) => T | undefined): T | undefined =>
    left.shapes.has(shape) && right.shapes.has(shape) ? join(a, b)
      : left.shapes.has(shape) ? a : right.shapes.has(shape) ? b : undefined;
  const scalarType = field('value', left.scalarType, right.scalarType, scalar);
  const listOf = field('list', left.listOf, right.listOf, same);
  const mapOf = field('map', left.mapOf, right.mapOf, same);
  const propertyElem = field('property', left.propertyElem, right.propertyElem, same);
  return {
    shapes: new Set([...left.shapes, ...right.shapes]),
    ...(scalarType ? { scalarType } : {}),
    ...(listOf ? { listOf } : {}),
    ...(mapOf ? { mapOf } : {}),
    ...(propertyElem ? { propertyElem } : {}),
  };
}
