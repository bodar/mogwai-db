// classifyBranchArms (src/compiler/steps/tail/child-shape.ts): the ONE canonical branch-family
// arm triage, consolidated from the ten ad-hoc booleans the prefix fold used to build inline
// (engine.ts) plus the shape re-classification each tryLower* did for itself. These assert the
// shape verdict per branch kind AND — the drift risk this consolidation removes — that
// branchNeedsShapeDispatch reproduces the old ten-boolean `break` predicate EXACTLY, so the
// prefix fold's break and the tail cascade's fall-through can never disagree.
import { test, expect, describe } from 'bun:test';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { normalize } from '../../src/compiler/ir/passes.ts';
import {
    asBranchKind, branchNeedsShapeDispatch, classifyBranchArms,
    isElementChild, isListChild, isScalarChild, type BranchKind, type ChildCtx,
} from '../../src/compiler/steps/tail/child-shape.ts';
import { type IRStep } from '../../src/compiler/ir/strategies.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { bagOf } from '../support/harness.ts';
import { seeded } from '../support/graph.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

/** The nested child body of the FIRST step that carries one — how a consumer hands a body to the
 *  classifiers. */
const nestedOf = (gremlin: string): any => {
  for (const s of normalize(stepChain(parseGremlin(gremlin), {})).steps)
    for (const a of s.args ?? []) if (a && typeof a === 'object' && 'nested' in a) return a.nested;
  throw new Error(`no nested child body in ${gremlin}`);
};

/** Every branch-family step in a traversal, as the compiler sees it (parsed + normalized, so a
 *  folded order().by()/repeat cluster is already canonical). */
const branchSteps = (gremlin: string): IRStep[] =>
  normalize(stepChain(parseGremlin(gremlin), {})).steps.filter((s) => asBranchKind(s.name));

/** A label-free classify context (no bound params, no as() in scope) — what a root-position
 *  branch sees before anything is labelled. */
const CTX: ChildCtx = { params: {}, labels: new Map() };

const planOf = (gremlin: string) => {
  const [step] = branchSteps(gremlin);
  return classifyBranchArms(asBranchKind(step.name)!, step, CTX);
};

describe('classifyBranchArms — the shape verdict', () => {
  test('homogeneous element arms stay on the prefix-fold hot path', () => {
    expect(planOf('g.V().union(__.out(), __.in())').merge).toBe('element');
    expect(planOf('g.V().union(__.out(), __.in(), __.both())').merge).toBe('element');
    // mixed element KIND (node + edge) is still all-element: the element lowerer owns that defer
    expect(planOf('g.V().union(__.outE(), __.out())').merge).toBe('element');
    expect(planOf('g.V().coalesce(__.out(), __.in())').merge).toBe('element');
    expect(planOf('g.V().choose(__.has("age"), __.out(), __.in())').merge).toBe('element');
    expect(planOf('g.V().optional(__.out())').merge).toBe('element');
  });

  test('homogeneous scalar / list arms route to their own merge', () => {
    expect(planOf('g.V().union(__.values("name"), __.values("age"))').merge).toBe('scalar');
    expect(planOf('g.V().coalesce(__.values("name"), __.values("age"))').merge).toBe('scalar');
    expect(planOf('g.V().union(__.out().values("n").fold(), __.in().values("n").fold())').merge).toBe('list');
    expect(planOf('g.V().choose(__.has("age"), __.out().values("n").fold(), __.in().values("n").fold())').merge).toBe('list');
  });

  test('genuinely mixed arms route to the variant merge', () => {
    expect(planOf('g.V().union(__.out(), __.values("name"))').merge).toBe('variant');
    expect(planOf('g.V().union(__.values("name"), __.out())').merge).toBe('variant');
    expect(planOf('g.V().union(__.out().values("n").fold(), __.values("age"))').merge).toBe('variant');
    expect(planOf('g.V().coalesce(__.out(), __.values("name"))').merge).toBe('variant');
  });

  test('the predicate arg is not an arm; choose arity below 3 keeps the element lowerer', () => {
    // choose(pred, then, else) → exactly the two VALUE arms are classified
    expect(planOf('g.V().choose(__.has("age"), __.out(), __.in())').shapes).toEqual(['element', 'element']);
    // the 2-arg form's else is an element identity → element lowerer, no shape question
    expect(planOf('g.V().choose(__.has("age"), __.out())').merge).toBe('element');
    // the option-map form is a tail CASE projector, not a prefix branch
    expect(planOf('g.V().choose(__.values("age")).option(29, __.out()).option(35, __.in())').merge).toBe('element');
  });

  test('below-arity union/coalesce defer to the element lowerer for the authoritative error', () => {
    expect(planOf('g.V().union(__.out())').merge).toBe('element'); // union needs >= 2
    expect(planOf('g.V().coalesce(__.out())').merge).toBe('element'); // coalesce needs >= 1 — this IS 1
    expect(planOf('g.V().coalesce(__.out())').shapes).toEqual(['element']);
  });

  // The asymmetry that a naive "unclassifiable → element" or "→ variant" rule gets WRONG in one
  // direction or the other. Both directions are pinned here because each was a real bug during
  // the consolidation: optional() stranded in the tail reported "step not implemented: optional()".
  test('an UNCLASSIFIABLE arm splits by kind — optional stays, multi-arm merges route out', () => {
    // A nested uniform-element branch (optional/coalesce/union) IS a classifiable element child now
    // (it folds through lowerElementSteps' prefix), so this arm is 'element', not unclassifiable —
    // and the outer optional stays 'element' either way (the routing invariant this test pins).
    const nestedOptional = planOf('g.V().optional(__.out().optional(__.out())).path()');
    expect(nestedOptional.shapes).toEqual(['element']);
    expect(nestedOptional.merge).toBe('element');
    // repeat() USED to be the example here ("its recursive walk carries no parent ordinal"). It now
    // carries its origin column through the walk, so a repeat arm is a classifiable ELEMENT child
    // and composes for real — pinned in repeat-path.exec.test.ts. A map/group/path-shaped body is
    // still genuinely unclassifiable (item 5 territory), so it takes over as this test's example;
    // the ROUTING asymmetry below is what is being pinned, not the choice of body.
    expect(planOf('g.V().optional(__.repeat(__.out()).times(2))').shapes).toEqual(['element']);
    // optional()'s miss arm is the parent element itself, so an unclassifiable arm keeps it an
    // ELEMENT branch, compiled by the optional StepFn's originSeed.
    expect(planOf('g.V().optional(__.valueMap())').shapes).toEqual([null]);
    expect(planOf('g.V().optional(__.valueMap())').merge).toBe('element');
    // a multi-arm merge cannot know an unclassified arm's shape → tail cascade, where each
    // tryLower* declines and the element lowerer throws the deferral naming the arm body.
    expect(planOf('g.V().union(__.valueMap(), __.in())').merge).toBe('variant');
    expect(planOf('g.V().coalesce(__.valueMap(), __.in())').merge).toBe('variant');
  });
});

// ---------- the equivalence that makes the consolidation safe ----------

/** The ORIGINAL ten-boolean break predicate, transcribed verbatim from the pre-consolidation
 *  lowerElementSteps (engine.ts). Kept as the reference oracle: branchNeedsShapeDispatch must
 *  agree with it for every branch shape, or the prefix fold and the tail cascade have drifted. */
function tenBooleanBreak(step: IRStep, params: ChildCtx): boolean {
  const nested = (a: any) => a && typeof a === 'object' && 'nested' in a;
  const unionBranches = step.name === 'union' ? step.args.filter(nested) : [];
  const scalarUnion = unionBranches.length >= 2 && unionBranches.every((a: any) => isScalarChild(a.nested, params));
  const listUnion = unionBranches.length >= 2 && unionBranches.every((a: any) => isListChild(a.nested, params));
  const chooseArgs = step.name === 'choose' && !(step as IRStep).optionArms ? step.args.filter(nested) : [];
  const scalarChoose = chooseArgs.length === 3
    && isScalarChild(chooseArgs[1].nested, params) && isScalarChild(chooseArgs[2].nested, params);
  const listChoose = chooseArgs.length === 3
    && isListChild(chooseArgs[1].nested, params) && isListChild(chooseArgs[2].nested, params);
  const coalesceArgs = step.name === 'coalesce' ? step.args.filter(nested) : [];
  const scalarCoalesce = coalesceArgs.length > 0 && coalesceArgs.every((a: any) => isScalarChild(a.nested, params));
  const listCoalesce = coalesceArgs.length > 0 && coalesceArgs.every((a: any) => isListChild(a.nested, params));
  const optionalNested = step.name === 'optional' ? step.args[0]?.nested : null;
  const shapedOptional = !!optionalNested
    && (isListChild(optionalNested, params) || isScalarChild(optionalNested, params));
  const mixedUnion = unionBranches.length >= 2 && unionBranches.some((a: any) => !isElementChild(a.nested, params));
  const mixedChoose = chooseArgs.length === 3 && chooseArgs.slice(1).some((a: any) => !isElementChild(a.nested, params));
  const mixedCoalesce = coalesceArgs.length > 0 && coalesceArgs.some((a: any) => !isElementChild(a.nested, params));
  return scalarUnion || listUnion || scalarChoose || listChoose || scalarCoalesce || listCoalesce
    || mixedUnion || mixedChoose || mixedCoalesce || shapedOptional;
}

/** Branch shapes spanning every class the triage must separate: homogeneous element/scalar/list,
 *  mixed, unclassifiable (repeat/group/nested-branch bodies), below-arity, option-map choose, and
 *  nesting in both the arm and the parent position. */
const CORPUS = [
  'g.V().union(__.out(), __.in())',
  'g.V().union(__.out(), __.in(), __.both())',
  'g.V().union(__.outE(), __.out())',
  'g.V().union(__.values("name"), __.values("age"))',
  'g.V().union(__.out().values("name").fold(), __.in().values("name").fold())',
  'g.V().union(__.out(), __.values("name"))',
  'g.V().union(__.values("name"), __.out())',
  'g.V().union(__.out().values("name").fold(), __.values("age"))',
  'g.V().union(__.out())',
  'g.V().union(__.out().order().by("name"), __.in())',
  'g.V().union(__.repeat(__.out()).times(2), __.in())',
  'g.V().union(__.group().by("name"), __.in())',
  'g.V().union(__.union(__.out(), __.in()), __.both())',
  'g.V().union(__.constant("x"), __.constant("y"))',
  'g.V().union(__.count(), __.values("age"))',
  'g.V().union(__.out().optional(__.in()), __.both())',
  'g.V().coalesce(__.out(), __.in())',
  'g.V().coalesce(__.values("name"), __.values("age"))',
  'g.V().coalesce(__.out().values("name").fold(), __.in().values("x").fold())',
  'g.V().coalesce(__.out(), __.values("name"))',
  'g.V().coalesce(__.out())',
  'g.V().coalesce(__.values("name"))',
  'g.V().coalesce(__.repeat(__.out()).times(2), __.in())',
  'g.V().coalesce(__.out().optional(__.in()), __.both())',
  'g.V(1).coalesce(__.coalesce(__.out(), __.in()), __.both())',
  'g.V().choose(__.has("age"), __.out(), __.in())',
  'g.V().choose(__.has("age"), __.values("name"), __.values("age"))',
  'g.V().choose(__.has("age"), __.out().values("n").fold(), __.in().values("n").fold())',
  'g.V().choose(__.has("age"), __.out(), __.values("name"))',
  'g.V().choose(__.has("age"), __.out())',
  'g.V().choose(__.has("age"), __.out().optional(__.in()), __.both())',
  'g.V().choose(__.values("age")).option(29, __.out()).option(35, __.in())',
  'g.V().optional(__.out())',
  'g.V().optional(__.values("name"))',
  'g.V().optional(__.out().values("name").fold())',
  'g.V().optional(__.out().out())',
  'g.V().optional(__.count())',
  'g.V().optional(__.out("created")).values("name")',
  'g.V().optional(__.both()).count()',
  'g.V().as("a").optional(__.out()).select("a")',
  'g.V().optional(__.out().optional(__.out())).path()',
  'g.V().optional(__.repeat(__.out()).times(2))',
  'g.V().optional(__.group().by("name"))',
  'g.V().optional(__.union(__.out(), __.in()))',
];

describe('branchNeedsShapeDispatch === the ten-boolean predicate it replaced', () => {
  test('agrees for every branch step in the corpus', () => {
    let checked = 0;
    for (const src of CORPUS) {
      for (const step of branchSteps(src)) {
        const kind = asBranchKind(step.name) as BranchKind;
        expect({ src, step: step.name, breaks: branchNeedsShapeDispatch(kind, step, CTX) })
          .toEqual({ src, step: step.name, breaks: tenBooleanBreak(step, CTX) });
        checked++;
      }
    }
    // guards against the corpus silently emptying (a parse change that stops yielding branch steps)
    expect(checked).toBeGreaterThanOrEqual(44);
  });
});

// ---------- classifyScalarChild ⟺ tryCompileScalarValueChild ----------
//
// The classify twin of the scalar-child EMITTER must admit exactly what the emitter lowers. Half
// the consumers call the emitter directly (map/flatMap/by) and half gate on the classifier
// (choose/coalesce/local/path/select/branch arms), so a disagreement shows up as one Gremlin body
// answering in one position and failing closed in another — which is what `values('age').count()`
// did, because the classifier keyed on the terminal step (`count` → the movement-count arm only)
// instead of taking the union of its three readings.
describe('classifyScalarChild admits what the scalar-child emitter lowers', () => {
  const store = seeded(MODERN_SEED);
  /** The scalar values a traversal yields (the scalar payload column), for shape-agnostic compare. */
  const scalars = (gremlin: string): unknown[] => {
    const p = compile(gremlin, {});
    if (p.kind !== 'read') throw new Error('expected read plan');
    return store.query<Record<string, unknown>>(p.sql, p.binds).map((r) => Object.values(r)[0]);
  };

  test('a projection-with-reducer body lowers in EVERY consumer position, with one answer', () => {
    // 4 persons have an age (1 value each), 2 software vertices have none (0) — so every consumer
    // position must answer with the same six counts. That is the whole claim, and it is a MULTISET
    // claim: none of these traversals fixes an order (no order(), no positional consumer), so the
    // sequence they arrive in is unspecified by design.
    //
    // This test used to carry TWO constants — a per-traverser order and a by-arm one, differing
    // only in position — which made it a pin on `g.V()`'s scan order, and it flipped under
    // `mise run test:perturbed`. The by-arm reading is a real property, but since 21's T4 it is
    // observable only where nothing demands an order, i.e. it is INTERNAL — and it is already
    // pinned where internals belong: `test/L2-sql/branch.sql.test.ts` asserts the merge window is
    // `ROW_NUMBER() OVER (… arm_idx, arm_ordinal, arm_encounter)`. Asserting it a second time
    // through result position bought nothing and cost the instrument.
    const counts = bagOf([1, 1, 1, 1, 0, 0]);
    expect(isScalarChild(nestedOf("g.V().map(__.values('age').count())"), CTX)).toBe(true);
    // the emitter-direct consumers (these already worked)
    expect(bagOf(scalars("g.V().map(__.values('age').count())"))).toEqual(counts);
    expect(bagOf(scalars("g.V().project('a').by(__.values('age').count())"))).toEqual(counts);
    // the classifier-gated consumers (these failed closed: "not yet supported (scalar/projection
    // body)" for the branches, "local() child shape not yet supported" for local)
    expect(bagOf(scalars("g.V().local(__.values('age').count())"))).toEqual(counts);
    expect(bagOf(scalars("g.V().choose(__.has('age'), __.values('age').count(), __.values('age').count())"))).toEqual(counts);
    expect(bagOf(scalars("g.V().coalesce(__.values('age').count(), __.constant(-1))"))).toEqual(counts);
    expect(bagOf(scalars("g.V().path().by(__.values('age').count())"))).toEqual(counts);
    // …and the movement-count reading of a count terminal still works next to it, in both
    // positions — the two arms are disjoint, so admitting one never shadows the other.
    const degrees = bagOf([3, 2, 1, 0, 0, 0]);
    expect(bagOf(scalars("g.V().local(__.out().count())"))).toEqual(degrees);
    expect(bagOf(scalars("g.V().choose(__.has('age'), __.out().count(), __.values('age').count())"))).toEqual(degrees);
  });

  test('EVERY scalar producer may carry a scoped reducer — the projection is not the axis', () => {
    // This used to be the fail-closed half of the invariant: a generalized producer (format/math/
    // call/sack) plus a reducer was rejected by the classifier, because only values/id/label/
    // constant carried an `encounter` and the scoped reducer demanded one. That demand was
    // mis-stated — the reducer reads the encounter for EXISTENCE (real child row vs the domain
    // LEFT JOIN's null padding), never as an ORDER, since every aggregate below it is
    // order-insensitive. The child row's own ordinal answers the same question, so the
    // projection's identity was never the axis and the whole gate went away.
    const body = "__.format('%{name}').count()";
    expect(isScalarChild(nestedOf(`g.V().map(${body})`), CTX)).toBe(true);
    expect(scalars(`g.V().map(${body})`)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(scalars(`g.V().local(${body})`)).toEqual([1, 1, 1, 1, 1, 1]);
    // by ARM, as in the test above: the four age-carrying vertices take format().count()=1, the
    // two without take out().count().
    expect(scalars(`g.V().choose(__.has('age'), ${body}, __.out().count())`)).toEqual([1, 1, 1, 1, 0, 0]);
    // A FANNING prefix under a generalized producer counts the same as under a bare movement —
    // which is the check that the productivity marker really is counting rows, not ranking them.
    expect(scalars("g.V().map(__.out().format('%{name}').count())"))
      .toEqual(scalars('g.V().map(__.out().count())'));
  });
});
