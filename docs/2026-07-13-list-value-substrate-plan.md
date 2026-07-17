# List-as-first-class-value + re-enterable tail — implementation plan

**Date:** 2026-07-13
**Status:** PARTIALLY IMPLEMENTED (Approach A). Core substrate + Scope.local reducers
landed; L3 608→617. See "Implementation status" below and the CLAUDE.md section
"List-value substrate + re-enterable tail". Remaining: inject-as-list, the rest of
Scope.local, select(Column.values), set-ops.
**Branch/worktree:** `worktree-with-strategies` (this is a git worktree — run everything here).

## Implementation status (2026-07-13)

LANDED (Approach A, each commit green, name-diff-verified zero regressions):
- **Commit 0** — frontend: collection literals parse as one array value; `Scope` captured;
  V/E/hasId/inject flatten a list arg via `flattenListArgs`; predicates unwrap. Neutral (608).
- **Commit 1** — scaffolding: `Carry` base + `St` tagged `kind:'elements'`; `stream.ts`
  (`Stream` union); `jsonbGroupArray`/`jsonbArrayOf` in plan.ts. Neutral (608).
- **Commit 3** (dispatcher merged in) — `dispatchNext` re-enterable tail; `compileFold`
  (non-terminal fold → JSONB `ListStream`); `compileUnfold` (json_each explode); terminal
  fold unchanged; `compileFromScalar` factored out. L3 608→609 (`g_V_fold_unfold`).
- **Scope.local reducers** — `count/sum/min/max/mean(Scope.local)` reduce each folded list
  (`compileFromList` `listReducer`). L3 609→617 (fold-sourced reducer cluster).

The plan's separate "commit 2 (inert dispatcher)" was MERGED into commit 3 — an inert
behavior-neutral refactor hides bugs (nothing exercises it); building it with fold/unfold
means real scenarios test it. Approach A's file decomposition (scalar.ts/group.ts/path.ts
splits) was intentionally NOT done — the plan marks it optional; only `stream.ts`/`list.ts`
were added, keeping churn/risk down. `St.elem` stays `'node'|'edge'` as mandated.

NOT YET DONE (each larger than the plan framed — verify semantics per-scenario like commit 0):
- **inject-as-list** (was "commit 4"): `inject([...])` is a stream of MULTIPLE list values
  (`inject([1,2],[3,4])` = two lists), needs mixed-type spreading (`inject([a,b],'c')`) and a
  `none()` collection filter. `ListStream` already supports N rows, so unfold works; the
  producer + terminal JSONB-list framing + none() are the work. inject still FLATTENS a lone
  list (commit-0 temporary) until this lands.
- **rest of Scope.local**: `order/limit/range/tail/dedup(Scope.local)` — their scenarios chain
  `reverse()`/`skip(Scope.local)`; element-list `order(local).by(key)` needs a rejoin.
- **select(Column.values/keys)** + the group-values cluster (`group().by().by(__.…fold())
  .select(Column.values).unfold().order(local)`) — re-plumbs group's Map into a list stream.
- **the global-MODIFIERS fail-loud Scope guard** (A.6): NOT added — it regresses the
  inject-list scenarios still passing by flatten-coincidence. Add it WITH inject-as-list.
- set-ops (`combine`/`intersect`/…), Map-unfold, `local()` — Tier 2, unchanged.

## Why this is the next thing (the compounding thesis)

Both `docs/2026-07-13-seam-reuse-audit.md` and `docs/2026-07-12-conformance-structural-bets.md`
keep bumping the SAME wall from different sides: `unfold`, `Scope.local`, chained
projections (`"only one projection step"`), set-ops, `local()` are all blocked because
**a projection/fold produces a value the chain cannot continue from.** The engine today
has two traverser representations — an **id-relation** (elements, the prefix fold `St`)
and a **scalar-`v` stream** (the tail) — and **no first-class list value**, and **no way
to retype a traverser mid-chain and keep going** (the tail is strictly terminal).

This plan builds the missing substrate: **a list as a first-class traverser value** +
**a re-enterable tail**. It's a dependency, not a leaf — once it exists, `unfold`,
`Scope.local`, set-ops, Map-unfold, and `local()` stop being separate hard problems and
become consumers of one thing. This is the deliberate "big bold change."

## What real clients actually need (corpus evidence — do not re-derive)

Of ~110 scored `unfold` scenarios (grep `vendor/tinkerpop/.../features` for `unfold`),
bucketed by what PRODUCES the collection `unfold` consumes:

**In scope (Tier 1 — real, no deferred dependencies):**
- **`fold()` as a real list value** — canonical producer. Unlocks (beyond unfold):
  the **collection set-op family** `combine`/`product`/`intersect`/`difference`/
  `disjunct`/`conjoin`/`merge` (~20 scenarios, all *defined* on list values, e.g.
  `V().values('name').fold().combine(__.V()...fold()).unfold()`); **`Scope.local` on any
  folded stream**; **fold-as-aliased-value reuse** (`...fold().as('m').mergeV(select('m').
  limit(Scope.local,1).unfold())...`, ~6); **fold inside `local()`**.
- **inject-list** — `inject([1,2,3,4]).unfold().asNumber()`, `inject([1b,1s,1i,…]).unfold().
  where(__.is(xx1))` (the numeric type-matrix, ~8), `inject([1,2,3]).limit/tail(Scope.local,n).
  unfold()`.
- **group-values** — `group[Count]().select(Column.values|keys).unfold()[.order(Scope.local)]`,
  `outE().weight.groupCount().select(Column.values|keys).unfold()` — the biggest coherent
  cluster (~15+).
- **`g.V().fold().unfold()`** — exactly ONE scenario, a no-op identity. Works for free once
  fold is a real value (materialize → `json_each` roundtrip; correct if wasteful — don't optimize it). Not a driver.

**Deferred (need OTHER substrates — explicit non-goals this pass):**
- `aggregate('a')…cap('a').unfold()` (~25) — side-effect state (named collections). Separate substrate.
- `local(…).unfold()`, `repeat(aggregate).cap.unfold` (~10) — `local()` / Scope. Reuses this substrate later.
- `valueMap()/elementMap()` Map-unfold → Map.Entry stream (~10) — a Map container (distinct wire shape). Tier 2.
- set-ops themselves (`combine`/`product`/…) — Tier 2, but this plan makes fold-as-value so they're a small add.
- `path().by(k).unfold()` — path-family extension.
- `values('list').is(typeOf(GType.LIST)).unfold()` — multi-cardinality LIST property (W4 multi-props).

## Established facts (from this session's exploration — trust these, cite file:line)

1. **`fold()` emits NO SQL today** — `wrapReducer` (`src/steps/projection.ts:600-622`) keeps the
   projection's N rows and only retags `Shape` → `{kind:'list', elem}`. The handler
   (`src/handler.ts:269-274`, `case 'list'`) collapses N rows → one GraphBinary List. So a
   "list" today = N rows + a tag; works ONLY because `fold()` is terminal.
2. **`compileTail` is strictly terminal** (`src/steps/projection.ts:126-167`) — always
   `readCompiled` (one SQL statement). No path from tail output back into `foldBody`/PREFIX.
   This is THE ceiling this plan lifts.
3. **`foldTailAcc`** (`projection.ts:104-122`) enforces "one projection, then modifiers, then one
   terminal reducer" (`reducerMod`'s `at.last` guard, `projection.ts:89-98`); throws
   `step not implemented: X()` on anything unknown (`:118`). The single-projection guard is `:108-112`.
4. **`compileInject`** (`projection.ts:500-593`) is the existing "value→stream" template: seed a
   `(v)` relation from `VALUES` → run the SAME `foldTailAcc`+`renderProjection` the element tail
   uses. A scalar stream is already a first-class (if unnamed) shape here.
5. **`foldBody(steps, seedSt, from)`** (`src/steps/index.ts:105-116`) is the existing
   "re-seed from an arbitrary relation and keep folding PREFIX" primitive — used by `seedUnion`
   and every branch body (`branchArm`, `src/steps/branch.ts:55-66`). This is the element-re-entry
   mechanism; it just has never been driven from the tail side.
6. **`renderProjection`** (`projection.ts:267-342`) is the shared scalar/element tail renderer
   (its own docstring invites reuse) — the scalar-re-entry mechanism.
7. **JSONB is available on both runtimes** (DO SQLite 3.47.0, Bun 3.53.0; JSONB ≥ 3.45.0).
   Project policy: NEW json columns use JSONB. `json_each` reads TEXT-json AND JSONB blobs
   transparently. Existing precedent: recursive-repeat path uses `jsonb_insert`/`jsonb_array`
   and `compilePathArray` (`projection.ts:781-804`) explodes a JSONB id-array via
   `json_each` + rejoin to `nodes` — **the exact idiom unfold-of-element-lists needs.**
   Use `jsonb(json_group_array(expr))` as the safe universal aggregate form (native
   `jsonb_group_array` unverified on 3.47 — PROBE before relying on it; see risks).
8. **Two FRONTEND correctness bugs block this AND are independently real** (fix first):
   - **`Scope` is not parsed.** No `TraversalScopeContext` case in `src/frontend.ts` `walkArgs`
     (grammar class confirmed `parser/GremlinParser.ts`, single `TraversalScopeContext`).
     `order(Scope.local)` today silently drops the scope and parses as global `order()` — a
     latent wrong-result bug.
   - **Bracketed list literals not parsed as one value.** `GenericCollectionLiteralContext`
     (present in the generated parser) falls through generic recursion, so `g.inject([1,2,3])`
     silently flattens to `inject(1,2,3)` (3 traversers) instead of one List traverser.
9. **Sqlg is a COUNTEREXAMPLE, not prior art:** it punts `unfold`/`fold`/`local` to the JVM
   interpreter (fold → `java.util.ArrayList`, never a SQL array/`json_agg`); its compile-to-SQL
   whitelist stops at movement/filter/aggregates. So there is NO prior art for compiling this
   family to SQL — mogwai leads (as with coalesce/map/math). Reaffirms locked decision #3.
10. **`select(Column.values/keys)`** is parsed (`frontend.ts:170` → `{column}`) but rejected
    (`projection.ts:654`). `compileSelectProject`'s multi-key branch (`projection.ts:688-708`)
    already has the per-key column-building logic `select(Column.values)` needs — extract it.

## Scope decision (locked this session)

**Tier 1**: list-as-value (fold + inject + select(Column.values) producers) + re-enterable tail
+ `unfold` (all Tier-1 forms + downstream continuation) + `Scope.local` reductions +
`select(Column.values/keys)`. Map-unfold, set-ops, `local()`, `aggregate/cap` are **deferred**
but this substrate makes set-ops a small Tier-2 add (fold yields a real list they operate on).

Delivery is **staged in commits, not staged in ambition** — the target is the full substrate;
each commit lands green with the L3 baseline ratcheting up.

---

# APPROACH A (PRIMARY) — explicit stream-kind union + central dispatcher

The bold, properly-decomposed version. Chosen deliberately: this is a foundational substrate
the whole list family sits on, so centralize the retype logic and lean into the file split.

## A.1 The stream model

Extract a `Carry` base from `St`; make `St` one arm of a `Stream` union.

```ts
// src/steps/context.ts — St keeps its exact runtime shape, now tagged + carved into Carry.
export interface Carry {
  readonly q: Query;
  readonly aliases: AliasMap;
  readonly indexKeys: ReadonlySet<string>;
  readonly params: Record<string, any>;
  readonly path?: PathState;
  readonly origin?: string;
}
export interface St extends Carry {
  readonly kind: 'elements';
  readonly last: Relation;   // the id-relation (unchanged)
  readonly elem: Elem;       // 'node' | 'edge' — MOVEMENT StepFns still only ever see this
}
```

```ts
// src/steps/stream.ts — NEW
export type ListOf =
  | { kind: 'elem'; elem: Elem }          // list holds bare rowids → rejoin on unfold
  | { kind: 'scalar'; as?: ValueType };   // list holds scalars (typed via ValueType)
  // { kind: 'entry' } reserved for Map-unfold (Tier 2)

export interface ScalarStream extends Carry { readonly kind: 'scalar'; readonly rel: Relation; readonly as?: ValueType; } // rel: one col `v`
export interface ListStream   extends Carry { readonly kind: 'list';   readonly rel: Relation; readonly of: ListOf; }      // rel: one col `list` (JSONB), + carried cols

export type Stream = St | ScalarStream | ListStream;

export const carryOf = (s: Stream): Carry => ({ q: s.q, aliases: s.aliases, indexKeys: s.indexKeys, params: s.params, path: s.path, origin: s.origin });
export const toScalarStream = (c: Carry, rel: Relation, as?: ValueType): ScalarStream => ({ ...c, kind: 'scalar', rel, as });
export const toListStream   = (c: Carry, rel: Relation, of: ListOf): ListStream => ({ ...c, kind: 'list', rel, of });
```

Key insight: `ListOf` IS a one-field description of the `Stream` kind `unfold` produces
(`elem` → a fresh `St`; `scalar` → a `ScalarStream`). Unfold has no per-case logic — it's
driven purely by `ListOf`.

**CRITICAL — `St.elem` stays `'node'|'edge'` only.** Do NOT widen it to include scalar/list.
The 20+ movement/filter/branch `StepFn`s must remain elements-only; they are only ever reached
from the elements phase. The union lives at the ORCHESTRATION layer, never inside a `StepFn`.

## A.2 The dispatcher (re-enterable pipeline)

```ts
// src/steps/dispatch.ts (or index.ts) — the orchestration layer
export function dispatchNext(s: Stream, steps: PStep[], at: number): Compiled {
  return s.kind === 'elements' ? compileFromElements(s, steps, at)
       : s.kind === 'scalar'   ? compileFromScalar(s, steps, at)
       :                         compileFromList(s, steps, at);
}
```

- `compileFromElements(st, steps, at)` — TODAY's `compileTail`, restructured: the existing
  special-cases (`properties`/`choose-options`/`map`/`math`/`group`) stay; `foldTailAcc` now
  returns `{acc, stop}` and STOPS (does not throw) at a retype boundary (`unfold`, or a reducer
  that is not last); on hitting one, build the next `Stream` and `dispatchNext`. Otherwise render
  terminally exactly as today.
- `compileFromScalar(stream, steps, at)` — the `foldTailAcc`+`renderProjection` engine
  `compileInject` uses, entered from a `ScalarStream` seed. `compileInject` becomes "seed a
  `ScalarStream` from `VALUES` + `dispatchNext`".
- `compileFromList(stream, steps, at)` — `unfold` → `dispatchNext(compileUnfold(stream), …)`;
  a `LIST_MODIFIERS` entry (Scope.local order/limit/tail/range/reducers) → recurse;
  end-of-steps → terminal list framing; else clear throw.

`compileRead` = `buildPrefix` (unchanged) → `compileFromElements(st, steps, stop)`.

**Why "only one projection" dissolves generally:** the single-projection guard stays true
WITHIN one `foldTailAcc` run (untouched). A retype boundary starts a NEW phase with a fresh
accumulator. `V().fold().unfold().values('name')` = elements→list→elements→scalar, each phase
with ≤1 projection, chained by `dispatchNext`. Structural fix, not a loosened check.

## A.3 File decomposition (the readability unlock)

The dispatcher is what lets each shape live in its own file. Target layout (from the 1039-line
`projection.ts`):

| file | holds |
|---|---|
| `src/steps/context.ts` | `Carry` + `St` (elements) + `advance` (existing) |
| `src/steps/stream.ts` **(new)** | `Stream` union, `ScalarStream`/`ListStream`/`ListOf`, constructors, `carryOf` |
| `src/steps/index.ts` | `PREFIX`, `foldBody`, `buildPrefix`, `dispatchNext`, `compileFromElements`, `compileRead` |
| `src/steps/scalar.ts` **(new)** | `compileFromScalar` + the scalar half of the tail (extracted from `compileInject`/`renderProjection`) |
| `src/steps/list.ts` **(new)** | `compileFold` (value form), `compileFromList`, `compileUnfold`, `LIST_MODIFIERS` (Scope.local), `json_each` explode helpers |
| `src/steps/select.ts` **(new)** | `compileSelectProject` + `buildMapEntries` + `compileMapToList` (select(Column.values/keys)) |
| `src/steps/group.ts` **(new, optional)** | `compileGroup` + `buildGroupKey` (extract from projection.ts) |
| `src/steps/path.ts` **(new, optional)** | `compilePath` + `compilePathArray` |
| `src/steps/projection.ts` | element PROJECTORS + `buildProjection` + shared `renderProjection` + `TailAcc`/`foldTailAcc` |
| `src/render.ts` | `Shape` (+ maybe `listPerRow`/`listPerRowGrouped` if terminal list-of-elements framing needs it — see A.4) |
| `src/handler.ts` | list framing reads JSONB (`json(list)`), `json_each`+frame; `listBuffer` reuse |

The optional extractions (`group.ts`/`path.ts`) can be split opportunistically — do them if the
file-size/clarity win is there, skip if churn outweighs it. The load-bearing new files are
`stream.ts`, `list.ts`, `scalar.ts`.

## A.4 fold as a real list value

`fold()` becomes a real list value: one row, a JSONB `list` column.
- element stream → `SELECT jsonb(json_group_array(id)) AS list FROM <stream>` (`ListOf {elem}`,
  bare rowids — rejoin on unfold/framing, mirroring `compilePathArray`).
- scalar stream → `SELECT jsonb(json_group_array(v)) AS list FROM <stream>` (`ListOf {scalar}`).

`fold()` is no longer a terminal-only reducer — it PRODUCES a `ListStream`. Replace `reducerMod`'s
`at.last` guard for `fold` with the list-phase transition: if `fold` is last, frame the list value;
if steps follow, `dispatchNext` into `compileFromList`.

**Terminal fold framing** (fold is last step): handler's `list` case reads the JSONB column and
frames each element (element list: `json_each` + rejoin `nodes`/`edges` via `vertexBuffer`/
`edgeBuffer` to preserve props — NEVER `anySerializer`; scalar list: frame each `v`). This is a
CONTAINED change to one handler function, guarded by existing `fold()` snapshots. (If element-list
framing gets awkward through the existing `{kind:'list'}` Shape, add `{kind:'listPerRowGrouped',
elem}` + a `listGroupedBuffers` sibling of `pathGroupedBuffers`, `handler.ts:149-160` — decide during impl.)

**`fold().unfold()` needs NO special-casing** — it works through the general path (materialize the
list value, then `json_each`-explode it), a harmless wasteful roundtrip on a query nobody writes.
Do NOT add a peephole to cancel the roundtrip — that's a premature optimization; correct-but-wasteful
is fine here (FAQ + EXPLAIN, not code).

## A.5 unfold typing

```ts
// src/steps/list.ts
export function compileUnfold(s: ListStream): St | ScalarStream {
  const c = carryOf(s);
  if (s.of.kind === 'elem') {
    const rel = c.q.cte(q`SELECT je.value AS id FROM ${s.rel}, json_each(${s.rel.c.list}) je ORDER BY je.key`, ['id']);
    return { ...c, kind: 'elements', last: rel, elem: s.of.elem, aliases: new Map(), path: undefined };
  }
  const rel = c.q.cte(q`SELECT je.value AS v FROM ${s.rel}, json_each(${s.rel.c.list}) je ORDER BY je.key`, ['v']);
  return toScalarStream(c, rel, s.of.as);
}
```
- list-of-elements → `St` → `dispatchNext` re-enters `compileFromElements` → `foldBody`/PREFIX →
  `unfold().out()` works with zero new movement code.
- list-of-scalars → `ScalarStream` → `compileFromScalar` (the shared inject tail).
- Aliases/path riding through a list retype are NOT supported yet — throw clearly (mirror the
  existing "after as()" refusals in `branch.ts`), don't silently drop.

## A.6 Scope.local

**Prerequisite: parse `Scope` (fact 8) — must land before ANY Scope.local support** so unsupported
forms fail closed instead of silently going global.

Lives in `LIST_MODIFIERS` (`list.ts`), reached only from `compileFromList` (structurally guaranteed
list-kind). Each reducer = explode → transform → re-collapse in one subquery, preserving list-kind:
```sql
-- order(Scope.local) asc, over a per-row JSONB list column `lst`
SELECT (SELECT jsonb(json_group_array(v)) FROM (SELECT je.value v FROM json_each(lst) je ORDER BY je.value ASC)) AS list FROM <seed>
-- limit(Scope.local,n): add LIMIT n inside; range(Scope.local,lo,hi): LIMIT/OFFSET
-- tail(Scope.local,n): ORDER BY je.key DESC LIMIT n, then re-ORDER BY key (two-level)
-- sum/min/max/mean/count(Scope.local): SQL aggregate directly → shape becomes scalar (reuse wrapReducer framing)
```

**MANDATORY fail-loud guard (do not skip — this is the silent-wrong trap):** the existing global
`order`/`limit`/`range`/`skip` in `MODIFIERS` (`projection.ts:56-72`) today read only `.bys`/args
and IGNORE a `{scope:'local'}` arg. Each must gain an explicit check: if `s.args[0]?.scope ===
'local'` is seen OUTSIDE a list phase → throw `"X(Scope.local) requires a preceding list-producing
step"`. Land this guard WITH its negative test in the same commit. Without it, `order(Scope.local)`
in the wrong position silently compiles to global order — plausible and wrong.

## A.7 select(Column.values/keys)

Extract `compileSelectProject`'s multi-key column-builder into `buildMapEntries` (behavior-neutral).
When `select(Column.values|keys)` follows a Map-producing `group`/`groupCount` (or `select`/`project`),
pack the entries into a `ListStream` instead of framing a Map:
- `elementList` group value (`by(__.fold())`/bare `by()`) → re-emit the underlying element rows with
  the group-key columns dropped ≈ near-identity (`V().group().by(label()).by(fold()).select(values).
  unfold()` compiles to same multiset as `V()`, reordered).
- `scalarList` (`by('age')`, already `json_group_array`) → genuine `json_each` explode → scalar stream.
- `count`/`sum` per key → not list-shaped; `unfold` is a pass-through no-op.
- `select(Column.keys)` → `buildGroupKey` alone, `SELECT DISTINCT <key>`.
- `elementLast` (`by(__.tail())`) → needs a window fn; DEFER with a clear throw.
- group/valueMap-sourced Column with dynamic Map size beyond the above → DEFER clearly.

## A.8 Commit sequence (each green; L1 2298/2298; L3 ratchets)

0. **Frontend correctness** (independent, may ratchet L3 alone): parse `TraversalScopeContext` →
   `{scope}` and `GenericCollectionLiteralContext` → JS array. **GREP the L1 corpus + feature set
   for existing bracket-literal args first** — ensure nothing currently passing regresses from
   "N args" to "1 array arg" (risk A-1).
1. **Scaffolding, zero behavior change**: extract `Carry`/tag `St`; add `stream.ts` (unused);
   `jsonbArrayOf`/`jsonbGroupArray` helpers in `plan.ts`. Full L1/L3 unchanged.
2. **Dispatcher + decomposition, behavior-neutral**: `compileTail`→`compileFromElements`+
   `dispatchNext`; extract `compileFromScalar`/`scalar.ts` (`compileInject` = seed + dispatch);
   `foldTailAcc` returns `{acc,stop}` + stop-not-throw at reducer/unfold. **THE risky structural
   commit — full L1/L3 regression before AND after (risk A-2).**
3. **fold as value + unfold**: `compileFold` (JSONB value), `compileFromList`,
   `compileUnfold` (both `ListOf`), handler JSONB list framing. `fold().unfold()` works via the
   general materialize→`json_each` path (no peephole). Lands `g_V_fold_unfold` + fold-as-value foundation.
4. **inject-list unfold**: collection-literal → `ListStream` (`jsonb_array` of consts) → unfold →
   scalar. Lands `inject([...]).unfold().asNumber()/.where(is)`.
5. **Scope.local**: `LIST_MODIFIERS` (order/limit/tail/range/reducers) + the fail-loud guard +
   negative test. Lands `inject([...]).limit/tail(Scope.local,n).unfold()`.
6. **select(Column.values/keys)**: `buildMapEntries` extract + `compileMapToList` + group lookahead.
   Lands the group-values cluster (`.unfold().order(Scope.local)`, `.dedup()`).
7. **Docs/ratchet**: CLAUDE.md substrate note, `test/conformance/tags.ts` widened, baseline bump,
   `fold().unfold()` FAQ line. Note set-ops as the teed-up Tier-2 follow-on.

Each commit: SQL snapshot tests + an execution test + `bun test test/conformance/l3.test.ts`
(auto-bumps baseline locally per CLAUDE.md), corpus stays 100%.

## A.9 Risks + mitigations

- **A-1 (frontend collection literal changes existing parse).** `[a,b,c]` as an arg anywhere today
  flattens to N args. Grep `test/conformance/corpus.txt` + feature set for bracket-literal usage
  before commit 0; confirm no passing traversal regresses.
- **A-2 (dispatcher refactor blast radius).** Commit 2 rewires a 1039-line, 100%-green file. Keep it
  strictly behavior-neutral; full L1+L3 regression on both sides; if L3 moves at all in commit 2,
  something's wrong — investigate, don't ratchet.
- **A-3 (`jsonb_group_array` availability on SQLite 3.47/3.53).** Use `jsonb(json_group_array(...))`
  (always valid) not the native form unless probed. Add an `EXPLAIN QUERY PLAN` check that
  Scope.local's per-row explode→reduce→recollapse doesn't scan pathologically at scale.

---

# APPROACH B (FALLBACK) — JSONB column + tag + reuse ramps (the middle path)

Switch to this if A's commit-2 dispatcher refactor gets into trouble (regression whack-a-mole, or
the abstraction fights the existing tail). B delivers the SAME Tier-1 behavior with a smaller,
additive footprint, at the cost of not dissolving "only one projection" generally and some
retype-logic duplication.

**Core difference:** do NOT introduce a `Stream` union or a dispatcher. `St` stays THE state
(elements). A list = a `Relation` with a JSONB `list` column + a `{elem|scalar}` tag. Handle each
producer/consumer in a dedicated function that re-enters via the EXISTING seams:
- `reenterElem(q, params, idRel, elem, steps, from)` → build a fresh `St`, call `foldBody` +
  `compileTail` (the `branchArm` pattern).
- `reenterValue(Q, valueRel, steps, from, indexKeys)` → `foldTailAcc` + `renderProjection` (the
  `compileInject` pattern).

**Discipline (this is why it's the "middle path", not the raw minimal design):** factor the retype
primitives into ONE `src/steps/list.ts` from day one — `buildListValue`, `explodeList`,
`reenterElem`, `reenterScalar` — so retype logic is centralized even without the dispatcher. This
keeps B from accreting divergent copies and makes a LATER promotion to A mechanical.

**Do NOT** (the raw minimal design's mistakes, rejected):
- Do NOT lean on compile-time constant-folding to fake the examples (`inject([3,1,2]).order(Scope.local)`
  sorted in JS). Build the SQL-native `json_each` path as the mechanism; const-folding is at most a
  later optimization. (This is the "don't punt downstream" line.)
- Do NOT special-case only `fold().unfold()`; build the real list value so set-ops follow.

**B commit sequence:** same commit 0 (frontend) and same commits 4–7 in spirit, but commits 1–3
collapse into "add `list.ts` primitives + `compileFold` value + `compileUnfold` + wire the two
ramps" without touching `compileTail`'s structure (only relaxing `foldTailAcc` to stop at `unfold`
and adding the peephole). `St`/`render.ts` mostly unchanged; handler gains the JSONB list framing.

**B pros:** small localized diff, minimal regression risk, matches the codebase's existing
"specialized compile fn per shape" grain (`compileProperties`/`compileGroup`/`compileInject`).
**B cons:** "only one projection" stays per-case; retype kind is implicit (no TS exhaustiveness →
fail-open risk, guard every fn); duplication accretes as Tier 2/3 land (may refactor into A later,
paying twice).

**When to abandon A for B:** if commit 2 can't be made behavior-neutral within ~a session of effort,
or L3 regresses in ways that resist isolation. Reset the worktree (blast radius is compiler-only) and
execute B from `list.ts` primitives — commit 0 and the fact-base above carry over unchanged.

---

# Testing discipline (both approaches)

- Every commit: SQL snapshot tests (assert the SQL is semantically equivalent) + an execution test (round-trip through
  the handler) + `bun test test/conformance/l3.test.ts` (baseline auto-bumps locally when
  `!process.env.CI`; commit it) + corpus stays 100% (`test/conformance/corpus.test.ts`).
- Behavior-neutral commits (A-1 scaffolding, A-2 dispatcher) MUST leave L1 (2298/2298) and L3
  counts unchanged and SQL semantically equivalent — if a count moves, stop and investigate.
- Widen `test/conformance/tags.ts` as each family lands (fold/unfold, Scope, Column) — never narrow.
- Fail-closed everywhere: an unsupported retype/Scope form throws a clear "not yet supported"
  message, never silently truncates or goes-global. The Scope.local guard (A.6) ships with a
  negative test in the same commit.

# Decision log (settled this session — do not relitigate without cause)

1. **Go big — build the substrate, not a leaf.** `fold().unfold()`-only would be a bait-and-switch.
2. **Tier 1 scope** (list-value + re-enterable tail + unfold + Scope.local + select(Column.values));
   Map-unfold, set-ops, `local()`, `aggregate/cap` deferred.
3. **fold as a REAL list value** is the canonical producer (unlocks set-ops, Scope.local-on-fold,
   fold-alias reuse) — NOT gold-plating.
4. **`fold().unfold()` works via the general fold-as-value path** (materialize→`json_each`), a
   harmless wasteful roundtrip — NOT special-cased. No peephole (premature optimization for a query
   nobody writes); correct-but-wasteful beats both rejecting it and adding code for it.
5. **Approach A is primary** (bold, decomposed, centralized retype). B is the fallback if the
   dispatcher refactor fights the green tail.
6. **No constant-folding to fake examples; no interpreter** — SQL-native (`json_each`/JSONB) only
   (locked decision #3).
7. **Frontend `Scope` + collection-literal parsing are real bugs**, fixed first regardless.
