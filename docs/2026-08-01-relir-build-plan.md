# RelIR: remaining work

RelIR is the only lowering: `Step[] → RelIR → SQL`. Its closed algebra, checker,
emitter, channel policies, pass vocabulary, recursion regimes, and parameter budget are
implemented. Code in `src/rel/` and `src/compiler/rel/` is authoritative.

## Constraints

- `src/rel/` is shape- and Gremlin-free. It owns relational construction, validation,
  rewriting, and SQL emission; lowering owns shape and framing.
- A data-sized row set crosses a statement boundary as one JSON value and is expanded with
  `json_each`; a bound parameter represents a user parameter, not a compiler constant.
- Every relation node declares its channel obligations. A pass may consult shape but may
  not construct it.
- SQLite recursive terms cannot contain a per-iteration aggregate or window. Bounded
  `repeat().times(n)` unrolls; unbounded walks use `Recursive`; unbounded plus a barrier
  remains an explicit refusal.

## Compounding work

1. **Generic child and tail lowering.** Complete the common rejoin, cardinality, value,
   and encounter authorities so nested children, map/record values, aliases, row
   operations, and element tails share one route rather than acquire step-specific paths.
2. **Relational rewrites.** Build the declared ordered pass pipeline with the remaining
   `flatten`, `unroll`, and `prune` work. In particular, distribute compound recursive
   bodies without changing multiset semantics (a self-loop through `both()` remains two
   traversers).
3. **Value carriage.** Preserve exact scalar types through JSON-backed values, including
   inexact reals, collection members, maps, aliases, and paths. This is a framing and
   lowering concern, not a new RelIR type.
4. **Set-based writes.** Lower write chains to `Insert`/`Update`/`Delete` bindings and
   retain `RETURNING` rows as snapshot relations. The sequence is bounded by write steps,
   never data rows.
5. **Remaining semantic families.** Paths, generic branch forms, `match`, retained side
   effects, and graph algorithms should consume the preceding substrate rather than add a
   second route.

## Verification

Run `mise run test` and the architecture/bind checks after a change. The feature matrix is
the public per-step status; `docs/outstanding-work.md` is the cross-family index.
