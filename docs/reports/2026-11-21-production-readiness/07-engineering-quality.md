# 07 — Engineering quality audit

**Date:** 2026-11-21. **Scope:** audit items 1, 2, 3 and 6 from the external review, plus coupling,
duplicated logic and error handling. **Method:** read-only code analysis at trunk `HEAD`. No suite was run.
Counts come from `grep`, `jq` and `git log`. A count marked *(keyword count)* is approximate.

**Related documents.** Open defects and debt: `docs/outstanding-work.md`. User-visible differences:
`docs/limitations.md`. Step support: `docs/feature-support-matrix.md`. New quality mechanisms that this
audit proposes: `docs/2026-11-21-engineering-quality-plan.md`.

## Summary (Reference)

| # | Audit question | Verdict | Status |
|---|---|---|---|
| 1 | Is RelIR a coherent, typed IR without per-step special cases? | **strong** | exists |
| 2 | Are transformations semantics-preserving (multiplicity, order, paths, nulls, side effects)? | **adequate** | partial |
| 3 | Are query semantics and SQLite-specific lowering separate? | **adequate** | partial |
| 6 | Are there differential, fuzz and property-based tests beyond the official corpus? | **strong** | exists |
| — | Coupling | **adequate** | partial |
| — | Duplicated logic | **weak** | partial |
| — | Error handling consistency | **adequate** | partial |

The reviewer's main concern is item 2. The code answers the *structural* half of that concern with an
always-on checker. The *semantic* half — "this rewrite keeps the same answer" — depends on tests, not on
a proof. Section 2 gives the details.

---

## 1. Relational algebra representation

**Question.** Is RelIR a coherent, typed IR, or does it carry special-case state for individual Gremlin
steps?

### Explanation

RelIR is the relational algebra that sits between the Gremlin step chain and SQL. The pipeline is
`parse → runPasses → analyze → lower to RelIR → emit` (`src/compiler/CLAUDE.md:6`). The lowering
(`src/compiler/rel/`) knows Gremlin. The algebra (`src/rel/`) does not.

The node set is a closed TypeScript union. A node is "branded": only the factory functions can create
one (`src/rel/rel.ts:52-63`). The checker refuses an unbranded node (`src/rel/check.ts:234`). Each node
carries two facts: its column types and its carried channels (`src/rel/types.ts:127-130`). A *channel* is
a column that holds per-traverser state, for example `bulk` or `path`. A channel has a *role* from a closed
list of 10 (`src/channels.ts:39`).

Per-node laws use `Record<RelKind, …>` tables. A new node kind does not compile until it declares its
laws. Three tables enforce this: `EXPR_SCOPE` (`src/rel/check.ts:147`), `STRUCTURE`
(`src/rel/check.ts:184`) and `CHANNEL_OBLIGATION` (`src/rel/obligations.ts:105`).

### Evidence (Reference)

| Fact | Value | Evidence |
|---|---|---|
| Relation node kinds | 16: `scan`, `values`, `self-ref`, `ref`, `project`, `filter`, `aggregate`, `sort`, `limit`, `distinct`, `window`, `explode`, `materialize`, `join`, `union`, `recursive` | `src/rel/rel.ts:11-50` |
| Expression kinds | 16: `agg`, `binary`, `call`, `case`, `cast`, `col`, `exists`, `in-list`, `in-query`, `json-array`, `json-object`, `lit`, `row`, `scalar`, `unary`, `window-expr` | `src/rel/expr.ts` |
| Statement kinds | 3: `insert`, `update`, `delete` | `src/rel/stmt.ts:18-27` |
| Imports from `src/compiler/` or `src/gremlin/` into `src/rel/` | 0 | `grep` of `src/rel/**` |
| Gremlin step-name comparisons in `src/rel/` | 0 (the 11 `.name === '…'` hits are storage column names `id`, `uid`, `value`) | `src/rel/lineage.ts:66`, `src/rel/passes/semijoin.ts:391` |
| Size of `src/rel/` | 9,055 lines | `wc -l` |
| "Node set closed" claim | stated as landed law | `docs/archive/2026-08-01-relir-build-plan.md` (archived, per root `CLAUDE.md`) |

Three node fields state physical facts, not algebra. Each has a written, measured reason:

| Field | Purpose | Evidence |
|---|---|---|
| `materialize.fenced` | Renders `AS MATERIALIZED` to stop a SQLite bug that drops an `OFFSET` | `src/rel/rel.ts:32-39` |
| `join.ordered` | Pins the left side as the outer loop (measured 1,492 ms vs 0.3 ms) | `src/rel/rel.ts:40-48` |
| `ref.bounds` | Row bounds of a hoisted binding, so `rowBounds` stays stable across a cut | `src/rel/rel.ts:15-18` |

### Weaknesses

- **`call.fn` is an open `string`** (`src/rel/expr.ts:19`). The lowering uses 43 distinct SQL function
  names (*keyword count* of `fn: '…'` and `call('…')`). The type system cannot check a name or an arity.
  A typo fails only when SQLite runs the statement.
- **The Gremlin-specific complexity lives in the lowering, and it is large.** `src/compiler/rel/` holds
  45,872 lines. `lower.ts` alone is 7,094 lines and `write.ts` is 6,652 lines. The lowering has 438
  step-name comparisons over 101 distinct step names. It also has 1,242 `return null` decline sites
  (`scripts/ladder-baseline.json`). This is the expected place for per-step logic. The size is the risk.
- **The layering rule is not gated by a tool.** `src/rel/obligations.ts:19` states that `src/rel/`
  imports nothing from `src/compiler/`. That is true today. No CI gate checks it
  (`scripts/arch-check.ts` checks only the Pass role rules). See the plan, item Q1.

### Verdict

**strong.** The IR is small, closed, typed and free of Gremlin step names. Residual risk: the open
`call.fn` string, and the size of the lowering above the IR.

---

## 2. Compiler invariants

**Question.** Are transformations semantics-preserving? The reviewer names multiplicity (bulk and
`UNION ALL`), ordering, paths, nulls and side effects. This is the reviewer's main concern.

### Explanation — where the checks run

`checkPlan` (`src/rel/check.ts:315`) checks the whole program. It runs on **every** compile, in
production, inside `emitProgram` (`src/rel/emit.ts:1376`). It is not test-only. The compile path calls
it exactly once, through `renderLowered` (`src/compiler/rel/lower.ts:4420`).

The checker runs **after** the physical passes. The pass pipeline is
`fuseAll → leadingAll → magicAll → dropUnreadJoins → semijoinAll → name`
(`src/compiler/rel/lower.ts:4372-4377`). So each pass output is checked for structure before SQL is
produced.

A checker failure is a plain `Error` with the prefix `RelIR:`. Only `BindBudgetExceeded`
(`src/rel/check.ts:24`) is caught and turned into a decline (`src/compiler/rel/lower.ts:4420-4423`). All
other violations escape as bugs, by design (`src/rel/check.ts:14-23`).

Some laws also run at construction time, in the factory: `values`, `project`, `aggregate`, `window`,
`join`, `union` and `recursive` (`src/rel/factory.ts:28-89`).

### Explanation — what the checks prove

The checker proves **structure**, not equivalence. It proves that a plan is well-formed and that every
carried channel survives each node by a declared rule. It does not prove that a rewrite returns the same
rows as the plan before the rewrite. That second property depends on tests (section 6).

### Evidence per concern (Reference)

| Concern | Checked law (always on) | Evidence | Tests that target it |
|---|---|---|---|
| **Multiplicity** | A grouped `Aggregate` may carry channels only if every role has a `combine` policy. `bulk` and `encounter` combine; the other 8 roles do not. | `src/rel/obligations.ts:167-177`, `src/channels.ts:178-194` | `test/rel.test.ts:104` "a GROUPED Aggregate may carry channels through, but only roles a grouping can combine" |
| Multiplicity | A whole-row `Distinct` may not carry a row-unique channel (it would collapse nothing). | `src/rel/obligations.ts:133-139`, `src/channels.ts:222-238` | `test/rel.test.ts:414` |
| Multiplicity | A barrier `Aggregate` drops all per-row channels. | `src/rel/obligations.ts:171` | `test/rel.test.ts:93` |
| Multiplicity | A `Union` must merge its inputs' channels. | `src/rel/obligations.ts:179-185` | `test/rel.test.ts:741` |
| Multiplicity | *Positional* decision: may a movement collapse into `SUM(bulk)` here? | `src/compiler/ir/bulk.ts:5-60` — an **analysis**, not a checker | `test/compiler/one-row-one-traverser.exec.test.ts` (11 tests), `test/L4-addendum/bulk-repeat-multiplicity.feature` |
| **Ordering** | A linear `json_group_array` over an input that carries `encounter` must `ORDER BY` that column. | `src/rel/obligations.ts:75-104` (probed: 168 linear folds satisfy it, 0 violate) | `test/rel.test.ts:129`, `test/rel.test.ts:152` |
| Ordering | Every other order (after `order()`, `tail()`, `path()`, branch arms) | **not checked statically**; checked at run time by L8 (reverse scan order) | `test/compiler/meaningful-order.exec.test.ts` (8 tests, the L8 keep-list) |
| **Paths** | `path` has the `undefined` group policy, so no grouping can carry it. | `src/channels.ts:182` | `test/rel.test.ts:104` |
| Paths | A `left` join may not carry a rigid channel from its nullable right side. | `src/rel/obligations.ts:195-202` | `test/rel.test.ts:680` |
| Paths | A `Recursive` seed and step carry identical channels. | `src/rel/obligations.ts:207-212` | `test/rel.test.ts:173-351` |
| **Nulls** | A `left` join declares every right-side column nullable. | `src/rel/check.ts:215-216` | `test/rel.test.ts:692` |
| Nulls | Positional type equality includes nullability. | `src/rel/types.ts:82-86` | `test/rel.test.ts` |
| Nulls | A bare column in `Aggregate.aggs` that is not a group key is refused (SQLite would return an arbitrary row). | `src/rel/check.ts:41-50`, `src/rel/check.ts:117-119` | `test/rel.test.ts:435` |
| **Side effects** | In a program with writes, a CTE that more than one step reads must be a snapshot. | `src/rel/check.ts:326-371` | `test/snapshot-writes.exec.test.ts` (5 tests), `test/compiler/writes.exec.test.ts` (63 tests) |
| Side effects | A `Ref` resolves only backwards, so execution order equals checked order. | `src/rel/check.ts:310-324` | `test/stmt.test.ts` (10 tests) |

Test counts by concern, across all `test()` names and L4 scenario names *(keyword count)*:

| Concern | `test()` names | L4 scenarios |
|---|---|---|
| Multiplicity (`bulk`, `multiset`, `duplicate`, `self-loop`) | 69 | 3 |
| Ordering (`order`, `encounter`, `emission`) | 183 | 177 |
| Paths (`path`, `simplePath`, `cyclic`) | 133 | 71 |
| Nulls (`null`, `absent`, `productive`) | 114 | 127 |
| Side effects (`side effect`, `aggregate(`, `snapshot`, `drop`, `write`, `cap(`) | 208 | 95 |

### Weaknesses

- **No equivalence check for most physical passes.** `fuse`, `leading`, `magic` and `dropUnreadJoins`
  always run. No switch turns them off, so no differential compares "pass on" with "pass off". The L5
  differential covers only the 7 `FastPathConfig` switches (`src/compiler/options/fast-paths.ts:102-110`),
  which include the two `semijoin` strategies. `fuse` calls itself the "SEMANTIC tier"
  (`src/rel/passes/fuse.ts:13`) and carries a written soundness argument, but no differential. Unit tests
  exist: `test/rel-fuse.test.ts` (12), `test/rel-leading.test.ts` (5). See the plan, item Q2.
- **Ordering is checked statically only for linear collecting aggregates.** A `Sort` that a later node
  needs is pinned only by the L8 run-time perturbation. L8 is a strong gate, but it only sees orders that
  a test asserts.
- **Multiplicity has no checked "reads rows vs reads traversers" law.** `src/compiler/ir/bulk.ts` decides
  where a collapse is safe. Its default is safe (`'reads-rows'`, `src/compiler/ir/bulk.ts:75-89`), so an
  unknown step costs performance, not an answer. The decision is still not re-checked on the plan.
- **A set `Union` (`all: false`) has no channel law.** `Distinct` refuses a row-unique channel, but a
  `Union` with `all: false` does not. Today there is one such site and it carries no channels
  (`src/compiler/rel/write.ts:3307`). The gap is latent, not active (inferred). See the plan, item Q1.
- **History.** The obligations file states that 33% of diagnosed defects were "a carried field dropped at a
  barrier, merge or rejoin" (`src/rel/obligations.ts:12-14`). The channel laws exist because of that
  class. `docs/outstanding-work.md` §1 lists 33 open wrong-answer items. One of them is a channel drop:
  `write-input-channels` ("Writes drop `sack`/`path` channels").

### Verdict

**adequate.** The structural invariants are strong, total over the node set and always on. Semantic
preservation of each rewrite is tested, not proved, and 4 physical passes have no on/off differential.

---

## 3. SQL generation

**Question.** Is there a clean separation between query semantics and SQLite-specific lowering?

### Explanation

There are three layers:

| Layer | Role | Files |
|---|---|---|
| Lowering | Gremlin steps → RelIR | `src/compiler/rel/**` (45,872 lines) |
| Emitter | RelIR → SQL `Expression` tree; SQLite flattening, alias, ordinal and literal rules | `src/rel/emit.ts` (1,387 lines) |
| Kernel | SQL template rendering, bind numbering, fail-closed column access | `src/sql/kernel/{q,render,budget}.ts` |

The lowering does not write SQL text. Its imports from `src/sql/kernel/` are only types and static-type
metadata (`ScalarType`, `ListOf`, `MapOf`, `STATIC`, `PER_ROW`) and `pastBudget`. Only `src/rel/emit.ts`
turns RelIR into SQL text (`src/rel/emit.ts:309`, `assembler`).

The emitter holds SQLite rules in one place. Examples: the flattener's rule for `OFFSET`
(`src/rel/emit.ts:669`), the 64-table join limit (`src/rel/emit.ts:278-296`), integer ordinals in
`ORDER BY` (`src/rel/emit.ts:462-465`), and `NaN`/`Inf` literals (`src/rel/emit.ts:506-510`).

### Where SQLite-specific constructs appear (Reference)

| Construct | Where it is decided | Layer |
|---|---|---|
| `json_each` | The `explode` node is `json_each` by definition | IR (`src/rel/rel.ts:26-31`) |
| `WITH RECURSIVE` | The `recursive` node; SQLite's recursive-term laws in `recursiveViolation` | IR + emitter (`src/rel/recursive.ts`) |
| `AS MATERIALIZED` | `materialize.fenced` | IR flag (`src/rel/rel.ts:32-39`) |
| Join order pin | `join.ordered` | IR flag (`src/rel/rel.ts:40-48`) |
| `json_*`, `jsonb_*`, `printf`, `glob`, `typeof`, `unixepoch` | `call.fn` strings, chosen by the lowering | IR content |
| 100-bind cap | `DO_BIND_CAP`, `bindCount` | checker (`src/rel/check.ts:12`, `src/rel/check.ts:80`) |

### Weaknesses

- **RelIR is a SQLite dialect, not an engine-neutral algebra.** The lowering picks SQLite function names
  directly (43 names). A second SQL engine would need a translation table for `call.fn`, `explode` and
  the two physical flags. This is a deliberate single-target choice (root `CLAUDE.md`, decision 3), not a
  defect. It is a cost only if a second engine is ever a goal.
- **`src/sql/CLAUDE.md` is stale.** It cites deleted paths: `compiler/steps/context/context.ts`
  (`src/sql/CLAUDE.md:20`) and `compiler/steps/tail/correlated.ts` (`src/sql/CLAUDE.md:29`). The
  directory `src/compiler/steps/` does not exist.

### Verdict

**adequate.** The code layers are clean: the lowering builds algebra, one emitter writes SQL. The
algebra's vocabulary is SQLite's. Residual risk: function-name typos are found at execution time, not at
compile time.

---

## 6. Testing beyond the official corpus

**Question.** Are there independent differential, fuzz and property-based tests beyond the official
conformance corpus?

### Explanation

The ladder has 9 rungs. L3 is the official TinkerPop corpus. The other rungs are independent of it. Three
of them use inputs that nobody wrote down (L5, L8, `rel-sweep`). One uses an independent reference engine
(L6 goldens from TinkerGraph).

### The ladder (Reference)

Total: 271 `*.test.ts` files, 3,278 `test()`/`it()` call sites (*keyword count*; `test.each` expands
further). Test code: 54,605 lines. Source code: 84,701 lines.

| Rung | What it checks | Oracle | Size today | Gate |
|---|---|---|---|---|
| L1 | Parse + step chain over the corpus | grammar | 2,395 traversals (`test/L1-corpus/corpus.txt`) | 100% |
| L2 | Compile-to-SQL contract, per step family | snapshot (semantic, not byte) | 28 files, 229 tests | all pass |
| L3 | Official cucumber suite over GraphBinary | TinkerPop expected values | 2,065 / 2,270 pass (`test/L3-conformance/l3-state.json`) | hard ratchet; every failure ledgered in `expected-outcomes.ts` |
| L4 | Our Gherkin addendum | reference-derived values | 167 features, 1,799 scenarios, 212 tagged `@Unsupported` | all pass; `@Unsupported` must refuse |
| L5 | Generated well-typed traversals | fast-path differential; 16 metamorphic laws (`test/L5-properties/laws.ts`); fail-closed capability ratchet | seed derived from `HEAD` (`test/L5-properties/seed.ts`); `KNOWN` is empty (`test/L5-properties/known.ts:79`) | ratchet |
| L6 | ~312 app-shaped queries | goldens generated once from TinkerGraph (docker, offline) | 305 pass, 0 wrong, 7 declined (`test/L6-workload/baseline.json`) | ratchet; a wrong answer needs a written reason |
| L7 (census) | Did any answer change? | committed result digests | 1,719 ran, 7 nondet, 294 deferred, 375 unbound, 0 crashed | no answer change; crash count may not grow |
| L8 | The whole suite under `PRAGMA reverse_unordered_selects` | perturbation | every bracket | zero failures, no ignore list |
| L9 | Nesting stays on the scoped-relation connector | host-closure ratchet; host totality | 5 baseline cells, 12 deferred hosts | ratchet |
| `rel-sweep` | `lowerToRel` returns a plan or `null`, never throws | contract | every corpus prefix × 3 chain shapes | zero violations |
| `sql-plan` | `EXPLAIN QUERY PLAN` shape | plan classifier | corpus reads | ratchet |

Unit tests for the algebra: `test/rel.test.ts` (47), `test/rel-fuse.test.ts` (12),
`test/rel-lineage.test.ts` (8), `test/rel-leading.test.ts` (5), `test/stmt.test.ts` (10).
Compiler execution tests: `test/compiler/` has 124 files and about 1,608 tests.

### Weaknesses

- **No reference-engine differential on generated inputs.** L5's oracles compare our engine with itself
  (two configurations, or two sides of a law). A defect that both sides share and that no law covers is
  invisible (`docs/property-based-testing-l5.md`, "The blind spot"). A JVM differential was rejected for
  CI cost. L6 uses TinkerGraph goldens, but its 312 queries are fixed. See the plan, item Q4.
- **Test documentation is out of date.** These numbers in `test/CLAUDE.md` do not match the artifacts:

  | Claim | Location | Artifact today |
  |---|---|---|
  | L1 has 2,298 traversals | `test/CLAUDE.md:50` | 2,395 lines |
  | 149 `@Unsupported` scenarios | `test/CLAUDE.md:81` | 212 tags |
  | L5 seed pinned at 42 | `test/CLAUDE.md:108-109` | derived from `HEAD` |
  | Census has 17 `crashed` rows | `test/CLAUDE.md:176`, `test/L7-census/README.md:47` | 0 |
  | "all-six-off" fast paths | `test/CLAUDE.md:102` | 7 switches |

  The census gate text says "three crashes exist today" (`test/L7-census/census.test.ts:62`). The gate
  itself reads the baseline, so it behaves correctly; only the prose is wrong.

### Verdict

**strong.** The suite has property-based generation, metamorphic laws, a perturbation rung, a behavioural
census and an offline reference-engine golden set. Residual risk: no generated-input comparison against
an independent engine.

---

## Other quality concerns

### Coupling (Explanation + Reference)

Five static gates run in `mise run ci` (`mise.toml:561-577`):

| Gate | Checks | Evidence |
|---|---|---|
| `arch` | No Pass reaches `ChainFacts` or the fast-path layer (LSP call hierarchy, transitive) | `scripts/arch-check.ts:1-28` |
| `lint` | Unused locals, parameters and type imports | `scripts/lint.ts` |
| `binds` | No hand-rolled `?` list sized by row count | `scripts/binds-check.ts` |
| `ladder` | `return null` count in `src/compiler/rel/` never rises (1,242 today) | `scripts/ladder-check.ts`, `scripts/ladder-baseline.json` |
| `sql-hygiene` | Literal provenance; DO SQL limits | `scripts/sql-hygiene.ts` |

Coupling inside the lowering is high by design. The `lower/` family uses function-level import cycles
(`src/compiler/CLAUDE.md:45-47`). The rule "a clean DAG at the family boundary" is stated but not gated.

**Verdict: adequate.** The Pass rules are gated at zero. Layer direction (`src/rel/` ↛ `src/compiler/`) is
true but not gated.

### Duplicated logic (Explanation)

- `docs/outstanding-work.md` holds 43 items whose titles name duplication ("one …", "twice", "reuse",
  "hand-rolled"). Examples: `rf3-reuse2` (hand-rolled `json_each` membership subqueries),
  `path-position-projection` (dispatch built twice), `members-everywhere`.
- The local helper `const call = (fn, ...args) => ({ kind: 'call', fn, args })` is defined 5 times:
  `src/compiler/rel/transform.ts:82`, `tag.ts:37`, `sack.ts:84`, `reducer.ts:48`, `write.ts:3986`.
- The project already has the tools to find duplication (`bun scripts/refs.ts`, `mise run orphans`).
  Duplication is tracked, not hidden.

**Verdict: weak.** The debt is known and indexed, but it is large. Some of it causes wrong answers today
(`rf3-reuse1`, `rf3-reuse3` are in `docs/outstanding-work.md` §1).

### Error handling consistency (Explanation + Reference)

The user-facing error surface has 3 typed classes (`test/error-surface.test.ts:1-6`):

| Class | Meaning | Evidence |
|---|---|---|
| `UnsupportedTraversal` | A clear decline; prefix from a closed `DeclineKind` table of 15 kinds | `src/compiler/unsupported.ts:9-89` |
| `ValueParseError` | The reference's own error, decided from the query text | `src/gremlin/coerce.ts` |
| `RaisedByQuery` | An error that the data decided | `src/rel/raise.ts` |

Mechanisms that keep a bare `Error` away from users:

- `rel-sweep`: the lowering must never throw over any corpus prefix (`scripts/rel-sweep.ts:1-35`).
- Census: the `crashed` count may not grow; it is 0 today (`test/L7-census/census.test.ts:59-67`).
- L5 capability ratchet: no new raw failure over generated traversals
  (`test/L5-properties/capability-baseline.ts:13`, empty).

Weaknesses:

- **The wire boundary does not classify errors.** `runQuery` sends every error message the same way,
  typed or not (`src/router.ts:116-119`). `errorResponse` always uses status 500 in the trailer
  (`src/http.ts:49-52`). A user cannot tell a decline from an internal bug, except by the message text.
- **An internal bug is not logged.** The default `QueryLogger` is silent (root `CLAUDE.md`, "A query
  failure is not a crash"). This is correct for a decline. It also hides an internal error, for example a
  `RelIR:` checker violation.
- **195 `throw new Error(` sites exist in `src/`**, 84 of them in `src/rel/`. Most are internal
  assertions. Recent history shows one reached a user: commit "fix: a named collection read inside a
  connector body no longer throws a bare RelIR error". `docs/outstanding-work.md` §1 lists two more:
  `graphson-binary-bare-error` and `rf3-bulk-dup-uid`.

See the plan, item Q3.

**Verdict: adequate.** The typed surface is clear and tested. The guarantee depends on test coverage,
not on a boundary that classifies errors.

### Churn signals (Reference)

| Signal | Value | Source |
|---|---|---|
| Commits since 2026-10-21 | 590 (of 3,089 total) | `git log` |
| Of those, `docs` / `fix` / `test` / `feat` / `perf` / `refactor` | 260 / 43 / 21 / 11 / 6 / 5 | subject prefixes |
| Commits with "revert" | 7 | `git log` |
| Most-changed source files | `src/compiler/rel/lower.ts` (100 commits), `lower/reduction.ts` (75), `lower/scoped.ts` (64), `write.ts` (37) | `git log --name-only` |
| Changes to `src/rel/emit.ts` | 24 | `git log --name-only` |

Inference (not measured): churn concentrates in the lowering, not in the algebra or the emitter. This is
consistent with a stable IR and an active lowering.

---

## Documentation drift found during this audit (Reference)

| Claim | Location | Code today |
|---|---|---|
| `feature-support-matrix.md` §17 lists deliberate divergences | root `CLAUDE.md` | §17 is "Not supported yet: rare combinations"; divergences are in `docs/limitations.md` §3 |
| Two fast paths survive | `src/compiler/CLAUDE.md:59` | 7 switches in `DEFAULT_FAST_PATHS` (`src/compiler/options/fast-paths.ts:102-110`) |
| Deleted `compiler/steps/**` paths | `src/sql/CLAUDE.md:20`, `src/sql/CLAUDE.md:29` | directory does not exist |
| Test counts | `test/CLAUDE.md` (table in section 6) | see section 6 |

## Glossary

| Term | Meaning |
|---|---|
| RelIR | The relational algebra between the Gremlin step chain and SQL (`src/rel/`). |
| Lowering | The translation from Gremlin steps to RelIR (`src/compiler/rel/`). |
| Channel | A column that carries per-traverser state; each has one of 10 roles (`src/channels.ts:39`). |
| Obligation | A per-node-kind law about channels, checked on every compile (`src/rel/obligations.ts`). |
| Bulk | The number of identical traversers that one row stands for. |
| Encounter | A minted column that records emission order. |
| Collapse | Replacing N rows of one element with one row whose `bulk` is N. |
| Physical pass | A RelIR → RelIR rewrite after lowering (`src/rel/passes/`). |
| Decline | A clean refusal, raised as `UnsupportedTraversal`. |
| Differential | A test that compares two configurations of the same engine. |
| Metamorphic law | A pair of queries that must return the same multiset. |
| Perturbation (L8) | Re-running the suite with SQLite's unordered scans reversed. |
