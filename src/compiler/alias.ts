import { type Elem } from './elem.ts';
import { PER_ROW_ENVELOPE, type ListOf, type ScalarType } from '../sql/kernel/render.ts';

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

/** Merge a shape into a label's shape set (rebind may add a new shape). */
export const withShape = (prev: ReadonlySet<AliasShape> | undefined, shape: AliasShape): Set<AliasShape> =>
  new Set([...(prev ?? []), shape]);
