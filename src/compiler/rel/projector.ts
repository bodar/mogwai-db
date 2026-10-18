import { col, compilerNull, compilerReal, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { arg } from '../../gremlin/frontend.ts';
import { constLit } from './const.ts';
import { compileMath, mathVars, type MathOps } from '../../gremlin/math.ts';
import { FORMAT_FROM_BY, formatTemplate } from '../../gremlin/format.ts';
import { STATIC } from '../../sql/kernel/render.ts';
import type { Rel } from '../../rel/rel.ts';
import type { SqlType } from '../../rel/types.ts';
import type { IRStep } from '../ir/step.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import type { FramedRel, RelFraming } from './framing.ts';
import { byTyped, mapScopeMayHold, modulations, scopedHost, type Modulation } from './modulator.ts';
import { asStringOf, evidenceOf, FORMAT_STRING, mathVariableMessage, raisingWhen, receiverOffence, type ValueEvidence } from './receiver.ts';
import { deferralExpr, raiseInRow } from '../../rel/raise.ts';
import type { GraphSource } from './source.ts';
import { carriedCols, jsonField, meta, typeOf, type Minter } from './build.ts';
import { correlatedMapKey } from './map.ts';
import { boundBeyondMap } from './alias.ts';

/**
 * THE PER-TRAVERSER PROJECTORS — `math("<formula>")` and `format("…%{t}…")`.
 *
 * ONE MODULE BECAUSE THEY ARE ONE QUESTION: a small language over the traverser's SCOPE, evaluated
 * to a single value per row, with a productivity rule that drops the traverser when a reference does
 * not resolve. `MathStep` and `FormatStep` are the same shape upstream too — both `MapStep`,
 * `ByModulating`, `TraversalParent`, `Scoping`, `PathProcessor`, both driving a `TraversalRing`. What
 * actually differs is three fields (`projectorValue`), and the relation they land in is shared.
 *
 * ## The resolver is the by() vocabulary, not machinery of theirs
 *
 * A variable NAMES A HOST and a modulator PROJECTS a value out of it, so the whole resolver is
 * `scopedHost` (`modulator.ts`) composed with an unchanged `byTyped`. Three consequences, none of
 * them built: every host works (element, VALUE and RECORD, the last resolving against the
 * traverser's own map because that is what `Scoping.getScopeValue` tries first); a projector works
 * as a CHILD BODY wherever a child body is legal; and the `by()` vocabulary grows both at once.
 *
 * ## What each keeps of its own
 *
 * `math()`'s formula is `gremlin/math.ts`'s parse plus an OPS RECORD, because three of its twenty
 * functions are non-derivable SQL facts and an AST would make each site re-derive them (§6·4).
 * `format()`'s template is `gremlin/format.ts`'s part list, because a template part carries no such
 * fact — the shared form is as small as the shared content, in both directions.
 *
 * ## What DECLINES, and why each is the honest answer
 *
 * - **an identity projection over a non-VALUE host.** `_` with no `by()` is `traverser.get()`, and
 *   `MathStep` RAISES for one that is not a Number (*"The variable %s for math() step must resolve
 *   to a Number"*) while `FormatStep` appends its Java `toString()` (`v[1]`). Neither is a rowid, so
 *   projecting one would answer a different question — the single thing this layer may never do.
 * - **a comparator in the ring** (`by(Order.desc)`): both read a projection, and a `by()` that names
 *   only a direction projects nothing.
 * - anything `byExpr` or `scopedHost` declines, unchanged.
 *
 * `TraversalRing.next()` is ROUND-ROBIN and yields NOTHING for an empty ring, in which case
 * `TraversalUtil.produce` hands back the scoped value itself — so a `by()`-less `math("a + b")` over
 * labelled VALUES is well-formed and needs no modulator at all, and this answers it.
 */

/**
 * THE `Expr` SIDE of the ops record — the EMISSION half.
 *
 * Every leaf is a REAL because `math()` is all-double arithmetic: a variable is `CAST(… AS REAL)`
 * (which is what makes `/` real division rather than SQLite's integer division on integer operands)
 * and a literal inlines with an explicit decimal point. Both are COMPILER-authored constants, so
 * they spend none of the 100-parameter budget.
 */
const relMathOps = (resolve: (name: string) => Expr): MathOps<Expr> => ({
  variable: (name) => ({ kind: 'cast', arg: resolve(name), to: 'real' }),
  real: (text) => compilerReal(Number(text)),
  binary: (op, left, right) => op === '/'
    ? nonZeroDivisor(right, { kind: 'binary', op, left, right })
    : { kind: 'binary', op, left, right },
  // A multiply by −1.0, not SQLite's unary minus, which drops a ZERO's sign: exp4j negates a double, so
  // `math('-_')` of 0.0 is −0.0 (`Double.toString` prints `-0.0`, `Double.compare` orders it below 0.0).
  negate: (a) => ({ kind: 'binary', op: '*', left: a, right: compilerReal(-1) }),
  call: (fn, args) => fn === 'MOD' && args.length === 2
    ? nonZeroDivisor(args[1]!, { kind: 'call', fn, args })
    : { kind: 'call', fn, args },
  conditional: (whens, otherwise) => ({ kind: 'case', whens, else: otherwise }),
  compare: (op, left, right) => ({ kind: 'binary', op, left, right }),
  nul: () => compilerNull('real'),
});

/**
 * A DIVISION BY ZERO RAISES — exp4j's `/` and `%` operators throw `ArithmeticException("Division by
 * zero!")` on a zero divisor (`MathStep` evaluates its formula through exp4j's `Expression`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:68,89`),
 * where SQLite answers NULL and the projector's productivity filter then dropped the traverser as if
 * the formula had produced nothing. In-statement, because a formula can sit in a correlated `by()`.
 */
const nonZeroDivisor = (divisor: Expr, quotient: Expr): Expr =>
  // A non-zero LITERAL divisor (`_ / 2`) cannot raise, and saying so keeps the formula raise-free —
  // which is what spares an unread side-effect site the drain `mayRaise` would otherwise owe it.
  divisor.kind === 'lit' && typeof divisor.value === 'number' && divisor.value !== 0 ? quotient : ({
  kind: 'case',
  whens: [[{ kind: 'binary', op: '=', left: divisor, right: compilerReal(0) }, raiseInRow('Division by zero!')]],
  else: quotient,
});

/** TinkerPop's name for the current traverser inside a formula (`MathStep.CURRENT`). */
const CURRENT = '_';

/**
 * A `math()`/`format()` variable resolved to a SIDE-EFFECT CONSTANT — `withSideEffect('x', 100)` read
 * inside `math('_ + x')` — as an inlined typed literal, or `null` when the name is not a declared
 * side-effect. `Scoping.getScopeValue` consults the side-effects (before the path labels) for exactly
 * this; the registry the front-end extracted rides on the seam (`ChildSeam.sideEffects`), and a
 * `withSideEffect` seed is a compile-time constant, so it inlines at zero bind cost.
 *
 * Called only after `scopedHost` misses, which is sound because a name that is BOTH a path label and a
 * side effect never reaches a lowering: `compilePlan` declines it up front (`sideEffectShadowedLabel`,
 * `ir/labels.ts`), for this reader and every other scope reader at once.
 */
const sideEffectConst = (name: string, child: ChildSeam): Expr | null =>
  child.sideEffects.has(name) ? constLit(arg(child.sideEffects.get(name))) : null;

/**
 * The formula as ONE expression over the host traverser, or `null` to decline.
 *
 * Split from the tail below because a `math()` is not only a chain step: it is a child body
 * (`order().by(__.math('_ * 10'))`, `project('x').by(__.math('a + b'))`), and there the answer
 * wanted is the VALUE rather than a relation carrying it — `serviceValue`/`midCall`'s split, for
 * the same reason.
 */
export function mathValue(step: IRStep, host: ChildHost, child: ChildSeam, source: GraphSource, fresh: Minter): Expr | null {
  const formula = step.args[0]?.value, extra = step.args[1]?.value;
  if (typeof formula !== 'string' || extra !== undefined || step.optionArms) return null;
  const ring = modulations(step, (step.modulators ?? []).length, child);
  if (!ring) return null;
  const resolved = new Map<string, Expr>();
  const offences: (readonly [Expr, string])[] = [];
  const vars = mathVars(formula);
  for (const [at, name] of vars.entries()) {
    // The ring advances ONCE PER VARIABLE, in first-seen order, and wraps — so one `by()` feeds every
    // variable and N by()s feed N variables (`TraversalRing.next()`).
    const modulation: Modulation = ring.length ? ring[at % ring.length]! : { key: { kind: 'identity' } };
    if (modulation.order !== undefined) return null;
    const varHost = name === CURRENT ? host : scopedHost(name, host, true);
    if (!varHost) {
      // A side-effect CONSTANT (`withSideEffect('x', 100)` in `math('_ + x')`) resolves to an inlined
      // literal, taking no `by()`. Only after a path-label miss (see `sideEffectConst`).
      // Only a TRUE miss: where the host's own Map may hold the name, `scopedHost` declined and the
      // side effect behind it is not the answer (`mapScopeMayHold`).
      if (name !== CURRENT && mapScopeMayHold(host, name)) return null;
      const se = name === CURRENT ? null : sideEffectConst(name, child);
      if (!se) return null;
      // A side-effect constant is a compile-time value, so its Number-ness is decided here: anything
      // else is the reference's raise, and declining is the fail-closed half of it.
      const seeded = child.sideEffects.get(name);
      if (typeof seeded !== 'number' && typeof seeded !== 'bigint') return null;
      resolved.set(name, se);
      continue;
    }
    // An identity projection over an ELEMENT or a RECORD is the traverser itself, which is not a
    // Number — the reference raises rather than coercing, so decline instead of projecting a rowid.
    if (varHost.kind !== 'scalar' && modulation.key.kind === 'identity') return null;
    // EVERY VARIABLE MUST RESOLVE TO A NUMBER (`MathStep.java:80-87`), a productive null included — the
    // receiver authority decides it (`receiver.ts`): a refuted static type declines, a per-row one raises
    // the reference's message in-statement, so `math('_ + 1').by('name')` no longer answers `1.0`.
    // Each variable is TESTED ONCE ahead of the formula, in first-seen order (the order `MathStep`
    // resolves and raises in), because the formula spells a variable once per use.
    const typed = byTyped(modulation, varHost, source, fresh, child);
    if (!typed) return null;
    const offends = receiverOffence('number', typed.value, typed.evidence, typed.productiveNull);
    if (offends === false) return null;
    if (offends) offences.push([offends, mathVariableMessage(name)]);
    resolved.set(name, typed.value);
  }
  // Total by construction: every variable `compileMath` can ask for is one `mathVars` reported.
  return raisingWhen(offences, nanDeferred(compileMath(formula, relMathOps((name) => resolved.get(name)!)), [...resolved.values()]));
}

/** The deferral a formula whose answer SQLite leaves NULL raises (`nanDeferred`) — a NaN, or an infinity
 *  SQLite does not compute (`log(0)` is `-Infinity` in exp4j, NULL in SQLite). */
export const MATH_NAN = 'math() producing NaN or an infinity SQLite does not compute is not supported';

/**
 * A FORMULA WHOSE ANSWER IS NaN DECLINES. exp4j evaluates in Java `double`s, so `math('_ - _')` over
 * `Infinity`, `sqrt(-1)`, `log(-1)` and `0 * Infinity` are each the Double `NaN` (`MathStep.map`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:89`);
 * SQLite has no NaN and answers NULL, which the productivity filter then DROPPED as if the formula had
 * produced nothing — a row silently missing. A NULL formula is a NaN exactly when every variable it
 * reads is non-NULL (a NULL variable is an unproductive `by()`, the drop the filter is for), so that
 * arm raises a deferral instead. `COALESCE` spells the formula ONCE: its second argument is evaluated
 * only where the formula is NULL.
 */
const nanDeferred = (value: Expr, variables: readonly Expr[]): Expr => {
  const present = variables.map((v): Expr => ({ kind: 'binary', op: 'is not', left: v, right: compilerNull() }));
  const raise = deferralExpr(MATH_NAN, { kind: 'call', fn: 'random', args: [] });
  const nan: Expr = present.length
    ? { kind: 'case', whens: [[present.reduce((acc, p) => ({ kind: 'binary', op: 'and', left: acc, right: p })), raise]] }
    : raise;
  return { kind: 'call', fn: 'COALESCE', args: [value, nan] };
};


/** The deferral a named `format()` token raises where its property is absent and the scope it falls
 *  through to may hold the name in a form, or a place, this lowering cannot read. */
export const FORMAT_UNSEEN_SCOPE = 'format() of an absent property whose name a side effect or an unreachable path label may bind is not supported';

/** MAY A SCOPE THE ROW CANNOT SHOW BIND THIS NAME? — a side effect (a `withSideEffect` constant, a reducer
 *  policy or any keyed writer in the program) or a path label bound anywhere in it (`programScopeNames`).
 *  Asked only after `scopedHost` missed, so a label bound ON this row has already answered. */
const mayScope = (name: string, child: ChildSeam): boolean =>
  child.sideEffects.has(name) || child.scopeNames.sideEffects.has(name) || child.scopeNames.labels.has(name);

/** The reference's message for `Vertex.property(key)` over a key holding several values
 *  (`Vertex.Exceptions.multiplePropertiesExistForProvidedKey`, `.../gremlin/structure/Vertex.java:178-180`). */
export const multiplePropertiesMessage = (key: string): string =>
  `Multiple properties exist for the provided key, use Vertex.properties(${key})`;

/**
 * A VERTEX'S SINGLE-PROPERTY READ, raising where the key holds several values — `value` (the first value,
 * `by(key)`'s read) wherever the vertex has at most one. The count is the graph source's own
 * (`propertyHasSeveral`), so a bound or decorated graph answers it as the base tables do.
 */
const multiValueRaises = (several: Expr, key: string, value: Expr): Expr =>
  ({ kind: 'case', whens: [[several, raiseInRow(multiplePropertiesMessage(key))]], else: value });

/**
 * `format("…%{token}…")` — the template's tokens resolved and concatenated, or `null` to decline.
 *
 * `formatTemplate` (`gremlin/format.ts`) owns the PATTERN, which is the reference's verbatim; what
 * is here is the resolution, and it is a DIFFERENT precedence from `math()`'s in exactly one place:
 *
 * - **`%{_}` takes the next `by()`** off the ring, round-robin, and the ring advances only for `_`
 *   (`FormatStep.processNextStart` — a named token that resolves as a property never touches it).
 * - **`%{name}` is a PROPERTY FIRST, then a scope key.** The reference tries
 *   `((Element) current).property(varName)` and falls through to
 *   `getNullableScopeValue(Pop.last, varName, traverser)` with a NULL traversal — so a named token
 *   takes no `by()` at all, and `COALESCE(property, scoped)` is that fallthrough exactly. Over a
 *   non-element traverser the property branch is skipped (`current instanceof Element`), which is
 *   why a VALUE host reads the scope key directly.
 *
 * PRODUCTIVITY is the same one rule as `math()`'s and for a stronger reason here: the reference
 * filters on `!product.isProductive() || product.get() == null`, i.e. a productive-but-NULL token
 * filters too — and SQLite's `||` yields NULL if any operand is NULL, so the shared
 * `IS NOT NULL` on the result says both at once. A template with NO tokens is a constant and owes
 * no filter, which is why `tokens` is reported back.
 */
function formatValue(
  step: IRStep, host: ChildHost, child: ChildSeam, source: GraphSource, fresh: Minter,
): { readonly expr: Expr; readonly tokens: number; readonly keep?: Expr } | null {
  const template = step.args[0]?.value, extra = step.args[1]?.value;
  if (typeof template !== 'string' || extra !== undefined || step.optionArms) return null;
  const ring = modulations(step, (step.modulators ?? []).length, child);
  if (!ring) return null;
  // EVERY TOKEN IS `String.valueOf` of its value — `FormatStep` appends it with `StringBuilder.append(Object)`
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FormatStep.java:100,114`),
  // which is `asString()`'s question exactly, so it is answered by `asString()`'s ONE authority
  // (`asStringOf`, `receiver.ts`) from what is known of the token's type: a Double `1.0` is `1.0`, not
  // SQLite's `1`; a Boolean `true`, not `1`; a Float its shortest decimal. A token it cannot spell (a
  // list, a map, a Double outside the plain form) declines statically or raises a deferral per row —
  // never a raw `||` of SQLite's text. A NULL stays NULL, which is the productivity drop below.
  //
  // The rendering mentions its value and tag once per arm, so a CORRELATED READ (a stored property and
  // its `vtype`, a child body) is evaluated ONCE as the one row of a `VALUES` the rendering is projected
  // over — `typedNodeOnce`'s spelling (`build.ts`). Inline, one property token took a statement past
  // 20 KB, and a handful of them past the platform's 100 KB statement-text limit.
  const token = (value: Expr, evidence: ValueEvidence): Expr | null => {
    const tag = evidence.kind === 'tag' ? evidence.tag : undefined;
    if (value.kind !== 'scalar' && tag?.kind !== 'scalar') return asStringOf(value, evidence, fresh, FORMAT_STRING);
    const one = make.values({
      id: fresh('fto'), channels: [], type: typeOf(meta('v', 'any', true), meta('t', 'text', true)),
      rows: [[value, tag ?? compilerNull('text')]],
    });
    const rendered = asStringOf(col(one.id, 'v'), evidence.kind === 'tag' ? { ...evidence, tag: col(one.id, 't') } : evidence, fresh, FORMAT_STRING);
    return rendered && { kind: 'scalar', plan: make.project({
      id: fresh('ftp'), input: one, channels: [], type: typeOf(meta('s', 'text', true)), exprs: [['s', rendered]],
    }) };
  };
  const pieces: Expr[] = [];
  // Each token's RAW value: its rendering is NULL exactly where the value is (`asStringOf` maps NULL to
  // NULL and nothing else to it), so the productivity drop reads these rather than the rendered result —
  // a filter over the rendered column is inlined by the emitter and spells the whole rendering twice.
  const raws: Expr[] = [];
  let tokens = 0;
  let fromBy = 0;
  for (const part of formatTemplate(template)) {
    if (part.kind === 'literal') { pieces.push(compilerText(part.text)); continue; }
    tokens++;
    if (part.name === FORMAT_FROM_BY) {
      const modulation: Modulation = ring.length ? ring[fromBy++ % ring.length]! : { key: { kind: 'identity' } };
      if (modulation.order !== undefined) return null;
      // A bare `%{_}` over an ELEMENT appends the element's own `toString()` (`v[1]`), which is a
      // Java rendering no SQL expression reproduces — decline rather than emit a rowid.
      if (host.kind !== 'scalar' && modulation.key.kind === 'identity') return null;
      const typed = byTyped(modulation, host, source, fresh, child);
      if (!typed) return null;
      const shown = token(typed.value, typed.evidence);
      if (!shown) return null;
      pieces.push(shown);
      raws.push(typed.value);
      continue;
    }
    // A MAP host (`elementMap()`/`valueMap()`/`group()`) resolves a named token against its OWN entries
    // first (`Scoping`/`FormatStep`: a Map traverser is not an Element, so the property branch is skipped
    // and the map scope is read directly). Only a SCALAR value side concatenates; an absent key yields
    // NULL, which `||` propagates so the whole token poisons the result and drops the traverser — the
    // reference's productive-absent ("software drops out" of `elementMap().format(…)`). `scopeValue` has
    // no minter, so the correlated read is done here where `fresh` is in scope.
    if (host.kind === 'map') {
      if (host.valOf.kind !== 'scalar') return null;
      if (host.keys && !host.keys.includes(part.name)) return null;
      // An ABSENT key falls through to a same-named side effect or path label, not to a null token.
      if (!host.row || boundBeyondMap(part.name, host.row)) return null;
      // Rendered INSIDE the correlated read (`over`), so the per-row type test spells the matched pair's
      // column rather than re-running the read once per mention. A per-row tag never declines, but the
      // authority's `null` is honoured all the same.
      let renderable = true;
      const shown = correlatedMapKey(host.map, part.name, fresh, (node) => {
        const rendered = token(jsonField(node, 'v'), { kind: 'tag', tag: jsonField(node, 't') });
        if (!rendered) renderable = false;
        return rendered ?? node;
      }).node;
      if (!renderable) return null;
      pieces.push(shown);
      raws.push(jsonField(correlatedMapKey(host.map, part.name, fresh).node, 'v'));
      continue;
    }
    const scoped = scopedHost(part.name, host);
    // A scope key holding an ELEMENT has the same `toString()` problem; only a value concatenates.
    const scopedRaw = scoped?.kind === 'scalar' ? scoped.value : null;
    const scopedValue = scoped?.kind === 'scalar' ? token(scoped.value, evidenceOf(undefined, scoped.vtype)) : null;
    if (scopedRaw && !scopedValue) return null;
    if (host.kind === 'element') {
      // A raise message cannot carry the sentinel's closing mark, so such a key is not spelled at all.
      if (part.name.includes('!$')) return null;
      const typed = byTyped({ key: { kind: 'property', key: part.name } }, host, source, fresh, child);
      if (!typed) return null;
      // `((Element) current).property(varName)` THROWS over a vertex holding SEVERAL values for the key
      // (`Vertex.property`'s `multiplePropertiesExistForProvidedKey`,
      // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/Vertex.java:69-79`)
      // — so the token raises the reference's own message there, rather than appending the first value.
      const several = host.elem === 'vertex' ? source.propertyHasSeveral('vertex', host.id, part.name, fresh) : null;
      const value = several ? multiValueRaises(several, part.name, typed.value) : typed.value;
      const property = token(value, typed.evidence);
      if (!property) return null;
      // The reference falls through to the SCOPE only where the property is ABSENT, which is what COALESCE
      // says. Where the scope holds a value this cannot render (an ELEMENT, whose `toString()` is `v[1]`),
      // or MAY hold the name in a scope this resolver cannot see — a SIDE EFFECT (`Scoping` reads those
      // first; any keyed writer anywhere in the program registers one), a path label bound where the row
      // carries no channel for it — an absent property would DROP the traverser where the reference
      // appends the scoped value: a row silently missing. That fallthrough raises a deferral instead, and
      // a present property still answers exactly. The token is then never NULL, so it owes the
      // productivity drop nothing, but its raws still read the value: a multi-valued key raises wherever
      // the drop is evaluated, the reference's raise being unconditional.
      const unseen = !scopedValue && (scoped !== null || mayScope(part.name, child));
      const fallthrough = scopedValue ?? (unseen ? deferralExpr(FORMAT_UNSEEN_SCOPE, { kind: 'call', fn: 'random', args: [] }) : null);
      pieces.push(fallthrough ? { kind: 'call', fn: 'COALESCE', args: [property, fallthrough] } : property);
      if (scopedRaw) raws.push({ kind: 'call', fn: 'COALESCE', args: [value, scopedRaw] });
      else if (!unseen) raws.push(value);
      else if (value !== typed.value) raws.push({ kind: 'call', fn: 'COALESCE', args: [value, compilerText('')] });
      continue;
    }
    if (!scopedValue || !scopedRaw) return null;
    pieces.push(scopedValue);
    raws.push(scopedRaw);
  }
  // `concat_ws` SKIPS nulls, so it cannot be used here — a null token must poison the whole result,
  // which is precisely what `||` does and what the reference's `productive` flag means.
  const joined = pieces.length
    ? pieces.reduce((left, right) => ({ kind: 'binary', op: '||', left, right }))
    : compilerText('');
  // CAST so a lone value token frames as a string rather than as whatever it was stored as.
  const present = raws.map((raw): Expr => ({ kind: 'binary', op: 'is not', left: raw, right: compilerNull() }));
  const keep = present.length ? present.reduce((left, right) => ({ kind: 'binary', op: 'and', left, right })) : undefined;
  return { expr: { kind: 'cast', arg: joined, to: 'text' }, tokens, ...(keep ? { keep } : {}) };
}

/** The step names this module owns — the set a fold checks membership in BEFORE asking for a
 *  lowering, so an unlowerable member ends the run rather than falling through to some other arm's
 *  reading of it (`REL_TRANSFORMS`' rule, one family over). */
export const REL_PROJECTORS: ReadonlySet<string> = new Set(['math', 'format']);

/**
 * EITHER PROJECTOR'S VALUE, plus the three facts the relation and the wire need about it.
 *
 * The dispatch is here rather than at three call sites because `math()` and `format()` differ in
 * exactly these fields and in nothing else — same host vocabulary, same ring, same productivity
 * question. `drop` is the productivity rule: `math()` can always yield NULL (an unproductive `by()`
 * or a SQL domain error), while a token-free `format()` is a constant and owes no filter.
 *
 * Exported because a projector is not only a chain step: it is a child body
 * (`order().by(__.math('_ * 10'))`, `project('n').by(__.format('%{name}'))`), and there the answer
 * wanted is the VALUE rather than a relation carrying it — `serviceValue`/`midCall`'s split, for
 * the same reason.
 */
export function projectorValue(
  step: IRStep, host: ChildHost, child: ChildSeam, source: GraphSource, fresh: Minter,
): {
  readonly value: Expr; readonly drop: boolean; readonly sqlType: SqlType; readonly framing: RelFraming;
  /** The drop's predicate over the HOST's scope where it is cheaper than `value IS NOT NULL` (`format()`'s
   *  raw token values), so the filter does not spell the value a second time. */
  readonly keep?: Expr;
} | null {
  if (step.name === 'math') {
    const value = mathValue(step, host, child, source, fresh);
    // `math()` is ALWAYS a Double (`MathStep extends MapStep<S, Double>`), whatever the leaves held.
    return value && { value, drop: true, sqlType: 'real', framing: { kind: 'scalar', type: STATIC('double') } };
  }
  if (step.name !== 'format') return null;
  const produced = formatValue(step, host, child, source, fresh);
  // `format()` is ALWAYS a String (`FormatStep extends MapStep<S, String>`) — the reference's own
  // declared type, and the `CAST(… AS TEXT)` above is what makes the relation agree with it.
  return produced && {
    value: produced.expr, drop: produced.tokens > 0, sqlType: 'text',
    framing: { kind: 'scalar', type: STATIC('string') },
    ...(produced.keep ? { keep: produced.keep } : {}),
  };
}

/**
 * THE PER-TRAVERSER PROJECTORS as a relation — the value projected as `v`, and the traverser
 * DROPPED where it is NULL.
 *
 * One tail for both because past the value they are the same relation: a `Project` that replaces
 * the payload, and a `Filter` that spends the reference's productivity rule. The CHANNELS ride
 * through untouched — a projector changes the traverser's VALUE, not its identity, its
 * multiplicity or its position — which is what makes a following `is()`, `order()`, `sum()` or
 * `fold()` the ordinary scalar tail with nothing to know about formulae or templates.
 *
 * The filter is owed whenever the result CAN be null. `math()` always can (an unproductive `by()`,
 * or a SQL domain error like `SQRT(-1)`). `format()` can only when it has
 * a token at all, so a constant template emits every traverser.
 */
export function projectorTail(
  input: Rel, step: IRStep, host: ChildHost, child: ChildSeam, source: GraphSource, fresh: Minter,
): FramedRel | null {
  const produced = projectorValue(step, host, child, source, fresh);
  if (!produced) return null;
  const { value, drop, sqlType, framing } = produced;
  const carried = input.channels;
  // A projector-supplied `keep` rides as its own column for the filter to read: the emitter inlines a
  // projected column into the filter that reads it, so filtering on `v` would spell the value twice.
  const keep = drop ? produced.keep : undefined;
  const projected = make.project({
    id: fresh('pv'), input, channels: carried,
    type: keep ? typeOf(meta('v', sqlType, true), meta(KEEP_COL, 'int', true), ...carriedCols(carried))
      : typeOf(meta('v', sqlType, true), ...carriedCols(carried)),
    exprs: [['v', value], ...(keep ? [[KEEP_COL, keep] as const] : []), ...carried.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
  });
  const kept: Expr = keep ? col(projected.id, KEEP_COL) : { kind: 'binary', op: 'is not', left: col(projected.id, 'v'), right: compilerNull() };
  const rel = drop ? make.filter({ id: fresh('pf'), input: projected, channels: carried, type: projected.type, pred: kept }) : projected;
  return { rel, framing };
}

/** The column a projector's own drop predicate rides in between its `Project` and its `Filter`. */
const KEEP_COL = 'pkeep';
