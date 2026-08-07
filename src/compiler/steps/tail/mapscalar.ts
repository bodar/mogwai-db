import { q, list, value, type Expression } from '../../../sql/kernel/q.ts';
import {
    elemCtx, scalarProp, aliasCtx,
    predicateSql, scalarTx, type ScalarCtx, tokenExpr
} from '../../plan/plan.ts';
import { isNested, isPickArg, isTokenArg, argValues } from '../../../gremlin/frontend.ts';
import { mathToSql, mathVars } from '../../../gremlin/math.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { aliasElem, layoutProjection, layoutProjectionMinting, layoutCols, patchLayout, elemRel, type ElementStream } from '../context/context.ts';
import { aliasId, aliasScalar } from '../../plan/alias.ts';
import { loweringStateOf, toScalarStream, type ListStream, type ScalarStream, type Stream } from '../context/stream.ts';
import { tryCompileElementChild, tryCompileBranchChildAllCard, tryCompileListChild, tryCompileScalarModulations, tryCompileScalarValueChild, type ModulationFallback, type ScalarModulationSpec } from './child.ts';
import { childSteps, classifyByAt, optionMapIsCase, readOptionMapArms } from './child-shape.ts';
import { engineOf } from '../../engine/deps.ts';

// ---------- map (scalar body → per-traverser scalar projector) ----------

/** Element-valued map body through the generic child-domain compiler. Null means the
 * body is outside the currently origin-safe element vocabulary, so the scalar child
 * fast path (or its clear deferral) should handle it. */
export function tryLowerMapElement(st: ElementStream, step: IRStep): ElementStream | null {
  const arg = step.args[0].value;
  if (!isNested(arg)) return null;
  return tryCompileElementChild(st, arg.nested, 'first')?.stream ?? null;
}

/** local() consumes every row produced by one child invocation per incoming
 * traverser. The child compiler owns origin-partitioned element barriers, so local
 * no longer needs a movement-only parser or a private window implementation. */
export function tryLowerLocalElement(st: ElementStream, step: IRStep): ElementStream | null {
  const arg = step.args[0].value;
  if (!isNested(arg)) return null;
  return tryCompileElementChild(st, arg.nested, 'all')?.stream ?? null;
}

/** flatMap() consumes every productive child row. Keeping this next to map() makes
 * `first` versus `all` an explicit consumer policy over one child compiler, for both
 * element and scalar output shapes. */
export function tryLowerFlatMap(st: ElementStream, step: IRStep): Stream | null {
  const arg = step.args[0].value;
  if (!isNested(arg)) return null;
  return tryCompileElementChild(st, arg.nested, 'all')?.stream
    ?? tryCompileScalarValueChild(st, arg.nested, 'all')
    ?? tryCompileListChild(st, arg.nested)
    ?? tryCompileBranchChildAllCard(st, arg.nested); // a bare list-armed / mixed-shape branch (all-cardinality)
}

export function tryLowerListChild(st: ElementStream, step: IRStep): ListStream | null {
  const arg = step.args[0].value;
  if (!isNested(arg)) return null;
  return tryCompileListChild(st, arg.nested);
}

/**
 * map(__.<scalar>) → one relational scalar child per traverser. Element bodies are
 * attempted first through tryCompileElementChild; alias/select/fold bodies still
 * defer when they are neither an element child nor a supported scalar/list child.
 * The produced ScalarStream re-enters the common dispatcher, so scalar followers
 * compose without this leaf owning a private tail compiler.
 */
export function lowerMapScalar(st: ElementStream, steps: IRStep[], stop: number): ScalarStream {
  const name = steps[stop].name; // 'map' or a scalar-reduction 'local'
  const arg = steps[stop].args[0].value;
  if (!isNested(arg)) throw new Error(`${name}(traversal) required`);
  const child = tryCompileScalarValueChild(st, arg.nested, name === 'local' ? 'all' : 'first');
  if (child) return child;
  throw new Error(`${name}() child not supported by generic scalar lowering`);
}

// ---------- math (scalar arithmetic projector) ----------

/**
 * math("<formula>") → a per-traverser Double scalar. The formula (src/math.ts)
 * becomes one SQL arithmetic expression; its variables resolve here:
 *   - `_`        → the current traverser (elemCtx).
 *   - an alias   → an as()-bound traverser (aliasCtx over the carried rowid column).
 * Each variable's scalar value comes from its by() modulator (a property key or a
 * nested traversal, via the shared child-row compiler) — positional/round-robin over the
 * folded by()s in first-seen variable order, so a single by() feeds every variable
 * and N by()s feed N variables (matching project()). A missing by() value makes the
 * arithmetic NULL, so the traverser is filtered (a by() that produces nothing drops
 * the traverser, per TinkerPop). The result is a ScalarStream, so a trailing
 * asNumber()/is()/order()/dedup()/limit()/barrier composes through common lowering.
 * Deferred (clear throws): a variable with no by() (bare incoming value — needs
 * local()/sack()), withSideEffect-bound variables, and reading project()/select()
 * map columns (math inside order().by(__.math(...))).
 */
export function lowerMath(st: ElementStream, steps: IRStep[], stop: number): ScalarStream {
  const s = steps[stop];
  const formula = s.args[0].value;
  if (typeof formula !== 'string') throw new Error('math(string) required');
  const bys = s.modulators ?? [];
  const varOrder = mathVars(formula);

  const specs: ScalarModulationSpec[] = [];
  const resolved = new Map<string, { key?: string; mod?: number; col?: string; elem: ElementStream['elem'] }>();
  for (const name of varOrder) {
    if (!bys.length) throw new Error(`math("${formula}"): variable "${name}" needs a by() modulator`);
    const by = classifyByAt(bys, varOrder.indexOf(name));
    let col: string | undefined;
    let elem = st.elem;
    if (name !== '_') {
      const entry = st.traverserLayout.aliases.get(name);
      if (!entry) throw new Error(`math("${formula}"): no such variable "${name}" — as("${name}") was not seen`);
      col = entry.col;
      elem = aliasElem(entry);
    }
    if (by.kind === 'nested') {
      const mod = specs.length;
      specs.push({ nested: by.nested, rootCol: col, rootElem: elem, contract: 'produce' });
      resolved.set(name, { mod, col, elem });
    } else if (by.kind === 'key') resolved.set(name, { key: by.key, col, elem });
    else throw new Error(`math("${formula}"): by() modulator must be a property key or a traversal`);
  }

  const mods = specs.length ? tryCompileScalarModulations(st, specs) : null;
  if (specs.length && !mods) throw new Error(`math("${formula}"): traversal modulator not supported by generic child lowering`);
  const p = (mods?.rel ?? st.rel).as('p');
  const n = elemRel(st);
  const resolveVar = (name: string): Expression => {
    const r = resolved.get(name)!;
    if (r.mod !== undefined) return p.c[mods!.values[r.mod].value];
    const ctx: ScalarCtx = r.col ? aliasCtx(aliasId(p.c[r.col], 'last'), r.elem) : elemCtx(n, st.elem);
    return scalarProp(ctx, r.key!);
  };

  const mathExpr = mathToSql(formula, resolveVar);

  // Drop a non-productive by() or SQL domain-error result (both yield NULL).
  const rel = st.q.cte(
    q`SELECT ${mathExpr} AS v${layoutProjection(st.traverserLayout, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(mathExpr, undefined)}`,
    ['v', ...layoutCols(st.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(st), rel, 'double');
}

/**
 * math("<formula>") over a SCALAR parent. The current value `_` IS the scalar `v`; a named
 * variable is bound by a by()-modulator that runs against the value (a scalar sub-traversal),
 * resolved through the parent-polymorphic modulation seam — positional/round-robin over the
 * by()s in first-seen order, matching the element form. Result is a Double; a domain-error/
 * NULL (or a non-productive by()) drops the row. `_`-only formulae keep a fast path that
 * preserves the encounter column so a child-scope scalar math (e.g. a project field
 * `by(__.math('_*10'))`) composes with partitioned followers. Deferred (return null): a
 * variable with no by(), a property-key by() (a scalar has no properties).
 */
export function lowerMathScalar(s: ScalarStream, step: IRStep): ScalarStream | null {
  const formula = step.args[0].value;
  if (typeof formula !== 'string') return null;
  const bys = step.modulators ?? [];
  const varOrder = mathVars(formula);

  // Fast path: `_`-only, no by() — one expression straight over the value, encounter preserved.
  if (!bys.length && varOrder.every((name) => name === '_')) {
    const p = s.rel.as('p');
    const mathExpr = mathToSql(formula, () => p.c.v);
    const rel = s.q.cte(
      q`SELECT ${mathExpr} AS v${layoutProjection(s.traverserLayout, p)} FROM ${p} WHERE ${predicateSql(mathExpr, undefined)}`,
      ['v', ...layoutCols(s.traverserLayout)],
    );
    return toScalarStream(loweringStateOf(s), rel, 'double', { result: 'value' });
  }

  // Named variables → one scalar by()-child each, resolved against the value via the seam.
  const specs: ScalarModulationSpec[] = [];
  const resolved = new Map<string, number | undefined>(); // var → modulation index (undefined = `_`)
  for (const name of varOrder) {
    if (name === '_') { resolved.set(name, undefined); continue; }
    if (!bys.length) return null;
    const by = classifyByAt(bys, varOrder.indexOf(name));
    if (by.kind !== 'nested') return null; // a property-key by() has no scalar meaning
    resolved.set(name, specs.length);
    specs.push({ nested: by.nested, contract: 'produce' });
  }
  const mods = specs.length ? tryCompileScalarModulations(s, specs) : null;
  if (specs.length && !mods) return null;
  const p = (mods?.rel ?? s.rel).as('p');
  const resolveVar = (name: string): Expression => {
    const mod = resolved.get(name);
    return mod !== undefined ? p.c[mods!.values[mod].value] : p.c.v; // `_` = the value (idCol='v')
  };
  const mathExpr = mathToSql(formula, resolveVar);
  const rel = s.q.cte(
    q`SELECT ${mathExpr} AS v${layoutProjection(s.traverserLayout, p)} FROM ${p} WHERE ${predicateSql(mathExpr, undefined)}`,
    ['v', ...layoutCols(s.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(s), rel, 'double');
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
export function lowerFormat(st: ElementStream, steps: IRStep[], stop: number): ScalarStream {
  const s = steps[stop];
  const tmpl = s.args[0].value;
  if (typeof tmpl !== 'string') throw new Error('format(string) required');
  const bys = s.modulators ?? [];
  // Split into alternating literal / token parts. Each `||` operand is a bound literal
  // (a plain string) or a resolved value expression; concatenate them all.
  const re = /%\{([^}]*)\}/g;
  const specs: ScalarModulationSpec[] = [];
  const parts: ({ kind: 'literal'; text: string } | { kind: 'property'; key: string } | { kind: 'mod'; index: number })[] = [];
  let last = 0, m: RegExpExecArray | null, u = 0, hadToken = false;
  while ((m = re.exec(tmpl)) !== null) {
    if (m.index > last) parts.push({ kind: 'literal', text: tmpl.slice(last, m.index) });
    const tok = m[1];
    hadToken = true;
    if (tok === '_') {
      if (!bys.length) throw new Error(`format("${tmpl}"): a %{_} placeholder needs a by() modulator`);
      const by = classifyByAt(bys, u++);
      if (by.kind === 'nested') {
        const index = specs.length;
        specs.push({ nested: by.nested, contract: 'produce' });
        parts.push({ kind: 'mod', index });
      } else if (by.kind === 'key') parts.push({ kind: 'property', key: by.key });
      else throw new Error(`format("${tmpl}"): a by() modulator must be a property key or a traversal`);
    } else {
      // A named token → the current element's property (first-under-multi for a node).
      parts.push({ kind: 'property', key: tok });
    }
    last = m.index + m[0].length;
  }
  if (last < tmpl.length) parts.push({ kind: 'literal', text: tmpl.slice(last) });
  const mods = specs.length ? tryCompileScalarModulations(st, specs) : null;
  if (specs.length && !mods) throw new Error(`format("${tmpl}"): traversal modulator not supported by generic child lowering`);
  const p = (mods?.rel ?? st.rel).as('p');
  const n = elemRel(st);
  const ctx = elemCtx(n, st.elem);
  // A named token %{key} reads the current element's property, FALLING BACK to an as()-label
  // of the same name when the property is absent (e.g. software have no `age` property, so
  // `inject(1).as('age').V().format('…%{age}…')` yields the alias value 1). COALESCE gives the
  // property precedence; with no such label it is just the property (a missing one → NULL →
  // the traverser is filtered).
  const namedToken = (key: string): Expression => {
    const prop = scalarProp(ctx, key);
    const entry = st.traverserLayout.aliases.get(key);
    return entry ? q`COALESCE(${prop}, ${aliasScalar(p.c[entry.col], 'last')})` : prop;
  };
  const pieces = parts.map((part): Expression => part.kind === 'literal'
    ? q`${value(part.text)}`
    : part.kind === 'property'
      ? namedToken(part.key)
      : p.c[mods!.values[part.index].value]);
  // A constant template (no tokens) is one string literal; concatenating a single
  // piece is fine. Cast the first piece to TEXT so a lone value token frames as string.
  const expr = pieces.length ? q`CAST(${list(pieces, ' || ')} AS TEXT)` : q`${value('')}`;

  const where = hadToken ? q` WHERE ${predicateSql(expr, undefined)}` : q``;
  const rel = st.q.cte(
    q`SELECT ${expr} AS v${layoutProjection(st.traverserLayout, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}${where}`,
    ['v', ...layoutCols(st.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(st), rel);
}

/**
 * format("…%{token}…") over a SCALAR parent. The value has no properties, so a `%{key}`
 * named token has no meaning (defer); a `%{_}` placeholder pulls the next by()-modulator
 * (a scalar sub-traversal over the value, round-robin/first-seen like the element form), and
 * literals concatenate. A NULL operand makes the whole `||` NULL → the traverser is filtered
 * (matching FormatStep). A token-free template is a constant string. Returns null to defer
 * (a `%{key}` token, or a `%{_}` with no/property-key by()).
 */
export function lowerFormatScalar(s: ScalarStream, step: IRStep): ScalarStream | null {
  const tmpl = step.args[0].value;
  if (typeof tmpl !== 'string') return null;
  const bys = step.modulators ?? [];
  const re = /%\{([^}]*)\}/g;
  const specs: ScalarModulationSpec[] = [];
  const parts: ({ kind: 'literal'; text: string } | { kind: 'mod'; index: number })[] = [];
  let last = 0, m: RegExpExecArray | null, u = 0, hadToken = false;
  while ((m = re.exec(tmpl)) !== null) {
    if (m.index > last) parts.push({ kind: 'literal', text: tmpl.slice(last, m.index) });
    const tok = m[1];
    hadToken = true;
    if (tok !== '_') return null; // a %{key} token reads a property — a scalar has none
    if (!bys.length) return null;
    const by = classifyByAt(bys, u++);
    if (by.kind !== 'nested') return null; // a property-key by() has no scalar meaning
    parts.push({ kind: 'mod', index: specs.length });
    specs.push({ nested: by.nested, contract: 'produce' });
    last = m.index + m[0].length;
  }
  if (last < tmpl.length) parts.push({ kind: 'literal', text: tmpl.slice(last) });
  const mods = specs.length ? tryCompileScalarModulations(s, specs) : null;
  if (specs.length && !mods) return null;
  const p = (mods?.rel ?? s.rel).as('p');
  const pieces = parts.map((part): Expression => part.kind === 'literal'
    ? q`${value(part.text)}`
    : p.c[mods!.values[part.index].value]);
  const expr = pieces.length ? q`CAST(${list(pieces, ' || ')} AS TEXT)` : q`${value('')}`;
  const where = hadToken ? q` WHERE ${predicateSql(expr, undefined)}` : q``;
  const rel = s.q.cte(
    q`SELECT ${expr} AS v${layoutProjection(s.traverserLayout, p)} FROM ${p}${where}`,
    ['v', ...layoutCols(s.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(s), rel);
}

// ---------- concat() with TRAVERSAL arguments (the `apply` child-value contract) ----------

/**
 * `concat(<traversal>…)` over a scalar parent → each traversal argument's per-traverser value,
 * concatenated onto the incoming value in argument order.
 *
 * This is the `TraversalUtil.apply` contract (`ConcatStep extends ScalarMapStep`), which differs
 * from `format()`'s `TraversalUtil.produce` in exactly one respect that matters relationally: it
 * can NEVER filter. `ScalarMapStep.processNextStart` is `traverser.split(map(traverser), this)`
 * — strictly one row out per row in — and `prepare()` sets `setBulk(1L)` so a multi-row child
 * cannot multiply the parent either. Hence `contract: 'apply'` (a LEFT JOIN) and the seam's
 * standing `'first'` cardinality, which together are `apply`'s `traversal.next()`.
 *
 * The child's INPUT is the current traverser (`prepare` splits it in as the child's start), which
 * is why `concat(__.inject("c"))` yields `aa`/`bb` and not `ac`/`bc`: `inject()` PREPENDS to its
 * incoming stream, so the child's first result is the traverser's own value. That is TinkerPop's
 * documented behaviour, not an accident — `inject` was deliberately de-special-cased here (see
 * the CHANGELOG entry for "use TraversalUtil.apply on it as with any other child traversals").
 *
 * Returns null when there is no traversal argument (the string-only form is the pure-SQL leaf's
 * job, unchanged) or when the seam cannot compile one of the children — the caller then keeps its
 * clear deferral. Divergence, deliberate: TinkerPop RAISES on an unproductive child, where the
 * LEFT JOIN yields NULL, which `concat_ws` then skips. That errs toward a null/short answer rather
 * than fabricating a value TinkerPop would have rejected.
 */
export function lowerConcatScalar(s: ScalarStream, step: IRStep): ScalarStream | null {
  const args = argValues(step);
  if (!args.some(isNested)) return null; // string-only concat() — the scalarTx leaf handles it
  const specs: ScalarModulationSpec[] = args.filter(isNested).map((a: any) => ({ nested: a.nested, contract: 'apply' }));
  // The scalar-parent child vocabulary (a label re-root, a `V()`/`E()` re-source) lives in
  // scalar-arm.ts, which imports this file's neighbourhood — so rather than an upward import,
  // reach the SAME generic loop it uses (`Engine.lowerStepsStrict`, the one whole-body fold) over
  // the seam's own pushed seed. A body outside that vocabulary throws, which is a decline here.
  const viaEngine: ModulationFallback = (seed, nested) => {
    const body = childSteps(nested, s.params);
    if (!body.length) return null;
    // A bare `inject(…)` body is the INCOMING TRAVERSER, not the injected literals.
    // `InjectStep extends StartStep`, and `StartStep.processNextStart` APPENDS its injections to
    // the starts queue — while `TraversalUtil.prepare` has already added the split traverser. So
    // `next()` returns the traverser's own value and the literals are never reached, which is why
    // `g.inject("a","b").concat(__.inject("c"))` is `aa`/`bb` (Concat.feature) rather than
    // `ac`/`bc`, and why `concat(__.inject(["b","c"]))` is `aa`. Recognizing it here keeps that
    // TinkerPop rule in ONE place; lowering `inject` as an ordinary child would seed the literals
    // as the child's stream and answer a different question.
    if (body.length === 1 && body[0].name === 'inject') return seed.kind === 'scalar' ? seed : null;
    try {
      const end = engineOf(seed).lowerStepsStrict(seed, body as IRStep[], 0);
      return end.kind === 'scalar' ? end : null;
    } catch { return null; }
  };
  const mods = tryCompileScalarModulations(s, specs, viaEngine);
  if (!mods) return null;
  const p = mods.rel.as('p');
  // Substitute each traversal argument with its resolved modulation column, IN PLACE, so the
  // leaf sees the arguments in their original order. Non-nested args cannot occur alongside a
  // nested one (the grammar's two productions are mutually exclusive), but mapping positionally
  // rather than filtering keeps that a property of the grammar and not an assumption here.
  let i = 0;
  const resolved = args.map((a: any) => (isNested(a) ? p.c[mods.values[i++].value] : a));
  const expr = scalarTx('concat', resolved, p.c.v);
  if (!expr) throw new Error('concat() scalar transform not available');
  const rel = s.q.cte(
    q`SELECT ${expr} AS v${layoutProjection(s.traverserLayout, p)} FROM ${p}`,
    ['v', ...layoutCols(s.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(s), rel);
}

// ---------- dateDiff() with a traversal operand (the `apply` child-value contract) ----------

/**
 * `dateDiff(__.traversal)` reads exactly one date from the current traverser, just as
 * `DateDiffStep` calls `TraversalUtil.apply`.  The literal form remains a fused scalar
 * transform; this row boundary is only for the nested form, whose child needs a correlated
 * scope and must not filter its parent when it is unproductive.
 */
export function lowerDateDiffScalar(s: ScalarStream, step: IRStep): ScalarStream | null {
  const arg = step.args[0].value;
  if (!isNested(arg)) return null;
  const mods = tryCompileScalarModulations(s, [{ nested: arg.nested, contract: 'apply' }]);
  if (!mods) return null;
  const p = mods.rel.as('p');
  const other = p.c[mods.values[0].value];
  const rel = s.q.cte(
    q`SELECT (${p.c.v} - ${other}) AS v${layoutProjection(s.traverserLayout, p)} FROM ${p}`,
    ['v', ...layoutCols(s.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(s), rel, 'long');
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
 * (through the shared child-row compiler); element bodies and
 * Pick.unproductive/any defer. The CASE result is a composable ScalarStream.
 */
export function lowerChooseOptions(st: ElementStream, steps: IRStep[], stop: number): ScalarStream | null {
  const cs = steps[stop];
  const a0 = cs.args[0].value;
  // A CASE has exactly ONE fallthrough (its ELSE), so it can serve an option map only when the
  // map has exactly one too. Decline otherwise and the arm merge takes over.
  const arms = readOptionMapArms(cs, st.params);
  if (!arms) return null;
  //   · no `Pick.none` → unmatched inputs emit the ELEMENT (TinkerPop pass-through), which no
  //     single value column can carry;
  //   · a written `Pick.unproductive` → a SECOND fallthrough, keyed off the choice's PRESENCE
  //     rather than its value, which needs the merge's per-arm gating.
  if (!optionMapIsCase(arms)) return null;
  // KNOWN GAP, deliberately left here rather than fixed by declining more: when the choice can be
  // unproductive and only `Pick.none` is written, TinkerPop still emits the ELEMENT for the
  // unproductive inputs — `choose(values('age')).option(between(26,30),name).option(Pick.none,name)`
  // pins `v[lop]`/`v[ripple]`, and this ELSE answers 'lop'/'ripple' instead. Declining here IS
  // correct and the arm merge answers it properly, but the resulting VariantStream then has no
  // group()/groupCount() tail, which costs a scenario that filters the unproductive inputs out
  // anyway (`hasLabel('person').choose(age)…groupCount()`). Net zero, one regression — so the fix
  // is gated on group-over-a-variant. See docs/outstanding-work.md item 2.
  const specs: ScalarModulationSpec[] = [];
  let choiceMod: number | undefined;
  if (isNested(a0)) {
    choiceMod = specs.length;
    // An unproductive choice is still routed to Pick.none; it does not drop the
    // parent. The LEFT join therefore differs deliberately from by()-productivity.
    specs.push({ nested: a0.nested, contract: 'presence' });
  } else if (!isTokenArg(a0))
    throw new Error('choose() choice must be a traversal or a T token');

  const options: { key: any; mod: number; isNone: boolean }[] = [];
  let sawNone = false;
  for (const opt of cs.optionArms!) {
    const bodyArg = argValues(opt).find(isNested);
    if (!bodyArg) return null;
    const keyArg = argValues(opt).find((x: any) => x !== bodyArg);
    let isNone = false;
    if (keyArg === undefined || isPickArg(keyArg)) {
      const pick = isPickArg(keyArg) ? keyArg.pick : 'none';
      if (pick !== 'none') return null;
      isNone = true;
      if (sawNone) continue; // first Pick.none wins
      sawNone = true;
    }
    const mod = specs.length;
    specs.push({ nested: bodyArg.nested, contract: 'presence' });
    options.push({ key: keyArg, mod, isNone });
  }
  if (!options.some((x) => !x.isNone)) throw new Error('choose().option() needs at least one keyed option');
  // No Pick.none → unmatched inputs pass through as the ELEMENT itself (TinkerPop), so the result
  // is mixed scalar/element and no CASE over one value column can carry it. DECLINE (never throw):
  // the caller falls through to the generic arm-merge route, where the pass-through is simply an
  // element arm of the variant merge. Same for an option body the scalar child seam can't compile
  // (an element `__.out('knows')`, a `…fold()` list) — that is an arm, not a CASE branch.
  if (!sawNone) return null;
  const mods = tryCompileScalarModulations(st, specs);
  if (!mods) return null;
  const p = mods.rel.as('p');
  const n = elemRel(st);
  const ctx = elemCtx(n, st.elem);
  const choice = choiceMod !== undefined
    ? p.c[mods.values[choiceMod].value]
    : (() => {
      // `choiceMod` is absent only on the token branch above. Spell that proof again here
      // instead of relying on control-flow across the mutable index.
      if (!isTokenArg(a0)) throw new Error('choose() choice must be a traversal or a T token');
      return tokenExpr(ctx, a0.token) ?? (() => { throw new Error(`choose(T.${a0.token}) not yet supported`); })();
    })();
  const keyed = options.filter((x) => !x.isNone);
  const fallback = options.find((x) => x.isNone)!;
  const whens = keyed.map((x) => q`WHEN ${predicateSql(choice, x.key)} THEN ${p.c[mods.values[x.mod].value]}`);
  const productiveWhens = keyed.map((x) => q`WHEN ${predicateSql(choice, x.key)} THEN ${p.c[mods.values[x.mod].present]}`);
  const result = q`CASE ${list(whens, ' ')} ELSE ${p.c[mods.values[fallback.mod].value]} END`;
  const productive = q`CASE ${list(productiveWhens, ' ')} ELSE ${p.c[mods.values[fallback.mod].present]} END`;
  // A nested option-map child is still one scalar row per parent, but the generic
  // child cardinality policy needs an explicit per-origin encounter. Root option-map
  // choose() remains order-free; only mint when an active child scope needs first/all
  // semantics downstream.
  const origin = st.traverserLayout.origins.at(-1);
  const layout = origin && !st.traverserLayout.encounter
    ? patchLayout(st.traverserLayout, { encounter: 'encounter' })
    : st.traverserLayout;
  const encounter = layout.encounter && layout.encounter !== st.traverserLayout.encounter
    ? q`ROW_NUMBER() OVER (PARTITION BY ${p.c[origin!]} ORDER BY ${p.c.id})`
    : undefined;
  const rel = st.q.cte(
    q`SELECT ${result} AS v${encounter
      ? layoutProjectionMinting(layout, p, 'encounter', encounter)
      : layoutProjection(layout, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(productive, undefined)}`,
    ['v', ...layoutCols(layout)],
  );
  return toScalarStream(loweringStateOf(st, layout), rel);
}

/**
 * option-map choose over a SCALAR parent: `values(…).choose(choiceFn).option(k, body)…`. The
 * choice runs against the value `_`=v (a scalar sub-traversal — a T.label/id token has no
 * scalar meaning and defers); each keyed option and the Pick.none default are scalar value
 * bodies. Compiled through the same parent-polymorphic modulation seam as the element form
 * (tryCompileScalarModulations over the scalar parent — no element join, the value is the
 * domain). Returns null to DEFER (a scalar has no element/T-token choice, no Pick.none, a
 * non-scalar option body) so the caller falls through to the clear generic message.
 */
export function lowerChooseOptionsScalar(s: ScalarStream, steps: IRStep[], stop: number): ScalarStream | null {
  const cs = steps[stop];
  const a0 = cs.args[0].value;
  const specs: ScalarModulationSpec[] = [];
  if (!isNested(a0)) return null; // scalar choice must be a traversal over the value
  const choiceMod = specs.length;
  specs.push({ nested: a0.nested, contract: 'presence' });

  const options: { key: any; mod: number; isNone: boolean }[] = [];
  let sawNone = false;
  for (const opt of cs.optionArms ?? []) {
    const bodyArg = argValues(opt).find(isNested);
    if (!bodyArg) return null;
    const keyArg = argValues(opt).find((x: any) => x !== bodyArg);
    let isNone = false;
    if (keyArg === undefined || isPickArg(keyArg)) {
      const pick = isPickArg(keyArg) ? keyArg.pick : 'none';
      if (pick !== 'none') return null;
      isNone = true;
      if (sawNone) continue; // first Pick.none wins
      sawNone = true;
    }
    const mod = specs.length;
    specs.push({ nested: bodyArg.nested, contract: 'presence' });
    options.push({ key: keyArg, mod, isNone });
  }
  if (!options.some((x) => !x.isNone) || !sawNone) return null; // need a keyed option AND a Pick.none default
  const mods = tryCompileScalarModulations(s, specs);
  if (!mods) return null;
  const p = mods.rel.as('p');
  const choice = p.c[mods.values[choiceMod].value];
  const keyed = options.filter((x) => !x.isNone);
  const fallback = options.find((x) => x.isNone)!;
  const whens = keyed.map((x) => q`WHEN ${predicateSql(choice, x.key)} THEN ${p.c[mods.values[x.mod].value]}`);
  const productiveWhens = keyed.map((x) => q`WHEN ${predicateSql(choice, x.key)} THEN ${p.c[mods.values[x.mod].present]}`);
  const result = q`CASE ${list(whens, ' ')} ELSE ${p.c[mods.values[fallback.mod].value]} END`;
  const productive = q`CASE ${list(productiveWhens, ' ')} ELSE ${p.c[mods.values[fallback.mod].present]} END`;
  const rel = s.q.cte(
    q`SELECT ${result} AS v${layoutProjection(s.traverserLayout, p)} FROM ${p} WHERE ${predicateSql(productive, undefined)}`,
    ['v', ...layoutCols(s.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(s), rel);
}
