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
import { TRANSITIONS, SOURCES, type RenderCtx, type Shape, type Transition } from './shape.ts';

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
        // body is out of the running once the nesting budget is spent.
        const legal = TRANSITIONS[shape].filter((t) => (t.bodies?.length ?? 0) === 0 || budgetLeft.depth > 0);
        if (legal.length === 0) break;
        const t = pick(legal);
        const bodies = (t.bodies ?? []).map((bodyShape) => {
          const inner = walk(bodyShape, { steps: Math.max(1, budgetLeft.steps - 1), depth: budgetLeft.depth - 1 });
          // An empty child body is not valid Gremlin — fall back to identity() so a body is always
          // a real anonymous traversal.
          return `__.${inner.src === '' ? 'identity()' : inner.src}`;
        });
        parts.push(t.render(ctxFrom(bodies, pick)));
        if (t.to === 'list') folded = shape;
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
