import type { Expr } from './expr.ts';
import { col, compilerInt } from './expr.ts';
import * as make from './factory.ts';
import type { Rel } from './rel.ts';
import type { ColMeta, RelId, SortTerm } from './types.ts';
import { forEachExpr, relExprs, substRelId } from './walk.ts';

type Minter = (hint: string) => RelId;

/**
 * ORDER BY THE POSITION'S KEYS, NOT BY ITS NUMBER — a relation whose emission-order column is a
 * `ROW_NUMBER() OVER (ORDER BY k…)` (`renumber`, `src/compiler/rel/build.ts`), re-expressed so a consumer that
 * only SORTS by that column sorts by `k…` instead, and the window that numbered it is gone.
 *
 * A row number is monotone in its order keys, so `ORDER BY rn` and `ORDER BY k…` put the rows in one order
 * (ties in `k…` aside, which the number broke arbitrarily anyway). A position minted over a position — a
 * hop numbered `(parent.encounter, edge.id)` — expands its parent's number into the parent's keys in place,
 * which is the lexicographic order the nested numbers stood for. What it buys is the cost of the number: a
 * window materializes and sorts its whole input, where a consumer that wants the FIRST row in that order
 * (`ORDER BY k… LIMIT 1`) is a top-1 sort SQLite runs without one — inside a correlated subquery, once per
 * host row, that is the difference between a sort per row and none (measured: `map(values('age'))` 29 → 6 ms
 * at 8k vertices). Calcite reasons the same way about a collation a `ROW_NUMBER` only re-encodes
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/metadata/RelMdCollation.java`, a `Window`'s
 * collation is its partition + order keys).
 *
 * The rewrite is along the PATH that defines the column: a pure-copy `Project`, a row-wise `Filter`/`Limit`/
 * `Sort`, a `Join` side, and the numbering `Window` itself. Each rebuilt node carries the key columns up
 * beside its own; the column itself becomes the constant 0, so ANY other reader of it would read a wrong
 * value — which is why every node on the path must not read it but to copy it, and the rewrite answers `null`
 * (the caller keeps sorting by the number) wherever one does, or wherever a node is not one of the above.
 */
type Keyed = { readonly rel: Rel; readonly keys: readonly SortTerm[] } | null;

/** MEMOIZED per (relation, column): a relation is immutable, so two consumers asking one position — a correlated
 *  first-row read's value and its presence `EXISTS` — get ONE rewritten relation, not two copies under fresh
 *  names that every later pass sees as different query blocks (the property seek narrows one, not the other). */
const positionMemo = new WeakMap<Rel, Map<string, Keyed>>();
export function positionKeys(r: Rel, name: string, fresh: Minter): Keyed {
  let known = positionMemo.get(r);
  if (!known) positionMemo.set(r, known = new Map());
  if (known.has(name)) return known.get(name)!;
  const answer = rewritePosition(r, name, fresh);
  known.set(name, answer);
  return answer;
}

function rewritePosition(r: Rel, name: string, fresh: Minter): Keyed {
  const readsCol = (e: Expr, rel: RelId, column: string): boolean => {
    let hit = false;
    forEachExpr(e, (node) => { if (node.kind === 'col' && node.rel === rel && node.name === column) hit = true; });
    return hit;
  };
  const extraCols = (keys: readonly SortTerm[], from: Rel): ColMeta[] =>
    keys.map((key) => from.type.cols.find((column) => key.expr.kind === 'col' && column.name === key.expr.name)!);
  const rekey = (keys: readonly SortTerm[], to: RelId): SortTerm[] =>
    keys.map((key) => ({ ...key, expr: col(to, (key.expr as Extract<Expr, { kind: 'col' }>).name) }));

  switch (r.kind) {
    case 'window': {
      if (r.specs.length !== 1) return null;
      const [minted, spec] = r.specs[0]!;
      if (minted !== name || spec.fn !== 'row_number' || spec.spec.partitionBy.length) return null;
      const input = r.input;
      // The keys, a nested position expanded into ITS keys; a constant term orders nothing and is dropped.
      let base = input;
      const terms: SortTerm[] = [];
      for (const term of spec.spec.orderBy) {
        if (term.expr.kind === 'lit') continue;
        const inner = term.expr.kind === 'col' && term.expr.rel === input.id && base === input
          && input.channels.some((channel) => channel.role === 'encounter' && channel.col === (term.expr as Extract<Expr, { kind: 'col' }>).name)
          ? positionKeys(input, term.expr.name, fresh) : null;
        if (inner && term.dir === 'asc') { base = inner.rel; terms.push(...inner.keys); continue; }
        terms.push(term);
      }
      if (!terms.length) return null;
      const id = fresh('pk');
      const named = terms.map(() => fresh('pkk') as string);
      const at = (e: Expr): Expr => (base === input ? e : substRelId(e, input.id, base.id));
      const rel = make.project({
        id, input: base, channels: r.channels,
        type: { cols: [...r.type.cols, ...named.map((n) => ({ name: n, type: 'any' as const, nullable: true }))] },
        exprs: [
          ...r.type.cols.map((column) => [column.name, column.name === name ? compilerInt(0) : col(base.id, column.name)] as const),
          ...terms.map((term, i) => [named[i]!, at(term.expr)] as const),
        ],
      });
      return { rel, keys: terms.map((term, i) => ({ ...term, expr: col(id, named[i]!) })) };
    }
    case 'project': {
      const own = r.exprs.find(([column]) => column === name)?.[1];
      if (!own || own.kind !== 'col' || own.rel !== r.input.id) return null;
      if (r.exprs.some(([column, e]) => column !== name && readsCol(e, r.input.id, own.name))) return null;
      const inner = positionKeys(r.input, own.name, fresh);
      if (!inner) return null;
      const id = fresh('pkp');
      const extras = extraCols(inner.keys, inner.rel);
      const rel = make.project({
        id, input: inner.rel, channels: r.channels, type: { cols: [...r.type.cols, ...extras] },
        exprs: [...r.exprs.map(([column, e]) => [column, substRelId(e, r.input.id, inner.rel.id)] as const),
          ...extras.map((column) => [column.name, col(inner.rel.id, column.name)] as const)],
      });
      return { rel, keys: rekey(inner.keys, id) };
    }
    case 'filter': case 'limit': case 'sort': {
      if (relExprs(r).some((e) => readsCol(e, r.input.id, name))) return null;
      const inner = positionKeys(r.input, name, fresh);
      if (!inner) return null;
      const id = fresh('pkf');
      const type = { cols: [...r.type.cols, ...extraCols(inner.keys, inner.rel)] };
      const base = { id, input: inner.rel, channels: r.channels, type };
      const at = (e: Expr): Expr => substRelId(e, r.input.id, inner.rel.id);
      const rel = r.kind === 'filter' ? make.filter({ ...base, pred: at(r.pred) })
        : r.kind === 'sort' ? make.sort({ ...base, terms: r.terms.map((term) => ({ ...term, expr: at(term.expr) })) })
          : make.limit({ ...base, ...(r.count ? { count: at(r.count) } : {}), ...(r.offset ? { offset: at(r.offset) } : {}) });
      return { rel, keys: rekey(inner.keys, id) };
    }
    case 'join': {
      if (r.on && (readsCol(r.on, r.left.id, name) || readsCol(r.on, r.right.id, name))) return null;
      const at = r.type.cols.findIndex((column) => column.name === name);
      const leftN = r.join === 'semi' || r.join === 'anti' ? r.type.cols.length : r.left.type.cols.length;
      if (at < 0) return null;
      const onLeft = at < leftN;
      const side = onLeft ? r.left : r.right;
      const sideName = side.type.cols[onLeft ? at : at - leftN]?.name;
      if (!sideName) return null;
      if (r.on && readsCol(r.on, side.id, sideName)) return null;
      const inner = positionKeys(side, sideName, fresh);
      if (!inner) return null;
      const extras = extraCols(inner.keys, inner.rel);
      const id = fresh('pkj');
      const left = onLeft ? inner.rel : r.left, right = onLeft ? r.right : inner.rel;
      // A join names its sides' columns BY POSITION, so the rebuilt side's columns are re-declared in the order
      // that side now has them: its own columns under this join's names, the key columns wherever the side put
      // them. A side that is itself a join inserts its keys after ITS left side, not at its end, and declaring
      // them at the end shifted every later name one column over (`both().both()`'s direction read its frontier's
      // position: a wrong vertex).
      let k = onLeft ? 0 : leftN;
      const extraNames = new Set(extras.map((column) => column.name));
      const sideCols = inner.rel.type.cols.map((column) => (extraNames.has(column.name) ? column : r.type.cols[k++]!));
      const cols = onLeft ? [...sideCols, ...r.type.cols.slice(k)] : [...r.type.cols.slice(0, leftN), ...sideCols];
      const on = r.on && substRelId(r.on, side.id, inner.rel.id);
      const rel = make.join({
        id, left, right, join: r.join, channels: r.channels, type: { cols },
        ...(on ? { on } : {}), ...(r.ordered ? { ordered: r.ordered } : {}),
      });
      return { rel, keys: rekey(inner.keys, id) };
    }
    default: return null;
  }
}
