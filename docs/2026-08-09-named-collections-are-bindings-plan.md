# A NAMED COLLECTION IS A BOUND RELATION, REDUCED AT THE READ

_Status: **APPROVED, not started.** Written 2026-08-09 against trunk `87105cc`. Supersedes the
"registered twice → decline" rule in `src/compiler/rel/collection.ts` and the `ctx.mutating` decline
beside it. Read this before touching `collection.ts`._

## The one-sentence thesis

`aggregate("a")` does not build a value; it **retains a relation under a name**. `cap("a")` is what
turns that relation into a traverser. Everything this plan does follows from moving the reduction
from the WRITE site to the READ site — which is where TinkerPop puts it
(`SideEffectCapStep.generateFinalResult`) and where our own plan vocabulary already has a word for
it (`Binding`, `src/rel/plan.ts:27-66`).

Today `collection.ts` does the opposite: it folds at the `aggregate` and stores the folded list. That
choice is defensible for ONE site — the module header argues it at length and the argument is sound
*for one site*. It does not survive contact with a second one, and eight further things fall out of
fixing it.

---

## §0. The measurement that started this, and a WARNING about the instrument

`g.V().local(aggregate("a")).out().local(aggregate("a")).cap("a")` — the same label filled at two
chain positions.

- **RelIR declines** it: `registerCollection` returns `false` on `collections.has(label)`
  (`src/compiler/rel/collection.ts:94`), so the whole traversal routes to legacy.
- **Legacy MIS-EXECUTES it.** `register` is
  `({ ...st, sideEffects: new Map([...(st.sideEffects ?? []), [name, def]]) })`
  (`src/compiler/steps/prefix/sideeffect.ts:163-164`). `Map` keeps the LAST entry, so the first
  site's members are silently discarded. No guard, no message, no comment claiming it is intended.

**Measured against `test/L3-conformance/l3-state.json`: 9 of the 13 multi-site scenarios in
`sideEffect/Aggregate.feature` FAIL today, on BOTH spines.** The four that pass do so by luck — a
`dedup()`, `groupCount()`, `count()` or `simplePath()` downstream makes the lost members invisible.

```
FAIL g_VX1X_localXaggregateXaX_byXnameXX_out_localXaggregateXaX_byXnameXX_name_capXaX
FAIL g_V_localXaggregateXaX_byXoutEXcreatedX_countXX_out_out_localXaggregateXaX_byXinEXcreatedX_weight_sumXX_capXaX
FAIL g_V_localXaggregateXaXX_outE_inV_localXaggregateXaXX_capXaX_unfold_dedup
FAIL g_V_hasLabelXpersonX_localXaggregateXaXX_outXcreatedX_localXaggregateXaXX_capXaX
FAIL g_V_hasXname_markoX_localXaggregateXaXX_outXknowsX_localXaggregateXaXX_outXcreatedX_localXaggregateXaXX_capXaX   (3 sites)
FAIL g_V_hasLabelXsoftwareX_localXaggregateXaXX_inXcreatedX_localXaggregateXaXX_outXknowsX_localXaggregateXaXX_capXaX (3 sites)
FAIL g_V_localXaggregateXaXX_outE_hasXweight_lgtX0_5XX_inV_localXaggregateXaXX_capXaX_unfold_path
FAIL g_V_hasXname_joshX_…_localXaggregateXaXX_outE_…_inV_localXaggregateXaXX_outE_inV_localXaggregateXaXX_capXaX      (3 sites)
FAIL g_V_hasLabelXpersonX_localXaggregateXaXX_outE_order_byXweightX_limitX1X_inV_localXaggregateXaXX_capXaX
PASS ×4 (by luck — a dedup/groupCount/count/simplePath downstream hides the loss)
```

So this is an **outright L3 gain of ~9**, not a cut-only item.

> ✅ **THE RANKING INSTRUMENT IS FIXED — `mise run rel-blockers` now splits on the CONFORMANCE
> RESULT.** The throwaway it replaced (described in `docs/2026-08-01-relir-build-plan.md` §Phase 2)
> asked `compilePlan(q, {}, {spine:'legacy'})` whether legacy **compiles** a traversal, which is not
> the question of whether legacy **answers** it — and this family was the counter-example: every
> `aggregate` row it called "a REAL GAP the route answers" is one legacy compiles and silently
> mis-answers. The split is now `answered` / `open` / `unscored`, joined through the committed
> `test/L1-corpus/scenarios.tsv` (which scenario a traversal came from) against both floors in
> `l3-state.json`, plus an `L3` column counting the scenarios a family would newly put in reach.
> It reproduces this section unaided: `mise run rel-blockers --step aggregate` prints the nine
> multi-site rows as `open` and the four single-site ones as `answered`.

---

## §1. What is verified, so nothing below is re-derived

Every line here was read at trunk `87105cc`. Cite these rather than re-tracing.

### The current shape

| Fact | Where |
|---|---|
| `Collection = {rel, framing}` — the **already-folded** one-row/one-column relation | `src/compiler/rel/collection.ts:57-64` |
| `Collections = Map<string, Collection>`, minted fresh once per `lowerChain` | `collection.ts:64`, `lower.ts:3190` |
| `registerCollection` — folds via `foldTraversers`/`foldProjection`, then `collections.set` | `collection.ts:89-115` |
| `registerMap` — **no fold**; stores whatever `groupBarrier` built, framing `{kind:'map',…}` | `collection.ts:126-134` |
| `readCollection` — a bare `collections.get(label)`, handed to `continueAs` | `collection.ts:219-223` |
| The **only** two `readCollection` call sites (scalar tail, element tail) | `lower.ts:2283-2286`, `lower.ts:3503-3506` |
| The **only** other reader is `namedElsewhere` — an EXISTENCE check, never a value read | `lower.ts:2806-2807`, consumed at `record.ts:410` |
| `aggregate` register sites (scalar, element) | `lower.ts:2278-2282`, `lower.ts:3494-3499` |
| `group`/`groupCount` register sites (scalar, element) | `lower.ts:1924`, `lower.ts:3472` |
| `ctx.mutating` — a WHOLE-CHAIN fact, `steps.some(s => MUTATING_STEPS.has(s.name))` | `lower.ts:247`, `lower.ts:3191`, `ir/strategies.ts:220` |
| Four `if (ctx.mutating) return null` decline sites | `lower.ts:1923`, `2279`, `3471`, `3495` |

### The folds

| Fact | Where |
|---|---|
| `foldScalars` — one row, one `jsonb` column `LIST_COL`, `groupBy: []`, **`channels: []`** | `list.ts:678-719` |
| `foldElements` — same shape, member is the **rowid** | `list.ts:741-757` |
| **Element fold is round-trip LOSSLESS** — `unfoldList`'s `elem` arm CASTs the member back to `id` and hands back an ordinary element relation | `list.ts:583-614` |
| **Scalar fold is ONE-WAY** — `channels: []`, no origin column; there is no path back to the producing rows | `list.ts:678-719` |
| `aggregate(...).by(p)` is **always** the scalar arm, even over an element host | `collection.ts:158-206` |
| `listSetOp`'s `combine` arm = list concatenation: explode both, tag `seg`, `UNION ALL`, re-fold by `(seg, ord)` | `list.ts:938-951` |
| Member payload expansion happens ONCE, at the root | `list.ts:1086-1133` |

### Sharing — the fact that decides §6

| Fact | Where |
|---|---|
| `childSeam` closes over the SAME `ctx`, so chain-position `union()`/`choose()` arms, `by()` bodies, `map`/`flatMap`/`local` bodies and `choose().option()` arms all **share** one `Collections` map | `lower.ts:4344-4356`, `unionArms` `lower.ts:3864`, `chooseArms` `lower.ts:4259-4261` |
| `rootedRead` re-enters `lowerChain` and **does not forward `collections`** — every rooted sub-chain gets a fresh, empty map | `lower.ts:4543-4557` + `lower.ts:3190` |
| Consequence: `sourceUnion` arms are isolated from each other and from the outer chain | `lower.ts:3944-3959` |
| Consequence: `within(__.cap('a').unfold())` cannot see an outer `aggregate('a')` — the nested `cap` reads an empty map and declines | `list.ts:836-851` (`operandList` → `child.rooted`) |

### The Binding vocabulary — already built, already exercised

| Fact | Where |
|---|---|
| `Binding = {name, node: Rel \| Stmt, snapshot?, guard?}` | `src/rel/plan.ts:27-66` |
| `retained(b)` = `isStmt(b.node) \|\| b.snapshot === true \|\| b.guard !== undefined` | `plan.ts:103-104` |
| `runProgram` retains a snapshot binding's rows and resolves later `Ref`s from them | `src/program.ts:27-75` |
| `write.ts` already PRODUCES snapshot bindings: `nameBindings(...)` then push `{name, node, snapshot: true}` | `write.ts:149,152,161,199,204` |
| `checkPlan`/`checkSnapshots` **throws** if a plain binding is read by >1 step of a program with effects | `src/rel/check.ts:453-483` (message at `479-482`) |
| The `name` pass turns a node referenced twice in the DAG into a `Binding` + `Ref` | `src/rel/passes/name.ts:18-75` |

### The reference — what TinkerPop actually does

Cite these at the pin; they settle every semantics question below.

| Fact | Where |
|---|---|
| There is ONE `AggregateStep` in v4; "local" is an explicit `LocalStep` **wrapping** it, not a `Scope` arg | `vendor/tinkerpop/gremlin-core/.../dsl/graph/GraphTraversal.java:3848` |
| Its constructor does `registerIfAbsent(key, BulkSetSupplier, Operator.addAll)` | `.../step/sideEffect/AggregateStep.java:57` |
| `processAllStarts` drains into a local `BulkSet` in encounter order, then merges the WHOLE set when the reducer is `addAll`/`assign`, else **member-by-member** | `AggregateStep.java:124-153` |
| `sideEffects.add(k,v)` is `set(k, getReducer(k).apply(get(k), v))` | `.../util/DefaultTraversalSideEffects.java:88-91` |
| `Operator.addAll` does `a.addAll(b)` **in place** and returns `a` | `.../Operator.java:178-196` |
| `BulkSet` is a `LinkedHashMap`-backed **multiset** — repeat members bump a count in place, new members append | `.../step/util/BulkSet.java:43,131,148,217-243` |
| `cap('a')` returns the raw `BulkSet` (`AggregateStep` does not override `generateFinalResult`) | `.../step/sideEffect/SideEffectCapStep.java:96-105`, `Generating.java:36` |
| **Side effects live on the ROOT traversal** — a step nested in a `union()` arm resolves to the same map | `AggregateStep.java:57` (`this.getTraversal().getSideEffects()`) |
| **ORDER IS NOT PINNED.** Every scenario in `sideEffect/Aggregate.feature` and `filter/Aggregate.feature` that reads a capped collection asserts `the result should be unordered`. There is no `ordered` assertion anywhere touching `aggregate`/`cap`. | grep the two feature files |
| A seeded `withSideEffect` supplies the initial value and its `Operator` the merge; a **`Set` seed makes `addAll` DEDUP** | `Aggregate.feature:279-563`, `s[]`-seeded scenarios |
| `repeat` refills the same label per iteration — `g.V().repeat(__.aggregate("a")).times(2).cap("a").unfold()` expects each vertex twice | `Aggregate.feature:743-763` |

**Therefore:** two sites accumulate; the result is a multiset; the order is free. A plain `UNION ALL`
of member relations is the correct lowering, and no interleave-by-encounter is required.

---

## §2. The six decisions, answered for compounding rather than for size

| | Question | Answer | Why it is the compounding one |
|---|---|---|---|
| 1 | Fold at `cap`, or concatenate folded lists at each site? | **Fold at `cap`. A `Collection` holds MEMBER ROWS, not a list.** | Concatenating folded lists re-explodes JSON once per extra site and leaves two spellings of "a collection" in the code. Holding rows makes multi-site a plain `UNION ALL` of relations — the algebra's own node — and makes `cap().unfold()` cancel the fold entirely instead of folding then exploding. |
| 2 | Mixed member shapes across sites? | **Widen through the existing VARIANT.** | The dynamic-tag variant already merges mixed branch arms (`variant.ts`, `mergeArms`). A union of member relations with different tags is the identical problem. Declining would invent a second answer to a question the substrate already answers. |
| 3 | `group`/`groupCount` keyed form too? | **Yes — same mechanism.** Store the (key, value) member rows plus the reducer, run the barrier at `cap`. | This is the unification. `aggregate` and `group("a")` stop being two registries with two shapes and become one: *rows retained under a name, reduced at the read*. `registerMap`'s "no fold happens here" special case disappears. |
| 4 | Rooted sub-chains and source-position `union` | **Thread `collections` through `rootedRead`.** | The fresh-map isolation is not a scoping decision, it is **wrong vs the reference** — side effects are root-traversal-global. Fixing it unifies the rooted and correlated seams and unblocks `within(__.cap('a').unfold())`, `g.union(__.aggregate('x'), __.aggregate('x'))`, and every set-op operand naming a collection. |
| 5 | The `ctx.mutating` decline | **Delete it. A collection becomes a `snapshot` Binding.** | Once a collection IS a named relation, `snapshot: true` is one field, `write.ts` already produces exactly this shape, `runProgram` already honours it, and `checkPlan` already enforces it. The decline was a placeholder for machinery that shipped. |
| 6 | `withSideEffect(name, seed, Operator.x)` | **Build the merge POLICY.** | With the reduction at the read, a seed is an extra member row (for `addAll`) or an initial accumulator (everything else) and the `Operator` is the reducer. The same policy object serves `withSack(seed, Operator.x)`, which is the other decline the build plan calls "a merge POLICY, not a step" (§Phase 2 gap 6). Two declines die together. |

Legacy: **not protected.** Where the legacy floor sheds a name RelIR holds, that is legal (§6·1) and
expected. The one legacy change worth making is turning its silent overwrite into a decline (§8).

---

## §3. The target shape

```ts
/**
 * A NAMED COLLECTION — the rows the traversal RETAINED under a name, and how to reduce them.
 *
 * Not a value. `aggregate("a")` retains; `cap("a")` reduces. That split is the reference's
 * (`SideEffectCapStep.generateFinalResult`) and it is what lets N sites be a union of N relations
 * rather than N-1 list concatenations.
 */
export interface Collection {
  /** The MEMBER rows — one row per contributed traverser, never folded. */
  readonly members: Rel;
  /** What one member IS. Decides the reduction and the framing `cap()` hands to `continueAs`. */
  readonly of: Members;
  /** How contributions combine, and what the collection holds before any arrive. */
  readonly merge: MergePolicy;
}

/** A member is a traverser (aggregate) or a keyed pair (group/groupCount) — one union, so `cap()`
 *  stays shape-polymorphic through the one dispatcher it already uses. */
type Members =
  | { readonly kind: 'traverser'; readonly framing: RelFraming }
  | { readonly kind: 'keyed'; readonly keyOf: …; readonly valOf: … };

/** THE MERGE POLICY — shared with `withSack(seed, Operator.x)`. `addAll` into a BulkSet is the
 *  default `aggregate` registers when nothing else is declared (`AggregateStep.java:57`). */
interface MergePolicy { readonly seed?: Arg; readonly operator: 'addAll' | 'assign' | 'sum' | …; }
```

`readCollection` gains the reduction it was doing implicitly before:

```
cap("a")  →  reduce(collection)  →  continueAs(rel, framing, …)
```

and `reduce` is the ONE place `foldElements`/`foldScalars`/`groupBarrier` are called for a named
collection — instead of three call sites inside two register functions.

---

## §4. Phases

Each phase is independently green, independently committable, and states its own checkpoint. Run
`mise run ci` → `mise run test:legacy-spine` → commit → rebase → push → watch CI at every one
(`docs/2026-08-01-relir-build-plan.md` §The instruments).

### Phase 1 — ✅ LANDED. `Collection` holds members; the reduction moves to `cap`. NO coverage change.

Pure refactor. Single-site only; the `collections.has(label)` decline STAYS.

- `Collection` became `{members, of}` — `of` is the TOTAL `Members` union (`elements` / `scalars` /
  the transitional `reduced`), each arm carrying exactly the fold parameters its reduction asks for.
  ⚠️ **`merge` is NOT in it yet, deliberately.** With the `reducers.has(label)` decline still standing
  (Phase 7 is what lifts it) the policy has exactly one possible value, and a single-valued field
  claims a capability the decline right beside it refuses. It lands in Phase 7 where it can hold more
  than one answer.
- `registerCollection` stops folding. The `by()` PROJECTION still happens at the write site — it must,
  because `by(__.outE("created").count())` is correlated to the traverser that is there NOW — so
  `foldProjection` became `projectedMembers`, which is its projection half returning member rows.
- `readCollection` is now `collections.get` + `reduce()`, and `reduce()` is the ONE place a named
  collection's fold is chosen.
- `registerMap` still stores the built map, under the `reduced` arm (Phase 4 moves it).

Landed alongside, because the pair `{rel, framing}` was spelled inline FOURTEEN times and `reduce()`
would have been the fifteenth: `FramedRel` in `framing.ts`, with `Tail` extending it.

**Checkpoint — measured:** `mise run ci` green; L3, census `spine` (1202), `rel-only` and the legacy
floor (1692, 83 RelIR-only / 0 legacy-only) ALL unchanged, which is what a pure refactor owes.

⚠️ **`sql-hygiene` did NOT move, and the prediction that it would was wrong.** Phase 1 moves WHERE the
fold node is built, not WHETHER one is built: `cap("a").unfold()` still folds and then explodes. The
cancellation §6·7 describes — a `cap()` whose reduction is immediately unfolded IS the member rows —
is a real increment that this phase makes expressible for the first time, but it is its own change
with its own question (the members' row order versus the list's `Agg.orderBy`), not a side effect of
this one. Tracked as Phase 2b below rather than left as a trap.

**Trap:** the scalar fold is where `withLossyFlag` decides the member encoding (`list.ts:769-789`).
It is a whole-relation `MAX(...) OVER ()`, so it must run over the UNION of all sites' members, not
per site — which is exactly why it belongs at the read. Getting this wrong gives a list whose members
are inconsistently enveloped.

### Phase 2 — ✅ LANDED. Multi-site accumulation. **+7 L3.**

- The `collections.has(label)` decline is gone.
- `Collection.sites` is a LIST of `{rel, order}`, in chain order, and `reduce()` builds the
  `UNION ALL` at the read. Sites stay APART until then, which is what makes the reference's
  ordering expressible — a pre-merged relation has already lost which rows came from where.
- Member relations must agree on `of` (`sameMembers`); if they do not, DECLINE (Phase 3 lifts this).

**Checkpoint — measured:** L3 1775 → **1782**, census `spine` 1202 → **1208**, legacy floor unchanged
at 1692 (RelIR-only 83 → 90, legacy-only still 0). The census answer-change gate names exactly the six
traversals whose answer was WRONG, which is the evidence that the route was mis-executing them.
`sql-hygiene` banks one rise — `cap` bytes 2029 → 2656, traversals that used to decline now compiling.

**Six of §0's nine.** The other three are not Phase 2's: two are MIXED member shapes (a `by(count())`
site beside a `by(sum())` one; edge sites beside vertex ones) and go with Phase 3, and
`cap("a").unfold().path()` is a path tail.

**The ENCOUNTER trap, answered differently from the way this section first proposed.** Each site's
members carry that site's emission order and the two are not comparable — but the fix is not to drop
the channel. The reference drains one site's traversers into a `BulkSet` in encounter order and then
`addAll`s that WHOLE set (`AggregateStep.java:124-153`, `Operator.java:178-196`), so site 1's members
precede site 2's, and that order is free to reproduce: each arm projects its site ORDINAL beside its
own encounter, and the fold orders by the pair. Deliberately dropping it would have bought
nondeterminism that `mise run test:perturbed` would then have to police, in exchange for nothing.
The generalization that made it one line: `foldScalars`/`foldElements` take an ORDER COLUMN LIST
rather than one encounter column.

### Phase 2b — the reduction a `cap().unfold()` never needed.

`cap("a").unfold()` folds every member into one JSONB array and immediately explodes it again. With
members held pre-fold, the answer is the member relation itself — the element arm without the
round-trip through JSON that §6·7 names. This is the movement `sql-hygiene` was predicted to show in
Phase 1 and did not.

**The question it must answer, and it is not rhetorical:** the fold pins member order with
`Agg.orderBy` on the encounter channel; the member relation carries that channel but no ORDER BY. So
the cancellation is only sound where the consumer does not depend on the list's order, and
`mise run test:perturbed` — not the corpus — is what decides whether a given consumer does.
Cancelling into an ordered movement is the conservative form and is probably what this should be.

### Phase 3a — ✅ LANDED. Member TYPES meet; a tag disagreement is not a shape disagreement.

Two sites whose members are a String and an Integer do not disagree about what a member IS. They
meet at a per-value type, which is the answer two BRANCH ARMS already gave — so the pair that gave
it moved out of `lower.ts` and both callers now share it: `meetScalarTypes` (`render.ts`, beside
`sameScalarType`, which it now uses instead of a `JSON.stringify` comparison) and `withMergedVtype`
(`build.ts`). What stayed in `lower.ts` is the framing-level decline above the meet, which is about
`Tail`s and not about types.

**Checkpoint — measured:** L3 unchanged at 1782 and census unchanged at 1208, because the ONE corpus
scenario in this family is blocked by something else (below). The evidence is four new L4 scenarios
in `aggregate-multi-site.feature`, which fail without it.

⚠️ **The L3 scenario this was expected to close is blocked by a DIFFERENT gap.**
`aggregate("a").by(__.inE("created").values("weight").sum())` declines at the SINGLE site — a `by()`
whose body is a numeric reducer has its type in a `vt` column that `byField` declines to supply
(`collection.ts`'s `projectedMembers`, and gap 5 of the build plan's Phase 2 table). `by(count())`
lowers; `by(sum())` does not. So the multi-site half of that scenario was never what stopped it.

### Phase 3b — mixed member SHAPES through the variant. NOT STARTED.

Two sites contributing different element KINDS (edge members beside vertex members), or an element
and a value. `ListOf` has no mixed arm — a list's members are all elements, all scalars, or all
lists — so this is not `mergeArms` reused: it is a member-level tagged union, one level below the
stream-level variant, and the wire framer has to read it. Not corpus-driven beyond one scenario
(`g_V_hasXname_joshX_outE_localXaggregateXaXX_inV_…`); it is combinatorial completeness.

### Two NEIGHBOURING gaps this phase measured, neither a collection gap

Both were found writing the L4 scenarios, and both are why those scenarios are spelled the way they
are. Recorded here because they are what a reader will hit next in this space.

1. **`union()` declines when the stream carries an encounter channel** (`unionArms`, the
   `encounterOf(input.channels)` guard). Any chain ending in a collecting consumer demands an
   encounter, so `g.V().union(__.aggregate("a"), …).cap("a")` declines at the UNION — not at the
   collection, which handles branch-arm sites fine. This is why the union-arm scenario is absent
   from the L4 feature.
2. **`count(Scope.local)` over an ELEMENT-membered list declines**; over a scalar-membered one it
   lowers. So the multiset SIZE of an element collection cannot be asserted directly, and the L4
   scenarios use `cap("a").unfold()` instead.

### §8 IS NOT UNBLOCKED — measured, and it needs four other gaps first

The plan said to make legacy's silent overwrite a refusal once Phase 2 landed. **Tried, and reverted:
it costs three L3 scenarios and a census row that NO spine then holds**, which is exactly the
condition §8 itself names as the reason to wait. The four shapes are luck-passes whose collection
loss is invisible AND which RelIR declines for unrelated reasons:

| Scenario shape | Why RelIR declines it |
|---|---|
| `…local(aggregate("a")).outE().inV().simplePath().local(aggregate("a"))…` | `simplePath()` |
| `…local(aggregate("a")).bothE().sample(1).otherV()…` | `sample()` |
| `…local(aggregate("a")).union(__.out(), __.in()).local(aggregate("a"))…` | gap 1 above (union + encounter) |
| `…by(__.outE("created").count())…by(__.inE("created").values("weight").sum())…` | the `by(<reducer>)` type gap |

So §8's precondition is "RelIR holds every shape legacy currently luck-passes", and that is four
independent features away. Until then the L4 scenarios pin their spine with `@SpineRel` rather than
declaring `@RelIR` — `@RelIR` asserts that legacy REFUSES, and legacy does not refuse, it answers
wrongly. Making that tag honest is the same work as §8.

### Phase 4 — `group("a")`/`groupCount("a")` join the mechanism.

Store keyed member rows + the reducer; run `groupBarrier` at `cap`. `registerMap` disappears into
`registerCollection`. Multi-site `group("a")` then falls out for free, as does the map's own merge.

**Trap:** a group's VALUE reducer is not the collection's merge operator. Keep them apart — the
member is `(key, value-contribution)` and the group reduction runs over the union.

### Phase 5 — ✅ LANDED. Rooted sub-chains inherit `collections`.

`collections` is a `Lowering` option, forwarded in `rootedRead`'s settle-list. The fresh-map
isolation was not a scoping decision — it was wrong against the reference, where a side effect lives
on the ROOT traversal (`AggregateStep.java:57`).

**Checkpoint — measured:** L3 unchanged at 1782, census unchanged at 1208, legacy floor unchanged.
The corpus does not exercise it, so the evidence is an A/B on one traversal and an L4 scenario:
`g.union(__.V().hasLabel("person").aggregate("x"), __.V().hasLabel("software").aggregate("x")).cap("x")`
lowers 1/2 → 2/2 steps with the forward and without it.

⚠️ **`within(__.cap('a').unfold())` is still blocked, and NOT here.** `where(P.within("a"))` declines
at the `where`, before any rooted body is reached — the predicate operand's label resolution is its
own gap. Phase 5 was a precondition for it, not the whole of it.

**Trap:** a rooted body is correlated to NOTHING. A collection registered inside one and read outside
it is fine (side effects are root-global); a collection registered OUTSIDE and read inside is fine
too. What is NOT fine is a rooted body whose member relation references the outer chain's rows —
`checkPlan`'s scope check catches that, and it must stay caught rather than be worked around.

### Phase 6 — ✅ LANDED for `aggregate`. The `snapshot` binding deletes two of the four declines.

Each site is registered as `{name, node: <the narrowed member rows>, snapshot: true}` and the site's
relation becomes a `Ref` to it — `write.ts`'s pattern, and `runProgram` already honoured it. The
bindings come back from `registerCollection` so the caller can put them in the effect sequence AT
THAT POSITION, which is the same prepend a write step makes and for the same reason.

⚠️ **The site is NARROWED to its member columns before it is bound, and that is not tidiness.** A
retained binding's rows cross the executor seam as JSON (`src/program.ts`), which fails closed on what
it cannot carry — and an element site's raw relation carries the alias channel as JSONB.

**Checkpoint — measured:** `mise run rel-sweep` **0 violations** (the gate that matters: a snapshot
mistake is `checkPlan` throwing, i.e. RelIR erroring where legacy answers). L3 1782, census 1208 and
the legacy floor 1692 all unchanged, which is expected — only 4 corpus traversals contain both a
mutating step and a named collection, and each of the four ALSO needs something else (a multi-label
`cap`, `select` over a collection label, a group as a property value, a groupCount as an `addE`
label). The evidence is three L4 scenarios in `aggregate-snapshot-write.feature`, each of which
declines outright without this, plus four shapes measured lowering that did not before:
`g.V().aggregate("a").addV("x").cap("a")`,
`g.V().hasLabel("person").aggregate("a").out("created").drop()`,
`g.V().values("name").aggregate("a").addV("x").cap("a")`, and
`g.V().aggregate("a").cap("a").unfold().property("k","v")`.

⚠️ **THE TWO KEYED-FORM DECLINES STAY, for a platform reason and not an unfinished one.** A
`group("a")`/`groupCount("a")` registers a grouping barrier's relation, which is a one-row JSONB map
payload — and a retained binding travels as JSON, which fails closed on exactly that (root
`CLAUDE.md`: a `RETURNING` feeding a retained binding projects `json(x)`, never `jsonb`). The answer
is Phase 4, not a second snapshot: once the keyed forms hold `(key, value-contribution)` MEMBER rows
and run `groupBarrier` at the `cap`, they take the aggregate sites' binding unchanged. `ChainCtx.mutating`
therefore survives, with two readers instead of four.

### Phase 7 — the merge POLICY: seed + `Operator`.

Delete the `reducers.has(label)` decline. A seed with `addAll` is an extra member row; a `Set` seed
makes the reduction DEDUP; every other operator reduces member-by-member over the seed
(`AggregateStep.java:124-153`). The same policy object then serves `withSack(seed, Operator.x)` —
land both, or land the collection half and leave a named seam the sack lowering can call.

---

## §5. What this deletes

- `collection.ts`'s `collections.has(label)` decline and the paragraph arguing it.
- `registerMap` (absorbed into `registerCollection`).
- The four `ctx.mutating` declines, and probably `ChainCtx.mutating` itself.
- The `reducers.has(label)` declines (two).
- `foldTraversers` (the reduction is `reduce()`'s, keyed off `Members`).
- The fold-then-explode SQL that every `cap("a").unfold()` currently emits.
- Legacy's silent-overwrite wrong answer (§8).

---

## §6. Traps — each of these is a wrong answer, not a compile error

1. **The order is NOT pinned, and that is a licence, not an obligation.** Do not invent a total order
   across sites to be safe; do not assume one either. Fold unordered and say so.
2. **`withLossyFlag` is a WHOLE-RELATION decision** (`list.ts:769-789`). It must see every site's
   members. Per-site is a silently inconsistent member encoding.
3. **The `by()` projection is correlated and stays at the write site.** Only the FOLD moves. Moving
   the projection would evaluate `by(__.outE("created").count())` against the wrong traverser.
4. **A `Set` seed dedups; a non-`addAll` operator merges member-by-member.** Both are Phase 7. Until
   then the `reducers` decline must stay, or the seed is silently dropped.
5. **Chain-position `union`/`choose` arms already share the map** (`lower.ts:4344-4356`). After
   Phase 2 both arms of a `union` registering the same label will ACCUMULATE — which is the
   reference's answer (side effects are root-global) but is a behaviour CHANGE from today's decline.
   The corpus has no such scenario; write one in L4.
6. **`checkPlan` throws rather than declines.** Any binding mistake is RelIR erroring where legacy
   answers. `mise run rel-sweep` is the instrument that finds it; run it every phase.
7. **The element fold is lossless and the scalar fold is not.** After Phase 1 the members ARE the
   pre-fold rows, so this asymmetry stops mattering for collections — but `unfoldList` still has both
   arms and a `cap().unfold()` should take the element one, not round-trip through JSON.

---

## §7. Instruments and their expected movement

| Instrument | Phase 1 | Phase 2 | later |
|---|---|---|---|
| `mise run ci` (L1–L5 + census + every static gate) | green, no number moves | +~9 L3 | — |
| `mise run test:legacy-spine` | unchanged | unchanged (legacy still wrong) | may SHED, which is legal |
| `mise run L3:rel-only` (THE CUT) | unchanged | down | down |
| census `spine` column | unchanged | up | up |
| `mise run sql-hygiene` | **moves** — `cap().unfold()` shrinks; re-record with the reason | moves | moves |
| `mise run rel-sweep` | must stay 0 | must stay 0 | **the Phase 6 gate** |

---

## §8. The legacy change

`src/compiler/steps/prefix/sideeffect.ts:163-164` last-write-wins is a silent wrong answer, which the
project forbids outright ("never silently answer a different question — throw a clear deferral or
fall through, never mis-execute", root `CLAUDE.md`). Once RelIR holds the shape (Phase 2), make
legacy's `register` refuse a repeated label with a clear message. The legacy L3 floor will shed the
four luck-passes; that is legal under the asymmetric gate (§6·1) precisely because RelIR holds them.

Do NOT do this before Phase 2 lands — a name no spine holds fails the gate.

---

## §9. Pointers

- `docs/2026-08-01-relir-build-plan.md` — §6·5 (the three populations), §6·6 (a fact the route drops
  reads as a missing lowering), §3.0 (a named CTE and a prior result are the same concept), §Phase 2
  gap 6 (the sack merge policy this shares).
- `docs/2026-07-28-scalartype-refactoring-pattern.md` — the template Phase 1 follows: N optionals →
  one total union, coarse views DERIVED, paired with a named preserving rebuild.
- `src/compiler/rel/CLAUDE.md` / `src/compiler/CLAUDE.md` — the Pass/ChainFacts/FastPath role rules.
