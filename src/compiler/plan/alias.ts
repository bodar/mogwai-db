import { q, value, empty, type Expression } from '../../sql/kernel/q.ts';
import { type Elem } from './plan.ts';

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
