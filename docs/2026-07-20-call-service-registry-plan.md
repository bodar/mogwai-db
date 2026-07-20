# call() + the TinkerServiceRegistry — implementation plan

**Date:** 2026-07-20
**Status:** proposed
**L3 gap addressed:** deferral bucket #2 — `unsupported source step: call` (14) + `step not
implemented: call()` (5). Target feature: `map/Call.feature` (20 scenarios,
`@StepClassMap @StepCall @TinkerServiceRegistry`).

## What `call()` is

`g.call(service, [map], [traversal]).with(k, v)…` invokes a **registered service** by name.
TinkerPop's `ServiceRegistry` + `TinkerServiceRegistry` register exactly three "toy" services
(confirmed against `origin/master` source — there are no other standard services):

| service | source | kind | semantics |
|---|---|---|---|
| `--list` (`DirectoryService.NAME`) | `ServiceRegistry` | Start | list/describe registered services |
| `tinker.search` | `TinkerTextSearchFactory` | Start | scan property values by regex, return the matching `Property` |
| `tinker.degree.centrality` | `TinkerDegreeCentralityFactory` | Streaming | per-input-vertex edge count in a direction |

**Parameters** arrive three ways and merge into one param map: a static map literal arg, a
traversal arg that produces a map (`__.project(k).by(__.constant(v))`), and `.with(k, value)`
modulators where `value` is a literal, an enum, or a traversal (`__.constant(v)`). In **every**
Call.feature scenario the param values are compile-time constants.

### Exact service semantics (from TinkerPop source)

- **`--list`** — `ServiceRegistry.execute`: emit each registered service's *name* (verbose=false
  default), filtered by the `service` param when present. The DirectoryService itself is **not**
  listed. TinkerGraph → `["tinker.search", "tinker.degree.centrality"]` in registration order.
- **`tinker.search`** — `TinkerHelper.search`: regex = `.*(search).*` (or a raw `regex` param);
  scan elements of the requested `type` (default: vertices ∪ edges ∪ vertex-properties), flat-map
  to their properties, keep properties whose `value.toString()` **fully matches** the regex (i.e.
  substring containment for a metachar-free term). Returns `Property`/`VertexProperty` objects.
  `type` ∈ {Vertex, Edge, VertexProperty}; VertexProperty searches *meta*-properties (empty on the
  toy graphs). `.element()` then yields each property's owning element.
- **`tinker.degree.centrality`** — per input vertex, `count(v.edges(direction))`; `direction`
  default **IN**. Bulk-aware (emits `count` once per traverser bulk). Cannot start a traversal.

## Key realization — most of this reuses existing machinery

De-risked by running candidate equivalents against the seeded modern graph:

- `--list` ≡ `g.inject("tinker.search", "tinker.degree.centrality")` (with the `service` filter
  applied at compile time, since it is constant). ✔ verified: returns the two names.
- `tinker.degree.centrality` (direction D) ≡ **`{in|out|both}E().count()`** per vertex:
  - `g.V().where(__.inE().count().is(3)).values("name")` → `["lop"]` ✔
  - `g.V().map(__.outE().count())` → `[3,0,2,1,0,0]` ✔ (correct per-vertex out-degrees)
- `tinker.search` result is a `Property` stream, and **`PropertyStream` already has an
  `element()` tail** (`propertyElement` in `PROPERTY_TAIL`, `group.ts`) that transitions to the
  owning node/edge. So only the *source relation* is new.

So the only genuinely new lowerings are: (a) a `tinker.search` PropertyStream source, and (b)
`project()` over a **scalar** stream with an element-valued path-label `by()` field (the degree
`project(...).by(select("v")).by()` scenarios). Everything else is a front-end rewrite.

## Architecture — desugar in `normalize`, one new source builder

Per the compiler-extension law, `call` gets **no** private mini-compiler. It is resolved in the
normalize seam and lowered through the existing engine.

### Seam A — `foldCall` in `src/strategies.ts` (new normalize pass)

Runs inside `normalize()` (so it applies to top-level **and** nested bodies uniformly — nested
traversals are normalized via `child.ts:62 normalize(rawSteps)`). For each `call` step:

1. **Absorb trailing `with()`** modulators onto the `call` step (like `foldByModulators`); leave
   non-`call` `with()` (e.g. `valueMap().with(token)`) untouched.
2. **Resolve service name** (`call()` → `--list`) and **constant-fold params** from the map arg,
   the traversal arg (`__.project(k).by(__.constant(v))` → `{k:v}`), and each `with(k, …)`
   (literal / enum / `__.constant(v)`). Reuse `isNested`/`stepChain` for nested extraction.
   Non-constant param traversals → **throw a clear deferral** (fail closed; no feature needs them).
3. **Rewrite by service:**
   - `--list` → replace the `call` step with `inject(<names filtered by the resolved `service`
     param>)`. (Names are the fixed registry list — a module constant.)
   - `tinker.degree.centrality` → replace with `map(__.{in|out|both}E().count())` chosen from the
     resolved `direction` param (default IN). A nested `__.call("…centrality")` inside
     `where()`/`by()` rewrites identically, so the child/where cases fall out for free.
   - `tinker.search` → rewrite to a single synthetic source step `__search` carrying
     `{regex, type}` (only meaningful as a Start step). This is the one case the engine can't
     already express.

Guard: `tinker.degree.centrality` as a **source** (position 0) → throw `cannotStartTraversal`
(spec-faithful; unused by the suite). `tinker.search`/`--list` mid-traversal → not in the suite;
fail closed.

### Seam B — `tinker.search` source builder in a new `src/steps/call.ts`

Add one rule to the source dispatcher (alongside `inject` in `write.ts`'s `WRITE_RULES`, which is
where source-shaped scalar reads already live): `s[0].name === '__search'` →
`compileSearchSource`. It builds a **`PropertyStream`** from a property-scan relation, then hands
off to `lowerSteps` (so `.element()`, `.with("type",…)` already folded, etc. all reuse the tail):

- Relation = the property table(s) selected by `type`, projected to `PROPERTY_PAYLOAD`
  (`vpid, owner, ownerLabel, pk, pv, pvtype, pmeta`), filtered by value containment.
  - default / `Vertex` → `vertex_properties` (owner = node)
  - `Edge` → `edge_properties` (owner = edge)
  - `VertexProperty` → empty relation (meta-property search; empty on toy graphs — documented
    limitation, matches expected results 13–14).
  - default type is the UNION ALL of vertex + edge (+ empty meta) property rows.
- Containment: `instr(pv, ?) > 0` (case-sensitive, literal — exactly `.*(term).*` for a
  metachar-free term). A raw `regex` param, or a `search` term containing regex metacharacters →
  **throw a deferral** (correct-by-design; a post-SQL JS regex filter is future work, noted below).

### Seam C — `project()` over a scalar stream with an element path-label field

Needed only for the 5 degree `project("vertex","degree").by(select("v")).by()` scenarios. Today
`lowerScalarProject` (`select.ts:268`) returns `null` (→ `project() requires element input`) when
a `by()` field needs element output. Extend it so a `by(select(label))` field that resolves to a
**path-history element** is emitted as an element-id field in the `RecordStream`, while the
identity `by()` field carries the scalar (the degree). This is a self-contained extension to the
scalar-project path; the second (empty) `by()` = identity = the current scalar traverser.

## Work breakdown & expected L3 delta

| Phase | Scope | Call.feature scenarios | Notes |
|---|---|---|---|
| 1 | `foldCall` skeleton: `with()` fold + param constant-folding + service resolution | — | plumbing |
| 2 | `--list` → `inject` | 7 (`g_call`, `g_callXlist*`) | reuse only |
| 3 | `tinker.degree.centrality` → `{dir}E().count()` | 1 (`g_V_whereXcallXdcXX`) | reuse only |
| 4 | `tinker.search` PropertyStream source + `element()` | 7 (`g_callXsearch*`) | one new builder |
| 5 | `project()` over scalar with element path-label field | 5 (degree `project(...)`) | new capability; highest risk |

Total: **20 scenarios** targeted. Phases 2–4 (15 scenarios) are low-risk reuse; Phase 5 (5
scenarios) is the one genuine new traversal capability and can ship separately if it slips.

## Test & discipline obligations (per CLAUDE.md)

- **L2 SQL snapshots** for each new emitted shape (`--list` inject, search property scan, degree
  count) — semantic-equivalence `.toContain`, not byte-identity.
- **`test/compiler.test.ts`** execution-semantics cases (results over the seeded modern graph) —
  the behavioural twin of the snapshots.
- **L1 corpus** must stay 100% (parser already accepts `call`/`with`; no grammar change).
- **L3**: `call` is already in scope (it runs and fails, not skipped) — no `tags.ts` change. A
  clean run re-records `l3-state.json` and syncs the passing count in `README.md` +
  `docs/feature-support-matrix.md` (commit together).
- **L4**: optionally add addendum scenarios for `with("regex", …)` / metachar terms marking the
  post-SQL-regex give-back with `@gap:call-regex`.
- Update `docs/feature-support-matrix.md` for `call`/`element` (❌→✅/🟡).

## Known limitations (fail closed, correct-by-design)

- Raw `regex` param and regex-metacharacter `search` terms → deferral throw (a post-SQL JS regex
  filter inside the store tier is the fidelity path, mirroring the DO's no-UDF regex-TextP story;
  no feature needs it).
- `type: VertexProperty` meta-property search → empty (matches the toy graphs).
- Dynamic (per-traverser, non-constant) call params → deferral throw (no feature needs them).
- `tinker.degree.centrality` as a start step / `tinker.search` mid-traversal → spec-faithful throw.
