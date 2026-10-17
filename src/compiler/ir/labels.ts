import { isNested, stepChain, type Step } from '../../gremlin/frontend.ts';
import { PATH_FAMILY, isStreamBarrier, type IRStep } from './step.ts';
import { eachChainDeep, eachChildChain, eachStepDeep, rawBodies, someStepDeep, valueNodes, type BodyReader } from './walk.ts';

// ---------- labels: who BINDS one, who READS one ----------
//
// One authority for the two questions the label retractions turn on, and they are not the same
// question: `as('a')` BINDS, `select('a')`/`where('a', P)`/`path().from('a')` READ. Both were
// answered privately before — `asLabelsOf`/`matchLabelsOf` lived in `strategies.ts` for
// `rewriteWhereEndLabels`' own use, and the read side had no whole-tree answer at all.
//
// This module is pure step reasoning over a `Step[]` — no streams, no SQL, no Engine — because a
// Pass runs before dispatch and cannot reach a lowering's helpers, and a second reading of the same
// fact is exactly how the two would drift.
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
 *  names two labels in one string (each is resolved against the carried aliases, throwing `no such
 *  variable` when one is missing), and `format()`'s `%{a}` tokens do the
 *  same. So every string contributes its identifier tokens as well as itself: measured, treating
 *  `'b + a'` as one opaque name is what made `retractUnreadAlias` delete a label `math()` then could
 *  not find. Tokenizing over-retains (a label named `name` stays live beside any `values('name')`),
 *  which costs a collapse and never an answer. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Every string reachable in an argument value, including through a predicate's operands. Deliberately
 *  indiscriminate — see the fail-closed note above. */
function collectStrings(value: unknown, into: Set<string>): void {
  for (const n of valueNodes(value)) {
    if (typeof n !== 'string') continue;
    into.add(n);
    if (n.length) for (const token of n.match(IDENTIFIER) ?? []) into.add(token);
  }
}

interface Acc { readonly labels: Set<string>; all: boolean }

/** Every `as()` label reachable at ANY depth inside a match()'s arguments is a READ of the enclosing
 *  scope — the variable-location rule `matchLabelsOf`'s note explains, applied recursively so it holds
 *  inside a CONNECTIVE (`and`/`or`) or a filter (`where`/`not`) branch too, not only on a top-level
 *  pattern. `matchLabelsOf` (the exact BIND side) deliberately does NOT descend, so a variable a
 *  pattern re-roots on but a naive scan would call a bind — e.g. a pre-bound `b` used only as a
 *  BACK EDGE `as('b')` inside an `or` branch — would be retracted before the match and answer wrong
 *  (`g.V().as('a').out().as('b').match(…, or(as('a').out('knows').as('b'), …))`). Fail closed on a body
 *  this scan cannot parse — an unknown read is not a licence to delete. */
function matchAsReads(s: Step, read: BodyReader, acc: Acc): void {
  const unreadable = (): void => { acc.all = true; };
  eachChildChain(s, read, (pattern) =>
    eachStepDeep(pattern, read, (st) => { for (const l of asLabelsOf(st)) acc.labels.add(l); }, unreadable), unreadable);
}

function walkReads(chain: readonly Step[], read: BodyReader, acc: Acc): void {
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
    if (s.name === 'match') matchAsReads(s, read, acc);
    // An `as()` BINDS; a bind is not a read, and counting one would make every label read itself.
    // Liveness is therefore per label NAME rather than per bind site, which is also what makes a
    // REBIND (`as('a')…as('a')`, whose history a later `select(Pop.first)` can read back) safe: both
    // binds live or die together with the name.
    if (s.name !== 'as') for (const a of s.args ?? []) collectStrings(a.value, acc.labels);
    if (typeof ir.from === 'string') acc.labels.add(ir.from);
    if (typeof ir.to === 'string') acc.labels.add(ir.to);
    for (const m of ir.modulators ?? []) for (const v of m) collectStrings(v, acc.labels);
    for (const [, v] of ir.withArgs ?? []) collectStrings(v, acc.labels);
    // Every child chain (`eachChildChain`) — a nested argument, a PREDICATE OPERAND included (in
    // `has('age', gt(__.select('a').values('age')))` the argument IS the `Pred` and the traversal reading
    // the label sits inside its `operands`; measured, missing it retracted a live label and answered
    // `[]`), a `by()`, and the folded repeat()/choose() clusters. A body this scan cannot parse has
    // UNKNOWN reads, and every caller here deletes on the answer, so it fails closed rather than skipping.
    eachChildChain(s, read, (c) => walkReads(c, read, acc), () => { acc.all = true; });
  }
}

/** Every label the tree reads, at any depth. */
export function labelReads(steps: readonly Step[], params: Record<string, any>): LabelReads {
  const acc: Acc = { labels: new Set<string>(), all: false };
  walkReads(steps, rawBodies(params), acc);
  return acc;
}

/** A direct `select(label)` operand that reads a label bound before a barrier, or null. This is narrower
 * than `labelReads`: federation needs the operand itself, while liveness deliberately over-approximates
 * every string. Nested predicate operands are walked because `has(k, select('x'))` stores its select as
 * a nested traversal there. */
export function preBarrierSelectRead(
  steps: readonly Step[], bound: ReadonlySet<string>, params: Record<string, any>,
): string | null {
  let found: string | null = null;
  let ambiguous = false;
  const read = rawBodies(params);
  const unreadable = (): void => { ambiguous = true; };
  const visit = (body: readonly Step[]): void => {
    const first = body[0];
    const label = body.length === 1 && first?.name === 'select' && !(first as IRStep).modulators?.length
      && first.args.length === 1 && typeof first.args[0]?.value === 'string'
      ? first.args[0].value
      : null;
    if (label && bound.has(label)) {
      if (found && found !== label) ambiguous = true;
      else found = label;
    }
  };
  // ARGUMENT positions only (`ChildPositions`, `walk.ts`): the injection is performed by rewriting the
  // pushed steps' own source text, which carries no folded `by()`/`with()`/cluster. A `select(label)` in
  // one of those positions is still a cross-boundary label READ (`labelReads` walks every position), so
  // `pushableTailPrefix` keeps that step local rather than naming an injection it cannot perform.
  for (const step of steps) eachChildChain(step, read, (c) => eachChainDeep(c, read, visit, unreadable, 'arguments'), unreadable, 'arguments');
  return ambiguous ? null : found;
}

/** Does this step, or anything nested at any depth inside it, BARRIER the stream? Conservative on
 *  purpose: a barrier confined to a `where()` body does not consume the outer traverser's labels (the
 *  consumer-boundary asymmetry `steps/CLAUDE.md` documents), but distinguishing the hosts that pass a
 *  body's traverser outward from the ones that re-project the parent is a second question, and getting
 *  it wrong here licenses a deletion. Over-answering costs a retraction; under-answering costs an
 *  answer. */
function carriesBarrier(s: Step, params: Record<string, any>): boolean {
  // Every child position, a predicate operand's traversal included; an unreadable body counts as one.
  return someStepDeep([s], params, (inner) => isStreamBarrier(inner as IRStep), true);
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

/** The steps whose string arguments NAME a traversal side effect — the keyed `SideEffectCapable`
 *  writers, each registering its key on the traversal's side effects when it is CONSTRUCTED (so the key
 *  exists at EVERY step, not only after the writer — e.g.
 *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/AggregateStep.java:57`,
 *  and `GroupSideEffectStep`/`TreeSideEffectStep`/`SubgraphStep`/`ProfileSideEffectStep` beside it), and
 *  `cap`, whose keys name one. A bare `group()`/`tree()` names nothing. */
const SIDE_EFFECT_KEYED: ReadonlySet<string> = new Set(['aggregate', 'store', 'group', 'groupCount', 'tree', 'subgraph', 'profile', 'cap']);

/**
 * A PATH LABEL A SIDE EFFECT SHADOWS — a name the traversal binds with `as()` (or a `match()` pattern)
 * AND names as a side effect (`withSideEffect`, or a keyed `aggregate`/`group`/… writer) — or `null`
 * where the two namespaces are disjoint.
 *
 * `Scoping.getScopeValue` resolves a key against the traverser's own Map, then the SIDE EFFECTS, and
 * only then the path labels
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-131`),
 * so wherever such a name is read — `select`, `where(label, …)`, `by(__.select(…))`, `math`, `format` —
 * the side effect wins. The lowering's scope readers resolve a key against the ALIAS MAP, which holds
 * only path labels, so each of them answered with the labelled traverser instead (measured:
 * `withSideEffect('x',100).V().values('age').as('x').math('_ + x')` added the age to itself). One
 * whole-tree check, asked once before lowering, is what closes that at EVERY reader at once rather than a
 * precedence guard per reader that the next reader forgets: the compile DECLINES. No corpus scenario
 * overlaps the two namespaces, so the decline costs no conformance; answering it means teaching each
 * scope reader the side-effect scope, which is a feature, not this guard's job.
 */
export function sideEffectShadowedLabel(
  steps: readonly Step[], params: Record<string, any>, declared: Iterable<string>,
): string | null {
  const named = new Set(declared);
  const bound = new Set<string>();
  eachStepDeep(steps, rawBodies(params), (s) => {
    for (const l of asLabelsOf(s)) bound.add(l);
    for (const l of matchLabelsOf(s, params)) bound.add(l);
    if (SIDE_EFFECT_KEYED.has(s.name))
      for (const a of s.args ?? []) if (typeof a.value === 'string') named.add(a.value);
  });
  for (const label of bound) if (named.has(label)) return label;
  return null;
}

/** The barriers that hand on the traverser they were GIVEN — so its path, and every label on it, survives
 *  them — rather than minting a new one. A filtering or reordering barrier emits (some of) the very
 *  traversers it took: `DedupGlobalStep`/`RangeGlobalStep` are `FilterStep`s, `TailGlobalStep` pops its
 *  tail buffer (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/`),
 *  `OrderGlobalStep`/`SampleGlobalStep` are `CollectingBarrierStep`s re-emitting their `TraverserSet`
 *  (`.../step/util/CollectingBarrierStep.java`) and `NoOpBarrierStep` (`barrier()`) likewise; a KEYED
 *  side-effect writer (`aggregate('a')` — `AggregateStep`; `group('a')`/`groupCount('a')` —
 *  `SideEffectBarrierStep`s) passes its traverser through (`.../step/sideEffect/`). Their `by()` keys
 *  never touch the traverser. A REDUCING
 *  barrier (`fold`, `count`, an unkeyed `group`, …) is not here: `ReducingBarrierStep` emits a traverser
 *  it GENERATES, carrying no path (`.../step/util/ReducingBarrierStep.java`). */
const PATH_PASSING_BARRIERS: ReadonlySet<string> = new Set(['dedup', 'order', 'limit', 'range', 'skip', 'tail', 'sample', 'barrier', 'aggregate', 'store']);
const KEYED_SIDE_EFFECT_WRITERS: ReadonlySet<string> = new Set(['group', 'groupCount']);
const passesTraverser = (s: Step): boolean =>
  PATH_PASSING_BARRIERS.has(s.name)
  || (KEYED_SIDE_EFFECT_WRITERS.has(s.name) && (s.args ?? []).some((a) => typeof a.value === 'string'));

/**
 * A SUB-PATH this compile cannot prove LOCATABLE — a `path()`/`simplePath()`/`cyclicPath()` whose
 * `from(label)`/`to(label)` the traverser's path might not carry, or might carry in the wrong order —
 * named by the offending label, or `null` when every one is provably locatable.
 *
 * `Path.subPath` THROWS on each of those (`couldNotLocatePathFromLabel`/`…ToLabel` when a label is
 * absent, `couldNotIsolatedSubPath` when the from-label's last position is after the to-label's —
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Path.java:259-292`,
 * reached from `PathStep` (`step/map/PathStep.java:114`) and `PathFilterStep` (`step/filter/PathFilterStep.java:60`)),
 * where the lowering's `subPathMembers` window leaves a NULL bound and keeps no position: an EMPTY
 * path, or a vacuously simple one — a different answer, not the error. So the compile declines unless
 * the sub-path is locatable on EVERY traverser:
 *
 * - each label is bound UNCONDITIONALLY before the step — a TOP-LEVEL `as()` of the same chain, not
 *   cleared by a barrier since (`labelsBoundBefore`'s rule, `as()` only: a `match()` pattern's binds
 *   are not positions this scan can order). A nested chain sees none of its host's labels here, so a
 *   sub-path inside a nested body declines unless that body binds its own;
 * - with both bounds, no bind of the from-label — at any depth — follows the to-label's last top-level
 *   bind, so the from position can never land after the to position.
 */
export function unlocatableSubPath(steps: readonly Step[], params: Record<string, any>): string | null {
  let found: string | null = null;
  eachChainDeep(steps, rawBodies(params), (chain) => {
    for (let i = 0; i < chain.length && found === null; i++) {
      if (!PATH_FAMILY.has(chain[i]!.name)) continue;
      // A passed chain carries the modulators folded onto the host (`absorbModulators`); a nested body
      // re-read raw still spells them as the steps that follow it. Both are read.
      let { from, to } = chain[i] as IRStep;
      for (let j = i + 1; j < chain.length; j++) {
        const m = chain[j]!;
        if (m.name === 'by') continue;
        if (m.name !== 'from' && m.name !== 'to') break;
        const label = m.args?.[0]?.value;
        if (typeof label !== 'string') { found = `${m.name}(…)`; break; }
        if (m.name === 'from') from = label; else to = label;
      }
      if (found !== null || (from === undefined && to === undefined)) continue;
      // The top-level binds before `i`, each at its LAST index; a barrier that mints a NEW traverser
      // clears them all (`passesTraverser` names the ones that do not).
      let last = new Map<string, number>();
      for (let k = 0; k < i; k++) {
        if (!passesTraverser(chain[k]!) && carriesBarrier(chain[k]!, params)) last = new Map();
        for (const l of asLabelsOf(chain[k]!)) last.set(l, k);
      }
      for (const label of [from, to]) if (found === null && label !== undefined && !last.has(label)) found = label;
      if (found !== null || from === undefined || to === undefined) continue;
      const fromLabel = from;
      let later = false;
      eachStepDeep(chain.slice(last.get(to)! + 1, i), rawBodies(params), (s) => {
        if (asLabelsOf(s).includes(fromLabel) || matchLabelsOf(s, params).includes(fromLabel)) later = true;
      });
      if (later) found = fromLabel;
    }
  });
  return found;
}
