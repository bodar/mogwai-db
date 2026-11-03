import type { ParamEnv } from '../../gremlin/param-env.ts';
import { collectionMembers, isNested, isPred, type Step } from '../../gremlin/frontend.ts';
import { eachChainDeep, rawBodies, valueNodes } from './walk.ts';

// ---------- uncarried-literal: a literal VALUE the substrate has no carrier for ----------
//
// Every value a traverser holds must keep its CLASS at every depth, or the traversal declines (build plan
// §6·7). One literal has no carrier at all, so no depth can keep it:
//
// - **NaN.** SQLite has no NaN — it stores one as NULL however it arrives — so a NaN traverser is a null
//   traverser to every later step: `inject(NaN, 1, NaN).fold()` framed `[null, null, 1]` where the reference
//   answers `[NaN, NaN, 1]`, `inject(NaN, 1).sum()` answered 1 where `NumberHelper.add` answers NaN, and
//   `constant(NaN)` framed null. A NaN is a `Double` (`Double.equals(NaN, NaN)` is true —
//   `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/util/AbstractTraverser.java:185-188`),
//   never a null.
//
// (A BigDecimal of NEGATIVE scale — `1e7m` — rides as its plain decimal text and frames at scale 0: the same
// value, a deliberate divergence in its scale, `docs/feature-support-matrix.md`.)
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

/** Does this argument value hold a NaN literal? */
const holdsNaN = (value: unknown): boolean => [...valueNodes(value)].some((node) => typeof node === 'number' && Number.isNaN(node));

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
function dropsNaNAsNull(step: Step | undefined, source: Step, params: ParamEnv): boolean {
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
export function uncarriedLiteral(steps: readonly Step[], params: ParamEnv): Step | null {
  let found: Step | null = null;
  eachChainDeep(steps, rawBodies(params), (chain) => {
    chain.forEach((s, i) => {
      if (found || OPERAND_STEPS.has(s.name)) return;
      const values = s.args.map((a) => a.value).filter((v) => !isPred(v));
      if (!values.some(holdsNaN)) return;
      // A NaN the next step drops as it drops a NULL is never observed.
      if ((s.name === 'inject' || s.name === 'constant') && dropsNaNAsNull(chain[i + 1], s, params)) return;
      found = s;
    });
  });
  return found;
}

// ---------- uncomparable-literal: a literal the substrate has no EQUALITY for ----------
//
// A map- or set-valued value is stored and compared as its JSON text, and a JSON object's entry order is
// the order the map was WRITTEN in — so `[a:1, b:2]` and `[b:2, a:1]`, one value to the reference
// (`LinkedHashMap.equals`/`AbstractSet.equals` are order-free, and `GremlinValueComparator` defers to them,
// `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java`),
// are two to SQL. An equality against one silently misses: `g.inject([b:2,a:[x:1,y:2]],[a:[y:2,x:1]])
// .mergeV()` created two vertices where the reference creates one. No canonicalising SQL is carried for it
// (a per-row re-sort of every stored map would also cost the index seek), so the QUERY TEXT that asks for
// such an equality declines, with the reason. A list is ordered both ways, so a list operand stays; only a
// map or set inside it declines. A parameter's value is resolved into its `Arg` through the `ParamEnv`, so
// `$m` is checked exactly like a literal — its content is the request, not the graph's size or contents.
// A value that arrives at RUN time (`values('m').mergeV()`) is not query text and is not seen here.

/** The explanatory decline a non-null `uncomparableLiteral` raises (`compiler.ts`). */
export const UNCOMPARABLE_LITERAL =
  'comparing a map- or set-valued value for equality is not supported: map entry order is not canonical, so equal maps written in different orders would not match';

/** Does this value hold — at any depth — a map or a set? */
const uncomparable = (value: unknown): boolean => [...valueNodes(value)].some((n) => n instanceof Map || n instanceof Set);

/** A bare collection argument of these steps is a MEMBERSHIP list, unrolled to its members
 *  (`GraphTraversal.hasId`/`hasValue`/`hasLabel`/`hasKey`), never one value compared whole. */
const MEMBERSHIP_STEPS: ReadonlySet<string> = new Set(['hasId', 'hasValue', 'hasLabel', 'hasKey']);

/** A list's or set's members; any other value as its own single member. */
const members = (value: unknown): unknown[] => (Array.isArray(value) || value instanceof Set ? [...value] : [value]);

/** Does predicate `p` compare an uncomparable operand for equality — an `eq`/`neq` operand, a
 *  `within`/`without` MEMBER (the collection itself is the membership list) — through its connectives? */
function comparesUncomparable(p: unknown): boolean {
  if (!isPred(p)) return false;
  switch (p.op) {
    case 'and': case 'or': case 'not': return p.operands.some((a) => comparesUncomparable(a.value));
    case 'eq': case 'neq': return p.operands.some((a) => uncomparable(a.value));
    case 'within': case 'without': {
      const only = p.operands.length === 1 ? p.operands[0]! : null;
      const list = only && (only.members || Array.isArray(only.value) || only.value instanceof Set)
        ? (only.value instanceof Set ? [...only.value] : collectionMembers(only).map((a) => a.value))
        : p.operands.map((a) => a.value);
      return list.some(uncomparable);
    }
    default: return false;
  }
}

/** Does a merge's MATCH criterion compare an uncomparable PROPERTY value? The criterion map itself is
 *  matched entry by entry, so only what an entry compares counts — and only a property (String-keyed)
 *  entry is a value comparison: a `T.label` Set is a label MEMBERSHIP list, a `T.id`/`Direction` entry an
 *  element. */
const criterionUncomparable = (criterion: unknown): boolean =>
  criterion instanceof Map && [...criterion].some(([k, v]) => typeof k === 'string' && uncomparable(v));

/** The match criteria a BARE `mergeV()`/`mergeE()` at `chain[i]` takes from the query text: each map an
 *  `inject(…)` right before it emits, or (through `unfold()`) each member of an injected list. */
function injectedCriteria(chain: readonly Step[], i: number): unknown[] {
  const prev = chain[i - 1];
  if (prev?.name === 'inject') return prev.args.map((a) => a.value);
  const source = chain[i - 2];
  if (prev?.name === 'unfold' && source?.name === 'inject') return source.args.flatMap((a) => members(a.value));
  return [];
}

/** The first step, at any depth, that compares a map- or set-valued literal or parameter for equality —
 *  `null` when there is none. A non-null answer is a DECLINE with `UNCOMPARABLE_LITERAL` (`compiler.ts`).
 *  Only a merge's MATCH criterion is read; an `onCreate`/`onMatch` map is written, never compared. */
export function uncomparableLiteral(steps: readonly Step[], params: ParamEnv): Step | null {
  let found: Step | null = null;
  eachChainDeep(steps, rawBodies(params), (chain) => {
    chain.forEach((s, i) => {
      if (found) return;
      const values = s.args.map((a) => a.value);
      const bare = OPERAND_STEPS.has(s.name)
        ? values.filter((v) => !isPred(v)).flatMap((v) => (MEMBERSHIP_STEPS.has(s.name) ? members(v) : [v])) : [];
      const criteria = s.name === 'mergeV' || s.name === 'mergeE'
        ? (s.args.length === 0 ? injectedCriteria(chain, i) : values.slice(0, 1)) : [];
      if (values.some(comparesUncomparable) || bare.some(uncomparable) || criteria.some(criterionUncomparable)) found = s;
    });
  });
  return found;
}
