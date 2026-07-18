import { q, list, value, empty, type Expression } from '../q.ts';
import {
  elemCtx, scalarProp, aliasCtx, labelNameSub, predicateSql, type ScalarCtx,
} from '../plan.ts';
import { mathToSql, mathVars } from '../math.ts';
import { type PStep } from '../strategies.ts';
import { aliasElem, carryFrag, carriedCols, elemRel, type ElementStream } from './context.ts';
import { aliasId, aliasScalar } from './alias.ts';
import { carryOf, toScalarStream, type ListStream, type ScalarStream, type Stream } from './stream.ts';
import { tryCompileElementChild, tryCompileListChild, tryCompileScalarModulations, tryCompileScalarValueChild, type ScalarModulationSpec } from './child.ts';

// ---------- map (scalar body → per-traverser scalar projector) ----------

/** Element-valued map body through the generic child-domain compiler. Null means the
 * body is outside the currently origin-safe element vocabulary, so the scalar child
 * fast path (or its clear deferral) should handle it. */
export function tryLowerMapElement(st: ElementStream, step: PStep): ElementStream | null {
  const arg = step.args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  return tryCompileElementChild(st, arg.nested, 'first')?.stream ?? null;
}

/** local() consumes every row produced by one child invocation per incoming
 * traverser. The child compiler owns origin-partitioned element barriers, so local
 * no longer needs a movement-only parser or a private window implementation. */
export function tryLowerLocalElement(st: ElementStream, step: PStep): ElementStream | null {
  const arg = step.args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  return tryCompileElementChild(st, arg.nested, 'all')?.stream ?? null;
}

/** flatMap() consumes every productive child row. Keeping this next to map() makes
 * `first` versus `all` an explicit consumer policy over one child compiler, for both
 * element and scalar output shapes. */
export function tryLowerFlatMap(st: ElementStream, step: PStep): Stream | null {
  const arg = step.args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  return tryCompileElementChild(st, arg.nested, 'all')?.stream
    ?? tryCompileScalarValueChild(st, arg.nested, 'all')
    ?? tryCompileListChild(st, arg.nested);
}

export function tryLowerListChild(st: ElementStream, step: PStep): ListStream | null {
  const arg = step.args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  return tryCompileListChild(st, arg.nested);
}

/**
 * map(__.<scalar>) → one relational scalar child per traverser. Element bodies are
 * attempted first through tryCompileElementChild; alias/select/fold bodies still
 * defer when they are neither an element child nor a supported scalar/list child.
 * The produced ScalarStream re-enters the common dispatcher, so scalar followers
 * compose without this leaf owning a private tail compiler.
 */
export function lowerMapScalar(st: ElementStream, steps: PStep[], stop: number): ScalarStream {
  const name = steps[stop].name; // 'map' or a scalar-reduction 'local'
  const arg = steps[stop].args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) throw new Error(`${name}(traversal) required`);
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
export function lowerMath(st: ElementStream, steps: PStep[], stop: number): ScalarStream {
  const s = steps[stop];
  const formula = s.args[0];
  if (typeof formula !== 'string') throw new Error('math(string) required');
  const bys = s.bys ?? [];
  const varOrder = mathVars(formula);

  const specs: ScalarModulationSpec[] = [];
  const resolved = new Map<string, { key?: string; mod?: number; col?: string; elem: ElementStream['elem'] }>();
  for (const name of varOrder) {
    if (!bys.length) throw new Error(`math("${formula}"): variable "${name}" needs a by() modulator`);
    const byArgs = bys[varOrder.indexOf(name) % bys.length];
    let col: string | undefined;
    let elem = st.elem;
    if (name !== '_') {
      const entry = st.carried.aliases.get(name);
      if (!entry) throw new Error(`math("${formula}"): no such variable "${name}" — as("${name}") was not seen`);
      col = entry.col;
      elem = aliasElem(entry);
    }
    const nested = byArgs.find((a: any) => a && typeof a === 'object' && 'nested' in a);
    const strKey = byArgs.find((a: any) => typeof a === 'string');
    if (nested) {
      const mod = specs.length;
      specs.push({ nested: nested.nested, rootCol: col, rootElem: elem, required: true });
      resolved.set(name, { mod, col, elem });
    } else if (strKey !== undefined) resolved.set(name, { key: strKey, col, elem });
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
    q`SELECT ${mathExpr} AS v${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(mathExpr, undefined)}`,
    ['v', ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel, 'double');
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
export function lowerMathScalar(s: ScalarStream, step: PStep): ScalarStream | null {
  const formula = step.args[0];
  if (typeof formula !== 'string') return null;
  const bys = step.bys ?? [];
  const varOrder = mathVars(formula);

  // Fast path: `_`-only, no by() — one expression straight over the value, encounter preserved.
  if (!bys.length && varOrder.every((name) => name === '_')) {
    const p = s.rel.as('p');
    const mathExpr = mathToSql(formula, () => p.c.v);
    const enc = s.encounter ? q`, ${p.c[s.encounter]} AS ${s.encounter}` : empty;
    const rel = s.q.cte(
      q`SELECT ${mathExpr} AS v${enc}${carryFrag(s.carried, p)} FROM ${p} WHERE ${predicateSql(mathExpr, undefined)}`,
      ['v', ...(s.encounter ? [s.encounter] : []), ...carriedCols(s.carried)],
    );
    return toScalarStream(carryOf(s), rel, 'double', 'value', s.encounter);
  }

  // Named variables → one scalar by()-child each, resolved against the value via the seam.
  const specs: ScalarModulationSpec[] = [];
  const resolved = new Map<string, number | undefined>(); // var → modulation index (undefined = `_`)
  for (const name of varOrder) {
    if (name === '_') { resolved.set(name, undefined); continue; }
    if (!bys.length) return null;
    const byArgs = bys[varOrder.indexOf(name) % bys.length];
    const nested = byArgs.find((a: any) => a && typeof a === 'object' && 'nested' in a);
    if (!nested) return null; // a property-key by() has no scalar meaning
    resolved.set(name, specs.length);
    specs.push({ nested: nested.nested, required: true });
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
    q`SELECT ${mathExpr} AS v${carryFrag(s.carried, p)} FROM ${p} WHERE ${predicateSql(mathExpr, undefined)}`,
    ['v', ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel, 'double');
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
      const byArgs = bys[u++ % bys.length];
      const nested = byArgs.find((a: any) => a && typeof a === 'object' && 'nested' in a);
      const strKey = byArgs.find((a: any) => typeof a === 'string');
      if (nested) {
        const index = specs.length;
        specs.push({ nested: nested.nested, required: true });
        parts.push({ kind: 'mod', index });
      } else if (strKey !== undefined) parts.push({ kind: 'property', key: strKey });
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
    const entry = st.carried.aliases.get(key);
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
    q`SELECT ${expr} AS v${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}${where}`,
    ['v', ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel);
}

/**
 * format("…%{token}…") over a SCALAR parent. The value has no properties, so a `%{key}`
 * named token has no meaning (defer); a `%{_}` placeholder pulls the next by()-modulator
 * (a scalar sub-traversal over the value, round-robin/first-seen like the element form), and
 * literals concatenate. A NULL operand makes the whole `||` NULL → the traverser is filtered
 * (matching FormatStep). A token-free template is a constant string. Returns null to defer
 * (a `%{key}` token, or a `%{_}` with no/property-key by()).
 */
export function lowerFormatScalar(s: ScalarStream, step: PStep): ScalarStream | null {
  const tmpl = step.args[0];
  if (typeof tmpl !== 'string') return null;
  const bys = step.bys ?? [];
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
    const byArgs = bys[u++ % bys.length];
    const nested = byArgs.find((a: any) => a && typeof a === 'object' && 'nested' in a);
    if (!nested) return null; // a property-key by() has no scalar meaning
    parts.push({ kind: 'mod', index: specs.length });
    specs.push({ nested: nested.nested, required: true });
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
    q`SELECT ${expr} AS v${carryFrag(s.carried, p)} FROM ${p}${where}`,
    ['v', ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel);
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
export function lowerChooseOptions(st: ElementStream, steps: PStep[], stop: number): ScalarStream {
  const cs = steps[stop];
  const a0 = cs.args[0];
  const specs: ScalarModulationSpec[] = [];
  let choiceMod: number | undefined;
  if (a0 && typeof a0 === 'object' && 'nested' in a0) {
    choiceMod = specs.length;
    // An unproductive choice is still routed to Pick.none; it does not drop the
    // parent. The LEFT join therefore differs deliberately from by()-productivity.
    specs.push({ nested: a0.nested, required: false });
  } else if (!(a0 && typeof a0 === 'object' && 'token' in a0))
    throw new Error('choose() choice must be a traversal or a T token');

  const options: { key: any; mod: number; isNone: boolean }[] = [];
  let sawNone = false;
  for (const opt of cs.options!) {
    const bodyArg = opt.args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
    if (!bodyArg) throw new Error('option() requires a traversal body');
    const keyArg = opt.args.find((x: any) => x !== bodyArg);
    let isNone = false;
    if (keyArg === undefined || (keyArg && typeof keyArg === 'object' && 'pick' in keyArg)) {
      const pick = keyArg && typeof keyArg === 'object' && 'pick' in keyArg ? keyArg.pick : 'none';
      if (pick !== 'none') throw new Error(`option(Pick.${pick}) not yet supported`);
      isNone = true;
      if (sawNone) continue; // first Pick.none wins
      sawNone = true;
    }
    const mod = specs.length;
    specs.push({ nested: bodyArg.nested, required: false });
    options.push({ key: keyArg, mod, isNone });
  }
  if (!options.some((x) => !x.isNone)) throw new Error('choose().option() needs at least one keyed option');
  // No Pick.none → unmatched inputs are the element itself (mixed vertex/scalar): defer.
  if (!sawNone) throw new Error('choose().option() without a Pick.none default not yet supported (unmatched pass-through is mixed-shape)');
  const mods = tryCompileScalarModulations(st, specs);
  if (!mods) throw new Error('choose().option() traversal not supported by generic scalar child lowering');
  const p = mods.rel.as('p');
  const n = elemRel(st);
  const ctx = elemCtx(n, st.elem);
  const choice = choiceMod !== undefined
    ? p.c[mods.values[choiceMod].value]
    : a0.token === 'label' ? labelNameSub(ctx.labelIdExpr)
      : a0.token === 'id' ? ctx.extIdExpr!
      : (() => { throw new Error(`choose(T.${a0.token}) not yet supported`); })();
  const keyed = options.filter((x) => !x.isNone);
  const fallback = options.find((x) => x.isNone)!;
  const whens = keyed.map((x) => q`WHEN ${predicateSql(choice, x.key)} THEN ${p.c[mods.values[x.mod].value]}`);
  const productiveWhens = keyed.map((x) => q`WHEN ${predicateSql(choice, x.key)} THEN ${p.c[mods.values[x.mod].present]}`);
  const result = q`CASE ${list(whens, ' ')} ELSE ${p.c[mods.values[fallback.mod].value]} END`;
  const productive = q`CASE ${list(productiveWhens, ' ')} ELSE ${p.c[mods.values[fallback.mod].present]} END`;
  const rel = st.q.cte(
    q`SELECT ${result} AS v${carryFrag(st.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(productive, undefined)}`,
    ['v', ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel);
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
export function lowerChooseOptionsScalar(s: ScalarStream, steps: PStep[], stop: number): ScalarStream | null {
  const cs = steps[stop];
  const a0 = cs.args[0];
  const specs: ScalarModulationSpec[] = [];
  if (!(a0 && typeof a0 === 'object' && 'nested' in a0)) return null; // scalar choice must be a traversal over the value
  const choiceMod = specs.length;
  specs.push({ nested: a0.nested, required: false });

  const options: { key: any; mod: number; isNone: boolean }[] = [];
  let sawNone = false;
  for (const opt of cs.options ?? []) {
    const bodyArg = opt.args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
    if (!bodyArg) return null;
    const keyArg = opt.args.find((x: any) => x !== bodyArg);
    let isNone = false;
    if (keyArg === undefined || (keyArg && typeof keyArg === 'object' && 'pick' in keyArg)) {
      const pick = keyArg && typeof keyArg === 'object' && 'pick' in keyArg ? keyArg.pick : 'none';
      if (pick !== 'none') return null;
      isNone = true;
      if (sawNone) continue; // first Pick.none wins
      sawNone = true;
    }
    const mod = specs.length;
    specs.push({ nested: bodyArg.nested, required: false });
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
    q`SELECT ${result} AS v${carryFrag(s.carried, p)} FROM ${p} WHERE ${predicateSql(productive, undefined)}`,
    ['v', ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel);
}
