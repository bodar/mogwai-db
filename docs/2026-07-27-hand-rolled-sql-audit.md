# Hand-rolled SQL audit — where a second implementation replaced the substrate

_Swept 2026-07-27; **re-measured 2026-07-27 after merging trunk** (`611a4fc`), which landed the
`union()` SOURCE consolidation and closed what this audit ranked #2 — see the struck entry. Every
count below is **measured** against the merged tree, not estimated: the method is at the bottom.
Ranked by (duplication × family unblock × reach at depth), which is not the same as ranking by lines._

> The kernel is not the problem. Every site here already builds through `q`/`Relation` — locked
> decision "only `kernel/q.ts` touches lazyrecords" holds. What this audit hunts is the **second
> implementation of traversal semantics**: SQL assembled by a private step-vocabulary instead of by
> `lowerSteps`/`lowerElementSteps`. That is the rule in `src/compiler/steps/CLAUDE.md` ("Never build
> a second implementation"), and it is the thing that costs whole families rather than one scenario.

## The lesson worth generalizing (from #6, the one that's now fixed)

**A fast path is the wrong place to discover a capability.** `predicateInlining` declared itself
disable-safe, its equivalence test passed, and it was still the only implementation of infix
connective precedence — so the flag silently controlled *what the compiler could express*, not just
how fast it did it. The tell was cheap and mechanical: **compile the whole corpus with the flag off
and diff.** 6 regressions, all one shape. Every other flag came back 0/0.

That check costs ~20 lines and is worth running for each of the remaining flags whenever one is
touched — it is strictly stronger than the hand-picked-cases equivalence test, which by construction
only covers shapes the author already knew had a fallback.

The fix direction generalizes too, and it is what the rest of this audit is asking for: **keep the
fast path, move the capability to the generic machinery.** The perf was real (1.2×–17×), so deleting
would have been a regression; extracting the load-bearing fold into a Pass made the flag honest,
fixed 3 top-level scenarios it had never reached, and left the optimization untouched.

## The one structural finding

Three of the remaining sites (#1, #4, #5) are the same missing primitive wearing different clothes.
The compiler has **two** rendering modes and needs a third:

| mode | who owns it | shape | used by |
|---|---|---|---|
| A — materialized CTE | `Query.cte` (`sql/kernel/q.ts`) | `WITH c0 AS (…), c1 AS (SELECT … FROM c0)` | the root + child seam |
| B — nested correlated derived | `InlineQuery` (`steps/tail/correlated.ts`) | `EXISTS(SELECT 1 FROM (SELECT … FROM (SELECT <outer.id>) x0) x1)` | `where`/`filter`/`and`/`or`/`choose`/`until` |
| **C — flat accumulation** | **nobody** | one SELECT whose FROM/WHERE is appended to, correlating by JOIN | hand-rolled 3× |

Mode B **cannot** stand in for mode C, and this is not a judgement call — SQLite has no `LATERAL`,
so a FROM-clause derived table cannot reference the row being recursed over. Verified directly:

```
FAIL  with recursive w(id,depth) as (select 1,0 union all
        select x.id, w.depth+1 from w, (select e.tgt as id from edges e
          join (select w.id as id) x0 on e.src=x0.id) x where w.depth<3) …
      -> no such column: w.id
OK    … select e.tgt, w.depth+1 from w join edges e on e.src=w.id …     (mode C, flat join)
```

So `expandRepeatBody` is not laziness — it is mode C, hand-written for one vocabulary. So is
`path.ts`'s grouped positional projector, and so is `write.ts`'s merge-match. **Whoever closes #1
should decide mode C deliberately**, because #4 and #5 fall out of the same decision.

For #1 specifically there is a cheaper route that needs *no* new mode, verified to work: compile the
body ONCE through the ordinary seam as a `(from_id, to_id)` relation over the whole vertex set, then
have the recursive term join it — a recursive term may legally reference a non-recursive CTE.

```sql
with recursive
  body(from_id, to_id) as (          -- ← whatever lowerElementSteps emits, seeded from V()
    select distinct p.id, e.tgt from nodes p join edges e on e.src=p.id
    where exists (select 1 from vertex_properties vp where vp.node=e.tgt and vp.key='ok')),
  w(id, depth) as (select 1, 0 union all
    select b.to_id, w.depth+1 from w join body b on b.from_id=w.id where w.depth<3)
select id, depth from w where depth = 3;          -- → [{id:4, depth:3}]   (verified)
```

That materializes |V|×fanout rows instead of expanding the frontier lazily, so it is a **fallback**,
not a replacement: keep today's flat-join expansion as the recognized fast path for
movement+`has()`, and route everything it declines through the generic body relation. That is
exactly the fast-path contract the project already runs on (`options/fast-paths.ts`), and it turns
repeat's vocabulary wall into a performance trade-off instead of a `throw`.

---

## The ranking

### 1. `expandRepeatBody` + the `repeat` StepFn — ✅ **the wall came down 2026-07-27** (both sides)
`steps/prefix/branch.ts` — `expandRepeatBody` is now a *fast path*, not the vocabulary

**What landed.** Not a rewrite of `expandRepeatBody` — it stays, unchanged, as the recognized fast
path, because it walks the frontier lazily where the generic route materializes. What changed is
that it is no longer the *only* route, so it no longer defines the vocabulary:

- **The generic body relation** (`repeatBodyRelation`). A recursive term may legally reference a
  NON-recursive CTE, so the body is compiled ONCE through the ordinary StepFns — seeded from every
  vertex, carrying its origin in the `carried` slot `pushChildScope` already uses for exactly this —
  and reduced to `(from_id, to_id)`. The recursive term joins it. **No new rendering mode**: this is
  the way around SQLite's missing `LATERAL` (verified below) that needs no mode C at all.
- **Origin columns ride through the walk.** A walk is row-local, so the parent ordinal just rides,
  exactly as movement carries it via `carryFrag`. That was the *only* thing keeping `repeat` out of
  `ELEMENT_CHILD_STEPS`.
- **`otherV` joined the row-local vocabulary** — the odd one out among the nine movements, gating
  every exploded-edge body in every child position. The emit side was already ready (the child
  compiler's own comment points at it).
- **The body is normalized with the same `normalize()` every other nested body uses**, not a
  hand-picked single fold. With `foldByModulators` alone a nested `times()` never folded onto its
  `repeat()`, so a nested walk reported `repeat() requires times(), until(), or emit()`.

**Measured:** repeat corpus **43 → 48**, total corpus **1,626 → 1,635**, **L3 1,440 → 1,445**,
`mise run ci` 890 pass / 0 fail. The ceiling moved much further than the floor, which is the point:

| | before | after |
|---|---|---|
| body vocabulary (12 probes) | 2 OK | **9 OK** — the 3 left are *named semantic walls* |
| `repeat()` at a nested position (7 probes) | 1 OK (a union arm) | **7 OK** — `local`/`map`/`where`/`group`/`order`/`union` |
| nested `repeat` in a body | ✗ | **✓**, equal to the flattened equivalent |

**What still defers, and why it is a wall rather than a gap.** A **per-iteration global barrier**
(`dedup`/`order`/`limit`/`range`/`sample`/`tail`/`group`/`aggregate`/`local`) observes the whole
frontier at one iteration; precomputing it per-origin answers a *different question* — a global
`dedup()` drops a vertex two origins both reach, a per-origin one keeps both. The deferral now names
the offending step and says this, instead of reciting a vocabulary. **This is the trap in the
change**: the generic StepFns would happily lower it — bare `dedup` emits
`SELECT DISTINCT id, <carried>`, and with an origin column in the tuple that silently becomes
per-origin — so the gate cannot be "whatever `lowerElementSteps` accepts". It is the ROW-LOCAL
vocabulary, which already existed as `isElementChildStep`. Pinned by a test.

Also still deferred: `as()` through the walk (an alias is a per-hop-appendable JSON history, not a
column that rides), and `path()`/`simplePath()` + `sack()` bodies, which stay with the flat
expansion because both are per-iteration state. A fixed `times(n)` body could be **unrolled** into
n generic phases — that route hosts barriers and is the natural next slice; not built.

<details><summary>The original entry (the measurement that motivated all of the above)</summary>

`steps/prefix/branch.ts` (~300 lines: `moveDirs`, `dirCombos`, `expandRepeatBody`, `repeat`)

The largest second implementation in the compiler, and the only one that duplicates *movement*.
It has its own direction table (`moveDirs`, a near-copy of `plan.ts dirsFor`), its own cartesian
direction product, its own edge-alias scheme (`re1`, `re2`, …), its own `has()` handling, its own
edge↔vertex position threading — none of it reachable from `lowerElementSteps`.

**Measured:** 43 / 135 `repeat()` corpus traversals compile. 69 failures attribute directly to this
site. The body vocabulary is 4 steps wide against the seam's ~25:

```
OK    repeat(__.out())                        FAIL  repeat(__.out().hasLabel("person"))
OK    repeat(__.out().has("name","x"))        FAIL  repeat(__.out().hasId(1))
OK    repeat(__.out().simplePath())           FAIL  repeat(__.out().where(__.has("name","x")))
      + sack(op).by() / where(__.sack())      FAIL  repeat(__.out().not(…)) / .filter(…) / .dedup()
                                              FAIL  repeat(__.union(__.out(),__.in())) / .local(…)
                                              FAIL  repeat(__.out().limit(2)) / .order()
                                              FAIL  g.V().as("a").repeat(__.out()).times(2).select("a")
```

**It is walled in both directions** — this is what makes it #1 rather than #2. `repeat` is
explicitly excluded from `ELEMENT_CHILD_STEPS` (`tail/child-shape.ts:203`, "forks, repeat, sack …
need their explicit child policy"), so the walk composes at exactly one nested position:

```
OK    g.V().union(__.repeat(__.out()).times(2), __.in())
FAIL  g.V().local(__.repeat(__.out()).times(2))          FAIL  g.V().where(__.repeat(__.out()).times(2))
FAIL  g.V().map(__.repeat(__.out()).times(2).count())    FAIL  g.V().group().by(__.repeat(…).count())
FAIL  g.V().order().by(__.repeat(__.out()).times(2).count())
```

**It also owns the only place #6 has no fallback.** `walkPredicate` (`branch.ts:39`) routes
`until()`/`emit()` through the inline predicate compiler and **throws** when it declines — unlike
every other consumer, which falls through to the generic child-existence gate. So the inline
compiler's vocabulary is the hard ceiling here and nowhere else:
`until(__.union(__.out(),__.in()))` and `emit(__.out().fold().count(local).is(1))` both fail.

**Not fail-closed:** the named-loop form crashes rather than deferring —
`g.V().emit().repeat("a", __.out("knows").filter(__.loops("a").is(0)))` →
`undefined is not an object (evaluating 'node.constructor')`. 4–5 corpus cases. Worth a cheap
guard independent of the rest.

**Corroborated independently by the project's own L3 telemetry**, which was not the source for any of
the above — a full `mise run test` on the merged tree surfaces
`repeat(__.bothE().otherV().has()) not yet supported` as an 11-scenario / 7-type cluster in its top
band, e.g. `g.withStrategies(RepeatUnrollStrategy).V().repeat(__.bothE().otherV().has('age',lt(30))).times(2)`.
Two measurement routes, same site.

Subsumes outstanding-work **item 3** (alias columns through `repeat()`) and most of P3's
recursive-path tails.

</details>

**Two things from the original entry are NOT closed and remain open items:**
- **`walkPredicate` still has no generic fallback** — `until()`/`emit()` throws when the inline
  predicate compiler declines, so #6's leaf vocabulary is still load-bearing there. The route is the
  same trick as the body: compile an element-only until/emit predicate ONCE as a `matching(id)`
  relation and have the recursive term read `id IN matching`. A sack- or `loops()`-dependent
  predicate keeps the inline form.
- **The named-loop form still crashes rather than deferring** —
  `g.V().emit().repeat("a", __.out("knows").filter(__.loops("a").is(0)))` →
  `undefined is not an object (evaluating 'node.constructor')`, 4 corpus cases. A cheap guard,
  independent of everything above.

---

### ~~2. `seedUnion` — a strictly weaker copy of a family that is already generic~~
✅ **LANDED on trunk 2026-07-27** (`322e45c`), between this audit's first sweep and its re-measure.
`seedUnion` is deleted; each branch now lowers through `Engine.lowerRootedArm`
(`engine/engine.ts:250`) and the merge is picked from the arms' **kinds**. Kept here — not deleted —
because it is now the audit's **worked example**, and it is worth reading before starting #1, #3 or #4:

| same arms, two implementations | mid-traversal | source (before → after) |
|---|---|---|
| scalar arm | ✅ | `g.union(__.V().values("name"))` ❌ → **✅** |
| alias | ✅ | `g.union(__.V().as("a").out()).select("a")` ❌ → **✅** |
| path | ✅ | `g.union(__.V().out(),__.V().in()).path()` ❌ → **✅** |
| list arm | ✅ | `g.union(__.V().out().fold())` ❌ → ❌ (a `fold()` arm lowers to a terminal result) |

**Measured: 2/15 → 8/15** `g.union(…)`-rooted corpus traversals compile; the whole bucket left the
failure table. 26 lines deleted bought four fail-closed walls and closed item 4's `encounter`
residual as a side effect.

**Three transferable lessons, all confirmed rather than assumed:**
1. The **merges** were reusable verbatim (they take a bare `Carry`, not a parent stream); the
   **triage** was not, because `classifyBranchArms` describes a child body under a parent traverser
   and a source arm is a rooted traversal. **Dispatch on the lowered Stream's `kind`, not on syntax.**
   That is the same move #3 (`match`) and #4 (`path`) need.
2. Reach for **compileRead's own spine minus the root materialization** — the new `lowerRootedArm` —
   rather than `buildPrefix`, which stops at the prefix. Most of these sites reach for the prefix
   fold and inherit its element-only ceiling.
3. The residual is honest and narrow: a `fold()` arm is a *terminal* result, not a relation a merge
   can consume. That is a real boundary, not a vocabulary gap — exactly the shape a fail-closed
   deferral should have.

---

### 3. `match.ts` — the binding table, and a pattern vocabulary narrower than the seam it calls
`steps/prefix/match.ts` (118 lines)

**Now the top open site after #1** (#2 landed). Half-reformed already: `applyPattern:47` genuinely folds the pattern body through
`lowerElementSteps`, so movement/filter inside a pattern is *not* duplicated (`union` inside a
pattern works). What is hand-rolled is the re-projection around it — the binding table can only hold
node rowids, so anything that isn't an element defers:

```
OK    g.V().match(__.as("a").out("knows").as("b"))
OK    g.V().match(__.as("a").union(__.out(),__.in()).as("b"))
FAIL  g.V().match(__.as("a").out("knows").values("name").as("b"))   -- scalar end var
FAIL  g.V().match(__.as("a").out("knows").count().as("b"))          -- reduced end var
FAIL  g.V().match(__.as("a").outE("knows").as("b"))                 -- edge end var
```

**Measured:** 17 / 66 `match()` corpus traversals compile. **23 of the 49 failures are the
MATCH-*string* form** (`unsupported source step: match`) — that is outstanding-work **7b**, a
separate language-level decision, not this site. Real residual here ≈ 26.

Fix shape is #2's move, and #2 has now built the machinery: lower each pattern through the **full**
loop and bind on the resulting Stream's `kind` rather than requiring element. `lowerRootedArm`'s
kind-dispatch is the template; the difference is that a pattern is *seeded* from a bound var rather
than rooted, so it wants `lowerStepsStrict` over `applyPattern`'s existing seed, not a fresh source.

---

### 4. `path.ts` — two positional projectors, one of them stuck at `by(key)`
`steps/tail/path.ts:239-291` (`compilePathArray`, ~61 lines) vs `lowerPathPositionChild:87`

The LINEAR regime (one column per position) runs a real child per position. The
RECURSIVE/grouped regime (a JSONB array walked by `json_each`) hard-codes `nodePropScalar(key)` and
throws for everything else — the same `by()` body, two answers depending on how the path was built:

```
OK    g.V().out().path().by(__.values("name"))
OK    g.V().out().path().by(__.out().count())
OK    g.V().repeat(__.out()).times(2).path().by("name")
FAIL  g.V().repeat(__.out()).times(2).path().by(__.values("name"))   -- path().by(traversal) modulator not yet supported
FAIL  g.V().repeat(__.out()).times(2).path().by(T.id)
```

**Measured:** 7 / 42 `path().by(…)` corpus traversals fail (was 9 pre-merge — trunk's union-source
work fixed `path()` over a union source); 14 attribute to path.ts overall. Needs a
positional-child substrate over `json_each` — push a child scope per position — which is the
mode-C question again. Already filed under P3 recursive-path tails; this sweep adds the
linear-vs-recursive asymmetry as the sharp framing.

---

### 5. `write.ts` — a hand-rolled match SELECT plus a row-at-a-time JS driver loop
`steps/write/write.ts:714-878` (`commonMergeConds`, `mergeMatchQuery`, `edgeMatchQuery`,
`mergeDrivers`, `resolveEndpoint`) — ~276 lines in the merge region

`mergeMatchQuery` assembles `SELECT id, uid, (SELECT name FROM labels …) FROM nodes WHERE <conds>` —
which is precisely what `V().hasLabel(l).has(k,v)` lowers to. It reuses the *leaf* builders
(`labelIn`, `nodeHasProp`) but not the *relation*, and it is re-rendered and re-executed **once per
incoming driver** inside a JS `for` loop (`compileMergeV:767`), each iteration a separate
`store.query`. `resolveEndpoint:593` and `mergeDrivers:749` do the same: `buildPrefixFresh` →
render → execute → read rows back into JS.

**Measured:** ~26 real deferrals (of 67 mergeV/mergeE corpus failures, **41 are a probe artifact** —
`mergeV(xx1)` with an unbound Map param — do not count them). Gates PartitionStrategy-aware upsert,
map-valued merge drivers, `property()` after `addV()`, `drop()` after `properties()`.

Ranked below #4 despite the line count for one reason the user's criterion makes decisive: this is
the write path, so fixing it unblocks a *cluster* but never composes at depth. It is the acknowledged
`write.ts` row-at-a-time debt in `outstanding-work.md` and `.claude/rules/schema-storage.md`;
this sweep confirms it open and sizes it.

---

### 6. `predicate.ts` — ✅ **FIXED 2026-07-27.** A fast path was hiding a capability
`steps/prefix/predicate.ts` (~264 → ~240 lines)

The question this entry originally answered was "should `tryInlinePredicate` die?" **No — and that
was the wrong question.** Two measurements settle it:

- **The perf is real.** On a synthetic 20k-vertex / 160k-edge graph, inline vs generic is
  **1.2×–17×** (the reducer case `where(__.out().count().is(gt(4)))`: 11.7ms vs 191.6ms), results
  identical in every case. Deleting it would be a regression, not a cleanup.
- **It was NOT disable-safe, which its own contract claimed it was.** Compiling the whole corpus
  with `predicateInlining:false` regressed **exactly 6 traversals** — every one the infix
  `.and()`/`.or()` connector form. The FastPath law (`compiler/CLAUDE.md`) is that "disabling it
  compiles the same traversal generically"; `splitInfixConnectors` had no generic equivalent
  anywhere, so flipping the flag lost a *capability*, not an optimization.

So the module was **misclassified, not redundant** — a genuine fast path with one load-bearing
capability welded inside it. Three things followed, all landed:

1. **`splitInfixConnectors` → `ConnectiveStrategy`, a `fold` Pass** (`ir/strategies.ts
   foldConnectives`). TinkerPop's own name for this rewrite is ConnectiveStrategy, and
   `NO_OP_STRATEGIES` *already claimed* the effect was "unconditionally baked into our compiler" —
   a false statement, now true. It belongs there by the project's own law: every `Step[]→Step[]`
   rewrite is one Pass.
   - **Disable-safety measured both ways: 0 regress, 0 newly-compile.** The flag is now a pure
     performance switch.
   - **+5 corpus compiles, L3 1,436 → 1,440.** Top-level infix
     (`g.V().has("name","marko").and().has(…)`) threw `and() needs at least two traversal branches`
     before — the fold only ever ran on child bodies. One of the three fixed scenarios is literally
     tagged `withStrategies(ConnectiveStrategy)`.
   - Two subtleties, both found by measurement rather than reasoning, both now pinned in
     `passes.exec.test.ts`:
     **(a)** a SOURCE step must not be absorbed into an operand (TinkerPop guards this with
     `legalCurrentStep` excluding `GraphStep`) — and in OUR IR that extends to an `as()` sitting on
     the source, because a label here *is* a step and folding it into the branch would confine a
     bind the outer traverser still needs. Getting this wrong showed up as one traversal that
     compiled only with the fast path OFF.
     **(b)** the recursion must be **identity-preserving**. `recurseInject` rebuilds every
     `{nested}` arg as a `Step[]`, which is fine for a strategy-gated decoration pass but not an
     unconditional one: a `{nested}` arg may still be a raw parse tree, and
     `services/params/traversal-param.ts` un-parses one back to Gremlin via the client's
     TranslateVisitor. Using it broke every `federate` `with("traversal", __.V())` param with
     `tree.accept is not a function`.
2. **The decline signal is a type, not a message prefix.** `tryInlinePredicate` sniffed
   `includes('not yet supported') && startsWith('where'|'filter')` — a support boundary defined by
   string shape, so `empty where()/filter() traversal` escaped as a hard error and
   `g.V().filter(__.is(0))` crashed. Now an `InlineDecline` marker class, and each of the 12 throw
   sites states which of the two it means (10 decline, 2 stay genuine illegalities: movement off an
   edge, a malformed connective).
3. **The equivalence test could not see the violation** — its 6 hand-picked shapes all happened to
   have fallbacks. It now carries the infix cases as a standing regression guard.

**Still true:** the leaf vocabulary (`has`/`hasLabel`/`hasId`/`values`/`label`/`loops`/`not`) remains
duplicated, and is now kept for exactly one reason — `until()`/`emit()`, where `walkPredicate` has no
fallback. That is #1's territory, and #1's body-relation route discharges it too: compile an
element-only until/emit predicate ONCE over all vertices as a `matching(id)` relation and the
recursive term reads `id IN matching`. A sack- or `loops()`-dependent predicate still needs the
inline form, so this shrinks the vocabulary rather than deleting it.

---

### 7. `child.ts` — the third scalar-child projector residue
`steps/tail/child.ts:423-…` (the "bespoke element-projection SQL builder", ~60 lines), reached from
`compileScalarChildRows:313`

Already mostly reformed (the common path now runs `lowerStepsStrict`). What remains hard-codes
`values`/`id`/`label`/`constant` against the generic `PROJECTORS` table's seven
(`tail/projection.ts:908`), and reads `vp.value` raw where the generic projector reads
`storedValueExpr(value, vtype)`. Now only reachable when the suffix carries a scoped reducer or a
`constant()` terminal, so the blast radius is small — I could not construct a divergent answer
through it. Confirms the existing Low debt item; do it opportunistically.

---

### 8. `services/catalog/search.ts` — a duplicate property→owner projection
`services/catalog/search.ts:73` (`searchProperties`, ~25 lines of SQL)

Builds the vertex/edge property payload join by hand and its own comment admits it: *"mirroring
`lowerProperties`"* — which exists, at `tail/group.ts:648`. Zero deferrals today; pure duplication,
and a schema change has to land in two places.

The contrast is instructive and belongs in the same entry: `services/catalog/degree-centrality.ts`
does the opposite — it calls `scopedMovementCount` and therefore gets
`where(call("tinker.degree.centrality").is(n))` at arbitrary depth **for free**. Two services, two
philosophies; the second one is the model.

---

### 9. Leaf-level, cosmetic
- `tail/group.ts:377` — the `properties()` inner-group expansion hand-joins `vertex_properties`
  where the sibling branch two lines up correctly routes through the child seam.
- `plan/plan.ts` `nodeProp*`/`edgeProp*` pairs — one `propSource(elem)` descriptor halves it.
  Already filed; opportunistic.

### Sanctioned — do NOT "consolidate" these
- **`tail/bulk.ts:215`** — the unrolled hop join is a `FastPath` with a declared equivalence
  contract that declines to generic lowering. That is the sanctioned form of duplication.
- **`tail/correlated.ts`** — mode B itself. It is the reuse substrate, not a copy of one.
- **`services/fts-index.ts`** — a write-path indexer over the in-memory `{t,v}` tree, deliberately
  not SQL (a trigger would index tag noise). Not a traversal at all.

---

## Method

`compile()` over all 2,298 L1 corpus traversals with a permissive param bag and the standard service
registry; failures bucketed by message and attributed to a site. **1,626 compile / 672 fail**
post-merge (1,620 / 678 before it). Composability claims are direct `compile()` probes of matched
pairs (same body, different position), not inference. The SQLite `LATERAL` and body-relation results
are `bun:sqlite` runs, quoted verbatim above. Scripts were scratch; the probe is ~40 lines and worth
re-running after any of these land — doing exactly that is what caught #2 landing under this doc.

**Three caveats on the numbers.** (1) Compiling is an upper bound on passing — corpus-compile 1,626
vs the L3 ratchet's 1,436. (2) A traversal fails at its *first* wall, so a site's count is a lower bound on what it
gates; the 41 `mergeV(xx1)` lines are the one known artifact and are excluded from #5's figure.
(3) Line anchors are as of the trunk merge (`545bb4b`) and drift — the function names are the stable
handle, not the numbers.
