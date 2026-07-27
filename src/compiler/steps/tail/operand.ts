import { q, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { isNested } from '../../../gremlin/frontend.ts';
import { childSteps } from './child-shape.ts';
import { embedSql, foldedListSubquery } from './list.ts';
import { engineOf, type Engine } from '../../engine/deps.ts';
import { aliasCtx, labelNameSub, scalarProp, type ScalarCtx } from '../../plan/plan.ts';
import { compileCorrelatedChild } from './correlated.ts';
import { correlatedReduce } from '../prefix/predicate.ts';
import type { PStep } from '../../ir/strategies.ts';
import type { Carried, Carry, LabelScope } from '../context/context.ts';

// ---------- predicate operands that are TRAVERSALS ----------
//
// TinkerPop lets a predicate's right-hand operand be a traversal, compared against its FIRST
// result: `has("name", __.V(vid).values("name"))`, `has("age", P.gt(__.V(vid).values("age")))`,
// `is(__.V(vid).out("knows").values("age"))`.
//
// A bare `constant(x)` operand is already gone by the time we get here — the
// foldConstantPredicateOperands Pass turned it into a literal in the IR. What is left is a real
// traversal, and it splits in two:
//
//   · RE-SOURCED (`V()`/`E()` head) — it re-roots the graph and never reads the current
//     traverser, so it is a standalone read. Compile it as its own sub-read and embed the result
//     as a scalar subquery, exactly as within()/all() already do for a folded list operand
//     (list.ts). No correlation needed, so it composes at any depth and over any parent shape.
//   · TRAVERSER-DEPENDENT (`__.values("k")`, `__.out().values("k")`) — needs a value correlated
//     to the current row, so it renders as a CORRELATED scalar subquery over the same inline
//     child machinery the predicate fast path already uses (correlated.ts). Available only where
//     the host can supply a ScalarCtx for the current element; elsewhere it still defers.
//
// Resolution happens in the STEP layer, not in plan.ts: building a sub-read needs the Engine,
// which the pure SQL layer cannot reach. plan.ts already accepts an Expression operand (value()
// forwards nodes untouched), so substituting one here is all it takes.

/** Is this body a re-source — a `V()`/`E()` head with no nested id argument? Such a traversal is
 *  independent of the incoming traverser, which is exactly what makes it a plain subquery. */
const isReSourced = (body: readonly any[]): boolean => {
  const head = body[0];
  return !!head && (head.name === 'V' || head.name === 'E') && !(head.args ?? []).some(isNested);
};


/** One traversal operand → `(SELECT v FROM (<sub-read>) LIMIT 1)`, or null when it is not a
 *  standalone re-sourced read this can build. LIMIT 1 is TinkerPop's rule: a multi-result operand
 *  compares against its FIRST result (Has.feature pins `__.V(vid).out("knows").values("name")
 *  .order()` → the first of the ordered pair). */
function operandSubquery(nested: any, deps: OperandDeps): Expression | null {
  const body = childSteps(nested, deps.params);
  if (!body.length || !isReSourced(body)) return null;
  const sub = deps.engine.compileReadCompiled(body as any, deps.params);
  // Only a VALUE-shaped read has a `v` column to compare against; an element/list/map read is a
  // different comparison entirely, so it declines rather than inventing one.
  if (sub.shape.kind !== 'value') return null;
  return q`(SELECT v FROM (${embedSql(sub)}) LIMIT 1)`;
}

/** The scalar an operand's TERMINAL step reads off the element it lands on. These are the same
 *  leaves the predicate fast path already builds from (plan.ts), so a correlated operand and a
 *  correlated filter agree by construction rather than by parallel implementations. */
const OPERAND_PROJECTORS: Record<string, (ctx: ScalarCtx, s: PStep) => Expression | undefined> = {
  values: (ctx, s) => (typeof s.args?.[0] === 'string' ? scalarProp(ctx, s.args[0]) : undefined),
  id: (ctx) => ctx.extIdExpr,
  label: (ctx) => labelNameSub(ctx.labelIdExpr),
};

/** A TRAVERSER-DEPENDENT operand → a correlated scalar Expression, or null when this shape is not
 *  one we can build (the caller then keeps its clear deferral).
 *
 *  Grammar: `<element movement/filter prefix>.<scalar projection>` — the same split the child seam
 *  uses everywhere. The prefix compiles through `compileCorrelatedChild`, the SAME inline renderer
 *  where()/filter() use, so movement inside an operand is not a second implementation; the
 *  projection then reads the reached element via `aliasCtx`, exactly as correlatedExists does for
 *  its trailing property test. An EMPTY prefix is not a special case but the degenerate one: the
 *  element it lands on IS the current traverser, so the projector reads the caller's own ctx and
 *  no subquery is needed.
 *
 *  An unproductive operand yields SQL NULL, which is already the right answer at both hosts
 *  TinkerPop pins: `eq(NULL)` is falsy so the traverser drops, and a NULL member of a within()
 *  set contributes nothing while a sibling constant can still match. */
function correlatedOperand(nested: any, deps: OperandDeps, ctx: ScalarCtx, labels?: LabelScope): Expression | null {
  const body = childSteps(nested, deps.params) as PStep[];
  if (!body.length) return null;
  const engine = deps.engine;
  // A terminal reducer over a movement (`__.out().count()`) is already a correlated subquery
  // builder — reuse it rather than growing a second aggregate path.
  const reduced = correlatedReduce(engine, body as any, ctx, deps.params, labels);
  if (reduced) return reduced;

  const proj = body[body.length - 1];
  const projector = OPERAND_PROJECTORS[proj.name];
  if (!projector) return null;
  const prefix = body.slice(0, -1);
  if (!prefix.length) return projector(ctx, proj) ?? null;
  const child = compileCorrelatedChild(engine, ctx.idExpr, prefix as any, deps.params, labels);
  if (!child) return null;
  const c = child.rel.as('opc');
  const scalar = projector(aliasCtx(c.c.id, child.elem), proj);
  // LIMIT 1 — TinkerPop compares against the operand's FIRST result.
  return scalar ? q`(SELECT ${scalar} FROM ${c} LIMIT 1)` : null;
}

/** What an operand needs from the compile, independent of the host's stream shape: the Engine (to
 *  build a sub-read) and the bound params (to parse the body). `carried` is present only when the
 *  host actually has a traverser schema — the inline predicate renderer does not. Taking this
 *  rather than a `Carry` is what lets predicate.ts, which never sees a Stream, resolve operands
 *  through the same path as the StepFns. */
export interface OperandDeps {
  readonly engine: Engine;
  readonly params: Record<string, any>;
  readonly carried?: Carried;
}

/** The deps a Stream-holding host already has to hand. */
export const operandDeps = (carry: Carry): OperandDeps =>
  ({ engine: engineOf(carry), params: carry.params, carried: carry.carried });

/** What the HOST can offer an operand beyond the query itself. All optional: a host that offers
 *  nothing still resolves the re-sourced form, which needs no context at all. */
export interface OperandHost {
  /** The current ELEMENT, for a correlated operand (`__.values('k')`, `__.out().values('k')`). */
  readonly ctx?: ScalarCtx;
  /** The row relation the host's own SQL references, for an operand that reads CARRIED
   *  per-traverser state rather than the graph — today just `__.sack()`. */
  readonly row?: Relation;
  /** The host's path-history labels, so an operand body reads them wherever a predicate body can
   *  — the operand and filter halves of one has() see the same labels rather than one silently
   *  deferring. Omitted where no relation holds the histories in scope. */
  readonly labels?: LabelScope;
}

/** `__.sack()` as an operand: the carried sack column on the host's row. Not a subquery and not a
 *  correlation — the value is already a column on the traverser, which is the whole point of the
 *  sack. Declines when the body is anything else or no sack is carried (a bare `sack()` with no
 *  `withSack()` is an error the sack step itself reports, not something to answer here). */
function sackOperand(nested: any, deps: OperandDeps, row: Relation | undefined): Expression | null {
  if (!row || !deps.carried?.sack) return null;
  const body = childSteps(nested, deps.params);
  if (body.length !== 1 || body[0].name !== 'sack' || (body[0].args ?? []).length) return null;
  return row.c[deps.carried.sack];
}

/** Replace every resolvable traversal operand in `pred` with its subquery Expression, leaving
 *  everything else exactly as it was. Handles the bare-operand form (`is(__.V(…)…)`) and operands
 *  nested inside a P, recursively (`P.not(P.gt(…))`). Returns `pred` unchanged when nothing
 *  resolved, so a caller can stay on its existing path. */
export function resolveTraversalOperands(pred: any, deps: OperandDeps, host: OperandHost = {}): any {
  // within/without over ONE traversal operand is a LIST membership, not a value comparison —
  // `within(__.V(1).out('knows').values('age').fold())` asks whether the value is among the
  // members that read produces. It is intercepted at the PRED level (the generic value walk
  // below substitutes a scalar per operand, which is the wrong shape here) and re-minted as the
  // list form predicateSql renders with a json_each scan.
  const listPred = tryListMembership(pred, deps);
  if (listPred) return listPred;
  if (isNested(pred)) {
    // Cheapest first: a carried column, then a standalone subquery (no correlation needed even at
    // a host that could correlate), then the correlated form.
    return sackOperand(pred.nested, deps, host.row)
      ?? operandSubquery(pred.nested, deps)
      ?? (host.ctx ? correlatedOperand(pred.nested, deps, host.ctx, host.labels) : null)
      ?? pred;
  }
  if (!pred || typeof pred !== 'object' || !('op' in pred) || !Array.isArray((pred as any).values)) return pred;
  let changed = false;
  const values = (pred as any).values.map((v: any) => {
    const out = resolveTraversalOperands(v, deps, host);
    if (out !== v) changed = true;
    return out;
  });
  return changed ? { ...pred, values } : pred;
}

/** PURE. Does this predicate still hold a traversal operand nothing could resolve? A FAST PATH
 *  must DECLINE on one rather than let the render throw: its contract is "return null and the
 *  caller falls through to the generic gate", and a throw from inside it defines support by
 *  vocabulary exhaustion instead. */
export function hasUnresolvedOperand(pred: any): boolean {
  if (isNested(pred)) return true;
  if (!pred || typeof pred !== 'object' || !Array.isArray((pred as any).values)) return false;
  return (pred as any).values.some(hasUnresolvedOperand);
}

/** `within(<traversal>)` / `without(<traversal>)` whose single operand folds a re-sourced read
 *  into a list → the `withinList`/`withoutList` pred predicateSql knows. Null for every other
 *  shape (a vararg set, a non-fold body, a correlated body), so the caller's normal resolution
 *  runs untouched. A CORRELATED list operand is a different problem — the members would vary per
 *  traverser, which `foldedListSubquery`'s standalone sub-read cannot express — so it declines
 *  and the existing deferral stands. */
function tryListMembership(pred: any, deps: OperandDeps): any | null {
  if (!pred || typeof pred !== 'object' || !('op' in pred)) return null;
  if (pred.op !== 'within' && pred.op !== 'without') return null;
  const vals = (pred as any).values;
  if (!Array.isArray(vals) || vals.length !== 1 || !isNested(vals[0])) return null;
  const body = childSteps(vals[0].nested, deps.params);
  if (body[body.length - 1]?.name !== 'fold' || !isReSourced(body)) return null;
  // A recognizer must DECLINE, never throw: the body is rooted by shape, but a source form the
  // seed layer does not yet cover still has to fall through to the caller's clear deferral.
  let listExpr: Expression | null = null;
  try { listExpr = foldedListSubquery(deps.engine, body as PStep[], deps.params); } catch { return null; }
  if (!listExpr) return null;
  return { op: pred.op === 'within' ? 'withinList' : 'withoutList', values: [listExpr] };
}
