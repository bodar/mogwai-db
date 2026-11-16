// THE REALISTIC PROFILE — app-shaped compositions over the `modern` schema, for the depth curve
// (`coverage.ts`, cc0-curve in docs/2026-11-15-compositional-coverage-plan.md).
//
// The lattice generator (`generate.ts`) is type-correct but semantically arbitrary: it draws children like
// `where(__.min())` or `filter(__.valueMap())` that no application writes, so its decline rate at depth
// mixes real gaps with noise. This grammar draws only idioms an app developer writes — walks over real
// edge labels, filters on real keys, and the hosts (`where`/`not`/`project().by`/`group().by`/`order().by`/
// `local`/`map`/`coalesce`/`optional`/`union`/`choose`/`repeat`) wrapping each other to a chosen depth.
// It is deliberately SMALL and schema-bound: its job is a stable, realistic curve, not discovery.
import fc from 'fast-check';

type Pick = <T>(options: readonly T[]) => T;
type Gen = { pick: Pick; chance: (pct: number) => boolean };

const PERSON_KEYS = ['name', 'age'] as const;

/** One hop from a vertex to vertices, with an optional realistic filter. */
function hop(g: Gen): string {
  const base = g.pick([
    "out('knows')", "out('created')", "in('created')", "in('knows')", 'both()', 'out()',
    "outE('created').inV()", "inE('knows').outV()", "both('created')",
  ]);
  if (!g.chance(35)) return base;
  return base + '.' + g.pick([
    "has('age',P.gt(30))", "has('lang','java')", "hasLabel('person')", "hasLabel('software')",
    "has('name',P.neq('marko'))", "has('age')",
  ]);
}

/** A vertex→vertex walk body, possibly itself holding a host at `depth - 1`. */
function walk(g: Gen, depth: number): string {
  const parts = [hop(g)];
  if (g.chance(40)) parts.push(hop(g));
  // With depth budget left, nest more often than not, so every depth level is actually populated.
  if (depth > 0 && g.chance(75)) parts.push(filterHost(g, depth - 1));
  if (g.chance(20)) parts.push(g.pick(['dedup()', 'limit(2)', "order().by('name')", 'simplePath()']));
  return parts.join('.');
}

/** A vertex→ONE value body (what a `by()`/`map()` wants). */
function value(g: Gen, depth: number): string {
  const options: (() => string)[] = [
    () => `values('${g.pick(PERSON_KEYS)}')`,
    () => 'count()',
    () => `${walk(g, depth)}.count()`,
    () => `${walk(g, depth)}.values('name').fold()`,
    () => `${hop(g)}.values('name').dedup().fold()`,
    () => "outE().values('weight').mean()",
    () => "outE().values('weight').sum()",
    () => 'elementMap()',
    () => `${hop(g)}.count().is(P.gt(0))`,
  ];
  // With depth budget left, draw the NESTING idioms twice as often as the flat ones.
  if (depth > 0) for (let i = 0; i < 2; i++) options.push(
    () => `${hop(g)}.${projectHost(g, depth - 1)}.fold()`,
    () => `coalesce(__.${hop(g)}.values('name').fold(), __.constant([]))`,
    () => `${hop(g)}.values('age').max()`,
    () => `${walk(g, depth - 1)}.path().by('name')`,
    () => `${walk(g, depth - 1)}.groupCount().by(label)`,
  );
  return g.pick(options)();
}

/** A filtering host. */
function filterHost(g: Gen, depth: number): string {
  return g.pick<() => string>([
    () => `where(__.${walk(g, depth)})`,
    () => `not(__.${walk(g, depth)})`,
    () => `where(__.${walk(g, depth)}.count().is(P.gt(${g.pick([0, 1, 2])})))`,
    () => `filter(__.or(__.has('age',P.gt(30)), __.${walk(g, depth)}))`,
    () => `and(__.${hop(g)}, __.${walk(g, depth)})`,
  ])();
}

/** A `project()` host with one plain and one computed `by()`. */
function projectHost(g: Gen, depth: number): string {
  return `project('a','b').by('name').by(__.${value(g, depth)})`;
}

/** A host that ends the traversal with a value-shaped result. */
function terminalHost(g: Gen, depth: number): string {
  return g.pick<() => string>([
    () => projectHost(g, depth),
    () => `group().by('name').by(__.${value(g, depth)})`,
    () => `groupCount().by(__.${value(g, depth)})`,
    () => `order().by(__.${walk(g, depth)}.count(), desc).values('name')`,
    () => `map(__.${value(g, depth)})`,
    () => `local(__.${walk(g, depth)}.limit(1)).values('name')`,
    () => `optional(__.${walk(g, depth)}).values('name')`,
    () => `union(__.${walk(g, depth)}, __.${walk(g, depth)}).dedup().values('name')`,
    () => `choose(__.has('age',P.gt(30)), __.${walk(g, depth)}, __.${walk(g, depth)}).values('name')`,
    () => `coalesce(__.${walk(g, depth)}.values('name'), __.values('name'))`,
    () => `repeat(__.${walk(g, Math.max(0, depth - 1))}).times(2).values('name')`,
    () => `${filterHost(g, depth)}.values('name')`,
  ])();
}

const SOURCES = [
  "g.V().hasLabel('person')", "g.V().has('name','marko')", 'g.V()', "g.V().hasLabel('software')",
] as const;

/** One realistic traversal whose host nesting is at most `maxDepth` levels below the root host. */
export const realisticTraversal = (maxDepth: number): fc.Arbitrary<{ query: string }> =>
  fc.gen().map((gen) => {
    const pick: Pick = (options) => options[gen(fc.nat, { max: options.length - 1 })]!;
    const g: Gen = { pick, chance: (pct) => gen(fc.nat, { max: 99 }) < pct };
    const depth = gen(fc.nat, { max: maxDepth });
    const prefix = g.chance(30) ? `.${hop(g)}` : '';
    return { query: `${pick(SOURCES)}${prefix}.${terminalHost(g, depth)}` };
  });
