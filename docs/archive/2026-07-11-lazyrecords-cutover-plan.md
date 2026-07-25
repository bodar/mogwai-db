# compiler.ts → lazyrecords cutover + 3-seam decomposition

**Self-contained handoff. Read `CLAUDE.md` first (project law), then this.**

> ⚠️ **SQL-BUILD APPROACH SUPERSEDED (2026-07-12).** The compiler no longer builds SQL
> from lazyrecords *ansi builders* (`select`/`from`/`join`/`comparison`/…) or a `render()`
> node adapter. It now uses a **template-first `q` kernel + typed `Relation` handles** —
> see `docs/2026-07-12-q-kernel-sql-builder.md` (the current SQL-build design). Seam 1 (SQL
> AST) is DONE and folded into that kernel; all read+write bodies are `q\`\``+relations.
>
> **ALL THREE SEAMS ARE NOW DONE (2026-07-12).** Seam 2 (step-family dispatch) + Seam 3
> (normalization passes) landed as a full functional-fold decomposition: `src/strategies.ts`
> (pure `Step[]→Step[]` passes) + `src/steps/*.ts` (per-family dispatch tables) + `Query`
> kernel adoption (typed-`self` recursive CTE, minted CTE names; `CteDef`/`withPrefixTree`
> retired). `compiler.ts` is now a 51-line orchestrator. See the end-of-doc "Decomposition
> complete" note. The stages roadmap below is HISTORICAL. Treat the two sections marked
> "SUPERSEDED" (ansi API cheat-sheet + 5 node-recipe templates) as historical too — do NOT
> follow them; use `q\`\``+relations.

## Where the work lives
- Worktree: `~/Projects/mogwai-db-worktrees/lazyrecords-cutover`, branch
  `lazyrecords-cutover`. **Run all commands there** (absolute paths / `cd` in one
  compound command; don't `cd` the exploration worktree).
- Trunk flow (autonomous "remote control" mode): after each green stage —
  `git add -A && git commit`, then `mise run ci`, then fast-forward push:
  `git fetch origin trunk -q; [ "$(git rev-parse origin/trunk)" = "$(git rev-parse HEAD~1)" ] && git push origin HEAD:trunk`.
  If not FF (trunk diverged), stop and reconcile. First run in a fresh worktree
  needs `mise trust`.
- Verify commands: `bunx tsc --noEmit` (typecheck — the worklist driver),
  `bun test` (192 pass gate), `mise run ci` (= check + test + worker build).

## What this is
Turn `compiler.ts` (was 1801 lines, string-concat SQL, one flat `switch`) into a
node-built, decomposed compiler. Scope (decided): **read + write**, **all three
seams**, lazyrecords consumed **from JSR**.

The three seams:
- **Seam 1 — SQL AST.** Every `{sql,binds}` string-pair becomes a lazyrecords
  `Expression`/`Sql` node; binds ride as `Value` tokens (no `?`+parallel-array).
- **Seam 2 — step-family dispatch table.** The flat `switch(s.name)` becomes a
  `Map<stepName, StepCompiler>` of small per-family compilers.
- **Seam 3 — Step[]→Step[] normalization passes.** Inline rewrites (discard-strip,
  repeat-cluster gather, range/limit-before-vs-after-`order()`) → pure transforms.

## Dependency: @bodar/lazyrecords (DONE — from JSR)
- `package.json`: `"@bodar/lazyrecords": "npm:@jsr/bodar__lazyrecords"` (no version;
  `bun.lock` pins **`0.494.348`**), same convention as `@bodar/yadic`. Symlink dropped.
- lazyrecords source: `~/Projects/bodar.ts/packages/lazyrecords`. It **auto-publishes**
  to JSR on push to `master` (GitHub Actions runs `./run ci` → `publish()` →
  `jsr publish`; version = `0.<git rev-list --count master>.<run#>`).
- **To ship a new lazyrecords node/change:** edit in `~/Projects/bodar.ts/packages/
  lazyrecords/src`; a node is only importable by package name if its file has a
  `/** @module */` header — after adding/removing one, run `bun run.ts exports`
  (regenerates the exports map). `git commit && git push origin master`; wait for
  JSR (check: `bun -e "const j=await(await fetch('https://npm.jsr.io/@jsr/bodar__lazyrecords')).json(); console.log(j['dist-tags'].latest)"`),
  then bump mogwai (`bun install` or pin the version). NOTE: `curl` output is
  summarized by the RTK proxy (values collapse to `string`) — use `bun -e fetch`
  or `rtk proxy curl` to read registry JSON.

## lazyrecords API cheat-sheet (learned the hard way) — ⚠️ SUPERSEDED (historical)
<!-- Describes the ansi-builder API the compiler NO LONGER uses. Kept for context on the
     bind-safe core (Value/Text/statement/jsonExtract) the q kernel still reuses. For how
     SQL is actually built now, see docs/2026-07-12-q-kernel-sql-builder.md. -->

Import via `.ts` subpaths: `@bodar/lazyrecords/sql/ansi/SelectExpression.ts`, etc.
- Render boundary: `statement(sql(node))` → `{text, args}`. `statement` from
  `sql/statement/ordinalPlaceholder.ts` emits `?` placeholders; `args` = the tree's
  `Value`s in encounter order. mogwai wraps this as `render()`/`compiled()` in `render.ts`.
- `select(quantifier, selectList, from, where?)` holds **only** from + optional where.
  JOIN / GROUP BY / ORDER BY / LIMIT are **separate nodes concatenated** inside
  `sql(...)` in SQL order: `sql(select(all,[cols],from(t)), join(t2,cond), whereNode, groupBy(...), orderBy(...), limit(n,off))`.
- Predicate tails render only the operator+operand: `comparison(op,v)`→`= ?`,
  `is(v)`→`= ?`/`is null`, `like(pat,esc)`→`like ? escape ?` (escape is BOUND),
  `inExpression(vs)`/`notIn(vs)`→`in (?, ?)`, `isNull()`/`isNotNull()`. Place the
  predicand before the tail via `expression(colExpr, tail)`.
- `between(a,b)` node is inclusive-both — **do NOT use** for Gremlin `between`
  ([lo,hi)); build two `comparison`s joined with `and(...)` (see `predicateSql`).
- `text(s)`/`raw(s)` = raw **unquoted** verbatim; `qualified(q,n)`=`"q"."n"`;
  `column`/`id`=quoted. `jsonExtract(text(col), key)` renders `json_extract(n.props,'$.age')`
  **unquoted** — REQUIRED so the literal-path expression index engages (perf gate).
- `list(items, sepText)` sep must be a `Text` (e.g. `sqlText(' + ')`), not a string.
- Set ops: `unionAll(...selects)` / `union(...)` from `sql/ansi/SetOperation.ts`.
- CTEs: `cte(name, body, cols?)`, `withClause(ctes, body)`, `withRecursive(...)`,
  `valuesClause(rows)`.

## Snapshot drift (accepted)
Node renderer lowercases keywords, quotes identifiers, adds comma-spacing, binds
`escape`. Semantically identical. When a `test/compiler.test.ts` `.toContain(...)`
asserts uppercase SQL, rebaseline it (already done for the S1 ones). The perf
EXPLAIN gate and behavior are unaffected.

## Invariants (every stage ends here — never push red)
- `bun test` = **192 pass / 0 fail**; `bunx tsc --noEmit` = 0 errors; `mise run ci` green.
- `test/performance.test.ts` EXPLAIN index gate green (index-eligibility preserved).
- L3 cucumber count not regressed (was **205** at W2; behavior-preserving cutover
  shouldn't change it; re-run to confirm per `conformance/README-cucumber.md`
  — needs the tinkerpop repo + a live server on `localhost:45940`).

## Modules now (post-decomposition-so-far)
- `frontend.ts` — parse + `stepChain` + arg walkers + `Step`/`Pred` IR. Clean, done.
- `render.ts` — compile-output contract (`Compiled`/`WritePlan`/`Shape`/`MapEntry`/
  `ElemShape`/`GroupKey`/`GroupVal`) + `render()`/`compiled()` node→{sql,binds} boundary.
  `handler.ts` imports these types (re-exported from `compiler.ts` so handler is untouched;
  handler.ts has binary GraphBinary fixtures — avoid editing it).
- `plan.ts` — leaf SQL node-builders: `P_OPS`, `propExtract`, `labelIn`,
  `edgeLabelFilter`, `predicateSql`, `likePattern`, `rangeToOffsetLimit`, `dirsFor`,
  `Elem`. (The builders listed in "end-state layout" below like `filterCte`/`movementCte`
  do NOT exist yet — aspirational.)
- `compiler.ts` (1540 lines) — still holds: `compile()` orchestrator,
  `rejectUnsupportedStrategies`, the movement/filter step compilers (`traversalCtes`),
  `compileRead` + tail (projection/order/group/properties/select-project), the
  `ScalarCtx` cluster (596–795), and all write compilers (drop/inject/addV/addE/
  mergeV/mergeE/setProperty).

## Key insight — why the cutover couples (don't re-derive)
`predicateSql` needs a **node** `expr` (its binds must be `Value` tokens, not `?`
in a pre-rendered string), which forces every expr-producer (`propExtract`/`propAt`/
`compileNestedScalar`) to yield nodes → `Scalar` became `{expr,indexKey}`. BUT
`ScalarCtx`'s string fields (`idExpr:'n.id'`, `propsExpr:'n.props'`, …) are
**bind-free** SQL fragments, so they're wrapped with `sqlText()` at the leaves —
this contained the blast radius to the `Scalar` currency. Consumers that still
assemble CTE/tail SQL as strings call `render(node)` to get `{sql,binds}` at their
boundary — a **temporary adapter** that vanishes when the bodies go node-native.

## Stages
- [x] **G7** lazyrecords `@module` on 6 core nodes; exports regen. 106 pass.
- [x] **S1** leaf scalar/predicate → nodes. `predicateSql` builds tails via
  `expression()`; the 8-caller `exprBinds` double-splices GONE. `Scalar`=`{expr,indexKey}`.
  ~20 consumers `render()` at boundary. Trunk `6715529`.
- [x] **S2** label-filter splice-kill (`labelIn`/`edgeLabelFilter`, ~7 copies
  collapsed). Read prefix splice-free. Remainder (CTE bodies as node trees) folded
  into S5 (done). Trunk `6715529`.
- [x] **S3 — read tail → nodes. DONE** (trunk `3aae1f4`). `compileRead` projection
  switch, `is`-filter, order-by, `compileSelectProject`, `compileGroup`,
  `compileProperties` all build a single tail node. The `fb.push(...r.binds, ...r.binds)`
  double-pushes are GONE — the projected `json_extract` node is shared between the
  SELECT and WHERE occurrences so its binds fall out of the one render per occurrence.
- [x] **S4 — write path → nodes. DONE** (trunk `3aae1f4`). `compileDrop`/`compileSetProperty`/
  `compileAddE`/`mergeDrivers`/`resolveEndpoint` assemble their id-materialising query via
  `render(withPrefixTree(ctes, tail))`; `compileInject` fully node-built. `mergeMatchQuery`/
  `edgeMatchQuery` keep their standalone `render(propExtract(...))` (a legit `{sql,binds}`
  boundary for a run-closure, not an adapter). Imperative `INSERT`/`UPDATE` statements in
  `insertVertex`/`insertEdge` stay plain parameterised SQL (fixed statements, no splicing).
- [x] **S5 — restructure. DONE.** Extracted (each green, on trunk): `frontend.ts` `89328a7`,
  `render.ts` `cb7638d`, `plan.ts` `24851fe`.
  1. [x] Move `ScalarCtx` cluster into `plan.ts` (**S5.1**, trunk `6b8c0b3`).
  2. [x] **S5.2 — DONE.** Step compilers split into `src/steps/*.ts` behind Map
     dispatch (Seam 2). The read prefix is a functional fold (`StepFn = (step, St) => St`
     over immutable `St` in `context.ts`); per-family modules
     `movement`/`filter`/`branch`/`passthrough`, tail in `projection.ts`
     (`PROJECTORS`/`MODIFIERS` Maps + group/properties/select barriers), writes in
     `write.ts` (ordered `WRITE_RULES` table), `index.ts` = `PREFIX` Map + `buildPrefix`
     + `compileRead`. Ctx threaded as an explicit immutable object, not mutable state.
  3. [x] Node-tree the CTE bodies + tail; remove the `render()` CTE-assembly adapter
     (**S5.3**, trunk `3aae1f4`, folded into S3/S4). `withPrefixTree(ctes, tail)` is now
     ONE tree. Seam 3 also DONE — inline rewrites (discard-strip, repeat-cluster gather,
     by()-modulator fold) extracted into `src/strategies.ts` as pure `Step[]→Step[]`
     passes run once up front, so the dispatch sees a canonical peek-free chain.
- **Location note:** work moved out of the `lazyrecords-cutover` worktree into the main
  checkout `~/Projects/mogwai-db`, committed directly on `trunk`. The worktree is stale
  (all its work is on trunk) and can be `git worktree remove`d.
- [x] **S6 — publish + wire (DONE early).** lazyrecords G1–G7 committed+pushed
  (`d6618a4`), auto-published JSR `0.494.348`; mogwai wired to it, symlink dropped,
  `mise run ci` + worker build green. Remaining nicety: `wrangler deploy --dry-run`
  gzip-size sanity (was ~265 KB before).

## The 5 CTE-body templates (for S5 step 3 — node recipes) — ⚠️ SUPERSEDED (historical)
<!-- These ansi-node recipes were NOT used. CTE bodies are now built with the q`` template
     + Relation handles (see docs/2026-07-12-q-kernel-sql-builder.md and traversalCtes in
     src/compiler.ts). Kept only to record what the 5 body shapes are. -->

`traversalCtes` cases reduce to: (1) **Filter** `SELECT n.id{carry} FROM tbl n JOIN
prev p ON n.id=p.id WHERE test` → `sql(select(all,[cols],from(table(tbl).as('n'))),
join(table(prev).as('p'), onExpr), sqlText('where'), predExpr)`; (2) **Movement**
`SELECT e.{to} AS id{carry} FROM edges e JOIN prev p ON e.{from}=p.id {labelFilter}`
UNION ALL… → `unionAll(...)`; (3) **Pass-through** limit/range/skip/dedup →
`select(distinct?,…)` + `limit(n,off)`; (4) **Recursive walk** (repeat) →
`withRecursive([cte('w', unionAll(seed,…rec), ['id','depth'])], …)`; (5) **as()/union**.
Label subquery: compose `expression(col, text('in'), parens([select…]))`.

## Prior art (cloned, for reference)
- `~/Projects/sqlg` — Gremlin→SQL on RDBMS (TinkerPop 3). Read
  `sqlg-core/.../strategy/BaseStrategy.java` + `.../sql/parse/SchemaTableTree.java`
  (step-fold → tree IR → one SQL statement; the closest architectural analogue).
- `~/Projects/janusgraph` (sparse, `.../tinkerpop/optimize/`) — `HasStepFolder`
  fold utilities. `~/Projects/tinkerpop` — TinkerGraph + strategy sources
  (step taxonomy: Filter/Map/FlatMap/Barrier/Branch; TraversalStrategy pipeline).

## Decomposition complete (2026-07-12) — Seam 2 + Seam 3 landed

`compiler.ts` went from 1352 lines (flat `switch` + inline rewrites) to a **51-line
orchestrator**: `parse → normalize → dispatch`. Chosen shape (all four maximal):

- **Seam 3 — `src/strategies.ts`.** Pure `Step[]→Step[]` passes run once up front so the
  dispatch sees a canonical, *peek-free* chain: `stripTerminal` (discard/none → flag),
  `foldRepeatClusters` (repeat/emit/times/until run → one step carrying `.cluster`),
  `foldByModulators` (trailing by() absorbed onto order/select/project/group + alias-compare
  where's single by(key) → `.bys`). This removed ALL index arithmetic from the compilers.
- **Seam 2 — `src/steps/*.ts`.** Fully functional fold: each prefix compiler is
  `StepFn = (step, St) => St` over an **immutable** `St` (`context.ts`); nothing mutates in
  place — only the `Query` builder accumulates CTEs. Per-family modules
  (`movement`/`filter`/`branch`/`passthrough`) + tail (`projection.ts`: `PROJECTORS` +
  `MODIFIERS` dispatch Maps + group/properties/select barriers) + `write.ts` (imperative
  interpreters behind an ordered `WRITE_RULES` table). `index.ts` builds the `PREFIX` Map +
  `buildPrefix` fold + `compileRead`.
- **`Query` kernel adopted** (was the q-kernel doc's pending follow-up): CTE names minted
  (no `c${len}`), **typed-`self` recursive CTE** for repeat(); `CteDef`/`withPrefixTree`/the
  `cte`/`withRecursive` ansi nodes retired from `render.ts`. Non-recursive queries now emit
  plain `WITH` (was always `WITH RECURSIVE`). Only `src/q.ts` imports raw lazyrecords
  `Text`/`Compound` now — every step module builds SQL through the kernel (`q`/`list`/`empty`).

SQL text changed (CTE quoting, walk names `w1`→`c1`, `WITH` vs `WITH RECURSIVE`) — 4 snapshot
assertions rebaselined; behaviour preserved (192 tests + contract + perf-EXPLAIN gate green).
One regression caught in review + fixed: alias-compare `where().by(a).by(b)` now fails closed
(a second by() is invalid there) instead of silently dropping the second — regression test added.
L3 cucumber (was 205) needs the tinkerpop repo + live server to re-run; behavioural gates green
so expected unchanged.
