# The `q` kernel — a template-first SQL builder for the compiler

**Status: in progress.** Kernel shipped + read path converted on trunk; remaining
bodies (select/project, group, properties, writes) mid-sweep. This doc records
the design and *why*, so the reasoning isn't lost.

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
  stringly-typed self. (Currently the compiler still uses the older `CteDef[]` +
  `withPrefixTree` machinery in `render.ts`; adopting `Query` to retire that — and
  the `cte`/`withClause`/`valuesClause` ansi nodes — is a follow-up.)
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
  (`prevRel`/`carryFrag`/`aliasCols` helpers). Byte-identical, zero churn. Trunk `5a18894`.
- [x] `compileRead` projection tail (values/id/label/valueMap/elementMap/vertex/edge +
  is/order/limit/count/fold/sum) → `q\`\``+relations. Trunk `c65900c`.
- [x] `compileSelectProject`, `compileGroup`/`buildGroupKey`/`elementSelect`,
  `compileProperties`, and the write compilers (drop/setProperty/addE/merge*/inject) →
  `q\`\``+relations. Added `renderCteSelect(ctes, cols)` (collapsed 5 copies of the
  CTE-render pattern). `compileInject` rewritten off `withClause`/`cte`/`valuesClause`,
  which are now **retired** — no ansi builder imports remain in compiler.ts/plan.ts.
  Byte-identical, zero churn. Trunk `98dfc46`.
- [ ] **Later:** adopt `Query` to retire `CteDef`/`withPrefixTree` (the last CTE-assembly
  machinery in `render.ts`); the plan.ts ScalarCtx cluster (uses kernel primitives — low
  priority); then evaluate upstreaming the surface (identifier-default template, `Relation`,
  typed-self recursive CTE) to lazyrecords.
- **Orthogonal, still pending (pre-kernel cutover):** Seam 2 — the step-family dispatch
  table (`Map<name, StepCompiler>`, = S5.2 in `docs/2026-07-11-lazyrecords-cutover-plan.md`);
  Seam 3 — normalization passes → `strategies.ts`. The kernel changed HOW bodies build SQL,
  not the `switch` structure, so these remain the outstanding decomposition work.
