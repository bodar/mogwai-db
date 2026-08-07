import { col, compilerNull, compilerReal, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { argValues } from '../../gremlin/frontend.ts';
import { compileMath, mathVars, type MathOps } from '../../gremlin/math.ts';
import type { Rel } from '../../rel/rel.ts';
import type { IRStep } from '../ir/step.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { byExpr, modulations, scopedHost, type Modulation } from './modulator.ts';
import { carriedCols, meta, typeOf, type Minter } from './build.ts';

/**
 * `math("<formula>")` — a per-traverser DOUBLE, as RelIR nodes.
 *
 * THE STEP IS TWO QUESTIONS AND ONLY THE SECOND IS NEW HERE. The formula is
 * `src/gremlin/math.ts`'s — the lexer, the precedence climb and the three SQL expansions that no
 * operator name derives (`log`→`LN`, `cbrt`'s sign split, `signum`'s three-way CASE) — parameterized
 * over an OPS RECORD so both spines spend one table (§6·4). What is this module's is variable
 * RESOLUTION, and that turns out to be two pieces the `by()` vocabulary already had:
 *
 * - a variable NAMES A HOST. `_` is the current traverser; anything else is a scope key, resolved
 *   MAP-SCOPE-FIRST then path labels (`scopedHost`, i.e. `Scoping.getScopeValue`'s own order).
 * - the ring's `by()` PROJECTS a value out of that host — `byExpr`, unchanged, so `by("age")`,
 *   `by(T.id)`, `by(__.out().count())` and `by(__.select('x'))` all work over a math variable the
 *   day they work anywhere. Legacy taught its math a private modulation spec and got the property
 *   and traversal forms only.
 *
 * `TraversalRing.next()` is ROUND-ROBIN and yields NOTHING for an empty ring, in which case
 * `TraversalUtil.produce` hands back the scoped value itself — so a `by()`-less `math("a + b")` over
 * labelled VALUES is well-formed and needs no modulator at all. Legacy throws there; this answers,
 * which is §6·1's "the floor is the union" rather than a divergence to reconcile.
 * (`MathStep.processNextStart`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:66-97`.)
 *
 * ## What DECLINES, and why each is the honest answer
 *
 * - a variable whose host is an ELEMENT under an identity `by()`. The reference RAISES there —
 *   *"The variable %s for math() step must resolve to a Number"* — because `traverser.get()` is a
 *   Vertex. Projecting the rowid would answer a different question, which is the one thing this
 *   layer may never do; declining hands the traversal to a spine that raises.
 * - a comparator in the ring (`by(Order.desc)`): `math()` reads a projection, and a `by()` that
 *   names only a direction projects nothing.
 * - anything `byExpr` or `scopedHost` declines, unchanged.
 */

/**
 * THE `Expr` SIDE of the ops record — the EMISSION half, the twin of legacy's `qMathOps`.
 *
 * Every leaf is a REAL because `math()` is all-double arithmetic: a variable is `CAST(… AS REAL)`
 * (which is what makes `/` real division rather than SQLite's integer division on integer operands)
 * and a literal inlines with an explicit decimal point. Both are COMPILER-authored constants, so
 * they spend none of the 100-parameter budget.
 */
const relMathOps = (resolve: (name: string) => Expr): MathOps<Expr> => ({
  variable: (name) => ({ kind: 'cast', arg: resolve(name), to: 'real' }),
  real: (text) => compilerReal(Number(text)),
  binary: (op, left, right) => ({ kind: 'binary', op, left, right }),
  negate: (a) => ({ kind: 'unary', op: 'neg', arg: a }),
  call: (fn, args) => ({ kind: 'call', fn, args }),
  conditional: (whens, otherwise) => ({ kind: 'case', whens, else: otherwise }),
  compare: (op, left, right) => ({ kind: 'binary', op, left, right }),
  nul: () => compilerNull('real'),
});

/** TinkerPop's name for the current traverser inside a formula (`MathStep.CURRENT`). */
const CURRENT = '_';

/**
 * The formula as ONE expression over the host traverser, or `null` to decline.
 *
 * Split from the tail below because a `math()` is not only a chain step: it is a child body
 * (`order().by(__.math('_ * 10'))`, `project('x').by(__.math('a + b'))`), and there the answer
 * wanted is the VALUE rather than a relation carrying it — `serviceValue`/`midCall`'s split, for
 * the same reason.
 */
export function mathValue(step: IRStep, host: ChildHost, child: ChildSeam, fresh: Minter): Expr | null {
  const [formula, extra] = argValues(step);
  if (typeof formula !== 'string' || extra !== undefined || step.optionArms) return null;
  const ring = modulations(step, (step.modulators ?? []).length, child);
  if (!ring) return null;
  const resolved = new Map<string, Expr>();
  const vars = mathVars(formula);
  for (const [at, name] of vars.entries()) {
    // The ring advances ONCE PER VARIABLE, in first-seen order, and wraps — so one `by()` feeds every
    // variable and N by()s feed N variables (`TraversalRing.next()`).
    const modulation: Modulation = ring.length ? ring[at % ring.length]! : { key: { kind: 'identity' } };
    if (modulation.order !== undefined) return null;
    const varHost = name === CURRENT ? host : scopedHost(name, host);
    if (!varHost) return null;
    // An identity projection over an ELEMENT or a RECORD is the traverser itself, which is not a
    // Number — the reference raises rather than coercing, so decline instead of projecting a rowid.
    if (varHost.kind !== 'scalar' && modulation.key.kind === 'identity') return null;
    const value = byExpr(modulation, varHost, fresh, false, child);
    if (!value) return null;
    resolved.set(name, value);
  }
  // Total by construction: every variable `compileMath` can ask for is one `mathVars` reported.
  return compileMath(formula, relMathOps((name) => resolved.get(name)!));
}

/**
 * `math()` over any host relation — the value projected as `v`, and the traverser DROPPED where it
 * is NULL.
 *
 * The drop is the reference's productivity rule: a variable whose `by()` yielded nothing makes the
 * whole step unproductive and emits no traverser at all (`MathStep`'s `productive` flag). SQL's NULL
 * propagation gives that for free through every arithmetic operator, and the sign-split CASEs return
 * NULL for a NULL argument for the same reason — so ONE `v IS NOT NULL` is the whole rule. It also
 * catches a SQL domain error (`SQRT(-1)`), which is legacy's behaviour here too.
 *
 * The CHANNELS ride through untouched: `math()` changes the traverser's VALUE, not its identity, its
 * multiplicity or its position — which is what makes a following `is()`, `order()`, `sum()` or
 * `fold()` the ordinary scalar tail with nothing to know about arithmetic.
 */
export function mathTail(
  input: Rel, step: IRStep, host: ChildHost, child: ChildSeam, fresh: Minter,
): Rel | null {
  const value = mathValue(step, host, child, fresh);
  if (!value) return null;
  const carried = input.channels;
  const projected = make.project({
    id: fresh('mv'), input, channels: carried,
    type: typeOf(meta('v', 'real', true), ...carriedCols(carried)),
    exprs: [['v', value], ...carried.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
  });
  return make.filter({
    id: fresh('mf'), input: projected, channels: carried, type: projected.type,
    pred: { kind: 'binary', op: 'is not', left: col(projected.id, 'v'), right: compilerNull() },
  });
}
