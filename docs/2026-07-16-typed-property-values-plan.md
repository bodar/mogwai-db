# Typed property values — one type vocabulary, parse → store → read → frame

**Date:** 2026-07-16 · **Status:** PLAN (not started). Schema change APPROVED (alpha,
no users, no data migration). **Baseline at authorship:** L3 1021, corpus 2298/2298.
This doc is written to be executed from a COLD (`/clear`ed) context — it restates
everything needed. Sibling context: `docs/2026-07-16-compiler-consolidation-plan.md`
(the value-streams work this builds on) and memory `w4-property-model`.

## Goal

`P.typeOf(GType.X)` works for **every** supported type over stored property values —
int/long/short/byte/double/float/bigint, string, boolean, datetime, uuid, char,
list/map/set — with no information lost on write. This is the substrate under
"extendable types." As a direct consequence, list/map/set-**valued** properties
(`property('list', ['a','b','c'])`, currently a bind crash) work, and `values()`/
`valueMap()` frame each value as its true GraphBinary type instead of re-inferring
from the SQLite storage class.

## The one idea

Today there are **three disconnected type vocabularies**:

1. **`Step.argTypes`** (frontend.ts:36) — captured at parse, but ONLY numeric subtypes
   (byte/short/int/long/bigint/float/double/bigdecimal), and consumed ONLY by the
   read/coerce tail (inject.ts, coerce.ts). Every other literal kind emits `null`.
2. **`ValueType`** (render.ts:64) — `'bool'|'byte'|'short'|'int'|'long'|'bigint'|
   'float'|'double'|'date'`. The compile-time GraphBinary framing tag on a scalar
   stream (`as?`). Synthesized ONLY by `as*()` cast steps at read time; never read
   from storage.
3. **`GTYPE_SQL`** (plan.ts:128) — the `typeOf`→SQL map. Non-numeric/non-string types
   fold to `false` because SQLite `typeof()` collapses bool→integer, datetime→integer,
   uuid→text (the "structural wall").

**Unify them into ONE canonical Gremlin type name, produced at parse, stored on write
(new `vertex_properties.vtype` column), and consumed on read (typeOf filter + framing).**
The type is *already parsed* (argTypes) and *thrown away at the write seam*
(`write.ts` never reads argTypes) — this plan stops discarding it and carries it through.

## Canonical type vocabulary

One lowercased name set (superset of GType names; the typeOf argument normalizes to it).
"Serializer?" = a bidirectional GraphBinary serializer exists in the `gremlin` client
package (so the value round-trips); if not, the type can be **detected** (`typeOf`
filter) but a value of it cannot be **framed** out.

| canonical | stored how (value column) | serializer? | notes |
|---|---|---|---|
| `string` | TEXT | ✅ string | |
| `boolean` | INTEGER 0/1 | ✅ boolean | storage-class-ambiguous w/ int → needs vtype |
| `byte`/`short`/`int`/`long`/`bigint` | INTEGER | ✅ each | subtype ambiguous in INTEGER → needs vtype |
| `float`/`double` | REAL | ✅ each | subtype ambiguous in REAL → needs vtype |
| `datetime` | INTEGER (epoch-ms, UTC) | ✅ dateTime | ambiguous w/ long → needs vtype |
| `uuid` | TEXT | ✅ uuid (**exists, unwired today**) | ambiguous w/ string → needs vtype |
| `list` | **JSONB** in value | ✅ list | detect via vtype='list' (or json_type) |
| `map` | **JSONB** in value | ✅ map | detect via vtype='map' |
| `set` | **JSONB** in value | ✅ set | detect via vtype='set'; array shape like list |
| `bigdecimal` | REAL | ❌ **none** | typeOf-filter works; value framing stays deferred |
| `char` | TEXT | ❌ **none** | typeOf-filter works; framing deferred |
| `duration` | — | ❌ **none** | not produced; deferred |

`ValueType` (render.ts) is the framing subset — extend it to add `'string'`, `'uuid'`,
`'list'`, `'map'`, `'set'` (all have serializers) so `frameValue` can key off the stored
type. `bigdecimal`/`char`/`duration` stay out of `ValueType` (no serializer) — a stored
`vtype='bigdecimal'` still answers `typeOf`, but framing that value throws as today.

Alias normalization (typeOf arg → canonical): `integer`→`int`, `biginteger`→`bigint`.
`GTYPE_SQL`'s storage-class map is retired in favor of `vtype` equality (with a
storage-class fallback ONLY for rows whose vtype IS NULL — see Phase 2).

## Current-state map (condensed, with file:line)

Value lifecycle and every touch point a type-tag must thread:

```
PARSE  frontend.ts walkArgs/emit → Step{args, argTypes[]}   (argTypes:36, suffix 40-43)
       numeric subtypes captured (73); datetime→epoch-ms number, type LOST (231-234,266);
       UUID()→plain string, type LOST (no case, generic recursion 257);
       collection literal→JS array/Map, type null (219,252-255); bool/string→null.
WRITE  routeWrite (write.ts:523) → WRITE_RULES (509) → parseVertexSpec (136, reads
       s.args, argTypes UNUSED) → PropSpec{key,value,meta,cardinality} (103, no type) →
       applyVertexProperty (179; raw bind 193-196; set-eq bind 187; traversal guard 183)
       → GraphStore.query coerceBind bool→0/1 bigint→num (storage.ts:88) →
       INSERT vertex_properties(node,key,value,meta) — value BLOB affinity (storage.ts:40).
       Other write sites: insertVertex (210), compileSetProperty (50: vertex 88-95 /
       edge 68-85), mergeV (434/440), mergeE (487/494), singleProps (132).
       Edges: value folded into flat JSONB props blob (write.ts:81,253; insertRow 169).
STORE  vertex_properties.value — SQLite storage class only; Gremlin subtype LOST.
READ   W4 seam (plan.ts:262): nodePropScalar (275, SELECT value ORDER BY id LIMIT 1),
       nodeHasProp (280), scalarProp/hasProp (287/292), vertexPropsAgg (298,
       json_group_object), framedProps (303), valueMapProps (313).
       values('k') flatMap JOIN → PROJECTORS['values'] (projection.ts:533; sets
       Shape{kind:'value', as UNSET}). valueMap/elementMap (548-563). has/order.by
       (filter.ts:133,183; nodePropOrderKey projection.ts:575). properties() stream
       (group.ts:353 PROPERTY_PAYLOAD ['vpid','owner','ownerLabel','pk','pv','pmeta'],
       372 selects vp.value AS pv; mirrored stream.ts:199, materialize.ts:96).
FRAME  execute.ts framedResults (288) → frameValue(v, as) (212-229) — THE consume point;
       as===undefined → anySerializer (infer from JS value, LOSSY). vertexBuffer (24),
       vertexPropertyBuffer (68, anySerializer 74), valueMapBuffer (84), groupBuffer
       (245), list/map buffers (108-141) — all anySerializer today.
typeOf plan.ts:141 typeOfSql; GTYPE_SQL:128; predicateSql:151.
render.ts:64 ValueType; :66-86 Shape; frameValue switch execute.ts:212-229.
schema.ts:13 vertexProperties relation constant (MUST gain the column).
```

Serializer availability (client `gremlin` build/esm/structure/io/binary): boolean, byte,
short, int, long, biginteger, float, double, string, datetime, **uuid** (unwired), list,
map, set, binary, vertex/edge/vp/property/path all ✅. **bigdecimal, char, duration = no
serializer** (DataType code exists, no impl). tree/graph = StubSerializer (throws).

## Design

### Schema (storage.ts + schema.ts)

Add `vtype TEXT` to `vertex_properties`, **nullable**:
```sql
CREATE TABLE IF NOT EXISTS vertex_properties(
  id INTEGER PRIMARY KEY, node INTEGER NOT NULL REFERENCES nodes(id),
  key TEXT NOT NULL, value, vtype TEXT, meta BLOB)
```
- Nullable so `test/performance.test.ts:24`'s raw `INSERT(node,key,value)` still works
  (NULL vtype = "infer", the legacy path). All writes through `applyVertexProperty` set
  it, and everything re-seeds (seeds run gremlin through the write path), so real data
  always has vtype.
- `value` column UNCHANGED — scalars keep storage class (numeric order/range intact).
  Collections (JS array/Map/Set) serialize to **JSONB** in `value` (`jsonb(?)` on the
  JSON text) with vtype='list'/'map'/'set'. This is what fixes the bind crash.
- Add `'vtype'` to the `vertexProperties` relation cols (schema.ts:13) — after `value`,
  before `meta` — or everything using `vp.c.vtype` won't typecheck.
- Indexes: keep `vp_key_value(key,value)` and `vp_node_key(node,key)` as-is for now.
  (A later `(key,vtype)` index only if typeOf-filtering shows up hot in EXPLAIN.)

### Parse (frontend.ts) — capture every literal's type

Extend literal capture so each property VALUE literal records its canonical type. Two
options; **recommend inferring at the write seam from JS runtime type + argTypes** (less
frontend churn) and only extending the frontend for the cases JS type can't disambiguate:
- number + argTypes subtype → that subtype (already captured).
- number with no subtype → int (int-literal default) / double (float-literal default).
- string → `string`; boolean → `boolean`; JS array → `list`; JS Map → `map`;
  JS Set → `set`.
- **datetime**: `datetime('...')` becomes an epoch-ms number today (231-234) and loses
  the marker. Add capture: tag the DateLiteral's argType `datetime` (parallel to numeric
  suffixes) so the write records `datetime` not `long`.
- **uuid**: `UUID('...')` degrades to a string today (no frontend case). Add a
  `uuidLiteral` case that tags argType `uuid` (value stays the string form).
- char: no literal path in practice; skip.

Net: `argTypes` graduates from "numeric subtypes only" to "every literal's canonical
Gremlin type." (Keep numeric defaults at frontend.ts:40-43.)

### Write (write.ts) — thread + store the type; serialize collections

- `PropSpec` (103) gains `vtype?: string`. `parseVertexSpec` (136), `singleProps` (132),
  `compileSetProperty` (57) populate it from the step's argTypes + JS-value inference
  (one helper `gremlinTypeOf(jsValue, argType)`).
- `applyVertexProperty` (179) gains a `vtype` param; binds a 5th column. For collection
  vtypes, serialize the value: `jsonb(JSON.stringify(val))` into `value`, and bind
  vtype; for scalars bind the value raw as today. This removes the array-bind crash.
- `mergeV`/`mergeE` (434/440/487/494), `insertVertex` (210) thread vtype through.
- Edge properties: **deferred this pass** (see Open Questions) — edge values stay
  untyped in the flat JSONB blob. `typeOf` over an edge property stays false/deferred.

### Read — carry a per-row type column

A property key can hold DIFFERENT types across rows (vertex A `property('x',1)`,
vertex B `property('x','a')`), so the type is **per-row data, not a compile-time tag**.

- `values('k')` (PROJECTORS['values'], projection.ts:533): also select `vp.vtype`, and
  carry it on the resulting `ScalarStream` as a per-row **`vtype` column** (new optional
  column, distinct from the storage-class `vt` used by numeric reducers — `vt` is
  'integer'/'real'/'text' for reducer framing; `vtype` is the full Gremlin type). Thread
  it through row-preserving scalar ops (is/order/limit/dedup); drop it at transforms/
  reducers (which change or erase the type).
- `properties()` stream (group.ts:353): add a `pvtype` payload column (8th) alongside
  `pv`, threaded through filterProperty/propertyScalar/compileFromProperty and mirrored
  in stream.ts:199 + materialize.ts:96.
- Statically-typed scalars (inject literal, `as*()` cast, math→double) keep the
  compile-time `as` tag; set the inject scalar's `as` from the literal's argType so
  `inject(1).is(typeOf(INT))` folds at compile.

### typeOf (plan.ts) — vtype equality, static fold, or fallback

Rewrite `typeOfSql(expr, arg, ctx)` to resolve the current scalar's type by source:
1. **Static `as` on the stream** → constant `1`/`0` at compile (e.g. asNumber/math/inject
   literal). Fold.
2. **Per-row `vtype` column present** → `vtype = '<canonical>'` (mixed-type keys correct).
3. **Neither (NULL vtype / untyped)** → storage-class fallback: numeric/string map as
   today; everything else `0`. Preserves old behavior for untyped rows.

`has('k', typeOf(X))` → `EXISTS(SELECT 1 FROM vertex_properties WHERE node=… AND key=?
AND vtype='<canonical>')`. Replace `GTYPE_SQL` with a canonical-name + alias table.
`typeOf(LIST)` etc. now match instead of folding to false.

### Frame (execute.ts) — consult the stored type

- Extend `ValueType` (render.ts:64) with `string`/`uuid`/`list`/`map`/`set`; extend
  `frameValue` (212) with cases: uuid→`uuidSerializer`, string→`stringSerializer`,
  list/map/set→the collection serializers (over the JSONB value). bigdecimal/char/
  duration have no case → stay `anySerializer`/throw (unchanged).
- Per-row framing: where a scalar/property stream carries a `vtype` column,
  `framedResults` frames each row by its own vtype (not the single static `as`). Where
  only a static `as` exists (computed scalars), frame by it as today.

### The list-substrate reuse (the elegant payoff)

`is(typeOf(GType.LIST))` is not just a filter — after it, every surviving value is a
JSONB array. Make it **retype the scalar stream → `ListStream`** (the `value` JSONB blob
becomes the `list` column). Then `unfold()` / `count(local)` / `range` / `project(...
by(count(local)))` all reuse the EXISTING list substrate (matrix §9) with no new code.
Same idea for `is(typeOf(MAP))` → MapStream (if in scope). This is why the List.feature
scenarios are "almost already built."

## Phased build plan (each phase ships green + commits + ratchets)

Use `MOGWAI_L3_TELEMETRY=1 bun test test/conformance/l3.test.ts` after each phase to
measure and re-rank; `bun test` (full) before each commit; commit-push-trunk per green
phase (NOTE: no backticks in `-m`, shell eats them — use `-F msgfile`).

**Phase 1 — schema + write capture (fixes the bind crash; no read change yet).**
Add `vtype` column + relation col; `gremlinTypeOf` helper; thread through PropSpec/
parseVertexSpec/applyVertexProperty/merge/insert; serialize collections as JSONB.
Verify: `g.addV('data').property('list',['a','b','c'])` writes without throwing; a
direct SQL check shows `vtype='list'` and a JSONB array in `value`. Expect L3 flat or
small (writes succeed but traversals not yet typed). Fix `test/performance.test.ts` raw
insert if needed (nullable column → fine). SQL snapshots in `test/compiler.test.ts` for
the property SELECT/INSERT churn — regenerate.

**Phase 2 — typeOf via vtype (the wall falls).**
Per-row `vtype` column on `values()`/`properties()`; rewrite `typeOfSql` (static-fold /
column / fallback); `has('k',typeOf(X))` EXISTS-on-vtype; canonical name+alias table;
set inject scalar `as` from argType. Verify: `typeOf(DATETIME)` (DateTime.feature ~8),
`typeOf(LIST/MAP)`, bool/uuid typeOf scenarios; `has(list, typeOf(LIST))`. Telemetry
should clear the `typeOf`/`Binding` buckets.

**Phase 3 — framing from stored type + list retype.**
Extend `ValueType`+`frameValue` (uuid/string/list/map/set); per-row framing in
framedResults; `is(typeOf(LIST))`→ListStream retype (and MAP→MapStream if scope). Verify:
List.feature unfold/count(local)/range/project/where scenarios; `values()` of a datetime/
uuid/bool prop frames the correct GraphBinary type (not inferred).

**Phase 4 — (assess/defer) edges + tail.**
Edge property types (design fork below); `typeOf` over edge props; bigdecimal/char as
typeOf-filter-only. Only if telemetry says it's worth it.

## Decisions (locked unless flagged)

- **vtype is a nullable TEXT column on `vertex_properties`.** NULL = infer (legacy/raw
  insert). Value column unchanged; collections → JSONB in value. No data migration
  (alpha; DDL is CREATE IF NOT EXISTS; everything re-seeds through the write path).
- **Per-row type, not compile-time only** — a key's type can vary by row; typeOf must
  filter per-row via the vtype column. Static `as` still folds when the type is known at
  compile (inject/cast/math).
- **One canonical vocabulary**; `ValueType` extends to the frameable additions; typeOf
  normalizes GType→canonical. `GTYPE_SQL` storage-class map retired (kept only as the
  NULL-vtype fallback).
- **Numeric subtypes stored exactly** (byte vs int vs long) from argTypes → `typeOf(LONG)`
  vs `typeOf(INT)` distinguishable over stored values.
- **bigdecimal/char/duration**: store vtype, `typeOf`-filter works, value framing stays
  deferred (no serializer) — not a regression, a documented edge.
- **Reuse the list substrate** via `is(typeOf(LIST))`→ListStream rather than building
  dynamic list handling on the scalar path.

## Open questions for the user (resolve before/early in Phase 1)

1. **Edges.** Vertex-first is assumed (edges deferred to Phase 4). Edge property values
   live in one flat JSONB blob with no per-value type slot — giving them types is a
   design fork: (a) a parallel `{key:type}` JSONB column on `edges`, or (b) promote to a
   normalized `edge_properties` table (TinkerPop edge Property has no id/meta/multi, so
   W4 didn't warrant a table — but it does have a type). Which, or defer?
2. **Bound-param writes** (`property('x', p)` where p is a bound param). The JS client
   sends int/long/double all as `number` over GraphBinary (can't distinguish) — so a
   bound numeric's exact subtype is unrecoverable server-side (same boundary as
   asNumber). Assumed: infer from JS runtime type (number→int/double heuristic), document
   the limitation. OK?
3. **`vt` vs `vtype`.** Keep the storage-class `vt` (numeric-reducer framing) separate
   from the Gremlin `vtype`, or unify (vtype supersedes vt where present)? Assumed:
   separate, note the relationship. OK?

## Test/churn expectations

- `test/performance.test.ts:24` raw insert — nullable column keeps it valid; vp-index
  EXPLAIN asserts unaffected (indexes unchanged).
- `test/compiler.test.ts` — SQL-substring snapshots for property SELECT/INSERT churn
  (nodePropScalar `ORDER BY id LIMIT 1`, values JOIN, INSERT column list). Regenerate.
- Conformance seeds re-seed transparently (gremlin through the write path).
- `baseline.json` ratchets up per phase; commit the bump.

## Start-here for a cold context

1. Read this doc + `docs/2026-07-16-compiler-consolidation-plan.md` §4b/§4c + memory
   `w4-property-model`, `conformance-grind`.
2. Confirm the 3 open questions with the user.
3. Phase 1: `src/storage.ts` (DDL) + `src/schema.ts` (relation) + `src/steps/write.ts`
   (PropSpec/applyVertexProperty/parseVertexSpec) + `src/frontend.ts` (datetime/uuid/
   collection argType capture) + a `gremlinTypeOf` helper. Verify the list write; commit.
4. Phase 2: `src/plan.ts` (typeOfSql + canonical map) + `values()`/`properties()` vtype
   column threading. Verify typeOf; commit.
5. Phase 3: `src/render.ts` + `src/execute.ts` framing + the `is(typeOf(LIST))`→ListStream
   retype. Verify List.feature; commit.
