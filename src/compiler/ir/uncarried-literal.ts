import { collectionMembers, isNested, isPred, type Step } from '../../gremlin/frontend.ts';
import { BigDecimal } from '../../gremlin/types.ts';
import { eachChainDeep, rawBodies, valueNodes } from './walk.ts';

// ---------- uncarried-literal: a literal VALUE the substrate has no carrier for ----------
//
// Every value a traverser holds must keep its CLASS at every depth, or the traversal declines (build plan
// §6·7). Two literals have no carrier at all, so no depth can keep them:
//
// - **NaN.** SQLite has no NaN — it stores one as NULL however it arrives — so a NaN traverser is a null
//   traverser to every later step: `inject(NaN, 1, NaN).fold()` framed `[null, null, 1]` where the reference
//   answers `[NaN, NaN, 1]`, `inject(NaN, 1).sum()` answered 1 where `NumberHelper.add` answers NaN, and
//   `constant(NaN)` framed null. A NaN is a `Double` (`Double.equals(NaN, NaN)` is true —
//   `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/util/AbstractTraverser.java:185-188`),
//   never a null.
// - **A BigDecimal of NEGATIVE scale** (`1e7m` is `new BigDecimal("1e7")`, unscaled 1, scale −7). Its
//   carrier is PLAIN decimal text (`BigDecimal.toString`, `src/gremlin/types.ts`), which cannot spell a
//   negative scale, so it would frame as scale 0 — a different `BigDecimal` on the wire and to
//   `asString()`. (A negative-scale widening a traversal COMPUTES rides as the REAL `BigDecimal.valueOf` carrier,
//   which every position reads at its scale — `doubleDecimalText`, `scalarFramedValue`; a LITERAL has no such carrier.)
//
// Only a VALUE position declines. A predicate OPERAND (`is(P.lt(NaN))`, `has('k', NaN)`, a `P` anywhere)
// is not a traverser — the predicate lowering reads it as the literal it is (`predicate.ts`). And a NaN
// that the very next step DROPS under the same verdict a NULL gets is never observed: `inject(NaN)
// .is(P.lt(1.0d))` is empty both ways, because a comparison with NaN is false
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java`,
// `Comparability.feature`'s NaN rows) and so is an ordering against a null. `lte`/`gte` against a null and
// `eq(null)` are TRUE for a null subject and false for NaN, so they are not in that set; neither is `neq`
// (true for NaN, which would then be observed). An `inject`'s leading `asBool()` folds over the literal
// NaN itself at compile time (`foldConstantCoercions` — `NaN` is `false`), so it observes nothing either.

/** A step whose bare-value arguments are predicate OPERANDS (`is(v)` is `is(P.eq(v))`, `has(k, v)`). */
const OPERAND_STEPS: ReadonlySet<string> = new Set(['is', 'has', 'hasValue', 'hasId', 'hasKey', 'hasLabel', 'hasNot', 'where']);

/** Does this argument value hold a literal with no carrier — a NaN, or a negative-scale BigDecimal? */
const holdsUncarried = (value: unknown): boolean => {
  for (const node of valueNodes(value)) {
    if (typeof node === 'number' && Number.isNaN(node)) return true;
    if (node instanceof BigDecimal && node.scale < 0) return true;
  }
  return false;
};

/**
 * A predicate's VERDICT over a NaN subject and over a NULL one — `undefined` where it is not decided here.
 * Every comparison with a NaN is false (`GremlinValueComparator.COMPARABILITY`: NaN equals nothing, NaN
 * included, and orders against nothing — `Comparability.feature`'s NaN rows); a NULL equals only a null and
 * orders (`lte`/`gte`) only against one. `within` is `eq` against each member, and the connectives compose
 * the two verdicts as they compose any other (`AndP`/`OrP`/`NotP`). `neq`/`without` are TRUE for a NaN,
 * so a NaN they keep is observed — they decide nothing here, by the caller's test below.
 */
function verdict(p: unknown, subject: 'nan' | 'null'): boolean | undefined {
  const isNullValue = (v: unknown): boolean => v === null || v === undefined;
  if (!isPred(p)) return isNullValue(p) ? subject === 'null' : false; // `is(v)` is `eq(v)`
  const operands = p.operands.map((a) => a.value);
  switch (p.op) {
    case 'and': case 'or': {
      const [left, right] = operands.map((o) => verdict(o, subject));
      if (left === undefined || right === undefined) return undefined;
      return p.op === 'and' ? left && right : left || right;
    }
    case 'not': {
      const inner = verdict(operands[0], subject);
      return inner === undefined ? undefined : !inner;
    }
    case 'eq': return operands.length === 1 ? subject === 'null' && isNullValue(operands[0]) : undefined;
    case 'lt': case 'gt': return operands.length === 1 ? false : undefined;
    case 'lte': case 'gte': return operands.length === 1 ? subject === 'null' && isNullValue(operands[0]) : undefined;
    case 'within': {
      const members = p.operands.length === 1 && (p.operands[0]!.members || Array.isArray(p.operands[0]!.value)) ? collectionMembers(p.operands[0]!).map((a) => a.value) : operands;
      return subject === 'null' && members.some(isNullValue);
    }
    default: return undefined;
  }
}

/** Does `step` DROP a NaN traverser under the verdict it gives a NULL one (see the module comment) — a
 *  filter FALSE for both, so neither is ever observed? An `is(p)`, or a `where`/`filter` whose whole body is
 *  one such `is`. */
function dropsNaNAsNull(step: Step | undefined, source: Step, params: Record<string, any>): boolean {
  if (!step) return false;
  if (step.name === 'asBool') return source.name === 'inject';
  if ((step.name === 'where' || step.name === 'filter') && step.args.length === 1 && isNested(step.args[0]!.value)) {
    const body = rawBodies(params)(step.args[0]!.value.nested);
    return body?.length === 1 ? dropsNaNAsNull(body[0], source, params) : false;
  }
  if (step.name !== 'is' || step.args.length !== 1) return false;
  const p = step.args[0]!.value;
  return verdict(p, 'nan') === false && verdict(p, 'null') === false;
}

/** The first step, at any depth, holding a literal VALUE no carrier keeps — `null` when there is none. A
 *  non-null answer is a DECLINE (`compiler.ts`). */
export function uncarriedLiteral(steps: readonly Step[], params: Record<string, any>): Step | null {
  let found: Step | null = null;
  eachChainDeep(steps, rawBodies(params), (chain) => {
    chain.forEach((s, i) => {
      if (found || OPERAND_STEPS.has(s.name)) return;
      const values = s.args.map((a) => a.value).filter((v) => !isPred(v));
      if (!values.some(holdsUncarried)) return;
      // A NaN the next step drops as it drops a NULL is never observed; a negative-scale BigDecimal is
      // observed by any consumer that frames or prints it, so it has no such exemption.
      const nanOnly = !values.some((v) => [...valueNodes(v)].some((n) => n instanceof BigDecimal && n.scale < 0));
      if (nanOnly && (s.name === 'inject' || s.name === 'constant') && dropsNaNAsNull(chain[i + 1], s, params)) return;
      found = s;
    });
  });
  return found;
}
