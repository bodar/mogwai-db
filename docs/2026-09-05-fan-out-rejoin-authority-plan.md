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
- **C2 (Claude; novel, reference-faithful).** The `flatMap` path-hide node — collapse the N body-minted
  path positions to one input→output position (`FlatMap.feature:56`). Lets `flatMap`-under-`path()` stop
  declining.
- **C3 (Claude).** Per-origin barrier-in-body ("slice 2") — a `fold`/`group`/`aggregate` inside a
  fan-out body scoped per-entering-traverser: `GROUP BY origin` with `origin` CONSULTED as part of the
  group key (the way `graph` is spliced into the dedup/group key, `channels.ts` note), NOT carried as a
  passenger. Extends `PER_ORIGIN_SAFE_BARRIER`. Bounded-`repeat`/`union`-arm variants stay per their
  arm-major/traverser-major rule; unbounded-`repeat` stays permanent decline.

### Phase D — the async-boundary frame authority (Codex sweep, Claude spec+review; Claude owns the path+encounter seed)

- **D1.** Route `lowerForeignResume` and the value/list/map resumes to seed the FULL frame through
  `Lowering.seed` (§4) rather than each hand-seeding a subset; build the composite
  `tracksPath && demandsEncounter` seed that currently declines. Wide blast radius across `lower.ts`
  resume functions, `segment.ts`, `foreign.ts`. Preferred form is the dissolving rewrite (re-enter the
  fold), not a parallel hand-seed table.

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
