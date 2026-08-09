import { channelCols } from '../../channels.ts';
import type { Expr } from '../expr.ts';
import { aggregate, project, recursive, values } from '../factory.ts';
import { explodeColumns } from '../obligations.ts';
import type { Rel } from '../rel.ts';
import type { ColMeta, RelId } from '../types.ts';
import { exprRels, forEachExpr, mapRelChildren, recursiveStep, relChildren, relExprs } from '../walk.ts';

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
 * The columns a `Recursive` must keep: what its consumer reads, PLUS what its own body reads back
 * off the walk, plus its channels — in declared order, because the header is positional.
 *
 * A `SelfRef` carries the recursive's own `id`, so a body's reference to the walk is an ordinary
 * `Col` against that id and this is just a scan for them.
 */
const keepOfRecursive = (r: Extract<Rel, { readonly kind: 'recursive' }>, need: ReadonlySet<string>): readonly string[] => {
  const fromSelf = new Set<string>();
  const body = recursiveStep(r);
  const scan = (node: Rel): void => {
    relExprs(node).forEach((e) => {
      refs(e, r.id, fromSelf);
      forEachExpr(e, (sub) => exprRels(sub).forEach(scan));
    });
    relChildren(node).forEach(scan);
  };
  scan(body);
  const keep = new Set([...need, ...fromSelf, ...channelCols(r.channels)]);
  return names(r.type.cols).filter((name) => keep.has(name));
};

/**
 * Re-express a walk body against a `SelfRef` of the PRUNED type.
 *
 * ⚠️ **The substitution must happen INSIDE pass 2, not before it**, and getting that backwards cost
 * a real cycle. Substituting first produces a body whose nodes declare their old widths over a
 * narrower child, and pass 2 then sees nothing to do — its retypes fire on a child having SHRUNK,
 * and within the pre-substituted tree nothing did. Done here, the self-ref shrinks like any other
 * child, so every retype downstream works unchanged: the unary chain follows it, and a `Join`'s
 * positional mapping still has the ORIGINAL side widths to map against.
 *
 * It exists at all because `recursive`'s factory memoises `step` — the body it built the first time
 * is the only body there is, so the original closure cannot simply be re-run against a new `self`.
 */
interface SelfSubstitution { readonly name: string; readonly self: Rel }

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
 * `Recursive` is the one whose header, seed and step are ONE decision: what the body reads back off
 * the walk joins the consumer's need before anything is decided, and the body is then re-expressed
 * against a `SelfRef` of the narrower type. See the arm in pass 2 for why that cannot reuse the
 * original `step` closure.
 */
export function prune(
  plan: Rel,
  required: readonly string[] = plan.type.cols.map((col) => col.name),
  substitute?: SelfSubstitution,
): Rel {
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

    if (r.kind === 'recursive') {
      // The header, the seed and the step move together, and what the BODY reads from the walk is
      // only knowable by instantiating it — so the walk's own reads join the parent's need before
      // anything is decided. `recursiveStep` is memoised by the factory, so this is the same body
      // object pass 2 walks.
      //
      // ⚠️ BOTH sides must be required, not just the seed. `check` holds the seed and the step to
      // IDENTICAL types, so a body left with no recorded need prunes to its channels alone and the
      // two stop agreeing — which is what happens on the path where the header does not shrink at
      // all, i.e. the case that looked like it needed no work.
      const keep = keepOfRecursive(r, need);
      require(r.seed, keep);
      require(recursiveStep(r), keep);
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
    // The walk reference, narrowed — see `SelfSubstitution`. It shrinks like any other child, which
    // is what makes every retype below fire without a special case.
    if (substitute && r.kind === 'self-ref' && r.name === substitute.name) return substitute.self;
    /**
     * `Values` is the OTHER node that removes a column at source, and forgetting it is not cosmetic:
     * a walk's SEED is typically a `Values`, so a `Recursive` whose header pruned would leave the
     * seed wider than the step and `check` holds those two to identical types. It is the first thing
     * `unroll` would have hit.
     *
     * ⚠️ It may not prune to zero — an empty relation is a `Filter(false)`, never an empty `VALUES`
     * (§3.3), and the factory says so.
     */
    if (r.kind === 'values') {
      const keep = new Set([...(needs.get(r) ?? names(r.type.cols)), ...channelCols(r.channels)]);
      const alive = r.type.cols.map((col, i) => [col, i] as const).filter(([col]) => keep.has(col.name));
      const kept = alive.length ? alive : [[r.type.cols[0]!, 0] as const];
      if (kept.length === r.type.cols.length) return r;
      return values({
        id: r.id, channels: r.channels, type: { cols: kept.map(([col]) => col) },
        rows: r.rows.map((row) => kept.map(([, i]) => row[i]!)),
      });
    }
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
    /**
     * The walk. Its header, seed and step are ONE decision, and the body has to be re-expressed
     * against a `SelfRef` of the narrower type or it goes on declaring columns the CTE no longer
     * has. The factory memoises `step`, so the original closure cannot be re-run against a new
     * `self` — the body it built the first time is the only body there is. So: substitute the walk
     * reference, then prune the substituted body to the same header. Re-entering `prune` rather than
     * threading this pass's memo through is deliberate — the body is now a DIFFERENT tree, and a memo
     * keyed on the old nodes would miss every one of them while looking like it had hit.
     */
    if (r.kind === 'recursive') {
      const keep = keepOfRecursive(r, needs.get(r) ?? new Set(names(r.type.cols)));
      if (keep.length === r.type.cols.length) return mapRelChildren(r, go);
      const kept = new Set(keep);
      const body = recursiveStep(r);
      return recursive({
        id: r.id, name: r.name, cols: keep, channels: r.channels,
        type: { cols: r.type.cols.filter((col) => kept.has(col.name)) },
        seed: go(r.seed),
        step: (self) => prune(body, keep, { name: r.name, self }),
      });
    }
    return mapRelChildren(r, go, { type: retypeOf(r, relChildren(r).map(go)) });
  }

  return go(plan);
}
