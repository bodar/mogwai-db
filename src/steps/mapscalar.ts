import { q, list, type Expression } from '../q.ts';
import {
  elemCtx, compileNestedScalar, scalarProp, aliasCtx, labelNameSub, predicateSql, type ScalarCtx,
} from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { mathToSql, mathVars } from '../math.ts';
import { type PStep } from '../strategies.ts';
import { elemRel, type St } from './context.ts';
import { readCompiled, type Compiled, type ValueType } from '../render.ts';
import { foldTailAcc, renderProjection, nodePropOrderKey, type ProjResult } from './projection.ts';

// ---------- map (scalar body → per-traverser scalar projector) ----------

/**
 * map(__.<scalar>) → one correlated scalar per traverser (shape value), reusing
 * compileNestedScalar (values/label/id/constant/out().count()/edge-aggregate). An
 * element-body map is first-result-only (needs a per-input row-number) and an alias/
 * select/fold body isn't a plain scalar — both defer via compileNestedScalar's throw.
 * A trailing step defers.
 */
export function compileMapScalar(st: St, steps: PStep[], stop: number): Compiled {
  const name = steps[stop].name; // 'map' or a scalar-reduction 'local'
  if (stop + 1 < steps.length) throw new Error(`step not implemented after ${name}(): ${steps[stop + 1].name}()`);
  const arg = steps[stop].args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) throw new Error(`${name}(traversal) required`);
  const ctx = elemCtx(elemRel(st), st.elem);
  const inner = stepChain(arg.nested, st.params);
  const sc = compileNestedScalar(inner, ctx);
  const n = elemRel(st);
  const p = st.last.as('p');
  const node = q`SELECT ${sc.expr} AS v FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  // A nested count() is always a Long (TinkerPop's count semantics); the SQLite
  // COUNT integer would otherwise infer as Int via anySerializer.
  const as: ValueType | undefined = inner[inner.length - 1]?.name === 'count' ? 'long' : undefined;
  return readCompiled(st.q, node, { kind: 'value', as });
}

// ---------- math (scalar arithmetic projector) ----------

/**
 * math("<formula>") → a per-traverser Double scalar. The formula (src/math.ts)
 * becomes one SQL arithmetic expression; its variables resolve here:
 *   - `_`        → the current traverser (elemCtx).
 *   - an alias   → an as()-bound traverser (aliasCtx over the carried rowid column).
 * Each variable's scalar value comes from its by() modulator (a property key or a
 * nested traversal, via compileNestedScalar) — positional/round-robin over the
 * folded by()s in first-seen variable order, so a single by() feeds every variable
 * and N by()s feed N variables (matching project()). A missing by() value makes the
 * arithmetic NULL, so the traverser is filtered (a by() that produces nothing drops
 * the traverser, per TinkerPop). The result routes through the shared value tail, so
 * a trailing asNumber()/is()/order()/dedup()/limit() composes (renderProjection).
 * Deferred (clear throws): a variable with no by() (bare incoming value — needs
 * local()/sack()), withSideEffect-bound variables, and reading project()/select()
 * map columns (math inside order().by(__.math(...))).
 */
export function compileMath(st: St, steps: PStep[], stop: number): Compiled {
  const s = steps[stop];
  const formula = s.args[0];
  if (typeof formula !== 'string') throw new Error('math(string) required');
  const bys = s.bys ?? [];
  const varOrder = mathVars(formula);

  const p = st.last.as('p');
  const cache = new Map<string, Expression>();
  const resolveVar = (name: string): Expression => {
    const hit = cache.get(name);
    if (hit) return hit;
    if (!bys.length) throw new Error(`math("${formula}"): variable "${name}" needs a by() modulator`);
    const byArgs = bys[varOrder.indexOf(name) % bys.length];
    let ctx: ScalarCtx;
    if (name === '_') ctx = elemCtx(elemRel(st), st.elem);
    else {
      const entry = st.aliases.get(name);
      if (!entry) throw new Error(`math("${formula}"): no such variable "${name}" — as("${name}") was not seen`);
      ctx = aliasCtx(p.c[entry.col], entry.elem);
    }
    const nested = byArgs.find((a: any) => a && typeof a === 'object' && 'nested' in a);
    const strKey = byArgs.find((a: any) => typeof a === 'string');
    let sc;
    if (nested) sc = compileNestedScalar(stepChain(nested.nested, st.params), ctx);
    else if (strKey !== undefined) sc = { expr: scalarProp(ctx, strKey) }; // by(key): a plain property read (first-under-multi for a node)
    else throw new Error(`math("${formula}"): by() modulator must be a property key or a traversal`);
    cache.set(name, sc.expr);
    return sc.expr;
  };

  const mathExpr = mathToSql(formula, resolveVar);

  // math() always yields a Double; route through the shared value tail.
  const { acc, stop: mstop } = foldTailAcc(steps, stop + 1);
  if (mstop !== steps.length) throw new Error(`${steps[mstop].name}() after math() not yet supported`);
  const n = elemRel(st);
  const proj: ProjResult = {
    shape: { kind: 'value', as: 'double' }, colsNode: q`${mathExpr} AS v`,
    fromNode: q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`, scalarExpr: mathExpr,
    // Drop rows a non-productive by() left NULL (a missing property/empty traversal
    // filters the traverser, per MathStep). NULL propagates through every op, so this
    // one check on the result subsumes a per-variable NULL guard. It ALSO drops a SQL
    // domain-error result (X/0, sqrt(neg), log(0) → NULL in SQLite, never Inf/NaN):
    // fail-closed (no row), since GraphBinary Double framing has no Inf/NaN path — a
    // known, unreachable-in-corpus divergence, deliberately not emitting a wrong 0.0.
    baseWhere: predicateSql(mathExpr, undefined),
  };
  return renderProjection(st.q, proj, acc, nodePropOrderKey(st));
}

// ---------- option-map choose (scalar CASE projector) ----------

/**
 * option-map choose(choiceFn).option(key, body)… → one CASE over a correlated choice
 * scalar. The choice is a T token or a nested scalar traversal (values/label/id/
 * out().count()); each keyed option → `WHEN predicateSql(choice, key) THEN <body>`
 * (a P key → its predicate, a literal → equality); the key-less option (Pick.none) →
 * the ELSE. Requires a Pick.none default with a scalar body: without one, unmatched
 * inputs pass through as the element itself (TinkerPop identity) → a mixed vertex/
 * scalar result the one-shape framing can't carry, so that defers. Scalar bodies only
 * (constant/values/label/id via compileNestedScalar); element bodies, Pick.
 * unproductive/any, and any trailing step defer. Shape: value.
 */
export function compileChooseOptions(st: St, steps: PStep[], stop: number): Compiled {
  const cs = steps[stop];
  if (stop + 1 < steps.length) throw new Error(`step not implemented after choose().option(): ${steps[stop + 1].name}()`);
  const ctx = elemCtx(elemRel(st), st.elem);

  const a0 = cs.args[0];
  let choice: Expression;
  if (a0 && typeof a0 === 'object' && 'token' in a0)
    choice = a0.token === 'label' ? labelNameSub(ctx.labelIdExpr)
      : a0.token === 'id' ? ctx.extIdExpr!
      : (() => { throw new Error(`choose(T.${a0.token}) not yet supported`); })();
  else if (a0 && typeof a0 === 'object' && 'nested' in a0)
    choice = compileNestedScalar(stepChain(a0.nested, st.params), ctx).expr;
  else throw new Error('choose() choice must be a traversal or a T token');

  const whens: Expression[] = [];
  let elseExpr: Expression = q`NULL`;
  let sawNone = false;
  for (const opt of cs.options!) {
    const bodyArg = opt.args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
    if (!bodyArg) throw new Error('option() requires a traversal body');
    const bodyScalar = compileNestedScalar(stepChain(bodyArg.nested, st.params), ctx).expr;
    const keyArg = opt.args.find((x: any) => x !== bodyArg);
    if (keyArg === undefined || (keyArg && typeof keyArg === 'object' && 'pick' in keyArg)) {
      const pick = keyArg && typeof keyArg === 'object' && 'pick' in keyArg ? keyArg.pick : 'none';
      if (pick !== 'none') throw new Error(`option(Pick.${pick}) not yet supported`);
      if (!sawNone) { elseExpr = bodyScalar; sawNone = true; } // first Pick.none wins
    } else {
      whens.push(q`WHEN ${predicateSql(choice, keyArg)} THEN ${bodyScalar}`);
    }
  }
  if (!whens.length) throw new Error('choose().option() needs at least one keyed option');
  // No Pick.none → unmatched inputs are the element itself (mixed vertex/scalar): defer.
  if (!sawNone) throw new Error('choose().option() without a Pick.none default not yet supported (unmatched pass-through is mixed-shape)');
  const n = elemRel(st);
  const p = st.last.as('p');
  const node = q`SELECT CASE ${list(whens, ' ')} ELSE ${elseExpr} END AS v FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  return readCompiled(st.q, node, { kind: 'value' });
}
