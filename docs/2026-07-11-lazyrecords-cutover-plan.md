# compiler.ts → lazyrecords cutover + 3-seam decomposition

**Self-contained handoff. Read `CLAUDE.md` first (project law), then this.**
This doc has everything needed to continue after a context clear.

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

## lazyrecords API cheat-sheet (learned the hard way)
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
- [~] **S2** label-filter splice-kill (`labelIn`/`edgeLabelFilter`, ~7 copies
  collapsed). Read prefix splice-free. Remainder (CTE bodies as node trees) folded
  into S5. Trunk `6715529`.
- [ ] **S3 — read tail → nodes.** `compileRead` projection switch, `is`-filter,
  order-by, `compileSelectProject`, `compileGroup`, `compileProperties`. Residual
  splices: `fb.push(...r.binds, ...r.binds)` double-pushes (SELECT+WHERE mention the
  same expr) — kill by building the tail SELECT as a `select()` node tree where the
  expr subtree is shared. Fold together with S5 (node-tree bodies pay off in `steps/*`).
- [ ] **S4 — write path → nodes.** `compileDrop`, `compileInject` (done, node-built),
  `compileAddV`, `compileAddE`, `compileMergeV`, `compileMergeE`, `compileSetProperty`,
  + `insertVertex`/`insertEdge`/`mergeMatchQuery`/`edgeMatchQuery`. Imperative
  run-closures; less splice payoff. `mergeMatchQuery`/`edgeMatchQuery` already use
  `render(propExtract(...).expr)`.
- [~] **S5 — restructure.** Extracted so far (each green, on trunk): `frontend.ts`
  `89328a7`, `render.ts` `cb7638d`, `plan.ts` `24851fe`. compiler.ts 1801→1540.
  STILL TO DO, in order:
  1. Move `ScalarCtx` cluster (compiler.ts **596–795**: `ScalarCtx`/`Scalar`/
     `labelNameSub`/`propAt`/`compileNestedScalar`/`MOVES`/`edgeCountFrom`/
     `requireTerminal`/`compileFilterPredicate`/`combineBranchPreds`/`compileExists`)
     into `plan.ts`. Contiguous block, circular-safe (no reverse dep on step compilers;
     needs `stepChain`/`Step` from frontend + `list` from Compound added to plan.ts
     imports; add `export` to the moved fns; compiler imports them back).
  2. Split step compilers into `steps/*.ts` behind `Map<name, StepCompiler>` dispatch
     (Seam 2). Families: movement (out/in/both/…E/…V), filter (has/hasLabel/where/
     and/or/not/is), branch (union/optional/repeat), projection/barrier (values/id/
     label/valueMap/elementMap/count/order/group/fold/sum/properties/select/project),
     write. Each `StepCompiler` a small unit-testable fn.
  3. Node-tree the CTE bodies (5 templates — see below) + tail; remove the `render()`
     adapters. Extract inline rewrites into `strategies.ts` (Seam 3).
- [x] **S6 — publish + wire (DONE early).** lazyrecords G1–G7 committed+pushed
  (`d6618a4`), auto-published JSR `0.494.348`; mogwai wired to it, symlink dropped,
  `mise run ci` + worker build green. Remaining nicety: `wrangler deploy --dry-run`
  gzip-size sanity (was ~265 KB before).

## The 5 CTE-body templates (for S5 step 3 — node recipes)
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
