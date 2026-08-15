# A NAMED COLLECTION IS A BOUND RELATION, REDUCED AT THE READ

**Read this before touching `src/compiler/rel/collection.ts`.** Coverage and L3 floors move for
unrelated reasons — read the instruments (`l3-state.json`, `scenarios.tsv`), never a number quoted here.

## The thesis

`aggregate("a")` does not build a value; it **retains a relation under a name**. `cap("a")` is what turns
that relation into a traverser. Everything follows from moving the reduction from the WRITE site to the READ
site — where TinkerPop puts it (`SideEffectCapStep.generateFinalResult`) and where our own plan vocabulary
already had a word for it (`Binding`).

Folding at the `aggregate` is defensible for ONE site and does not survive contact with a second: `Map` keeps
the last entry, so the first site's members are silently discarded. **That was a wrong ANSWER, not a gap** —
which is why the reduction moved to the cap, and why a shape the fold cannot serve declines
(`UnsupportedTraversal`) rather than folding at the first site and dropping the rest.

---

## The substrate (what a `Collection` IS)

A `Collection` holds MEMBER rows, not a folded list; `reduce()` at the `cap` is the ONE place its fold is
chosen. `Collection.sites` is a chain-ordered list reduced to a `UNION ALL` at the read, so sites stay APART
until then (which keeps the reference's order expressible). Member TYPES meet per-value
(`meetScalarTypes`/`withMergedVtype`, shared with branch arms). A rooted sub-chain inherits `collections` (a
side effect lives on the ROOT, `AggregateStep.java:57`). A site is a `snapshot` Binding, so a collection
survives a mutating chain. The merge policy is built in FULL (its own section below). A keyed
`group("a")`/`groupCount("a")` is `(key, contribution)` MEMBER ROWS merged per key (`groupRows`/`groupMap`,
`map.ts`, the `grouped` `Members` arm) — same argument as `aggregate`, one container along. Mixed-kind
labels are the `mixed` `Members` arm (self-describing `{t,v}` envelopes; `envelopeSites`).

Facts worth not re-deriving:

- **An unrolled `repeat()` body IS N sites** — `aggregate`/the keyed groupings are in `UNROLLABLE_BARRIERS`
  with nothing crossing a phase boundary. `g.V().repeat(__.aggregate("a")).times(2).cap("a").unfold()`
  returns each vertex TWICE (`Aggregate.feature:743-763`).
- **The `reduced` arm is NOT transitional — do not delete it.** A POOLED value (`by(<reducing traversal>)`)
  has no `(key, contribution)` row behind it (child rows pool, barrier reduces once), so it is single-site BY
  CONSTRUCTION. Deleting it cost a scenario before the census caught it.
- **The keyed merge is asserted in `test/L4-addendum/group-multi-site.feature` alone** — every corpus
  scenario it answers is blocked further along its own chain (`legality-not-corpus-defines-support`).

---

## The merge policy (Phase 7), settled — read before re-opening any of it

`COLLECTION_OPS` (`src/compiler/rel/operator.ts`) is `FOLD_OPS ∪ BULK_OPS`: every `Operator` the Gremlin
string grammar can name except `sumLong`, which is `add` narrowed by a cast nothing has asked for. Three
mechanisms, so a reader does not go looking for one function:

| the reference's branch | ours |
|---|---|
| member-by-member (`AggregateStep.java:150`) | `seededFold` — a `Recursive` left fold |
| `addAll` with the site's whole `BulkSet` (`:148`) | `seedAsSite` — the seed's items as SITE 0, then the ordinary list fold |
| `assign` with the site's whole `BulkSet` (`:148`) | the LAST site, and `lastMember` when that site's barrier held one traverser |

Three facts worth not re-deriving:

1. **The CONSTANT form declares a policy too.** `registerIfAbsent` keeps whichever SUPPLIER was registered
   first and fills only a MISSING reducer (`DefaultTraversalSideEffects.java:110-119`), so
   `withSideEffect("a", {"alice"}).V()…aggregate("a")…cap("a")` is seed `{"alice"}` merged by `addAll` with no
   `Operator` written anywhere. `sideEffectPolicies` reports both forms and the consuming step applies the
   DEFAULT operator. (Reading only the reducer form gave a twelve-member duplicated list where
   `Aggregate.feature:171-180` asks for a deduped set.)
2. **The SITE's granularity is recorded by the pass that erases it.** `inlineIdentityHostBody` splices
   `local`/`map`/`flatMap` away — correct for the eight folding operators, unrecoverable for `assign` — so it
   marks the spliced steps (`Step.perTraverser`/`ranPerTraverser`). Do not re-derive it in `collection.ts`;
   by then the wrapper is gone.
3. **`withSack(seed, Operator)` is NOT this work and the shared object was never what blocked it.** Measured
   at the pin, all of `sideEffect/Sack.feature:294`,`:306`,`:321`,`:347` carry `barrier()`/
   `barrier(Barrier.normSack)`, two also `withBulk(false)`. The operator decides how two traversers' sacks
   combine when a BARRIER merges them — a `CHANNEL_MERGE_POLICY` answer (`src/channels.ts` says `identical`
   today) plus a `normSack` step. `seedSack` reads the shared `MergePolicy` and still declines on
   `spec.operator !== undefined`.

Two neighbouring shapes stay REFUSED, both refusals rather than gaps:

- **a SCALAR constant on an aggregated label** — `addAll(1, bulkSet)` is the reference's own
  IllegalArgumentException ("Objects must be both of Map or Collection"); answering the members and pretending
  the seed was not there would be the wrong answer this phase removed. (A LIST seed beside element/mixed
  members is DIFFERENT — `addAll` concatenates, so it folds to a mixed collection; only a scalar seed refuses.)
- **a declared policy on a KEYED label** (`registerMap`) — a seeded `group("a")` accumulates INTO the declared
  map. This is the one remaining feature (below), a multi-mechanism build left fail-closed.

One scenario looks like this and is not: `Aggregate.feature`'s second set-seed scenario supplies the side
effect through the cucumber harness (`using the side effect a defined as "s[]"`) rather than in the
traversal — a WIRE question; nothing carries a client-supplied side effect into a compile.

✅ **Phase 7 also discharged a THIRD plan's item and TWO latent defects.** `SackSpec` and the policy are now
ONE object (`MergePolicy` — a seed `Arg` plus an operator, which is how TinkerPop registers both); the
value+`initType` pair it replaced could not carry the seed's wire-parameter NAME, so `withSack($x)` inlined
where the bind rule says it binds. A `Recursive` REWRITE used to defer its TERM into the returned closure, so
`name`'s binding push landed after `plan()` had copied the list — a `Ref` in the term with no binding in the
plan at all (`src/rel/walk.ts`, `mapRelChildren`); reachable from any term holding a shared subtree, and a
seeded fold over a multi-site collection was the first one built. And `continueAs`'s list arm DROPPED
`framing.set`, turning every set that re-entered through the dispatcher back into a list — a wrong wire CLASS,
since GraphBinary spells List and Set differently.

---

## 🚧 What is LEFT

**The collection SUBSTRATE is DONE.** Every phase this doc planned has landed: multi-site accumulation, the
`snapshot` binding, the full merge policy, keyed `group`/`groupCount` merge, element-keyed
`select(Column.keys)`, `local(group("a"))` stream-identity, branch-arm sites, `count(Scope.local)` over a
member multiset, the MIXED member arm (Phase 3b — `ListOf.mixed`/`Members.mixed`, `envelopeSites`, the
per-row `typedNode` framing for `cap().unfold()`, and the list-seed-beside-non-scalar `addAll` case), and the
`cap().unfold()` fold-cancel (Phase 2b — `readUnfolded`/`capUnfolded`). Tests: `grouped-keys`,
`branch-collection-sites`, `count-local-members`, `mixed-collection`, `cap-unfold-cancel` (`test/compiler/`)
+ `mixed-collection`/`group-multi-site` (`test/L4-addendum/`). Nothing below is collection substrate.

### The one real remaining feature — a KEYED-label seed, left fail-closed

**A declared policy on a KEYED label is a multi-mechanism feature, NOT a leaf.** A seeded `group("a")`
accumulates INTO the declared map, and the one corpus scenario (`Group.feature:186`,
`withSideEffect("a",[marko:["666"],noone:["blah"]]).V().group("a").by("name").by(__.outE().label().fold()).cap("a").unfold().group().by(Column.keys).by(select(Column.values).order(local))`)
stacks four separate mechanisms: a MAP-seed parsed and merged PER KEY (`GroupBiOperator` concatenates value
lists per key — not the `(key,contribution)` member-row union this module has, but a map-level merge); a
`fold()` VALUE, i.e. the `reduced`/pooled arm (single-site), so the seed cannot be member rows; and a trailing
`group().by(Column.keys).by(select(Column.values).order(local))` that is its own gap. Even the simplest seeded
shape (`withSideEffect([marko:[999]]).V().group("a").by("name")`) produces a MIXED value list (an int seed
item beside vertices), which is mixed-members at the group-VALUE level that `map.ts` does not build. There is
no clean small slice; `registerGrouping` declining is the honest answer, not a punt. Building it is a real
feature, separate from this doc.

### Gaps owned by OTHER substrates — not collection work

| shape | blocked by |
|---|---|
| `…by(__.inE("created").values("weight").sum())…` | the `by(<reducer>)` type gap — a reducer-body's type rides in a `vt` column `byField` won't supply (RelIR build plan Phase 2; `by(count())` lowers, `by(sum())` does not) |
| `cap("a").unfold().path()` | the path substrate |
| `within(__.cap('a').unfold())` | predicate-operand label resolution at the `where` (Phase 5 was a precondition, not the whole of it) |
| `…local(aggregate("a")).outE().inV().simplePath()…` | `simplePath()` |
| `…local(aggregate("a")).bothE().sample(1).otherV()…` | `sample()` |
| `union`/`choose` arms, `barrier()` mid-chain, `subgraph`/`tree` | their own features |

**Fail-closed by design:** a multi-site shape the lowering does not cover raises `UnsupportedTraversal` (the
single-spine cut removed the last-write-wins that once answered a plausible half of a multi-site label).

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
| **ORDER IS NOT PINNED** — every scenario reading a capped collection asserts `the result should be unordered`; no `ordered` assertion touches `aggregate`/`cap` | `sideEffect/Aggregate.feature`, `filter/Aggregate.feature` |
| A **`Set` seed makes `addAll` DEDUP** | `Aggregate.feature:279-563` |
| `repeat` refills the same label per iteration — each vertex appears twice | `Aggregate.feature:743-763` |

**Therefore:** N sites accumulate, the result is a multiset, and the order is free — so a plain `UNION ALL` of
member relations is the correct lowering and no interleave-by-encounter is required.

---

## ⚠️ Traps that still guard unbuilt work

1. **The order is a LICENCE, not an obligation.** Do not invent a total order across sites to be safe; do not
   assume one either. (The `cap().unfold()` fold-cancel keeps this honest by MINTING the encounter from the
   site order, so it reproduces the fold's order rather than dropping it — `mise run test:perturbed` checks.)
2. **`withLossyFlag` is a WHOLE-RELATION decision** (a `MAX(…) OVER ()`), so it must see every site's members.
   Per-site gives a silently inconsistent member encoding — which is exactly why it belongs at the read.
3. **The `by()` projection is correlated and STAYS at the write site.** Only the FOLD moves; moving the
   projection would evaluate `by(__.outE("created").count())` against the wrong traverser.
4. **A merge policy is spent at the READ, and every shape of it is built** — so keep the DIRECTION, not a
   decline: `Members` says what a member is, the policy says how members combine, and neither may start
   answering the other's question. The `Set` seed proves it — its dedup is a member-relation rewrite
   (`firstOccurrences`) and its set-ness is a FRAMING marker: two layers for one word.
5. **A rooted body is correlated to NOTHING.** Registering inside one and reading outside is fine, and so is
   the reverse (side effects are root-global). What is NOT fine is a rooted body whose member relation
   references the outer chain's rows — `checkPlan`'s scope check catches it and must keep catching it.
6. **`checkPlan` THROWS rather than declines**, so a binding mistake surfaces as a hard error, never a quiet
   wrong answer. `mise run rel-sweep` is the instrument that finds it; it must stay at 0.
7. **Chain-position `union`/`choose` arms already share the map**, so both arms registering one label
   ACCUMULATE. That is the reference's answer, and a behaviour change from the old decline — no corpus
   scenario, so it lives in L4.

---

## Pointers

`docs/2026-08-01-relir-build-plan.md` — §6·5 (the two reasons a `null` is spelled), §6·6 (a fact the route
drops reads as a missing lowering), §3.0 (a named CTE and a prior result are one concept), and Phase 2's gap
list, which owns the `by(<reducer>)` type gap and the sack merge policy this shares.
