# Path tracking — prior-art scan before we build (2026-07-12)

Before committing to bet #1 (`path`/`simplePath`/`cyclicPath`/`tree`) from
`2026-07-12-conformance-structural-bets.md`, we checked for prior art: other
TinkerPop-on-relational implementations, the v4 semantic contract, our own
current plumbing, and the wider SQL-path literature. Four parallel deep dives.

**Headline: we were about to miss a trick.** The naive plan — thread a path
array column through *every* movement/filter StepFn — is the expensive path, and
the reference implementation of "Gremlin compiled to SQL" (Sqlg) deliberately
does **not** do that. It splits path into two regimes, and only the small
recursive-repeat regime touches SQL path accumulation. The linear-`path()` regime
reuses the *label-carry rails we already have*. That split is the main finding.

---

## The prior art that matters (and it's already on disk)

- **Sqlg** (`~/Projects/sqlg`, github.com/pietermartin/sqlg) — the closest living
  relative: TinkerPop Gremlin compiled to relational SQL (Postgres/HSQLDB/H2/
  MariaDB), same "optimize into SQL, don't interpret" thesis as us. Has a whole
  `recursive/` test package (Pieter Martin's native recursive-CTE repeat) and a
  `TestPathStep`. **This is the bullseye — someone already solved Gremlin-path-in-
  SQL and we have the source.**
- **JanusGraph** (`~/Projects/janusgraph`) — distributed, step-at-a-time over
  pluggable storage; interprets rather than compiles, so it's a semantics
  reference, not an architecture one. Not load-bearing for us here.
- **TinkerPop 4 reference** (`~/Projects/tinkerpop`) — but see the surprise in
  §2: v4 *deleted* the Java step engine. The Gherkin features are now the only
  authoritative contract.
- Wider field (web): DuckPGQ, DuckDB `USING KEY`, Apache AGE, SQL:2023/SQL-PGQ,
  IBM SQLGraph, Cytosm, GraphflowDB.

---

## 1. Sqlg's two-regime split — THE strategic finding

Sqlg does not have "a path implementation." `repeat()` forks at compile time
(`BaseStrategy.java:158-168`) and general `path()` is handled a third way:

| Gremlin shape | Sqlg strategy | Mechanism |
|---|---|---|
| `repeat(out()).times(n)` | **loop-unroll** (`handleRepeatStep`, `BaseStrategy.java:1081`) | `for i<n` appends another `VertexStep` → **n chained JOINs**, no CTE at all |
| `repeat(out()).until(<pred>)` | **`WITH RECURSIVE`** (`SchemaTableTree.constructRecursive*Query`) | native array-path CTE (below) |
| `g.V().out().out().path()`, `select`, `tree`, standalone `simplePath`/`cyclicPath` | **force-label + assemble in memory** (`precedesPathOrTreeStep`, `BaseStrategy.java:1657`) | SQL computes **no path**; every intermediate element is force-labelled into the SELECT so it's materialised, then *stock in-memory TinkerPop* `PathStep`/`TreeStep`/`SimplePathStep` runs over the hydrated rows |

The third row is the trick. For general linear `path()`, **Sqlg does not compute
the path in SQL at all.** It detects a downstream path/tree step, tags every
intermediate step with a fake label (`"P~~~" + "sqlgPathFakeLabel"`,
`BaseStrategy.java:1072-1075`) so Sqlg's normal "drop non-terminal columns"
optimisation is defeated and every element lands in the result set, then lets
vanilla TinkerPop assemble the Path object in JS-equivalent memory.

**Why this matters for us:** our own repo survey (below) found the invasive
option — thread a `path` column through `advance()` and every movement/filter/
branch CTE — collides with every "no carried history" refusal we have
(`repeat after as`, `dedup after as`, `union after as`). Sqlg says don't. The
linear path is *already materialisable* from the label-carry mechanism we built
for `as()`/`select()` (P2a column-threading) — a `path()` is just "remember every
step's element, not only the `as()`-tagged ones," reconstructed in `handler.ts`.
Only the recursive-repeat family needs true SQL path accumulation.

### Sqlg's recursive-repeat SQL (the part we *do* port)

`constructRecursiveOutQuery`, `SchemaTableTree.java:4823-4866` (Postgres):

```sql
WITH RECURSIVE search_tree("ID", out_fk, in_fk, depth, is_cycle, previous, path) AS (
  SELECT e."ID", e.out_fk, e.in_fk, 1, false,
         ARRAY[e.out_fk],                 -- path up to prior vertex
         ARRAY[e.out_fk, e.in_fk]         -- full vertex-id path
  FROM edge e JOIN start ON start.alias1 = e.out_fk
  UNION ALL
  SELECT e."ID", e.out_fk, e.in_fk, st.depth + 1,
         e.in_fk = ANY(path),             -- is_cycle: next vertex already in path?
         path,                            -- carry old path as "previous"
         path || e.in_fk                  -- APPEND next vertex id
  FROM edge e JOIN search_tree st ON st.in_fk = e.out_fk
              JOIN vertex v ON st.in_fk = v."ID"
  WHERE NOT is_cycle <optional until clause>
)
SELECT *, gen_random_uuid() FROM search_tree WHERE NOT is_cycle
-- then: LEFT JOIN UNNEST(path) WITH ORDINALITY to explode ordered elements,
--       WHERE path NOT IN (SELECT previous FROM ...) to keep only maximal paths
ORDER BY gen_random_uuid, path, ordinal;
```

Techniques worth stealing, and their SQLite translation (Sqlg is Postgres-only —
uses `ARRAY[]`, `= ANY`, `UNNEST WITH ORDINALITY`, `gen_random_uuid`, none of
which SQLite has):

| Sqlg (Postgres) | Purpose | SQLite equivalent |
|---|---|---|
| `path` `bigint[]`, `path \|\| id` | accumulate path | JSON1 `json_insert(path,'$[#]', id)` (SQLite has no array type) |
| `id = ANY(path)` | `simplePath` cycle guard | `NOT EXISTS(SELECT 1 FROM json_each(path) WHERE value=id)` |
| `UNNEST(path) WITH ORDINALITY` | explode elements in order | `json_each(path)` — `.key` gives the ordinal for free |
| `previous` array + `path NOT IN (SELECT previous)` | keep only maximal paths, drop prefixes | portable as-is (compare serialised text) — a neat set-based trick |
| `gen_random_uuid()` per path | keep same-prefix paths groupable after explode | recursive-CTE row identity / `rowid` |
| loop-unroll `times(n)` → n JOINs | bounded repeat without recursion | port directly — cheaper than `WITH RECURSIVE` for fixed n |
| force-label all → in-memory assemble | general `path()`/`tree()` | reuse our `as()` column-carry + assemble in `handler.ts` |

Key Sqlg pointers: dispatch `BaseStrategy.java:158-168`; recursive builder
`SchemaTableTree.java:4823-4866` (out), `:5109` (both — carries a `direction`
column + CASE ladder for undirected cycle-check), `:4135-4293` (include-edge:
parallel `epath` edge-id array, V/E interleave, `LIMIT 500000` guard);
loop-unroll `BaseStrategy.java:1081`; force-label `BaseStrategy.java:1657-1075`;
path→Emit reconstruction `SqlgUtil.java:376-410`; label→column encoding in the
column alias string `SchemaTableTree.java:3055-3072`.

---

## 2. The v4 semantic contract (and a surprise)

**Surprise: TinkerPop 4.0.0-beta.2 deleted the Java step engine.** No
`MutablePath`, `PathStep`, `SimplePathStep`, `TreeStep`, `RepeatStep`,
`TraverserRequirement` anywhere — the whole `process/traversal/step/` dir is gone.
`PathRetractionStrategy`/`RequirementsStrategy` survive but import deleted classes
(vestigial v3 carryover; good as intent-docs, not compilable). **The Gherkin
features are now the only authoritative contract** — which is exactly our model
(parse→compile→conform-against-features). We cannot crib step algorithms; we
derive from the `Path` interface data model + scenarios.

Semantic rules we must match:

- **A Path is two parallel ordered lists**: `objects()` + `labels()` (a
  `Set<String>` per object). `extend(obj, labels)` appends; `extend(labels)` tags
  the current head (that's what `as('x')` does — no new object).
  `Path.java:36-43,80-88`.
- **What enters the path**: every *mapping/flatmapping* step appends one object
  (V, out, in, both, values, outE, inV…). **Filter steps append nothing**
  (`has`, `where`, `simplePath`). So `V().as(a).has(..).as(b).has(..).as(c).path()`
  → a **single-element** path with three labels on one vertex (`Path.feature:74`).
- **`path().by(...)` = positional round-robin**, modulator index = `elemIdx %
  byCount`. `out().out().path().by("name").by("age")` → 3 elements, 2 by's cycle:
  name, age, name (`Path.feature:62`).
- **Non-productive-`by` DROPS the whole traverser** (default). `out().path().
  by("age")` yields 2 paths not 3 — `lop` has no age, so that path vanishes
  (`Path.feature:113`); only `ProductiveByStrategy` emits `null`. A correctness
  trap to replicate.
- **`simplePath`/`cyclicPath` compare OBJECTS ONLY, all-pairs, whole path**
  (`Path.java:206-215`). cyclicPath = exact negation. `by`/`from`/`to`
  transform-and-scope the compared subpath.
- **`tree()` = prefix-merged nested map** (a trie), a barrier side-effect; same
  round-robin `by` keyed by depth. `Tree.feature`.

### The two levers that decide our whole design

**(a) `PATH` vs `LABELED_PATH` requirement.** Presence of `path`/`tree`/
`simplePath`/`cyclicPath` (unscoped) ⇒ **full walk must be materialised**.
Everything else (`as`/`select`/`where`/scoped `from`/`to`) ⇒ only **labelled**
elements needed, and each label only across `[as-step … last-reference]` — a
bounded, sparse column set, droppable early (`PathRetractionStrategy` reverse
`keepLabels` scan). **So detect the split at compile time**: full-walk assembly
vs the bounded label-column set we already thread.

**(b) Path kills bulking.** A traverser's path is part of its identity; two
traversers reaching the same node via different walks are **not equal**, so they
**cannot merge/bulk** — each distinct walk is its own row (`Traverser.java:176-
183,206-226`). Cardinality becomes **walk-cardinality** (potentially exponential
in hops), not node-cardinality. This is the same exponential wall §4 quantifies,
seen from the semantics side. Our existing "traversers are multisets, only dedup
collapses" note already aligns; path just forces `bulk=1` and forbids the
count-fold.

Conformance surface (Gherkin): `Path.feature` 11, `SimplePath.feature` 5,
`CyclicPath.feature` 5, `Tree.feature` 12, path-bearing `Repeat.feature` subset,
`Paths.feature` 2 (advanced — defer). ~35 core scenarios. First tests to write:
`SimplePath.feature:21` (smallest simplePath), `CyclicPath.feature:21/47`,
`Path.feature:62` (round-robin), `Path.feature:113` (non-productive drop),
`Path.feature:85` (V/E interleave), `SimplePath.feature:34` (`repeat(both.
simplePath).times(3).path` — cycle-free repeat), `Tree.feature:38` (prefix merge),
`Path.feature:100` (labelled subpath / the LABELED_PATH surface).

---

## 3. Our current state — the rails that exist

Full survey in the agent report; the load-bearing facts:

- **`repeat` recursive CTE carries `(id, depth)` only** (`branch.ts:75-84`).
  Widening to `(id, depth, path)` with `json_array(id)` seed + `json_insert(...,
  '$[#]', tgt)` in the recursive term is the natural, *contained* change — and
  it's the only place SQL path accumulation should live. Note repeat currently
  **refuses alias-carry** (`branch.ts:54`) and requires `times()`.
- **`St` traverser state is one relation, columns = `id` + alias cols**
  (`context.ts:24-31`). Columns are fixed at CTE construction (`q.ts:119-133`) —
  `Relation` is not open-ended. So threading a path column *through the linear
  fold* is invasive across every StepFn (`movement.ts:14-22` `carryFrag`) —
  which is exactly what Sqlg's force-label-and-assemble approach lets us avoid.
- **`as()`/`select()` already remember per-row element ids as columns**
  (`filter.ts:36-48`, `projection.ts:330-357`): `as('a')` binds col `a0`,
  `carryFrag` splices `, p.a0` onto every hop, `select('a')` joins it back. **A
  linear `path()` is the generalisation of this** — remember every step, not just
  tagged ones — and it's the mechanism to reuse, not a new path column.
- **No path/tree/simplePath/cyclicPath code exists** (one unrelated `path:null`
  in the P-typeof map). They currently hit the generic "not implemented" throw.
- **Framing rails present**: `listBuffer` (hand-framed GraphBinary LIST, used by
  `fold`) + `elementBuffer` in `handler.ts:107-125`. A `{kind:'path'}` shape maps
  each element through these; TinkerPop `Path` has its own `DataType.PATH`
  layout, so a small `pathBuffer` mirroring labels+objects, templated on
  `listBuffer`.

---

## 4. The scaling wall — quantified, and SQLite has no escape hatch

Every production graph-on-RDBMS engine that supports real path workloads
**abandons naive recursive CTEs** for a bespoke operator (DuckPGQ = CSR +
vectorised BFS; DuckDB `USING KEY` = settled/keyed working table; Apache AGE =
custom VLE executor; GraphflowDB = worst-case-optimal joins). One reason,
everywhere: plain `WITH RECURSIVE` is **append-only** — no "already-settled" set —
so on any cyclic/dense graph it re-derives each reachable node through every
distinct path, i.e. exponential simple-path enumeration.

Concrete number (DuckDB `USING KEY` blog): on a **424-node, 1,446-edge** graph —
*tiny* — a standard recursive CTE produced **605,859,791 rows** (near-OOM) vs
**19,213** with a settled set, same query/data. The threshold isn't graph size,
it's **branching-factor × depth**; and the path-array cycle check is itself
O(depth) per row (`json_each` scan), so cost is multiplicative.

**SQLite has no mitigation**: `USING KEY`/settled-set is DuckDB-only; SQLite's
recursive CTE is strictly append-only (only `UNION` whole-row dedup, no
settled-set-by-key). So we inherit the worst case with only depth caps and
`until()`/`limit()` early-termination as guard rails. The saving grace in
practice: our target is small OLTP graphs (agent memory, per-tenant KGs) with low
branching factor, and `simplePath()`'s **early-reject** guard keeps the frontier
small at the source (that's the entire lesson of 605M-vs-19K).

SQLite's own docs never show a path column (community idiom); they do recommend
`UNION` for cycle-safety and a `LIMIT` in the recursive term as a hard safety
valve. Canonical SQLite path+cycle pattern we'd adopt (JSON1):

```sql
WITH RECURSIVE walk(id, path, depth) AS (
  SELECT id, json_array(id), 0 FROM nodes WHERE id = :start
  UNION ALL
  SELECT e.tgt, json_insert(w.path,'$[#]', e.tgt), w.depth+1
  FROM walk w JOIN edges e ON e.src = w.id
  WHERE w.depth < 32
    AND NOT EXISTS (SELECT 1 FROM json_each(w.path) je WHERE je.value = e.tgt)  -- simplePath
)
SELECT * FROM walk;
```

Terminology aligns with SQL:2023/SQL-PGQ (we're not inventing vocabulary):
`path()`=WALK, `simplePath()`=SIMPLE, `cyclicPath()`=the negation of SIMPLE
(no first-class standard mode), TRAIL (no-repeated-*edge*) has no Gremlin step.
SIMPLE is precisely the standard's stated *finiteness guarantee* for unbounded
quantifiers — matching why users put `simplePath()` inside `repeat()`.

---

## Verdict — are we missing a trick?

**Yes, one, and it changes the plan:** don't thread a path column through the
linear movement fold. Adopt Sqlg's **two-regime split**:

1. **Recursive-repeat regime** (`repeat(...).until/times(...).path()`,
   `repeat(...simplePath()...)`): true SQL path accumulation, but **only here** —
   widen the one `recursiveCte` in `branch.ts` to carry a JSON `path` (`json_
   insert '$[#]'`), `simplePath` = `NOT EXISTS json_each` early-reject in the
   recursive WHERE, `cyclicPath` = the dual predicate post-hoc (unbounded, leans
   on the depth-32 guard). This is contained to one function and is where the
   `path` work *upgrades* the repeat we already shipped.
2. **Linear regime** (`g.V().out().out().path()`, `tree`, `select`, standalone
   `simplePath`/`cyclicPath`): **do not compute path in SQL.** Detect the
   `PATH` requirement, force every intermediate element into the projection
   (generalise the `as()` column-carry we already have), and assemble the
   `Path`/`Tree`/simple/cyclic filter in `handler.ts` over materialised rows.
   Reuses `listBuffer`/`elementBuffer`; a small `pathBuffer` for `DataType.PATH`.

This still honours "compile to SQL, never interpret" — the SQL does the movement
set-at-a-time; only the final *path shaping* (a bounded per-row list) folds in the
handler, exactly as `groupBuffer`/`listBuffer` already shape group/fold results.

What we should **not** build: a DuckPGQ-style CSR/bespoke path operator. That
buys shortest/cheapest-path selectors Gremlin's `path` family doesn't need
(shortest path is a `repeat().until().limit(1)` composition, already out of
scope), and SQLite can't host it well anyway.

Design forks to settle before coding:
- **Detection pass**: add a `PATH`-vs-`LABELED_PATH` scan in `strategies.ts`
  (mirrors how the repeat cluster is already pre-scanned) that flags the regime
  and, for LABELED_PATH, the live span of each label.
- **Bulk**: when `PATH` is flagged, the id-relation must be UNION-ALL walk-rows
  (no count-fold) — confirm nothing downstream assumes node-cardinality.
- **Lift the "after `as()`" refusals** (`repeat`/`dedup`/`union`) that the path
  work will collide with — they assume no carried history.
