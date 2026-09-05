# Encounter and order — the fan-out rejoin authority

> **Status: PLAN (2026-09-05).** Active. One root cause — a per-traverser-spliced body does not thread
> its outbound carried state (labels, path, entering-vertex, emission order) back to parent scope —
> produces a large read-side family of fail-closed coverage gaps. This doc is the shared spec for the
> increment ladder (§7) and for the two Codex sweeps (§8). Cite every semantics claim at the pin
> (`vendor/tinkerpop/...`, `vendor/calcite/...`); the code is the authority, this is the map.

## 1. The one gap

The fold threads a continuation as three things: the `Rel` (which carries every CHANNEL —
`alias`/`path`/`origin`/`fromV`/`encounter`/`bulk`/`sack`/`loops`/`graph` — as ordinary columns), the
`RelFraming` (shape), and the `AliasMap` (`labels`, the name→column mapping the framing layer owns). A
**boundary** is any point that rejoins/merges/resumes a spliced body or landed data into a new scope:
the fan-out child rejoin (`flatMapRejoin`), the branch merge (`mergeArms`), and every async resume
(`lowerForeignResume`, the value/list/map resumes, the `segment.ts` transplant).

At a boundary the physical channels ride through fine (a movement carries its input's channels by
contract, §3.5 obligations), **but the outbound `AliasMap` is dropped**: `childRows`
(`src/compiler/rel/lower/reduction.ts:460`) computes the body's merged `tail.aliases` and discards it —
`ChildRows` (`src/compiler/rel/child.ts:127`) has fields `{rel, framing, origin}` and **no `aliases`**.
`flatMapRejoin` then continues with the *pre-body* `labels`. The async resumes are the same shape one
axis over: each hand-seeds a DIFFERENT subset of channels rather than the full frame (measured table in
the boundary trace; `lowerForeignResume` refuses `tracksPath && demandsEncounter` outright,
`lower.ts` combo decline).

This is the largest defect class in the repo's history made into a feature gap: **"a carried field
dropped at a barrier, merge or rejoin is 33% of diagnosed defects"** (`src/rel/obligations.ts:6-14`).
Today every instance is fail-closed (`UnsupportedTraversal`), never a wrong answer — so this is a
COVERAGE family, with one behavior correction (§3, flatMap).

## 2. Load-bearing reference facts (read, not reasoned)

- **`local()` ≠ `flatMap()` for label/path visibility.** `LocalStep.processNextStart` returns
  `localTraversal.nextTraverser()` — the child's FULL `Traverser.Admin`, path + labels intact
  (`vendor/tinkerpop/gremlin-core/.../step/branch/LocalStep.java:60-67` →
  `.../Traversal.java:593-595`). Plain `flatMap` goes through `Traversal.next()` which UNWRAPS to a bare
  value, then `head.split(value)` re-derives from the PRE-child head
  (`.../step/map/FlatMapStep.java:42-52` → `.../util/DefaultTraversal.java:220-230` →
  `.../Traverser.java:185-195`). So `local(out().as('b'))` escapes `'b'`; `flatMap(out().as('b'))`
  discards it. And `local(out().out()).path()` = `[v,mid,end]`; `flatMap(out().out()).path()` = `[v,end]`
  (`.../gremlin-test/.../map/FlatMap.feature:56`).
- **`union`/`choose`/`repeat` are on the label-PRESERVING side** (they forward the full traverser via
  `nextTraverser()`/`getEndStep()`), so their body-bound labels DO escape —
  `BranchStep.standardAlgorithm` (`.../step/branch/BranchStep.java:123-153`),
  `RepeatStep`/`RepeatEndStep` (`.../step/branch/RepeatStep.java:213-214,333-354`). Plain `flatMap` is
  the lone exception.
- **A barrier's scope is the ENCLOSING combinator's, not the barrier step's.** `local()` drains ONE
  entering traverser, resets, reseeds (`LocalStep.java:59-89`) → per-origin. `BranchStep` with
  `hasBarrier` drains ALL starts into an arm before iterating (`BranchStep.java:123-153`) → arm-major.
  So a per-origin window in a `union` arm would be WRONG; a barrier in a `local` body is per-origin.
- **`otherV()` scans path history backward for the nearest `Vertex`** (`EdgeOtherVertexStep.java:44-55`),
  requires `TraverserRequirement.PATH`, throws `IllegalStateException` if the slot was trimmed. The
  entering-vertex slot must survive a rejoin.
- **`DedupGlobalStep` keys on `java.util.List` content-equality** — a plain `ArrayList` in a
  `HashSet<Object>` (`.../step/filter/DedupGlobalStep.java:59,79-89`); an unproductive `by()` for any
  label filters the whole tuple. SQLite canonical-JSON text equality is the faithful lowering for a
  list-valued key.
- **Calcite: nothing survives a hop "for free."** `RelDecorrelator.Frame`'s `corDefOutputs`/
  `oldToNewOutputs` decide, per node, whether a correlation column is consumed as the join key (dropped)
  or explicitly re-projected forward (`vendor/calcite/core/.../sql2rel/RelDecorrelator.java:4026-4048,
  1894-1976`). Per-correlated-group limit/order is `PARTITION BY corVars`
  (`decorrelateSortWithRowNumber`, `.java:610-616`); DISTINCT ON is
  `ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)` filtered `rn=1`
  (`.../sql2rel/SqlToRelConverter.java:1049-1114`). Our `perOriginWindow` is this exactly.

## 3. The keystone abstraction — an outbound frame + a per-combinator regime

A continuation point is the triple `{rel, framing, aliases}` — the shape `ChainRead` already carries for
`match` (`child.ts:116`). Make every rejoin/merge/resume RETURN that full triple, and apply the
enclosing combinator's TinkerPop regime to the outbound `AliasMap`:

| Boundary | Regime |
|---|---|
| `local` / `union`-arm / `repeat` body | **carry** — return the body's `tail.aliases` (reconciled to the rel via `liveAliases`); alias/path channels already ride. `bindAliases` numbers off `next.size`, so the single-relation `local` rejoin needs NO remap. |
| plain `flatMap` | **shed** — drop the body-minted alias channels, return the INCOMING aliases; a downstream `select('b')` is then the empty result (`Select.feature`), not a decline. Path stays hidden (needs C2's hide-node). |
| branch merge (`UNION ALL`, positional) | **remap + NULL-pad** — canonical-column remap per `CHANNEL_MERGE_POLICY.alias='union'` (`src/channels.ts`), the `mergeChannels` alias merge the core already anticipates. |
| async resume | **seed the full frame** — via the landed `Lowering.seed` builder (below), re-entering the fold so seeding is complete, rather than each resume hand-seeding a subset. |

**Fail-closed stays the law.** Where a role still cannot be threaded correctly (a body-bound label
consumed by a downstream `group()`/`fold()` grouping key; an unbounded-`repeat` body-bound label against
the recursive-term schema-identity law, `obligations.ts` `recursive`), the boundary DECLINES, never
mis-executes.

## 4. The async axis already has its substrate (landed 2026-09-05, `49b2ed5c`)

`Lowering.seed` (`src/compiler/rel/lower.ts:2620`) is a `(fresh) => FramedRel | null` builder that makes
`lowerChain` start from a re-injected SOURCE relation (Calcite `Values`) instead of a source step, so a
resume tail "composes through the ORDINARY machinery, segmentPlan INCLUDED"; the three re-injected
sources are one builder each (`valueSeed`/`listSeed`/`mapSeed`), shared by the fold path and the nesting
path. Dan landed the SEQUENTIAL-barrier half (`valueMap(k).order().fold().asString(local)`); the commit
names the harder CHILD-BODY case as the remaining gap — which is §7's Phase A/C. **Phase D builds on
`Lowering.seed`**: route the bespoke resumes (`lowerForeignResume`, value/list/map resumes) to seed the
full frame through this path, and build the `tracksPath && demandsEncounter` composite seed that
currently declines.

## 5. Instruments per increment (from build-plan §8)

`mise run ci` → `test:cf-limits` on any new SQL → commit → `mise run L5` at the commit (HEAD-derived
seed) → push. `test:perturbed` whenever the change touches ORDER. Read the census for
deferral→wrong-answer. Keep L1 100%; re-record L3/L5; add an L4 oracle for any shape no corpus scenario
names (list-alias dedup key, the local/flatMap split).

## 6. Fail-closed boundaries to preserve (each already cost a wrong answer)

- `fromV`/`alias`/`path`/`origin`/`sack` group policy is `undefined` — none may survive a COLLAPSE or a
  whole-row `Distinct`; the carry regime keeps them only through row-preserving nodes and window
  functions, never a grouping (`channels.ts` `CHANNEL_GROUP_POLICY`, `obligations.ts`).
- `FROM_V_TRANSPARENT` deliberately excludes `dedup` — do not add it to "fix" otherV composition.
- Path DENY-by-default (`src/compiler/rel/path.ts`) — a step joins the path-transparent set only if it
  provably mints no new traverser object.
- The channel obligations (`obligations.ts`) are build-time enforced — a new carrying node shape must
  satisfy its `CHANNEL_OBLIGATION` entry or the build fails.

## 7. Increment ladder (each: green `ci` → commit → push to trunk)

### Phase A — the keystone (Claude; first, everything depends on its shape)

- ✅ **A1 (LANDED f3ffb79b).** Added `aliases: AliasMap` to `ChildRows`; `childRows` returns
  `tail.aliases`; `flatMapRejoin` threads it (carry regime) for `local`. Unlocked `local` label-escape
  AND `local`-under-`path()` (both pure coverage — `inBody` never cleared `tracksPath`, so the body
  already minted the right positions). L3 1816→1819.
- ✅ **A2 (LANDED 27b65b42).** The local/flatMap SPLIT: `flatMap` sheds body-bound aliases
  (`shedBodyAliases`) → downstream empty (correct per §2), no longer declines on label-escape;
  `flatMap`-under-`path()` still declines pending C2. New oracle
  `test/L4-addendum/flatmap-local-escape.feature` pins the asymmetry.

### Phase B — read-side consumers (Claude; each on A)

- ✅ **B1 (LANDED a1fb1bff).** Started as the list-valued alias `dedup('a')` key, but probing showed the
  real gap: keyed `dedup(label)` was dispatched ONLY from the element/record tails, so a keyed dedup over
  a bound LIST or scalar declined though `dedupByLabels` was built (the reach-the-arm trap). Extracted one
  `keyedDedup` dispatch, wired the scalar/list/map tails, and added the `list` arm to `dedupByLabels`
  (`aliasListAt`, canonical `json()` = `java.util.List` content-equality; `map` stays declined —
  order-sensitive text ≠ `LinkedHashMap` entry-equality). Oracle `test/L4-addendum/list-alias-dedup.feature`.
- ✅ **B2 (LANDED 4d3183b0 — the deferral premise was WRONG).** The residual — a scalar (value) alias
  ORDERING theta (`where('a', gt('b'))` over two stored scalars) — was deferred on the belief that it
  needed TinkerPop's cross-type TOTAL order and SQLite's `<`/`>` would diverge (a WRONG answer, "the same
  JS-comparator boundary `order(Scope.local)` draws"). **That conflated two reference comparators.**
  `Compare.gt/gte/lt/lte` route through `GremlinValueComparator.COMPARABILITY`
  (`vendor/tinkerpop/gremlin-core/.../process/traversal/Compare.java:63-116` →
  `.../util/GremlinValueComparator.java:97-153`), NOT the ORDERABILITY total order `order(Scope.local)`
  uses. COMPARABILITY is comparable ONLY within one `Type` bucket (`ft == st`,
  `GremlinValueComparator.java:314-363`) and is simply FALSE across buckets (guard returns false before
  `compare` throws). So there is no cross-type total order to render and no wrong-answer risk: the
  faithful lowering is a same-bucket-else-false CASE — the shape `ordered()` already builds for the
  one-static-side case, one axis over. New `comparableTheta` (`src/compiler/rel/predicate.ts`) renders
  it per-row off each alias's stored `t` tag, over ALL reachable scalar buckets (not the proposed
  "Number-only narrow slice"): Number (one bucket across int/real, cast per side by storage class),
  Date/Duration (int), String/char + Boolean + UUID (stored value; uuid lexical, matching
  `orderability.ts` so the two comparators agree). An UNKNOWN-typed alias (no `t` tag) declines
  fail-closed rather than answer a real comparison false. Works at depth — witnessed inside `match()`
  (int/int, int/real, string/string, and the cross-bucket int-vs-string → empty). Also hoisted a shared
  `compilerFalse` (`ordered()` had its own copy). Oracle
  `test/L4-addendum/scalar-alias-ordering-theta.feature`; not corpus-witnessed (census 0 drift).
  **Residual, NOW a separate compounding item:** `ordered()`'s own bucket split is only 2-way
  (numeric/string), so `is(P.gt(<bool>))` between two booleans still mis-answers — a latent correctness
  bug a shared bucket table would fix; see §7 B4.
- ✅ **B3 (DONE BY THE SUBSTRATE — regression pins added).** Probing showed the fan-out `otherV()`
  scope-crossing family ALREADY lowers after A/C: `local`/`coalesce`/`union`/`flatMap` bodies with a
  following `otherV()`, including with a trailing `path().by()`, all compile (the `ctx.needsFromV` demand
  threads through `childRows`/`inArmBody`). This is the request's "one substrate clears a large read-side
  family" — B3 was subsumed. Only repeat-body `otherV()` still declines, and that belongs to the repeat
  substrate (not this plan). New oracle `test/L4-addendum/otherv-scope-crossing.feature` pins the
  coalesce+otherV+path and local(bothE.limit).otherV compositions against regression.
- ✅ **B4 (LANDED 643a7530 — a latent wrong answer, fixed).** `ordered()`
  (`src/compiler/rel/predicate.ts`) split subject types only 2-way (numeric vs string), so a BOOLEAN
  subject fell to the `else` and every ordering op folded to false: `values(boolProp).is(P.gt(false))`
  was EMPTY where TinkerPop's Boolean bucket keeps the `true`s (`false < true`,
  `GremlinValueComparator.Type.Boolean` + `naturalOrder`; `Compare.java:63-116` routes gt/lt/gte/lte
  through COMPARABILITY). Added the Boolean bucket to all three arms: a `static`/`perRow` boolean subject
  compares raw (0/1 = the natural order), an `unknown`-typed subject stays false (a stored 0/1 boolean is
  indistinguishable from an int without a tag). Consistent with `comparableTheta` and `orderability.ts`.
  Witnessed on the zoo `captiveBorn` property (gt(false)=5, gte(false)=10, lt(true)=5, gt(true)=0 — all 0
  before). Oracle `test/L4-addendum/boolean-ordering-theta.feature`; census 0 answer changes (the corpus
  never exercised it). The fuller "one shared bucket table for `ordered()` + `comparableTheta`" cleanup
  (retiring the `NUMERIC_VTYPES`/`CAST_TO_INT` ad-hoc split, adding a UUID ordering arm) remains optional
  de-duplication, not a correctness gap.

### Phase C — the hard structural half

- ✅ **C1 (LANDED d835c490 — Codex sweep, Claude reviewed+committed).** Branch-arm label remap in
  `mergeArms` (`remapArmAliases`): canonical-column remap + NULL-pad per `CHANNEL_MERGE_POLICY.alias='union'`;
  `mergeArms` returns the merged outbound `AliasMap` (`BranchRel`) and the scalar/element/property branch
  tails continue with `merged.aliases`. Oracle `test/L4-addendum/branch-arm-label-escape.feature`;
  `rel-spine.test.ts` union case moved DECLINED→COVERED. L3 1828→1829.
- ✅ **C2 (LANDED 5557f9c8 — mechanism (b), the risk was on (a)).** The `flatMap` path-hide:
  `flatMap(out().out()).path()` = `[v,end]`, mid hidden (`FlatMap.feature:56`). The reference is exact —
  `LP_O_OB_P_S_SE_SL_Traverser.split`
  (`vendor/tinkerpop/gremlin-core/.../traverser/LP_O_OB_P_S_SE_SL_Traverser.java:65-69`) sets
  `clone.path = head.path.clone().extend(r, labels)`: the PRE-child head's path extended by exactly ONE
  position, the emitted value. The deferral's "correctness risk" lived entirely in **mechanism (a)**
  (static-N JSON slice, miscount); **mechanism (b)** has no miscount because it never appends the body's
  hops. `flatMapRejoin` under a path demand now: `mintRowOrigin` beside the entering path P, run the body
  PATH-FREE (`dropPath` — a path-hostile body step then composes, exactly TinkerPop hiding the body's own
  paths), recover P by an inner join on `origin` (fan-out is one-to-many), `extendPath` by the one output
  element → P ++ [emitted]. The only substrate change: `childRows` now REUSES a pre-minted per-row origin
  (`mintRowOrigin` is idempotent) instead of refusing it — a group reducer (`!perRow`, host-rowid origin)
  still refuses. Element-output only (a scalar/list output under `path()` stays fail-closed — its own
  increment). "Niche" was also wrong: it IS the corpus scenario `g_V_flatMapXout_outX_path`. Works at
  depth — witnessed with a per-origin barrier inside the body
  (`flatMap(out().order().by('name')).path()`). Oracle updates in
  `test/L4-addendum/flatmap-local-escape.feature` (dropped `@Unsupported`, added barrier-in-body +
  non-element pins); L3 1831→1832; census deferral→run (answer reference-verified).
- ✅ **C3 (LANDED — all three families, 1783c614 / d0b82487 / 77af9ac6).** Per-origin barrier-in-body
  ("slice 2"). The keystone turned out to be ONE seeded-barrier substrate (families 2/3 share it):
  `ChainCtx.originDomain` (set by `childRows`, one row per entering traverser) lets a per-origin
  `GROUP BY origin` LEFT JOIN it and `COALESCE` the empty origins to the barrier's SEED (`[]` for `fold`,
  `{}` for `group`) — the crux a naive `GROUP BY` silently drops. `origin` is a CONSULTED key (plain
  column, re-declared as the channel on the output), never a grouped-Aggregate passenger. It compounded
  beyond `local`: union-arm/flatMap-arm folds landed too (3 `@Unsupported` scenarios dropped). Probed the
  actual declines: `local(out.fold())`, `local(out.count())`, `flatMap(out.fold())`,
  `local(out.fold()).unfold()`'s terminal forms ALREADY lower (the reduction arm / `scalarChild`). What
  declined was three families, each its own mechanism:
  - ✅ **a non-seeded numeric reducer in `local` (LANDED 1783c614).** `local(outE.values('weight').sum())`,
    `mean` — declined because a reducer over an empty child emits NOTHING (unlike `count`→0, `fold`→[]),
    so `perTraverserChild` failed on `present` ABSENT (`reduction.ts:261`). **Measured correction to the
    scoping: `min`/`max` ALREADY worked** (the argmax arm computes `present: EXISTS(value rows)`); only
    `sum`/`mean` fell into `correlatedReduce`'s numeric arm which returned WITHOUT `present`. The fix was
    that ONE signal, not the feared channels-core change: extract the argmax EXISTS-probe as `existsAny`,
    share it, and read the reducer's OWN input off the already-lowered tail (`collapseInput`) so it costs
    no second lowering. **This is a CORRELATED SCALAR, never `childRows`/`origin`** — so the "scalar-host
    origin / channel-carries-a-VALUE" clause was mis-scoped here (it bled from the group family below);
    a scalar-HOST `local` reducer is a genuinely separate, unwitnessed sub-case, correctly still deferred.
    Compounds to sum/mean in `map`/`flatMap`/`where`/`choose` and reducer-valued `property(k, __.…sum())`
    writes; +16 census deferral→run (1 mine, 15 pre-existing drift), 0 answer changes. Oracle
    `test/L4-addendum/local-reducer-empty-drop.feature`; `rel-spine.test.ts` two DECLINED→COVERED.
  - ✅ **a full GROUP in `local` (LANDED 77af9ac6).** `local(out.group().by('lang'))`, `groupCount()` — a
    grouping barrier scoped per-entering-traverser, `GROUP BY [origin, key]` at stage 1 and `GROUP BY
    [origin]` at the fold-to-map, `origin` CONSULTED as a plain-column key (like `graph`), NOT a passenger.
    Reused the family-3 seeded substrate whole: `groupMap`'s per-origin path (`map.ts`) + the origin
    DOMAIN LEFT JOIN that SEEDS the empty `{}` a `group()` owes an edgeless vertex (the crux family 3
    already solved for `[]`). Keyed `group("a")` in a per-origin scope stays fail-closed. Verified
    per-origin + seeded (marko `groupCount.by(name)` `{josh:1,lop:1,vadas:1}`, edgeless vadas `{}`); 0
    census answer changes; ordinary/keyed group unchanged. Oracle `test/L4-addendum/local-group.feature`.
  - ✅ **a barrier that CONTINUES mid-body (LANDED d0b82487).** `local(out.fold().unfold())` — the fold's
    result re-enters the body and continues. Built the SHARED per-origin-barrier substrate families 2/3
    both need: a new `ChainCtx.originDomain` (set by `childRows`, one row per entering traverser) so
    `foldPerOrigin` (`list.ts`) can `GROUP BY origin` (the key CONSULTED not a passenger — `origin` is
    `undefined` group policy) AND LEFT JOIN the domain to SEED the empties `fold()` owes (`[]` for a vertex
    with no `out()`), which a bare `GROUP BY` drops. The seeded-empty was the crux: a naive per-origin fold
    silently dropped empty origins (wrong for `count(Scope.local)`), which is why the substrate, not a
    peephole, was the right call. Compounded to union-arm/flatMap-arm folds (3 `@Unsupported` scenarios
    dropped, answers reference-verified). 0 census answer changes; ordinary top-level fold byte-unchanged.
    Oracle `test/L4-addendum/local-fold-continue.feature`.
  Bounded-`repeat`/`union`-arm variants stay per their arm-major/traverser-major rule; unbounded-`repeat`
  stays permanent decline. Each family is a separate green increment.

### Phase D — the async-boundary frame authority (Codex sweep, Claude spec+review; Claude owns the path+encounter seed)

- ⛔ **D1 (RE-DIAGNOSED 2026-09-05 — the deferral HOLDS, but the real blocker is UPSTREAM of the seed;
  STOPPED for a human design decision).** The named gate is the path+encounter combo decline (now
  `lower.ts:3007`, `if (facts.tracksPath && facts.demandsEncounter) return null;`, plus its twin at the
  `detachedTail` `.V()`/`.E()` re-root). The combined seed IS a clean build — path-project THEN renumber,
  which composes because a `Window` only EXTENDS its input (§3.5), so the path rides through the encounter
  renumber untouched; I wrote it (a shared `combinedPathEncounterSeed`, deleting the blanket 3007 gate so
  the existing `demandsEncounter && !seedsEncounter && !ordersMidChain` line is the sole, correct gate) and
  it type-checked. **But it is UNWITNESSABLE end-to-end and was reverted**, because probing showed the
  combo is UNREACHABLE by any valid traversal:
  - `order().by(k).path()` ALREADY works (`order()` mints the encounter mid-chain, so `demandsEncounter`
    stays false without a downstream collector — the `ordersMidChain` case never hit the gate).
  - The only thing that makes `demandsEncounter` true alongside `tracksPath` is an ORDER-DEMANDING
    consumer AFTER `path()` (a whole-stream `fold()`/`order()`/`group()`). **None composes:** `fold` is
    deliberately NOT a `PATH_LIST_OP` (`ir/step.ts:461-465` — over a path, `fold`/`order`/`dedup`/`count`
    are whole-stream ops meaning something other than the per-path list ops), and `path().fold()` DECLINES
    on the BASE graph too (measured), not just federated. Folding a stream of ELEMENT-membered paths needs
    the element-membered-nested-list re-entry that `outstanding-work.md` marks **"Superseded / won't-do"**.
  So the seed guard protects a combo nothing reaches, and landing the seed would be dead code whose
  wrongly-VALUED channels (`checkChannels` is structural-only) nothing could catch until a path-consumer
  feature lands far away — exactly the risk this bullet already flagged. **The design fork for the human:**
  (a) accept D1's deferral as correctly fail-closed + unreachable (the guard stays; revisit when path
  consumers exist); or (b) invest in the PATH-CONSUMER family first — a whole-stream `fold()`/`order()`/
  `group()` over a `path`-framed stream, including the element-membered-nested-list fold that is currently
  a "won't-do" — which is the actual prerequisite that would make D1 reachable AND witnessable. Only then
  is the seed (already written, easy to reconstruct) worth landing. The plan's earlier "the federate
  witness is non-trivial to construct" was the wrong diagnosis: the witness is impossible because the
  CONSUMER does not exist, not because the harness is hard.

## 8. Claude / Codex split & sequencing

Claude lands **A** first (keystone, delicate, correctness-critical). Once A is green on trunk, Claude
dispatches Codex in the BACKGROUND on **C1** and **D1** in parallel (independent, wide, high-blast-radius
— Codex's strength) with a precise written spec drawn from this doc; Codex produces diffs, Claude
verifies each against `vendor/` and `mise run ci`, and Claude commits+pushes (Codex does not commit).
Meanwhile Claude takes **B1–B3, C2, C3** (small/novel/reference-faithful). Codex prompts must avoid
backticks and `$` (shell-interpolated bridge).

## 9. Superseded framings to correct as we land

- `where('a',eq('b')).by('key')` is NOT broken for the element-alias case — the `sourceFilter` comment
  claiming so is stale (B2 covers only the scalar/mixed residue).
- `otherV()` core mechanism works root-chain; the gap is scope-crossing composition, not `otherVertex`
  itself (B3).
- `union`-arm barriers are arm-major — a per-origin window there is wrong (C3 excludes it).
