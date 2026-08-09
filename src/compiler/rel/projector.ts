import { col, compilerNull, compilerReal, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { argValues } from '../../gremlin/frontend.ts';
import { compileMath, mathVars, type MathOps } from '../../gremlin/math.ts';
import { FORMAT_FROM_BY, formatTemplate } from '../../gremlin/format.ts';
import { STATIC } from '../../sql/kernel/render.ts';
import type { Rel } from '../../rel/rel.ts';
import type { SqlType } from '../../rel/types.ts';
import type { IRStep } from '../ir/step.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import type { FramedRel, RelFraming } from './framing.ts';
import { byExpr, modulations, scopedHost, type Modulation } from './modulator.ts';
import { carriedCols, meta, typeOf, type Minter } from './build.ts';

/**
 * THE PER-TRAVERSER PROJECTORS — `math("<formula>")` and `format("…%{t}…")`.
 *
 * ONE MODULE BECAUSE THEY ARE ONE QUESTION: a small language over the traverser's SCOPE, evaluated
 * to a single value per row, with a productivity rule that drops the traverser when a reference does
 * not resolve. `MathStep` and `FormatStep` are the same shape upstream too — both `MapStep`,
 * `ByModulating`, `TraversalParent`, `Scoping`, `PathProcessor`, both driving a `TraversalRing` — and
 * legacy's own header called them one section while giving each its own copy of the ring, the
 * resolution and the projection. What actually differs is three fields (`projectorValue`), and the
 * relation they land in is shared.
 *
 * ## The resolver is the by() vocabulary, not machinery of theirs
 *
 * A variable NAMES A HOST and a modulator PROJECTS a value out of it, so the whole resolver is
 * `scopedHost` (`modulator.ts`) composed with an unchanged `byExpr`. Three consequences, none of
 * them built: every host works (element, VALUE and RECORD, the last resolving against the
 * traverser's own map because that is what `Scoping.getScopeValue` tries first); a projector works
 * as a CHILD BODY wherever a child body is legal; and the `by()` vocabulary grows both at once.
 *
 * ## What each keeps of its own
 *
 * `math()`'s formula is `gremlin/math.ts`'s parse plus an OPS RECORD, because three of its twenty
 * functions are non-derivable SQL facts and an AST would make each spine re-derive them (§6·4).
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
 * labelled VALUES is well-formed and needs no modulator at all. Legacy throws there; this answers,
 * which is §6·1's "the floor is the union" rather than a divergence to reconcile.
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
 *   why a VALUE host reads the scope key directly rather than declining as legacy does.
 *
 * PRODUCTIVITY is the same one rule as `math()`'s and for a stronger reason here: the reference
 * filters on `!product.isProductive() || product.get() == null`, i.e. a productive-but-NULL token
 * filters too — and SQLite's `||` yields NULL if any operand is NULL, so the shared
 * `IS NOT NULL` on the result says both at once. A template with NO tokens is a constant and owes
 * no filter, which is why `tokens` is reported back.
 */
function formatValue(
  step: IRStep, host: ChildHost, child: ChildSeam, fresh: Minter,
): { readonly expr: Expr; readonly tokens: number } | null {
  const [template, extra] = argValues(step);
  if (typeof template !== 'string' || extra !== undefined || step.optionArms) return null;
  const ring = modulations(step, (step.modulators ?? []).length, child);
  if (!ring) return null;
  const pieces: Expr[] = [];
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
      const value = byExpr(modulation, host, fresh, false, child);
      if (!value) return null;
      pieces.push(value);
      continue;
    }
    const scoped = scopedHost(part.name, host);
    // A scope key holding an ELEMENT has the same `toString()` problem; only a value concatenates.
    const scopedValue = scoped?.kind === 'scalar' ? scoped.value : null;
    if (host.kind === 'element') {
      const property = byExpr({ key: { kind: 'property', key: part.name } }, host, fresh, false, child);
      if (!property) return null;
      // The reference falls through only when the property is ABSENT, which is what COALESCE says.
      pieces.push(scopedValue ? { kind: 'call', fn: 'COALESCE', args: [property, scopedValue] } : property);
      continue;
    }
    if (!scopedValue) return null;
    pieces.push(scopedValue);
  }
  // `concat_ws` SKIPS nulls, so it cannot be used here — a null token must poison the whole result,
  // which is precisely what `||` does and what the reference's `productive` flag means.
  const joined = pieces.length
    ? pieces.reduce((left, right) => ({ kind: 'binary', op: '||', left, right }))
    : compilerText('');
  // CAST so a lone value token frames as a string rather than as whatever it was stored as.
  return { expr: { kind: 'cast', arg: joined, to: 'text' }, tokens };
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
  step: IRStep, host: ChildHost, child: ChildSeam, fresh: Minter,
): { readonly value: Expr; readonly drop: boolean; readonly sqlType: SqlType; readonly framing: RelFraming } | null {
  if (step.name === 'math') {
    const value = mathValue(step, host, child, fresh);
    // `math()` is ALWAYS a Double (`MathStep extends MapStep<S, Double>`), whatever the leaves held.
    return value && { value, drop: true, sqlType: 'real', framing: { kind: 'scalar', type: STATIC('double') } };
  }
  if (step.name !== 'format') return null;
  const produced = formatValue(step, host, child, fresh);
  // `format()` is ALWAYS a String (`FormatStep extends MapStep<S, String>`) — the reference's own
  // declared type, and the `CAST(… AS TEXT)` above is what makes the relation agree with it.
  return produced && {
    value: produced.expr, drop: produced.tokens > 0, sqlType: 'text',
    framing: { kind: 'scalar', type: STATIC('string') },
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
 * or a SQL domain error like `SQRT(-1)` — which legacy drops too). `format()` can only when it has
 * a token at all, so a constant template emits every traverser.
 */
export function projectorTail(
  input: Rel, step: IRStep, host: ChildHost, child: ChildSeam, fresh: Minter,
): FramedRel | null {
  const produced = projectorValue(step, host, child, fresh);
  if (!produced) return null;
  const { value, drop, sqlType, framing } = produced;
  const carried = input.channels;
  const projected = make.project({
    id: fresh('pv'), input, channels: carried,
    type: typeOf(meta('v', sqlType, true), ...carriedCols(carried)),
    exprs: [['v', value], ...carried.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
  });
  const rel = drop
    ? make.filter({
      id: fresh('pf'), input: projected, channels: carried, type: projected.type,
      pred: { kind: 'binary', op: 'is not', left: col(projected.id, 'v'), right: compilerNull() },
    })
    : projected;
  return { rel, framing };
}
