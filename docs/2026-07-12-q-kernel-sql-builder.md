# The `q` kernel — a template-first SQL builder for the compiler

**Status: complete.** The compiler builds ALL its SQL through the kernel — reads,
writes, the decomposed step dispatch (Seams 2+3), and typed `ScalarCtx`. `src/q.ts`
is the only module that touches lazyrecords. This doc records the design and *why*,
so the reasoning isn't lost.

## The problem

`compiler.ts` writes a shed-ton of SQL. The lazyrecords **ansi builder layer**
(`select(quantifier, cols, from(table('t')))`, `join`, `comparison`) is *app-shaped*
— tuned for typed selects over a fixed schema. A **compiler** is the opposite: it
assembles SQL *shapes* (raw fragments, dynamic intermediate relations, `WITH`
prefixes), and is identifier-heavy (table/column names dominate; few real binds).
Every clean example we wrote collapsed to an interpolated template, not nested
constructors — a signal the ansi layer is the wrong altitude here.

Crucially: **the SQLite schema is fixed and known** (nodes/edges/labels + fixed
columns; we never DDL at query time). So identifiers should be declared once as
typed constants, not repeated as strings — and ~⅔ of what the compiler concatenates
is exactly that. The other ⅓ is *generated* (CTE names `c0…`, synthetic alias
columns `a0…`) — which a pure schema-constant model can't cover.

## The kernel (`src/q.ts`)

Template-first, built ON lazyrecords' **bind-safe core** (`Text`/`Value`/`Sql`/
`statement`/`jsonExtract`) — the subtle, worth-reusing machinery — and dropping the
ansi builders entirely.

- **`q\`…\`` template** — interpolations default to **raw identifiers/fragments**;
  bind a value by wrapping it `${value(x)}`. The *flip* of the usual bind-by-default
  tag (right, since a compiler is identifier-heavy). A node embeds as-is (binds fall
  out); a number/string splices raw.
- **`Relation`** — a base table OR a generated CTE, **indistinguishable at the use
  site**: `${rel}` renders the FROM form (`nodes`, or `nodes n` aliased), `rel.c.col`
  a qualified column. `rel.as('n')` rebinds the column qualifier (the one trick that
  makes columns follow the alias). This *unifies* the fixed ⅔ and generated ⅓: the
  compiler always writes `rel.c.x` / `${rel}`, whether `rel` is a schema constant
  (`nodes`) or a minted CTE (`relation('c3', […])`).
- **`Query`** — a per-query context that mints CTE names (`c0`, `c1`, … — you never
  write a number) and gives recursive CTEs a **typed `self` handle**
  (`recursiveCte(['id','depth'], self => q\`… ${self.c.depth} … ${self} …\`)`) — no
  stringly-typed self. `Query` IS the compiler's CTE machinery now; the older
  `CteDef[]`/`withPrefixTree` in `render.ts` and the `cte`/`withClause`/`valuesClause`
  ansi nodes are retired.
- **`src/schema.ts`** — `nodes`/`edges`/`labels` as typed relation constants (Drizzle's
  "one object, columns as properties, import everywhere" shape; lean — no types/DDL,
  which mogwai doesn't consume).

Identifiers **quote only when unsafe** (`^[A-Za-z_][A-Za-z0-9_]*$` → raw), decided at
render time — so output reads like hand SQL (`n.id`, not `"n"."id"`).

## Why these choices (backed by prior-art research)

- **Free functions, NOT fluent methods.** Fluent chaining (`.from().where().eq()`)
  couples node classes (Column→Comparison, Select→From/Where), linking the whole
  grammar and defeating tree-shaking. Kysely is the proof: it *has* decoupled
  `OperationNode` classes but a fluent front-door + monolithic visitor, so it doesn't
  tree-shake anyway (~40 KB gzip; a like-for-like app was 340 KB vs Drizzle's 55 KB).
  AND: mogwai uses ~all the grammar, so tree-shaking saves it ≈nothing regardless.
  **So justify free-functions on decoupling / god-object-avoidance / composability —
  not bundle size.** A compiler assembles trees from pieces; fluent immutable builders
  hide that low level. `.as()` on a Relation is fine — it's a value-object method on
  one type, not grammar coupling.
- **Position/shape typing over a wrapped default.** No JS lib flips the template
  default; HoneySQL (Clojure) sidesteps it — a bare keyword *is* an identifier, a
  value *is* a value, typed by position. `rel.c.x` (identifier by construction) vs
  `value(x)` (bind) is that pattern — which makes the template-flip mostly moot: with
  relation refs there's no ambiguous bare interpolation left.
- **`(sql, binds)` tuple fold per node** (HoneySQL), not a mutable god-visitor
  (Kysely) — which is what lazyrecords' core already does (render → {text,args}).
- **Render-time conditional quoting** (SQLAlchemy `_requires_quotes`, jOOQ
  `EXPLICIT_DEFAULT_UNQUOTED`) — mogwai already did this for `propExtract`; now house
  style for all identifiers.
- **Recursive CTEs**: Drizzle **can't** (issue #209, raw-SQL workaround) — and mogwai's
  `repeat()` needs `WITH RECURSIVE`, so Drizzle's model is a non-starter here. Kysely
  can, but references self by **string name**. The typed-`self` handle is ahead of
  both — genuinely novel ground.

## Operating principle

When a body shows noise (nesting, numbering, repetition), **push a fix down into the
kernel/helper so the noise disappears at the source** — don't endure it in the compiler.

## Upstream disposition

Build the kernel *for mogwai* first (fast iteration, exact fit). It reuses lazyrecords'
bind-safe core but bypasses its ansi builders. If it proves beautiful, the
compiler-facing surface — **identifier-default template, `Relation` handles, typed-self
recursive CTE** — is a *genuine new contribution* to lazyrecords (nothing in the JS
ecosystem has it), so upstreaming it later is a real give-back, not a fork.

## Progress

- [x] `src/q.ts` kernel — `q`/`Relation`/`Query`/typed-self recursive CTE. Prototype-
  proven (renders + executes a full read path and the recursive `repeat()` walk). Trunk `7543161`.
- [x] `src/schema.ts` relation constants + `predicateSql` on `q\`\`` (zero churn). Trunk `6a9e1f2`.
- [x] `traversalCtes` CTE bodies (movement/filter/branch/source/pass-through) → `q\`\``+relations
  (`prevRel`/`carryFrag`/`aliasCols` helpers). Semantically identical, zero churn. Trunk `5a18894`.
- [x] `compileRead` projection tail (values/id/label/valueMap/elementMap/vertex/edge +
  is/order/limit/count/fold/sum) → `q\`\``+relations. Trunk `c65900c`.
- [x] `compileSelectProject`, `compileGroup`/`buildGroupKey`/`elementSelect`,
  `compileProperties`, and the write compilers (drop/setProperty/addE/merge*/inject) →
  `q\`\``+relations. Added `renderCteSelect(ctes, cols)` (collapsed 5 copies of the
  CTE-render pattern). `compileInject` rewritten off `withClause`/`cte`/`valuesClause`,
  which are now **retired** — no ansi builder imports remain in compiler.ts/plan.ts.
  Semantically identical, zero churn. Trunk `98dfc46`.
- [x] **`Query` adopted (2026-07-12).** `CteDef`/`withPrefixTree`/`readCompiled(ctes,…)` and the
  `cte`/`withRecursive` ansi nodes are retired from `render.ts`; the compiler builds CTEs via
  `Query` (minted names, typed-`self` recursive CTE for repeat()). `readCompiled(query,tail,…)` /
  `renderFrom(query,last,…)` are the new boundaries. Only `src/q.ts` imports raw lazyrecords
  `Text`/`Compound` now; a `list(parts, sep?: string)` + `empty` are re-exported so step modules
  build every compound through the kernel. `q.ts` also gained the `list` string-separator wrapper
  (no more `sqlText(' AND ')` at call sites).
- [x] **Seam 2 + Seam 3 done (2026-07-12).** Step-family dispatch (`src/steps/*.ts`, functional
  `StepFn = (step, St) => St` fold over an immutable `St`) + normalization passes
  (`src/strategies.ts`). See the "Decomposition complete" note in
  `docs/2026-07-11-lazyrecords-cutover-plan.md`. `compiler.ts` is now a 51-line orchestrator.
- [x] **ScalarCtx typed (2026-07-12).** `ScalarCtx`'s fields are now `Expression`, not raw SQL
  strings — built from typed `Relation` columns (`elemCtx(elemRel(st), elem)` for node/edge; the
  properties CTE's `Relation` for the property ctx). `propExtract`/`propAt`/`labelIn` accept
  `Expression | string`; `labelNameSub` returns an `Expression`. No hand-written SQL column
  fragments remain in the compiler — only `q.ts` touches raw lazyrecords `Text`/`Compound`.
- [ ] **Later:** evaluate upstreaming the kernel surface (identifier-default template, `Relation`,
  typed-self recursive CTE, `list`/`values`/`paren` helpers) to lazyrecords.
