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
- ◑ **B2 (ASSESSED — mostly already done, residual correctly deferred).** The element-alias theta
  `where('a', op('b')).by('key')` ships today, ordering included (`aliasWhere`, `lower.ts:4558-4580`).
  The residual — a scalar (value) alias ORDERING theta (`where('a', gt('b'))` over two stored scalars) —
  is a legitimate comparator DEFERRAL, not a wire gap: value/type equality (`eq`/`neq`) is SQLite `=`
  (built, `lower.ts:4587-4591`), but `<`/`>` over two stored scalars of unknown type diverges from
  TinkerPop's `GremlinValueComparator` cross-type total order, so a naive SQLite compare is a WRONG
  answer (the same JS-comparator boundary `order(Scope.local)` draws). The one correct narrow slice is
  guarded on both aliases' `AliasEntry.scalarType` being in the Number family (then SQLite `<` is
  faithful) — low-value; build it only with a witness. Mixed-kind theta (`by('key')` over a value alias)
  is semantically ill-formed (a scalar has no property key). So B2 is not the "cheap wire" it looked
  like; the declines are correct.
- ✅ **B3 (DONE BY THE SUBSTRATE — regression pins added).** Probing showed the fan-out `otherV()`
  scope-crossing family ALREADY lowers after A/C: `local`/`coalesce`/`union`/`flatMap` bodies with a
  following `otherV()`, including with a trailing `path().by()`, all compile (the `ctx.needsFromV` demand
  threads through `childRows`/`inArmBody`). This is the request's "one substrate clears a large read-side
  family" — B3 was subsumed. Only repeat-body `otherV()` still declines, and that belongs to the repeat
  substrate (not this plan). New oracle `test/L4-addendum/otherv-scope-crossing.feature` pins the
  coalesce+otherV+path and local(bothE.limit).otherV compositions against regression.

### Phase C — the hard structural half

- ✅ **C1 (LANDED d835c490 — Codex sweep, Claude reviewed+committed).** Branch-arm label remap in
  `mergeArms` (`remapArmAliases`): canonical-column remap + NULL-pad per `CHANNEL_MERGE_POLICY.alias='union'`;
  `mergeArms` returns the merged outbound `AliasMap` (`BranchRel`) and the scalar/element/property branch
  tails continue with `merged.aliases`. Oracle `test/L4-addendum/branch-arm-label-escape.feature`;
  `rel-spine.test.ts` union case moved DECLINED→COVERED. L3 1828→1829.
- ◑ **C2 (DESIGNED — sequenced after C3/D1; the one item deferred, with magnitude).** The `flatMap`
  path-hide — collapse the N body-minted path positions to one input→output position
  (`FlatMap.feature:56`: `flatMap(out().out()).path()` = `[v,end]`). **Key fact:** `movement()` appends a
  path position whenever the path CHANNEL is present (`pathCarried`), NOT based on `ctx.tracksPath`, so
  running the body with `tracksPath` off does not stop appends. Two mechanisms, both with real cost:
  - **(a) static-N JSON surgery.** Count the body's path-appending steps (movements + value-maps, per
    `path.ts`) at compile time; if statically constant (a LINEAR body — `out().out()` = 2), reproject the
    path as `first (len − N) positions ++ last position` via a `json_each` reconstruction. N==1 is already
    correct (no-op). Risk: an exact miscount of the append set is a wrong path; a non-linear body (branch/
    repeat inside) has no static N and must decline.
  - **(b) origin-rejoin.** Number the input (`mintRowOrigin`, keeping P), strip the path channel for the
    body so it appends nothing, run the body, then self-join the element output to the numbered input by
    `origin` to recover P, and `extendPath` the output position. Robust but must INLINE the body-run
    (`childRows` refuses a pre-numbered input, `reduction.ts:464`), and needs the join.
  **Deferred because:** `flatMap`-under-`path()` is niche (few/no corpus witnesses), it is correctly
  fail-closed today, and both mechanisms carry correctness risk (miscount / intricate join) better spent
  on C3/D1 first. Restrict the eventual build to an element-output linear body; non-element / non-linear
  stays deferred.
- ◑ **C3 (SCOPED — a multi-part subtle substrate, not one edit).** Per-origin barrier-in-body ("slice 2").
  Probed the actual declines: `local(out.fold())`, `local(out.count())`, `flatMap(out.fold())`,
  `local(out.fold()).unfold()`'s terminal forms ALREADY lower (the reduction arm / `scalarChild`). What
  declines is three distinct families, each its own mechanism:
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
  - **a full GROUP in `local`** (`local(out.group().by('lang'))`, `groupCount()`) — a grouping barrier
    scoped per-entering-traverser = `GROUP BY [origin, key]` with `origin` CONSULTED as part of the group
    key (like `graph`, `channels.ts` note), NOT a passenger. Extends `PER_ORIGIN_SAFE_BARRIER` for the
    grouped case.
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

- ◑ **D1 (LOCATED — a focused follow-up; hard to VERIFY, so not a tail-end rush).** The concrete named
  gap is the path+encounter combo decline at `lower.ts:2999`: `if (facts.tracksPath && facts.demandsEncounter)
  return null;`. The seed would have to carry BOTH the path channel (position 0 off the landed id, as
  `seedPath` does for the base source) AND the encounter (minted from the landed array order,
  `foreignRelation(withOrder)`). The broader unification routes the bespoke resumes
  (`valueResume`/`lowerForeignResume`) through the full-frame `Lowering.seed`/`valueSeed`/`listSeed`/`mapSeed`
  machinery (3308-3338, landed 49b2ed5c) rather than each hand-seeding a subset (the boundary trace's
  subset table). **Why a focused session, not a rushed dispatch:** the channel-obligations gate
  (`checkChannels`, `src/rel/obligations.ts`) catches a DROPPED channel at build time, but NOT a wrongly-
  VALUED one (a path seeded in the wrong position, an encounter off the wrong order) — and a witness needs
  a federate/subgraph traversal that tracks `path()` AND orders mid-chain, which the federate test infra
  makes non-trivial to construct. So D1 wants the reference in hand and the federate witness built FIRST,
  then the seed. Preferred form is the dissolving rewrite (seed → re-enter the fold), not a parallel
  hand-seed table.

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
