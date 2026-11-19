# Compositional coverage — measure the depth cliff, then flatten it

**Status: COMMITTED DIRECTION (owner, 2026-11-16).** The goal is to make this work. **Only the owner can
abandon, narrow or reverse it — never an agent or a session on its own judgement.** Phases 0–1 measure and
change no compiler code. Measurement still comes first, per `src/compiler/CLAUDE.md`, but its job here is to
STEER the build: which hosts first, where the fast path must stay, which problems to solve. It does not
decide whether the build happens.

**Escalation rule.** The gates and thresholds below (G1, G2, the 80% / 1.5× / special-case signals) are
**escalation triggers, not stop conditions.** When one fires:
1. stop building in the affected area;
2. write up the numbers, the diagnosis and the options (including how to fix it within this direction);
3. bring it to the owner.

No item goes to "Won't do", and no phase is skipped or reverted, without the owner's explicit consent given
after that discussion.

## 1. Why — what was measured on 2026-11-15

| Probe | Result |
|---|---|
| L3 (TinkerPop's corpus) | 2,018 / 2,270 (89%); the curve is flattening into a low-reach tail |
| 40 hand-written app-shaped queries over `modern` | 34 / 40 (85%) |
| 2,500 generated well-typed compositions (`traversal({steps: 6, depth: 3})`, seed 11) | 72.7% execute |
| Wrong answers / internal errors across all of the above | 0 |

How often a query declines depends on how deeply it nests (max paren depth, which includes predicate parens):

| Depth | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Decline rate | 6% | 28% | 71% | 88% | 98% |

A compositional compiler shows a roughly FLAT curve. This one has a cliff.

**All six realistic misses have the same cause.** A structured or child-produced value crosses a scope boundary that has no route for it:

- `path().count(local)`
- `out().out().path().unfold()`
- a nested `project()` inside `by()`
- `by(coalesce(out().values().fold(), constant([])))`
- `map(out().values().fold()).where(count(local).is(gt(1)))`
- `sideEffect(out().aggregate('x')).cap('x').unfold()`

**The structural reason.** A child body is lowered by a LADDER of specialised routes. These include:

- the correlated scalar `scalarChild`;
- `correlatedReduce`;
- `flatMapRejoin`, which works for element hosts only;
- `nestedHostChild` and `producedOnlyWhere`;
- per-shape readers in `list.ts`, `map.ts` and `record.ts`.

Each route covers the combinations it was written for and returns `null` on the rest. The lowering holds
**~890 `return null` decline sites**:

| File | Sites |
|---|---|
| `lower.ts` | 304 |
| `lower/reduction.ts` | 134 |
| `match.ts` | 69 |
| `lower/branch.ts` | 67 |
| `modulator.ts` | 65 |
| other files | the rest |

Each site is a combination that some route did not anticipate. Under a ladder, the work grows as
*hosts × body shapes × value shapes × depth*. That is the "never-ending task" the owner is worried about,
and it is real for as long as the ladder is the semantic authority.

## 2. The substantial thing — scoped relations (general decorrelation)

### Prior art

This is a solved problem in relational compilers. Neumann and Kemper's *Unnesting Arbitrary Queries*
(BTW 2015) and *Improving Unnesting of Complex Queries* (BTW 2025) show that ANY dependent join
`T ⋈ₓ B(x)` becomes a plain join with no correlation. You compute the DOMAIN `D = distinct(free variables of T)`,
push `D` down into `B` so `B` becomes an ordinary relation keyed by `D`, and join back on that key.
The algorithm is total: depth only adds key columns.

Calcite ships this algorithm, and it is vendored here:
- `vendor/calcite/core/src/main/java/org/apache/calcite/sql2rel/TopDownGeneralDecorrelator.java`;
- domain push-down at `:444`;
- the per-operator push rules `:737-812`;
- `ROW_NUMBER` for top-N per domain at `:657`.

**Which paper we follow: the 2025 top-down algorithm.** The two papers do not describe two algorithms to
build. The 2025 paper refines the 2015 one, and Calcite implements only the 2025 version.

From 2015 we take:
- the core equation (`T ⋈ₓ B` ≡ `T ⋈_{x=d} (D ⋈ₓ B)`);
- the per-operator push-down rules.

From 2025 we take:
- **top-down push-down.** The domain `D` travels only into the subtrees that actually reference the free variables. Correlation-free subtrees are left alone. This keeps deep nesting from duplicating work.
- **one domain per scope level.** Calcite's `corDefs` collects the free variables of every enclosing level. That is our S2 scope stack.
- **`ROW_NUMBER` handling for `limit`/top-N per domain** (`:657`, §4.4). That is our `perOriginWindow`.

Calcite marks the class `@Experimental` and does not wire it into its own pipeline. It is good prior art for
the rules, not a proof that the approach works in production. Phase 2's measurements have to supply that proof.

**TinkerPop's model is the same idea.** A child traversal is applied *per traverser*
(`TraversalUtil.apply`), so the scope key IS the entering traverser's identity.

### We already own about half of it

- `ORIGIN` channel, minted by `mintRowOrigin`/`childRows`. This is a per-traverser scope key.
- `originDomain` (11 uses). This is Neumann's `D`. It lets a seeded barrier emit `[]`/`{}`/`0` for a scope whose sub-stream is empty.
- `nestRowOrigin`. This is a nested scope, stacked as channels.
- `perOriginWindow`. This is Calcite's per-domain `ROW_NUMBER` top-N, already citing `SqlToRelConverter.java:1045-1113`.
- `continueAs`. This is the ONE fold that a body re-enters.

### What is missing: making it TOTAL and making it the AUTHORITY

**S1 — The scope key is total.** Any host framing mints an origin: element, scalar, list, map, record, path. Today:
- `childRows` and `flatMapRejoin` take elements only ("a scalar host has no rowid for origin");
- a body that loses the origin at a barrier declines.

`ROW_NUMBER() OVER ()` needs no rowid, so the elements-only limit is unnecessary.

**S2 — Barrier law.** Every barrier inside a scoped body is scoped by the WHOLE scope stack. The stack is every enclosing origin, as passengers.

| Barrier | Scoped form |
|---|---|
| grouping (`fold`, `count`, `sum`, `group`, `groupCount`) | `GROUP BY (scope stack[, key])` |
| `dedup`, `order`, slices | partition by the stack |

This removes the documented residue *"GROUP BY names one origin and the enclosing one has no group policy"*
(`outstanding-work.md` §3.8). This is ONE rule, not a per-barrier route.

**S3 — Domain law.** A seeded barrier LEFT-JOINs the scope domain, which generalises `originDomain`:
- `fold` gives `[]` for an empty scope;
- `count` gives `0`;
- an unseeded barrier (`sum`) emits nothing (`SumGlobalStep`).

Cite the reference per barrier, as CLAUDE.md requires.

**S4 — Hosts are CONNECTORS, not routes.** Every child-taking step becomes:

1. scope the input;
2. lower the body through `continueAs`, the same fold the root uses;
3. reconnect with a policy.

The policy table below has one row per host, about 15 rows. It is a `Map` registration, per the bright line in `src/compiler/CLAUDE.md`:

| Host | Reconnect policy (on the scope key) | Reference |
|---|---|---|
| `map(b)` | first per scope (`rn = 1`), inner join | `TraversalMapStep.java:49-53` |
| `flatMap(b)` / `local(b)` | all rows, scope-major order, shed or forward labels | `FlatMapStep.java:42-52`, `LocalStep.java:80-88` |
| `where(b)` / `filter(b)` / `and` | semi-join | `TraversalFilterStep` |
| `not(b)` | anti-join | `NotStep` |
| `or(b…)` | semi-join on a union of the arm domains | `OrStep` |
| `optional(b)` | body rows ∪ host rows whose scope is not in the body domain | `OptionalStep` |
| `coalesce(b…)` | per scope, the rows of the lowest arm index that is non-empty | `CoalesceStep.java:58` |
| `choose(p, t, f)` / `branch().option` | route on the predicate's semi-join or anti-join, or on the key value | `BranchStep.java:161-162` |
| `union(b…)` | `UNION ALL` of the arms, ordered scope-major then arm | `UnionStep` |
| `project(..).by(b)` / `select().by(b)` | LEFT JOIN of first-per-scope, one per `by()` | `ProjectStep.java:66` |
| `group().by(k).by(b)` | the body reduced per (scope, key) | `Grouping.java` |
| `order().by(b)` / `dedup().by(b)` | first-per-scope as a sort or dedup key | `OrderGlobalStep.java:183-184` |
| `repeat(b)` bounded / unbounded | unchanged: phases / `Recursive` (the two-regime law) | archived repeat plan |
| `sideEffect(b)` / `aggregate` in a body | the collection substrate's binding, scope-keyed | named-collections plan |

**S5 — Structured values cross the seam as JOIN COLUMNS, not scalar subqueries.**

- **Paths, lists, maps and records.** These ride the scoped relation as typed carriers. The carrier is the typed-value-carrier plan's T1 (`docs/2026-11-05-typed-value-carrier-plan.md`). Under S4 the carrier stays one column of a joined row. That satisfies T1's rule 4 ("one read") by construction.
- **Collection re-entry** (`unfold`, `count(local)` and similar). This is an `explode` keyed by the scope.
- **`path()` as a value.** It is simply the path channel projected as a payload.

### Why this flattens the cliff

Today a depth-k query has to match a route that someone wrote for that exact combination. Under S1–S5, a host
is correct for ANY body that `continueAs` can lower at the top level. Nesting adds one scope column; it does
not add a route combination. The coverage question changes:
- from: "did someone write this combination?"
- to: "does the step lower at the top level, and does its host have a connector row?"

The second question is O(steps + hosts), so it is finite.

### What stays: the ladder becomes the FAST PATH

The correlated scalar subquery is genuinely faster for common shallow shapes. Examples:
- `project('x').by('age')`;
- `where(out().count().is(gt(1)))` over a selective outer.

These are index seeks per outer row; the scoped form is a grouped join over the domain. So the existing
routes are KEPT. They are demoted to an opt-in `FastPath` (`correlatedChild`) that the lowering reads, exactly
as `movementCollapse` is today. Three consequences:

1. **L5 gets a new differential for free.** Comparing `correlatedChild` on and off checks every existing route against the general lowering. Every wrong answer the ladder hides becomes visible.
2. **A route's `return null` stops being a user-visible decline.** It becomes "fast path not applicable", and the query falls to the general lowering.
3. **The ladder can SHRINK.** Wherever a route matches the general path's plan cost, delete it. The count of `return null` sites becomes a tracked metric.

### Risks and their checks

| Risk | Check |
|---|---|
| A grouped join over the domain is slower than per-row seeks on selective outers | Scaling probe at 1k/8k on the cost-discipline shapes (§5). The fast path stays wherever it wins. |
| SQLite's 64-table join cap is hit sooner (one join per `by()` per level) | Each scope level is a `MATERIALIZED` CTE (the `hoist.cut` mechanism), so a level costs one FROM entry. A remaining overflow is a query-TEXT decline, which is allowed. |
| DO's 100 KB statement text | Measure the bytes per level in the spike. |
| Ordering semantics (scope-major vs interleaved) | Already solved once: `originMajor`. Generalise it, don't re-derive it. |
| "Shape consulted, never constructed" | Not touched. S1–S5 add no shape field to the IR, and the connector table is keyed by STEP NAME. |
| It is a big refactor | The phases below keep trunk green at every step. The general path ships behind a switch until it is inverted, so a partial build-out is never a regression. |

## 3. Phases

### Phase 0 — Instruments (no compiler change). IDs `cc0-*`.

- **cc0-curve — the depth curve as a tracked metric.** Add `scripts/coverage-curve.ts` and `mise run coverage`.
  - Sample the L5 generator at fixed seeds, N ≥ 2,000, under two profiles:
    - `{steps: 6, depth: 3}`;
    - a new `realistic` profile with app-idiom children such as `out(k).has(..)`, `values(k).fold()`, `count()` and `project`.
  - Report the execute % by **child-traversal nesting depth**, computed from the IR with `ir/walk.ts` (not parens), and by host step.
  - Commit the result as `test/L5-properties/coverage-baseline.json`.
  - Add a one-way ratchet test: the curve may not drop at any depth, mirroring `l3-state.json`.
  - Print the curve in CI.
- **cc0-workload — a realistic workload suite, `test/L6-workload/`.** `scripts/brackets.ts` turns the new directory into its own bracket automatically.
  - **Corpus.** Start with the 40 queries from 2026-11-15. Add app-shaped queries from TinkerPop's recipes and from *Practical Gremlin* (verify the licence before vendoring text) over `modern` and a larger graph. Aim for ~200, each tagged by idiom.
  - **Oracle, for now.** Execution, plus the L5 differential, plus hand-verified answers on `modern` for a subset.
  - **Goldens — DECIDED by the owner (2026-11-16).** Generate them ONCE, offline, against TinkerGraph using the `tinkerpop/gremlin-server` Docker image, pinned to the same TinkerPop commit as `vendor/tinkerpop`. Commit the goldens together with the one-off script that produced them, in `scripts/workload-goldens/`. That script is never run in CI, so the build gains no dependency.
  - **Practical Gremlin queries — APPROVED.** The owner approved adding examples from *Practical Gremlin* (Kelvin Lawrence), including its `air-routes` graph as a second fixture. Confirm its licence before committing, and put the attribution in the fixture header.
  - Ratchet the pass count one way.
- **cc0-host-law — a host-closure L5 law.** For any body `b` that executes at the top level, every host `H(b)` executes too:
  - hosts: `map`, `flatMap`, `local`, `where`, `not`, `project().by`, `group().by().by`, `order().by`, `coalesce`, `optional`, `union`;
  - this applies wherever `H` is well-typed for `b`'s output;
  - the semantic half compares the results: `map(b) ≡ b` per traverser for single-valued `b`, and similar.

  Report the closure rate per host. This is the most direct measure of compositionality, and it subsumes
  typed-value-carrier T8.

### Phase 1 — Attribution (no compiler change). IDs `cc1-*`.

- **cc1-shrink — minimal declining cores.** Delta-debug each declining query from cc0 down to the smallest one that still parses and still declines:
  - drop a step;
  - replace a child with `identity()`;
  - hoist a child to the top level.

  Then canonicalise the core into a signature (host → body shape → value shape) and cluster. The output is a ranked table in `.logs/coverage-attribution.md`, with a committed summary.
- **cc1-classify — one class per cluster:**
  - **(a) seam**: the step lowers at the top level and declines only under a host or depth;
  - **(b) step**: the step itself has no lowering;
  - **(c) platform**: an SQLite or DO limit;
  - **(d) generator noise**: not a sensible query.
- **Checkpoint G1 (escalation, not a stop).** Record the measured share of class (a) here.
  - If it is **≥ 50%** of the weighted declines at depth ≥ 2, proceed to Phase 2.
  - If it is lower, the missing steps (class (b)) are a bigger share than expected. Bring the clusters to the owner with a proposal for how to interleave the (b) work alongside Phase 2. Do not drop the refactor.

#### G1 measurement (2026-11-16)

Recorded for the owner's checkpoint — **the decision is the owner's, not this record's.** Instrument:
`mise run attribution` (`scripts/coverage-attribution.ts`, engine `test/L5-properties/{shrink,attribution}.ts`;
full table in `.logs/coverage-attribution.md`, ~2 min). Inputs: every decline from the L6 workload (41),
the `realistic` and `lattice` coverage profiles at 1,000/seed × 3 seeds, and the host-closure ratchet sample
(seed 42, 200 cases) — 3,013 declines, 1,152 clusters, **0 internal errors**. Reach weights: workload ×8,
realistic ×4, host-closure ×2, lattice ×1. Depth = the ORIGINAL query's child-nesting depth.

**Weighted share of class (a) seam at depth ≥ 2: 94.5%** (1,573 of 1,744 declines; 95.1% with noise left out
of the denominator; 90.2% unweighted).

| Scope (count, weighted share) | (a) seam | (b) step | (c) platform | (d) noise |
|---|---|---|---|---|
| all depths | 2,604 — 90.6% | 377 — 8.9% | 0 | 32 — 0.5% |
| depth ≥ 2 | 1,573 — 94.5% | 146 — 4.9% | 0 | 25 — 0.6% |
| workload (all / depth ≥ 2) | 20 / 7 | 21 / 1 | 0 | 0 |
| realistic, depth ≥ 2 | 429 — 98.2% | 8 | 0 | 0 |
| host-closure, depth ≥ 2 | 805 — 98.1% | 16 | 0 | 0 |
| lattice, depth ≥ 2 | 332 — 69.5% | 121 — 25.3% | 0 | 25 — 5.2% |

Seam (a) by S-item (weighted; a step-name heuristic in `attribution.ts` `sItemOf`, not a proof): **S5 34%**
(most of it the PATH channel a `simplePath()` body reads, then a `fold()` arm), **S4 29%**, S2 21%, S1 13%, S3 3%.

Top 20 clusters by reach (sources = workload/realistic/host/lattice):

| # | Reach | Class | S | Host | Sources | Example minimal core |
|---|---|---|---|---|---|---|
| 1 | 292 | seam | S5 | coalesce | 1/71/0/0 | `g.V().coalesce(__.values('name').fold(), __.constant([]))` |
| 2 | 76 | seam | S4 | project.by | 3/13/0/0 | `g.V().project('name','manager').by('name').by(__.in('knows'))` |
| 3 | 76 | seam | S5 | where | 0/19/0/0 | `g.V().where(__.simplePath().count().is(P.gt(1)))` |
| 4 | 75 | seam | S5 | where | 0/16/2/7 | `g.V().where(__.simplePath())` |
| 5 | 74 | seam | S4 | map | 0/0/37/0 | `g.V().map(__.has('age'))` |
| 6 | 73 | seam | S2 | coalesce | 0/18/0/1 | `g.V().coalesce(__.limit(2), __.identity())` |
| 7 | 72 | seam | S4 | group.by | 0/18/0/0 | `g.V().group().by('name').by(__.out())` |
| 8 | 71 | step | — | — | 4/0/0/39 | `g.V().path().count(local)` |
| 9 | 71 | seam | S4 | project.by | 0/0/33/5 | `g.V().project('x').by(__.has('age'))` |
| 10 | 68 | seam | S4 | groupCount.by | 0/17/0/0 | `g.V().groupCount().by(__.out())` |
| 11 | 64 | seam | S3 | group.by | 0/16/0/0 | `g.V().group().by('name').by(__.count().is(P.gt(0)))` |
| 12 | 64 | seam | S4 | project.by | 0/16/0/0 | `g.V().project('a','b').by('name').by(__.out())` |
| 13 | 62 | seam | S5 | not | 0/14/2/2 | `g.V().not(__.simplePath())` |
| 14 | 61 | seam | S5 | or | 0/15/0/1 | `g.V().or(__.identity(), __.simplePath())` |
| 15 | 58 | seam | S4 | dedup.by | 0/0/29/0 | `g.V().dedup().by(__.has('age'))` |
| 16 | 57 | seam | S2 | coalesce | 0/9/9/3 | `g.V().coalesce(__.dedup(), __.identity())` |
| 17 | 52 | seam | S5 | choose | 0/13/0/0 | `g.V().choose(__.identity(), __.simplePath())` |
| 18 | 51 | step | — | — | 0/0/0/51 | `g.E().otherV()` |
| 19 | 48 | seam | S4 | group.by | 1/10/0/0 | `g.V().group().by('name').by(__.in('created'))` |
| 20 | 44 | seam | S4 | project.by | 3/5/0/0 | `g.V().project('p','top').by('name').by(__.outE('created'))` |

What the numbers say, for the owner:
- **The workload is the one source where (b) is half** (21 of 41): those are almost all depth 0–1 step gaps —
  vertex-property (meta-property) access (`properties('location').has/hasNot/values/order`), `path()` as a value
  (`path().count(local)`, `path().unfold()`), `tree()`, `where(P.within(sideEffect))`, `where(P.gt(label)).by()`.
  At depth ≥ 2 the workload is 7 seam to 1 step. So the (b) work Phase 5 owns is concentrated and nameable.
- **Several seams are trivially shallow**: a filter or element-valued body under a value host
  (`map(has(..))`, `project().by(has(..))`, `dedup().by(has(..))`, `group().by(k).by(out())`,
  `order().by(out(), desc)`) declines at depth 1. These are S4 connector rows in their simplest form.
- **A path-reading body (`simplePath()`) under any host** is the largest S5 family (clusters 3, 4, 13, 14, 17,
  plus `union`/`optional`/`repeat`): the path channel does not cross the seam.

How to read it (the instrument's limits): delta debugging keeps the FIRST minimal decline it reaches, so a
query with two gaps is attributed to whichever survives the greedy shrink; slippage to an unrelated
decline is held back by guards (a coarse type check, positional `by()`s, label protection, shape-preserving
drops, two-arm branches — `shrink.ts`). The figure is sensitive to those guards and they push it UP: an
unguarded shrink (small sample) read 44%, because a third of its top clusters were slips into type-error
declines (`project('p').out()`, `count().values()`); with the guards, the full-sample runs read 87.1% →
87.2% → 94.5% as the last two (two-arm branches, shape-aware hoisting) went in. Class (a) is decided mechanically: every arm of the innermost
host, hoisted over the host's input, compiles (and, outside a `repeat`, executes). Noise (d) is lattice-only:
a filter over an always-productive seeded reducer, or a hoisted body the reference rejects.

**G1 decision (owner, 2026-11-16): PROCEED to Phase 2.** Alongside it, run the class (b) step-gap
clusters found in the workload as their own track (**cc1b**, in workload-reach order):
- meta-property access (`properties(k).has/hasNot/values/order().by`);
- `path()` as a value (`path().count(local)`, `path().unfold()`);
- `tree()`;
- `where(P.within/without(<side-effect>))`;
- `where(P.gt('a')).by(k)`.

S4/S5 do not cover these, so they will not fall out of the refactor.

### Phase 2 — Spike: scoped relations for three hosts, behind a switch. IDs `cc2-*`.

- Implement S1–S3 plus the connector rows for `where`/`not`, `map`, and `project().by` over **every host framing**.
- These run as the general path. The existing routes are wrapped as the `correlatedChild` fast path (on by default).
- **Measure:**
  - the cc0 curve for those three hosts with `correlatedChild` off. This is the general path alone; does it flatten?
  - the L5 differential with it on vs off: 0 unexplained divergences, or each one diagnosed as a ladder bug;
  - scaling at 1k/8k on the cost-discipline shapes;
  - statement bytes and join count per nesting level;
  - `sql-hygiene` with it on.
- **Escalation signals.** Any of these means "stop and discuss with the owner", NOT "abandon":
  - the general path's closure rate at depth 3 for those hosts is < 80%;
  - it needs per-shape special cases in the connector (that is the ladder again);
  - a common shape regresses > 1.5× with no fast-path recovery.

  Each one comes with a diagnosis and a fix within the direction. For example: a missing connector rule, a value-carrier gap, or a plan shape the fast path should keep.
- **Checkpoint G2.** The owner reviews the spike's numbers before Phase 3 starts.

#### G2 measurement (2026-11-16)

Recorded for the owner's checkpoint — **the decision is the owner's, not this record's.**

**What was built.** `src/rel/decorrelate.ts` — a general decorrelator over the closed RelIR node set (Neumann
2015/2025, Calcite `TopDownGeneralDecorrelator`): one rule per node kind (Aggregate grouped by the key, a
scalar Aggregate LEFT-joining the domain and taking each `Agg`'s value over zero rows, Window partitioned by
it, Limit → per-key `ROW_NUMBER`, two keyed join sides equated on it, a keyed Recursive). `src/compiler/rel/lower/scoped.ts`
— the connector: S1 (scope any framing by `ROW_NUMBER()`; a fenced CTE where self-contained, else numbered
over every column so two reads agree), the body lowered over ONE correlated host row through `continueAs`,
decorrelated, then reconnected by the host's `CONNECTORS` row: `where`/`filter`/`and` semi-join, `not`
anti-join, `map` first-per-scope inner join, `project().by` first-per-scope LEFT join per child `by()`.
S2 and S3 are not routes: every barrier is scoped by every enclosing key because each level's decorrelation
adds its key to the relation the next level decorrelates (the nested-where plan partitions by
`(outer key, inner key)`), and a seeded barrier keeps its seed because the correlated plan's own SQL answer
over zero rows is kept (`count`→0, `fold`→`[]`, `sum`'s non-empty guard emits nothing — the per-barrier
citations already on those lowerings carry over). The switch: `correlatedChild` (on) tries the ladder first;
off tries the connector first; each is the other's fallback, and `bothChildOrders` (`rel/spine.ts`) retries a
declining compile in the other order, because a NESTED site's choice changes what its enclosing route
accepts (measured: 4 of 8,929 host queries answered in one order only before the retry; 0 after). The
connector declines bodies that draw (`sample`/`coin`/shuffle) or re-source (`V()`/`E()`) — the ladder's
`shared-draw`/`resource-under-absent` decisions stay the ladder's. A connector body's path read now seeds the
chain's path (`connectorBodyTracksPath`, `ir/analyze.ts`) — the "path channel does not cross the seam" S5
family for these hosts.

**Closure of the spiked hosts nested only in each other** (seed 42, 200 executable cases, up to 6 sampled
chains per case per depth; `.scratch`-style instrument, numbers per outermost host):

| host | general path ALONE d1 / d2 / d3 | shipping (`correlatedChild` on) d1 (ratchet) | trunk before d1 / d2 (ratchet) |
|---|---|---|---|
| map | 99.0% / 92.4% / 93.2% | 99.0% | 35.5% / 10.9% |
| where | 99.0% / 89.2% / 93.0% | 99.5% | 61.5% / 22.7% |
| filter | 99.0% / 93.1% / 94.7% | 99.5% | 61.5% / 30.8% |
| not | 99.0% / 92.9% / 93.9% | 99.5% | 61.5% / 27.7% |
| project | 96.0% / 96.6% / 94.7% | 96.0% | 33.0% / 10.0% |
| ALL | 98.4% / 92.8% / 93.9% | | |

**The curve is flat for the spiked hosts** (93.9% at depth 3; the escalation bar is 80%). The full
host-closure ratchet (all 13 hosts, inner hosts any) re-recorded at map 99.0/71.0/54.8, where 99.5/74.4/54.4,
project 96.0/76.9/62.0 for levels 1/2/3 — its deeper levels are bounded by the UN-spiked inner hosts
(`optional`/`coalesce` ~10%, `dedup` ~3% at level 3), which is Phase 3's work, not a defect of these rows.
A HEAD-vs-now replay of all 8,929 host-closure queries of the seed-42 pool: **0 lost, 0 changed answers,
+1,915 newly answering** (4,168 → 6,083); ON vs OFF: identical support and identical answers on all 6,083.

**Depth curve (`mise run coverage`, shipping):** lattice d1 67.7→85.0%, d2 24.0→61.2%, d3 6.5→36.1%;
realistic d1 83.2→86.0%, d2 70.4→73.8%, d3 71.6→75.4%, d4+ 63.2→66.7%.

**Conformance and workload:** L3 2,018 → 2,030 (+12, every one a ledgered decline that now passes against
TinkerPop's expected answer); L6 workload 271 → 280 pass, **0 wrong**, 0 fast-vs-generic divergences; census
+10 newly executing, 0 stopped, 0 changed — the 10 are exactly L3 scenarios that now pass. L4: 19 `@Unsupported`
scenarios now answer (18 untagged and passing; one — "a bind inside a MAPPING child escapes to the parent" —
encoded a WRONG expectation from the deleted legacy spine: `TraversalMapStep` emits `traverser.split(…)` off
the PARENT, so the body's `as()` does not escape; rewritten to the reference's empty answer, see below), plus
`test/L4-addendum/scoped-connector.feature` (9 scenarios, reference-cited).

**Wrong answers found.** None in the ladder: the L5 per-switch differential (corpus + generated), the L6
fast-vs-generic differential and the 6,083-query ON/OFF replay agree everywhere both lowerings answer. One
wrong EXPECTATION was found (the L4 label-escape scenario above). Two connector bugs were found and fixed
during the build, both by the L4/L6 instruments: `map(union(constant('lo'), constant('hi')))` took `hi`
(the body's emission order must be READ for a first-per-scope pick — fixed with `bodyOrder: 'read'`), and a
constant seed position made a body `fold()` order its members by emission instead of by value, diverging
from the ladder's deterministic pick (fixed: the seed carries a position only for a body that reads one,
`tail`).

**Attribution (G1 top-20 clusters):** 8 of the 20 minimal cores now compile — #2, #3, #4, #5, #9, #12, #13,
#20, reach 542 of 1,509 — which is EVERY top-20 cluster whose host is a spiked one. The rest are other hosts
(`coalesce`, `group().by`, `groupCount().by`, `or`, `dedup().by`, `choose`) or class (b) (`path().count(local)`,
`otherV()`).

**Cost.** Each scope level is one fenced CTE (self-contained) or one numbered derived table; the decorrelated
body adds one join per level and one per `by()`. `sql-hygiene` is green with no baseline rise. Compile
work: a DECLINING compile now lowers twice (`compile-work` ceiling 2016 → 2190 lowerings); a compiling one
still lowers once.

Scaling probe (synthetic graph, ~2.5 out-edges/vertex; ms at 1k → 8k):

| Shape | ON (shipping) | OFF (connector only) |
|---|---|---|
| `order().by(select('a')…)` | 29 → 140 | 33 → 148 |
| `project('x').by('age')` | 12 → 43 | 16 → 31 |
| `map(values('age'))` | 7 → 12 | 9 → 29 |
| `where(out().count().is(gt(1)))` | 8.5 → 4.9 | 7.6 → 15 |
| `dedup().by('name')` | 5.9 → 21 | 5.8 → 17 |
| `project … coalesce` | 25 → 86 | 22 → 139 |
| `map(out().values('name'))` † | 8.3 → 50 | 7.7 → 36 |
| `project().by(in('knows')…)` † | 9.7 → 24 | 7.4 → 23 |
| `where(out().simplePath())` † | 6.2 → 24 | 5.7 → 23 |
| `where(out().where(out().where(has)))` | 5.5 → 31 | 20 → 181 |
| `project(project(out().count()))` | 3.7 → 3.3 | 11 → 36 |

† connector-only shapes (the ladder declines them; ON and OFF run the same plan). Every shape scales at
most linearly in N (8× data, ≤ 9× time) in both configurations — no superlinear plan. ON is unchanged on
every §5 shape because the ladder still runs first. OFF is 2–6× slower on the deeply nested and
multi-`by()` shapes — that constant factor is the plan-cost work Phase 3 owes before inversion.

### Phase 3 — Build out and invert. IDs `cc3-*`.

**G2 DECISION (owner, 2026-11-16): PROCEED — full implementation.** Convert every remaining host, make the
general path fast enough on the slow shapes, invert it to the default, and do the performance work. The
generic mechanism is the priority because it COMPOUNDS: move as much as possible onto it. An old route
(ladder rung, correlated fast path) is kept ONLY if it earns its keep, and the bar is:
- **a measured win** on a realistic shape at 1k/8k after the general path's cost work — not a theoretical one;
- **weighed against its complexity.** A complex route that the general path replaces is a reason to delete it
  even at a small speed cost; a kept route is a small, legible switch with an L5 differential.
Each kept route is listed in this doc with its measured margin. Everything else is deleted.

Work order: (a) remaining connector rows and (b) general-path plan cost run in parallel; (c) inversion and
(d) the ladder audit/deletion follow, with the `return null` count as the tracked metric.

1. The remaining connector rows from §2's table, one commit per host. Each one: L4 scenarios citing the reference step, plus the curve delta in the commit message.
2. The nested scope stack (S2) end to end. It closes §3.8's residue and §0's "a correlated body that is a relation of its own" (the tree-Plan promotion, which `outstanding-work.md` cites as a prerequisite in four places).
3. **Inversion.** The general path becomes the semantic authority. `correlatedChild` stays a switch, under L5's per-switch sweep.
4. **Ladder deletion.** Delete a route wherever its plan is no faster than the general one. Track the `return null` count; the target is a large reduction, not zero.

#### Phase 3 (b) — general-path plan cost (2026-11-16)

Instrument: `mise run scaling` (`scripts/scaling-probe.ts`, not in `ci`) — each shape over a synthetic graph
(~2.5 out-edges/vertex, 20% `software`, 90% of persons with an `age`), ON (ladder first) vs OFF (connector
first) vs CONN (`MOGWAI_CONNECTOR_ONLY=1`, the connector ALONE); min of 7 runs; `-- --sql <shape>` prints the
plans and their EXPLAIN.

**Diagnosis.** The OFF plans paid for a decorrelation SQLite cannot use: a `ROW_NUMBER` scope over a fenced
CTE, the body grouped or windowed over every key, an automatic index to join it back. SQLite's join IS a
nested loop, so for a body it can SEEK the dependent join itself is the cheapest physical form. The connector
now KEEPS it wherever SQL can hold it, and decorrelates only where it cannot — one rule per reconnect, none
per shape:
- **existence** (`where`/`filter`/`and`/`not`): an `EXISTS` over the correlated body;
- **first row** (`map`, `project().by`): one correlated scalar per payload column (`correlatedFirst`) — one
  column always, two (value + type tag) over a body with no subplan of its own, no sort over a body of at most
  one row;
- the pick is the body's **emission order** (`TraversalMapStep.java:49-53` takes `mapTraversal.next()`): a
  multi-row body is lowered from a positioned seed, so its hops number rows in storage order, and the pick
  sorts by the position's KEYS (`src/rel/position.ts` — a `ROW_NUMBER` is monotone in its order keys, so the
  window per host row is dropped), never by value;
- a host column the body COMPUTES with is spelled inside the subquery, so a computed one (a read `as()` label)
  keeps the body decorrelated (`spelledOuterColumns`/`columnIsStored`, `src/rel/copies.ts`);
- the emitter drops a one-row constant `VALUES` that only seeds a join (`withoutUnit`, `src/rel/emit.ts`).

The decorrelated plan (`decorrelate.ts`) is the fallback for: a recursive walk in the body, a read computed host
column, a wider payload, and a multi-row body whose payload is itself a subquery (SQLite resolves an `ORDER BY`
term's subquery without the outer scopes — "no such column", measured).

**Before → after, connector ALONE, ms at 8k** (1k in the probe output; ON is unchanged by this work):

| Shape | ON | CONN before | CONN after | after / ON |
|---|---|---|---|---|
| `where(out().where(out().where(has('age',gt(40)))))` | 31.5 | 108 | 32.8 | 1.04 |
| `project('a').by(project('b').by(out().count()))` | 10.3 | 41.8 | 8.1 | 0.78 |
| `map(out().count())` | 2.7 | 16.9 | 2.8 | 1.04 |
| `map(values('age'))` | 6.3 | 11.4 | 6.6 | 1.05 |
| `out().map(values('age'))` | 18.5 | 32.1 | 18.7 | 1.01 |
| `where(out().count().is(gt(1)))` | 20.5 | 33.1 | 19.9 | 0.97 |
| `not(out().has('age',gt(40)))` | 18.5 | 23.2 | 18.7 | 1.01 |
| `where(out('knows').out('knows'))` | 27.2 | 33.7 | 26.5 | 0.98 |
| `as('a').where(out().has(…)).select('a')` | 24.3 | 35.0 | 27.4 | 1.13 |
| `project('n','m').by('name').by(in('knows').values('name').fold())` | 42.6 | 57.0 | 42.3 | 0.99 |
| `map(out().values('name'))` † | 23.8 | 33.1 | 23.2 | 0.97 |
| `where(out().simplePath())` † | 44.9 | 48.3 | 45.7 | 1.02 |
| `project('n','c').by('name').by(coalesce(values('age'),constant(0)))` | 31.3 | 54.9 | 51.2 | **1.63** |

† the ladder declines these; ON runs the connector's plan. `order().by(select('a')…)`, `project('x').by('age')` and
`dedup().by('name')` are not connector sites (one plan in every mode). Every shape is within 1.5× of the ladder
but one: **`project … coalesce`**, whose cost is the `coalesce` body's own lowering (a per-row window and union
for its arm order), not the reconnect — correlating that body measured worse (89 ms). It moves with the
`coalesce` lowering. `sql-hygiene`: no baseline rise. Host-closure pool replay (seed 42): no answer lost, ON and
connector-only agree; `map`'s pick changed to emission order wherever a body had several results
(`test/L4-addendum/first-row-emission-order.feature`).

**What this means for ladder deletion (Phase 3 step 4):** the existence routes (`childPredicate`/`correlatedExists`)
and the `map`/`project().by` correlated-scalar routes have no measured win left on these shapes; the `coalesce`
by() field is the one route with a margin (1.6×) until `coalesce` lowers flat.
#### cc3a record (2026-11-16) — remaining connector rows

Rows landed (commits `cc3a: …`): `coalesce`/`optional` (PRIORITY: each arm's host anti-joined on every earlier
arm's key), `order`/`dedup`/`groupCount`/`group` key `by()` (values LANDED as join columns the host's own
lowering reads through `childSeam`), `group().by(k).by(<barrier body>)` (a POOL scoped by the group key),
`or` (semi-join on the union of keys), `flatMap`/`local` (the rejoin, `split`/`forward` policies),
`choose` (the condition scoped, the options the host's own via `RoutedCondition`), `union` (global arms — the
row is the arm merge; it makes an arm's path read seed the chain). Every row is built from the five reconnect
primitives named in `scoped.ts`'s header; no row is a shape branch.

Closure, connector ALONE, all ratchet hosts nested in each other (seed 42): **96.3 / 88.8 / 87.8%** at levels
1/2/3 (G2: 98.4/92.8/93.9 over five hosts; the trunk-before shipping ratchet read 77.7/56.9/42.9). Shipping
ratchet **96.8 / 91.8 / 91.0%**. Curve: lattice d1/d2/d3 85.0→89.6, 61.2→81.7, 36.1→65.7; realistic
d1–d4+ 86.0→96.5, 73.8→84.2, 75.4→94.0, 66.7→96.5. L3 2030→2039, L6 280→285 (0 wrong), census +9, all verified.

Reference corrections the connector exposed: `coalesce` is a `FlatMapStep` (head.split) — a carried path is
the head's plus the one result and an arm's label does not escape; the ladder and three tests had read it as a
branch.

**Escalation (below the 80% bar at depth 3, connector alone): `group` 79.5%, `dedup` 78.5%.** Diagnosis: one
FRAMING gap, not a connector one — a MAP value holding element rowids nested inside another value (a
`group()` of elements as a group value, a key, a member) frames the rowids as bare numbers, because a nested
map node is rebuilt as it stands and never expands its elements. A pooled group value of that shape shipped a
wrong answer in the first cc3a commit and is now declined (as are such keys); the same gap answers wrong on
trunk BEFORE this work through `project('x').by(out().group().by(label))` (frames `[2,4]`). Fix in the
direction: give the map-node builder the element expansion `listNodeExpr` already has (S5's typed carrier).
**RESOLVED (cc3a, after the cc3b rebase):** `mapNodePayload` (`map.ts`) is recursive over a map's value side —
a list's members through `listNodeExpr`, a nested map's through itself — and every place a map is NESTED reads
it: a record field, a list member (`listNodeExpr`/`listPayloadExpr`), a landed group key's node. The declines
are gone, the trunk wrong answer is fixed (L4 pins all three shapes), and connector-alone depth-3 closure is
`group` 87.9%, `dedup` 88.2%.

After the rebase onto cc3b the rows keep cc3b's dependent-join forms (`firstInner`/`existence` correlated
where SQL-holdable, `rejoin` the decorrelated fallback); `coalesce`/`optional` over ONE correlated row take the
host's own `coalesceMerge`, and a by() value the seam holds as a correlated scalar is not landed — so `mise run
scaling` is at trunk's numbers on every shape (CONN@8k `order.by(select)` 84.4 vs 84.4, `project.coalesce`
51.9 vs 51.8). Not built: a correlated form for the many-row new hosts (`optional`/`local` forward,
`flatMap`/`coalesce` split) — an EXISTS-gated correlated join where the body is SQL-holdable.

Pre-existing on trunk, found by the differential and FIXED in the same commit: a nested `project()` whose inner map is
empty drops the outer key under the connector (`g.V(4).project('x').by(project('x').by(values('lang')))` is
`[{}]`, TinkerPop `[{x:{}}]`): the record-valued by() read its presence off its first SUB-field; it is now held as the map it is wherever that first field may be absent (`recordAsMap`, `scoped.ts`).

Deferred hosts, with the reason: `sideEffect(b)` — an effect-free body is already removed by a Pass
(`dropEffectFreeSideEffect`), and one WITH effects is the collection substrate's (a scoped body declines
effects); its row needs effects threaded through a decorrelated body. `repeat` until/emit — the unbounded
regime is a `Recursive` term, which may hold no window (`BARRIER_IN_TERM`), so a per-iteration ROW_NUMBER scope
key cannot exist there; the bounded regime's phases could use `RoutedCondition`-style scoped predicates, not
built. `choose(k).option(…)` (the option-map form) stays the host's own; a landed key value would serve it.
Unordered FIRST picks: the ladder is not self-consistent (a `map(coalesce(outE…))` first is edge order, a
`project().by(flatMap(coalesce…))` first is id order), so a connector body can match only one; no L5 run has
flagged one, and §17's unordered-slice divergence covers both.

#### Kept routes — the ladder audit (cc3d, 2026-11-16)

**The bar** (owner): a route is deleted when (1) the connector answers every query it answers, with identical
answers, over the L1 corpus, the L6 workload and the L9 host-closure pools (seed 42, levels 1–2), and (2) it is at
most 1.2× faster than the connector on its shape at 1k and 8k (`mise run scaling`). Anything else stays, listed here.

**How it was measured.** Coverage: the pools under the shipping default vs `connectorOnly` — on trunk `2c25a969`
the default answered **119** queries the connector alone does not, and 0 differently; each family was then taken off
the ladder in turn (the dispatch offers it no ladder) and those queries re-run. Speed: `mise run scaling` on trunk,
LADDER (`correlatedChild` on) vs CONN (the connector alone), ms at 1k / 8k, min of 7. "Lines only it uses":
line coverage of the same pools ladder-first vs connector-alone (`bun test --coverage`), read against the code — what
runs ladder-first and never under the connector. `return null` sites counted by `scripts/ladder-check.ts`'s rule.

**Deleted** (commits `cc3d: …`): `project` over an element or scalar host (`recordLeft` alone: its ladder-first
branches and the tails' `collectionArm` project arm), and `order`/`dedup`/`groupCount` with a child `by()` (no
code of their own — the dispatch no longer offers the tail the site alone; `byValues` still hands it the landed
values). One generic fix moved the largest ladder-only cluster (36 of the 119, `union(<arm>.dedup(), …)` inside a
body) onto the connector: `mergeArms` reconciles `bulk` and a dropped `path` across arms. The set of ladderless hosts
is `LADDERLESS` in `lower/scoped.ts`. `return null`: 1360 → 1358 by the rule the audit began under; trunk's guard now
leaves the connector's own scoped.ts out of the total (L9 guards it), and every site deleted here was in scoped.ts, so
under it the total is 1279 → 1279 (scoped.ts 81 → 79).

The BRANCH hosts — `choose`, `coalesce`/`optional`, `union` — are deleted too, by making the connector fast for
them rather than by keeping them: each row now tries the host's own DEPENDENT-JOIN merge over the stream first
(`chooseArms` with its correlated condition, `coalesceArms`/`optionalArms` gated by NOT EXISTS, `unionArms`), the
form SQLite runs as the nested loop its join is, and scopes the stream only where that declines; a write in an arm is
threaded as the tails did (`withBranchEffects`), and the arms see an `otherV()` demand (`armsCtx`). Before → after,
connector alone at 8k: choose(out,values,constant) 14.5 → 7.3 ms (ladder 7.6), coalesce(values,constant) 13.2 → 6.0
(6.1), optional(out.knows) 10.8 → 3.9 (3.8), project.coalesce 35.5 → 38.2 on a loaded box (ladder 37.7 there), and the
option-map `choose(values('age')).option(…)` — no connector row before — 30.0 (ladder 26.6 on trunk, 29.5 alongside).
The pools lose nothing and change nothing; the option-map form is answered by the connector now, so `choose` is
no longer a deferred host in practice.

| Family | 8k ladder / connector (worst shape) | Pool queries only it answers | Recommendation |
|---|---|---|---|
| existence (`where`/`filter`/`not`/`and`/`or`) | 20.8 / 23.8 (1.14×) | 28 | make the connector total, then delete |
| per-traverser (`map`/`flatMap`/`local`) | 8.3 / 10.6 (**1.29×**) | 9 + every re-source/draw body | make the connector total + fast, then delete |
| `group` (child value `by()`) | 5.9 / 12.6 (**2.14×**) | 17 | **DELETED 2026-11-19** (see §3) |

**1. Existence — `where`/`filter`/`not`/`and`/`or`.**
- *Where:* the tails' filter dispatch at a connector site — `lower.ts` `hostFilter` (1252) from `elementTail`/
  `scalarTail`/`propertyTail`, the scan fusion in `lowerChainFrom` (the `correlatedChild` test at 5267), and
  `aliasWhere`'s traversal leg (`lower.ts:6519-6619`); the route body is `lower/filter.ts` `sourceFilter`'s nested
  `where`/`filter`/`not` (588-610) and `and`/`or` (633-652) clauses, `childPredicate` (256-301),
  `selectRerootSubject` (302-353), `correlatedExists` (43-105).
- *Shapes (ms 1k/8k, ladder vs connector):* where(count.is) 3.0/20.8 vs 3.0/23.8 (1.14×) · nested where ×3 4.0/32.4
  vs 4.1/33.9 (1.05) · not(out.has) 2.4/19.4 vs 2.5/18.8 (0.97) · where(out.out) 3.5/27.8 vs 3.6/28.0 (1.01) ·
  as.where(out.has) 3.5/28.7 vs 3.6/29.1 (1.01) · where(simplePath) 5.9/46.8 vs 6.0/47.1 (1.01) ·
  and(out,in) 0.3/2.5 vs 0.3/2.4 (0.98) · or(out.has,in) 0.8/7.1 vs 0.8/7.1 (0.99). **Within the bar.**
- *Lines only it uses:* ~55 — `selectRerootSubject` and `childPredicate`'s `readsScopeValue` re-root (filter.ts),
  `comparableTheta` (predicate.ts 641-663), `classifyWhereLeg` (match.ts 616-619), the scan fusion. Everything else in
  the route is SHARED: `sourceFilter`'s connective clauses, `childPredicate` and `correlatedExists` build every
  `choose`/`repeat`/`coalesce` condition and the connector's own `childSeam.predicate`.
- *`return null` it owns:* 5 (`selectRerootSubject`); the 8 in the shared clauses stay with them.
- *Queries only it answers (28):* 27 H2 of ONE shape — an existence body holding `project(…).by(<path read>)`
  (`not(has('age',lt(1)).project('a','b').by(identity()).by(cyclicPath().hasId(4)))` under nine hosts), because the
  connector cannot lower `project().by(path())` inside a nested body (`where(project('b').by(path()))` declines); and
  1 L1, the alias-compare `where("a", P.lt("b").or(P.gt("c")).and(P.neq("d"))).by("age").by("weight").by(__.in("created").values("age").min())`.
  Outside the pools: a drawing body (`where(out().sample(1))`; the connector refuses draws, `ladderOwns`).
- *Recommendation:* **make the connector total, then delete** — lower `project().by(<path read>)` inside a nested
  body, give the alias-compare `where(a, P).by(<traversal>)` a row; the dispatch entries then go.

**2. Per-traverser — `map`/`flatMap`/`local`.** The largest deletable route.
- *Where:* `lower/reduction.ts` `perTraverserChild` (283-339), `flatMapRejoin` (494-605), `localDrawsPerRow`
  (606-611), `atMostOnePerTraverser` (439-490), `bodyScopesPerOrigin`/`nestedHostScopes`/the `PER_ORIGIN_*` sets
  (366-437), `nestRowOrigin` (707-709), `originMajor` (742-752); dispatched from `scalarTail` (`lower.ts:2185`) and
  `elementTail` (`lower.ts:5625`).
- *Shapes:* map(values) 0.8/6.5 vs 0.9/6.8 (1.04) · out.map(values) 2.2/17.8 vs 2.4/20.0 (1.12) · map(out.values)
  1.02 · map(out.count) 0.96 · local(out.count) 0.99 · local(both.dedup) 1.03 · local(out.limit) 0.88 ·
  **flatMap(out.out) 0.9/8.3 vs 1.2/10.6 (1.29×)** · local(choose.option.fold) 8.1/59.7 vs ✗ (the connector declines).
- *Lines only it uses (measured by deleting it):* ~360 net in `reduction.ts` plus the two dispatch sites.
- *`return null` it owns:* 13 (12 in `reduction.ts`, 1 in `lower.ts`).
- *Queries only it answers:* 9 in the pools — 4 L1 `map|local(choose(values('age')).option(…, values('name').fold())…)`
  (a VARIANT payload the rejoin refuses), 1 L1 `local(properties('location').order().by(T.value).range(0,2)).value()`
  (a PROPERTY payload), 1 L1 `match(…, as('a').map(inE('followedBy').values('weight').mean()).as('b'), …)` (the
  map's value keeps the reducer's `result` marker, which a `match` binding refuses), 3 H2
  `id().union(map|flatMap|local(sum()), identity())` (the same marker, refused by the arm meet). Outside the pools —
  which exclude random draws — **every body that re-sources or draws**: `map(V().count())`,
  `flatMap(V().hasLabel('software'))`, `local(V().has('age',gt(30)).values('name'))`, `local(out().sample(1))`,
  `flatMap(out().sample(1))`, `local(V().sample(1))`. The connector refuses those bodies by design (`ladderOwns`).
- *Measured and NOT landed* (each closed its gap and broke a pinned fact): rejoining a property/variant payload
  (closes 5; raises `sql-hygiene` `local`/`map` 7.5 KB → 12.7 KB and is 1.15× slower on local(choose.option.fold));
  shedding the reducer's marker on an emitted value (closes 4; loses `property(k, local(values('age').sum()))`'s
  stored type); letting the connector take a re-source body (answers six `@Unsupported` L4 scenarios and two WRONG —
  `map(V().choose(hasLabel('person'), values('age'), constant(null)).order().limit(1))` answered six nulls for `[]`);
  draws through the decorrelated rejoin (independent per scope under `local`/`flatMap`, a SHARED draw under `map`'s
  correlated form); splicing a barrier-free `local`/`flatMap` body into the chain (flatMap(out.out) → 9.5 ms, 1.14×,
  but `passes.exec.test.ts` pins "a body that MOVES … is left alone").
- *Recommendation:* **make the connector total and fast for this shape, then delete** — re-source and draw bodies
  (the `ladderOwns` refusal, with the reference's answer for a re-source under a maybe-absent value), variant/property
  payloads, the emitted value's marker, and a transparent body inlined.

**3. `group` with a child value `by()` — the keyed pool.**
- *Where:* `map.ts` the pooled arm of `groupRows` (417-499), `groupReduced` (913-1086), `groupCollected`
  (1087-1195), `dedupGroupMembers` (1196-1223), `mapOfGroupsPerOrigin` (806-823), `POOLED_RECIPE` (694); `reducer.ts`
  `screenedByTag`/`exactTail`/`mixedRefused` (121-280, the typed reduction they feed).
- *Shapes:* **group.by(label).by(count) 0.9/5.9 vs 1.5/12.6 (2.14×)** · **group.by(name).by(tail) 9.0/71.0 vs
  13.0/101.8 (1.43×)** · group.by(name).by(both.count) 0.84 · group.by(label).by(fold) 0.86.
- *Lines only it uses:* ~200 (map.ts 913-1223 and the pooled arm; coverage shows none of it under the connector).
- *`return null` it owns:* 21 (16 in 913-1223, 5 in the pooled arm).
- *Queries only it answers (17):* 13 keyed side-effect `group("a").by(…).by(<child>).cap("a")` (12 L1, 1 L6 —
  `byValues` leaves a keyed group to the host), 2 `group().by(<child key>).by(constant(1))`, 2 L6 nested groups
  (`group().by('name').by(in('created').group().by('name').by(values('age')))`,
  `project('name','skills').by('name').by(outE('uses').group().by(inV().values('name')).by(values('skill')))`).
- *Recommendation:* **keep**; to delete it, make `pooledGroup`'s count/tail plans a plain GROUP BY (they pool through
  a scope today) and give the keyed side-effect form a connector row.
- **DELETED (2026-11-19).** R5.2/R5.3/R5.4 and the pooled keyed group took its ladder-only answers to 0 (wide
  ladder-reach sample: L1/L6/H1/H2 group 0, `differ` empty); `group` joined `LADDERLESS` over element and scalar
  hosts, every form. Owner Q3a margins accepted: 8k ladder/connector `by(label).by(count)` 6.0/8.7 ms (1.46×),
  `by('name').by(tail)` 72.0/96.1 (1.33×). Nothing above became dead: the pooled arm of `groupRows` and
  `groupReduced`/`groupCollected` still serve the PROPERTY host (`g.V().properties().group().by(key).by(count())`),
  whose framing is outside `LADDERLESS`.

### Phase 4 — Structured values across scope. IDs `cc4-*`.

Sequence this with typed-value carrier T1–T5, because the carrier is what crosses the scope as a column (S5).
- Path as a value: `path().count(local)`, `path().unfold()`, `path().order()`/`group()` (outstanding-work §3 "Path as a value").
- Nested `project` inside `by()`.
- A collection value from an arm (`coalesce(fold, constant([]))`).
- `map(fold()).where(count(local)…)`.
- `sideEffect(aggregate).cap()`.

Each of these should FALL OUT of S4 and S5. Any that does not is a finding against the design. Record it.

### Phase 5 — Long tail by reach. IDs `cc5-*`.

- Work the cc1 clusters that are class (b), in workload-reach order.
- L3 stops being the headline metric. Its residue is worked only where a workload query or a cluster points at it.

## 4. Metrics — reported together, every round

| Metric | Source | Direction |
|---|---|---|
| Execute % by child-nesting depth (both profiles) | `mise run coverage` | up, and flatter |
| Host-closure rate per host | cc0-host-law | → 100% |
| Workload pass % | `test/L6-workload` | up |
| L3 passing | `l3-state.json` | non-decreasing |
| `return null` sites in `src/compiler/rel/` | grep count, recorded in the baseline | down after Phase 3 |
| Wrong answers / internal errors | L5 differential + laws, census | 0, always |
| Common-shape latency at 1k/8k | scaling probe | no regression |

## 5. Cost discipline (inherited)

These shapes must not get slower:
- `order().by(select('a'))`
- `project('x').by('age')`
- `map(values('age'))`
- `where(out().count().is(gt(1)))`
- `dedup().by('name')`
- `project … coalesce`

The `correlatedChild` fast path exists to guarantee this. `sql-hygiene` may only go down; a rise must name the
answer it buys.

## 6. Decisions for the owner

1. ~~The workload goldens source~~. Decided 2026-11-16: TinkerGraph, generated once offline (cc0-workload).
2. **G1 and G2**, as stated above. Both are measured, not argued.
