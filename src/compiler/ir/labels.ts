import { isNested, stepChain, type Step } from '../../gremlin/frontend.ts';
import { PATH_FAMILY, isStreamBarrier, type IRStep } from './step.ts';

// ---------- labels: who BINDS one, who READS one ----------
//
// One authority for the two questions the label retractions turn on, and they are not the same
// question: `as('a')` BINDS, `select('a')`/`where('a', P)`/`path().from('a')` READ. Both were
// answered privately before — `asLabelsOf`/`matchLabelsOf` lived in `strategies.ts` for
// `rewriteWhereEndLabels`' own use, and the read side had no whole-tree answer at all (the closest,
// `labelsMentioned` in `steps/tail/child-shape.ts`, never inspects `.modulators`, so a
// `by(__.select('a'))` is invisible to it).
//
// This module is pure step reasoning over a `Step[]` — no streams, no SQL, no Engine — for
// `productivity.ts`'s reason: `ir/` cannot import from `steps/` (the layering runs
// deps ◂ families ◂ engine ◂ compiler, and Passes run before dispatch), so the read scan cannot
// call the legacy one even where it would be right, and a second reading of the same fact is
// exactly how the two would drift.
//
// ## The read side FAILS CLOSED, and that is a design choice with a cost
//
// A precise reader list — "these step names, in these argument positions, reference a label" — is a
// closed enumeration only until the next step lands, and the failure mode of missing one is a live
// `as()` deleted and a WRONG ANSWER, silent at every layer. So the scan does not enumerate readers:
// **any string that appears as an argument anywhere in the tree may be a label read.** That over-
// retains (a chain binding `as('name')` and filtering `has('name', …)` keeps its label), which costs
// only a collapse this pass would otherwise have enabled — never correctness. A future step with a
// label argument needs no change here.
//
// The BIND side cannot be conservative the same way, because over-approximating a bind is what
// would license a deletion. It stays exact, and exactly two things bind: `as()` and a `match()`
// pattern's `as()`-wrapped ends.

/** PURE. The string labels an `as()` step binds (`as('a','b')` binds both). */
export const asLabelsOf = (s: Step): string[] =>
  s.name === 'as' ? (s.args ?? []).map((a) => a.value).filter((a: any): a is string => typeof a === 'string') : [];

/** PURE. The labels a `match()` step binds — the `as(start)`/`as(end)` wrapping each of its pattern
 *  arguments. A step's OWN `as()` is not the only way a label enters scope, and match() is the case
 *  that matters: it binds inside its arguments, so a chain that reads `where(__.as('c')…)` after a
 *  match() sees a label a naive pass would call unbound — even though the lowering carries the
 *  column perfectly well. Syntactic and shape-free, exactly like `asLabelsOf`: the pattern body is
 *  re-read with the same `stepChain` primitive every other scanner uses, and a FILTER argument
 *  (`not(…)`/`where(…)`, which binds nothing — see prefix/match.ts) contributes no label because it
 *  does not open with `as()`. */
export const matchLabelsOf = (s: Step, params: Record<string, any>): string[] => {
  if (s.name !== 'match') return [];
  const out: string[] = [];
  for (const { value: a } of s.args ?? []) {
    if (!isNested(a)) continue;
    const chain = stepChain(a.nested, params);
    if (chain[0]?.name !== 'as') continue;
    out.push(...asLabelsOf(chain[0]));
    if (chain.length > 1) out.push(...asLabelsOf(chain[chain.length - 1]));
  }
  return out;
};

/** What the whole tree READS. `all` is the fail-closed answer — every label is read, so no
 *  retraction is legal — and two things set it: a `path()`-family step (a Path carries the labels
 *  bound along it, so every label is observable in the result), and a nested body this scan could
 *  not parse. */
export interface LabelReads {
  readonly labels: ReadonlySet<string>;
  readonly all: boolean;
}

/** A label reference need not BE a string argument — it can be spelled INSIDE one. `math('b + a')`
 *  names two labels in one string (`steps/tail/mapscalar.ts` resolves each against the carried
 *  aliases and throws `no such variable` when one is missing), and `format()`'s `%{a}` tokens do the
 *  same. So every string contributes its identifier tokens as well as itself: measured, treating
 *  `'b + a'` as one opaque name is what made `retractUnreadAlias` delete a label `math()` then could
 *  not find. Tokenizing over-retains (a label named `name` stays live beside any `values('name')`),
 *  which costs a collapse and never an answer. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Every string reachable in an argument value, including through a predicate's operands. Deliberately
 *  indiscriminate — see the fail-closed note above. */
function collectStrings(value: any, into: Set<string>): void {
  if (typeof value === 'string') {
    into.add(value);
    if (value.length) for (const token of value.match(IDENTIFIER) ?? []) into.add(token);
    return;
  }
  if (value == null || typeof value !== 'object') return;
  if (isNested(value)) return; // a nested body is walked as a body, not scraped as a value
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, into); return; }
  // An `Arg` ({value,…}) and a `Pred` ({op, operands}) are the two shapes a label rides inside.
  if ('value' in value) collectStrings((value as any).value, into);
  if ('operands' in value) collectStrings((value as any).operands, into);
}

interface Acc { readonly labels: Set<string>; all: boolean }

/** Walk into every nested TRAVERSAL reachable in an argument value — mirroring `collectStrings`'
 *  shape, because a nested body hides in the same places a string does.
 *
 *  A PREDICATE OPERAND is the one that matters and the one a direct `isNested(arg.value)` test misses:
 *  in `has('age', gt(__.select('a').values('age')))` the argument IS the `Pred`, and the traversal
 *  reading the label sits inside its `operands`. Measured: scanning only the argument itself made that
 *  label look dead, and retracting it answered `[]` where `['josh','peter']` was expected. */
function descend(value: any, params: Record<string, any>, acc: Acc): void {
  if (isNested(value)) {
    let body: Step[];
    // A body needing params this scan does not have is a body whose reads are UNKNOWN. `verifyStandard`
    // may skip such a body because it never deletes anything; every caller here does, so the catch has
    // to fail closed instead of skipping.
    try { body = stepChain(value.nested, params); } catch { acc.all = true; return; }
    walkReads(body, params, acc);
    return;
  }
  if (value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) descend(v, params, acc); return; }
  if ('value' in value) descend((value as any).value, params, acc);
  if ('operands' in value) descend((value as any).operands, params, acc);
}

function walkReads(chain: readonly Step[], params: Record<string, any>, acc: Acc): void {
  for (const s of chain) {
    // `path()` emits the labels bound along it; `simplePath()`/`cyclicPath()` do not, but they share
    // the family's from()/to() scoping and cost nothing to treat alike.
    if (PATH_FAMILY.has(s.name)) acc.all = true;
    const ir = s as IRStep;
    // A `match()` PATTERN'S VARIABLES ARE READS OF THE ENCLOSING SCOPE, even though each is spelled
    // `as()`. `match(__.as('a').out().as('c'), …)` does not introduce a fresh `a` — it re-roots on
    // whatever `a` already holds, TinkerPop's variable-location rule, and `rewriteWhereEndLabels`
    // deliberately leaves a PATTERN argument's labels alone (only a match FILTER argument is
    // canonicalized to `select`/`where(P.eq)`). So the `as`-is-a-bind rule below would miss them.
    //
    // Measured: `g.V().as('a').out().as('b').match(__.as('a').out().count().as('c'),
    // __.as('b').in().count().as('c'))` answered at trunk and DEFERRED here, because both outer binds
    // were retracted as unread. `matchLabelsOf` is the same bind-side helper the pass uses, read here
    // from the other direction — inside a match, a variable's every mention is a use.
    if (s.name === 'match') for (const l of matchLabelsOf(s, params)) acc.labels.add(l);
    // An `as()` BINDS; a bind is not a read, and counting one would make every label read itself.
    // Liveness is therefore per label NAME rather than per bind site, which is also what makes a
    // REBIND (`as('a')…as('a')`, whose history a later `select(Pop.first)` can read back) safe: both
    // binds live or die together with the name.
    if (s.name !== 'as') for (const a of s.args ?? []) collectStrings(a.value, acc.labels);
    if (typeof ir.from === 'string') acc.labels.add(ir.from);
    if (typeof ir.to === 'string') acc.labels.add(ir.to);
    for (const m of ir.modulators ?? []) for (const v of m) { collectStrings(v, acc.labels); descend(v, params, acc); }
    for (const a of s.args ?? []) descend(a.value, params, acc);
    // The folded clusters are not in the chain that hosts them, so a scan that only walked `args`
    // would miss a `repeat()`'s own until()/emit() and a `choose()`'s arms entirely.
    if (ir.repeatRegion) walkReads(ir.repeatRegion, params, acc);
    if (ir.optionArms) walkReads(ir.optionArms, params, acc);
  }
}

/** Every label the tree reads, at any depth. */
export function labelReads(steps: readonly Step[], params: Record<string, any>): LabelReads {
  const acc: Acc = { labels: new Set<string>(), all: false };
  walkReads(steps, params, acc);
  return acc;
}

/** Does this step, or anything nested at any depth inside it, BARRIER the stream? Conservative on
 *  purpose: a barrier confined to a `where()` body does not consume the outer traverser's labels (the
 *  consumer-boundary asymmetry `steps/CLAUDE.md` documents), but distinguishing the hosts that pass a
 *  body's traverser outward from the ones that re-project the parent is a second question, and getting
 *  it wrong here licenses a deletion. Over-answering costs a retraction; under-answering costs an
 *  answer. */
function carriesBarrier(s: Step, params: Record<string, any>): boolean {
  if (isStreamBarrier(s as IRStep)) return true;
  const ir = s as IRStep;
  // Structural, for `descend`'s reason: a barrier can sit inside a nested traversal that is itself a
  // PREDICATE OPERAND rather than a bare argument.
  const nested = (value: any): boolean => {
    if (isNested(value)) {
      let body: Step[];
      try { body = stepChain(value.nested, params); } catch { return true; }
      return body.some((inner) => carriesBarrier(inner, params));
    }
    if (value == null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(nested);
    return (('value' in value) && nested((value as any).value))
      || (('operands' in value) && nested((value as any).operands));
  };
  if ((s.args ?? []).some((a) => nested(a.value))) return true;
  if ((ir.modulators ?? []).some((m) => m.some(nested))) return true;
  return [...(ir.repeatRegion ?? []), ...(ir.optionArms ?? [])].some((inner) => carriesBarrier(inner, params));
}

/** The labels bound UNCONDITIONALLY before `index` — collected from TOP-LEVEL steps only, which is
 *  what makes the answer unconditional rather than merely "bound somewhere". A bind inside a
 *  `choose()`/`coalesce()`/`optional()` arm holds only for traversers routed through that arm; one
 *  inside an unbounded `repeat()` body holds only for traversers that entered the loop, which is the
 *  walk-carried fact the `loops` channel models and not something a syntactic scan may assume. So
 *  this never descends to COLLECT — the omission IS the rule.
 *
 *  Filters and movements between the bind and the read do not weaken it: a filter reduces the
 *  population, it never un-binds a label on a survivor.
 *
 *  **A BARRIER DOES, and it clears the whole set.** `CHANNEL_BARRIER_POLICY` calls the `alias` role
 *  `consumed` — a reducing barrier emits a NEW traverser carrying no label — so a bind before one is
 *  not visible after it. Measured, as an answer rather than a plan:
 *  `g.V().as('x').values('age').union(__.min(), __.identity()).select('x').count()` is 4, not 5,
 *  BECAUSE `select('x')` drops the `min()` arm's traverser, whose label that arm's barrier ate. Treating
 *  the bind as still live made the presence filter look like a tautology and deleting it returned 5. */
export function labelsBoundBefore(steps: readonly Step[], index: number, params: Record<string, any>): ReadonlySet<string> {
  let bound = new Set<string>();
  for (let i = 0; i < index && i < steps.length; i++) {
    if (carriesBarrier(steps[i], params)) bound = new Set();
    for (const l of asLabelsOf(steps[i])) bound.add(l);
    for (const l of matchLabelsOf(steps[i], params)) bound.add(l);
  }
  return bound;
}

/**
 * Is the chain from `index` on a terminal that observes only CARDINALITY — never the traverser's
 * value? One name at a time, each with its own argument, exactly as `analyze.ts`'s collapse
 * terminals are:
 *
 * - **bare `count()`** — `CountGlobalStep.projectTraverser` returns `traverser.bulk()` and nothing
 *   else, so it is structurally incapable of reading the object it was handed
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CountGlobalStep.java:46`).
 * - **a stripped `discard()`/`iterate()`** — `DiscardStep.filter` returns `false` for every traverser
 *   (`.../step/filter/DiscardStep.java:35`), so the whole result is thrown away, cardinality
 *   included. This is STRONGER than the count case: nothing about the stream is observable at all.
 *
 * Deliberately absent, and each for a reason rather than for caution: `groupCount()` and `group()`
 * make whatever reaches them the group KEY; `sum`/`mean`/`min`/`max` need a VALUE to reduce (which is
 * why `analyze.ts` admits them only behind a scalar projection); `fold()` collects the values
 * themselves. There is no arrangement in which any of those sees a value and ignores it.
 */
export function cardinalityOnlyTerminalAt(steps: readonly Step[], index: number, discard: boolean): boolean {
  if (index === steps.length) return discard;
  const last = steps[index];
  return index === steps.length - 1 && last.name === 'count' && (last.args?.length ?? 0) === 0;
}
