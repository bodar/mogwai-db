import { channelCols } from '../../channels.ts';
import type { Expr } from '../expr.ts';
import { aggregate, project } from '../factory.ts';
import { explodeColumns } from '../obligations.ts';
import type { Rel } from '../rel.ts';
import type { ColMeta, RelId } from '../types.ts';
import { forEachExpr, mapRelChildren, relChildren, relExprs } from '../walk.ts';

const refs = (expression: Expr, relation: RelId, out: Set<string>): void =>
  forEachExpr(expression, (e) => { if (e.kind === 'col' && e.rel === relation) out.add(e.name); });

const names = (cols: readonly ColMeta[]): readonly string[] => cols.map((column) => column.name);
/** The columns a child still emits after its own rebuild — the only honest way to learn what a
 *  parent must drop, since a Project is the only node that removes a column at source. */
const survived = (rebuilt: Rel): ReadonlySet<string> => new Set(names(rebuilt.type.cols));
const shrank = (original: Rel, rebuilt: Rel): boolean => original.type.cols.length !== rebuilt.type.cols.length;

/** The columns a node ADDS on top of its input's, which its input therefore cannot supply. */
const added = (r: Rel): readonly string[] =>
  r.kind === 'window' ? r.specs.map(([name]) => name)
    : r.kind === 'explode' ? explodeColumns(r.as)
      : [];

/**
 * Remove unobserved columns, everywhere the plan's own laws leave a defined answer.
 *
 * Two passes, because the plan is a DAG: a shared node has more than one consumer, and pruning it to
 * what ONE parent reads breaks the other. Pass 1 accumulates each node's need as the UNION over its
 * consumers, to a fixpoint; pass 2 rebuilds bottom-up through the sharing-preserving rewrite.
 *
 * **A `Project` is still the only node that removes a column at SOURCE** — every other kind's output
 * is a function of its input's, so it loses a column only by its child losing one first. What pass 2
 * does for those kinds is RETYPE: rebuild the node so its declared columns agree with the children it
 * actually has now. Without that a pruned `Project` under a `Join` is an immediate `check` failure
 * (the join declares a width its sides no longer have), which is why pruning below `Join`/`Union`/
 * `Aggregate` was the pass's declared remainder rather than an accident of where the walk stopped.
 *
 * ⚠️ **A node is retyped ONLY when a child actually shrank.** Pruning nothing must change nothing —
 * that property is what makes this safe to wire in front of an emitter whose SQL is snapshot-tested.
 *
 * Three laws the per-kind rules exist to keep, each of which is a wrong ANSWER rather than an error
 * if broken:
 *
 * - **A `groupBy` key is never dropped.** Removing one makes the grouping COARSER — a different
 *   answer with the right shape. Only `aggs` entries are prunable.
 * - **An `Aggregate` keeps at least one output.** A `Project` over a whole-relation `Aggregate`
 *   (empty `groupBy`) that reads none of its outputs ERASES the aggregation (§12, Calcite's
 *   `fieldsUsed.isEmpty()`), turning one row into N.
 * - **A channel is never pruned.** It is carried state, not an observed output, and dropping one is
 *   the largest defect category in this repo's history (§3.5).
 *
 * `Recursive` still requires every declared column: its `step` is a FUNCTION of `self`, so what the
 * body reads from the walk is only knowable by instantiating it, and the seed/step/header types must
 * move together. That fixpoint is its own increment.
 */
export function prune(plan: Rel, required: readonly string[] = plan.type.cols.map((col) => col.name)): Rel {
  const needs = new Map<Rel, Set<string>>();
  const queue: Rel[] = [];
  const require = (r: Rel, cols: Iterable<string>): void => {
    const need = needs.get(r) ?? new Set<string>();
    const before = need.size;
    for (const col of cols) need.add(col);
    if (!needs.has(r) || need.size !== before) { needs.set(r, need); queue.push(r); }
  };
  /** Unary kinds whose output IS their input's, extended at most by columns they mint themselves. */
  const preserves = (r: Rel): boolean =>
    r.kind === 'filter' || r.kind === 'sort' || r.kind === 'limit' || r.kind === 'distinct'
    || r.kind === 'window' || r.kind === 'explode' || r.kind === 'materialize';

  require(plan, required);
  while (queue.length) {
    const r = queue.pop()!;
    const need = new Set(needs.get(r));

    if (r.kind === 'project') {
      const keep = new Set([...need, ...channelCols(r.channels)]);
      const inputNeed = new Set(channelCols(r.input.channels));
      r.exprs.filter(([name]) => keep.has(name)).forEach(([, expression]) => refs(expression, r.input.id, inputNeed));
      require(r.input, inputNeed);
      continue;
    }

    if (r.kind === 'aggregate') {
      // The group keys are the leading outputs and are NOT optional; only the aggregates prune, and
      // never to zero.
      const keyCount = r.groupBy.length;
      const aggNames = names(r.type.cols).slice(keyCount);
      const wanted = aggNames.filter((name) => need.has(name));
      const keptAggs = wanted.length ? wanted : aggNames.slice(0, 1);
      const inputNeed = new Set(channelCols(r.input.channels));
      r.groupBy.forEach((e) => refs(e, r.input.id, inputNeed));
      r.aggs.filter(([name]) => keptAggs.includes(name)).forEach(([, e]) => refs(e, r.input.id, inputNeed));
      if (r.having) refs(r.having, r.input.id, inputNeed);
      require(r.input, inputNeed);
      continue;
    }

    if (r.kind === 'join') {
      // The output is the sides' columns POSITIONALLY, so a needed output name is a needed column of
      // whichever side owns that position. A semi/anti join emits the left side alone.
      const leftWidth = r.left.type.cols.length;
      const wants = (child: Rel, offset: number): Set<string> => {
        const out = new Set(channelCols(child.channels));
        names(r.type.cols).forEach((name, i) => {
          const local = child.type.cols[i - offset];
          if (need.has(name) && local && i - offset >= 0 && i - offset < child.type.cols.length) out.add(local.name);
        });
        relExprs(r).forEach((e) => refs(e, child.id, out));
        return out;
      };
      require(r.left, wants(r.left, 0));
      if (r.join !== 'semi' && r.join !== 'anti') require(r.right, wants(r.right, leftWidth));
      continue;
    }

    if (r.kind === 'union') {
      // Every input's columns are IDENTICAL to the output's (name, type and nullability alike), so
      // the need passes straight through and every arm prunes the same way or the union stops
      // type-checking.
      for (const input of r.inputs) require(input, new Set([...need, ...channelCols(input.channels)]));
      continue;
    }

    for (const child of relChildren(r)) {
      const mine = new Set(added(r));
      const childNeed = new Set(preserves(r)
        ? [...[...need].filter((name) => !mine.has(name)), ...channelCols(child.channels)]
        : names(child.type.cols));
      for (const expression of relExprs(r)) refs(expression, child.id, childNeed);
      require(child, childNeed);
    }
  }

  /**
   * ⚠️ **Pass 2 constructs each node with its new type IN ONE STEP, which is why it is not built on
   * `rewrite`.** `rewrite` rebuilds a node's children and only then hands it to a callback, and a
   * factory validates its declared type against the children it was given — so a `Join` whose sides
   * just lost a column throws inside the rebuild (*"a inner Join emits its sides' 2 columns; its
   * type declares 4"*) and the callback that would have retyped it never runs. `mapRelChildren`
   * takes the override for exactly that reason; the children are mapped through the same memo first,
   * so computing the type from them costs nothing.
   */
  const memo = new Map<Rel, Rel>();
  const go = (r: Rel): Rel => {
    const seen = memo.get(r);
    if (seen) return seen;
    const out = build(r);
    memo.set(r, out);
    return out;
  };

  /** The declared columns a node must now carry, or `undefined` where nothing below it shrank. */
  const retypeOf = (r: Rel, kids: readonly Rel[]): Rel['type'] | undefined => {
    // Filter/Sort/Limit/Distinct/Materialize must declare EXACTLY their input's columns and
    // Window/Explode theirs followed by the ones they mint, so the unary chain moves with whatever
    // pruned beneath it or the plan stops verifying. A source-less `Explode` has no relational child
    // and so can never be the node that has to move.
    if (preserves(r) && kids.length === 1 && relChildren(r).length === 1) {
      const [input] = kids as readonly [Rel];
      if (!shrank(relChildren(r)[0]!, input)) return undefined;
      const mine = new Set(added(r));
      return { cols: [...input.type.cols, ...r.type.cols.filter((col) => mine.has(col.name))] };
    }
    if (r.kind === 'join') {
      const [left, right] = kids as readonly [Rel, Rel];
      if (!shrank(r.left, left) && !shrank(r.right, right)) return undefined;
      // The output is the sides' columns POSITIONALLY, so a column dies iff the side that owns its
      // position stopped emitting it. Semi/anti emit the left side alone.
      const leftWidth = r.left.type.cols.length;
      const half = r.join === 'semi' || r.join === 'anti';
      const alive = (i: number): boolean => {
        const [side, local] = i < leftWidth ? [left, r.left.type.cols[i]] : [right, r.right.type.cols[i - leftWidth]];
        return !!local && survived(side).has(local.name);
      };
      return { cols: r.type.cols.filter((_, i) => (half ? i < leftWidth : true) && alive(i)) };
    }
    if (r.kind === 'union') {
      const [first] = kids as readonly [Rel];
      if (!first || !shrank(r.inputs[0]!, first)) return undefined;
      const alive = survived(first);
      return { cols: r.type.cols.filter((col) => alive.has(col.name)) };
    }
    return undefined;
  };

  function build(r: Rel): Rel {
    // A Project removes a column at SOURCE, so its expressions change too and the factory has to see
    // both at once.
    if (r.kind === 'project') {
      const keep = new Set([...(needs.get(r) ?? []), ...channelCols(r.channels)]);
      const exprs = r.exprs.filter(([name]) => keep.has(name));
      const input = go(r.input);
      if (exprs.length === r.exprs.length && !shrank(r.input, input)) return mapRelChildren(r, go);
      return project({
        id: r.id, input, channels: r.channels,
        type: { cols: r.type.cols.filter((col) => keep.has(col.name)) }, exprs,
      });
    }
    // An Aggregate likewise: the surviving `aggs` and the declared columns are one construction.
    if (r.kind === 'aggregate') {
      const keyCount = r.groupBy.length;
      const keyCols = r.type.cols.slice(0, keyCount);
      const aggCols = r.type.cols.slice(keyCount);
      const want = needs.get(r) ?? new Set<string>();
      const wanted = aggCols.filter((col) => want.has(col.name));
      const keptCols = wanted.length ? wanted : aggCols.slice(0, 1);
      if (keptCols.length === aggCols.length) return mapRelChildren(r, go);
      const kept = new Set(names(keptCols));
      return aggregate({
        id: r.id, input: go(r.input), channels: r.channels, having: r.having,
        groupBy: r.groupBy, aggs: r.aggs.filter(([name]) => kept.has(name)),
        type: { cols: [...keyCols, ...keptCols] },
      });
    }
    return mapRelChildren(r, go, retypeOf(r, relChildren(r).map(go)));
  }

  return go(plan);
}
