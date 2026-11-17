#!/usr/bin/env bun
/**
 * SCALING PROBE — the plan-cost instrument for the scoped-relation connector
 * (`docs/2026-11-15-compositional-coverage-plan.md` §5 cost discipline, Phase 3 item (b)).
 *
 * Runs each probe shape over a synthetic graph at N vertices (~2.5 out-edges each) under the three
 * `correlatedChild` configurations and reports, per shape and N: the median execute time, the SQL bytes and
 * the JOIN count of the plan.
 *
 *   LADDER  — `correlatedChild` on (opt-in): the ladder of correlated routes first, the connector its fallback;
 *   DEFAULT — the shipping default since the Phase 3 inversion: the connector first, the ladder its fallback;
 *   CONN    — the connector ALONE (`MOGWAI_CONNECTOR_ONLY=1`): what the general path costs with no ladder.
 *
 * `MOGWAI_CONNECTOR_ONLY` is read once at module load, so each configuration is a CHILD process
 * (`--child <mode> <n>`) and this parent only tabulates. An INSTRUMENT, deliberately not in `ci`: its numbers
 * are wall-clock and need judgement.
 *
 *   bun scripts/scaling-probe.ts                  # 1k and 8k, every shape
 *   bun scripts/scaling-probe.ts --sizes 1000     # one size
 *   bun scripts/scaling-probe.ts --only nested    # shapes whose name contains the text
 *   bun scripts/scaling-probe.ts --sql <name>     # print the plan's SQL + EXPLAIN QUERY PLAN per mode (1k)
 */
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { compile } from '../src/compiler/compiler.ts';
import { loadBulk, type BulkEdge, type BulkVertex } from '../src/bulk.ts';

interface Shape { readonly name: string; readonly query: string }

/** §5's shapes, then the connector-only and nested ones the G2 measurement added. */
const SHAPES: readonly Shape[] = [
  { name: 'order.by(select)', query: "g.V().as('a').out().order().by(select('a').values('name')).values('name')" },
  { name: 'project.by(age)', query: "g.V().project('x').by('age')" },
  { name: 'map(values)', query: "g.V().map(values('age'))" },
  { name: 'where(count.is)', query: 'g.V().where(out().count().is(gt(1)))' },
  { name: 'dedup.by(name)', query: "g.V().dedup().by('name')" },
  { name: 'project.coalesce', query: "g.V().project('n','c').by('name').by(coalesce(values('age'),constant(0)))" },
  { name: 'map(out.values)', query: "g.V().map(out().values('name'))" },
  { name: 'project.by(in.fold)', query: "g.V().project('n','m').by('name').by(in('knows').values('name').fold())" },
  { name: 'where(simplePath)', query: 'g.V().where(out().simplePath())' },
  { name: 'nested where x3', query: "g.V().where(out().where(out().where(has('age',gt(40)))))" },
  { name: 'nested project', query: "g.V().project('a').by(project('b').by(out().count()))" },
  { name: 'not(out.has)', query: "g.V().not(out().has('age',gt(40)))" },
  { name: 'where(out.out)', query: "g.V().where(out('knows').out('knows'))" },
  { name: 'map(out.count)', query: 'g.V().map(out().count())' },
  // A host carrying an `as()` label (a COMPUTED column) the body does not read, and a host after a hop.
  { name: 'as.where(out.has)', query: "g.V().as('a').where(out().has('age',gt(40))).select('a')" },
  { name: 'as.map(out.count)', query: "g.V().as('a').map(out().count())" },
  { name: 'out.map(values)', query: "g.V().out().map(values('age'))" },
  // The Phase 3 inversion (cc3c) put `group().by(k).by(<barrier>)` on the connector's pooled group, and
  // `local`/`flatMap` and `coalesce` on its rows: the app idioms those take.
  { name: 'group.by(label).by(count)', query: 'g.V().group().by(label).by(count())' },
  { name: 'group.by(name).by(both.count)', query: "g.V().group().by('name').by(both().count())" },
  { name: 'group.by(label).by(fold)', query: "g.V().group().by(label).by(values('name').order().by(desc).fold())" },
  { name: 'group.by(name).by(tail)', query: "g.V().group().by('name').by(tail())" },
  { name: 'local(out.count)', query: 'g.V().local(out().count())' },
  { name: 'local(both.dedup)', query: "g.V().local(both('created').dedup())" },
  { name: 'where(out.values.is)', query: "g.V().where(out().values('age').is(30))" },
  // The ladder audit (Phase 3 (d)): one shape per remaining host family, so every route deleted or kept has
  // its margin measured here.
  { name: 'local(choose.option.fold)', query: "g.V().local(choose(values('age')).option(between(26, 30), values('name').fold()).option(none, values('name').fold()))" },
  { name: 'flatMap(out.out)', query: "g.V().flatMap(out().out()).count()" },
  { name: 'local(out.limit)', query: "g.V().local(out().order().by('name').limit(1))" },
  { name: 'coalesce(values,constant)', query: "g.V().coalesce(values('age'), constant(0))" },
  { name: 'optional(out.knows)', query: "g.V().optional(out('knows')).count()" },
  { name: 'union(out,in)', query: 'g.V().union(out(), in()).count()' },
  { name: 'choose(out,values,constant)', query: "g.V().choose(out('created'), values('name'), constant('none'))" },
  { name: 'choose(values).option', query: "g.V().choose(values('age')).option(between(20, 40), constant('young')).option(none, constant('old'))" },
  { name: 'order.by(out.count)', query: 'g.V().order().by(out().count()).limit(10)' },
  { name: 'dedup.by(out.count)', query: 'g.V().dedup().by(out().count())' },
  { name: 'groupCount.by(out.count)', query: 'g.V().groupCount().by(out().count())' },
  { name: 'project.by(out.count)', query: "g.V().project('a','b').by(out().count()).by(values('name'))" },
  { name: 'and(out,in)', query: 'g.V().and(out(), in()).count()' },
  { name: 'or(out.has,in)', query: "g.V().or(out().has('age', gt(40)), in('created')).count()" },
  // A per-traverser reducer beside a default (the rejoin clears `reducedGlobally`, the arm meet re-types `vt`).
  { name: 'reducer arm: union(local(sum),constant)', query: "g.V().union(local(outE().values('weight').sum()), constant(0))" },
  { name: 'reducer arm: choose(local(mean),constant)', query: "g.V().choose(hasLabel('person'), local(outE().values('weight').mean()), constant(0))" },
  { name: 'reducer arm: id.union(map(sum),identity)', query: 'g.V().id().union(map(sum()), identity())' },
  { name: 'reducer arm: match(map(mean))', query: "g.V().match(__.as('a').map(inE('created').values('weight').mean()).as('b')).select('b')" },
  { name: 'reducer arm: union(local(sum),out)', query: "g.V().union(local(outE().values('weight').sum()), out())" },
  { name: 'reducer arm: group.by(union(local(sum),constant).sum)', query: "g.V().group().by(label).by(union(local(outE().values('weight').sum()), constant(0)).sum())" },
  // R3 (docs/2026-11-16-ladder-retirement-plan.md): the existence prefix and the alias compare's landed by().
  { name: 'where(a,gt(b)).by(out.count)', query: "g.V().as('a').out().as('b').where('a', gt('b')).by(out().count()).count()" },
  { name: 'where(a,neq(b)).by(landed)', query: "g.V().as('a').out().as('b').where('a', neq('b')).by(out().order().by('name').values('name').limit(1)).count()" },
  { name: 'where(out.sample)', query: 'g.V().where(out().sample(1)).count()' },
  { name: 'not(has.project.by(path))', query: "g.V().not(has('age',lt(1)).project('a','b').by(identity()).by(cyclicPath().hasId(4))).count()" },
  { name: 'where(project.by(path))', query: "g.V().where(project('b').by(path())).count()" },
  { name: 'coalesce(has.project,has.project)', query: "g.V().coalesce(has('age').project('a').by(values('name')), hasNot('age').project('a').by(values('name'))).count()" },
  { name: 'local(where(out.project))', query: "g.V().local(where(out().project('x').by(path()))).count()" },
  { name: 'union(where(out.limit),id)', query: 'g.V().union(where(out().limit(2)), identity()).count()' },
  { name: 'choose(out.project.by(path),a,b)', query: "g.V().choose(out().project('x').by(path()), constant('a'), constant('b')).count()" },
  // A RE-SOURCING body (`lower/scoped.ts` `reSourcedBody`): the read after `V()` computed once and crossed with
  // the host, never a graph scan per traverser. `local(V()…)`'s OUTPUT is hosts × matches, so its count is the
  // probe (the rows are the answer's own size).
  { name: 'map(V.count)', query: 'g.V().map(V().count())' },
  { name: 'map(V.values)', query: "g.V().map(V().values('name'))" },
  // `dedup()` added by 6e58b6d2 (N1): the undeduped output is hosts × matches, so the dedup keeps the row probing the
  // shared read rather than the answer's own N × G size.
  { name: 'local(V.has.values).count', query: "g.V().local(V().has('age',gt(30)).values('name')).dedup().count()" },
  { name: 'as.map(select.V.count)', query: "g.V().as('p').map(select('p').V().hasLabel('software').count())" },
  { name: 'where(V.has)', query: "g.V().where(V().has('age',gt(40))).count()" },
  { name: 'group.by(label).by(V.count)', query: 'g.V().group().by(label).by(V().count())' },
  // GraphStep's general cross in the fold (N1): a prefix carrying a path, a read binding its own label, a rest
  // reading host state under an all-rows host. The `local` shapes' OUTPUT is N × G, so probe them by
  // TRAVERSERS (`--sizes 32,90` puts N × G near 1k and 8k), the others at 1k/8k vertices.
  { name: 'resource: map(V.count).path', query: 'g.V().map(V().count()).path()' },
  { name: 'resource: out.map(V.count).path', query: 'g.V().out().map(V().count()).path()' },
  { name: 'resource: both.simplePath.map(V.count)', query: 'g.V().both().simplePath().map(V().count()).sum()' },
  { name: 'resource: map(V.has.as.out.select)', query: "g.V().map(V().has('name','p1').as('m').out().select('m').values('name')).dedup().count()" },
  { name: 'resource: out.map(V.values).path', query: "g.V().out().map(V().values('name')).path()" },
  { name: 'resource: out.V.has.path', query: "g.V().out().V().has('name','p1').path().count()" },
  { name: 'resource: sack.V.sack', query: 'g.V().sack(assign).by(constant(1)).V().has(\'name\',\'p1\').sack().count()' },
  { name: 'resource xNG: local(V.as.out.select)', query: "g.V().local(V().as('x').out().select('x')).count()" },
  { name: 'resource xNG: local(V.as.out.where(neq))', query: "g.V().local(V().as('x').out().where(neq('x'))).count()" },
  { name: 'resource xNG: local(V.values.as.select)', query: "g.V().local(V().values('name').as('n').select('n')).count()" },
  { name: 'resource xNG: as.local(V.as.select(a,b))', query: "g.V().as('a').local(V().as('b').select('a','b')).count()" },
  { name: 'resource xNG: local(V.has.as).select', query: "g.V().local(V().has('age',gt(30)).as('x')).select('x').count()" },
  { name: 'resource xNG: sack.V.sack', query: 'g.V().sack(assign).by(constant(1)).V().sack().count()' },
  // Reach contrived (M2): an instrument, no fix owed.
  { name: 'resource xNG: as.local(V.as.out.where(neq(a))).count', query: "g.V().as('a').local(V().as('x').out().where(neq('a')).count()).count()" },
  // The first-row hosts the N1 review measured quadratic when a path-carrying or simplePath prefix fell to the
  // fold's per-row cross: the shared read must stay ONE read under them.
  { name: 'resource: out.map(V.max).path', query: "g.V().out().map(V().values('age').max()).path().count()" },
  { name: 'resource: out.where(V.out.has).path', query: "g.V().out().where(V().out().has('name','zzz')).path().count()" },
  { name: 'resource: both.simplePath.map(V.max)', query: "g.V().both().simplePath().map(V().values('age').max()).count()" },
  { name: 'resource: out.map(V.limit.values).path', query: "g.V().out().map(V().limit(1).values('name')).path().count()" },
  // `flatMap` splits the HOST (`FlatMapStep` `head.split(r)`): the host path crosses the shared read as `map`'s does.
  { name: 'resource: out.flatMap(V.has).path', query: "g.V().out().flatMap(V().has('name','p1')).path()" },
  // `tree()` collects the same paths in the rejoin's encounter order (one sort, not a per-row term).
  { name: 'resource: out.flatMap(V.has).tree', query: "g.V().out().flatMap(V().has('name','p1')).tree().by('name')" },
  { name: 'flatMap(out).tree', query: "g.V().flatMap(out()).tree().by('name')" },
  { name: 'union(out,in).tree', query: "g.V().union(out(),in()).tree().by('name')" },
  { name: 'resource: out.local(V.order.limit).path', query: "g.V().out().local(V().order().by('name').limit(1)).path().count()" },
  { name: 'project.by(V.count)', query: "g.V().project('n','c').by('name').by(V().count())" },
  // N3: a pooled re-source's value is an Aggregate over pool-weight × graph, factored per side by `fuse`'s
  // AggregateJoinTransposeRule (`src/rel/passes/fuse.ts` `factor`) — never |keys| × |V| rows.
  { name: 'ajt: group.by(name).by(V.count)', query: "g.V().group().by('name').by(V().count())" },
  { name: 'ajt: both.group.by(name).by(V.count)', query: "g.V().both().group().by('name').by(V().count())" },
  { name: 'ajt: group.by(label).by(V.out.count)', query: 'g.V().group().by(label).by(V().out().count())' },
  { name: 'ajt: group.by(name).by(V.values.sum)', query: "g.V().group().by('name').by(V().values('age').sum())" },
  { name: 'ajt: group.by(name).by(V.has.count)', query: "g.V().group().by('name').by(V().has('name','zzz').count())" },
  { name: 'ajt: group.by(name).by(E.count)', query: "g.V().group().by('name').by(E().count())" },
  { name: 'ajt: groupCount.by(name).map(V.count)', query: "g.V().local(group().by('name').by(V().count())).count()" },
  { name: 'ajt: project.by(group.by(name).by(V.count))', query: "g.V().hasLabel('software').project('g').by(V().group().by('name').by(V().count()))" },
  // The unit row is never a CTE (`isUnitValues`, `src/rel/block.ts`): first-row `map(<traversal>)` reads, at depth.
  { name: 'unit: map(values(name))', query: "g.V().map(values('name'))" },
  { name: 'unit: withPath.as.out.map(select.values)', query: "g.withPath().V().as('a').out().map(select('a').values('name'))" },
  { name: 'unit: local(map(out.values))', query: "g.V().local(map(out().values('name')))" },
  { name: 'unit: where(map(out.values).is)', query: "g.V().where(map(out().values('name')).is('p1')).count()" },
  { name: 'unit: union(map(values),map(out.values))', query: "g.V().union(map(values('name')), map(out().values('name')))" },
  { name: 'unit: project.by(map(out.values))', query: "g.V().project('a').by(map(out().values('name')))" },
  { name: 'unit: repeat(out).times(2).map(values)', query: "g.V().repeat(out()).times(2).map(values('name'))" },
  // N5: a per-key min/max is ONE `GROUP BY` argmin (`arg_min`/`arg_max`, SQLite's MIN/MAX with bare columns),
  // keyed by the decorrelator's Aggregate rule — no window, no materialize, at the root and in a body alike.
  { name: 'minmax: project.by(outE.values.min)', query: "g.V().project('n','m').by('name').by(outE().values('weight').min())" },
  { name: 'minmax: map(outE.values.min)', query: "g.V().map(outE().values('weight').min()).count()" },
  { name: 'minmax: union(map(min),constant)', query: "g.V().union(map(outE().values('weight').min()), constant(0)).count()" },
  { name: 'minmax: local(outE.values.max)', query: "g.V().local(outE().values('weight').max()).count()" },
  { name: 'minmax: map(out.values(age).max)', query: "g.V().map(out().values('age').max()).count()" },
  { name: 'minmax: values(age).min', query: "g.V().values('age').min()" },
  { name: 'minmax: group.by(label).by(values.max)', query: "g.V().group().by(label).by(values('age').max())" },
  { name: 'minmax: where(map(outE.max).is)', query: "g.V().where(map(outE().values('weight').max()).is(gt(0.5))).count()" },
  { name: 'minmax: order.by(outE.values.min)', query: "g.V().order().by(outE().values('weight').min()).limit(5)" },
  // A predicate emit on a bounded repeat: each tested level is its phases + the connector's filter row.
  { name: 'emit: repeat.emit(has).times(2)', query: "g.V().repeat(out()).emit(has('age')).times(2).count()" },
  { name: 'emit: emit(hasLabel).repeat.times(2)', query: "g.V().emit(hasLabel('person')).repeat(out()).times(2).count()" },
  { name: 'emit: times(2).repeat.emit(hasLabel)', query: "g.V().times(2).repeat(out()).emit(hasLabel('person')).count()" },
  { name: 'emit: emit(out.count.is).repeat.times(2)', query: "g.V().emit(out().count().is(gt(1))).repeat(out()).times(2).count()" },
  { name: 'emit: emit(person).repeat(out.order).times(2)', query: "g.V().emit(hasLabel('person')).repeat(out().order().by('name')).times(2).values('name')" },
  { name: 'emit: repeat.emit(loops.is(1)).times(2)', query: "g.V().repeat(out()).emit(loops().is(1)).times(2).count()" },
  { name: 'emit: local(repeat.emit(has).times(2).count)', query: "g.V().local(repeat(out()).emit(has('age')).times(2).count())" },
  { name: 'emit: where(repeat.emit(has).times(2))', query: "g.V().where(repeat(out()).emit(has('age', gt(40))).times(2)).count()" },
  { name: 'emit: repeat.emit(has).times(3)', query: "g.V().repeat(out()).emit(has('age', gt(40))).times(3).count()" },
  // R6: a side effect collected inside a child body — the body and its collector sites keyed in ONE
  // decorrelation (`keyedBody`), the sites one relation over every scope, read at the cap.
  { name: 'collect: sideEffect(out.aggregate).cap.count', query: "g.V().sideEffect(out().aggregate('x')).cap('x').unfold().count()" },
  { name: 'collect: sideEffect(where(out).aggregate)', query: "g.V().sideEffect(where(out()).aggregate('x')).cap('x').unfold().count()" },
  { name: 'collect: both.sideEffect(aggregate)', query: "g.V().both().sideEffect(aggregate('x')).cap('x').unfold().count()" },
  { name: 'collect: sideEffect(out.groupCount.by(name))', query: "g.V().sideEffect(out().groupCount('x').by('name')).cap('x')" },
  { name: 'collect: local(out.aggregate).cap.count', query: "g.V().local(out().aggregate('x')).cap('x').unfold().count()" },
  { name: 'collect: sideEffect(out.aggregate).cap (fold)', query: "g.V().sideEffect(out().aggregate('x')).cap('x').count(local)" },
  { name: 'collect: nested sideEffect(out.sideEffect(out.aggregate))', query: "g.V().sideEffect(out().sideEffect(out().aggregate('x'))).cap('x').unfold().count()" },
  { name: 'collect: where(out.aggregate)', query: "g.V().where(out().aggregate('x')).cap('x').unfold().count()" },
  { name: 'collect: optional(out.aggregate)', query: "g.V().optional(out().aggregate('x')).cap('x').unfold().count()" },
  { name: 'collect: sideEffect(out.aggregate).values', query: "g.V().sideEffect(out().aggregate('x')).values('name').count()" },
];

const MODES = { LADDER: {}, DEFAULT: {}, CONN: { MOGWAI_CONNECTOR_ONLY: '1' } } as const;
type Mode = keyof typeof MODES;

/** Deterministic xorshift, so every child and every run sees one graph. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

function graph(n: number): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const r = rng(7);
  const vertices: BulkVertex[] = [];
  for (let i = 1; i <= n; i++) {
    const software = i % 5 === 0;
    const properties = [{ key: 'name', value: `${software ? 's' : 'p'}${i}` }];
    if (!software && r() < 0.9) properties.push({ key: 'age', value: 18 + Math.floor(r() * 50) } as never);
    vertices.push({ id: i, labels: [software ? 'software' : 'person'], properties });
  }
  const edges: BulkEdge[] = [];
  for (let i = 1; i <= n; i++) {
    const k = Math.floor(r() * 6); // 0..5, mean 2.5
    for (let j = 0; j < k; j++) {
      const t = 1 + Math.floor(r() * n);
      edges.push({ label: t % 5 === 0 ? 'created' : 'knows', src: i, tgt: t, properties: [{ key: 'weight', value: r() }] });
    }
  }
  loadBulk(store, vertices, edges);
  return store;
}

interface Row { readonly name: string; readonly ms: number | null; readonly bytes: number; readonly joins: number; readonly rows: number; readonly error?: string }

function child(mode: Mode, n: number, only: string | undefined, sqlOf: string | undefined): void {
  const store = graph(n);
  const fastPaths = { correlatedChild: mode === 'LADDER' };
  const out: Row[] = [];
  for (const shape of SHAPES) {
    if (only && !shape.name.includes(only)) continue;
    if (sqlOf && shape.name !== sqlOf) continue;
    try {
      const plan = compile(shape.query, {}, { fastPaths });
      if (plan.kind !== 'read' || !plan.sql) { out.push({ name: shape.name, ms: null, bytes: 0, joins: 0, rows: 0, error: plan.kind }); continue; }
      if (sqlOf) {
        console.log(`---- ${mode} ----\n${plan.sql}\n`);
        for (const row of store.query('EXPLAIN QUERY PLAN ' + plan.sql, plan.binds)) console.log(`  ${row.id}/${row.parent} ${row.detail}`);
        continue;
      }
      let rows = 0;
      const times: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        rows = store.query(plan.sql, plan.binds).length;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      out.push({ name: shape.name, ms: times[0]!, bytes: plan.sql.length, joins: (plan.sql.match(/\bJOIN\b/g) ?? []).length, rows });
    } catch (error) {
      out.push({ name: shape.name, ms: null, bytes: 0, joins: 0, rows: 0, error: (error as Error).constructor.name });
    }
  }
  if (!sqlOf) console.log(JSON.stringify(out));
}

const argv = Bun.argv.slice(2);
const flag = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

if (argv[0] === '--child') {
  child(argv[1] as Mode, Number(argv[2]), flag('--only'), flag('--sql'));
} else {
  const sizes = (flag('--sizes') ?? '1000,8000').split(',').map(Number);
  const only = flag('--only'), sqlOf = flag('--sql');
  const run = (mode: Mode, n: number): string => {
    const extra = [...(only ? ['--only', only] : []), ...(sqlOf ? ['--sql', sqlOf] : [])];
    const proc = Bun.spawnSync(['bun', import.meta.path, '--child', mode, String(n), ...extra], { env: { ...process.env, ...MODES[mode] }, stderr: 'inherit' });
    return proc.stdout.toString();
  };
  if (sqlOf) {
    for (const mode of Object.keys(MODES) as Mode[]) console.log(run(mode, sizes[0]!));
  } else {
    const results = new Map<string, Map<string, Row>>(); // `${mode}@${n}` → shape → row
    for (const n of sizes) for (const mode of Object.keys(MODES) as Mode[]) {
      const rows = JSON.parse(run(mode, n).trim().split('\n').pop()!) as Row[];
      results.set(`${mode}@${n}`, new Map(rows.map((r) => [r.name, r])));
    }
    const cell = (r: Row | undefined): string => (!r ? '-' : r.ms === null ? `✗${r.error ?? ''}` : r.ms.toFixed(1));
    const header = ['shape', ...sizes.flatMap((n) => (Object.keys(MODES) as Mode[]).map((m) => `${m}@${n / 1000}k`)), 'CONN/LADDER', 'bytes LADDER/CONN', 'joins LADDER/CONN'];
    console.log(`| ${header.join(' | ')} |`);
    console.log(`|${header.map(() => '---').join('|')}|`);
    const last = sizes[sizes.length - 1]!;
    for (const shape of SHAPES) {
      if (only && !shape.name.includes(only)) continue;
      const at = (m: Mode, n: number) => results.get(`${m}@${n}`)?.get(shape.name);
      const on = at('LADDER', last), conn = at('CONN', last);
      const ratio = on?.ms && conn?.ms ? (conn.ms / on.ms).toFixed(2) : '-';
      console.log(`| ${[shape.name, ...sizes.flatMap((n) => (Object.keys(MODES) as Mode[]).map((m) => cell(at(m, n)))), ratio,
        `${on?.bytes ?? '-'}/${conn?.bytes ?? '-'}`, `${on?.joins ?? '-'}/${conn?.joins ?? '-'}`].join(' | ')} |`);
    }
  }
}
