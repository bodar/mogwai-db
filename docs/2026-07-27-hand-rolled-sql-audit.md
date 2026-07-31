# Hand-rolled SQL audit — where a second implementation replaced the substrate

_Swept 2026-07-27, then re-measured twice as trunk moved under it. Every count below is **measured**,
not estimated: the method is at the bottom. Ranked by (duplication × family unblock × reach at depth),
which is not the same as ranking by lines._

**Names in this doc predate the 2026-07-29 rename** (`Carry` → `LoweringState`, `carryFrag` →
`layoutProjection`, `carriedCols` → `layoutCols`, `foldByModulators` → `absorbModulators`,
`foldConnectives` → `canonicalizeConnectives`). The narrative is a record of closed sites and is
left as written; the full map is in
[tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md).

> ## STATUS 2026-07-30 (L3 1623) — **this audit is DONE. All nine sites are closed.**
>
> _Six closed by 2026-07-27, when THREE premises in this doc were also falsified by measurement (see
> below — the original entry text still reflects the pre-fix state in each case). The last four
> closed 2026-07-30._
>
> What remains under #5 is not hand-rolled SQL and never was: a MAP-shaped merge driver (~22 of the ~25 real merge deferrals —
> tracked as `outstanding-work` item 0b) and a decision about the write path's row-at-a-time
> execution model. **Neither is this doc's subject, so re-measure before treating #5 as open work
> here** — its entry now records what is actually left.
>
> **Three of the four closed that day were MIS-RANKED in this doc, all in the same direction and for
> the same reason: a duplicate filed as *cosmetic* or *Low* because no divergent answer had been
> constructed.** In every case one existed. #9's property expansion was the entire safety argument
> for a vertex-only wall; #7's second projector answered NOTHING where the root answers a list;
> #8's "mirror" of `lowerProperties` had already drifted. **A second implementation whose
> equivalence rests on "I could not construct a counterexample" is UNRANKED, not Low** — and the
> thing to interrogate is the probe set, because all three counterexamples needed a shape the
> reference graphs do not contain (a collection-valued property, an edge-owned property).
>
> **The fourth was found by generated input, not by reading.** L5's per-commit seed rotation caught
> `predicateInlining` THROWING where the generic path answers — the same FastPath law as #6, broken
> in the opposite direction, and structurally invisible to this doc's own cheap check (see #6).
>
> **The recurring lesson, now four times over: the abstraction usually already existed, and the site
> was blocked on REACHING it.** #1 needed no new rendering mode (a recursive term may reference a
> non-recursive CTE). #3 needed no new binding mechanism (the alias table was always shape-generic;
> the element-only prefix fold was the wall) and no new reducer path (the child seam's scalar entry
> points just demanded a parse tree a pattern body does not have). #4 needed no new positional-child
> substrate (spelling the `json_each` explode as an ElementStream, via `origins`, let the LINEAR
> regime's child compiler serve it unchanged). Predicting "this needs a new substrate" was wrong
> every time; the cheap check is to ask what the existing seam cannot *express* versus what it merely
> cannot be *handed*.
>
> | # | site | state |
> |---|---|---|
> | 1 | `expandRepeatBody` — the repeat body mini-compiler | ✅ retired as the vocabulary; it is now a fast path |
> | 2 | `seedUnion` | ✅ landed on trunk |
> | 6 | `predicate.ts` infix connectives | ✅ extracted to `ConnectiveStrategy`, a fold Pass |
> | — | the child seam's shape ceiling *(not originally a numbered site)* | ✅ now shape-generic: ONE rejoin, map + record bodies |
> | 3 | `match()` binding table | ✅ shape-generic ends + per-binding reducers; residual is `fold()` and the MATCH-string form (7b) |
> | 4 | `path.ts` grouped positional projector | ✅ one projector AND one positional child compiler; both regimes agree |
> | 5 | `write.ts` merge/endpoint | ✅ no hand-rolled SQL left (2026-07-30); the residual is a map-shaped driver + a write-path execution-model decision, both tracked elsewhere |
> | 8 | `search.ts` duplicate property payload | ✅ closed 2026-07-30 — one payload, two provisionings |
> | 9 | leaf dups | ✅ closed 2026-07-30 — both halves; the property one was hiding a vertex-only wall |
> | 7 | `child.ts` residue | ✅ closed 2026-07-30 — it was a SILENT WRONG ANSWER, not Low |
> | — | mode C *(this doc's "one structural finding")* | ❌ **retired — measured unnecessary, see below** |
>
> **Three premises here are FALSE — do not rebuild on them:**
> 1. *"Mode C (flat accumulation) is a missing rendering mode the compiler needs."* Avoidable, and
>    now measured avoidable at **every** site it was claimed for, not just #1 — see "the one
>    structural finding" below, which is fully retracted. A recursive term may reference a
>    NON-recursive CTE, so the body compiles once through the ordinary seam as a
>    `(from_id, to_id)` relation the term joins. No new mode was added, and none should be.
> 2. *"The remaining shapes are blocked on making the tail's terminal boundary relational."*
>    `project`/`group`/`path` already HAVE relational forms; they were blocked on having no child
>    PROVIDER. And `local(__.out())` already worked, so "the element terminal needs a relational form"
>    was imaginary too.
> 3. *"Mode B cannot stand in for mode C."* True only in **FROM-clause position**. A correlated
>    scalar subquery in a recursive term's SELECT list *does* see the walk row (verified below), so
>    mode B works inside recursion — just not for a body that FANS OUT. The fan-out, not the
>    correlation, is what `expandRepeatBody` is really working around.
>
> **The biggest remaining ceiling gap is not in this list**: parent-shape uniformity (67 corpus
> traversals, ~35 steps — the same step working over an element stream but not a scalar/list/path/map
> one). Logged as item 5c in `outstanding-work.md`.
>
> **Method note worth keeping:** twice in this effort I escalated a hypothetical to a "needs a human
> decision" (a T-token tag in the `{t,v}` vocabulary; group's value-mode matrix). Both dissolved on
> one grep for demand — zero and two corpus traversals respectively. Check demand before designing.

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

## The one structural finding — ❌ **RETRACTED. Mode C is not needed. Do not build it.**

_Checked 2026-07-27, as this section asked: 14 `bun:sqlite` probes over a seeded modern graph, one
group per claimed site, each result verified against an expected value rather than "it ran".
Conclusion: **no site needs a third rendering mode.** The kernel has two, and two is enough._

The reasoning error was scoping the problem as *rendering* when it is *provisioning*. Mode C's
unique capability is narrow and precise:

> a child body can reference a row-source living in the **same FROM clause**.

Mode A can't (each step wraps the previous as a subquery); mode B can't (correlation reaches
OUTWARD through a WHERE/EXISTS boundary, never sideways into a sibling FROM item). So the real
question is not "is mode C nice" but **which row-sources cannot first be materialized as their own
relation and joined on a key** — and the measured answer is: in SQLite, only a recursive CTE's
self-reference. Every other claimed site materializes fine.

| mode | who owns it | shape | used by |
|---|---|---|---|
| A — materialized CTE | `Query.cte` (`sql/kernel/q.ts`) | `WITH c0 AS (…), c1 AS (SELECT … FROM c0)` | the root + child seam |
| B — nested correlated derived | **`DerivedQuery` (`sql/kernel/q.ts`)** | `EXISTS(SELECT 1 FROM (SELECT … FROM (SELECT <outer.id>) x0) x1)` | `where`/`filter`/`and`/`or`/`choose`/`until` |
| ~~C — flat accumulation~~ | ~~nobody~~ | ~~one SELECT whose FROM/WHERE is appended to~~ | **retired: `expandRepeatBody`'s fast path is the only instance and stays one** |

Both modes now live in the kernel — mode B moved there as `DerivedQuery`, since "nest instead of
name" is a property of `Query`, not of traversals. Correlation is what the *caller* seeds; the
inline correlated child (`steps/tail/correlated.ts`) is the two composed.

### What each site actually needs — the keyed child relation, not a mode

The primitive all three sites share was already in the codebase **three times**: compile a child body
ONCE over its whole domain, keyed by its origin, then JOIN on the key. `repeatBodyRelation` (#1's
`(from_id, to_id)`), the LINEAR path regime's per-position child (keyed by ordinal,
`LEFT JOIN … ON b.o0 = p.o0`), and both routes verified below.

✅ **Extracted 2026-07-27 as `steps/tail/keyed.ts` (`keyedChildRelation`/`keyedKeySet`)** — the third
way to PROVISION a child body, sitting alongside the other two rather than being a fourth rendering
mode. The distinction the module makes explicit, and the reason all three belong in one vocabulary:
provisioning is about **where the child's input comes from**, not how SQL is rendered.

| provisioning | input | rejoin | who |
|---|---|---|---|
| parent stream | the parent's rows | ordinal | `pushChildScope` + `applyChildCardinality` |
| outer row | an expression naming the row being filtered | correlation | `compileCorrelatedChild` |
| **keyed relation** | its WHOLE domain, once | **JOIN on the key** | **`keyedChildRelation`** |

Two consumers today (`repeat()`'s body and `until()`/`emit()`'s predicate — the latter closed by the
extraction, see #1), and the guards live in one place instead of being re-derived per site. That
mattered immediately: the original had a **silent wrong answer** the extraction fixed. It classified
bodies with the caller's labels but seeded an empty alias map, so a label-mentioning body compiled
and returned NOTHING — `g.V().as("a").repeat(__.out().where(__.select("a"))).times(1)` gave 0 rows
where the same body outside `repeat()` gives 6. The keyed domain is every vertex, so there is no
outer row to read an alias column from; it now DECLINES such a body, exactly as the inline correlated
renderer does when handed no `LabelScope`. Same guardrail, one place, two renderers.

- **#4 `path.ts` grouped regime — no mode C.** SQLite gives table-valued functions the one
  lateral-ish affordance it has, so `FROM paths pp, json_each(pp.path) je` already works; the
  explode then materializes as `(pk, ord, id)` and the `by()` child keys off `id`. Pure mode A —
  structurally identical to what the linear regime already does. Verified with a real child
  traversal, not just a property: `by(__.out().count())` → `[3,2,0],[3,2,0]`, and
  `by(__.out().has("name","lop").count())` → `[1,1,0],[1,1,0]`. Mode B over the exploded CTE works
  too, so there are *two* routes and neither is new.
- **#5 `write.ts` merge — not mode C at all.** `mergeMatchQuery` isn't correlating with anything:
  the driver id is resolved in JS and bound as a literal. It is mode A with the correlation done by
  a **round-trip**, which is a different defect (row-at-a-time execution) with a different fix.
  Set-based `drivers ⋈ match` runs in one query; the genuinely per-driver part — a merge map whose
  value is a traversal seeded at the driver — becomes a keyed `(driver, value)` relation. Both
  verified.
- **#1 `repeat` — the one real constraint, and it is about FAN-OUT.** Correlation inside a recursive
  term is fine: a correlated scalar subquery in the recursive term's SELECT list *does* see the walk
  row (verified — this falsifies the blanket "mode B cannot stand in for mode C"). What a scalar
  subquery cannot do is return MANY rows per input row, and a movement fans out. Fan-out needs FROM
  position; FROM position has no lateral. **That** is why `expandRepeatBody` is hand-rolled — and it
  stays, as the recognized fast path, with the generic body relation as the fallback. Nothing to
  build.

The `LATERAL` evidence below is still correct and still worth keeping — it explains why
`expandRepeatBody` exists. It just does not imply a third mode:

```
FAIL  with recursive w(id,depth) as (select 1,0 union all
        select x.id, w.depth+1 from w, (select e.tgt as id from edges e
          join (select w.id as id) x0 on e.src=x0.id) x where w.depth<3) …
      -> no such column: w.id
OK    … select e.tgt, w.depth+1 from w join edges e on e.src=w.id …     (mode C, flat join)
```

**What the re-measure ADDED, and why it flips the conclusion.** SQLite's lateral rule is not
"none" — it is positional, and the three positions differ. This is the whole finding:

```
OK    from paths pp, json_each(pp.path) je                    -- table-valued fn: sees earlier FROM item
FAIL  from paths pp, json_each(pp.path) je,
        (select count(*) c from edges where src=je.value) x    -- derived table: no such column: je.value
OK    select (select count(*) from edges e where e.src=je.value)
        from paths pp, json_each(pp.path) je                   -- correlated scalar subquery: sees it
OK    with recursive w(id,depth,deg) as (select 1,0,… union all
        select e.tgt, w.depth+1, (select count(*) from edges e2 where e2.src=e.tgt)
        from w join edges e on e.src=w.id where w.depth<2) …    -- ditto INSIDE recursion
```

So the constraint is **fan-out in FROM position**, not correlation. A scalar subquery correlates
freely (even into a recursive term) but returns one row; a movement needs many. Everything that
only needs one value per row — which is every `by()`, every merge-map value, every until/emit
predicate — has a route today. `expandRepeatBody` keeps its flat join because a movement body is
exactly the fan-out case, and it is a **fast path** with the generic body relation behind it.

So `expandRepeatBody` is not laziness — it is a lazy frontier walk, kept for that reason.
`path.ts`'s grouped positional projector and `write.ts`'s merge-match were filed alongside it on the
assumption that they share the constraint; **measured, they do not** — neither one fans out inside a
recursive term, so both reduce to a keyed relation plus a join.

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

**One thing from the original entry is now CLOSED; one remains open:**
- ✅ **`walkPredicate` has its generic fallback** (2026-07-27), and it is the SECOND consumer of the
  extracted **keyed child relation** (`steps/tail/keyed.ts`) — which is what made the extraction
  worth doing rather than a rename. A row-local until/emit predicate compiles ONCE over every vertex
  and the recursive term reads `id IN <origin set>`; `until()`/`emit()` are existence, so that is the
  whole semantics. Inline stays FIRST (it alone reads `loops()`/the sack, so it is a capability not
  an optimization, which is why it is not declared a FastPath). Per-iteration bodies need no extra
  guard: `loops` and bare `sack()` are outside the row-local vocabulary, so the keyed route declines
  them itself. **Measured:** 3 of 9 until/emit probes moved FAIL→OK (all the branch predicates —
  `until(__.union(…))`, `coalesce`), 0 regressions; corpus +1, **L3 1473 → 1474**, and the newly
  passing scenario is exactly the nested case
  `g_V_repeatXoutXknowsXX_untilXrepeatXoutXcreatedXX_emitXhasXname_lopXXX_path_byXnameX`.
- ✅ **The named-loop form now defers instead of crashing** (verified 2026-07-30 by probe, not by
  reading): `g.V().emit().repeat("a", __.out("knows").filter(__.loops("a").is(0)))` and
  `g.V().repeat("a", __.out()).times(2)` both throw
  `repeat(name, body)/loops(name) named-loop form not yet supported (requires named loop counters)`.
  It is L3's 4th-largest failure cluster (15 scenarios, 10 types) — but as a fail-closed deferral,
  which is where this entry wanted it. Implementing named loop counters is a separate feature.

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

### 3. `match.ts` — ✅ **CLOSED 2026-07-27.** Shape-generic ends + per-binding reducers
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

**What landed — exactly that, and the diagnosis above was wrong in an instructive way.** The binding
table was **never** the limitation. `aliasEntry` has tagged node/edge/value/list/map since labels
became path histories, so "the binding table can only hold node rowids" was describing
`applyPattern`, not the table. What actually walled it in was folding only the ELEMENT prefix
(`lowerElementSteps`), which stops at the first non-element step — which is why `values()` surfaced
as "unsupported pattern step" rather than as a binding problem. Running the full loop (prefix fold →
`lowerStepsStrict`, rejecting a terminal result) and dispatching on the result's `kind` removes both
named walls at once, with no new SQL and no new binding mechanism.

Two things fell out that this entry did not predict:
- **A var's SHAPE must be recorded at bind time**, not assumed `'node'`. Two consumers need it:
  re-rooting a later pattern on the var (an edge rowid read as a node id is silently wrong — both are
  integers), and rejecting a re-bind at a different shape (comparing a rowid against a value is
  meaningless rather than narrower, so it must not emit SQL that quietly never matches). That is what
  makes an edge var usable as a pattern START —
  `as("a").outE().as("e"), as("e").inV().as("b")` — which was not on the wish list.
- **The reducer case is a DIFFERENT defect** — it does not close with the others, and it is now
  closed on its own terms. `count()` in a pattern body is a GLOBAL barrier over what is here the
  binding table, so lowering it at that scope answers one count across ALL bindings where the pattern
  asks for one per binding. So a barrier body routes through the CHILD SEAM instead, whose
  cardinality rejoin restores exactly one row per binding. Two routes, chosen by a real semantic
  fact (`isGlobalBarrier` — the same predicate `repeat()` uses, moved out of `branch.ts` into
  `child-shape.ts` rather than copied) instead of by a vocabulary.

  **What had kept `match()` out of that seam was not the seam's shape — it was reachability.** The
  scalar-child entry points required a `nested` PARSE TREE, and a pattern body is a `Step[]` SLICE
  between its `as()` wrappers with no tree of its own, even though those entry points already
  accepted a pre-parsed body. Changing the guard from "I have a tree" to "I have a body from
  somewhere" made it reuse rather than a second reducer implementation. Same lesson as #4: reaching
  an existing seam beat adding machinery.

  **Measured:** every reducer form is verified EQUAL to `map(__.<same body>)` — `count`/`sum`/`max`
  over `out`/`both`/`outE().values()` — so the per-binding semantics are pinned against an
  established route, not against constants. `g.V().match(as("a").out("knows").count().as("b"))`
  gives `[2,0,0,0,0,0]` where a global reduction would give one row of `2`. Residual: a LIST-shaped
  end var (`fold()`), and `where(var,P)` on a scalar-bound var — a downstream alias-compare gap that
  only became REACHABLE now that a scalar var can be bound at all.

**Measured:** of the three named shapes, 2 now compile and 1 defers with the real obstacle named;
match's real corpus bucket 17 → 14. `select()` on a scalar-bound var and on an edge-bound var both
return the right values, and `values("age")` round-trips as an INTEGER (the static type tag rides
into the entry). CI 915/0, L3 unmoved.

---

### 4. `path.ts` — ✅ **CLOSED 2026-07-27.** One projector, one positional child, both regimes agree
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
work fixed `path()` over a union source); 14 attribute to path.ts overall. Already filed under P3
recursive-path tails; this sweep adds the linear-vs-recursive asymmetry as the sharp framing.

**What landed.** The two hand-rolled by()-interpretation switches are now ONE (`positionScalar`),
parameterized by a `ScalarCtx` — the linear regime passes `elemCtx` over its joined position table
(direct columns), the grouped one `aliasCtx` over the exploded `je.value` (correlated reads). Same
`by()` ⇒ same answer, where before the grouped side hardcoded `nodePropScalar(key)` and threw for
everything else. So `by(T.id)`/`by(T.label)` work on a recursive path now, and the non-productive
drop guard reuses the same projector instead of rebuilding the property read a second time. Linear
output is unchanged (including edge positions, which read off `edges` — `scalarProp` already
dispatched on `ctx.elem`, the hand-rolled switch was duplicating that dispatch).

**A note on how this got ranked.** It was briefly demoted on measured CORPUS demand (~1 traversal).
That was the wrong axis — this list ranks by (duplication × family unblock × reach at depth), none of
which is a corpus count. The defect here is that the same modulator answered two different ways
depending on how the path was built; a floor metric cannot see that at all.

**`by(traversal)` over a recursive path — ✅ CLOSED, and the fix needed NO new abstraction.** The
seam problem was real: the explode is naturally `(id, pk, ord)` while an ElementStream's physical
schema is `['id', ...carriedCols]`, so `pk`/`ord` cannot just ride alongside. They ride as
**`origins`** — which is exactly what that slot means ("which parent did this row come from"), and
for a path element the answer literally is "path `pk`, position `ord`". That makes the exploded rows
an ordinary element stream, so `pushChildScope` mints its ordinal after them and the rejoin is the
same `LEFT JOIN … ON b.<ordinal> = d.<ordinal>` the linear regime already does.

The child itself is `lowerPathPositionChild`, **unchanged and shared** — fan-out guards, the
`choose`/`coalesce` branch route and the `first` collapse are ONE implementation for both regimes.
A grouped path is in fact the easier case: `bys.length > 1` already defers, so a single uniform
`by()` means one child rather than one per position.

I had predicted this would want a "scalar sibling to `keyedChildRelation`". It did not, and that is
worth recording: the child seam was already the right abstraction, and what kept this regime out of
it was only that its explode could not be spelled as an ElementStream. **Reaching an existing seam
beat adding a fourth provisioning strategy.**

**Measured:** `by(__.values("name"))` on a recursive path equals `by("name")`; `by(__.out().count())`
→ `[3,2,0],[3,2,0]` and the LINEAR regime gives the same; `by(__.in().count())` → `[0,1,3],[0,1,1]`;
non-productive drop and ProductiveBy agree with the by(key) forms even though one filters
pre-numbering and the other group-wise post-join; the shared fan-out guard still rejects `union()`
at a position.

**The route, measured (2026-07-27) — no new rendering mode, and simpler than the linear case.**
Materialize the `json_each` explode as its own `(pk, ord, id)` relation, push ONE child scope over
it, and `LEFT JOIN` the child back on the ordinal — structurally what `lowerPath` already does per
position. It is *easier* than linear because `compilePathArray` already defers `bys.length > 1`, so
a grouped path has exactly ONE `by()` body applied uniformly: one child lowering, not N. Verified
end-to-end on a seeded graph — `by(__.out().count())` → `[3,2,0],[3,2,0]` and
`by(__.out().has("name","lop").count())` → `[1,1,0],[1,1,0]`, both matching the expected values, and
a mode-B correlated child over the exploded CTE gives the same answers. What must go with it:
`nodePropScalar(key)` gives way to the generic projector (so `by(T.id)` stops being special), and
the `bys.length > 1` deferral can stay — round-robin over a dynamic length is a real semantic wall,
not a vocabulary gap.

---

### 5. `write.ts` — the only open site, and **its "hand-rolled SQL" half is now closed too**
`steps/write/write.ts` (`commonMergeConds`, `mergeMatchQuery`, `edgeMatchQuery`, `mergeDrivers`,
`resolveEndpoint`)

**Re-measured 2026-07-30, and this entry was stale in the direction that matters: there is no
hand-rolled SQL left here.** The original complaint was that `mergeMatchQuery` assembles
`SELECT id, uid, (SELECT name FROM labels …) FROM nodes WHERE <conds>` — reusing the *leaf*
builders but not the *relation*. Today `commonMergeConds` builds through `propHasFor` /
`vertexLabelIn` / `labelIn`, `mergeMatchQuery` is five lines with no projection of its own, and the
last hand-written label subquery (it had moved to `edgeMatchQuery`) now goes through the label
seam. The six remaining raw SQL strings in the file are single-row imperative reads/writes
(`insertVertexProperty`, `nodeExtId`, …) — the acknowledged imperative write surface, not a second
implementation of traversal semantics, which is what this audit hunts. **Rebuilding the match as a
lowered `V().hasLabel(l).has(k,v)` relation would produce heavier SQL inside a per-driver loop and
buy nothing; do not do it as a "consolidation".**

**What is genuinely open here is not SQL shape at all**, and it splits in two — neither of which
belongs to this doc's subject:

1. **The row-at-a-time execution model.** `run` renders and executes once per incoming driver, and
   it interleaves reads with INSERTs and reads back what it wrote — so a set-based form has to
   decide match-vs-create for the whole driver set *before* writing. Both set-based routes were
   verified in 2026-07-27 (`drivers ⋈ match` in one query; the per-driver merge-map value as a
   keyed `(driver, value)` relation), so **rendering was never the blocker**. This is the
   acknowledged debt in `outstanding-work.md` and `.claude/rules/schema-storage.md`, and it is a
   design decision about the write path's execution model, not a lowering gap.
2. **A MAP-shaped merge driver** — which is what the failures actually are.

**Measured 2026-07-30** from the census deferrals (a two-way baseline, better than the original
compile sweep): of the mergeV/mergeE deferrals, **48 are the `xx1` unbound-Map-param probe
artifact** (the original entry said 41 — same artifact, do not count them), and a further handful
are TinkerPop-SPECIFIED errors we raise correctly ("merge step can only take an array or an
Iterable", "can't be null"). The ~25 real ones are dominated by one theme:

| n | deferral | what it needs |
|---|---|---|
| 11 | `merge with select('m') needs a withSideEffect('m', map) constant` | a map-shaped driver |
| 6 | `merge whole-arg traversal … not yet supported` | a map-shaped driver |
| 3 | `mergeE: missing outV endpoint` | endpoint from the incoming traverser |
| 3 | `mergeV()/mergeE() with no argument` | a map-shaped driver (the traverser IS the map) |
| 2 | `merge() cannot consume the elementMap result shape` | a map-shaped driver |
| 1 | `merge() on a record value` | a map-shaped driver |

So **~22 of ~25 are one feature**: the merge map arriving as a MAP-shaped stream rather than a
literal with per-key nested traversals. That is `outstanding-work` item **0b**'s named remaining
consumer (`ElementReadDriver` has a scalar driver; whole-map `MergeStep`/`MergeElementStep`/
`MergeEdgeStep` bodies need a map-shaped one) — a feature, tracked there, not hand-rolled SQL.

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

**The same law broken from the other side — found 2026-07-30 by L5, fixed.** The 2026-07-27 entry
found `predicateInlining` LOSING a capability when disabled. The rotating L5 seed found it GAINING
a throw when enabled: `g.V(1).where(__.out().repeat(__.identity()).times(1))` executes with the
flag off and throws *"a nested-derived Query has no shared WITH and cannot host a recursive CTE"*
with it on (same for `filter()`/`not()`, and for any body where a movement precedes the `repeat`
— a `repeat` FIRST never reaches the inline renderer, which is why nothing caught it).

The kernel guard was correct: mode B genuinely has no shared `WITH` to attach a recursive CTE to.
A fail-closed THROW is simply the wrong signal at a site whose contract is *recognition failure
falls through*. `needsRecursiveCte` (the pure classify leaf) now answers the renderer's question
before it starts, at any nesting depth, and `compileCorrelatedChild` declines to the materialized
gate; the kernel guard is the backstop behind that, not the mechanism. Pinned beside the infix
cases in the `predicateInlining` equivalence test.

**The transferable part:** "compile the corpus with the flag off and diff" (this entry's cheap
check) only finds the LOSE direction. The GAIN direction — a shape the fast path claims and then
fails — needs generated input, because nobody writes `where(__.out().repeat(__.identity()))` by
hand. That is exactly what L5's per-commit seed rotation is for, and it is the first defect it has
paid for.

**Still true:** the leaf vocabulary (`has`/`hasLabel`/`hasId`/`values`/`label`/`loops`/`not`) remains
duplicated, and is now kept for exactly one reason — `until()`/`emit()`, where `walkPredicate` has no
fallback. That is #1's territory, and #1's body-relation route discharges it too: compile an
element-only until/emit predicate ONCE over all vertices as a `matching(id)` relation and the
recursive term reads `id IN matching`. A sack- or `loops()`-dependent predicate still needs the
inline form, so this shrinks the vocabulary rather than deleting it.

---

### 7. `child.ts` — ✅ **CLOSED 2026-07-30, and the "Low" ranking was wrong**
`steps/tail/child.ts` (the "bespoke element-projection SQL builder", ~60 lines), reached from
`compileScalarChildRows`

The residue hard-coded `values`/`id`/`label`/`constant` against the generic `PROJECTORS` table's
seven and read `vp.value` raw where the projector reads `storedValueExpr(value, vtype)` and tags
the scalar `PER_ROW('vtype')`. **This entry ranked it Low because I could not construct a divergent
answer. A LIST-valued property constructs one immediately** — the one thing `storedValueExpr`
exists for:

```
g.V().values("nums").max()          -> the list      (root)
g.V().map(__.values("nums").max())  -> NOTHING       (child — also local(), project())
```

A silent wrong answer, not a deferral. **The lesson for this doc: "I could not construct a
divergent answer" is not evidence of equivalence when the two implementations differ in a
TYPE-DEPENDENT expression** — it means the probe set was drawn from the reference graphs, which
have no collection-valued property. Reach for the shape the divergent expression is *about*.

**What landed — and the split it was missing is that only the TAIL is special.** A scoped reducer
is per-ORIGIN in a child scope and global in the engine loop; that asymmetry is the entire reason
this code existed. Everything BEFORE the tail is ordinary. So the element prefix and its scalar
projection now lower through `lowerStepsStrict` — the same call the shared branch above it makes —
and only the reducer tail is continued by hand. The builder and the divergence go together.

**One capability was genuinely welded inside it**, which is the same tell as #6: `constant()` in a
child scope. The generic route rejected it for a real reason (a literal has no emission order for
the partitioned cardinality policy to rank on), so the fix is to SUPPLY the order, not to keep a
second projector — the tail entry mints the per-origin encounter on the element stream first
(`mintChildEncounter`), which is exactly what the retired builder did inline. `lowerConstant`'s
guard now states the precondition it really has rather than deferring the whole shape.

**Then `BESPOKE_PROJECTIONS` went entirely — and the ceiling rose, because the gate was guarding a
mis-stated requirement.** It survived one round as `SELF_ORDERING_PROJECTIONS` ("the projections
that carry a per-origin EMISSION ORDER, so a scoped reducer has something to partition on"), which
is what `lowerScopedScalarReducer`'s own error message said. It reads the encounter in exactly ONE
place — `COUNT(<marker>)`, to tell a real child row from the domain LEFT JOIN's null padding — and
never as an order, because every aggregate under it is order-insensitive. The child row's own
ORDINAL answers that question on every child stream by construction. So the projection's identity
was never the axis: `map(__.format("%{name}").count())` and every other generalized producer
(`call`/`math`/`sack`/`format`) now compose with a scoped reducer, and the classifier gate is gone
rather than widened.

**The tell, worth keeping:** the deferral message named the wrong requirement, and the classifier
had been written to satisfy the message. Read what the consumer USES, not what it says it needs —
one grep at the single read site settled a gate that had shaped a vocabulary.

---

### 8. `services/catalog/search.ts` — ✅ **CLOSED 2026-07-30.** One payload, two provisionings
`services/catalog/search.ts` (`searchProperties`) vs `tail/group.ts` (`lowerProperties`)

Built the vertex/edge property payload join by hand and its own comment admitted it: *"mirroring
`lowerProperties`"*. Zero deferrals, pure duplication — and the two had already **drifted**: search
joined `labels` for an edge's `ownerLabel` where `lowerProperties` correlates, so the "mirror" was
not one.

**What landed.** `propertyPayload(elem, pr, n)` is the projection, and the split it makes explicit
is the one that was missing: the two callers **provision the ROWS** differently (a traverser vs an
FTS hit) and **share the payload**. It is DERIVED from `PROPERTY_PAYLOAD` — a `Record` keyed by
that list — rather than transcribing it, so adding a payload column is a compile error at the one
site instead of a silently-short SELECT at the other. The vertex/edge difference it encodes is
exactly TinkerPop's VertexProperty-vs-Property split (a VertexProperty is an element and carries
meta-properties; an edge Property is neither → `vpid`/`pmeta` NULL).

Two things fell out. `lowerProperties` lost its own vertex/edge branch — given `propRel` /
`propOwnerCol` (the aliased-and-joined form of #9's property source, which this reused rather than
re-derived) the two bodies were the same statement. And search's edge scope now reads its owner
label through the same correlated subquery as everything else, which is the drift closing.
`properties()` SQL is byte-identical. CI 1083/0, L3 1623.

The contrast is instructive and belongs in the same entry: `services/catalog/degree-centrality.ts`
does the opposite — it calls `scopedMovementCount` and therefore gets
`where(call("tinker.degree.centrality").is(n))` at arbitrary depth **for free**. Two services, two
philosophies; the second one is the model.

---

### 9. Leaf-level, cosmetic — ✅ **BOTH CLOSED 2026-07-30**
- ✅ **The `properties()` inner-group expansion — CLOSED, and "cosmetic" undersold it.** It
  hand-joined `vertex_properties` off the pushed domain and hand-built a property `ScalarCtx` that
  was `propertyCtx` with the payload column names substituted; it now runs `lowerProperties` over
  the pushed seed and rejoins on the ordinal, which is its sibling branch's shape exactly.
  **The hand-join was also the reason the branch was VERTEX-only** — an edge rowid read against
  `vertex_properties` is a silent wrong answer, so `parent.elem !== 'edge'` was the only thing
  making it safe. Running the real step removes the reason for the guard, so the guard went too.
  One more latent vertex-assumption fell out: `propertyCtx` re-derived the OWNER's label as a
  vertex lookup, which is wrong for an edge-owned property and is reachable today through
  `g.E().properties().group()`. It now reads the `ownerLabel` the payload already carries (#8's
  work), and takes an `ownerElem` for the two positions a name cannot serve.
- ✅ **`plan/plan.ts` `nodeProp*`/`edgeProp*` pairs — CLOSED 2026-07-30, and it was bigger than
  "cosmetic".** The eight builders were four pairs, each the other with two nouns changed; the real
  cost was OUTSIDE the file, where eight call sites re-spelled the `elem === 'edge' ? … : …`
  dispatch by hand. `propSource(elem)` states the three actual disagreements once (table, owner
  column, whether a key may hold several values), `propRead` is the one correlated subquery over
  it, and the four public readers (`propScalarFor`/`propTypeFor`/`propSortKeyFor`/`propHasFor`) are
  TOTAL over `Elem` — so a caller passes the elem it already had instead of branching. That is
  `elemTable`'s twin on the property side, and the shape this entry predicted.
  `storedPropFor` fell out and was not predicted: the value, its stored vtype and their
  `storedValueExpr` composition always travel together, and four record-field builders in
  `select.ts` were each spelling the trio out — two of them as a vertex branch and an edge branch
  differing only in the dispatch plus a redundant element-table JOIN. Now one branch.
  **Emitted SQL is byte-identical** (the subqueries still name their own columns unqualified, via
  the relation's declared column list, so a schema rename stays a compile error) — which is the
  right bar for a pure dedup and is what the census exists to check. CI 1083/0, L3 1623.

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
