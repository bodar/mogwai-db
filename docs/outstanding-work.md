# Outstanding work

An index of what is LEFT, in priority order. Per-step support lives in the
[feature matrix](./feature-support-matrix.md); finished work lives in git history and `docs/archive/`.
IDs in parentheses are stable — `git log -S<id>` finds their history (much of it in the archived
[RelIR plan](./archive/2026-08-01-relir-build-plan.md) §10). Reach is common / plausible unless marked.

**Instruments.** L3 floor: `test/L3-conformance/l3-state.json` (deferral buckets in
`l3-telemetry.summary.json`); every in-scope failure is named with its kind and reason in
`test/L3-conformance/expected-outcomes.ts`. RelIR coverage by family: `mise run rel-blockers`. Fail-closed check:
`test/L7-census/deferrals.tsv` must hold no `crashed` rows. Three worklists fail loudly when a shape
lands: `test/rel-spine.test.ts` `DECLINED`, `test/L4-addendum` `@Unsupported`, L5 `LAW UNEVALUABLE`.

**L3 accounting (✅ landed, faecb6f2).** Every in-scope L3 failure is ledgered with a kind
(divergence/wall/decline/defect) and a checked citation; the 16 scenarios the JS GLV cannot ask are
excluded as GLV-lossy, DERIVED from gremlin.js + the corpus (`GLV_LOSSY`, `test/L3-conformance/tags.ts`).
The ledger must equal the failing set (`l3-state.test.ts`, `l3.test.ts`). Remains: nothing — the ledgered
defects are §1 items; a fix deletes its names from the ledger.

**Edge Property framing (l3-edge-prop-frame, ✅ landed, 781a352c).** An edge's property is framed as a
plain `Property`, not a `VertexProperty`: the class rides a compile-time owner discriminant (`Shape`/
`ListOf` `elem`, node tag via `propertyTag`) into `framePropertyRow` (`src/execute.ts`). L3 1890 → 1896.
Remains: nothing.

## 1. Wrong answers today

Each is a lost or duplicated row, a wrong number class, a wrong value or element, or a crash. A data-size
refusal comes first: it is a production outage.

- **Merge writes refuse on traverser count (o-seqguard) — DATA-SIZE REFUSAL.** `sequentialGuard`
  (`rel/write.ts`) raises at run time on `count(*) > 1`: `…values('name').mergeV(__.select('k'))
  .option(Merge.onMatch, __.select('j'))` raises over 6 traversers and answers over 1, as does
  `mergeV([name:'zz']).option(onMatch,[age:1])`; label-only multi-driver `mergeV` with different labels
  declines (r7-fu11). Answer from a SNAPSHOT of the input; this retires `sequentialGuard` and
  `guardMergeInterleaving`/`mergeObservesOtherWrites`.
- **Write-path id lookups skip the uid check — WRONG-ELEMENT WRITE (rf3-reuse1).** `endpointRowid`, mergeE's
  `endpointRowid.byColumn` and `withPreChecks` (`write.ts`) match `id = v`: with `addV('a').property(T.id,'x')`
  at rowid 1, `g.mergeE([(T.label):'k',(OUT):1,(IN):2])` writes an edge from `'x'` (ref: "Vertex does not
  exist"). Export `externalIdIs(idCol, uidCol, v)` from `rowidOnly`; leave `elementIdGuard` alone.
- **A null-holding driver map collapses with its duplicate (nr-fu-null-dup-create).**
  `g.inject([name:'a',age:null],[name:'a',age:null]).mergeV().id()` gives `[7,7]`; the reference creates two
  (a null is never stored, `ElementHelper.java:348-352`). In `rel/write.ts` `createKey`/`mapCouldMatch`, a
  map holding a null entry never collapses.
- **onMatch arms resolve against the Map, not the matched element (nr-fu-onmatch-scope)** — latent behind a
  decline with an untrue reason (`ir/write-args.ts` `mergeMaps`; `MergeVertexStep.java:100`). Pass
  `'notMap'` for onMatch arms. Build before R8-res (§4).
- **`property(k, <traversal>)` (o-prop-trav)** — the guard can fire after an earlier write, and
  `mergeArmValueWrite` takes `limit 1` scan order and stores null.
- **A meta-property under undeclared cardinality patches instead of inserting (o-meta-undeclared).**
- **`loadBulk` `{idPolicy:'remap', onCollision:'replace'}` (rf3-bulk-remap-replace)** — `resolveReplace`
  ignores `idPolicy`, so `V(1)` lands as rowid 1 with uid NULL (`src/bulk.ts`).
- **`loadBulk` APPEND with one uid twice in a batch (rf3-bulk-dup-uid)** surfaces SQLite's raw "UNIQUE
  constraint failed"; add an in-batch check keyed like `dedupeByKey` with the named-remedy error.
- **Federate barriers (rf3-fed-barrier, r7-fu7).** `noParents()` decides the zero-parent answer from the LAST
  pushed step, and with parents a pushed global barrier runs the sibling once: `h.V().count()` gives `[]`
  (ref `[0]`), with parents `[6]` (ref `[12]`). Stop `pushableTailPrefix` at the first global barrier in MID
  form, or lower the pushed prefix over an empty relation for the seed (`ReducingBarrierStep.java:143-148`).
- **A federate subgraph's `V(2,[3,4])` gives `[josh,lop,vadas]`, ref `[vadas]` (rf3-reuse3)** — extract
  `idArgMembers(args)` from `idMembership` for `BoundGraph.elementScan`/`inlineNames` (`rel/boundgraph.ts`).
- **A Map-valued property under `project()` (cr-fu14)** — `g.V().project('n','m').by('name').by(values('m'))
  .select('m')` leaks `TypeError: pairs.flatMap is not a function` (`src/execute.ts`); a `group()` nested in
  `local()` is not reached by ProductiveByStrategy.
- **`dedup()` keeps `[a:1,b:2]` and `[b:2,a:1]` apart** — `g.inject([x:1,y:2],[y:2,x:1]).dedup().count()`
  gives 2; a map's identity should be its entries in any order, read by every dedup/group/set-op site.
- **`barrier(Barrier.normSack)` mis-executes instead of declining** — `withSack(1.0).V().both()
  .barrier(normSack).sack()` gives twelve `1`s; the reference divides each sack by the total.
- **`g.V(1,1)` is one traverser** — the reference gives two (a repeated literal id is a lost row).
- **Untagged whole REAL re-injected by a value barrier frames as an Int** (`lowerValueResume`).
- **Set-op literal operand loses member class** — `combine([1.0d])` reads a whole Double back as an Int.
- **Intermediate `sum` overflow not widened** — a running total that leaves the Long range and returns.
- **`mean()` of a BigInteger** answers a Double (reference: BigDecimal).
- **L3-ledgered wrong answers** — each is a `defect` in `test/L3-conformance/expected-outcomes.ts`; the
  fix deletes its names there.
  - **`Binary(…)` is carried as its base64 String (l3-binary)** — `g.inject(Binary('AQID'))` answers
    `'AQID'`, and `values('blob').is(typeOf(GType.BINARY))` matches nothing: no binary value class exists
    end to end (literal, storage, GraphBinary `BINARY`). `data/Binary.feature`, 5 scenarios.
  - **`call(service, map, traversal)` ignores the traversal's map (l3-call-trav-params)** —
    `call('tinker.degree.centrality', ['x':'y'], __.project('direction').by(constant(Direction.OUT)))`
    answers the default direction, and `call('--list', …, project('service')…)` lists every service. 2.
  - **`select(Pop.mixed, k).by(…)` answers wrong values (l3-select-mixed-by)** —
    `V().as('a').out().as('a').out().as('a').select(mixed,'a').by(unfold().values('name').fold()).tail(local,1)`;
    the matrix lists dynamic-shape `Pop.mixed` as unsupported, yet it answers. 3.
  - **`with('multilabel')` frames an edge's own label as a String (l3-multilabel-edge-label)** —
    `E().elementMap()` gives its endpoints' labels as Sets but its own as a String. 1.
  - **`order(local).by(keys)` sorts `T` keys after every String (l3-t-token-order)** —
    `V(1).elementMap().order(local).by(keys, desc)` gives `id, label, name, age`; the reference orders a
    `T` key by its name (`name, label, id, age`). 2.
  - **`merge()` over an incoming Map raises a type error (l3-map-merge)** —
    `V().has('name','marko').elementMap().merge(__.V().has('name','lop').elementMap())` raises `merge step
    can only take an array or an Iterable type for incoming traversers, encountered map`; the reference
    merges the two maps. 3.

## 1b. Super-linear at production size

Measured N≈1k → 8k (linear ≈8×), or over a DO cap — passes every test graph, fails in production.

- **A chain of value-run `is()` re-inlines its input per `CASE` (rf3-is-chain-size)** — four `is()` emit
  1.52 MB, over DO's 100 KB statement cap. Pin under `CfLimitedSql`; fixed by §3's `once` consumers.
- **A re-source over an origin-INDEPENDENT candidate set is quadratic (cr-fu5 + per-origin slice)** —
  `local(__.V().hasLabel('person').limit(2)).count()` 355 ms → 24.6 s (`sample(2)` the same; `rankPairs`
  crosses origins × candidates). `rootedRead` the prefix once, cross with its small result; fix the
  `rankPairs` doc ("FENCED" overclaims — the CTE is not `MATERIALIZED`).
- **A shared collection is re-read per traverser** — `g.V().group('a').by(constant('a')).by('age')
  .select('a').select('a').count()` 57 ms → 3.4 s. Read the key once as one MATERIALIZED relation and
  cross-join it.
- **Mid-traversal `V().has` with no seek in a READ (r4-perf1)** — 813 ms → 44.6 s.
- **Correlated-value property seek (r7-fu3, r6-fu1)** — `V().has(k, select(label))` needs a narrowing
  `element.id IN (owner seek)` conjunct in `rel/passes/semijoin.ts`, entering correlated subplans via
  `rewriteRels` (55×). The parked attempt failed on: a string id `V('u0')` not treated as a bound, a shared
  `EXISTS` hoisting a CTE over the whole property table, a constant seek outranked, `mapValueElem` throwing
  a bare Error.
- **`fuse` runs only in the read `lowered()` (rf3-fuse-write, r4-fu0)** — a write fed by
  `order().by(…).V().has(…)`, or a write-body `V()` re-source's label filter, renumbers holders×V first.
- **K-entry map driver (r7-fu9)** — `inject([k0:0,…]).mergeV()` 55× (`json_extract` re-reads per entry); a
  child seek does not reach a `fold()` reducer (68×); `hasLabel` after an equi-joined hop in a re-source 16×.
- **Scalar member node rebuilt per one-row producer (r6-reuse4)** —
  `project().by(outE().values('weight').sum())` reads the edges 2× per host row (`max`: 3×).
- **No body-may-yield-NULL fact (S11)**, so the M3 removal machinery always runs (+13–75%).

## 2. Needs a human call

- **GraphQL redesign.** The reflection-derived schema was a mistake
  ([plan, top section](./2026-08-07-graphql-front-end-plan.md)). Replace it with an explicit,
  human-defined schema/views registered via an API (Neo4j GraphQL type-defs / CouchDB design-doc views).
  🔴 Decide: SDL+directives vs views-as-traversals, storage, versioning. Follow-ons under it:
  - a `_gremlin(query:)` raw-Gremlin escape field;
  - mutations generated from the defined schema;
  - measure bind count / 100 KB SQL text for depth-4 selections.

- **Tier B — retire `PresentWhen`?** 🔴 `PresentWhen` (`rel/child.ts`, the `{ when, orValue? }` arm of
  `Presence`) is the one way a child body states a PRODUCTIVE null. Four producers (`aliasGuard`,
  `oneRowPresence`'s `EXISTS`, `selectedNodeChild`'s `{t,v}` test, coalesce's `orValue`), ~33 readers.
  - **Retire:** Presence becomes `'always' | 'value-nullness' | 'unknown'`; a productive null in a child body
    is absent — one §17 line generalising "A null `by()` value". Deletes the arm, `statedPresence`,
    `orValue`, `HostPresence` and the per-row `EXISTS`/node tests. Cost: a dropped null changes a COUNT.
  - **Keep:** add `presentWhere(pred)` so no producer reports `{when: ALWAYS_PRODUCTIVE}` (the a4c62a20
    regression), then build a binding-presence substrate for the chain-vs-child wrong answers it fixes:
    `project()` drops a productive-null `by()` entry (r4-fu4, rf3-project-null-label, `ProjectStep.java:66`);
    a null Map entry dropped under map/local/flatMap/choose (S9.9); `inject(null,1).map(__.is(P.neq(1)))`
    gives `[]`, chain `[null]` (rf3-static-null-is); a label bound to null in a branch arm —
    `g.V().as('v').union(constant(null).as('k'), constant(0)).select('v').map(__.select('k'))` gives `[]`,
    ref `[null,null]` (`Scoping.java:129-130`; `rerootPresence` is `'value-nullness'`); a re-sourced
    productive-null arm in `choose`; stated-presence `by()` in local/map/optional; `aliasGuard`'s presence
    spelling (F14b). None user-reported.

## 3. Compounding substrate

RelIR substrate, in unlock order (`mise run rel-blockers` ranks the open families):

1. **`once` consumers** — route every re-inliner through `once()` (`rel/build.ts`), semantics-free (no Map
   probe, no `landedOnce`): `storedCompareOnce`/`valueTheta` in `predicate.ts` (nr-once-twins: nr-ru1,
   nr-ru2, r5-fu5 — every correlated `where()`/`has()` comparison); the `is()` chain (rf3-is-chain-size,
   §1b); the modulator's `projectionOf`/`typedOf`; groupCount's `json_each` 15×/row (r6-s9-4), the child
   seam's 3–5× (S9.8), alias operand at `as()` (r5-fu2), `order().by(<may-be-empty>)` emitted twice
   (r6-m-orderby), record-field `{t,v}` round trip (r6-s9-6); the math label-variable fold spelled 3×.
2. **Closed per-row node vocabulary (per-row-node-vocabulary-closed)** — a `{t,v}` node and framing arm for
   every per-row scalar shape (Map.Entry `{t:'entry'}` like `execute.ts` `mapEntry`; element nodes carry
   their id; an unreadable arm raises via `src/rel/raise.ts`). Unblocks `g.V().values('m').unfold()` and
   `format()` over a maybe-Map (per-row-unfold-entry-node).
3. **S3 — a write inside a child or multi-arm body** (local/map/flatMap/union/coalesce/optional/choose/
   repeat/sideEffect/where, onMatch): the `fold().coalesce(unfold(), addV(…))` upsert idiom,
   `g.V().local(__.mergeV([name:'x']))`, corpus `coalesce(E()…, addE(…))`, onMatch `sideEffect(…drop())`
   (r6-m-oncreate); then writes after path/fold/sack and source-union starter-arm writes. With it:
   `g.V().addE('x').to(__.V().sample(1))` declines SHARED_DRAW (nr-fu-addE-draw).
4. **Alias channels through `childSeam` (G)** — carry label scope into nested arms (aliases family, 10 open).
5. **One table per row-changing reference strategy (H)** in `ir/`, citing vendor lines (the `bulk.ts`
   pattern); never for one that only changes execution order.
6. **Map shape** (9 open) — map-valued `g.union(select('map'),…)` source, seeded `fold([:], addAll)`, merge
   map operand, T-token key.
7. **List members** — `fold().as('m').mergeV(select('m').limit(local,1).unfold())`; `is(P)`/`order()` in a
   correlated list-member body (a bind-budget call); `order`/`range(local)` over list-of-maps, PROPERTY and
   MIXED lists; `select()` in a list-host body.
8. **Fan-out** — per-origin scalar order (`project().by(values(k).order().fold())`), reductions without
   fold, scalar-host group reducer, `tail`, child-label escape, `map` first-result window.
9. **Branch / slice** (10 open) — MAP/RECORD/PATH/PROPERTY variant arm, batched `choose`, alias through a
   collapsed arm, nested branch in a sliced arm.
10. **`repeat()` residue** — an unbounded body whose UNION is not the top node (join-union distribution),
    the UNORDERED bulked slice, the unroll's deny-list gate, `times($x)` → walk.

Beside the RelIR substrate:

- **Value carriage.** Keep exact scalar types through JSON-backed collections, member variants, maps,
  aliases, paths and format adapters. Concretely: carry the child reducer's type (`produced.vtype`) and
  productivity so `by(sum/mean/…)` works in `project`/`aggregate`/`store`/`where`, not only `group`.
- **Value barriers carry the traverser's channels.** `split()`/regex/`lowerValueResume` re-root the
  stream, so a label/path/sack bound before them declines. Then SPIKE exact big-number predicates
  (REAL-band prefilter + JS BigInt compare) — deferred by Dan.
- **Exact decimal arithmetic.** `values('p').sum()` over `1.5m` and `2` defers (decimal-TEXT values
  can't go through SQL `sum`); `fold(seed, Operator.x)` declines classes outside int/long/double.
- **Path as a value.** `path().order()`, `path().group()` (needs a `{t:'path'}` arm in
  `frameTypedNode`/`listNodeExpr`), `path().fold().unfold()`.
- **Per-origin slice in a batched `union`/`choose` arm or bounded-`repeat` body** under an outer
  per-origin scope — thread the arm-minted origin through `mintTraverserMajor` (`lower/branch.ts`).

## 4. Sensible queries we decline

- **Writes — top candidate: TinkerPop's batch-upsert idiom (R8-res).** Neither
  `g.inject([[name:'x'],…]).unfold().mergeV()` nor
  `g.inject([[lookup:[…], create:[…]],…]).unfold().mergeV(__.select('lookup')).option(Merge.onCreate, __.select('create'))`
  lowers ("no lowering covers": an `unfold()`ed list is not Map-framed). The un-unfolded spelling
  (`inject([lookup:…, create:…]).mergeV(__.select('lookup'))`) and record-framed
  `project('name').by('name').mergeV()` decline with the own-entry reason (`MapScopeDeferral`
  `'merge-own-entry'`) until `mergeFromTraversal` takes record and `inject(map)` drivers. Nearest seam:
  `parseComputedMergeArg`'s per-driver map decomposition (`src/compiler/ir/write-args.ts`). Build
  nr-fu-onmatch-scope (§1) first. Beside it: an explicit whole-arg map over a Map driver
  (`inject([a:1]).mergeV([name:'q'])`, or a side-effect `select(k)` no Map holds) is a mere multiplier
  `mergedFromMap` does not route yet.
- **A Map driver holding a TOKEN key (`T.label`, `Direction`) (nr-fu-token-keys)** — `literalKeyFacts`
  (`rel/framing.ts`) gives up on a non-string key, so `mapSearchedKeys` is null (the one-at-a-time guard
  refuses any onMatch/`property()` write) and `mayHold` is always true (a side-effect `select(k)` arm
  declines `merge-map-scope`). Hits the usual labelled upsert
  `inject([(T.label):'person',name:'marko'],…).mergeV().option(onMatch,[seen:true])` and every
  endpoint-bearing `mergeE` map. Record the STRING keys beside the token keys (a string `select(k)` never
  hits a token key, `Scoping.java:119-121`).
- **`singleSource` and the addV(T.id) one-row admission as `rowBounds` questions (nr-ru5)** — lifts
  `g.V(1).addV().property(T.id,99)` (`write.ts` → `src/rel/bounds.ts`); the source addV id-collision guard
  must then cover the mid-chain path. `writeSnapshot` stays Values-only.
- **`g.inject(1,2,3).as('i').addV('person').property('age', __.select('i'))` (inject-label-addV).**
- **Merge residue.** Explicit list/set cardinality on a runtime merge arm; map-driver merge holding
  `T.id`, a list-valued map (e.g. from `valueMap()`) or a multi-label map; map-driver `mergeE` with
  `option(Merge.outV/inV)` or an onCreate endpoint; `mergeE` over an incoming vertex stream
  (`elementMergeE`); edge runtime arm value `option(onMatch,[k:__.trav])`; the local-slice corpus form
  `mergeV(__.select("m").limit(local,1).unfold())` (could move L3). PartitionStrategy-aware upsert (×7 L3).
- **`math()` over a Map's OWN keys (cr-fu10, B1)** — `g.V().has('name','marko').values('m').math('k + a')`
  declines (trunk answered `[3]`); keep the map-entry read when no outer scope names the variable
  (`Scoping.java:119-135`).
- **Side-effect constant reads in a `by()`/child seam (cr-fu12, B2)** — `project/group/order().by(__.select('k'))`,
  `sideEffect(__.select('k'))`, a null constant under `map`/`where` decline though the chain answers; route
  the by()/project seam to `sideEffectSelectChild`, add L4 coverage.
- **An explicit federate `traversal` referencing an outer user parameter (rf3-fed-explicit-params)** —
  "Unbound parameter"; forward `boundParams` in both forms (`src/services/catalog/federate.ts`).
- **Labels and scope** — `where().by()` under repeat labels/wrappers/`P.within`/bodies, incl.
  `not(where…by)` (r2-gap-wb); repeat `until`/`emit` and shortestPath see no aliases —
  `g.V().as('a').repeat(out()).until(where(eq('a')))` (r2-gap-F6); alias-where under within/between/TextP
  (r5-fu8).
- **Source union** (corpus) — nested union first step, mixed arms, withSideEffect/withSack,
  `union(constant('x')).path()`, steps after it; `opensOffStarter` and `unionArms` disagree (r1101-fu4).
- **Path / property streams** (corpus) — `dedup()` before `path().from()` (o-subpath); `id`/`label`/
  `valueMap` positions and mixed `path().unfold()` (o-pathvals); `where(<body>)` over a property host,
  meta-properties (o-propstream).
- **Values** (corpus) — set ops lose member types (o-setop-types); `order(local)` keeps the `set` marker
  (o-set-framing); global `order()` over element lists (o-order-elemlist); local split (o-split); sack merge
  seed and `normSack` (o-sack); inject list/set residue `g.inject({1,1})` (r6-fu2-r).
- **Depth gaps** — Column/multi-key select inside arms (`path().select(Column.keys)`); `values('m')
  .select(k)` over a Map-capable scalar; federate tails beyond values/count/order;
  `project().by()` after an `emit().repeat(…simplePath())` walk.
- **Families** (rank by `rel-blockers`) — scalar-transform tail, body-keyed `choose`
  (`choose(values('name')).option(is('marko'),…)`), Column/path row ops, `Pop.all/mixed`, side effects
  (`group('m').by().by(__.in().values())`), local/match/where; the single-missing-caller list.
- **`match()` residue.** A binding `or` branch; `map(<mean>)` body; `fold()` end;
  ProductiveByStrategy null-keeping; `where('a',P)` over scalar aliases / non-eq ops; per-origin slice
  in a pattern body; `match` over a map stream (`g.V().valueMap().match(as('a').select('name').as('b'))`);
  `concat(constant(…), select('b').by('name'))` (likely a concat-with-select-child gap).
- **A re-sourced body that reads host traverser state** — `map(__.V().sack())`, `__.V().simplePath()`,
  `__.V().select('<host label>')`, `loops()` under a host. A mid-traversal `V()` splits the host traverser,
  but `rootedRead` computes the body once for every host, so `readsHostState` declines. Needs that state
  correlated into the body (a per-host read). Tests: `test/L4-addendum/resourced-scalar-value.feature`
  `@gap:resourced-host-state`.
- **A random draw in a `V()`/`E()` body shared by many hosts** — `map(__.V().sample(1))`,
  `project('x').by(__.V().sample(1))`, `where(__.V().sample(1)…)` decline (`SHARED_DRAW`): the body is an
  UNCORRELATED scalar SQLite evaluates once, so every host would share one draw, while the reference draws per
  traverser. `local(__.V()…sample(1))` and a one-row host answer. Draw-INDEPENDENT bodies
  (`project().by(__.V().sample(1).count())`, `local(__.V().sample(1).count())`) decline too, though a shared
  draw would be right for them. Needs the scalar seam to take its value off `reSourcedOnce`'s per-origin draw
  (a per-host row the value correlates to) — the rows path (`property`, `local`, `flatMap`) already draws
  per origin.
- **`where(without('x'))` after `aggregate('x')`** — lower as `NOT IN (SELECT … FROM <collection>)`.
- **`choose()` with mixed list-shaped arms** — `choose(hasLabel('person'), out().fold(), values('name').fold())`.
- **`group().by(k).by(out().limit(1).fold())`** — a per-key `ROW_NUMBER` window.
- **Keyed-label seeded merge** — `withSideEffect("a", <map>).group("a")…` (per-key `GroupBiOperator`;
  `collection.ts` `registerGrouping`).
- **Bare-list `[1L]`/`[1.0f]` literal** declines at `listLiteralBlob`.
- **`filter(__.identity())`** — the one lattice gap L5 names.
- **A MAP stream's child bodies beyond `select(k)`** — `inject([x:1]).map(__.count(local))`,
  `valueMap().project('c').by(__.count(local))`, `withSideEffect('k',[x:1]).V().values('n').select('k')
  .map(__.count(local))` (`mapHostChild` reads only `select(k)`). Tests:
  `test/L4-addendum/per-row-collection-readers.feature` (the `@Unsupported` side-effect form).
- **`property(T.label)` on an existing element** (label append) — genuine future work; see debt for `T.id`.

## 5. Product capabilities

- **Strategies** (`src/compiler/ir/strategies.ts`) — the largest L3 clusters:
  `SubgraphStrategy(edges: __.or(…))`, `SubgraphStrategy(vertexProperties:)`, `includeMetaProperties`,
  ProductiveByStrategy on a non-standard host. No rule yet wraps a criterion around a mutation.
- **Step vocabulary (matrix-fill).** `tree`, `subgraph('sg')`, `withSack(seed, Operator)`,
  `mean/sum(Scope.local)` over a value list, string steps inside `repeat`, null carriage under `path()`,
  mutation-guard outcomes (`ReadOnlyStrategy` — reject as the reference does). Sizes in L3 telemetry.
- **Federate.** Run independent sibling RPCs concurrently (federate and `io()`); arms at mid-position or
  inside a nested prefix; Phase 2b cross-graph identity (`group().by(id)`, `has(T.id, <cross-graph>)`);
  Phase 3b post-merge reads (`hasLabel`/`has(key)`, live `out`/`in`, bound+base element-read mix);
  side-effect-boundary widening (low). Design: [pushdown](./archive/2026-08-26-federate-pushdown-design.md).
- **Replication.** Thread federate depth to a cross-server peer (a `federationDepth` request field);
  native whole-DB snapshot incl. tombstones (an `io()` round-trip can resurrect deletes); shared-target
  before-image journal (when shared-target replication is real); dissolve the composite `(graph,id)`
  into a global `gid` rejoin.
- **Graph algorithms (GDS).** Cheap params (`maxIterations`, `tolerance`, `consecutiveIds`,
  `useWassermanFaust`, `maxDegree`); `nodeSimilarity` `topK`/`similarityCutoff`/`degreeCutoff`;
  `sourceNodes`, `seedProperty`; weighted betweenness/LPA; `scaler`; then iterative ones
  (`labelPropagation`, `eigenvector`, `louvain`).
- **`io()`.** Measure a full-size round trip against the 5-min CPU budget; a `g.io(...).with(...)` option
  to select the replace policy; perf: skip endpoint lookups under `idPolicy:'preserve'`, parse each line once.
- **Operations.** Real Cloudflare deployment, authentication, transaction/session semantics, GraphSON
  responses, a `PRAGMA optimize` schedule (after bulk load / on alarm, never per request).
- **Browser.** Wire `navigator.storage.estimate()`; exactly-once writes (idempotency keys).

## 6. Internal debt

- **Identity-reprojection idiom ~43×** in `src/compiler/rel/**`, `src/rel/**` — add an override-aware
  `carriedExprs(channels, sourceId, overrides?)` and a `from` on `withPayload`; migrate.
- **`OwnerSeek` DISTINCT tail ×3** in `src/rel/passes/semijoin.ts` — extract `distinctOwners`.
- **The merge search's seeks are hand-built in `write.ts`** (`seekedSearch`, `propertySeeks`,
  `decimalTextSeeks`, `endpointSeek`, `cappedCount`'s per-driver choice). Their generic home is a
  CORRELATED-join `OwnerSeek` in `src/rel/passes/semijoin.ts` — a seek per outer row chosen over the
  finished algebra — so any per-row property search (not only a merge's) gets the most-selective-key and
  decimal-TEXT-prefix access paths. Move them there once `semijoin.ts` seeks under a correlated join. The
  same multi-key `OwnerSeek` was r6-fu6/S10-r's fix for a 19× two-pool merge guard (verify: the two-pool
  grid now measures linear below).
- **The map merge guard's key-set containment** (`searchKeying`, `write.ts`) crosses each earlier map with
  every PRESENT key set it contains — linear for any batch of a few key sets, but a batch that is itself
  a power set of k keys is 3^k pairs over 2^k maps (N^1.58). Finding the containment is a set-containment
  join over the DISTINCT key sets: each probes the strictly LONGER key sets holding its rarest key, so data
  key NAMES whose every key many longer key sets share cost N × those holders (all inside the guard's one
  statement, never a bind). Measure before touching; no real batch seen. The pool / k-subset family is
  measured LINEAR (`test/compiler/merge-scale.exec.test.ts`): the two-pool grid `[a{i%s}:1,b{i/s}:1]`
  128 ms → 863 ms from 1k to 8k maps, 30-entry maps 1k → 8k at 8.2×, and one map's width no longer
  matters (`mapDrivers` picks its driving entry once per driver: 1000 entries 107 ms, was 1.9 s).
- **Map-key scope has two dispatchers (mapKeyScope, nr-fu-b4-one-authority)** — one `mapKeyScope(key,
  facts, ctx, live)` beside `mapKeyCollision` for `mapTail` (`rel/lower.ts`) and `mapHostChild`
  (`lower/reduction.ts`); then route `resolveMergeArg`'s collision sentence through `mapKeyCollision`.
  First: where a Map's keys are UNKNOWN (`valueMap()`, `group()`), the B4 message advises "rename the label"
  forever — say the keys are not known at compile time (nr-fu-b4-unknown-keys).
- **Six PROPERTY_TABLE insert builders in `rel/write.ts` (propertyRowsInsert)** — one builder,
  byte-identical SQL (absorbs nr-fu-mapentry-props' `json_extract` helper).
- **Four copied blocks in `write.ts`** (carrier reproject, merged-create spread, alias-carry, nested-spec decline).
- **One `deferred(ctx, () => …)`** for the four narrowed catches in `rel/lower.ts`/`rel/write.ts`.
- **`idQueryOf` re-derives `idMembership` (rf3-idquery-dup)** — `routable`/`listAmongSeveral`
  (`lower/filter.ts`) already drift; classify the predicate only. Fix the refuted "`V(1,[2,3]) ≡ V(1,2,3)`"
  doc (`GraphTraversalTest.java:146-147`).
- **~10 hand-rolled `json_each` membership subqueries (rf3-reuse2)** — one `jsonMembers(values)`; three use
  bare `JSON.stringify` on user strings (`olap/kernel.ts`, `olap/pagerank.ts`, `manager.ts`), so a
  lone-surrogate label matches nothing.
- **Five column walkers (rf3-reuse4)** — fold `semijoin.ts` `retarget` and `write.ts` `reScope` into `walk.ts`
  `substRelId`; one `colsRead(e, rel)` for fuse/prune/semijoin/walk.
- **`olap/pagerank.ts` routes seeds by `rows.length` (rf3-reuse5)** — route by the call's form.
- **A scalar side-effect constant decoded per reference (cr-fu3)** — spell it with `constLit` at the child
  seam; `where(__.select('k').is(5))` emits a ~1 KB CASE tower.
- **`group()`'s `mayYieldNull` (cr-reuse4)** — derive from `producedMemberNode`'s member gate, dropping the
  null-first sort term for fold/list/map/element bodies.
- **`firstInChainsDeep`/`someNode(value, pred)` (cr-reuse5)** for `uncarriedLiteral`/`uncomparableLiteral`/`holdsNaN`.
- **One owned one-row relation builder (nr-ru3)** — move `lower.ts` `oneRow` to `build.ts`, add
  `rowOf(cells, names, fresh)` for `once()`; deletes five `VALUES(1)` units (r1-reuse4, r6-reuse5).
- **Smaller consolidations** — `firstPerPartition` for five `row_number` hand-rolls (r1-reuse2); drop the
  always-true `prn > 0` (r1-reuse3); `choose()` conditions via `childPredicate` (r2-reuse1);
  `VALUE_ARGUMENT_STEPS` from the move tables (r2-reuse8); `rowBounds` over `collapsedToOneRow`
  (r3-reuse5); every self-contained fence through `build.ts` `fenced`, ~10 sites (r6-reuse3, r7-reuse1).
- **Four spellings of the per-traverser filter-host set (cr-fu15)** — `ONCE_FILTER_HOSTS`,
  `COLLAPSE_FILTERS`, `SHAPE_PRESERVING`, `EXISTENCE_FILTER_HOSTS`: one authority or a comment why; also
  ≈10 hand-rolled `V||E` re-source tests.
- **Path-position `by()` dispatch built twice** (`src/compiler/rel/path.ts`) — extracting
  `pathPositionProjection` also fixes a mid-path value/list/map position read as a vertex.
- **`writeInputChannels`** (`write.ts`) keeps only `encounter|alias`, dropping `sack`/`path` for writes after them.
- **`property(T.id)` on an existing element** raises a clearable `Deferral` (`write-args.ts`); make it a permanent `Error`.
- **Two framing→`{t,v}` encoders** (`producedMemberNode`, `fieldNode`) — edit in lockstep; merging is architectural.
- **`ContentDemand.keys` is unconsumed** (`ir/content-demand.ts`) and `literalKeysOf` takes a 3-arg `has`'s
  label as its key — delete it.
- **Decline messages** — ~25 self-explaining declines carry kind `'uncovered'`: rename the default
  `'unsupported'` and migrate the remaining lowering throws (`channels.ts`, `sql/kernel/q.ts`) to the sink
  (nr-fu-s0-default-kind); `UNCOMPARABLE_LITERAL` names the step and suggests the intent, asserted by the
  two `@Unsupported` pins in `merge-oncreate-overrides-runtime-map.feature`, and `validateNoOverrides`
  stringifies every JS Map as `"{}"` — do not grow the peephole (cr-fu13, D).
- **`once` naming** — rename `rel/build.ts` `once` to `heldOnce`/`evaluateOnce` (`refs.ts once` resolves to
  `emit.ts`'s locals); pin the math chain's exponential→linear win
  (`g.V().values('age').as('a').math('a+1').as('b').math('a+b').as('c').math('a+b+c')` → `[118,110,130,142]`
  at ~15 KB).
- **`barrierIn` mislabels a federate call in an arm as `'source'` (rf3-callsite-form)** (`rel/segment.ts`).
- **Pins and tests** — `test/cf-constructs.test.ts` binds fixed port 8977 (rf3-ci-port);
  `one-row-one-traverser.exec.test.ts` times out at 5 s under the parallel run (nr-fu-ci-flake); replace the
  vacuous "hasId after a hop adds no scan" pin with the uncorrelated `IN (SELECT id …)` shape (rf3-pins);
  stale L4 expectations (o-l4-sweep).
- **cr-fu8 (C2)** — stale `dedupBy`/`keptDedup` comments (`lower/slice.ts`); `productivityFilter(step, key,
  key.raw ?? key.value)` → `key.value` (r3-fu4); pin `compilerNull()` and the `aliasGuard` witnesses; fix
  `group-value-null-member.feature`'s ProductiveByStrategy scenario to `order().by(label).by('name')`.
- **Single items** — trace the `valueMap` sql-hygiene raise 75→82 (r4-fu6); `perRowCollectionStep`
  re-parses JSON per row (r7-m); `rowBounds` too wide over `rn=1`/HAVING (r6-m-s8); CF federation drops
  param types (r6-m-federate-types, verify); derive `declaredTypeOf` from `valueNodeOf` (r5-fu6); pin the
  `withSideEffect` number class (R15); make `rankedFirst`'s key total (F8); `refReads` stops at a Ref (F11);
  one JS→JSON encoder for a literal list (r7-fu10); `byNode` nests its CASE (o-plansize);
  `properties().drop()` via `removeRows` (r4-fu8c); `effectScope` snapshots leak into later statements'
  WITH (r4-fu8d, verify).
- **Docs** — the C3 §17 line (name `not()`, the `order()` route, the seats it covers, and that the concat
  raise is not Java's); the r7-m §17 lines for NUL and surrogates.
- **Stale comments**: `src/services/catalog/olap/shortest-path.ts` header (old recursive-CTE walk);
  `src/compiler/ir/strategies.ts` ~539 (stream/mutate/stats modes).
- Keep the `antlr4ng` patch until upstreamed; regenerate and diff `parser/` on a TinkerPop bump.

## 7. Low priority

- **Contrived shapes — build only on a user report.** Real gaps in shapes nobody has been seen to write;
  if one is reported, build the generic fix.
  - `inject([a:3],[a:null]).unfold().group().by(keys).by(select(values).fold())` gives `{a:[null]}`, ref
    `{a:[3,null]}` (r7-fu4).
  - A bare `Error: malformed JSON` from `where(__.select('k').toUpper().is('AB'))` over a string label bound
    in nested `choose` arms (rf3-where-armlabel-json, `lower/filter.ts`).
  - A `project()` key equal to a live label declines —
    `g.V().as('name').project('name','age').by('name').by('age').select('name')`; a lift returns the ENTRY
    (cr-fu11, `Scoping.java:119-121`).
  - Wide longs: `sum/min/mean` drop a wide constant over a varying stream, and a top-level sum past 2^53
    rounds — `local(union(constant(9007199254740993L), values('age')).sum())`.
- **Bulk journal clear in bounded chunks** — `clearBulkJournal` (`src/storage.ts`) is one DELETE.
- **Nested scalar `reverse()`/`split()`** inside a child body.
- **Federated `order`/`dedup(local)` over landed-foreign elements** — re-source keys via `BoundGraph`.
- **Agent memory Phase-0 spike** — brute-force cosine over in-DO vectors at realistic sizes
  ([vision](./2026-07-17-agent-memory-vision.md)); the rest belongs in a sibling repo.

## Won't do (do not reopen)

- **Java-execution emulation** — merge order, raise extent, write interleave, signed zero, UTF-16,
  `java.util.regex`, Java number spelling, Float32, out-of-range Double carriers. Matrix §17.
- **Per-traverser write interleave** — writes see a snapshot of their input; don't rebuild the guards.
- **Recursion barrier-in-term / unbounded-`repeat` per-origin slice** — algebraically impossible.
- **Global `tail`/`sample` with no `encounter`** — the decline is correct.
- **Per-origin window inside a `union`/`choose` arm** — the window is global in the reference
  (`vendor/tinkerpop/gremlin-core/.../step/branch/BranchStep.java`); current answer is right.
- **Moving `FromItem` construction into `src/rel/block.ts`** — would break the predict/construct split.
- **Map-literal `[k:__.trav]` as a merge argument.**
- **Heterogeneous-layout branch arms / per-traverser coalesce/optional arm slices** — decline
  (`test/L4-addendum/branch-arm-decline.feature`).
- **Writes past a slice the reference stops pulling at** — beyond `EarlyLimitStrategy`'s crossings these
  decline (`test/L4-addendum/early-limit-side-effect.feature`).
