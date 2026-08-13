# `match()` on the RelIR spine — build plan

> **Status: PLANNED 2026-08-13.** `match()` lowering was deleted with the legacy spine
> (`4af061e`, `src/compiler/steps/prefix/match.ts`, 338 lines). The GQL-string front end
> (`src/gremlin/gql.ts`, `parser/gql/`, the `desugarMatchString` Pass) SURVIVED — it produces the
> ordinary `match()` IR — so today it desugars and then dead-ends on a `match` step nothing lowers
> (`UnsupportedTraversal`). This plan reinstates the lowering on the RelIR algebra. `Match.feature`
> (35) + `MatchString.feature` (25) + the two strategy features are the corpus.

## The thesis: match is composition, not new algebra

Three independent reads (legacy `match.ts`, TinkerPop `MatchStep`, Calcite `SubQueryRemoveRule` +
mogwai's own `src/rel`) converge on one finding: **the relational substrate match needs already
exists and is load-bearing.** `src/rel/rel.ts:44` `join` already carries
`inner | left | cross | semi | anti`; `union`, `recursive`, and negatable correlated `exists`/`scalar`
Exprs already emit (`src/rel/emit.ts:404-409` render `semi`/`anti` as `[NOT] EXISTS (SELECT 1 …)` —
byte-for-byte Calcite's `RelToSqlConverter` strategy for a SQLite target). `where`/`not`/`and`/`or`
already lower through it (`lower.ts:613-677`, `correlatedExists`). The alias channel
(`src/compiler/rel/alias.ts`, `bindAliases`) already binds an element/scalar to a named carried column
and reads it back; `ir/labels.ts:33-42` `matchLabelsOf` already models match's variables-as-reads.

**If implementing match makes anyone reach for a new `Rel` node kind, that is the signal to stop and
reuse these instead** (`src/compiler/CLAUDE.md`: the burden on a structural proposal here is a
measurement, and match's is already answered — the algebra is complete).

## Why this is depth-general, and the legacy version was not — the load-bearing invariant

Legacy match was **shallow by construction**: it carried its OWN mini-fold
(`engineOf(seed).lowerElementSteps`/`lowerStepsStrict` per pattern), so a pattern body could only do
what that engine had been re-taught. That is exactly why legacy DEFERRED `and`/`or`/nested-`match`/
modulated bodies — the corpus shapes at depth.

This lowering routes **every pattern body through the ONE fold** the whole compiler already uses, via
the child seam (`src/compiler/rel/child.ts`, "run the ordinary fold over a supplied stream"). Two
invariants make composition total, and both are gated (below):

1. **A pattern body lowers through `ChildSeam`, never a private match-fold.** ⇒ any step legal in the
   fold is legal in a pattern at any depth, for free — `outE().order().by().limit().inV()` (scenario
   `…outEXcreatedX_order_byXweight_descX_limitX1X…`), `repeat(out).times(2)` (`…a_repeatXoutX_timesX2X…`),
   `map(inE.mean())` (the sunshine scenario), nested `where`/`and`/`or`.
2. **`match` is registered in the fold's mid-chain step dispatch, so it is reachable from `ChildSeam`.**
   ⇒ `match` nests inside `where`/`not`/`repeat`/another `match` (`…b_matchX…X_selectXcX…`, the
   `notXmatchX…XX` scenario), and its output (an alias-carrying stream) feeds any downstream step
   (`…selectXcX_outXcreatedX_name` continues the traversal AFTER match).

This is the substrate move from `SCOPE.md`: make the pattern body a first-class participant in the one
engine, so every combination composes through it. The user must never wonder "does this step work
*inside* a match pattern, *here*?" — resolving that is our job, discharged by invariant 1.

## The model: a binding-table stream threaded through the child seam

Match maintains a **binding table** — an ordinary stream whose carried alias columns are the pattern
variables (legacy's mental model, TinkerPop's `getBindings` = `startLabels ∪ endLabels`). Each pattern
folds onto it one at a time. This is left-deep by construction; **join order is unobservable** (proved
by TinkerPop's `CountMatchAlgorithm` reordering patterns by runtime cardinality — `MatchStep.java:793`)
and is SQLite's job (locked decision #3). We do **readiness-only** scheduling for correctness, never a
cost model.

```
lowerMatch(step, inputRel, inputAliases):
  labels    = union of every pattern's as(start)/as(end)              # matchLabelsOf
  root      = first of (startLabels − endLabels)                      # MatchStep.computeStartLabel
              ‖ topological fallback when that set is empty (a cycle)  # scenario a_created_b__b_0created_a
  rel,als   = bindAliases(as(root), inputRel, inputAliases, <incoming traverser>)   # bind the V() traverser to root
  pending   = patterns
  bound     = {root} ∪ inputAliases
  loop until pending empty (else UNMATCHABLE — a fail-closed decline):
    p = first pattern in `pending` that is READY
        # binding pattern ready  ⇔ its start ∈ bound
        # filter pattern ready   ⇔ every label it READS ∈ bound
    case p is a BINDING pattern  __.as(start).<body>.as(end):
        chain = [ select(start), <body>, (end∈bound ? where(P.eq(end)) : as(end)) ]
        rel,bound-aliases = childSeam.chain(rel, framing, chain, als)   # ONE fold, invariant 1
        bound += end
    case p is a FILTER pattern  where(…)/not(…)/and(…)/or(…):
        rel = filter(rel, childSeam.predicate(body, subject, negated))  # reuse lower.ts:613-677
        # where('a', P.eq('b'))  → a theta-clause between two bound alias columns (NOT an EXISTS)
  emit: if match is TERMINAL → project the bindings MAP over `labels`   # else leave alias cols for downstream
```

**match ALWAYS emits the bindings MAP, terminal or not** — a lesson paid for once. An early version
returned the last scheduled pattern's own framing when a step followed the match, on the theory that a
downstream `select` reads the alias channels and the payload is vestigial. Two failures: (1) a
scalar-valued end left the payload a `v` column while the returned framing claimed `elements`, so a
following `limit`/`identity` read a rowid the row lacked — a fail-closed THROW that `rel-sweep` caught
(the decline contract: a lowering must DECLINE, never throw); (2) even once the framing tracked the
real payload, `…values('name').as('b')).identity()` emitted the bare `b` value where TinkerPop emits
`{a,b}` — a wrong answer the *census* caught, because `MatchStep.getBindings` splits the traverser to
the bindings map unconditionally. So match projects the map every time (`recordTail` then serves the
`select`/`identity`/`limit`/`count` that follow, and `select(k)` re-enters a field or reads the alias
channel). A 0/1-variable map is NOT a `select` (`select('a')` is the value, not `{a:…}`) and declines
for now — the `project('a').by(select('a'))` shape `gql.ts` builds is a later phase.

Every mechanism named is already built: `bindAliases` (alias.ts:119), the leading-`as`→`select`
re-root + trailing-bound-`as`→`where(eq)` rewrite (`rewriteWhereVariables`/`rewriteStartLabel`,
`strategies.ts:1479` — today it fires for match FILTER args; we extend it / apply it to BINDING
patterns inside the match lowering, which is where the bind-vs-constrain decision legitimately lives —
`strategies.ts:1548` deliberately leaves pattern args untouched for exactly this reason), the
child-seam `chain`/`predicate` arms, and the record/map projection (`record.ts`, multi-key `select`).

### The two constraint shapes route to two existing mechanisms

- **A back-edge / repeated end label** (`as(b)` where `b` already bound; `where(as(x)…as(y))`): an
  equality between the body's produced element and the bound alias column — a `where(P.eq(label))`
  clause, already what `rewriteEndLabel` builds.
- **`where('a', P.eq('b'))` / `P.neq`** (`WherePredicateStep`): a theta-clause **between two already
  bound columns** — a plain predicate over alias reads, NOT a correlated `EXISTS`. Route through
  `predicateExpr` over two `aliasProjection`s, not through `correlatedExists` (which wants an element
  subject + a moving body — flagged by the ref sweep).

## Scope, phased — trunk-based, one green increment at a time

Ordered so the substrate lands first and everything else reaps through it. Each phase is one-or-more
`mise run ci`-green commits, pushed to trunk, census/L3 re-recorded per increment. **Not phase-gates on
capability** (combinatorial completeness forbids "this step works only after phase N") — phases are the
landing order of one engine, not a support matrix.

- **P0 — the engine + the simplest binding pattern. ✅ LANDED 2026-08-13.** `src/compiler/rel/match.ts`;
  dispatch arm in the fold's mid-chain dispatcher; root computation (+ zero-root topo fallback);
  readiness scheduler; binding pattern via `childSeam.chain`; terminal bindings-map. Reaped: `a_out_b`,
  the chained/order-independent pairs, `select(b).by(T.id)`, cyclic `a_created_b__b_0created_a`, the
  multi-hop `out().out()` body — **and the whole GQL match-STRING front end**, which desugars to
  `match(Traversal)` and had been dead-ending on the missing lowering. L3 1480 → 1509 (+29), and 29
  corpus traversals moved deferral → golden (verified correct before banking). The scalar-end grateful
  scenarios wait on P1.
- **P1 — constraints & per-row scalar ends. ✅ LANDED 2026-08-13.** A no-end constraint pattern
  (`as('d').has('name','vadas')`) folds as a re-rooted FILTER through `child.chain` (`classify` gates
  it to a non-moving body — a moving no-end body is an existence semi-join, deferred to P2). A per-row
  SCALAR end (`values('name').as('b')`, `select(key).as('b')`) binds a VALUE via `bindAliases`'s value
  form, with scalar back-edges comparing stored values. L3 1509 → 1515. **A REDUCING-barrier end
  (`count()`/`sum()`, `framing.result` 'count'/'number') DECLINES** — its per-origin 0/empty default
  needs a correlated scalar child, and folding it inline drops empty origins (a wrong answer, caught
  before it shipped). **P1c LANDED 2026-08-13:** a reducing-barrier end (`count()`/`sum`/`mean`/`min`/
  `max`) routes through `child.scalar` rooted at the start alias (the same correlated read
  `by(__.out().count())` uses, 0 for an empty origin); scalar back-edges compare the reduced values.
  Landed with the **zero-root fix**: when a start variable is ALREADY bound before the match
  (`V().as('a').out().as('b').match(…)`), the root is NOT rebound — rebinding it to the incoming
  traverser corrupted the pre-bound value (`a_out_count_c__b_in_count_c` was the witness). L3 1516 →
  1518. Still ❌: a filter-AFTER-reduce end (`count().is(P.gt(10)).as('b')`) and a `fold()` (list) end.
- **P2 — filter legs.** **P2a LANDED 2026-08-13:** an inline `where('a', P.eq/neq('c'))` leg is a
  two-variable THETA clause between bound ELEMENT aliases — a `Filter` comparing two rowids, binding
  nothing, reads both keys (`readsOf`). Reaps the inline-where-leg scenarios (580 grateful, 253's where
  arm). ⚠️ **Still open, and it is the SUBSTRATE piece:** the TRAVERSAL legs `not(as('a')…as('b'))` /
  `where(as('c').<moving body>)` need a correlated `[NOT] EXISTS` / SEMI-ANTI JOIN with MULTI-COLUMN
  correlation — the leg body references SEVERAL outer aliases (`not(as('a').out().as('b'))` correlates
  on a AND b), which `correlatedExists` (single correlation, `body[0]` a movement) cannot express.
  Calcite's exact mapping (`SubQueryRemoveRule`, `JoinRelType` SEMI/ANTI); `src/rel/emit.ts:404`
  already RENDERS semi/anti as `[NOT] EXISTS`, but nothing CONSTRUCTS those nodes — match's legs are
  the first constructor. Also `where('a', P.neq('c'))` as a step AFTER the match (scenario 95) is a
  downstream `where(key,P)` over the record stream, a separate `where('a',P)` gap. `where('a',P)` over
  SCALAR aliases and non-eq/neq ops also await.
- **P3 — connectives & nesting.** `and(…)` binding group; `or(…)` → UNION of branches; nested `match`
  in a pattern; top-level `not(match(…).where(…).select(…))`.
- **P4 — modulated bodies & downstream collectors.** `outE.order.by.limit.inV`, `repeat.times`, `map(mean)`
  bodies (these fall out of invariant 1 — verify, don't build); `dedup("a","b"[,…])` keyed on alias
  columns; `count()`/`select().count()` after match.

Each phase, per the working rules: land the L2 SQL snapshots + the cucumber tag in `tags.ts`, keep L1
100%, and — when a phase closes a shape L5 could generate — promote it to an L4 `.feature`.

## Gates that hold the two depth invariants

- **`mise run arch`** already forbids a Pass reaching `ChainFacts`/fast paths; `match.ts` is a lowering,
  not a Pass, and calls `ChildSeam` — the same one-way DAG (`build ◂ {modulator,list,write} ◂ lower ◂ spine`).
- **L5 differential + metamorphic** is the ceiling instrument: a match nested in a generated prefix that
  the fold can reach is exactly what proves invariant 1 held. A private match-fold would show up as a
  shape the differential cannot reach — the tell to watch for.
- **The census**: when `ran` rises, read the new match rows (a deferral→wrong-answer is the one
  transition no gate sees).

## Deliberately NOT ported (fail closed, named)

- **TinkerPop's `Greedy`/`CountMatchAlgorithm` cost model** — join order is SQLite's (locked #3); the
  `MatchAlgorithmStrategy`/`MatchPredicateStrategy` corpus scenarios are strategy *selection* over an
  unobservable order, so they either pass unchanged or are excluded by name, never implemented.
- **`match()` on an EDGE stream / path tracking through match** — legacy's `st.elem==='vertex'` +
  no-path guards; keep as fail-closed declines until a scenario demands otherwise.
- **`DeclarativeMatchStep`/`match(String)` as an upstream provider strategy** — a real v4-native angle
  (v4 deprecates `match(Traversal…)` for it), but the GQL front end already desugars `match(String)` →
  `match(Traversal)`, so this lowering serves both. Logged as a future upstream-first option, not a
  blocker.
