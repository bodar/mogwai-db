# A NAMED COLLECTION IS A BOUND RELATION, REDUCED AT THE READ

_Status: **Phases 1, 2, 3a, 5 and 6 LANDED.** Open: **7** (the largest item, 29 scenarios), **4** (13),
**3b**, **2b**, **§8**. Numbers re-validated 2026-08-11 against `l3-state.json` + `scenarios.tsv`; absolute
L3 floors are deliberately not quoted (they move for unrelated reasons — read the instruments). **Read this
before touching `src/compiler/rel/collection.ts`.**_

## The thesis

`aggregate("a")` does not build a value; it **retains a relation under a name**. `cap("a")` is what turns
that relation into a traverser. Everything follows from moving the reduction from the WRITE site to the READ
site — which is where TinkerPop puts it (`SideEffectCapStep.generateFinalResult`) and where our own plan
vocabulary already had a word for it (`Binding`).

Folding at the `aggregate` is defensible for ONE site and does not survive contact with a second: `Map` keeps
the last entry, so the first site's members are silently discarded. **That was a wrong ANSWER on both spines,
not a gap** — RelIR declined and legacy mis-executed.

---

## ✅ What landed (one line each; `git log` has the detail)

- **1 — `Collection` holds MEMBER rows, not a folded list.** `reduce()` at the `cap` is the one place a
  named collection's fold is chosen. Pure refactor, no coverage change.
- **2 — multi-site accumulation.** `Collection.sites` is a list in chain order; `reduce()` builds the
  `UNION ALL` at the read. Sites stay APART until then, which is what keeps the reference's order
  expressible. **Consumed 6 of the 9 multi-site failures this plan opened with** (re-verified: 6 now pass,
  and the 3 survivors are the ones predicted below).
  ✅ **It also discharged a blocker in another plan, which is the compounding worth naming.** The `repeat()`
  unroll's admitted-body set excluded side-effect steps because "accumulation ACROSS phases" was thought to
  need its own argument — but an unrolled body IS N sites, so multi-site accumulation is that argument.
  Verified 2026-08-11: with `aggregate` admitted, `g.V().repeat(__.aggregate("a")).times(2).cap("a").unfold()`
  routes to RelIR and returns each of the six vertices TWICE, which is `Aggregate.feature:743-763` exactly.
  ⚠️ The stale claim survived in two other docs for two days after it stopped being true — *read a decline's
  REASON, not its date*.
- **3a — member TYPES meet.** A String site beside an Integer site is not a shape disagreement; they meet at
  a per-value type via `meetScalarTypes`/`withMergedVtype`, shared with branch arms rather than reinvented.
- **5 — rooted sub-chains inherit `collections`.** The fresh-map isolation was not a scoping decision, it was
  wrong against the reference: a side effect lives on the ROOT traversal (`AggregateStep.java:57`).
- **6 — a site is a `snapshot` Binding**, so a collection survives a mutating chain. Deleted two of the four
  `ctx.mutating` declines; two remain, for the keyed forms only (see Phase 4).

---

## 🚧 What is LEFT

### Phase 7 — the merge POLICY: seed + `Operator`. **The largest item: 29 scenarios.**

Measured 2026-08-11: **23** `withSideEffect(name, seed, Operator)` scenarios that NO spine holds, plus **6**
`withSack(seed, Operator)` scenarios that take the same policy object — disjoint from Phase 4. Delete the
`reducers.has(label)` decline (`collection.ts:164`, `:262`).

**Verified at the pin, so the design is not guesswork** — `sideEffect/Aggregate.feature:279-563` over
`gmodern`'s ages (29, 27, 32, 35):

| declaration | expected | so the reduction is |
|---|---|---|
| `("a", 1, Operator.sum)` | `124` | `1+29+27+32+35` |
| `("a", 123, Operator.minus)` | `0` | `123-29-27-32-35` |
| `("a", 2, Operator.mult)` | `1753920` | `2*29*27*32*35` |
| `("a", 876960, Operator.div)` | `1` | `876960/29/27/32/35` |
| `("a", 1, Operator.min)` / `("a", 100, Operator.min)` | `1` / `27` | extremum including the seed |
| `("a", …, Operator.addAll)` / a `Set` seed | a list / a deduped list | the list fold, seed first |

**It is ONE mechanism, and picking nine aggregates would be the mistake.**
`DefaultTraversalSideEffects.add` is `set(k, getReducer(k).apply(get(k), v))` — a LEFT FOLD over the members
in order, seeded. So the lowering is a `Recursive` walk over the ordered member relation with one
operator-dependent expression: `make.recursive`, nothing new.

⚠️ **`SUM`/`MIN`/`MAX` would cover four operators and silently MIS-ANSWER two.** `mult` and `div` have no SQL
aggregate, and rewriting `div` as `seed / PRODUCT(members)` is NOT equivalent under INTEGER division — it
happens to agree on this fixture and would not in general. A left fold is exact by construction, which is the
difference between a right answer and a lucky one. The member ORDER it needs is the one Phase 2 already
pinned (site ordinal, then that site's encounter), so nothing new decides it.

A non-`addAll` operator's result is a SCALAR, not a list, so `reduce()` gains a second framing answer — which
is what keeping `Members` and `MergePolicy` as separate fields is for. `merge` was deliberately left off
`Collection` in Phase 1: with the decline standing it had exactly one possible value, and a single-valued
field claims a capability the decline beside it refuses.

**Work, in order:** widen `sideEffectReducers` from `ReadonlySet<string>` to a map of `{seed, operator}` (the
front end already finds the form and throws the payload away — its own comment says it widens "when a merge
policy lands, one place") · thread it as `ChainCtx` already threads the set · add `MergePolicy` to
`Collection` · make `reduce()` dispatch list-fold vs recursive-fold. Then `withSack`'s identical decline
takes the same object.

### Phase 4 — `group("a")`/`groupCount("a")` join the mechanism. **13 scenarios.**

Store keyed member rows plus the reducer; run `groupBarrier` at the `cap`. `registerMap` disappears into
`registerCollection`, and multi-site `group("a")` falls out for free. **Measured: 13 named-group/groupCount
scenarios that no spine holds, disjoint from Phase 7** — the second-largest item, which this plan previously
did not quantify at all. (Single-site `group("a")` already routes; what is missing is the unification and the
multi-site case.)

⚠️ **It is also what lifts the last two `ctx.mutating` declines, and a second snapshot is NOT the way.** A
keyed form registers a grouping barrier's relation, which is a one-row JSONB map payload — and a retained
binding travels as JSON, which fails closed on exactly that (root `CLAUDE.md`: a `RETURNING` feeding a
retained binding projects `json(x)`, never `jsonb`). Once the keyed forms hold `(key, value-contribution)`
MEMBER rows, they take the aggregate sites' binding unchanged.

⚠️ **A group's VALUE reducer is not the collection's merge operator.** Keep them apart: the member is
`(key, value-contribution)` and the group reduction runs over the union.

### Phase 3b — mixed member SHAPES through the variant

Two sites contributing different element KINDS (edge members beside vertex members), or an element beside a
value. `ListOf` has no mixed arm, so this is NOT `mergeArms` reused: it is a member-level tagged union one
level BELOW the stream-level variant, and the wire framer has to read it. One corpus scenario; otherwise
combinatorial completeness.

### Phase 2b — the reduction a `cap().unfold()` never needed

Still emitted today (verified: `cap("a").unfold()` folds into a JSONB array and immediately `json_each`s it
back). With members held pre-fold the answer is the member relation itself.

⚠️ **The question it must answer is not rhetorical:** the fold pins member order with `Agg.orderBy` on the
encounter channel, while the member relation carries that channel but no `ORDER BY`. So the cancellation is
sound only where the consumer does not depend on the list's order, and **`mise run test:perturbed`, not the
corpus, is what decides that.** Cancelling into an ordered movement is the conservative form.

### The 3 remaining multi-site failures, and none is a collection gap

Re-verified 2026-08-11 — these are what is left of the nine, each blocked elsewhere: a
`by(__.inE("created").values("weight").sum())` site (a `by()` whose body is a numeric REDUCER has its type in
a `vt` column `byField` declines to supply — build plan Phase 2, and `by(count())` lowers where `by(sum())`
does not) · a `cap("a").unfold().path()` tail · one mixed-shape pair (Phase 3b).

### §8 — legacy's silent overwrite, and it is NOT unblocked

`steps/prefix/sideeffect.ts`'s last-write-wins is a silent wrong answer, which the project forbids outright.
Making it a refusal was **tried and reverted: it costs three L3 scenarios and a census row that NO spine then
holds.** §8's real precondition is "RelIR holds every shape legacy currently luck-passes", and that is four
independent features away:

| the luck-pass shape | why RelIR declines it |
|---|---|
| `…local(aggregate("a")).outE().inV().simplePath()…` | `simplePath()` |
| `…local(aggregate("a")).bothE().sample(1).otherV()…` | `sample()` |
| `…local(aggregate("a")).union(__.out(), __.in()).local(aggregate("a"))…` | `union()` declines when the stream carries an encounter channel (below) |
| `…by(__.outE("created").count())…by(__.inE("created").values("weight").sum())…` | the `by(<reducer>)` type gap |

Until then the L4 scenarios pin their spine with `@SpineRel` rather than `@RelIR` — `@RelIR` asserts that
legacy REFUSES, and legacy does not refuse, it answers wrongly. Making that tag honest is the same work.

### Two NEIGHBOURING gaps, neither a collection gap

Recorded because they are what a reader hits next in this space, and both shape the L4 scenarios.

1. **`union()` declines when the stream carries an encounter channel** (`unionArms`' `encounterOf` guard).
   Any chain ending in a collecting consumer demands an encounter, so `g.V().union(__.aggregate("a"), …)
   .cap("a")` declines at the UNION, not at the collection — which handles branch-arm sites fine. (Legacy
   then throws *"cap('a') references an undefined side-effect"*.) This is why no union-arm scenario is in the
   L4 feature.
2. **`count(Scope.local)` over an ELEMENT-membered list declines**; over a scalar-membered one it lowers. So
   an element collection's multiset SIZE cannot be asserted directly, and the L4 scenarios use
   `cap("a").unfold()` instead.

⚠️ Also still blocked and NOT Phase 5's: **`within(__.cap('a').unfold())`** declines at the `where` — the
predicate operand's label resolution is its own gap. Phase 5 was a precondition, not the whole of it.

---

## The reference — cite these rather than re-deriving

| Fact | Where |
|---|---|
| ONE `AggregateStep` in v4; "local" is an explicit `LocalStep` **wrapping** it, not a `Scope` arg | `GraphTraversal.java:3848` |
| Its constructor registers `(key, BulkSetSupplier, Operator.addAll)` — that is the DEFAULT policy | `AggregateStep.java:57` |
| `processAllStarts` drains one site into a `BulkSet` in encounter order, then merges the WHOLE set for `addAll`/`assign`, else **member-by-member** | `AggregateStep.java:124-153` |
| `sideEffects.add(k,v)` is `set(k, getReducer(k).apply(get(k), v))` — a seeded LEFT FOLD | `DefaultTraversalSideEffects.java:88-91` |
| `BulkSet` is a `LinkedHashMap`-backed **multiset**; `cap` returns it raw | `BulkSet.java`, `SideEffectCapStep.java:96-105` |
| **Side effects live on the ROOT traversal** — a step in a `union()` arm resolves to the same map | `AggregateStep.java:57` |
| **ORDER IS NOT PINNED** — every scenario reading a capped collection asserts `the result should be unordered`; there is no `ordered` assertion touching `aggregate`/`cap` | `sideEffect/Aggregate.feature`, `filter/Aggregate.feature` |
| A **`Set` seed makes `addAll` DEDUP** | `Aggregate.feature:279-563` |
| `repeat` refills the same label per iteration — each vertex appears twice | `Aggregate.feature:743-763` |

**Therefore:** N sites accumulate, the result is a multiset, and the order is free — so a plain `UNION ALL` of
member relations is the correct lowering and no interleave-by-encounter is required.

---

## ⚠️ Traps that still guard unbuilt work

1. **The order is a LICENCE, not an obligation.** Do not invent a total order across sites to be safe; do not
   assume one either.
2. **`withLossyFlag` is a WHOLE-RELATION decision** (a `MAX(…) OVER ()`), so it must see every site's
   members. Per-site gives a silently inconsistent member encoding — which is exactly why it belongs at the
   read.
3. **The `by()` projection is correlated and STAYS at the write site.** Only the FOLD moves. Moving the
   projection would evaluate `by(__.outE("created").count())` against the wrong traverser.
4. **A `Set` seed dedups and a non-`addAll` operator merges member-by-member** — both Phase 7. Until it
   lands the `reducers` decline must stay, or a declared seed is silently dropped.
5. **A rooted body is correlated to NOTHING.** Registering inside one and reading outside is fine, and so is
   the reverse (side effects are root-global). What is NOT fine is a rooted body whose member relation
   references the outer chain's rows — `checkPlan`'s scope check catches it and must keep catching it.
6. **`checkPlan` THROWS rather than declines**, so any binding mistake is RelIR erroring where legacy
   answers. `mise run rel-sweep` is the instrument that finds it; it must stay at 0.
7. **Chain-position `union`/`choose` arms already share the map**, so both arms registering one label
   ACCUMULATE. That is the reference's answer, and it was a behaviour change from the old decline — the
   corpus has no such scenario, so it lives in L4.

---

## Pointers

`docs/2026-08-01-relir-build-plan.md` — §6·5 (the two reasons a `null` is spelled), §6·6 (a fact the route
drops reads as a missing lowering), §3.0 (a named CTE and a prior result are one concept), and Phase 2's gap
list, which owns the `by(<reducer>)` type gap and the sack merge policy this shares.
