# RelIR — architecture and remaining work

RelIR is the sole lowering: `Step[] → RelIR → SQL`. `src/rel/` and
`src/compiler/rel/` are authoritative; this document records the constraints that code alone
does not make obvious and the substrate still worth building.

## Platform laws

- A SQLite recursive reference appears exactly once, at the top level of the recursive
  term's `FROM` join tree. It cannot sit behind a derived table or `Materialize`; recursive
  terms cannot contain aggregates or windows. `src/rel/block.ts` is the authority.
- Correlated scalars, `NOT EXISTS`, derived `UNION`s, `IN (SELECT ...)`, and multi-hop joins
  are legal in that term. Do not mistake the old lowering's vocabulary for a platform limit.
- No recursive lowering can express a per-iteration barrier or collapse a multiset. Therefore
  bounded `repeat().times(n)` unrolls into phases; unbounded `repeat()` uses `Recursive`; an
  unbounded body with a barrier refuses clearly. The full evidence is retained in
  [the archived repeat plan](./archive/2026-08-09-repeat-two-regimes-plan.md).
- SQLite supports `INSERT ... SELECT ... RETURNING`, upsert-returning, `UPDATE ... FROM`, and
  `DELETE ... IN (SELECT)`, but not data-modifying CTEs. A write chain is a sequence bounded by
  write steps, never by data rows. `RETURNING` order is undefined: order the source and
  re-associate by a carried key, never result position.

## Boundary and object model

`src/rel/` imports neither the compiler nor the Gremlin front end. It contains immutable,
branded relational data plus total construction, checking, rewriting, and emission. It knows
only output columns, their channel roles, and channel policies—not Gremlin shapes, sacks, or
step names. `src/channels.ts` is the neutral channel core.

Shape-aware value construction belongs in `src/compiler/rel/`; byte framing belongs in
`src/execute.ts`. A framing boundary is `(rows, Shape)`, never SQL in the framer. A Pass may
consult shape but never construct it.

A plan is bindings plus a result relation:

```ts
type Plan = { readonly bindings: readonly Binding[]; readonly result: Rel }
type Binding = { readonly name: string; readonly node: Rel | Stmt; readonly snapshot?: boolean }
```

A shared relation binding becomes a CTE; a statement binding retains `RETURNING` rows; a
`snapshot` relation is retained at that point rather than recomputed. A later statement reads a
retained row set as one JSON value expanded with `json_each`. Effects live only at bindings: a
write in a read position is hoisted, never interpreted by a row driver.

## Closed node set

RelIR has expressions (one value per row), relations (rows), and statements (writes). Kinds and
fields live in `src/rel/{expr,rel,stmt}.ts`; rebuild through the named factories, never object
spread. The node set is intentionally smaller than SQL: `HAVING` is `Filter(Aggregate)` and a
distinct union is `Distinct(Union{all})`.

- `Scan` is the only physical-schema node; `Project` alone declares channels; an empty relation
  is `Filter(false)`, not `Values([])`.
- `Distinct` is whole-row only. Keyed dedup is a `Window(row_number partitioned by key)` followed
  by a filter. `Window` only extends its input; `Aggregate` emits group keys then aggregates;
  `Union` is n-ary; `Join` preserves positional column order.
- `Recursive` alone creates its self-reference and requires equal seed/step channels. `Agg` and
  `WindowExpr` only occur in their owning nodes. Correlation is an expression referring to an outer
  relation, not a lateral node.
- `Explode` without input is the sole-FROM `json_each` form. It turns a transported JSON value into
  a relation without manufacturing a bind list.

There is no `With` node (bindings name work), `Param` node (a parameter is a literal source), or
shape/cardinality/productivity/bulk node (those are Gremlin semantics above RelIR). Add a node only
after proving existing relational composition cannot express the required form; RelIR is not a cost
model, statistics engine, or join-order optimizer.

## Channel, budget, and decline rules

Every relation node declares a total channel obligation in `src/rel/obligations.ts`. `Project`
declares; ordinary relational operators preserve; `Union` merges by policy. A true barrier creates
a new traverser and drops channels. A grouping that retains traverser identity must preserve the
channels it claims; `CHANNEL_GROUP_POLICY` decides which N→1 answers exist (`bulk` adds,
`encounter` takes earliest, and identity-bearing roles refuse).

A `?` belongs to a user parameter. Compiler-held constants are typed SQL literals. A data-sized row
set is one JSON bind, never N binds: reads need it as a relation in one statement, writes may need a
pre-mutation snapshot, and this keeps bind count a function of plan size. `check` enforces the DO's
100-bind and 100-KB statement limits; JSON transport fails closed for non-transportable values. A
retained BLOB must project `json(x)`, not `jsonb`.

`null` is the lowering's only "not learned" result. A semantic error propagates; a graph-dependent
error is a guard binding that tests a relation's row count and raises the reference message. Do not
turn an argument or shape limit into a silent different answer, or let a verifier reject a chain the
lowering can correctly continue.

## Rewrites and emission

RelIR rewrites are not compiler Passes: Passes rewrite `Step[]` above lowering; RelIR rewrites are
total `Rel → Rel` functions. `check` validates columns, node placement, channels, budgets, and the
recursive-term laws. `name` selects CTEs versus derived tables; `prune` removes unread columns;
`seek` is the optional property-seek rewrite. The remaining `flatten`, `unroll`, and `fuse` work must
be ordered deliberately rather than growing call-site pipelines.

The emitter is a total SELECT-block assembler over the `q` kernel. It opens a derived SELECT only
when a required slot is already occupied; it does not grow a mega-`Select` node. Validate results and
access path, never byte-identical SQL.

## Compounding work

1. **Generic child and tail lowering.** Complete common rejoin, cardinality, value, and encounter
   authorities so nested children, map/record values, aliases, row operations, and element tails
   share one route rather than acquire step-specific paths.
2. **Relational rewrites.** Build the declared ordered pipeline with remaining `flatten`, `unroll`,
   and `prune` work. Compound recursive bodies must preserve multiset semantics: `both()` on a
   self-loop remains two traversers.
3. **Value carriage.** Preserve exact scalar types through JSON-backed values, including inexact
   reals, collection members, maps, aliases, and paths. This is framing and lowering work, not a
   new RelIR type.
4. **Set-based writes.** Lower write chains to `Insert`/`Update`/`Delete` bindings and retain
   `RETURNING` rows as snapshot relations.
5. **Semantic families.** Paths, generic branch forms, `match`, retained side effects, and graph
   algorithms should consume the preceding substrate rather than add a second route.

## Verification

Run `mise run test` and the architecture and bind checks after a RelIR change. Use
`test:cf-limits` for new SQL and the perturbed-order test when order changes. The feature matrix is
the public per-step status; [outstanding work](./outstanding-work.md) is the cross-family index.
