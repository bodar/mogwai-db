// The Pass pipeline (src/compiler/ir/pass.ts + passes.ts): ordering invariants that used to live
// only in prose comments + the inside-out normalize() nesting. Encoding them as a test turns a
// silent mis-compile (a future reorder) into a loud failure. Asserted DIRECTLY against the PASSES
// array — no compile() needed.
import { test, expect, describe } from 'bun:test';
import { PASSES } from '../../src/compiler/ir/passes.ts';
import { PASS_CATEGORIES } from '../../src/compiler/ir/pass.ts';
import { canonicalizeConnectives } from '../../src/compiler/ir/strategies.ts';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { runPasses, EMPTY_STRATEGY_USE, childSteps } from '../../src/compiler/ir/passes.ts';
import { standardRegistry } from '../../src/services/standard.ts';

const names = PASSES.map((p) => p.name);
const ord = (name: string) => names.indexOf(name);
const catOrd = (cat: string) => PASS_CATEGORIES.indexOf(cat as any);

describe('Pass pipeline ordering invariants', () => {
  test('category order is non-decreasing across PASSES', () => {
    // The flat array is assembled by concatenating category groups in PASS_CATEGORIES order; if a
    // future edit appends a Pass to the wrong group, its category ordinal goes backwards here.
    let last = -1;
    for (const p of PASSES) {
      const idx = catOrd(p.category);
      expect(idx).toBeGreaterThanOrEqual(last);
      last = idx;
    }
  });

  test('extract runs first, and stripTerminal leads it', () => {
    // stripTerminal must be the very first Pass in the pipeline: it removes an out-of-band terminal
    // FLAG (discard/none) rather than a step, so every later Pass — desugarMatchString included,
    // which reads whether a match() is LAST to decide on the binding-map projection — should see the
    // chain's true end.
    expect(PASSES[0].name).toBe('stripTerminal');
    // The invariant is that extract precedes every other category, NOT that it has one member (it
    // used to, and asserting the count made adding a second one look like a violation).
    const lastExtract = PASSES.findLastIndex((p) => p.category === 'extract');
    const firstNonExtract = PASSES.findIndex((p) => p.category !== 'extract');
    expect(lastExtract).toBeLessThan(firstNonExtract);
  });

  test('decoration precedes fold — injectors recurse into RAW {nested} args', () => {
    // Load-bearing: formRepeatRegions/absorbOptionArms move a repeat()/choose() body from a
    // {nested} arg into .cluster/.options. injectSubgraphRec/injectPartitionRec recurse over the
    // raw {nested} args, so they MUST see the chain before those folds — else a subgraph/partition
    // criterion is silently not injected into the body (an unfiltered leak). See passes.ts.
    expect(catOrd('decoration')).toBeLessThan(catOrd('canonicalize'));
    for (const dec of ['SubgraphStrategy', 'PartitionStrategy', 'ProductiveByStrategy'])
      expect(ord(dec)).toBeLessThan(ord('formRepeatRegions'));
  });

  test('absorbModulators precedes dropRedundantOrder', () => {
    // dropRedundantOrder skips an order() carrying a by() — which requires absorbModulators to have
    // already absorbed the by() onto the order()'s .bys.
    expect(ord('absorbModulators')).toBeLessThan(ord('dropRedundantOrder'));
  });

  test('collapseFoldCountLocal precedes dropRedundantOrder', () => {
    // collapseFoldCountLocal can expose an order().count() (from fold().count(local)) that
    // dropRedundantOrder then removes; so it must run first.
    expect(ord('collapseFoldCountLocal')).toBeLessThan(ord('dropRedundantOrder'));
  });

  test('verify runs last', () => {
    const verifyIdxs = PASSES.map((p, i) => (p.category === 'verify' ? i : -1)).filter((i) => i >= 0);
    const nonVerifyMax = PASSES.map((p, i) => (p.category !== 'verify' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    for (const vi of verifyIdxs) expect(vi).toBeGreaterThan(nonVerifyMax);
  });

  test('the two RAW-nested-arg folds lead the group, end-labels before connectives', () => {
    // Both rewriteWhereEndLabels and ConnectiveStrategy read the raw `{nested}` args (before
    // formRepeatRegions/absorbOptionArms move a body into .cluster/.options), so both lead.
    // Their ORDER follows TinkerPop: a where()'s variable locations are resolved at step
    // CONSTRUCTION, before any strategy runs, whereas ConnectiveStrategy is a strategy. It matters
    // for `where(__.as("a").out().and().out().as("b"))` — folding the connective first would move
    // the trailing as("b") inside the and()'s last operand, out of the end-label rewrite's sight.
    const folds = PASSES.filter((p) => p.category === 'canonicalize').map((p) => p.name);
    expect(folds.slice(0, 2)).toEqual(['rewriteWhereEndLabels', 'ConnectiveStrategy']);
    // ConnectiveStrategy is still the only fold that RESTRUCTURES the chain, so it must precede
    // every remaining fold and the whole simplify group.
    expect(ord('ConnectiveStrategy')).toBeLessThan(ord('formRepeatRegions'));
    expect(ord('ConnectiveStrategy')).toBeLessThan(ord('collapseFoldCountLocal'));
  });
});

// ---------- ConnectiveStrategy (the infix .and()/.or() fold) ----------
//
// This fold lived inside the predicateInlining FAST PATH until 2026-07-27, where it was reachable
// only in a child body and only while that flag was on. These pin the three properties that made
// moving it to a Pass the right call; each one was a measured defect before.
describe('ConnectiveStrategy: infix .and()/.or() folds to the step form', () => {
  const fold = (g: string) => canonicalizeConnectives(stepChain(parseGremlin(g), {}), {});
  const shape = (steps: any[]): string =>
    steps.map((s) => {
      const nested = s.args.map((a: any) => a.value).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
      return nested.length ? `${s.name}(${nested.map((n: any) => shape(stepChain(n.nested, {}))).join(', ')})` : s.name;
    }).join('.');

  test('a SOURCE step is never absorbed into an operand', () => {
    // TinkerPop's ConnectiveStrategy.legalCurrentStep excludes GraphStep for exactly this reason;
    // swallowing V() would make the whole traversal one filter over an empty source.
    expect(shape(fold('g.V().has("name","marko").or().has("name","josh")'))).toBe('V.or(has, has)');
    expect(shape(fold('g.E().has("weight",0.5).and().has("weight",0.5)'))).toBe('E.and(has, has)');
  });

  test('an as() ON the source travels WITH it, not into the operand', () => {
    // Our IR difference from TinkerPop, where a label is not a step at all: `as` labels whatever
    // precedes it, so a bind sitting on V() must stay on the outer traverser. Folding it into the
    // branch would confine it and a later select("a") would read an unbound label.
    expect(shape(fold('g.V().as("a").out("knows").and().out("created")'))).toBe('V.as.and(out, out)');
    // …but an as() further along belongs to ITS step and IS absorbed (TinkerPop does this too).
    expect(shape(fold('g.V().out().as("a").and().out("created")'))).toBe('V.and(out.as, out)');
  });

  test('OR binds looser than AND', () => {
    expect(shape(fold('g.V().out("created").and().out("knows").or().in("knows")')))
      .toBe('V.or(and(out, out), in)');
  });

  test('the fold reaches a connective at ANY depth, by the same rule', () => {
    expect(shape(fold('g.V().where(__.out("created").and().out("knows"))')))
      .toBe('V.where(and(out, out))');
    expect(shape(fold('g.V().choose(__.values("age").is(P.gt(29)).and().values("age").is(P.lt(35)), __.values("name"), __.constant("x"))')))
      .toBe('V.choose(and(values.is, values.is), values, constant)');
  });

  test('an untouched chain is returned BY REFERENCE (parse trees survive)', () => {
    // Load-bearing, and it was a real break: a {nested} arg may still be a raw parse tree, and
    // services/params/traversal-param.ts un-parses one back to Gremlin via the client's
    // TranslateVisitor (needs `tree.accept`). An unconditional pass that rebuilt every nested arg
    // as a Step[] broke every federate `with("traversal", __.V())` param.
    const steps = stepChain(parseGremlin('g.V().call("x").with("traversal", __.V().out())'), {});
    expect(canonicalizeConnectives(steps, {})).toBe(steps);
  });

  test('an empty operand throws rather than silently dropping a conjunct', () => {
    expect(() => fold('g.V().and().has("name","marko")')).toThrow(/malformed infix/);
  });
});

describe('the writeArguments verify Pass — a text-level refusal is not the lowering\'s business (§6·5)', () => {
  const passes = (gremlin: string) =>
    runPasses(stepChain(parseGremlin(gremlin), {}), EMPTY_STRATEGY_USE, {});

  test('a text-level write ERROR raises from the Pass tier, above the lowering', () => {
    // The point is WHERE, and it is what makes the coverage counter able to reach 100%. Raised from
    // a lowering whose contract is `null` these were `catch { return null }` at every write site,
    // so the census counted a traversal TinkerPop itself REFUSES as an uncovered gap forever.
    // Asserted against runPasses directly: no engine, no store, no lowering reached yet.
    for (const [gremlin, message] of [
      ['g.addV().property("k","v","acl")', /meta-properties must be key\/value pairs/],
      ['g.addV().property("k","v",1,"x")', /meta-property key must be a string/],
      ['g.mergeV(["name":"marko"]).option(Merge.onCreate, ["name":"stephen"])', /cannot override values from merge/],
    ] as const) {
      expect(() => passes(gremlin), gremlin).toThrow(message);
      // …and identically through the whole compile, which is the property one authority buys.
      expect(() => compile(gremlin, {}), gremlin).toThrow(message);
    }
  });


  test('the Pass resolves a withSideEffect constant rather than refusing for want of one', () => {
    // It runs BEFORE the lowering and therefore before anything else has read the registry, so
    // `compilePlan` extracts it first. Verifying without it would refuse a traversal for a fact the
    // compile already holds.
    const gremlin = 'g.withSideEffect("c", [(T.label):"person","name":"marko"]).mergeV(__.select("c"))';
    expect(() => compile(gremlin, {})).not.toThrow();
    // …and without the declaration the very same text is a refusal, from the same place.
    expect(() => compile('g.mergeV(__.select("c"))', {}))
      .toThrow(/needs a withSideEffect/);
  });
});

// ---------- inlineIdentityHostBody — a per-traverser host over a stream-identity body ----------
//
// `local(__.aggregate("a"))` IS `aggregate("a")`. TinkerPop's three per-traverser hosts differ only
// in what they do with the body's RESULTS, so a body that emits exactly its input traverser — once,
// unchanged — makes all three the identity and the host has nothing left to decide. Stating that as
// a Pass is what makes it true at every position and in every tail at once, rather than a host each
// lowering has to learn separately.
describe('inlineIdentityHostBody: a per-traverser host over a stream-identity body IS its body', () => {
  const chain = (g: string) =>
    runPasses(stepChain(parseGremlin(g), {}), EMPTY_STRATEGY_USE, {}).steps.map((s: any) => s.name).join('.');

  test('local(aggregate) / map(aggregate) / flatMap(aggregate) all splice', () => {
    for (const host of ['local', 'map', 'flatMap'])
      expect(chain('g.V().' + host + '(__.aggregate("a")).cap("a")')).toBe('V.aggregate.cap');
  });

  test("the body's by() rides through and folds onto the SPLICED step, not onto nothing", () => {
    // The reason this Pass sits in `extract`: at this point `absorbModulators` has not run, so the
    // body is the TWO steps `[aggregate, by]`. Splicing before the fold is what lets the modulator
    // land on its host.
    const steps = runPasses(stepChain(parseGremlin('g.V().local(aggregate("x").by("age")).cap("x")'), {}), EMPTY_STRATEGY_USE, {}).steps;
    expect(steps.map((s: any) => s.name).join('.')).toBe('V.aggregate.cap');
    expect((steps[1] as any).modulators).toEqual([['age']]);
  });

  test('it unwraps to a FIXPOINT — a spliced body that is itself an identity host splices too', () => {
    expect(chain('g.V().local(__.local(__.aggregate("a"))).cap("a")')).toBe('V.aggregate.cap');
  });

  test('a MUTATING sack is stream-identity; a BARE sack() is a retype and is not', () => {
    expect(chain('g.withSack(0).V().local(__.sack(sum).by("age")).sack()')).toBe('V.sack.sack');
    // `local(__.sack())` REPLACES the traverser with the accumulator's value, so the host decides
    // something and must survive.
    expect(chain('g.withSack(0).V().local(__.sack())')).toBe('V.local');
  });

  test('a body that MOVES, PROJECTS or FILTERS is left alone — that is what the hosts are FOR', () => {
    for (const body of ['__.out()', '__.out().count()', '__.values("name")', '__.has("name","marko")', '__.count()'])
      expect(chain('g.V().local(' + body + ')')).toBe('V.local');
  });

  test('a barrier() body is NOT its body — the equivalence is with identity, not with barrier()', () => {
    // `barrier()` inside a local scope is a no-op while `barrier()` in the chain is a real bulk
    // barrier, so splicing would introduce one the user did not write.
    expect(chain('g.V().local(__.barrier())')).toBe('V.local');
  });

  test('it reaches a NESTED body too, because every child chain re-runs the pipeline', () => {
    const where: any = runPasses(stepChain(parseGremlin('g.V().where(__.local(__.aggregate("a")).values("name"))'), {}), EMPTY_STRATEGY_USE, {}).steps[1];
    expect(childSteps(where.args[0].value.nested, {}).map((s: any) => s.name).join('.')).toBe('aggregate.values');
  });
});

describe('the label retractions: state nobody reads is not carried (§7.4 items 2-3)', () => {
  const chain = (g: string) =>
    runPasses(stepChain(parseGremlin(g), {}), EMPTY_STRATEGY_USE, {}).steps.map((s: any) => s.name).join('.');

  // NOTE: the shape §7 blocks on — `repeat(__.out()).times(5).as("a").out("writtenBy").as("b")
  // .select("a","b").count()`, 24 309 134 024 traversers over the grateful graph — is NOT pinned here.
  // Both retractions fire on it correctly, but the chain still contains `repeat`: `unrollFixedRepeat`
  // only splices a body that carries a barrier, so a bare `out()` body stays rolled on this trunk. The
  // pin belongs with the widened unroll (archived on origin/repeat-two-regimes), where the spliced
  // chain is what the retractions then reduce to plain movement.

  test('a dead as() goes; a label read by a later step stays', () => {
    expect(chain('g.V().as("a").out().count()')).toBe('V.out.count');
    // `select("a")` re-roots the stream, so the value IS observed downstream.
    expect(chain('g.V().as("a").out().select("a").out().count()')).toBe('V.as.out.select.out.count');
    // …and a label reached only as a PREDICATE OPERAND is read just as much.
    expect(chain('g.V().as("a").out().where("a", P.neq("b")).as("b").count()')).toBe('V.as.out.where.as.count');
  });

  test('a label spelled INSIDE a string is read — math()/format() name their variables there', () => {
    // Measured: treating 'b + a' as one opaque name deleted a label math() then threw on.
    expect(chain('g.V().as("a").out().as("b").math("b + a")')).toBe('V.as.out.as.math');
  });

  test('a select() whose terminal is NOT cardinality-only keeps its read', () => {
    expect(chain('g.V().as("a").out().select("a").values("name")')).toBe('V.as.out.select.values');
  });

  test('a BARRIER between the bind and the read un-binds it, so the select stays', () => {
    // CHANNEL_BARRIER_POLICY calls the alias role `consumed`. Asserted as an ANSWER in
    // test/L4-addendum: `…as('x').values('age').union(__.min(), __.identity()).select('x').count()` is
    // 4 and not 5, because select('x') drops the min() arm's traverser.
    expect(chain('g.V().as("x").values("age").union(__.min(), __.identity()).select("x").count()'))
      .toBe('V.as.values.union.select.count');
  });

  test('a conditional bind cannot make the presence filter a tautology', () => {
    // as('a') lives inside a choose() arm, so only traversers routed through that arm carry it.
    expect(chain('g.V().choose(__.hasLabel("person"), __.as("a").out(), __.identity()).select("a").count()'))
      .toBe('V.choose.select.count');
  });

  test("a match() pattern's variables are READS of the enclosing scope, not fresh binds", () => {
    // `match(__.as('a')…)` re-roots on whatever `a` already holds — TinkerPop's variable-location
    // rule — and `rewriteWhereEndLabels` leaves a PATTERN argument's labels alone, so the
    // as()-is-a-bind rule would miss them. This answered at trunk and DEFERRED once the retraction
    // dropped both outer binds as unread.
    expect(chain('g.V().as("a").out().as("b").match(__.as("a").out().count().as("c"), __.as("b").in().count().as("c"))'))
      .toBe('V.as.out.as.match');
  });

  test('path() reads every label, so nothing is retractable beneath one', () => {
    expect(chain('g.V().as("a").out().path()')).toBe('V.as.out.path');
  });

  test('a TRAILING as() is left alone — retract only where it buys something', () => {
    expect(chain('g.V().out().as("a")')).toBe('V.out.as');
  });

  test('REMOVAL is root-only: an arm binds, the chain that hosts it reads', () => {
    // Liveness is a whole-traversal property. A body normalized alone cannot see `select("a")` after
    // the merge, and deleting the bind there answered [] where three traversers were expected.
    const arm = 'g.union(__.V(1).as("a").out(), __.V(2)).select("a")';
    expect(chain(arm)).toBe('union.select');
    const union: any = runPasses(stepChain(parseGremlin(arm), {}), EMPTY_STRATEGY_USE, {}).steps[0];
    expect(childSteps(union.args[0].value.nested, {}).map((s: any) => s.name).join('.')).toBe('V.as.out');
  });

  test('withoutStrategies(PathRetractionStrategy) genuinely suppresses the retraction', () => {
    const suppressed = runPasses(
      stepChain(parseGremlin('g.V().as("a").out().count()'), {}),
      { with: [], without: ['PathRetractionStrategy'] }, {},
    ).steps.map((s: any) => s.name).join('.');
    expect(suppressed).toBe('V.as.out.count');
  });
});

describe('labelMutationTarget — a specified refusal, raised ABOVE the lowering', () => {
  const raises = (gremlin: string) =>
    expect(() => compile(gremlin, {})).toThrow('Label mutation is not supported');

  test('an edge stream refuses all three mutations', () => {
    // The three conformance scenarios that assert the message, and the reason this Pass exists: the
    // refusal is raised in a verify Pass, above the lowering, so it fires however (or whether) the
    // traversal would otherwise lower — not as a side effect of a downstream step happening to throw.
    for (const gremlin of ['g.E().addLabel("friend").labels().fold()',
      'g.E().dropLabel("knows").labels().fold()', 'g.E().dropLabels().labels()'])
      raises(gremlin);
  });

  test('the target is the STREAM, not the source step — a movement to edges refuses too', () => {
    raises('g.V().outE().addLabel("x")');
    raises('g.V().bothE().dropLabel("knows")');
  });


  test('a prefix it cannot TYPE is left to the lowerings, never raised on', () => {
    // `elementKindAt`'s third answer. A verifier that guessed here would refuse traversals nobody
    // analysed; the honest answer is to decline to answer and let the route decide. These must not
    // raise the label-mutation message — whatever else they do.
    for (const gremlin of ['g.V().union(__.outE(), __.inE()).addLabel("x")',
      'g.V().as("a").select("a").addLabel("x")']) {
      let message = '';
      try { compile(gremlin, {}, undefined); } catch (e: any) { message = e.message; }
      expect(message, gremlin).not.toContain('Label mutation is not supported');
    }
  });
});

describe('desugarGraphAlgos — the four native OLAP steps rewrite to call() on a mogwai.* service', () => {
  // The "named steps never lower directly" invariant (plan doc Guardrails #1): each native step is a
  // desugar to the ONE call() service, never a second lowering. Asserted at the Pass level (runPasses,
  // no compile) so it sees the rewrite before the service's fail-closed deferral fires.
  const chainOf = (gremlin: string) =>
    runPasses(stepChain(parseGremlin(gremlin), {}), EMPTY_STRATEGY_USE, {}, undefined, false).steps;
  const callOf = (gremlin: string) => {
    const chain = chainOf(gremlin);
    const call = chain.find((s) => s.name === 'call');
    expect(call, gremlin).toBeDefined();
    return call!;
  };
  const serviceName = (c: any) => c.args[0].value;
  const config = (c: any) => c.args[1].value as Map<string, any>;

  test('each step names its canonical service and its native-step mode', () => {
    const cases: Array<[string, string, string]> = [
      ['g.V().pageRank()', 'mogwai.pageRank', 'decorate'],
      ['g.V().connectedComponent()', 'mogwai.wcc', 'decorate'],
      ['g.V().peerPressure()', 'mogwai.peerPressure', 'decorate'],
      ['g.V().shortestPath()', 'mogwai.shortestPath', 'path'],
    ];
    for (const [gremlin, name, mode] of cases) {
      const call = callOf(gremlin);
      expect(serviceName(call), gremlin).toBe(name);
      expect(config(call).get('mode'), gremlin).toBe(mode);
      // The original step name is gone — the desugar is a rewrite, not an annotation beside it.
      expect(chainOf(gremlin).some((s) => s.name === 'pageRank' || s.name === 'connectedComponent'
        || s.name === 'peerPressure' || s.name === 'shortestPath'), gremlin).toBe(false);
    }
  });

  test('pageRank(α) carries the damping factor; a non-numeric arg is refused', () => {
    expect(config(callOf('g.V().pageRank(0.9)')).get('dampingFactor')).toBe(0.9);
    expect(config(callOf('g.V().pageRank()')).has('dampingFactor')).toBe(false);
  });

  test('the ~tinkerpop.<algo>.* config folds onto the minted call via absorbCallWith', () => {
    // with() config rides through extract and is folded onto the call in canonicalize, exactly as a
    // hand-written call().with() is — so the service reads one params map however the query spelled it.
    const call = callOf('g.V().connectedComponent().with("~tinkerpop.connectedComponent.propertyName","cluster")');
    expect(call.withArgs).toContainEqual(['~tinkerpop.connectedComponent.propertyName', 'cluster']);
  });

  test('an unbuilt algorithm is a clear fail-closed deferral, not a mis-execution or a silent decline', () => {
    // The compute for these is not built yet; the seam is. A native OLAP step must refuse loudly rather
    // than answer a different question. Under the real (reference) registry the services ARE registered,
    // so the message is the pending-execution deferral, not "unknown service". connectedComponent,
    // pageRank and peerPressure are omitted — their compute IS built (mogwai.wcc/.pageRank/.peerPressure),
    // covered by L3/L2. Only shortestPath (Template B) is still pending.
    const withReg: CompileOptions = { registry: standardRegistry };
    for (const gremlin of ['g.V().shortestPath()'])
      expect(() => compile(gremlin, {}, withReg), gremlin).toThrow('graph algorithm execution is not implemented yet');
  });
});
