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

### Phase 3 — Build out and invert. IDs `cc3-*`.

1. The remaining connector rows from §2's table, one commit per host. Each one: L4 scenarios citing the reference step, plus the curve delta in the commit message.
2. The nested scope stack (S2) end to end. It closes §3.8's residue and §0's "a correlated body that is a relation of its own" (the tree-Plan promotion, which `outstanding-work.md` cites as a prerequisite in four places).
3. **Inversion.** The general path becomes the semantic authority. `correlatedChild` stays a switch, under L5's per-switch sweep.
4. **Ladder deletion.** Delete a route wherever its plan is no faster than the general one. Track the `return null` count; the target is a large reduction, not zero.

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
