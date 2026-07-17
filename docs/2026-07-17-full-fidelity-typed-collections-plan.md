# Full-fidelity recursive typed collection values — Option B (self-describing typed-JSON)

**Status: DONE (2026-07-17)** — 3 stages landed (deep TypeNode capture + set literals →
self-describing `{t,v}` storage cutover → full-fidelity whole-element framing). Closes S2
("typed collection ELEMENTS") from the typed-merge-values plan and the whole fidelity family
(#1–#6). L3 1146 held, zero regressions; e2e round-trip proves per-element wire types survive
write→storage→read→frame across values/unfold/valueMap/vertex/edge/`properties()`/write-echo.

**Deltas from the plan as written** (it predated commit `f6933b6`, the exact-primitive
substrate): the lossy `normalizeLeaf`→number was superseded by reusing `storedScalar`
(long/bigint>2^53, bigdecimal, duration → canonical decimal TEXT — lossless); `frameTypedNode`
leaves reuse `frameValue`/`vtypeToValueType` (now complete for every canonical type); a
`gremlinTypeOf` fix infers `long` for integers beyond int32 (a strict Int framer would
overflow). `nodePropScalar`/`edgePropScalar` were left raw (collection-as-sort/group-KEY is a
degenerate out-of-family shape) — only the materializing `values()` projector + whole-element
aggs json()/`{t,v}`-wrap. Also landed: a per-scenario L3 ratchet (`l3-passing.txt`) that names
regressions instead of only reporting a count.

Chosen after A/B/C architecture bake-off (user picked B).

## Requirement (no compromise)

Every property value round-trips with FULL fidelity: list/set/map elements, typed &
non-string MAP KEYS, arbitrary recursive nesting, each leaf's exact gremlin type
(uuid/datetime/long/…) preserved write→storage→read→GraphBinary. Must NOT regress: scalar
SQLite storage class (order/range), SQL-side collection ops (`unfold()`/Scope.local via
`json_each`), `has`/`typeOf`, both runtimes. Greenfield — NO back-compat / NO migration.

## The whole family being fixed (all rooted in "type must ride with value")

1. list element types; 2. set element types + `{a,b}` set-literal parse bug + set framing;
3. map value **and KEY** types + non-string keys (`collectionJson` does `Map→object` via
`String(key)` — collision bug); 4. recursive nesting; 5. valueMap()/vertex/edge whole-element
framing also drops SCALAR vtype (`vertexPropsAgg`/`edgePropsAgg` don't carry vtype; client
serializers JS-infer); 6. bare `values(mapProp)` mis-frames the raw blob.

## Design — B: self-describing typed-JSON

Schema UNCHANGED. Collection `value` column becomes a self-describing JSON tree; scalars stay
raw (value col + vtype col, storage class intact). The sibling `vtype` column still names the
OUTER shape ('list'/'map'/'set'), so `has`/`typeOf`/existence never touch the value internals.

```ts
// gremlin-types.ts
type ValueNode = { t: CanonicalType|null; v: any }        // scalar leaf (t=null → infer)
               | { t: 'list'|'set'; v: ValueNode[] }
               | { t: 'map'; v: [ValueNode, ValueNode][] } // pairs → typed/non-string keys
```

**On-disk convention:** the column stores the BARE `v` of the top node (the vtype col already
names the outer `t`); only NESTED nodes carry the full `{t,v}` envelope (no sibling column to
consult → must self-describe). list→`[node,…]`, set→`[node,…]`, map→`[[keyNode,valNode],…]`.

**TypeNode gains map KEY types** (needed for #3): map entries `Record<string,{key,value}|null>`
(was value-only). `decodeTyped` MAP branch decodes the key via `decodeTyped` (was bare
`anySerializer`); `mapLiteralType` sets `{key:'string',value}`.

**Write:** stop flattening at `propVtype` (`write.ts:225`) — thread `TypeNode` to
`applyVertexProperty`/`insertEdgeProperty`; store `JSON.stringify(valueNodeOf(val,typeNode).v)`
for collections; `vtype` col = `flatType(typeNode)`. `valueNodeOf` recursively tags; a
`normalizeLeaf` coerces bound `Date`→epoch-millis and `bigint`→number (JSON-safe). Delete
`collectionJson`.

**Read:** `json_each(value)` still iterates top items, but each item is now a `{t,v}` node —
every consumer extracts `->>'$.v'` (payload) / `->>'$.t'` (type). `unfold()` off a stored typed
collection produces a **`vtype`-carrying `ScalarStream`** (reuses the P1–P3 typed-scalar spine —
the elegance win). `ListOf.scalar` gains `typed?:boolean`; `ListStream` gains `set?:boolean`;
`scalarListRetype`→`scalarCollectionRetype(s,'list'|'set')`. `nodePropScalar`/`edgePropScalar`
CASE `json(value)` for collections (fixes #6). `PROPERTY_PAYLOAD` gains `pvtype`.

**#5 fix (biggest piece):** `vertexPropsAgg`/`edgePropsAgg`/`valueMapProps` wrap each property
instance via `propNodeExpr(value,vtype)` = `json_object('t',vtype,'v',CASE WHEN collection THEN
json(value) ELSE value END)`; `vertexBuffer`/`edgeBuffer`/`valueMapBuffer`/`elementMapBuffer`
hand-roll every property value via the unified framer instead of the client's JS-inferring
serializers.

**Unified framer (execute.ts):** `frameTypedNode(node)` (recursive: list/set→containerBuf,
map→mapBuf, leaf→`frameValue(node.v, vtypeToValueType(node.t))` reusing the existing scalar
table) + `frameStoredValue(rawColumn, vtype)` (entry for a raw value+vtype column pair). NEVER
uses the client's container serializers (they JS-infer each element — the bug). Consumers:
`case 'value'`/`case 'property'`/`vertexBuffer`/`edgeBuffer`/`valueMap`/`elementMap`/`group`
element paths + write-response echo all converge here.

## Frontend fixes (bug #2 + list literal typing)

`walkArgs` `GenericCollectionLiteralContext`: build per-element `items` (was flat `'list'`).
NEW `GenericSetLiteralContext` case (grammar `LBRACE genericLiteral … RBRACE`) — currently NO
case → `{a,b}` flattens to N args; add it, producing a real `Set` + `{t:'set',items}`.

## Staging (each: green tsc + bun test + L3 hold, commit)

1. **Frontend/wire/TypeNode capture** — set-literal case (bug #2), list-literal deep items,
   TypeNode map-key types + `decodeTyped` key-typed, `mapLiteralType {key,value}`, add
   `ValueNode`+`valueNodeOf`+`normalizeLeaf`+`mapKeyType` (defined; storage unchanged). Behavior:
   only the set-literal parse changes (verify corpus/L3). Commit.
2. **Storage cutover (atomic core)** — write `valueNodeOf().v`; read paths for collections:
   `json_each ->>'$.v'` across list.ts, `scalarCollectionRetype` list+set, `compileUnfold` typed
   branch, `nodePropScalar`/`edgePropScalar` CASE, `ListOf.typed`/`ListStream.set`; framer
   `frameTypedNode`/`frameStoredValue` + `case 'value'`/list/set root framing. Round-trip green.
3. **Whole-element #5 + properties()** — `propNodeExpr`, aggs wrap `{t,v}`, `vertexBuffer`/
   `edgeBuffer`/`valueMap`/`elementMap`/`PROPERTY_PAYLOAD.pvtype`/group values + write echo via
   the unified framer. Commit.

## Deliberately deferred (flagged, not silent)

- `is(typeOf(MAP))`→`MapStream` relational map-unfold (SQL-side traversal INSIDE a stored map):
  substrate-ready follow-up, not a round-trip-fidelity requirement.
- Scope.local STRING transforms over typed list elements → fail closed clearly (not reachable
  pre-change; retagging the transformed element's type is future work).
- `has(k, eq(collectionLiteral))` collection equality predicate (pre-existing gap).
- meta-properties typing (out of family).
- Upstream JS-client PR / non-conformant-client shim (from typed-merge plan).

## Test discipline

Round-trip contract tests per shape (mixed-type list, set, map with int/uuid/nested-map keys,
deeply nested list-of-map-of-list) asserting every leaf type + key type/value survives
write→read→frame. Set-literal parse test. Bare `values(collectionProp)` per list/map/set.
valueMap/vertex/edge of a uuid/datetime-valued property (#5). GraphBinary round-trip (not just
L3 count) for the hot framing rewrite. Update SQL snapshots (semantic-equivalence rule).
