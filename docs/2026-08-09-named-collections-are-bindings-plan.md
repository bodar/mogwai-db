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

> ⚠️ **THE CUT-FILTERED RANKING INSTRUMENT HAS A FLAW — FIX IT BEFORE TRUSTING IT AGAIN.** The
> throwaway described in `docs/2026-08-01-relir-build-plan.md` §Phase 2 splits blocked traversals by
> asking `compilePlan(q, {}, {spine:'legacy'})` whether legacy **compiles** them. That is not the
> same question as whether legacy **answers correctly**, and this family is the counter-example: all
> eleven `aggregate` rows it reported as "REAL GAPS the route answers" are traversals legacy compiles
> and silently mis-answers. The correct filter runs the traversal on a seeded store and compares, or
> — cheaper and good enough — cross-references `l3-state.json`'s `passed` set. Until it does, read
> "the route answers" as "the route COMPILES", and treat a family whose scenarios are absent from
> `passed` as BETTER value than the ranking claims, not worse.

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

### Phase 1 — `Collection` holds members; the reduction moves to `cap`. NO coverage change.

Pure refactor. Single-site only; the `collections.has(label)` decline STAYS.

- `Collection` becomes `{members, of, merge}` with `merge` hardcoded to the `addAll` default.
- `registerCollection` stops calling `foldTraversers`/`foldProjection`. The `by()` PROJECTION still
  happens at the write site — it must, because `by(__.outE("created").count())` is correlated to the
  traverser that is there NOW — but the FOLD does not. Keep `foldProjection`'s projection half,
  delete its fold half.
- `readCollection` gains `reduce()`, which calls the fold the framing names.
- `registerMap` keeps storing the built map for now (Phase 4 moves it).

**Checkpoint:** L3, census `spine` column, `rel-only` and the legacy floor ALL unchanged. `sql-hygiene`
will move — `cap("a").unfold()` should get materially shorter (a fold immediately exploded is now
neither), and that is the phase's evidence. Re-record with the reason.

**Trap:** the scalar fold is where `withLossyFlag` decides the member encoding (`list.ts:769-789`).
It is a whole-relation `MAX(...) OVER ()`, so it must run over the UNION of all sites' members, not
per site — which is exactly why it belongs at the read. Getting this wrong gives a list whose members
are inconsistently enveloped.

### Phase 2 — multi-site accumulation. **+~9 L3.**

- Delete the `collections.has(label)` decline in `registerCollection`.
- A second registration UNIONs its member relation into the existing one (`make.union({all: true})`).
- Member relations must agree on `of`; if they do not, DECLINE (Phase 3 lifts this).

**Checkpoint:** the nine FAIL scenarios in §0 turn PASS. `mise run test:legacy-spine` will show the
legacy floor unchanged (legacy still mis-answers them, it just is not the authority). Census `spine`
column up.

**Trap:** the ENCOUNTER channel. Each site's members carry that site's emission order, and the two
orders are not comparable. Order is not pinned (§1), so the union may drop the channel — but it must
drop it DELIBERATELY and the reduction must then fold unordered, not fold by a channel that means
different things per arm.

### Phase 3 — mixed member shapes through the variant.

Two sites contributing different element kinds, or an element and a value. Reuse `mergeArms`/the
dynamic-tag variant rather than declining. Not corpus-driven — this is combinatorial completeness,
and the substrate exists.

### Phase 4 — `group("a")`/`groupCount("a")` join the mechanism.

Store keyed member rows + the reducer; run `groupBarrier` at `cap`. `registerMap` disappears into
`registerCollection`. Multi-site `group("a")` then falls out for free, as does the map's own merge.

**Trap:** a group's VALUE reducer is not the collection's merge operator. Keep them apart — the
member is `(key, value-contribution)` and the group reduction runs over the union.

### Phase 5 — rooted sub-chains inherit `collections`.

Forward `collections` in `rootedRead`'s settle-list (`lower.ts:4543-4557`). Unblocks
`within(__.cap('a').unfold())`, `g.union(__.aggregate('x'), __.aggregate('x'))`, and every set-op
operand naming a collection.

**Trap:** a rooted body is correlated to NOTHING. A collection registered inside one and read outside
it is fine (side effects are root-global); a collection registered OUTSIDE and read inside is fine
too. What is NOT fine is a rooted body whose member relation references the outer chain's rows —
`checkPlan`'s scope check catches that, and it must stay caught rather than be worked around.

### Phase 6 — the `snapshot` binding deletes the `ctx.mutating` decline.

Register the collection as `{name, node: members, snapshot: true}`. Copy the pattern verbatim from
`write.ts:149-161`. Delete all four `if (ctx.mutating) return null` sites and the `mutating` field if
nothing else reads it.

**Checkpoint:** `mise run rel-sweep` is the gate that matters — a snapshot mistake shows up as
`checkPlan` throwing, i.e. RelIR erroring where legacy answers, which is the one failure the routing
switch cannot absorb.

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
