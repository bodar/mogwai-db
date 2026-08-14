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

## ✅ What already exists (the substrate)

A `Collection` holds MEMBER rows, not a folded list; `reduce()` at the `cap` is the ONE place its fold is
chosen. `Collection.sites` is a chain-ordered list reduced to a `UNION ALL` at the read, so sites stay APART
until then (which keeps the reference's order expressible). Member TYPES meet per-value
(`meetScalarTypes`/`withMergedVtype`, shared with branch arms). A rooted sub-chain inherits `collections` (a
side effect lives on the ROOT, `AggregateStep.java:57`). A site is a `snapshot` Binding, so a collection
survives a mutating chain. The merge policy is built in FULL (its own section below). A keyed
`group("a")`/`groupCount("a")` is `(key, contribution)` MEMBER ROWS merged per key (`groupRows`/`groupMap`,
`map.ts`, the `grouped` `Members` arm) — same argument as `aggregate`, one container along.

Learnings from that substrate, worth not re-deriving:

- ✅ **An unrolled `repeat()` body IS N sites.** The unroll's admitted-body set had excluded side-effect steps
  on the belief that "accumulation ACROSS phases" needed its own argument; multi-site accumulation IS that
  argument, so `aggregate` and the keyed groupings joined `UNROLLABLE_BARRIERS` with nothing crossing a phase
  boundary. `g.V().repeat(__.aggregate("a")).times(2).cap("a").unfold()` returns each vertex TWICE
  (`Aggregate.feature:743-763`).
- ✅ **The substrate moved nothing; the PASS that then used it moved +6 L3.** Watch the shape of that win — a
  compounding lesson, not a headline for the merge machinery itself.
- ✅ **The `reduced` arm is NOT transitional — do not delete it.** A POOLED value (`by(<reducing traversal>)`)
  has no `(key, contribution)` row behind it (child rows pool, barrier reduces once), so it is single-site BY
  CONSTRUCTION. Deleting it cost a scenario before the census caught it.
- ⚠️ **The keyed merge moved NEITHER L3 nor the census on its own, and that is the finding, not a
  disappointment.** Every scenario it answers is blocked further along its own chain, so
  `test/L4-addendum/group-multi-site.feature` is the only place it is asserted —
  `legality-not-corpus-defines-support` applied exactly.
- ⚠️ *Read a decline's REASON, not its date* — the stale "side effects can't unroll" claim outlived its truth
  in two other docs by two days.

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
  the seed was not there would be the wrong answer this phase removed.
- **a declared policy on a KEYED label** (`registerMap`) — a seeded `group("a")` accumulates INTO the declared
  map, which is Phase 4's (below).

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

## 🚧 What is LEFT — in compounding-substrate order

Ranked by what a gap UNLOCKS, not by L3 gain: substrate that opens other families first, leaf gaps last. None
of it is collection work — the collection substrate is done.

### Substrate — each unlocks several, do these first

**Element-keyed `select(Column.keys)`** — ✅ LANDED (keys; `Column.values` still pending, below), and the fix
was DEEPER than the framing tweak this bullet first guessed. The real defect was a PREMATURE FOLD: `cap`
folded the grouping into a JSONB map, which expands each element key to a PUBLIC `COALESCE(uid,id)` payload —
and the map blob is framed in JS (`execute.ts`), which cannot expand a rowid back, so the key node had to be
pre-expanded, LOSING the rowid the graph is keyed by. That is fatal for the admission's
`select(Column.keys).unfold().both()` (`GroupCount.feature:212`): the keys must MOVE, and movement needs the
rowid — the same reason element LISTS keep rowids-until-root (`list.ts` `unfoldList`). Both references agree
(TinkerPop keys are live `Vertex` objects; Calcite key-selection is a projection over `(key,agg)` rows), as
does this doc's own thesis. So the fold is now CONSUMER-DRIVEN: `cap` recognises a following
`select(Column.keys)` and projects the DISTINCT key rowids straight off the member rows into a Set
(`collection.ts` `groupedKeys` + the `cap` lookahead in `lower.ts`), which moves natively. Asserted in
`test/compiler/grouped-keys.exec.test.ts`; L3/census did not move because the direct corpus scenario is gated
further along by the admission below (`legality-not-corpus-defines-support`). **This generalises Phase 2b
(cancel a fold the consumer never needed) and is the substrate the remaining `cap` reads should follow.**

**The ready admission: `local(group("a"))`/`local(groupCount("a"))` as a stream identity** — ✅ LANDED. A
KEYED `group("a")`/`groupCount("a")` IS a stream identity: `GroupSideEffectStep`/`GroupCountSideEffectStep`
both extend `SideEffectBarrierStep`, whose `processAllStarts` re-adds the traverser unchanged
(`vendor/tinkerpop/gremlin-core/.../step/sideEffect/SideEffectBarrierStep.java:49-57`), which is
`AggregateStep`'s contract exactly. So `local(groupCount("a"))` IS `groupCount("a")` — now in
`isStreamIdentity` (`ir/strategies.ts`) beside `aggregate`, gated on the LABEL; a bare `group()`/`groupCount()`
stays a `ReducingBarrierStep` that replaces the stream. Its merge (count / `GroupBiOperator`) is
granularity-invariant, so `local()`'s per-traverser barrier is safe (unlike `assign`).

It had been reverted TWICE, and BOTH blockers are now gone: (1) multi-site keyed groups (landed earlier);
(2) the continuation `…cap("a").select(Column.keys).unfold()…` declining over an element-keyed map — fixed by
the consumer-driven fold above. The historic hazard (admitting the splice let the chain answer a plausible
half instead of declining) was checked directly: the admission scenario `GroupCount.feature:212` answers
EXACTLY `{marko:6,vadas:2,lop:6,josh:6,ripple:2,peter:2}` (matches TinkerPop), and the census re-record moved
exactly ONE traversal deferred→ran with zero golden answers changed. L3 1546→1547.

**Branch-arm collection sites** — ✅ LANDED. The `union()`-declines-on-an-encounter-channel guard this
bullet described is gone: `union`/`choose` merge a FRESH UNORDERED stream, dropping the spent encounter and
minting a deterministic one only where a downstream collecting/positional consumer demands it
(`withFanoutOrder`, the branch-emission-order substrate), so `g.V().union(__.aggregate("a"), …).cap("a")`
compiles. The remaining neighbour was `coalesce`: a non-final arm needs a "produced nothing" predicate and
`alwaysProduces` reads the LAST step alone, so a pure side-effect arm (`aggregate("a")`, labelled
`groupCount("a")`, `sideEffect(…)`, `identity()`) was not seen as always-firing and `coalesce` declined —
fixed by a whole-body `isStreamIdentity` check (`coalesceArms`, `lower.ts`). Asserted in
`test/compiler/branch-collection-sites.exec.test.ts`; no corpus scenario has the shape, so L3/census did not
move (`legality-not-corpus-defines-support`).

**`count(Scope.local)` — the local-reducer vocabulary.** ✅ LANDED. Over a MAP it counts ENTRIES (already
worked). The gap was an ELEMENT-membered list: `listRetype` declined every non-bare list up front, but
`count(Scope.local)` never reads a member's VALUE — it counts members via `membersOf` regardless of kind — so
it now answers BEFORE the bare-list gate (which the value reducers still need). `aggregate("a").cap("a").count(Scope.local)`
reports the multiset size directly (`g.V().both().aggregate("a").cap("a").count(Scope.local)` = 12). Asserted
in `test/compiler/count-local-members.exec.test.ts`.

### Member/variant substrate

**Phase 3b — mixed member SHAPES through the variant.** ✅ LANDED. Two sites contributing different element
KINDS (an edge site beside a vertex site), or an element beside a value, now accumulate into a MIXED
collection rather than declining (`accumulate`, `collection.ts`). The design turned out SIMPLER than a
"member-level variant that the framer must learn": the wire's `frameTypedNode` (`execute.ts`) already frames
ANY self-describing `{t,v}` node — a vertex, an edge, a scalar leaf — so the whole of the wire change was
routing a new `ListOf.mixed` arm to it (`listItemBuffers`). The ALGEBRA work is the real content: a mixed
`UNION ALL` shares ONE member column, where a bare rowid is indistinguishable from a scalar, so
element-until-root cannot hold — each element expands to its `{t,v}` envelope AT THE SITE (`envelopeSites`,
`elementNode`), the one place that rule is suspended, and each scalar to `typedNode` with its own tag. `cap`
folds the envelope column like any typed list; `count(Scope.local)` counts members regardless of kind.

`cap("a").unfold()` over a mixed collection emits one traverser PER MEMBER, each framed by its own tag — a
new per-row `typedNode` framing (`framing.ts`/`render.ts`), distinct from the stream-level `variant` because
a self-describing envelope preserves a per-member scalar TYPE (a uuid/datetime member) that `variant`'s single
static scalar arm would infer away (§6·7). It is TERMINAL for the variant's reason: a stream that is a vertex
on one row and an edge on the next has no uniform continuation, so a follower declines. No corpus scenario
mixes kinds into one label directly (the multi-site aggregate scenarios use edge steps only as MOVEMENTS
between vertex sites, so the label stays homogeneous — `elements`, not `mixed`), so this moved neither L3 nor
the census; it is asserted in `test/L4-addendum/mixed-collection.feature` and
`test/compiler/mixed-collection.exec.test.ts` (`legality-not-corpus-defines-support`).

### Leaf gaps — one thing each, no downstream unlock

**A declared policy on a KEYED label.** A seeded `group("a")` accumulates INTO the declared map
(`GroupBiOperator` merges maps); `registerGrouping`/`registerMap` declines rather than dropping the seed. One
scenario.

**Phase 2b — the reduction a `cap().unfold()` never needed.** Still emitted (`cap("a").unfold()` folds into a
JSONB array and immediately `json_each`s it back); with members held pre-fold the answer is the member
relation itself. ⚠️ **The question it must answer is not rhetorical:** the fold pins member order with
`Agg.orderBy` on the encounter channel, while the member relation carries that channel but no `ORDER BY`. So
the cancellation is sound only where the consumer does not depend on the list's order, and **`mise run
test:perturbed`, not the corpus, is what decides that.** Cancelling into an ordered movement is the
conservative form.

**`within(__.cap('a').unfold())`** — ⚠️ declines at the `where`; the predicate operand's label resolution is
its own gap (Phase 5 was a precondition, not the whole of it). NOT a collection gap.

**The 2 remaining multi-site failures — each blocked elsewhere.** What is left of the original nine (the
mixed-shape pair is now Phase 3b, landed): a `by(__.inE("created").values("weight").sum())` site (a `by()`
whose body is a numeric REDUCER has its type in a `vt` column `byField` declines to supply — build plan
Phase 2; `by(count())` lowers where `by(sum())` does not) · a `cap("a").unfold().path()` tail. Neither a
collection gap.

**Owned by their own features:** `union`/`choose` arms, `barrier()` mid-chain, `subgraph`/`tree`.

### Capstone — the shapes still not covered

**The silent-overwrite problem is discharged by the single-spine cut.** The wrong answer this was once a
capstone over — a last-write-wins that answered a plausible half of a multi-site label — is gone with the
second spine it lived in. A multi-site shape the lowering does not cover now raises `UnsupportedTraversal`, the
fail-closed answer, not a quiet wrong one. What is LEFT is COVERAGE: the shapes below still decline, each
blocked in a DIFFERENT substrate four features away.

| shape | why the lowering declines it |
|---|---|
| `…local(aggregate("a")).outE().inV().simplePath()…` | `simplePath()` |
| `…local(aggregate("a")).bothE().sample(1).otherV()…` | `sample()` |
| `…by(__.outE("created").count())…by(__.inE("created").values("weight").sum())…` | the `by(<reducer>)` type gap |

(The `…union(__.out(), __.in()).local(aggregate("a"))…` row is GONE — branch-arm sites now compile;
`g.V().local(aggregate("a")).union(__.out(),__.in()).local(aggregate("a")).cap("a").unfold().count()` = 18.)

So `test/L4-addendum/group-multi-site.feature` is where the keyed merge is asserted at all: the corpus's one
multi-site scenario is unreachable until the element-keyed `select(Column.keys)` above lands.

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
   assume one either.
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
