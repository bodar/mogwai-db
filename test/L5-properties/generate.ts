// The generator: a fast-check arbitrary that walks the shape lattice (shape.ts) to produce
// well-typed Gremlin source.
//
// Every traversal it emits is shape-legal by construction — the next step is drawn only from the
// transitions of the CURRENT shape, so `count().out()` can never be generated and the run's budget
// goes on real compositions instead of syntax noise. Child bodies recurse through the same walk from
// the body's own input shape, which is what makes nesting depth (the "ceiling" test/CLAUDE.md asks
// for) a parameter rather than a hand-written list of cases.
//
// Shrinking is why this is fast-check and not a hand-rolled loop: a divergence found at depth 4
// inside two nested branches is unusable until it is minimised, and fast-check shrinks the
// underlying choice sequence, which walks the traversal back down to the smallest chain that still
// diverges. `fc.letrec` gives the recursion a shrinkable spine.
import fc from 'fast-check';
import { SHAPES, TRANSITIONS, SOURCES, type RenderCtx, type Shape, type Transition } from './shape.ts';

/** How big a traversal to build. `steps` bounds the chain length; `depth` bounds child-body
 *  nesting (0 = no step that takes a child body may be chosen). */
export interface Budget {
  readonly steps: number;
  readonly depth: number;
}

/** A generated traversal plus the metadata a failure report needs. */
export interface Generated {
  /** The full `g.…` source. */
  readonly query: string;
  /** Step names in order, for classifying findings without re-parsing. */
  readonly steps: readonly string[];
  /** Terminal shape — a useful grouping for coverage reporting. */
  readonly shape: Shape;
}

/** fast-check's randomness, exposed to a Transition's `render` as the `pick` it needs. Drawing from
 *  the same `mrng`/`biasFactor` the arbitrary was given keeps every literal choice part of the
 *  shrinkable choice sequence, so shrinking can simplify literals too, not just structure. */
const ctxFrom = (bodies: readonly string[], pickFrom: <T>(o: readonly T[]) => T): RenderCtx =>
  ({ bodies, pick: pickFrom });

/**
 * The traversal arbitrary. Built with `fc.gen()` (fast-check's imperative generator surface) rather
 * than a composed tree of `oneof`s: the walk is genuinely sequential — each step's legal set depends
 * on the shape the previous step produced — and `gen` keeps that dependence explicit while still
 * recording every draw in the shrinkable choice sequence.
 */
export const traversal = (budget: Budget): fc.Arbitrary<Generated> =>
  fc.gen().map((gen): Generated => {
    // One `pick` closure over `gen`, threaded into every render. Each call is a recorded draw, so
    // shrinking can simplify a literal choice as well as the chain structure.
    const pick = <T>(options: readonly T[]): T => options[gen(fc.nat, { max: options.length - 1 })]!;

    const walk = (from: Shape, budgetLeft: Budget): { src: string; shape: Shape } => {
      const parts: string[] = [];
      let shape = from;
      // What a following `unfold()` would restore. Set when `fold()` folds a shape away; that is
      // the one transition whose output shape isn't a function of its input shape alone.
      let folded: Shape = from;
      const n = gen(fc.nat, { max: Math.max(0, budgetLeft.steps) });
      for (let i = 0; i < n; i++) {
        // THE CONFINEMENT: only this shape's transitions are candidates. A step needing a child
        // body is out of the running once the nesting budget is spent, and a list transition that
        // needs numeric members is out unless that is what was folded.
        const legal = TRANSITIONS[shape].filter((t) =>
          ((t.bodies?.length ?? 0) === 0 || budgetLeft.depth > 0)
          && (t.requiresListOf === undefined || t.requiresListOf === folded));
        if (legal.length === 0) break;
        const t = pick(legal);
        const bodies = (t.bodies ?? []).map((bodyShape) => {
          const inner = walk(bodyShape, { steps: Math.max(1, budgetLeft.steps - 1), depth: budgetLeft.depth - 1 });
          // An empty child body is not valid Gremlin — fall back to identity() so a body is always
          // a real anonymous traversal.
          return `__.${inner.src === '' ? 'identity()' : inner.src}`;
        });
        parts.push(t.render(ctxFrom(bodies, pick)));
        // Only fold() establishes the member shape an ensuing unfold() restores.
        // List-preserving transforms such as order(local) must not replace that
        // remembered pre-fold shape with `list` itself.
        if (t.name === 'fold') folded = shape;
        shape = t.to === 'inherit' ? folded : t.to;
        if (t.terminal) break; // nothing meaningful follows a reducer
      }
      return { src: parts.join('.'), shape };
    };

    const source = pick(SOURCES);
    const head = source.render(ctxFrom([], pick));
    const body = walk(source.to, budget);
    const query = `g.${head}${body.src ? '.' + body.src : ''}`;
    return { query, steps: stepNames(query), shape: body.shape };
  });

/** Step names, read off the generated source. Cheap and good enough for reporting: the generator
 *  controls the shape of what it emits, so a `name(` scan cannot mis-read it. */
const stepNames = (q: string): string[] =>
  [...q.matchAll(/(?:^|[.(])([a-zA-Z]\w*)\(/g)].map((m) => m[1]).filter((n) => n !== 'g' && n !== '__');

/**
 * A generated PREFIX that is guaranteed to LAND on `shape` — the context a metamorphic law is
 * instantiated over (`laws.ts`).
 *
 * A law like `out(l) ≡ outE(l).inV()` only means anything applied to something; what makes it a
 * property test rather than a fixed example is that the something is generated. The law appends its
 * two variants to this prefix and must get the same answer for every one of them.
 *
 * Landing on a known shape is done by restricting the walk to SHAPE-PRESERVING transitions
 * (`to === shape`) rather than by searching for a path to it. That is a deliberate trade: it costs
 * the shape-changing steps (a prefix can't route vertex→edge→vertex), and it buys a generator that
 * cannot fail to satisfy the constraint. For `vertex` the preserved set is still the whole
 * interesting surface — movement, filters, branches, repeat, order/slice, dedup.
 */
export const prefix = (shape: Shape, budget: Budget): fc.Arbitrary<{ src: string; steps: readonly string[] }> =>
  fc.gen().map((gen) => {
    const pick = <T>(options: readonly T[]): T => options[gen(fc.nat, { max: options.length - 1 })]!;
    const sources = SOURCES.filter((s) => s.to === shape);
    if (!sources.length) throw new Error(`no source lands on ${shape}`);
    const parts: string[] = [pick(sources).render(ctxFrom([], pick))];
    const preserving = TRANSITIONS[shape].filter((t) => t.to === shape && !t.terminal);
    const n = gen(fc.nat, { max: Math.max(0, budget.steps) });
    for (let i = 0; i < n; i++) {
      const legal = preserving.filter((t) => (t.bodies?.length ?? 0) === 0 || budget.depth > 0);
      if (!legal.length) break;
      const t = pick(legal);
      const bodies = (t.bodies ?? []).map((bodyShape) => {
        const inner = walkAny(bodyShape, { steps: Math.max(1, budget.steps - 1), depth: budget.depth - 1 }, pick, gen);
        return `__.${inner === '' ? 'identity()' : inner}`;
      });
      parts.push(t.render(ctxFrom(bodies, pick)));
    }
    const src = `g.${parts.join('.')}`;
    return { src, steps: stepNames(src) };
  });

/**
 * One deterministic, independently-typed witness for every lattice edge. This is
 * deliberately much smaller than the random walker: it proves that every declared
 * `(input shape, transition)` reaches the capability oracle at least once, while
 * the random generator continues to explore compositions and nesting. Child bodies
 * use identity(), which is valid at every declared body input shape and leaves the
 * transition itself as the only capability under test.
 */
export interface TransitionWitness {
  readonly from: Shape;
  readonly transition: Transition;
  readonly query: string;
}

const witnessSource: Readonly<Record<Shape, string>> = {
  vertex: 'g.V()',
  edge: 'g.E()',
  scalar: "g.V().values('age')",
  list: "g.V().values('age').fold()",
  record: 'g.V().valueMap()',
  group: 'g.V().groupCount()',
  path: 'g.V().out().path()',
};

const first = <T>(options: readonly T[]): T => options[0]!;

export const transitionWitnesses = (): readonly TransitionWitness[] =>
  SHAPES.flatMap((from) => TRANSITIONS[from]
    .filter((transition) => transition.requiresListOf === undefined || transition.requiresListOf === 'scalar')
    .map((transition) => {
      const bodies = (transition.bodies ?? []).map(() => '__.identity()');
      return { from, transition, query: `${witnessSource[from]}.${transition.render(ctxFrom(bodies, first))}` };
    }));

/** An unconstrained child-body walk, for the bodies a prefix's branch/filter steps need. Shares the
 *  confinement rule with `traversal`'s walk; kept separate only because that one is a closure over
 *  its own `gen`. */
function walkAny(from: Shape, budget: Budget, pick: <T>(o: readonly T[]) => T, gen: any): string {
  const parts: string[] = [];
  let shape = from;
  let folded: Shape = from;
  const n = gen(fc.nat, { max: Math.max(1, budget.steps) });
  for (let i = 0; i < n; i++) {
    const legal = TRANSITIONS[shape].filter((t) => (t.bodies?.length ?? 0) === 0 || budget.depth > 0);
    if (!legal.length) break;
    const t = pick(legal);
    const bodies = (t.bodies ?? []).map((b) => {
      const inner = walkAny(b, { steps: Math.max(1, budget.steps - 1), depth: budget.depth - 1 }, pick, gen);
      return `__.${inner === '' ? 'identity()' : inner}`;
    });
    parts.push(t.render(ctxFrom(bodies, pick)));
    if (t.name === 'fold') folded = shape;
    shape = t.to === 'inherit' ? folded : t.to;
    if (t.terminal) break;
  }
  return parts.join('.');
}
