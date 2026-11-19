import { CopiedDraw } from '../../sql/kernel/budget.ts';
import { isUnitValues } from '../block.ts';
import { copyRerunsBarrier, draws } from '../copies.ts';
import { materialize, ref } from '../factory.ts';
import { relId } from '../types.ts';
import { plan, type Binding, type Plan } from '../plan.ts';
import type { Rel } from '../rel.ts';
import { exprRels, forEachExpr, isSelfContained, relChildren, relExprs, rewriteRels } from '../walk.ts';
import { readInFull } from '../work.ts';

/**
 * Decide which DAG vertices deserve a named boundary, and REWRITE them into `Plan` bindings.
 *
 * This is §4, and a binding is now the only naming mechanism: the pass used to return a side
 * table the emitter consulted, which meant "is this node a CTE?" was a question asked of a map
 * carried beside the plan rather than of the plan. A binding plus a `Ref` says the same thing IN
 * the algebra, and says it identically for a relation and for a statement's retained rows (§3.0).
 *
 * A node reached more than once is shared, which is only true if the passes upstream preserved
 * sharing — a rewrite that rebuilds per parent occurrence makes every count 1 and silently turns
 * this analysis off.
 *
 * ⚠️ **`mint` is REQUIRED, and it is the caller's program-wide fresh-name source.** A private counter
 * made names unique within ONE call only: a program that splices the bindings of two separately named
 * plans — a write's target snapshot and the read that produced its input — had both call their first
 * shared node `r0`, and `plan()` refused the splice (`duplicate Plan binding`, a bare internal Error on
 * `g.V().both().addV('x')`). Drawing binding names from the same per-compile minter as `Rel` ids also
 * means a CTE name can never equal a relation alias. The `taken` loop below still guards the names this
 * pass did NOT mint — an explicit `Materialize` name and a `Recursive`'s CTE name.
 *
 * `hoisted` are relations the LOWERING already bound (`boundedSpine`, `src/compiler/rel/lower.ts`: a long
 * chain's spine cut into CTEs so no walker recurses deeper than a bound), each read by a `Ref` from the
 * next. They are roots of the same program, so they are named as ONE plan with `root`: a node two of them
 * share is counted across all of them and bound once, and a hoisted node reached again by identity reads
 * its own binding rather than being spelled a second time. A hoisted binding is never inlined back — it
 * is a root, and the depth bound is the reason it exists.
 */
export function name(root: Rel, mint: () => string, hoisted: readonly { readonly name: string; readonly node: Rel }[] = []): Plan {
  const roots = [...hoisted.map((binding) => binding.node), root];
  const counts = new Map<Rel, number>();
  const visit = (rel: Rel): void => {
    const seen = (counts.get(rel) ?? 0) + 1;
    counts.set(rel, seen);
    if (seen > 1) return;
    // ⚠️ THE COUNT MUST INCLUDE CORRELATED SUBPLANS, or a node shared between the spine and a
    // `Scalar`/`Exists` body counts once and is INLINED at both — the emitter spells the whole
    // subtree twice, and it is spelled again for every further occurrence. Nothing is wrong with the
    // answer, which is why this survived: it is bytes, and §3.6's statement-text budget is measured
    // in bytes. `COMPUTE ONCE` (§Phase 2's invariants) measured the same shape at 1,250 → 4,108 for
    // a single `max`.
    relExprs(rel).forEach((e) => forEachExpr(e, (node) => exprRels(node).forEach(visit)));
    relChildren(rel).forEach(visit);
  };
  roots.forEach(visit);

  // An explicit Materialize name is the caller's, and a Recursive's name is its CTE's — the walk's
  // own term refers to it — so generated names must not collide with either, nor with a hoisted one.
  const taken = new Set([...[...counts.keys()].flatMap((rel) =>
    ((rel.kind === 'materialize' && rel.name) || rel.kind === 'recursive' ? [rel.name] : [])),
  ...hoisted.map((binding) => binding.name)]);
  const generate = (): string => {
    let candidate = mint();
    while (taken.has(candidate)) candidate = mint();
    taken.add(candidate);
    return candidate;
  };
  /**
   * ⚠️ **A CORRELATED subtree may not be bound, and this is the whole risk of reaching into
   * subplans.** A binding is a CTE beside the statement; a subtree whose `Col`s resolve against a
   * relation OUTSIDE it stops resolving the moment it moves there — and it does not necessarily
   * fail, because a same-named relation elsewhere in the statement would silently capture it. So the
   * admission rule is the free-reference test, not the occurrence count.
   *
   * That is also why the test lives in `walk.ts`: `flatten` (§4) decides what it must DECORRELATE
   * with exactly this fact, and two implementations of "is this subtree self-contained" is two
   * chances to get it wrong.
   *
   * ⚠️ **A subtree holding a walk's own reference may not be bound either, and `freeRelIds` does not
   * say so** — a `SelfRef` names its walk POSITIONALLY rather than by a `Col`, so such a subtree is
   * free-reference-clean and looked bindable. Hoisting it puts the reference in a CTE beside its own
   * recursive statement, which SQLite answers with `circular reference`. It is reachable two ways —
   * a `Materialize` inside a recursive term (always), and any node the term shares with itself — and
   * `check` refuses the first outright, so what this arm keeps correct is the second.
   *
   * ⚠️ **The question is FREE reference, not containment**, and the difference is a whole `Recursive`
   * node: it binds its own name, so moving it moves the definition too. `containsSelfRef` made every
   * walk unbindable — a walk always holds its own reference — so a SHARED walk lost its CTE and was
   * spelled, and computed, once per occurrence (`hasFreeSelfRef` carries the measurement).
   *
   * **The constant unit row is never bound** (`isUnitValues`, `src/rel/block.ts` — the one classification
   * the emitter's `directSource` also asks). Shared by every correlated block that re-sources from it, it
   * became `rN AS (SELECT … FROM (VALUES (1)) …)`, read through a `Ref` the emitter's fold cannot erase and
   * re-entered per host row. Left inline it reaches each block as the `unit` source `withoutUnit` erases;
   * spelling it again costs no bind, no read, no multiplicity and no draw. */
  const isRoot = new Set(roots);
  const binds = (rel: Rel): boolean =>
    !isRoot.has(rel) && ((counts.get(rel) ?? 0) > 1 || rel.kind === 'materialize')
    && isSelfContained(rel) && !isUnitValues(rel);
  /**
   * ⚠️ **A SHARED relation that stays INLINE is evaluated once per spelling** — so if it DRAWS (`draws`,
   * `src/rel/copies.ts`), each spelling picks differently and the readers disagree about one traverser:
   * `local(out().order().by(shuffle).limit(1).union(out(), __.in()).count())` read the out-arm of one
   * pick and the in-arm of another and answered 5, which no out-neighbour of v1 has. SQLite has no way to
   * evaluate a CORRELATED relation once for two readers (an `AS MATERIALIZED` CTE written inside the
   * correlated subquery is re-evaluated per reference, measured), so this declines. A bound one is a CTE,
   * and a CTE read twice is evaluated once only when SQLite cannot flatten it into its readers: a CTE
   * whose top SELECT is a plain projection or filter IS flattened into each reader, under a plain compound
   * and a MERGE UNION ALL alike (measured; `copyRepeatsWork`, `src/rel/copies.ts`). So a bound relation that
   * DRAWS is FENCED (`fenced` below): its CTE renders `AS MATERIALIZED`, evaluated once, and every reader
   * sees one pick. Its top need not be a barrier — a per-scope draw the decorrelator keyed
   * (`src/rel/decorrelate.ts`) tops out in the `ROW_NUMBER` filter's projection, which SQLite flattened into
   * each reader: `local(out().order().by(shuffle).limit(1).union(identity(), identity()).dedup().count())`
   * answered 2 (measured). A reader that can read its input once instead (`hopJoin`'s direction row) asks
   * `doubledReads` first and never reaches here.
   */
  for (const [rel, seen] of counts) {
    if (seen > 1 && !isRoot.has(rel) && !binds(rel) && draws(rel)) throw new CopiedDraw();
  }
  /**
   * A shared, bound relation SQLite would evaluate once PER READER, as the fenced `Materialize` its CTE must
   * be. One rule for two reasons, both "SQLite flattens this CTE into each reader and evaluates a copy":
   *
   * - it DRAWS (`draws`): each copy picks differently, a wrong ANSWER (above);
   * - a copy RE-RUNS A BARRIER OR A WALK (`copyRerunsBarrier`, `src/rel/copies.ts` — `copyRepeatsWork`'s
   *   measured model of SQLite's flattener, less the computed-column half a fence does not pay for): a
   *   compute-once violation. It is asked of the REWRITTEN node, where a shared input bound below is
   *   already a `Ref` evaluated once. `repeat(out('knows')).emit(in('knows').has('age', gt(40)))` reads its walk's
   *   `lp0 > 0` filter twice — once to collect the ids the emit condition is asked of, once to keep the
   *   rows it admits — and SQLite flattened that filter into both readers, so the recursive CTE was walked
   *   twice per statement (two `CO-ROUTINE wk_…` sites in one plan). Fenced, it is one `MATERIALIZE` and
   *   each reader scans the temp table (or an automatic index on it).
   *
   * The second reason holds only where EVERY reader reads the relation in full (`readInFull(roots, 'once').full`,
   * `src/rel/work.ts`, the reader-demand fact). A fence spools the WHOLE relation before the first row; a reader
   * that stops early — a `LIMIT`, an uncorrelated `EXISTS` — reads a flattened copy only as far as it needs, so two
   * such copies cost two short reads, not two relations. `g.V().has('age', gt(30)).both().values('name').limit(3)`
   * shares the range seek's `SELECT DISTINCT` between both directions: fenced it spooled every match and went
   * near-constant → linear (2.8 → 45 ms at 64k vertices). A relation read both ways is not in `full` and stays
   * lazy too. A draw fences whatever its demand: that is an answer, not a cost.
   *
   * A walk bound under its own name is already one CTE in the `WITH RECURSIVE` list — SQLite cannot flatten
   * a recursive CTE — so it is never wrapped (the emitter renders a bound `Recursive` itself, not a
   * `Materialize` over one). `sql-hygiene` checks the outcome independently, from SQLite's own plan: no
   * named CTE evaluated twice in one statement.
   */
  const demand = readInFull(roots, 'once');
  const fenced = (original: Rel, mapped: Rel): Rel =>
    (counts.get(original) ?? 0) > 1 && original.kind !== 'recursive'
      && (draws(original) || (demand.full.has(original) && copyRerunsBarrier(mapped)))
      && !(mapped.kind === 'materialize' && mapped.fenced)
      ? materialize({ id: relId(`${original.id}_fence`), input: mapped, channels: mapped.channels, type: mapped.type, fenced: true })
      : mapped;

  const bindings: Binding[] = [];
  // Bottom-up and memoised — ONE memo across every root — so a binding is pushed after every binding it
  // depends on, and the second occurrence of a shared node gets the SAME `Ref`: the ordering `checkPlan`
  // then proves.
  const memo = new Map<Rel, Rel>();
  const rewriteRoot = (from: Rel): Rel => rewriteRels(from, (mapped, original) => {
    if (!binds(original)) return mapped;
    // A Recursive binds under its OWN name rather than a generated one: its term already refers to
    // that name, so a second name would need the definition rewritten to match.
    const declared = original.kind === 'recursive' ? original.name
      : original.kind === 'materialize' ? original.name : undefined;
    const bound = declared ?? generate();
    bindings.push({ name: bound, node: fenced(original, mapped) });
    return ref({ id: original.id, name: bound, channels: mapped.channels, type: mapped.type });
  }, memo);
  for (const binding of hoisted) {
    const node = rewriteRoot(binding.node);
    bindings.push({ name: binding.name, node });
    memo.set(binding.node, ref({ id: binding.node.id, name: binding.name, channels: node.channels, type: node.type }));
  }
  return plan({ bindings, result: rewriteRoot(root) });
}
