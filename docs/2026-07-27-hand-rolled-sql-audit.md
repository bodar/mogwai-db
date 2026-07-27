# Hand-rolled SQL audit — where a second implementation replaced the substrate

_Swept 2026-07-27 against the working tree. Every count below is **measured**, not estimated: the
method is at the bottom. Ranked by (duplication × family unblock × reach at depth), which is not
the same as ranking by lines._

> The kernel is not the problem. Every site here already builds through `q`/`Relation` — locked
> decision "only `kernel/q.ts` touches lazyrecords" holds. What this audit hunts is the **second
> implementation of traversal semantics**: SQL assembled by a private step-vocabulary instead of by
> `lowerSteps`/`lowerElementSteps`. That is the rule in `src/compiler/steps/CLAUDE.md` ("Never build
> a second implementation"), and it is the thing that costs whole families rather than one scenario.

## The one structural finding

Three of the top five sites are the same missing primitive wearing different clothes. The compiler
has **two** rendering modes and needs a third:

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

### 1. `expandRepeatBody` + the `repeat` StepFn — the recursive term's private mini-compiler
`steps/prefix/branch.ts:505-801` (~300 lines: `moveDirs`, `dirCombos`, `expandRepeatBody`, `repeat`)

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

**It also owns the only place #6 has no fallback.** `walkPredicate` (`branch.ts:37`) routes
`until()`/`emit()` through the inline predicate compiler and **throws** when it declines — unlike
every other consumer, which falls through to the generic child-existence gate. So the inline
compiler's vocabulary is the hard ceiling here and nowhere else:
`until(__.union(__.out(),__.in()))` and `emit(__.out().fold().count(local).is(1))` both fail.

**Not fail-closed:** the named-loop form crashes rather than deferring —
`g.V().emit().repeat("a", __.out("knows").filter(__.loops("a").is(0)))` →
`undefined is not an object (evaluating 'node.constructor')`. 4–5 corpus cases. Worth a cheap
guard independent of the rest.

Subsumes outstanding-work **item 3** (alias columns through `repeat()`) and most of P3's
recursive-path tails.

---

### 2. `seedUnion` — a strictly weaker copy of a family that is already generic
`engine/engine.ts:224-244` (26 lines)

Best duplication-removed-per-line in the audit, and already correctly scoped as outstanding-work
**item 4b**. This sweep confirms that item's spike rather than adding to it. Side by side, same arms,
two implementations:

| | mid-traversal | source |
|---|---|---|
| scalar arm | `g.V().union(__.values("name"), __.constant("x"))` ✅ | `g.union(__.V().values("name"))` ❌ |
| list arm | `g.V().union(__.out().fold(), __.in().fold())` ✅ | `g.union(__.V().out().fold())` ❌ |
| alias | `g.V().as("a").union(__.out(),__.in()).select("a")` ✅ | `g.union(__.V().as("a").out()).select("a")` ❌ |
| path | `g.V().union(__.out(),__.in()).path()` ✅ | `g.union(__.V().out(),__.V().in()).path()` ❌ |

**Measured:** 2 / 15 `g.union(…)`-rooted corpus traversals compile.

The merges (`finishElementMerge`, `unionScalarStreams`, `finishListMerge`, `mergeVariantArms`) are
already parent-agnostic and directly reusable; only the *triage* doesn't transfer, because a source
arm is a rooted traversal, not a child body. Dispatch on the lowered Stream's `kind` instead. Closes
item 4's residual as a side effect.

---

### 3. `match.ts` — the binding table, and a pattern vocabulary narrower than the seam it calls
`steps/prefix/match.ts` (118 lines)

Half-reformed already: `applyPattern:59` genuinely folds the pattern body through
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

Fix shape is the same move as #2: lower each pattern through the **full** loop (`lowerSteps`) and
bind whatever kind it lands on, rather than requiring element. Doing #2 and #3 together is cheaper
than either alone.

---

### 4. `path.ts` — two positional projectors, one of them stuck at `by(key)`
`steps/tail/path.ts:233-285` (`compilePathArray`, ~61 lines) vs `lowerPathPositionChild:87`

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

**Measured:** 9 / 42 `path().by(…)` corpus traversals fail; 14 attribute to path.ts overall. Needs a
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

### 6. `predicate.ts` — the biggest pure vocabulary duplication, and (almost) the cheapest to ignore
`steps/prefix/predicate.ts:60-305` (~262 lines)

`compileInlinePredicate` is a parallel implementation of `has`/`hasLabel`/`hasId`/`values`/`label`/
`loops`/`not`/`and`/`or`/`count`/`sum` plus infix connector precedence. On duplication alone it
ranks second. On measured functionality it ranks near-last, and this corrected my initial read:
**every shape I probed falls through cleanly to the generic child-existence gate.**

```
OK  g.V().where(__.out().out())                    OK  g.V().where(__.union(__.out(),__.in()))
OK  g.V().where(__.out().dedup().count().is(gt(1)))  OK  g.V().where(__.out().order().by("name").limit(1))
OK  g.V().where(__.out().fold().count(local).is(1))
```

So it is a **fast path doing its job** — the movement branch already delegates to
`compileCorrelatedChild`, so movement is genuinely not duplicated; what is duplicated is the leaf
predicate vocabulary. **Delete it when #1 lands, not before**: its only load-bearing use is
`until()`/`emit()`, which has no fallback (see #1).

One genuine leak: `tryInlinePredicate:139` only swallows messages that *start with* `where`/`filter`,
so `empty where()/filter() traversal` escapes as a hard error — `g.V().filter(__.is(0))` and
`g.E().filter(__.is(0))` crash instead of routing generically. Two corpus lines, a one-line fix.

---

### 7. `child.ts` — the third scalar-child projector residue
`steps/tail/child.ts:498-540` (~60 lines), reached from `compileScalarChildRows:334`

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
registry; failures bucketed by message and attributed to a site. 1,620 compile / 678 fail.
Composability claims are direct `compile()` probes of matched pairs (same body, different position),
not inference. The SQLite `LATERAL` and body-relation results are `bun:sqlite` runs, quoted verbatim
above. Scripts were scratch; the probe is ~40 lines and worth re-running after any of these land.

**Two caveats on the numbers.** (1) Compiling is an upper bound on passing — corpus-compile 1,620 vs
L3 1,430. (2) A traversal fails at its *first* wall, so a site's count is a lower bound on what it
gates; the 41 `mergeV(xx1)` lines are the one known artifact and are excluded from #5's figure.
