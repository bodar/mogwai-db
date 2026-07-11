# compiler.ts → lazyrecords cutover + 3-seam decomposition

Target: `compiler.ts` (1801 lines, string-concat SQL, one flat `switch`) becomes
a node-built, decomposed compiler. Decided scope: **read + write**, **all three
seams**, **lazyrecords published to JSR**.

The three seams:
- **Seam 1 — SQL AST.** Every `{sql,binds}` string-pair becomes a lazyrecords
  `Expression`/`Sql` node. The `render()` (= `statement()`) boundary sits once at
  the top of `compile()`. Double-splices (the 8 `predicateSql` string+bind
  callers) die here.
- **Seam 2 — step-family dispatch table.** The flat `switch(s.name)` becomes a
  `Map<stepName, StepCompiler>` of small, unit-testable per-family compilers.
- **Seam 3 — Step[]→Step[] normalization passes.** The inline rewrites
  (discard-strip, repeat-cluster gather, range/limit-before-vs-after-`order()`)
  become pure list transforms.

## End-state file layout
- `frontend.ts` — parse + `stepChain` + arg extraction + IR types (`Step`,`Pred`).
- `strategies.ts` — pure `Step[]→Step[]` normalization passes.
- `plan.ts` — mogwai node builders on lazyrecords: `filterCte`, `movementCte`,
  `passThroughCte`, `recursiveWalk`, `aliasRebind`, `labelSubquery`, scalars.
- `steps/*.ts` — per-family compilers + the dispatch table.
- `render.ts` — the `render(tree)→{sql,binds}` boundary + `Compiled`/`WritePlan`.
- `compiler.ts` — slim orchestrator: dispatch → assemble plan tree → render once.

## Invariants (every stage ends here)
- `bun test` = 192 pass / 0 fail.
- L3 cucumber conformance count not regressed (currently 205).
- `test/performance.test.ts` EXPLAIN index gate green — `jsonExtract(text(col),key)`
  keeps the literal-path index eligible (proven in prototype).
- SQL snapshot drift (lowercase keywords, quoted idents) is accepted; rebaseline.

## Stages
- [x] **G7** — lazyrecords `@module` on 6 core nodes (select/from/where/is/
  PredicateExpression/SelectList). Exports regen, 106 pass. DONE.
- [x] **S1 — boundary + scalar/predicate layer.** DONE, 192 pass. `render()`
  fragment boundary added; `propExtract`/`propAt`/`predicateSql`/`compileNestedScalar`/
  `edgeCountFrom`/`Scalar` are node-valued (`{expr,indexKey}`). `predicateSql`
  builds `comparison`/`is`/`like`/`in`/`isNotNull` tails via `expression()` — the
  manual `exprBinds` double-splices are GONE (binds fall out of the tree). ~20
  consumers wrapped in `render(...)`; `ScalarCtx` string fragments left as-is
  (bind-free), wrapped with `sqlText()` at the leaves. Snapshot drift rebaselined
  (lowercase kw, `escape ?` bound, comma-spacing). Consumers still assemble CTEs
  as strings via `render()` — those adapters vanish in S2.
- [~] **S2 — traversalCtes splice-kill.** DONE (192 pass): all label-filter
  binds node-built via `labelIn`/`edgeLabelFilter`; ~7 copies of the idiom
  collapsed. Read prefix is now splice-free. NOT yet done: CTE *bodies* are still
  string-assembled (predicate nodes rendered in via `render()`), and there's no
  dispatch table yet. Folding the CTE-body-as-tree + dispatch table into S5
  (the restructure) — building `select`/`join`/`unionAll` bodies pays off
  structurally only alongside the `steps/*` split, not as isolated churn here.
- [ ] **S3 — read tail.** projection/order/limit/count + group + properties +
  select/project → nodes.
- [ ] **S4 — write path.** drop, inject(done), addV, addE, mergeV, mergeE,
  setProperty → nodes.
- [ ] **S5 — restructure.** Split into the end-state layout; extract Seam-3
  passes; wire the Seam-2 dispatch table.
- [ ] **S6 — publish.** Commit bodar.ts lazyrecords (G1–G7), version bump,
  `jsr publish`; mogwai `package.json` → `npm:@jsr/bodar__lazyrecords`; drop
  symlink; `mise run ci` green; `wrangler deploy --dry-run` bundle sane.
  (Confirm before the actual publish — outward-facing.)
