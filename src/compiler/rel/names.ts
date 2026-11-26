/**
 * THE NAME DICTIONARIES — the one authority for how the RelIR reads and writes an interned NAME.
 *
 * A label is stored as a rowid into the `labels` table, a set of names under a `UNIQUE (name)` index.
 * Every step that names a label goes through that indirection: a read filters `labels` by name and joins
 * the ids (`nameIds`), a creation upserts its names and gets the ids back (`internNames`), and an output
 * decodes an id back to its name (`nameOf` for one id, `withNames` for a relation of ids). Each name
 * resolves INSIDE the statement, through the index — the compile never reads the store, so a plan is a
 * function of the query text alone, and a name that was never interned is an empty set, not an error.
 * The ids an ELEMENT carries are one `(owner, label)` relation for both kinds (`labelOwners`).
 *
 * This is a `BaseGraph` storage detail. It stays out of the `Source` interface (`source.ts`): a bound
 * or landed graph carries its labels as JSON name arrays, not as ids.
 */
import { col, compilerText, disjoin, param, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { insert } from '../../rel/stmt-factory.ts';
import type { Stmt } from '../../rel/stmt.ts';
import { EXCLUDED } from '../../rel/types.ts';
import type { Arg } from '../../gremlin/frontend.ts';
import { eq, jsonEachSet, LABEL_OWNERS, meta, typeOf, type Minter } from './build.ts';
import type { Elem } from '../elem.ts';

/** A name dictionary: a table of `(id, name)` rows under a unique name. Labels are the only one today. */
export type NameDict = 'labels';

/**
 * A scan of a name dictionary, as its `(id, name)` rows. PRIVATE on purpose: every read and write of a
 * dictionary goes through the functions below, so no caller outside this file reads `labels` directly.
 */
const dictScan = (dict: NameDict, fresh: Minter): Extract<Rel, { readonly kind: 'scan' }> =>
  make.scan({ id: fresh('lbl'), table: dict, alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });

/**
 * The ids of a set of NAMES in `dict` — the filter each label-restricting step (`hasLabel`, `out('knows')`,
 * `has(label, k, v)`, `dropLabel('x')`) joins against.
 *
 * The names are either label ARGUMENTS or a compile-time list. An inline argument (a parsed literal
 * `'knows'`) and a compile-time name INLINE as a `compilerText` — zero binds. A label PARAMETER BINDS: a
 * scalar `$l` as one `?` on the name, a bound list `$ls` as ONE `jsonb(?)` exploded by `json_each`. So a
 * parameter's data never enters the statement text, the same rule the id and `within` set paths keep.
 * Callers pre-validate arguments with `labelArgsAllStrings`, so every value here is text.
 */
export function nameIds(dict: NameDict, names: readonly Arg[] | readonly string[], fresh: Minter): Rel {
  const scan = dictScan(dict, fresh);
  const nameCol = col(scan.id, 'name');
  const inline: string[] = [];
  const clauses: Expr[] = [];
  for (const a of names) {
    if (typeof a === 'string') {
      inline.push(a);
    } else if (a.name == null) {
      const members = a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value];
      for (const v of members) inline.push(v as string);
    } else if (Array.isArray(a.value)) {
      clauses.push({ kind: 'in-query', expr: nameCol, plan: jsonEachSet(a.name, a.value, fresh), negated: false });
    } else {
      clauses.push({ kind: 'binary', op: '=', left: nameCol, right: param(a.value, a.name, 'text') });
    }
  }
  if (inline.length) clauses.unshift({ kind: 'in-list', expr: nameCol, values: inline.map(compilerText) });
  const pred = disjoin(clauses);
  const matching = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: pred! });
  return make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
}

/**
 * ONE id's name — the decode as a scalar, `(SELECT name FROM <dict> WHERE id = <id>)`. One INTEGER PRIMARY
 * KEY seek, correlated when `id` is an outer row's column (an edge's `label`). NULL for an id no row holds.
 */
export function nameOf(dict: NameDict, id: Expr, fresh: Minter): Expr {
  const names = dictScan(dict, fresh);
  const matching = make.filter({ id: fresh('f'), input: names, channels: [], type: names.type, pred: eq(col(names.id, 'id'), id) });
  const only = make.project({
    id: fresh('p'), input: matching, channels: [], type: typeOf(meta('name', 'text', true)),
    exprs: [['name', col(matching.id, 'name')]],
  });
  return { kind: 'scalar', plan: only };
}

/**
 * A relation's ids DECODED — `input` inner-joined to `dict` on its `idCol`, carrying `input`'s columns, then
 * `lid` (the dictionary id; a Join's declared names are positional and must be unique, so never a second
 * `id`) and `name`. Each row is one INTEGER PRIMARY KEY seek.
 *
 * The join condition is the decode and nothing else: a correlation on an owner goes BELOW it
 * (`labelOwners(kind, fresh, of)`), a test on the name ABOVE it (a Filter over the result). A row order
 * on the result is the caller's: the interning order is `lid` (equal to `idCol`), and that is what makes
 * `labels[0]` the first-interned label.
 */
export function withNames(dict: NameDict, input: Rel, idCol: string, fresh: Minter, { ordered }: { readonly ordered?: boolean } = {}): Rel {
  const names = dictScan(dict, fresh);
  return make.join({
    id: fresh('j'), left: input, right: names, join: 'inner', ...(ordered ? { ordered } : {}), channels: input.channels,
    type: typeOf(...input.type.cols, meta('lid', 'int'), meta('name', 'text')),
    on: eq(col(input.id, idCol), col(names.id, 'id')),
  });
}

/**
 * THE (owner, label) RELATION of an element kind — the one authority for where its label ids live
 * (`LABEL_OWNERS`): a vertex's `vertex_labels(node, label)` rows, an edge's own `(id, label)`. A Scan
 * names physical columns, so the owner column keeps its physical name, `LABEL_OWNERS[kind].owner`.
 * With `of`, only that owner's own rows — a seek on `vertex_labels`' PRIMARY KEY (node, label) or the
 * edge rowid.
 */
export function labelOwners(kind: Elem, fresh: Minter, of?: Expr): Rel {
  const { table, owner } = LABEL_OWNERS[kind];
  const scan = make.scan({
    id: fresh(kind === 'edge' ? 'el' : 'vl'), table, alias: fresh(kind === 'edge' ? 're' : 'rvl'), channels: [],
    type: typeOf(meta(owner, 'int'), meta('label', 'int')),
  });
  return of === undefined ? scan : make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: eq(col(scan.id, owner), of) });
}

/**
 * The id of ONE name in `dict`, as a scalar: `(SELECT id FROM <dict> WHERE name = <name>)`. One UNIQUE
 * seek, correlated when `name` reads a column (a merge driver's map label).
 *
 * The result is NULL for a name that was never interned. Use it ONLY in a positive `=` in an ON or WHERE
 * clause: there `x = NULL` is NULL, so the row drops, which is the correct "no such label" answer. Do NOT
 * use it under NOT or in a `<>`: `NOT (x = nameId(…))` is also NULL (SQLite three-valued logic), so that
 * row drops too, where the caller wants it kept.
 */
export function nameId(dict: NameDict, name: Expr, fresh: Minter): Expr {
  const scan = dictScan(dict, fresh);
  const named = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: eq(col(scan.id, 'name'), name) });
  return { kind: 'scalar', plan: make.project({ id: fresh('p'), input: named, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(named.id, 'id')]] }) };
}

/**
 * A creation's names as it WRITES them: the compile-time names (a constant creation, cross-joined onto
 * every new row), or the `(o, name)` relation that gives each traverser its own — a label ASSIGNMENT,
 * joined onto the new rows by position.
 */
export type CreationNames = readonly Expr[] | Rel;
export const isConstantNames = (names: CreationNames): names is readonly Expr[] => Array.isArray(names);

/**
 * THE NAME → ID INDIRECTION, as one statement — `GraphStore.labelId`'s idiom in the algebra.
 *
 * The dictionary is a SET, so `ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id` is
 * what returns the id whether the row was new or already there; `DO NOTHING` returns no row on the
 * existing case, which is why it is not that. It interns the WHOLE list in one statement, so the bind
 * count is a function of the query TEXT and not of anything the data decides.
 *
 * `null` for an EMPTY list, and that is a real state rather than a guard: under
 * `LabelCardinality.ZERO_OR_MORE` a bare `addV()` creates a vertex carrying none, and there is nothing
 * to intern — `Values` refuses the empty relation anyway (§3.3).
 *
 * Written once because every creation needs it (`addV`, `addE`, `addLabel`, `mergeE`'s create arm), and
 * each hand-rolled copy of an upsert whose `DO UPDATE` looks redundant is one more chance to write the
 * `DO NOTHING` that silently returns nothing.
 */
export function internNames(dict: NameDict, names: CreationNames, bind: (stmt: Stmt) => Rel, fresh: Minter): Rel | null {
  if (isConstantNames(names) && !names.length) return null;
  const target = dictScan(dict, fresh);
  const onConflict = { target: ['name'], set: [['name', col(EXCLUDED, 'name')] as const] };
  if (isConstantNames(names)) {
    return bind(insert({
      target, cols: ['name'],
      source: make.values({ id: fresh('lv'), channels: [], type: typeOf(meta('name', 'text')), rows: names.map((name) => [name]) }),
      channels: [], type: typeOf(meta('id', 'int')), onConflict, returning: [['id', col(target.id, 'id')]],
    }));
  }
  // An ASSIGNMENT interns its DISTINCT names, and returns each with its id — the relation the
  // per-traverser pairing joins on (`labelledByPosition`). `INSERT … SELECT … ON CONFLICT` needs the
  // emitter's `WHERE true`, which it supplies for every such source.
  const name = make.project({ id: fresh('p'), input: names, channels: [], type: typeOf(meta('name', 'text')), exprs: [['name', col(names.id, 'name')]] });
  return bind(insert({
    target, cols: ['name'], source: make.distinct({ id: fresh('d'), input: name, channels: [], type: name.type }),
    channels: [], type: target.type, onConflict,
    returning: [['id', col(target.id, 'id')], ['name', col(target.id, 'name')]],
  }));
}
