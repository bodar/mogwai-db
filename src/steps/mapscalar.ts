import { q, list, value, type Expression } from '../q.ts';
import {
  elemCtx, compileNestedScalar, scalarProp, aliasCtx, labelNameSub, predicateSql, type ScalarCtx,
} from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { mathToSql, mathVars } from '../math.ts';
import { type PStep } from '../strategies.ts';
import { carryFrag, carriedCols, elemRel, type ElementStream } from './context.ts';
import { carryOf, toScalarStream, type ListStream, type ScalarStream, type Stream } from './stream.ts';
import { type ValueType } from '../render.ts';
import { tryCompileCountChild, tryCompileElementChild, tryCompileListChild, tryCompileScalarChild } from './child.ts';

// ---------- map (scalar body → per-traverser scalar projector) ----------

/** Element-valued map body through the generic child-domain compiler. Null means the
 * body is outside the currently origin-safe element vocabulary, so the scalar child
 * fast path (or its clear deferral) should handle it. */
export function tryLowerMapElement(st: ElementStream, step: PStep): ElementStream | null {
  const arg = step.args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  return tryCompileElementChild(st, arg.nested, 'first')?.stream ?? null;
}

/** flatMap() consumes every productive child row. Keeping this next to map() makes
 * `first` versus `all` an explicit consumer policy over one child compiler, for both
 * element and scalar output shapes. */
export function tryLowerFlatMap(st: ElementStream, step: PStep): Stream | null {
  const arg = step.args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  return tryCompileElementChild(st, arg.nested, 'all')?.stream
    ?? tryCompileScalarChild(st, arg.nested, 'all')
    ?? tryCompileListChild(st, arg.nested);
}

export function tryLowerListChild(st: ElementStream, step: PStep): ListStream | null {
  const arg = step.args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  return tryCompileListChild(st, arg.nested);
}

/**
 * map(__.<scalar>) → one correlated scalar per traverser (shape value), reusing
 * compileNestedScalar (values/label/id/constant/out().count()/edge-aggregate). An
 * Element bodies are attempted first through tryCompileElementChild; alias/select/fold
 * bodies still defer when they are neither an element child nor a plain scalar.
 * The produced ScalarStream re-enters the common dispatcher, so scalar followers
 * compose without this leaf owning a private tail compiler.
 */
export function lowerMapScalar(st: ElementStream, steps: PStep[], stop: number): ScalarStream {
  const name = steps[stop].name; // 'map' or a scalar-reduction 'local'
  const arg = steps[stop].args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) throw new Error(`${name}(traversal) required`);
  const inner = stepChain(arg.nested, st.params);
  const childCount = tryCompileCountChild(st, arg.nested);
  if (childCount) return childCount;
  const scalarChild = tryCompileScalarChild(st, arg.nested, name === 'local' ? 'all' : 'first');
  if (scalarChild) return scalarChild;
  const ctx = elemCtx(elemRel(st), st.elem);
  const sc = compileNestedScalar(inner, ctx);
  const n = elemRel(st);
  const p = st.rel.as('p');
  // Do not use `v IS NOT NULL` as a productivity test: constant(null) is a
  // productive null traverser. compileNestedScalar currently collapses an empty
  // child and a null value to the same SQL scalar; generic child lowering will
  // represent productivity as row presence and remove that ambiguity.
  const rel = st.q.cte(
    q`SELECT ${sc.expr} AS v${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`,
    ['v', ...carriedCols(st.carried)],
  );
  // A nested count() is always a Long (TinkerPop's count semantics); the SQLite
  // COUNT integer would otherwise infer as Int via anySerializer.
  const as: ValueType | undefined = inner[inner.length - 1]?.name === 'count' ? 'long' : undefined;
  return toScalarStream(carryOf(st), rel, as);
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
 * the traverser, per TinkerPop). The result is a ScalarStream, so a trailing
 * asNumber()/is()/order()/dedup()/limit()/barrier composes through common lowering.
 * Deferred (clear throws): a variable with no by() (bare incoming value — needs
 * local()/sack()), withSideEffect-bound variables, and reading project()/select()
 * map columns (math inside order().by(__.math(...))).
 */
export function lowerMath(st: ElementStream, steps: PStep[], stop: number): ScalarStream {
  const s = steps[stop];
  const formula = s.args[0];
  if (typeof formula !== 'string') throw new Error('math(string) required');
  const bys = s.bys ?? [];
  const varOrder = mathVars(formula);

  const p = st.rel.as('p');
  const cache = new Map<string, Expression>();
  const resolveVar = (name: string): Expression => {
    const hit = cache.get(name);
    if (hit) return hit;
    if (!bys.length) throw new Error(`math("${formula}"): variable "${name}" needs a by() modulator`);
    const byArgs = bys[varOrder.indexOf(name) % bys.length];
    let ctx: ScalarCtx;
    if (name === '_') ctx = elemCtx(elemRel(st), st.elem);
    else {
      const entry = st.carried.aliases.get(name);
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

  const n = elemRel(st);
  // Drop a non-productive by() or SQL domain-error result (both yield NULL).
  const rel = st.q.cte(
    q`SELECT ${mathExpr} AS v${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(mathExpr, undefined)}`,
    ['v', ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel, 'double');
}

// ---------- format() (per-traverser string templating) ----------

/**
 * format("…%{token}…") → one SQL string built by `||`-concatenating the literal parts
 * with each token's resolved value (SQLite `||` coerces to text, and a NULL operand
 * makes the whole result NULL — so a missing property filters the traverser, matching
 * FormatStep). A `%{_}` placeholder pulls the next by() modulator (round-robin, first-
 * seen order, like math); a `%{key}` placeholder reads the current element's property.
 * A format with no tokens is a constant string. Deferred: reading project()/select()
 * map columns, and the as()-alias fallback for a missing property. The resulting
 * ScalarStream composes through the common scalar dispatcher.
 */
export function lowerFormat(st: ElementStream, steps: PStep[], stop: number): ScalarStream {
  const s = steps[stop];
  const tmpl = s.args[0];
  if (typeof tmpl !== 'string') throw new Error('format(string) required');
  const bys = s.bys ?? [];
  const p = st.rel.as('p');
  const ctx = elemCtx(elemRel(st), st.elem);

  // Split into alternating literal / token parts. Each `||` operand is a bound literal
  // (a plain string) or a resolved value expression; concatenate them all.
  const re = /%\{([^}]*)\}/g;
  const pieces: Expression[] = [];
  let last = 0, m: RegExpExecArray | null, u = 0, hadToken = false;
  while ((m = re.exec(tmpl)) !== null) {
    if (m.index > last) pieces.push(q`${value(tmpl.slice(last, m.index))}`);
    const tok = m[1];
    hadToken = true;
    if (tok === '_') {
      if (!bys.length) throw new Error(`format("${tmpl}"): a %{_} placeholder needs a by() modulator`);
      const byArgs = bys[u++ % bys.length];
      const nested = byArgs.find((a: any) => a && typeof a === 'object' && 'nested' in a);
      const strKey = byArgs.find((a: any) => typeof a === 'string');
      if (nested) pieces.push(compileNestedScalar(stepChain(nested.nested, st.params), ctx).expr);
      else if (strKey !== undefined) pieces.push(scalarProp(ctx, strKey));
      else throw new Error(`format("${tmpl}"): a by() modulator must be a property key or a traversal`);
    } else {
      // A named token → the current element's property (first-under-multi for a node).
      pieces.push(scalarProp(ctx, tok));
    }
    last = m.index + m[0].length;
  }
  if (last < tmpl.length) pieces.push(q`${value(tmpl.slice(last))}`);
  // A constant template (no tokens) is one string literal; concatenating a single
  // piece is fine. Cast the first piece to TEXT so a lone value token frames as string.
  const expr = pieces.length ? q`CAST(${list(pieces, ' || ')} AS TEXT)` : q`${value('')}`;

  const n = elemRel(st);
  const where = hadToken ? q` WHERE ${predicateSql(expr, undefined)}` : q``;
  const rel = st.q.cte(
    q`SELECT ${expr} AS v${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}${where}`,
    ['v', ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel);
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
 * (constant/values/label/id via compileNestedScalar); element bodies and
 * Pick.unproductive/any defer. The CASE result is a composable ScalarStream.
 */
export function lowerChooseOptions(st: ElementStream, steps: PStep[], stop: number): ScalarStream {
  const cs = steps[stop];
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
  const p = st.rel.as('p');
  const rel = st.q.cte(
    q`SELECT CASE ${list(whens, ' ')} ELSE ${elseExpr} END AS v${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`,
    ['v', ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel);
}
