# Traverser bulking — design investigation

*2026-07-14. Research + design scoping for the biggest remaining structural gap.
Sources: TinkerPop 4 source (`gremlin-core`), the Sqlg codebase, TinkerPop upgrade
docs + mailing list, and a full sweep of this repo's traverser representation.*

**STATUS: count-bulking SHIPPED (`src/steps/bulk.ts`).** `repeat(...).times(n).count()`
(path/sack-free, simple out/in/both body) compiles to unrolled GROUP-BY-SUM(bulk)
CTEs. The grateful graph is now seeded (`test/conformance/conformance-server.ts`);
`times(8).count()` returns 2505037961767380 in ~10ms (was an uninterruptible hang).
The same engine accepts a cardinality-only post-repeat suffix of `as()` + movement +
bare `select(labels).count()`: labels and record construction are erased because their
value is discarded, while each movement adds another grouped bulk frontier. This keeps
the official `times(5).as(a).out('writtenBy').as(b).select(a,b).count()` result
(24,309,134,024) bounded instead of materializing billions of record rows.
L3 824 (was 822: +times(3).count + times(8).count, matching TinkerPop's exact
`d[14465066]`/`d[2505037961767380]`). No fail-fast guard was needed — every other
grateful scenario either works or fails closed at compile (verified by running all 39
grateful queries in isolation: zero hangs). Deferred (own follow-ups, NOT built):
`groupCount`/`group().by(count)` bulking (times(2) group already materializes fine, so
not a tractability blocker — its non-pass is a group-value/empty-key semantics gap),
`sum`/labels whose identity remains live past the reducer, and unbounded
`until()`/`emit()` bulking (no compile-time depth → would need a JS depth-loop).

## The problem in one line

mogwai materializes **every traverser as a separate SQL row** (UNION ALL). TinkerPop
**bulks** equal traversers into one `(value, count)` pair. On a dense graph an
unbounded `repeat(out()).times(N).count()` has astronomically many walks
(grateful-dead `times(8)` ≈ 2.5e15) — TinkerPop answers it with one arithmetic
reduction over a bounded frontier; mogwai would try to build 2.5e15 physical rows
and hang the host. That is why `ggrateful` is deliberately not seeded
(`test/conformance/conformance-server.ts:36-43`).

## What bulking is (TinkerPop semantics)

A **bulk** is a per-traverser multiplicity — a `long` on `Traverser`
(`Traverser.bulk()`: *"the number of traversers represented in this traverser"*).
Two traversers are **mergeable** when they compare equal, and merge sums their
bulks (`Traverser.Admin.merge`: *"instead of enumerating all traversers, they can
be counted"*). The merge happens in `TraverserSet` — a
`LinkedHashMap<Traverser,Traverser>` keyed on traverser equality; `add()` either
inserts or calls `existing.merge(incoming)`.

Equality — hence mergeability — depends on which concrete traverser class the
`TraverserGenerator` picked, which is driven by `TraverserRequirement` bits:

- `B_O_Traverser` (bulk + object + step location): `equals` = object + current-step.
  Merges freely. `merge` = `this.bulk += other.bulk()`.
- `B_LP_O_P_S_SE_SL_Traverser` (adds a `Path`): `equals` also compares `path`. **Two
  traversers that reached the same vertex via different walks are no longer equal**,
  so they never merge — they enumerate one row per walk. **This is what "path kills
  bulking" means, mechanically.**
- Sack: sack participates in merge **only if `withSack` was given a merge
  `BiFunction`**. Without one, sack isn't in equality — convergent paths silently
  keep one sack value (a correctness trap, not just perf).

Propagation through steps (confirmed from source):

| Step | Effect on bulk |
|---|---|
| `count()` (`CountGlobalStep`) | reduces `SUM(bulk)` — never counts objects |
| `groupCount()`, `group().by(count)` | increments key by `traverser.bulk()` |
| `sum()` | bulk-weighted |
| `out()`/`in()`/`both()` | fan out, children inherit parent bulk (multiply) |
| `dedup()` (`DedupGlobalStep`) | **`setBulk(1)`** — collapse, reset, NOT sum |
| filters (`where`/`is`/`has`) | pass bulk through unchanged |

`Traverser.split()` is the multiplicative counterpart to merge: one traverser
becomes N children at fan-out / branch / emit points.

## Why `repeat().count()` stays tractable

`LazyBarrierStrategy` inserts a `NoOpBarrierStep(2500)` after every `out`/`in`/`both`
(and large `GraphStep`). Each barrier drains its input through a `TraverserSet`, so
after every hop all traversers that landed on the **same vertex** collapse to one
row with a summed bulk. The frontier after hop *i* is therefore bounded by `|V|`,
not by the number of walks. The astronomical number is carried as the *value* of
`bulk` in ≤ `|V|` rows; `count()` is one `SUM(bulk)` over that frontier.

Crucially, `LazyBarrierStrategy.apply` **bails out entirely** when the traversal
requires `PATH`, or contains `DropStep`/`ElementStep`, or runs on GraphComputer:

```java
if (onGraphComputer(traversal) ||
    traversal.getTraverserRequirements().contains(TraverserRequirement.PATH) ||
    hasStepOfAssignableClass(DropStep.class, traversal) ||
    hasStepOfAssignableClass(ElementStep.class, traversal))
    return;
```

So path-tracking turns bulking off **globally**, not just where the path is read.
Our compiler needs the same static guard.

## Prior art

- **TinkerPop is the reference.** Port its semantic map: bulk column, sum-on-merge,
  reset-on-dedup, weight-in-reducers, disable-under-path.
- **The SQL trick is standard**, not novel — reachability counting via a
  multiplicity column folded into the recursive term's `GROUP BY`/`SUM`:

  ```sql
  WITH RECURSIVE walk(id, depth, bulk) AS (
    SELECT id, 0, 1 FROM <seed>
    UNION ALL
    SELECT e.tgt, w.depth + 1, SUM(w.bulk)
    FROM walk w JOIN edges e ON e.src = w.id
    WHERE w.depth < :times
    GROUP BY e.tgt, w.depth + 1        -- the TraverserSet-merge analog
  )
  SELECT SUM(bulk) FROM walk WHERE depth = :times;   -- count() = SUM(bulk)
  ```
  Frontier bounded by |V| per depth; the 2.5e15 stays a correctly-computed BIGINT.

- **Sqlg is *negative* prior art.** Its `SchemaTableTree.constructRecursive*Query`
  compiles every repeat to a recursive CTE that unconditionally carries a full
  `path` ARRAY + `is_cycle` guard, one row per walk, no bulk column. Same
  exponential exposure. **Do not copy Sqlg's repeat shape for count-only queries.**

- **BulkSet wire type is a dead end — ignore it.** GraphBinaryV4/GraphSONV4 *removed*
  BulkSet as a serialized type, folding it into a `List` bulk-flag (`0x02`, RLE
  `{item}{bulk}` pairs), and **remote clients always expand it back to a flat List on
  deserialize**. The pinned `gremlin@4.0.0-beta.2` client has zero bulk support
  (predates GraphBinaryV4 — grep for `bulk` in `node_modules/gremlin` is empty). So
  mogwai's current unrolling of `aggregate().cap()` to individual rows is **correct
  permanently**, not a gap. **Bulking's entire payoff is internal (the SQL compiler);
  there is no wire feature to chase.**

## What this unblocks

**Direct: ~35–39 conformance scenarios** on the grateful graph, across 12 feature
files (Repeat 8, Match 8, Range 6, Count 3, Group 3, Order 2, Recommendation 2,
Sample 2, SideEffectCap 2, ShortestPath/Vertex/Paths 1 each). Seeding infra is
already built (`seed-graphson.ts` `graphsonSeed()`); grateful is merely excluded
from `SEEDS`. Net is slightly under 39 — some grateful scenarios are also blocked on
Match patterns / Sample (`@StepSample` excluded anyway) / ShortestPath.

**Bigger than the count: it is a correctness fix, graph-wide.** `count()` today is
`COUNT(*)` over materialized walk rows (`src/steps/projection.ts:385-392`). On *any*
dense cyclic graph — not only grateful — a reducer after a nontrivial `repeat()`
either times out or can't be built. `sum()`/`groupCount()` the same. Bulking makes
reducers-after-big-repeat correct **and** tractable everywhere.

## Why it compounds (not a one-off)

- **Plumbing already exists.** A `bulk BIGINT` carried column follows the exact
  `sack`/`origin` pattern: a field on `Carry` (`src/steps/context.ts:62-72`), added
  to `carriedCols` (`:101`), spliced by `carryFrag` (`:107`), seeded in `seedSource`
  (`src/steps/index.ts:87-114`), tri-stated in `advance` (`:118-140`). The immutable-
  fold rails carry it for free.
- **One semantic, inherited everywhere.** Teach movement-collapse (`SUM(bulk)`),
  dedup (`bulk=1`), and the reducers (weight by bulk) once; everything built on them
  inherits it.
- **repeat() fixpoint mechanics** *are* bulking — collapse identical `(id,depth)`
  frontier rows per iteration.
- **Adjacent unlocks** ride the same substrate: `aggregate`/`cap` weighting, and the
  currently fail-closed `within('x')`/`without('x')` eager-readback.

**Where it does not compound: path.** Path is part of traverser identity, so it
forces `bulk=1` and forbids the collapse — mutually exclusive with
`path`/`simplePath`/`cyclicPath`/`tree`. The compiler already detects this
(`chainTracksPath`, `src/steps/index.ts:78`); bulking must disable itself there,
mirroring `LazyBarrierStrategy`'s guard.

## Sharp edges (the real engineering)

1. **Aggregate-in-recursive-term restriction.** SQLite (like most engines) won't
   allow `SUM`/`GROUP BY` directly inside the recursive branch in the naive form.
   The real shape materializes each depth's frontier fully-merged before feeding the
   next — a per-iteration aggregation, not the one-liner above. **This is the actual
   work**, and needs a spike against both `bun:sqlite` and DO SQLite to confirm the
   viable CTE shape.
2. **UNION-collapse ≠ SUM-collapse.** UNION = distinct reachable nodes (dedup
   semantics, bulk→1). SUM-in-GROUP-BY = walk count (the 2.5e15 answer). Different
   semantics; pick per query.
3. **dedup resets to 1**, does not sum. Getting this wrong makes `count()` silently
   report the opposite of what was asked.
4. **order/range/limit/sample need individual traversers** (TinkerPop's `ONE_BULK`).
   A `LIMIT`/`ORDER BY`/sample downstream of a bulked frontier is undefined per-walk;
   must force an unbulk there — which reintroduces the blowup for exactly those
   cases. Same trade-off TinkerPop accepts (bulking gives up strict ordering).
5. **Overflow.** 2.5e15 fits SQLite INTEGER (max ≈ 9.2e18), but `b=20, n=15` ≈ 3.3e19
   overflows. Need an explicit clamp/reject policy, not silent wraparound.
6. **Applicability gate.** Fire bulking **only** when the chain is reducer-terminal
   and has no path/dedup/order/sack requirement upstream of the reducer — a static
   pass mirroring `LazyBarrierStrategy`'s own applicability check, not a runtime
   decision. A bare `repeat().times(8)` with no reducer has no shortcut (must
   enumerate); bulking only saves reducer-terminated chains.

## SQL spike results (2026-07-14, bun:sqlite 3.53)

Ran the candidate CTE shapes against a synthetic dense cyclic graph. Findings that
settle the design:

- **Unrolled per-depth GROUP-BY CTEs are correct and instant.** A `times(n)` walk
  unrolls to `f0 … fn`, each `SELECT e.tgt, SUM(f{d-1}.bulk) … GROUP BY e.tgt`. The
  bulked count matches the naive UNION-ALL walk count exactly, and `times=10` on a
  branching-12 graph (≈6.2e10 walks) computes in **1.1 ms**. The frontier is bounded
  by reachable |V|, not the walk count.
- **Recursive-term GROUP BY is REJECTED by SQLite:** `WITH RECURSIVE … GROUP BY …` in
  the recursive select errors **`recursive aggregate queries not supported`** the
  moment the CTE is materialized (a bare `SELECT 1` that never reads it falsely
  parses). This is core SQLite — the recursive engine is row-at-a-time and cannot
  collapse a generation — so it is identical on DO 3.47 and Bun 3.53. **Recursive
  bulking is impossible in SQLite.** Unroll is therefore not "the safer syntax," it
  is the *only* shape that collapses the frontier.
- **Overflow fails loud.** `SUM(bulk)` past i64 (`times=22`, 8^22 ≈ 7e19) raises
  SQLite's native `integer overflow` error — no silent wraparound. Grateful's answers
  (≤ 2.5e15) fit i64 comfortably; TinkerPop's own `long` bulk would overflow at the
  same point, so erroring is the honest behaviour.
- **Consequence for scope:** `times(n)` (all grateful blockers) → unroll, one plain
  non-recursive statement, works on both runtimes. Unbounded `until()`/`emit()`
  bulking is not expressible as one SQLite statement (would need a JS depth-loop) and
  stays deferred — a separate follow-up, not foreclosed by this choice.

Delivered in two steps: **D1** — seed the grateful graph + a fail-fast guard so a
not-yet-bulkable big repeat-count throws a clear error instead of materializing
(CI-safe, harvests the grateful scenarios that only needed the graph present). **D2**
— the unroll bulking engine (replaces D1's throw for the `times(n)`-reducer case).

## Verdict

Biggest single structural gap, and it earns the label — a compounding substrate
(graph-wide reducer correctness + the grateful reference graph + adjacent aggregate
work), not a grateful-only patch. Well-precedented: port TinkerPop's semantic map
into a `bulk` carried column and a GROUP-BY-SUM recursive CTE, gated by a
path/order/dedup/sack-free static check. The concept is settled; the real work is
(a) the per-iteration recursive-CTE aggregation shape that SQLite will actually run,
and (b) the applicability gate + unbulk boundaries.

**Recommended next step:** a SQL spike — get `repeat(out()).count()` running as a
bulked recursive CTE on both runtimes with a small synthetic dense graph, before
touching the compiler. Confirm edge 1 (the CTE shape) is real, then wire the `bulk`
column through the `sack`/`origin` plumbing and build the gate.

## Cross-references

- `test/conformance/conformance-server.ts:36-43` — canonical statement of the gap.
- `test/conformance/seed-graphson.ts` — `graphsonSeed()`, ready; grateful withheld.
- `docs/feature-support-matrix.md` "Where this points" — ~35 scenarios estimate.
- `docs/2026-07-12-path-tracking-prior-art.md:169-176` — path↔bulking incompatibility.
- `src/steps/context.ts`, `src/steps/sack.ts` — the carried-column pattern to reuse.
- `src/steps/branch.ts` — the current `WITH RECURSIVE walk(id, depth)` repeat CTE.
