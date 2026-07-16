# `as()` labels as per-traverser path history — full Pop across all shapes

**Date:** 2026-07-16
**Status:** LANDED (core + follow-ups #1/#2/#4); #3 and #5 remain.
**Baseline:** started full 373/373, compiler 248/248, L3 933. Core landed at full
377/377, compiler 251/251, **L3 952** (+19). Follow-ups #1/#2/#4 (commits 378bcd2,
4f8e808, 7003da2) then took it to full 382/382, compiler 256/256, **L3 955** (+3),
corpus 2298/2298.

## Landed (commits f4d4661, 93435b6)

- **Encoding flip** (`src/steps/alias.ts`): every as() label is a JSONB history array
  of tagged entries `{k,v[,t]}`, appended per bind. All element-alias consumers
  (select re-root, where/and/or alias-compare, math vars, match binds+joins, addE
  endpoints, write chain) read the last entry's id. Behaviour-identical flip.
- **`AliasEntry`** widened to `{col, shapes, as?, binds?}` — shape set + value type +
  compile-time binding count (for static Pop resolution on linear chains).
- **as() on value streams** (`labelselect.ts asOnStream`): scalar/list/variant labels,
  shape-agnostic rebuild via `streamColumns`. Dispatched once in `lowerStream`
  (`dispatchAlias`); per-shape row-consumers yield to it (no special cases).
- **select(Pop.first/last/all/mixed, labels…)**: single-label (`selectOneFromAlias`)
  → scalar / re-rooted element / List; multi-label (`selectRecordFromAlias`) →
  heterogeneous Map. Element-tail select (`lowerSingleSelect`/`lowerRecordSelectProject`)
  delegates non-last Pop to the same resolvers. The 3 `Pop!=='last'` guards deleted.
- **Unbound label → drop** (empty result), never error (`emptyElementLike`).

## Follow-ups

1. **Branch fork/merge of DIVERGENT arm labels** — ✅ DONE (378bcd2). `mergeBranchCarried`
   now unions the label set across arms (`mergeAliasMaps`): a pre-branch label keeps its
   seed column; a label first bound inside an arm gets a fresh canonical column;
   `armProjection` remaps each arm's independently-minted physical column onto the
   canonical one and pads a label an arm never bound with a NULL history. `binds` becomes
   `undefined` (dynamic) when a label is bound in only some arms or with a differing count.
   Element-tail `select()` of a dynamic-binds label guards on `aliasPresent` (drop, not a
   phantom NULL-id row). Rigid cols (origin/sack/fromV/encounter) still must agree. The
   runtime Pop.mixed CASE was already present in `aliasPop`; static Pop.mixed over a
   dynamic-binds label still throws the existing clear error (result-shape unknowable at
   compile time — a genuine separate variant piece, unreached by conformance).
2. **order().by(select("x"))** — ✅ DONE (4f8e808) for the reachable form: `order()` on a
   RecordStream by `by(__.select(field))` (`compileFromRecord` → `recordOrderTerms`), value
   field → its scalar col, element field → external id, following limit/skip/range fused
   into the sort. The element/scalar-stream `order().by(__.select("x"))` forms (only the
   `sum(Scope.local)` scenario, blocked by #5) stay deferred in `modulation.ts`/`scalar.ts`.
3. **as() on map/group/path/property streams** — ⏸ DEFERRED (large, separate shape; 0
   measurable L3 yield alone). `currentEntry` covers scalar/list/variant. A group/map/path
   label must COLLAPSE its multi-row physical shape to ONE tagged JSON entry (`k=4` map),
   which is a barrier (N group-key rows → 1 map traverser) PLUS a new first-class
   **map-valued carried entry** that `select()` can re-materialize back into a
   Group/Map/Path stream. That re-materialization is the "later shapes" work this doc's
   model table already flags. No standalone conformance scenario is unblocked by it alone:
   every group/path-`as` scenario in the suite is also gated on a separately-deferred
   feature (`label().groupCount()` = groupCount-on-scalar, `path().as().union(...)` =
   path-through-union, `elementMap(...).as()` = elementMap-as-a-non-terminal-stream, or a
   `map(__.…groupCount())` map-nested-group). So it is pure substrate with regression risk
   on the central group/path barriers and no test-visible payoff — do it as its own scoped
   shape project (map-value stream + collapse + re-materialize), not a rushed commit.
4. **where() scalar alias-compare edge cases** — ✅ DONE (7003da2). `where(P.not(<inner>))`
   over labels unwraps + flips negation (current-vs-label and label-vs-label, with/without
   by(key)). `where()` on a RecordStream (`recordWhere`) compares two carried alias labels
   (the record still carries the alias history columns) — element identity or by(key);
   traversal-predicate / whole-map single-predicate forms defer. Unlocked the canonical
   `select("a","b").where("a",P.eq/neq("b"))` Where.feature scenarios.
5. **Pre-existing (now reachable) carried-column drop** in the `sum(Scope.local)`/
   map-local scalar path: a scalar produced there drops carried alias columns, so
   `as("v")…map(...).sum(local).as("s")` trips `assertStreamColumns` (fails closed,
   not corruption). Fix the handler to thread `carriedCols`. (Still open; would unblock
   the `order().by(__.select("s"))` Order.feature scenario together with the element-stream
   half of #2.)

## What and why

`as(label…)` today is an element-only `PREFIX` `StepFn` (`src/steps/filter.ts`)
that stores **one carried column per label** (`a0`,`a1`,…) holding the current
vertex/edge **rowid**, overwriting on rebind. That is exactly `Pop.last` of an
element — so bare `select("a")` (default `Pop.last`) and single-binding element
selects already work, but everything else throws:

- `as()` on a **non-element stream** (`values().as("a")`, `count().as("a")`,
  `fold().as("a")`, `group().as("a")`, `path().as("a")`) → `step not implemented: as()`.
- `select(Pop.first|all|mixed, …)` → uniformly rejected (three copy-pasted
  `pop !== 'last'` guards in `src/steps/select.ts`).
- rebind history (`…as("a")…as("a")…`, `repeat(out().as("a"))`,
  `V().as("a").out().as("a")`) → only the last binding survives.
- `select("a","b")` mixing a scalar label and an element label → the record
  field vocabulary has no cross-shape story.
- `where("a", P.eq("b"))` / `order().by(select("a"))` on non-element labels — no
  alias branch exists at all in the order modulator; where alias-compare is
  element-id only.

**TinkerPop semantics (the spec we match), from `Path.get(Pop,label)`:**
a traverser's path is two synchronized ordered lists `(objects, labelSets)`;
`as()` attaches its label(s) to the **preceding step's current object** and
**appends** a history entry (never overwrites). `select`:

| form | result when label bound N× on this traverser |
|------|----------------------------------------------|
| bare `select("a")` (= `Pop.last`) | the last object (unwrapped) |
| `Pop.first` | first object; N==1 → that object |
| `Pop.last`  | last object;  N==1 → that object |
| `Pop.all`   | **always a List** (singleton List when N==1) |
| `Pop.mixed` | N==1 → the object; N>1 → a List (binding order) |
| unbound label | **drop the traverser** (NOT throw); whole-traversal select of an unseen label ⇒ empty result |
| `select("a","b",…)` | a `Map<String,Object>`, each value resolved by the Pop rule independently; duplicate keys collapse |

`by()` modulators cycle round-robin one-per-key in select-key order (fewer
`by()`s than keys ⇒ reuse earlier ones), and run on the **already-Pop-resolved**
value (so `by(unfold().values("name").fold())` sees a List start for a multi-bind
`Pop.all`). Label resolution is **path-first, then the named side-effect
registry** (`aggregate`/`group('x')` fallback — already partly present).

A label's history can be **heterogeneous in shape** across bindings
(`V().as("a").values("name").as("a")` → `[vertex, string]`), so the model must
carry a tagged value per entry, not a single compile-time element kind.

## The model — one JSONB history column per label

`AliasMap` entry changes from `{col, elem}` to:

```ts
type AliasEntry = { col: string; shapes: ReadonlySet<AliasShape> };
type AliasShape = 'node' | 'edge' | 'value' | 'list' | 'map';
```

The carried column `aN` holds a **JSONB array of tagged entries in binding
order** (array-ALWAYS, even for a single binding — uniform Pop reads, uniform
fork/merge, forward nothing-special):

| shape | entry encoding | notes |
|-------|----------------|-------|
| node  | `{"k":0,"v":<rowid>}` | framed to a vertex at materialization by rowid |
| edge  | `{"k":1,"v":<rowid>}` | framed to an edge |
| value | `{"k":2,"v":<scalar>,"t":<vt?>}` | `t` = the `ValueType` tag for numeric subtype / date; absent = plain |
| list  | `{"k":3,"v":<jsonb array>}` | a labeled fold()/collection |
| map   | `{"k":4,"v":<jsonb obj>}` | labeled group()/groupCount()/elementMap (later shapes) |

`shapes` accumulates the set of binding shapes seen at compile time:
homogeneous single-element-kind → keep the fast concrete framing; heterogeneous
or list/map → resolve through the existing **variant / heterogeneous-list**
materializer (runtime tag dispatch — `materializeVariantRoot`/`listResult`
already frame by tag).

### `as()` — shape-aware, appends to history

`as()` becomes dispatchable on every stream shape (not just `ElementStream`).
Per current shape it appends the tagged current object to each named label's
array:

```
aN' = CASE WHEN aN IS NULL THEN jsonb_array(<entry>) ELSE jsonb_insert(aN, '$[#]', <entry>) END
```

- element stream → entry `{"k":0|1,"v":id}` (shape node/edge).
- scalar stream → `{"k":2,"v":<v>,"t":<vt of s.as>}`.
- list stream → `{"k":3,"v":json(list)}`.
- group/map/path → `{"k":4,…}` (map) as those shapes come online.

Because `as()` no longer only produces an `ElementStream`, it moves out of the
element-only `PREFIX` `StepFn` map into a shape-agnostic handler invoked from
each arm of `lowerStream` (or a single shared helper keyed on the stream kind).
It **does not retype** the stream — it labels and passes the SAME shape through
(a pass-through CTE that adds/updates the `aN` column), so a chain continues.

### Pop reads (`select`)

`aliasPop(col, pop)` yields either one entry expression or the whole array:

- `first` → `col -> '$[0]'`
- `last`  → `col -> ('$[' || (json_array_length(col)-1) || ']')`
- `all`   → the array (materialized as a List)
- `mixed` → `CASE WHEN json_array_length(col)=1 THEN col->'$[0]' ELSE col END`

then the entry(ies) frame by tag `k`. Element re-rooting
(`select("a").out()`) extracts `CAST(entry->>'$.v' AS INTEGER)` as the rowid and
picks the table from the entry's `k` (compile-time when `shapes` is a single
element kind; otherwise a variant). `Pop.all` of elements resolves to a List and
only re-enters movement via `unfold()`.

**Drop-not-throw:** an unbound label (`aN` absent / `NULL` / empty array on a
given row) filters that traverser (`WHERE aN IS NOT NULL AND json_array_length>0`),
matching the empty-result scenarios; a label NEVER `as()`-anywhere but present in
the side-effect registry resolves against that instead (existing fallback).

### where / order alias-compare

`aliasIdExpr` / `aliasResolver` / `elementOrderSql` resolve a label through
`aliasPop(col,'last')` (the default) to an id or scalar, replacing today's raw
`p.aN`. `order().by(select("a"))` gains the missing alias branch in
`modulation.ts`.

### Fork / merge (union / optional / coalesce / choose) — full semantics

History is just a carried JSONB column, so it rides UNION-ALL arms per row. Two
changes to `branch.ts`:

1. **Merge the alias SETS across arms** (was: assert arms carry an identical
   column set). An arm that binds a label the others don't → the others emit an
   empty/`NULL` history for that column (`armProjection` pads it, exactly as it
   already pads ragged path positions). This deletes the
   `branch arms disagree on carried columns` guard for aliases specifically.
2. Each arm appends its own entries onto the shared pre-branch prefix, so
   divergent per-arm history is preserved by the merge with no extra machinery.

`match()` binds are the same `AliasMap` entries; its internal `a{n}` columns must
move to the history encoding in lockstep (or bind through the shared helper).

### Barrier boundaries

`withoutCarried` currently wipes aliases at every true barrier
(count/fold/reducer/group/path/scalar-retype). A label bound BEFORE a barrier is
part of the traverser's path and, per spec, survives the barrier only where the
barrier preserves a single owning traverser. For global barriers (global
count/sum/group with no by-origin) there is no single owning row → dropping is
correct. For per-origin / row-preserving retypes (scalar transform chains,
fold→list, unfold) the alias history MUST thread through. Audit each
`withoutCarried` site: keep the wipe only at genuine global collapses; thread
`carried` (minus nothing) at row-preserving retypes.

## Change map (files)

1. `src/steps/context.ts` — `AliasMap`/`AliasEntry` (`shapes` set), keep
   `aliasColsOf`/`carriedCols`/`carryFrag` (unchanged: still one col per label).
   New `src/steps/alias.ts` for the encoding helpers (`aliasAppendSql`,
   `aliasPopSql`, `aliasLastIdSql`, `aliasEntryShapeMaterialize`).
2. `src/steps/filter.ts` — `as` becomes shape-aware (append semantics);
   `aliasIdExpr`/`aliasResolver` resolve through `aliasPopSql(...,'last')`.
3. `src/steps/index.ts` — route `as` on every `lowerStream` arm (shared helper),
   not only the element `PREFIX`.
4. `src/steps/select.ts` — delete the three `pop!=='last'` guards; implement
   `aliasPop` in `lowerSingleSelect` / record building / `compileFromRecord`;
   mixed record fields (a field may be value/element/list/variant by the label's
   `shapes`); drop-not-throw.
5. `src/steps/branch.ts` — alias-set merge + ragged pad; drop the disagree guard
   for aliases.
6. `src/steps/match.ts` — history encoding for pattern binds.
7. `src/steps/modulation.ts` — `order().by(select/alias)` branch.
8. `src/plan.ts` — `aliasCtx` reads a resolved entry (id/props by tag).
9. `src/steps/materialize.ts` / `src/render.ts` — record field of variant/list
   shape; a Pop.all/mixed List of heterogeneous entries frames via the variant
   list path.
10. barrier sites (`barrier.ts`, `group.ts`, `select.ts` path) — thread vs wipe
    audit.

## Test strategy

- Compiler SQL snapshots per shape (`as()` on scalar/list/element/group/path),
  per Pop (first/last/all/mixed × N=1 and N>1), mixed record, alias-compare,
  order-by-alias, drop-not-throw, fork/merge history through each branch step.
- Full `bun test` + corpus 2298 + L3 ratchet green before each incremental
  commit. Widen `test/conformance/tags.ts` is not needed (Select/Where/Order
  already in scope); the ratchet auto-bumps.

## Non-negotiable invariants (carry from CLAUDE.md)

Productive SQL NULL is a traverser. `carriedCols` order (path last) is
load-bearing. No JS traversal interpretation — all Pop reads are SQL over the
JSONB history column. Fail closed, never under-answer.
