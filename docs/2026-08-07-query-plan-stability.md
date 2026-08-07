# Query-plan stability — the 516× we are leaving on the floor

> **STATUS: FINDING + PLAN. Nothing has landed.** Measured 2026-08-07 on trunk at `41c897d`,
> `bun:sqlite` 3.53.0, in-memory, synthetic graphs. One number needs verifying on workerd before the
> first fix can be designed (§5). Method at the bottom (§7).

A single-vertex lookup plus one hop — the most common shape in the language —
takes **9.8 seconds** on a 20 000-vertex graph. After 0.5 ms of `PRAGMA optimize` it takes
**19 ms**. Nothing in the suite sees this, because every fixture is small enough that the wrong plan
is free.

This was found while measuring something else (`docs/2026-08-07-graphql-front-end-plan.md`'s
placement question). It is much bigger than what it was found under.

---

## 1. The measurement

`g.V().has('person','name','marko8').out('knows').values('name')`, warm, ms/op:

| vertices | no stats | after `PRAGMA optimize` | speedup |
|---|---|---|---|
| 6 (modern) | 0.6 | 0.6 | 1.0× |
| 4 000 | 364 | 3.5 | **105×** |
| 20 000 | **9 842** | **19** | **516×** |

The long chain behaves identically (9 937 → 21 ms, 463×). Two other shapes are untouched
(`group` 19.2 → 18.5, `valueMap` page 11.0 → 11.0, both 1.0×) — so this is a plan decision on
specific shapes, not a warm-cache artefact.

Scaling of the bad plan is **superlinear**: 5× the data, 27× the time. The good plan is roughly
linear (3.5 → 19 ms). So the gap widens with graph size, and the DO's request budget is a hard wall
somewhere before 20 000 vertices.

`PRAGMA analysis_limit=400; PRAGMA optimize;` cost **0.5 ms** on the 20 000-vertex graph.

## 2. What the planner actually does

The compiled SQL for that traversal (elided for width — full text reproducible via §7):

```sql
SELECT … FROM edges rme16
  INNER JOIN nodes rn ON ((rme16.src = rn.id) AND rme16.label IN (SELECT … FROM labels …))
  INNER JOIN vertex_properties rp24 ON ((rp24.node = rme16.tgt) AND rp24.key IN ('name'))
WHERE (rn.id IN (SELECT rvl6.node FROM vertex_labels rvl6 WHERE rvl6.label IN (…'person'…))
   AND EXISTS (SELECT 1 FROM vertex_properties rp10
               WHERE rp10.node = rn.id AND rp10.key = 'name' AND rp10.value = 'marko8'))
```

**Without stats** the outer loop is the projection's property table:

```
SEARCH rp24 USING INDEX vp_key_value (key=?)          ← every 'name' property in the graph
SEARCH rme16 USING COVERING INDEX e_in (tgt=? AND label=? AND src=?)
…
SEARCH rp10 EXISTS USING INDEX vp_node_key (node=? AND key=?)   ← the selective filter, applied LAST
```

It walks all 20 000 `name` rows, does an edge lookup for each, and only then asks whether the vertex
was `marko8`.

**With stats** it inverts:

```
SEARCH rn USING INTEGER PRIMARY KEY (rowid=?)
SEARCH rme16 USING COVERING INDEX e_out (src=? AND label=?)
SEARCH rp24 USING INDEX vp_node_key (node=? AND key=?)
SCAN rvl6                                              ← still a scan
```

The indexes were never missing. `e_out(src,label,tgt)`, `e_in(tgt,label,src)`,
`vp_key_value(key,value)` and `vp_node_key(node,key)` all exist (`src/storage.ts:89-99`). What is
missing is any reason for SQLite to believe one of them is selective.

## 3. Two fixes, and they are not alternatives

### 3·1 Give the planner stats

`ANALYZE` and nothing else is the wrong tool for a live DO — it is a full scan of every index.

```sql
PRAGMA analysis_limit=400;   -- bound each index sample; near-constant cost, approximate stats
PRAGMA optimize;             -- run ANALYZE only where stats are missing or stale
```

`sqlite_stat1` is an ordinary table, so it persists in DO storage: the cost is paid once and every
later request in that object's lifetime benefits, across hibernations.

**When to run it:**

- **After a bulk load / `io().read()`** — the one moment cardinalities change wholesale, and exactly
  where a graph goes from "no stats" to "wrong plan forever". Non-negotiable.
- **On the DO alarm**, or after N writes since the last run. Cheap enough (0.5 ms at 20 000 vertices)
  that the threshold can be generous.
- **Never per request.**

### 3·2 Stop depending on the guess

We generate this SQL. A `has(label, key, value)` is a *seek* and we know it at compile time, but we
emit the value predicate as a correlated `EXISTS` in the `WHERE`, which is the one form the planner
cannot use to seed a join order. Emitting it as a driving join on `vp_key_value(key, value)` states
the intent instead of hoping it is inferred.

Post-`optimize` numbers show why this is not redundant: 19 ms is not the floor. The plan still never
seeks `vp_key_value(key=?, value=?)`, and it still `SCAN`s `vertex_labels` for the label membership.
Stats fixed the join *order*; they did not make the most selective index reachable.

The split of responsibility is clean, and both halves are wanted:

- **§3·1 covers the shapes we did not hand-shape** — a general safety net, one PRAGMA, no compiler
  change.
- **§3·2 makes the shapes we care about plan-stable by construction** — no dependence on whether
  stats happen to be fresh, which matters most on a *young* graph, i.e. every graph on its first
  requests.

A generated-SQL engine that needs the planner to guess correctly has given away the advantage of
generating SQL.

## 4. Why nothing caught it

`accessPaths` already exists (`test/support/sql-core.ts:69`) and already does the right thing —
it reduces `EXPLAIN QUERY PLAN` to the index decisions, dropping aliases and CTE-materialization
noise. It is used by `test/rel-l2-equivalence.test.ts` to prove the two spines pick the same paths.

**The assertion machinery is there; the fixture size that would make it meaningful is not.** On the
6-vertex modern graph the bad plan and the good plan both take 0.6 ms, and `accessPaths` will happily
record `SEARCH vp_key_value (key=?)` as the expected answer — because at that size it *is* a fine
answer. Equivalence between two spines is orthogonal to whether either one is any good.

So the gate this wants is not a new mechanism, it is the existing one pointed at a graph big enough
to have an opinion:

- a fixture of a few thousand vertices (bulk-loaded, so it costs milliseconds to build);
- `accessPaths` assertions on a handful of canonical shapes — point lookup, 1-hop, label scan,
  ordered page — asserting the *seek* is present and no full `SCAN` of a property or label table is;
- run with and without stats, because §3·2's whole claim is that the good plan should not require
  them.

That last point is what makes it a real gate rather than a snapshot: a plan that is only correct
after `ANALYZE` is a plan that is wrong on every young graph.

## 5. The blocking unknown

**Does `ctx.storage.sql.exec` permit `PRAGMA` and `ANALYZE` at all?** The Durable Objects SQL API
docs list exactly one statement restriction — no `BEGIN TRANSACTION` / `SAVEPOINT` — and say nothing
about PRAGMAs, `ANALYZE`, or `sqlite_*` table creation. Undocumented is not the same as permitted:
workerd owns the connection and reserves its own namespace.

This is empirically checkable and must be checked before §3·1 is designed, not after: `wrangler dev`
runs the real workerd, so a DO method that executes the two PRAGMAs and then reads `sqlite_stat1`
settles it in one run. Note that `mise run test:cf-limits` cannot answer this — `src/cf-limits.ts`
is a Bun-side decorator that models DO limits we already know about; it is not workerd.

**If PRAGMAs are refused**, §3·2 is not the complement to §3·1 — it is the whole fix, and its
priority changes accordingly.

## 6. Priority against the other levers

This was found while benchmarking compile time, on the theory that moving compilation to the edge is
a throughput lever. It is one — `docs/2026-08-07-edge-compilation-plan.md` — but it is clearly third:

| lever | magnitude |
|---|---|
| plan stability (this doc) | ~9 800 ms → ~19 ms on a mid-size graph |
| edge-side compile | ~4 ms fixed, moved off the DO's serial budget |
| ANTLR cold start | ~45 ms, once per isolate |

The first is a correctness-shaped problem wearing performance clothing: a 9.8-second traversal does
not return slowly, it exceeds the request budget and fails. Nothing in the other two is worth tuning
while this is outstanding.

## 7. Method

Synthetic graph: N `person` vertices (`name`, `age`), N `software` vertices (`name`, `lang`), 4
`knows` edges and 1 `created` edge per person, landed via `loadBulk` into
`new GraphStore(new BunSqlite(':memory:'))`. Queries run through `test/support/executor.ts`'s
`exec(store).framed(...)`, warmed then timed over 3–40 iterations depending on cost. Plans read with
`EXPLAIN QUERY PLAN` over the compiled `Compiled.sql` / `Compiled.binds`. `PRAGMA optimize` timed
separately from the queries it affects. Benchmark scripts were throwaway and are not in the tree;
everything above reproduces from the description in this section plus `src/storage.ts`'s schema.

Numbers are `bun:sqlite` 3.53.0. DO SQLite is 3.47.0 — `analysis_limit` has existed since 3.32, so
the mechanism is present there, but no number in this document has been reproduced on workerd (§5).
