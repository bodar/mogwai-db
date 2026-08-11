# A NAMED COLLECTION IS A BOUND RELATION, REDUCED AT THE READ

_Status: **Phases 1, 2, 3a, 5, 6 and 7 LANDED (7 in full); Phase 4's SUBSTRATE landed and its remaining
scenarios are each blocked in another feature.** Open: **3b**, **2b**, **§8**, and the three named
downstream gaps under Phase 4. Numbers re-validated 2026-08-11 against `l3-state.json` +
`scenarios.tsv`; absolute L3 floors are deliberately not quoted (they move for unrelated reasons — read the
instruments). **Read this before touching `src/compiler/rel/collection.ts`.**_

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
- **7 — a merge policy, in FULL** (`src/compiler/rel/operator.ts` + `seededFold`/`seedAsSite`/`lastMember`)
  — **+26 L3**, plus `test/L4-addendum/aggregate-merge-policy.feature` for the compositions the corpus
  never asks (it covers exactly one shape per operator). Its own section is next, because what it settled
  is worth reading before re-opening any of it.
  ✅ **It also discharged a THIRD plan's item and TWO latent defects.** `SackSpec` and the policy are now
  ONE object (`MergePolicy` — a seed `Arg` plus an operator, which is how TinkerPop registers both); the
  value+`initType` pair it replaced could not carry the seed's wire-parameter NAME, so `withSack($x)`
  inlined where the bind rule says it binds. A `Recursive` REWRITE used to defer its TERM into the
  returned closure, so `name`'s binding push landed after `plan()` had copied the list — a `Ref` in the
  term with no binding in the plan at all (`src/rel/walk.ts`, `mapRelChildren`); reachable from any term
  holding a shared subtree, and a seeded fold over a multi-site collection was just the first one built.
  And `continueAs`'s list arm DROPPED `framing.set`, turning every set that re-entered through the
  dispatcher back into a list — a wrong wire CLASS, since GraphBinary spells List and Set differently.

- **4 — a keyed grouping is MEMBER ROWS, so N sites merge PER KEY** (`groupRows`/`groupMap`, `map.ts`;
  the `grouped` `Members` arm). `group("a")`/`groupCount("a")` are `SideEffectBarrierStep`s — the map is
  read back at the `cap`, so it cannot be built where the step is, and a stored map has already
  discarded which rows came from where. Same argument as `aggregate`, one container along. The merge is
  then Phase 2's machinery unchanged: a `UNION ALL` of `(key, contribution)` rows reduced once.
  ⚠️ **It moved NEITHER L3 nor the census, and that is the finding, not a disappointment.** Every
  scenario the merge would answer is blocked further along its own chain (see below), so
  `test/L4-addendum/group-multi-site.feature` is the only place it is asserted at all — which is
  `legality-not-corpus-defines-support` applied exactly.
  ✅ The `reduced` arm SURVIVED, and its status changed: it is not transitional after all. A POOLED value
  (`by(<reducing traversal>)`) has no `(key, contribution)` row behind it — the members' child rows pool
  and the barrier reduces the pool once — so it is single-site BY CONSTRUCTION. That is what "this shape
  genuinely has no member relation" looks like, and deleting the arm cost a scenario before the census
  caught it.

---

## Phase 7, in full — the closed one worth reading before re-opening any of it

`COLLECTION_OPS` (`src/compiler/rel/operator.ts`) is `FOLD_OPS ∪ BULK_OPS`: every `Operator` the Gremlin
string grammar can name except `sumLong`, which is `add` narrowed by a cast nothing has asked for. The
three mechanisms, so a reader does not go looking for one function:

| the reference's branch | ours |
|---|---|
| member-by-member (`bulkSet.forEach(p -> add(k, p))`, `AggregateStep.java:150`) | `seededFold` — a `Recursive` left fold |
| `addAll` with the site's whole `BulkSet` (`:148`) | `seedAsSite` — the seed's items as SITE 0, then the ordinary list fold |
| `assign` with the site's whole `BulkSet` (`:148`) | the LAST site, and `lastMember` when that site's barrier held one traverser |

Three facts it is worth not re-deriving:

1. **The CONSTANT form declares a policy too.** `registerIfAbsent` keeps whichever SUPPLIER was
   registered first and fills in only a MISSING reducer (`DefaultTraversalSideEffects.java:110-119`), so
   `withSideEffect("a", {"alice"}).V()…aggregate("a")…cap("a")` is seed `{"alice"}` merged by `addAll` with
   no `Operator` written anywhere. Reading only the reducer form was a WRONG ANSWER (a twelve-member
   duplicated list where `Aggregate.feature:171-180` asks for a deduped set), which is why
   `sideEffectPolicies` reports both forms and the DEFAULT operator is applied by the consuming step.
2. **The SITE's granularity is recorded by the pass that erases it.** `inlineIdentityHostBody` splices
   `local`/`map`/`flatMap` away — correct for the eight folding operators, unrecoverable for `assign` —
   so it marks the spliced steps (`Step.perTraverser` / `ranPerTraverser`). Do not try to re-derive it
   in `collection.ts`; by then the wrapper is gone.
3. **`withSack(seed, Operator)` is NOT this work and the shared object was never what blocked it.**
   Measured at the pin: all of `sideEffect/Sack.feature:294`, `:306`, `:321`, `:347` carry a `barrier()`
   or `barrier(Barrier.normSack)`, and two also carry `withBulk(false)`. The declared operator decides
   how two traversers' sacks combine when a BARRIER merges them — a `CHANNEL_MERGE_POLICY` answer
   (`src/channels.ts` says `identical` today) plus a `normSack` step. `seedSack` reads the shared
   `MergePolicy` and still declines on `spec.operator !== undefined`. Do not re-file them here.

Two neighbouring shapes stay refused, and both are refusals rather than gaps:

- **a SCALAR constant on an aggregated label** — `addAll(1, bulkSet)` is the reference's own
  IllegalArgumentException ("Objects must be both of Map or Collection"), so answering the members and
  pretending the seed was not there would be the wrong answer this phase removed.
- **a declared policy on a KEYED label** (`registerMap`) — a seeded `group("a")` accumulates INTO the
  declared map, and that is Phase 4's.

One scenario looks like this phase's and is not: `Aggregate.feature`'s second set-seed scenario supplies
the side effect through the cucumber harness (`using the side effect a defined as "s[]"`) rather than in
the traversal. That is a WIRE question — nothing carries a client-supplied side effect into a compile.

---

## 🚧 What is LEFT

### Phase 4's residue — three DOWNSTREAM gaps, none of them the collection's

The substrate landed (above). What is left of the "13 scenarios" is a list of OTHER features, and the
ranking is the point — **do not come back here looking for collection work**:

| gap | scenarios | what it is |
|---|---|---|
| `select(Column.keys)` over an ELEMENT-keyed map | 1 + unblocks the splice | `entrySide`/`sideList` decline an `elem` side, deliberately: the blob holds a `{t:'vertex', v:{…}}` node and the SCALAR framer would emit it as a JSON string (`map.ts`'s own comment) |
| `count(Scope.local)` over a MAP | 3 | the list/map local-reducer vocabulary — `select("a").count(local)` counts ENTRIES |
| `repeat(groupCount("m")…)` bodies | 4 | the unroll's admitted-body set. An unrolled body IS N sites, which now WORKS, so this is the same discharge Phase 2 gave `aggregate` — admit the keyed forms and measure |
| a declared policy on a keyed label | 1 | a seeded grouping accumulates INTO the declared map (`GroupBiOperator` merges maps). `registerGrouping` declines rather than dropping the seed |
| `union`/`choose` arms, `barrier()` mid-chain, `subgraph`/`tree` | rest | their own features |

#### The one admission that is READY, and has now been tried and reverted TWICE

A KEYED `group("a")`/`groupCount("a")` **is a stream identity** — `GroupSideEffectStep` and
`GroupCountSideEffectStep` both extend `SideEffectBarrierStep`, whose `processAllStarts` calls
`sideEffect(traverser)` and re-adds the traverser unchanged
(`vendor/tinkerpop/gremlin-core/.../step/sideEffect/SideEffectBarrierStep.java:49-57`), which is
`AggregateStep`'s contract exactly. So `local(groupCount("a"))` IS `groupCount("a")` and belongs in
`isStreamIdentity` (`ir/strategies.ts`) beside `aggregate`, gated on the LABEL — a bare
`group()`/`groupCount()` is a `ReducingBarrierStep` that replaces the stream, so `local(group().by(…))`
is emphatically not its body. The change is six lines and it is written out in the git history of
2026-08-11.

**Reverted twice, and each time for a different blocker — record the SECOND one, because the first is
gone.** Attempt 1: multi-site keyed groups did not exist, so RelIR declined at the second registration
and legacy's last-write-wins answered a plausible half. Attempt 2 (after the substrate landed): the
scenario continues `…cap("a").select(Column.keys).unfold().both().local(groupCount("a")).cap("a")`, and
RelIR declines at `select(Column.keys)` over an ELEMENT-keyed map — so the chain still reaches legacy,
which still answers one site. Both times the splice turned a clean DEFERRAL into a wrong answer and the
census caught it (`ran` +1 with no answer-change flag, which is the one transition that gate cannot see
— check the `spine` column when `ran` rises).

⚠️ **So the order is fixed: element-keyed `select(Column.keys)` FIRST, then the admission.** On its own
the admission still fixes zero scenarios — the other `local(group…)` bodies contain a `select`/
`count(local)`, which are not identities.

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
4. **A merge policy is spent at the READ, and every shape of it is now built** — so the thing to keep
   true is the DIRECTION, not a decline: `Members` says what a member is, the policy says how members
   combine, and neither may start answering the other's question. The `Set` seed is the case that proves
   it — its dedup is a member-relation rewrite (`firstOccurrences`) and its set-ness is a FRAMING marker,
   two different layers for one word.
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
