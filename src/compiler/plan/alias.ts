import { q, value, empty, type Expression } from '../../sql/kernel/q.ts';
import { type Elem } from './plan.ts';
import { PER_ROW, PER_ROW_ENVELOPE, sameScalarType, UNKNOWN, type ListOf, type ScalarType } from '../../sql/kernel/render.ts';

// ---------- as() label encoding: per-traverser path history ----------
//
// A label's carried column (a0,a1,…) holds a JSONB ARRAY of tagged entries in
// binding order (array-ALWAYS, even for a single binding). Each entry is a small
// tagged object so a label can hold — and accumulate across rebindings — values of
// ANY shape (vertex/edge/scalar/list/map), possibly heterogeneous. This is exactly
// TinkerPop's Path label history: as() APPENDS the current object; select(Pop,…)
// reads first/last/all/mixed off the array. See docs/archive/2026-07-16-labels-as-path-history.md.
//
//   k=0 node   {"k":0,"v":<rowid>}
//   k=1 edge   {"k":1,"v":<rowid>}
//   k=2 value  {"k":2,"v":<scalar>[, "t":<ValueType tag>]}
//   k=3 list   {"k":3,"v":<json array>}
//   k=4 map    {"k":4,"v":<json object>}

export type AliasShape = 'vertex' | 'edge' | 'value' | 'list' | 'map' | 'property';

/** The `k` tag each shape rides under. EXPORTED because it is DATA rather than emission: the RelIR
 *  spine writes the same history entries (`src/compiler/rel/alias.ts`) and a second copy of these
 *  numbers would be a second chance for the two encodings to drift apart silently — the same reason
 *  `STORAGE_CLASS`/`JAVA_WHITESPACE` are shared rather than re-derived (build plan §10·8). */
export const SHAPE_K: Record<AliasShape, number> = { vertex: 0, edge: 1, value: 2, list: 3, map: 4, property: 5 };
const K_SHAPE: Record<number, AliasShape> = { 0: 'vertex', 1: 'edge', 2: 'value', 3: 'list', 4: 'map', 5: 'property' };

// Elem ⊂ AliasShape now that both spell an element the same way — these were two ternaries
// bridging a gratuitous spelling difference.
export const elemShape = (elem: Elem): AliasShape => elem;
export const shapeElem = (shape: AliasShape): Elem => (shape === 'edge' ? 'edge' : 'vertex');
export const isElementShape = (shape: AliasShape): boolean => shape === 'vertex' || shape === 'edge';

/** One tagged history entry `jsonb_object('k',<k>,'v',<value>[,'t',<type>])`. An
 *  element entry's value is its rowid; a value entry may carry a ValueType tag `t`
 *  so a numeric/date label reframes correctly on the way out. A list/map entry wraps
 *  a JSON structure via json() so SQLite stores it AS json (not a quoted string). */
/** `typeTag` may be a compile-time tag or a per-row SQL expression. This is the
 * history boundary where a ScalarType.perRow column stops being a relation column
 * and becomes a self-describing entry field. */
export function aliasEntry(shape: AliasShape, valueExpr: Expression, typeTag?: string | Expression | null): Expression {
  const k = SHAPE_K[shape];
  const val = shape === 'list' || shape === 'map' || shape === 'property' ? q`json(${valueExpr})` : valueExpr;
  const t = typeTag ? q`, 't', ${typeof typeTag === 'string' ? value(typeTag) : typeTag}` : empty;
  return q`jsonb_object('k', ${value(k)}, 'v', ${val}${t})`;
}

export const nodeEntry = (idExpr: Expression): Expression => aliasEntry('vertex', idExpr);
export const edgeEntry = (idExpr: Expression): Expression => aliasEntry('edge', idExpr);
export const elemEntry = (elem: Elem, idExpr: Expression): Expression => aliasEntry(elemShape(elem), idExpr);

/** A brand-new label's column value: a one-element history array. */
export const aliasSeed = (entry: Expression): Expression => q`jsonb_array(${entry})`;

/** Append an entry onto an existing label column (rebind). A row where the label was
 *  never bound (NULL — e.g. a branch arm that didn't bind it) starts a fresh array,
 *  so append is total. */
export const aliasAppend = (prevCol: Expression, entry: Expression): Expression =>
  q`CASE WHEN ${prevCol} IS NULL THEN jsonb_array(${entry}) ELSE jsonb_insert(${prevCol}, '$[#]', ${entry}) END`;

/** The Pop-resolved slice of a label column: ONE entry (first/last) or the whole
 *  array (all always; mixed when >1 binding). `mixed` with a single binding is that
 *  lone entry — matching TinkerPop's "singleton unwrapped, else List". */
export function aliasPop(col: Expression, pop: string): Expression {
  switch (pop) {
    case 'first': return q`${col} -> '$[0]'`;
    case 'all': return col;
    case 'mixed': return q`CASE WHEN json_array_length(${col}) = 1 THEN ${col} -> '$[0]' ELSE ${col} END`;
    case 'last':
    default: return q`${col} -> '$[#-1]'`;
  }
}

/** True iff `pop` always yields a List value (only Pop.all; mixed is data-dependent
 *  and handled by aliasPop's CASE, so it is NOT statically a list). */
export const popIsList = (pop: string): boolean => pop === 'all';

/** The rowid held by an element label, by Pop position. Used to re-root movement /
 *  join / compare on the label without materialising the element. */
export function aliasId(col: Expression, pop: string = 'last'): Expression {
  const path = pop === 'first' ? '$[0].v' : '$[#-1].v';
  return q`CAST(${col} ->> ${value(path)} AS INTEGER)`;
}

/** The scalar value held by a value label, by Pop position (text/number as stored). */
export function aliasScalar(col: Expression, pop: string = 'last'): Expression {
  const path = pop === 'first' ? '$[0].v' : '$[#-1].v';
  return q`${col} ->> ${value(path)}`;
}

/** Extract from a single resolved ENTRY object (the output of aliasPop first/last/mixed-single). */
export const entryId = (entry: Expression): Expression => q`CAST(${entry} ->> '$.v' AS INTEGER)`;
export const entryScalar = (entry: Expression): Expression => q`${entry} ->> '$.v'`;
export const entryKind = (entry: Expression): Expression => q`${entry} ->> '$.k'`;
export const entryTypeTag = (entry: Expression): Expression => q`${entry} ->> '$.t'`;
export const kindShape = (k: number): AliasShape => K_SHAPE[k];

/** Drop-not-throw guard: keep a traverser only where the label is actually bound on
 *  its path (a non-empty history). An unbound label filters the row (empty result),
 *  never an error — matching select() semantics for a never-seen label. */
export const aliasPresent = (col: Expression): Expression =>
  q`${col} IS NOT NULL AND json_array_length(${col}) > 0`;

// ---------- the same channel's COMPILE-TIME description ----------
//
// Above is what a label's history looks like IN THE DATABASE. Below is what the compiler knows about
// it while building a plan: which column holds it, which shapes it has held, what type its scalar
// bindings carry. The two belong together for the reason `SHAPE_K` is shared rather than copied — a
// second spelling of either is a second chance for the two to drift, and here they would drift
// SILENTLY, since a wrong compile-time summary produces valid SQL against a correct encoding.
//
// It used to live in `steps/context/context.ts`, beside `LoweringState` and `TraverserLayout`. That
// made it look like legacy's object model, which it never was: `rel/alias.ts` builds and reads the
// same entries, and its own header records why ("the shared type stays because select() re-entry
// still needs the same entry shape the legacy host reads"). The build plan's Phase 0 proposed giving
// `rel/` its own alias types instead; that predates §10·10 removing the TraverserLayout bridge, and
// it would have bought a second encoding to keep in step. One home, no bridge.

/** Bound as() labels: label → its carried column (a0, a1, … — user strings never
 *  enter SQL identifiers) + the SET of shapes the label has held across its bindings
 *  (a label's history can be heterogeneous, e.g. [vertex, string]). The column holds
 *  a JSONB history array (see src/compiler/steps/context/alias.ts); `shapes` is the compile-time
 *  summary a consumer uses to decide framing (homogeneous element → fast concrete
 *  path; heterogeneous/list → variant). */
export type AliasEntry = {
  col: string;
  shapes: ReadonlySet<AliasShape>;
  /** The scalar type channel after it has crossed into JSON history. A per-row
   * stream no longer has its original relation column, so it is represented by
   * the entry's own `t` field and restored into a fresh `vtype` column on select. */
  scalarType?: ScalarType;
  /** Member descriptor for a list value held in history. This is deliberately
   * alias-local: it says how to re-enter THIS JSON list, not what a Stream is. */
  listOf?: ListOf;
  /** Compile-time binding count along the traverser's path: 1 for a once-bound label,
   *  >1 after rebinds. `undefined` = dynamic depth (bound inside repeat()/a branch arm),
   *  where the count is only known at runtime and Pop must resolve via SQL. Lets Pop.all/
   *  mixed/first/last resolve statically for the common linear case. */
  binds?: number;
  /** Linear path position index this label attached to (the current element's position
   *  at bind time — `path.cols.length - 1`). Set only while path tracking is active on a
   *  linear chain, so path().from(l)/to(l) can resolve a label to a static position slice.
   *  A rebind overwrites with the latest; `undefined` = no path / dynamic position. */
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
 *
 * What the coarsening COST, and it is the same loss the list members had: `static` dropped `text`, so
 * a big long carried as decimal TEXT went through `as('a')`/`select('a')` and came back a plain
 * static `long` — the flag that says "cast this before comparing it" gone, which is the defect the
 * local reducers had from the other direction.
 */
export const aliasScalarTypeOf = (type: ScalarType): ScalarType =>
  type.kind === 'perRow' ? PER_ROW_ENVELOPE : type;

/** Restore an alias history type onto a scalar relation. The carrier MOVES: inside the history the
 *  type rides in the entry's `t`, and on the way out it becomes a column of the NEW projection (never
 *  the source relation's vanished one). `static`/`unknown` cross unchanged, `text` flag included. */
export const scalarTypeFromAlias = (type: ScalarType | undefined, vtype = 'vtype'): ScalarType =>
  type === undefined ? UNKNOWN : type.kind === 'perRow' ? PER_ROW(vtype) : type;

/** Merge the scalar types of several bindings of one label — the alias channel's own join, used
 *  when a branch merge unions arms that bound the same label differently. `sameScalarType` is the
 *  authority, so two `long`s that disagree about `text` no longer read as agreeing. */
export const mergeAliasScalarTypes = (types: readonly (ScalarType | undefined)[]): ScalarType | undefined => {
  const present = types.filter((type): type is ScalarType => type !== undefined);
  if (!present.length) return undefined;
  if (present.every((type) => sameScalarType(type, present[0]!))) return present[0];
  // Differing tags are all faithfully represented by the JSON entry's own `t`, so the merged label is
  // self-describing rather than untyped — a selected relation exposes that per-row channel.
  return PER_ROW_ENVELOPE;
};

/** The element kind of a homogeneously-element label (node/edge). Throws if the
 *  label is a value/list/map or a mixed-shape history — callers that need a single
 *  element kind must have already established the label is element-homogeneous. */
export function aliasElem(entry: AliasEntry): Elem {
  if (entry.shapes.size !== 1) throw new Error('alias with mixed-shape history has no single element kind');
  const [s] = entry.shapes;
  if (s !== 'vertex' && s !== 'edge') throw new Error(`alias holds a ${s}, not an element`);
  return s;
}

/** True iff every binding of the label is the same element kind (node XOR edge). */
export const aliasIsElement = (entry: AliasEntry): boolean =>
  entry.shapes.size === 1 && (entry.shapes.has('vertex') || entry.shapes.has('edge'));

/** Merge a shape into a label's shape set (rebind may add a new shape). */
export const withShape = (prev: ReadonlySet<AliasShape> | undefined, shape: AliasShape): Set<AliasShape> =>
  new Set([...(prev ?? []), shape]);
