# Query-plan stability — the 516× we are leaving on the floor

A single-vertex lookup plus one hop — the most common shape in the language — takes **9.8 seconds** on
a 20 000-vertex graph. After 0.5 ms of `PRAGMA optimize` it takes **19 ms**. Nothing in the suite sees
this, because every fixture is small enough that the wrong plan is free.

**Two things remain open, and are the reason this document stays:**

- **§3·1's stats schedule** — the `PRAGMA optimize` call sites (after a bulk load, on the alarm); none
  exist yet.
- **§4's plan-stability GATE** — what would stop this regressing. Until it exists the fix is asserted
  only by two L2 access-path assertions, and by nothing that would notice a graph growing.

Numbers are `bun:sqlite`, in-memory synthetic graphs; the platform half re-measured on real workerd via
`test/cf-probe/`. Method: §7.

---

## 1. The measurement

`g.V().has('person','name','marko8').out('knows').values('name')`, warm, ms/op:

| vertices | no stats | after `PRAGMA optimize` | speedup |
|---|---|---|---|
| 6 (modern) | 0.6 | 0.6 | 1.0× |
| 4 000 | 364 | 3.5 | **105×** |
| 20 000 | **9 842** | **19** | **516×** |

The long chain behaves identically (9 937 → 21 ms, 463×). Two other shapes are untouched (`group`
19.2 → 18.5, `valueMap` page 11.0 → 11.0) — so this is a plan decision on specific shapes, not a
warm-cache artefact.

Scaling of the bad plan is **superlinear**: 5× the data, 27× the time; the good plan is roughly linear
(3.5 → 19 ms). The gap widens with graph size, and the DO's request budget is a hard wall somewhere
before 20 000 vertices. `PRAGMA analysis_limit=400; PRAGMA optimize;` cost **0.5 ms** on the
20 000-vertex graph.

## 2. What the planner actually does

The compiled SQL (elided for width — full text reproducible via §7):

```sql
SELECT … FROM edges rme16
  INNER JOIN nodes rn ON ((rme16.src = rn.id) AND rme16.label IN (SELECT … FROM labels …))
  INNER JOIN vertex_properties rp24 ON ((rp24.node = rme16.tgt) AND rp24.key IN ('name'))
WHERE (rn.id IN (SELECT rvl6.node FROM vertex_labels rvl6 WHERE rvl6.label IN (…'person'…))
   AND EXISTS (SELECT 1 FROM vertex_properties rp10
               WHERE rp10.node = rn.id AND rp10.key = 'name' AND rp10.value = 'marko8'))
```

**Without stats** the outer loop is the projection's property table — it walks all 20 000 `name` rows,
does an edge lookup for each, and only then asks whether the vertex was `marko8` (the selective filter,
applied LAST). **With stats** it inverts: `nodes` by rowid, then `e_out(src,label)`, then
`vp_node_key(node,key)`.

The indexes were never missing — `e_out(src,label,tgt)`, `e_in(tgt,label,src)`,
`vp_key_value(key,value)`, `vp_node_key(node,key)` all exist (`src/storage.ts:89-99`). What is missing
is any reason for SQLite to believe one of them is selective.

**The defect is the join ORDER, not which indexes are reachable.** That distinction decides the whole
fix and is easy to get backwards, so §3·2 establishes it by measurement before proposing anything.

## 3. Two fixes, and they are not alternatives

### 3·1 Give the planner stats — available on the platform, but not boundable there

**`ANALYZE` alone is the wrong tool for a live DO — it is a full scan of every index.** The bounded
form:

```sql
PRAGMA analysis_limit=400;   -- bound each index sample; near-constant cost, approximate stats
PRAGMA optimize;             -- run ANALYZE only where stats are missing or stale
```

`sqlite_stat1` is an ordinary table, so it persists in DO storage across hibernations: the cost is paid
once, every later request in the object's lifetime benefits.

**What a Durable Object permits, measured** (`test/cf-probe/`, a throwaway `wrangler dev` worker on
real workerd — the only authority, since `src/cf-limits.ts` models limits we already know about and
cannot see a platform *authorizer*):

| statement | outcome on DO SQLite |
|---|---|
| `PRAGMA analysis_limit=400` | **refused** — `not authorized: SQLITE_AUTH` |
| `PRAGMA analysis_limit` (read) | **refused** — same |
| `PRAGMA optimize` | accepted; populates `sqlite_stat1` |
| `PRAGMA optimize(0x10002)` | accepted |
| `ANALYZE` / `ANALYZE <table>` | accepted |
| `SELECT … FROM sqlite_stat1` | accepted; appears in `PRAGMA table_list` |

So stats **can** be gathered in production and **cannot** be bounded there — not a detail: the 0.5 ms
above is what `analysis_limit=400` buys, and without it `PRAGMA optimize` is a full `ANALYZE` of every
index with stale stats, cost proportional to the graph, on the DO's serial request budget. The refusal
is the platform's authorizer (the same one that refuses `PRAGMA writable_schema`), **not a dialect gap
a runtime bump would close.** **Consequence: §3·2 is the load-bearing half, not the complement.**

**When to run it:**

- **After a bulk load / `io().read()`** — the one moment cardinalities change wholesale, and where a
  graph goes from "no stats" to "wrong plan forever". Also the one moment an unbounded `ANALYZE` is
  affordable, because the load already dominates.
- **On the DO alarm**, or after N writes — threshold set against an UNBOUNDED cost, stricter than the
  0.5 ms number suggests.
- **Never per request.**

### 3·2 Stop depending on the guess

We generate this SQL. The traversal fixes the order its steps run in; the emitted SQL throws that away
and asks SQLite to re-derive it from cardinality guesses. Those guesses are wrong in the worst
direction on a graph with no `sqlite_stat1`, and the post-`optimize` plan shows they are not reliably
right even with stats (it still `SCAN`s `vertex_labels`).

**Four ways of stating the intent were measured. Three do nothing.** N = 4 000, no stats, 1 492 ms
baseline:

| form | ms/op | reaches `vp_key_value(key=?, value=?)` |
|---|---|---|
| correlated `EXISTS` in the `WHERE` (today) | 1 492 | no |
| `IN (SELECT node FROM vertex_properties WHERE key=? AND value=?)` | 1 493 | **yes** |
| property seek as leading table of a plain inner join | 1 488 | **yes** |
| `WITH seek AS MATERIALIZED (…)` as source CTE | 1 478 | **yes** |
| **`CROSS JOIN … ON …`** | **0.3** | **yes** |

Three make the selective index *reachable* and change nothing, because reachability was never the
problem: **SQLite reorders the terms of a `FROM` freely regardless of textual order**, and put the same
table in the outer loop every time. Even a `MATERIALIZED` CTE — an optimization fence for the
*subquery* — does not pin where its result lands in the join order.

**`CROSS JOIN` is SQLite's documented order fence and the only one that works here.** In SQLite it is
not a cartesian product: `A CROSS JOIN B ON p` means exactly `A INNER JOIN B ON p` with the tables left
of the keyword kept in the outer loop. Same rows (verified), and the parser accepts the `ON`.

So the fix is two statements of what the traversal already says, both known at compile time, neither a
guess:

- **A hop is "for each traverser I have, find its edges".** The incoming frontier is the join's LEFT
  side, `edges` is probed. Today it is reversed — `edges` on the left, free to reorder — copied from
  the legacy spine on the reasoning that it kept "the access path the covering indexes were built for".
  **Measured, that is backwards:** with the order free SQLite picks `e_in` and scans the whole edge
  table to hop off one vertex; pinned, it seeks `e_out(src,label)`. Which index the planner reaches for
  was the question, never whether the covering indexes exist.
- **A `values()`/`properties()` join is a probe, not a scan.** Same fence, so the stream drives
  `vp_node_key(node,key)` instead of the planner leading with `vp_key_value(key=?)` — every `name` row
  in the graph — and rediscovering the traverser afterwards.

**A `has(key, value)` at the source is a SEEK, which today can only be checked.** A bare `V()` is the
whole table and the `has` is usually the only selective thing said about it, but as an `EXISTS` in the
`WHERE` there is no way to *drive from* it. Making it a relation — seek `vp_key_value(key, value)`, take
the owners, probe the element scan by rowid — starts the traversal at one vertex instead of 4 000. Two
properties make that safe rather than clever:

- **`DISTINCT` is load-bearing.** A `Cardinality.list` key may hold the same value twice on one element,
  and a traverser must not be duplicated by the way we chose to *find* it.
- **It narrows and never decides.** The `has` stays in the fold as an ordinary clause, so the seek can
  only change which rows SQLite visits, never which rows survive. An access-path change structurally
  incapable of changing a result is a different risk class from one merely believed correct.

Measured, cumulative, N = 4 000, no stats:

| | no stats | with stats |
|---|---|---|
| today | 1 492 ms | 6.6 ms |
| + order fence | 6.2 ms | 6.6 ms |
| + source seek | **0.3 ms** | 0.5 ms |

The second row is the point; the third is a bonus: **after the fence the plan is the same with and
without `sqlite_stat1`.** That is "plan-stable by construction", worth more than the ms — it makes a
young graph (every graph on its first requests) behave like a warm one.

**The cost, stated honestly.** Pinning the order gives up the cases where the planner's reordering would
have been better:

- `g.V().out('knows').has('name','marko8')` — the counter-shape, selective filter at the END, pipeline
  order looks wrong: **9.0 ms free, 4.9 ms fenced**. The fence still wins.
- `g.V().values('name')` — unfiltered whole-graph projection: **1.4 ms free, 2.1 ms fenced**, a ~1.5×
  loss, because the free plan reads `vp_key_value(key=?)` directly and skips `nodes` entirely.

That second is a real regression and the trade is deliberate: a bounded constant factor on unfiltered
projections against a superlinear cliff on filtered lookups. It also points at the next piece — `nodes`
contributes nothing to `g.V().values('name')` but an existence check the FK already guarantees, so
eliminating that join recovers it and is a separate, larger win.

### 3·3 Where each half belongs in the code

The two halves are different KINDS of change and must not share a home.

- **The order fence is a property of the join**, not a rewrite: `Join` gains `ordered`, meaning "the
  left side is the outer loop", set by the lowering because which side is the traverser stream is what
  the lowering knows. It is the one place the algebra states a fact about execution rather than rows.
  **Only an `inner` join may carry it** (a `left` join's order is fixed by its semantics, a `cross`
  join has no `ON` to reorder around) and both the factory and `check.ts` refuse otherwise. Nothing
  about it is optional or disable-able, because it changes no rows.
- **The source seek is a physical REWRITE and belongs in `src/rel/passes/`** — a sibling to `fuse`, not
  a case inside it: `fuse` is declared for *semantic* collapses across adjacent nodes; this is the
  opposite, same algebra stated physically (Calcite's logical/physical split, `vendor/calcite` at the
  pin).

  **Recognise it on the ALGEBRA** (`Filter(Scan nodes, … EXISTS(props key=k, value=v) …)`) **rather than
  on the step chain** — that keeps it from drifting. A step-chain recogniser needs its own list of which
  step names are source-position filters, a second copy of what `sourceFilter` accepts: add a filter
  step and forget the list and the seek silently stops firing; add a non-filter to it and the answer is
  wrong. The algebra shape has no such list.

  It is gated by a `FastPath` switch, `propertySeek` — not because it is a fast path in the dispatch
  sense (it has no `tryLower`, so it is declared in `GATE_ONLY_FAST_PATHS` beside `repeatBodyExpansion`)
  but because that is what puts it under **L5's differential**. **The switch is read at the call site,
  not inside the pass**, so the pass stays a total function of its input and a configuration cannot
  change coverage. `FAST_PATH_NAMES` derives from `DEFAULT_FAST_PATHS`, so the flag enters the
  per-switch sweep by existing. What the sweep watches is the `DISTINCT` — a `Cardinality.list` key
  holding one value twice would multiply a traverser through the seek and not through the filter — and,
  as telemetry, the emission-order changes of §4·1.

  **It is the first switch that selects a physical ACCESS PATH**, normally the mark of something RelIR
  declines rather than implements (the FTS contrast in `compileViaRel`). The difference: this changes no
  algebra at all — the predicate it lifts stays exactly where it was, so both positions decide the
  surviving rows with one expression and there is no second semantics to keep in step.

A generated-SQL engine that needs the planner to guess correctly has given away the advantage of
generating SQL.

## 4. Why nothing caught it

`accessPaths` already exists (`test/support/sql-core.ts:69`) and already reduces `EXPLAIN QUERY PLAN` to
the index decisions, dropping alias and CTE-materialization noise; `test/rel-l2-equivalence.test.ts`
uses it to prove the two spines pick the same paths.

**The assertion machinery is there; the fixture size that would make it meaningful is not.** On the
6-vertex modern graph the bad plan and the good plan both take 0.6 ms, and `accessPaths` will happily
record `SEARCH vp_key_value (key=?)` as the expected answer — because at that size it *is* fine.
Equivalence between two spines is orthogonal to whether either one is any good.

The gate this wants is the existing mechanism pointed at a graph big enough to have an opinion:

- a fixture of a few thousand vertices (bulk-loaded, so milliseconds to build);
- `accessPaths` assertions on a handful of canonical shapes — point lookup, 1-hop, label scan, ordered
  page — asserting the *seek* is present and no full `SCAN` of a property or label table is;
- **run with and without stats, and assert the two agree.** Plan STABILITY is the property, stronger and
  cheaper than any single plan: no table of blessed access paths to go stale, and it fails on exactly
  the defect this document is about — a plan only correct after `ANALYZE` is a plan wrong on every young
  graph, and per §3·1 `ANALYZE` is the expensive unbounded form on the runtime we ship to.

**Note for whoever writes it:** the existing L2 SQL assertions spell the *current* join order (`FROM
edges … INNER JOIN r0 …`, two today). Those are semantic-equivalence snapshots, not byte-identity ones
(`test/CLAUDE.md`), so they update with the change — and they are the reason to land the fence before
more arms are written against the unfenced shape, not after.

### 4·1 What pinning the order costs the instruments

Two gates move, and each first presents as a regression.

**`scripts/sql-hygiene.ts` — 53 traversals change emission order.** The gate compared RelIR ≡ legacy
framed answers ORDER-SENSITIVELY; pinning the join order changes which rows come back first on 53 corpus
traversals. Measured, and the measurement is the whole argument:

- every one is **multiset-identical** — same traversers, different sequence;
- **both** spines' orders are stable under `MOGWAI_REVERSE_UNORDERED=1`, so neither was passing by luck
  and this is not the class `test:perturbed` exists for;
- none of the 53 calls `order()`, so neither order is the specified one. Traversers are a multiset.

So the gate was asserting a fact with no standing; the fix gives it the standing the census already
gives the identical fact: **which rows gates, what order is telemetry**. `comparable` returns both
renderings, the multiset comparison fails the build, and the order difference is counted and printed as
`N spine emission-order difference(s) — telemetry, never gates` — deliberately the census's sentence,
because it is the same claim. An order the language DOES specify is an `ORDER BY` in the emitted SQL and
survives any plan change; if it ever diverged, the rows would diverge with it and the multiset gate
catches that.

**The per-family `bytes` ratchet rises**, because the seek adds a driving subquery: `has` 1 571 →
2 418, `values` 2 075 → 2 632, five others ~+155 each. **`binds` and `bound` do NOT move** — the
signature that matters: the seek's key and value inline as typed literals and spend none of the
100-parameter budget. Re-bank with `mise run sql-hygiene-record`; the reason belongs in the commit
message.

## 5. Scope: RelIR only

The fix lands on the RelIR spine and the legacy spine is left alone. Legacy is a route with an end date
(build plan §6·1), so the value of a plan fix there is bounded by how long it survives, and every change
to it is a change to code scheduled for deletion. The census remains spine-differential either way, so a
divergence between the two positions is visible rather than silent.

## 6. Priority against the other levers

Edge-side compile (`docs/2026-08-07-edge-compilation-plan.md`) is a throughput lever, but clearly third:

| lever | magnitude |
|---|---|
| plan stability (this doc) | ~9 800 ms → ~19 ms on a mid-size graph |
| edge-side compile | ~4 ms fixed, moved off the DO's serial budget |
| ANTLR cold start | ~45 ms, once per isolate |

The first is a correctness-shaped problem wearing performance clothing: a 9.8-second traversal does not
return slowly, it exceeds the request budget and fails. Nothing in the other two is worth tuning while
this is outstanding.

## 7. Method

Synthetic graph: N `person` vertices (`name`, `age`), N `software` vertices (`name`, `lang`), 4 `knows`
edges and 1 `created` edge per person, landed via `loadBulk` into `new GraphStore(new
BunSqlite(':memory:'))`. Queries run through `test/support/executor.ts`'s `exec(store).framed(...)`,
warmed then timed over 3–40 iterations depending on cost. Plans read with `EXPLAIN QUERY PLAN` over the
compiled `Compiled.sql` / `Compiled.binds`. `PRAGMA optimize` timed separately from the queries it
affects.

§3·2's form comparison uses the same graph generated directly in SQL rather than through `loadBulk`, so
the identical rows can be replayed on both runtimes; at N = 4 000 that is 8 000 vertices and 20 000
edges, which is why its baseline (1 492 ms) is not the 364 ms of §1's "4 000" row. Ratios, not
absolutes, carry between the two.

Benchmark scripts were throwaway and are not in the tree; everything above reproduces from this section
plus `src/storage.ts`'s schema.

Numbers are `bun:sqlite` 3.53.0. DO SQLite is 3.47.0. §3·1's permission table was measured on real
workerd through `test/cf-probe/` (`wrangler dev`, a Durable Object executing each statement and
reporting per statement); no TIMING here has been reproduced on workerd, and the platform-side cost of
an unbounded `PRAGMA optimize` is the one number §3·1 still wants.
