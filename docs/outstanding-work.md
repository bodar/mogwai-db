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

**Landed in the 2026-11-03 round** (detail in git; each item's residue is filed below). L3 1890 → 1994:
the L3 accounting ledger + derived GLV-lossy exclusion (faecb6f2: every in-scope failure is in
`test/L3-conformance/expected-outcomes.ts` with a kind and a checked citation; a fix deletes its names
there); edge Property framing (781a352c); mid-traversal `inject(xs)` (90518dfa); list-host member order in
a `by()` body (d4e3312f); reducer-headed child body (202bdbce); `null` id members (9ec195ad); statically
decidable steps — stray repeat modulators, `times(n<=0)`, `identity()`/`discard()` filters, effect-free
`sideEffect()` (f5b66932); filter-led predicate body + per-row label/id key probe (7915c526);
`is(typeOf(T))` over known framings + MAP retype (7b3d623a); Binary values (e4b29d47);
`V(<traversal>)`/`E(<traversal>)` (89ed8a0d); `call(service, map, traversal)` param merge in
the reference's order, static map < traversal map < `with()` (874c5570: the one merger `parseCallSpec`,
`src/services/params/call-params.ts`, over the existing constant folder; L3 → 1965, remains: nothing); T/`Direction` tokens order on the String rung by name, the Java class-name emulation deleted (5cb607a7: `kindOf` in `src/compiler/rel/orderability.ts` shares `cmpNatural` with String, so the JS and SQL key orders agree; defect l3-t-token-order, L3 → 1967, remains: nothing); `sum/mean/min/max/order/dedup(Scope.local)` over a value that may not be a collection (f1639e8a: a non-collection row is a one-member list handed to the list route's own per-row reducer via `oneMemberList`/`scalarListMember` in `src/compiler/rel/list.ts`, a Map row reads its entry set via `mapEntriesLocal` in `src/compiler/rel/map.ts`; ledger local-scope-scalar, L3 → 1973, remains: nothing); `merge()` over an incoming Map (6770c173: a per-row putAll — `mapPutAll` in `src/compiler/rel/map.ts` runs the `putAll` key rule factored out of `mapsMerged`, argument wins a shared key, wired by `mapMerge` in `src/compiler/rel/lower.ts`; defect l3-map-merge, L3 → 1976, remains: nothing); bounded `repeat().times(n)` unroll admits `tail`/`skip`/`sample` and the per-traverser hosts `local`/`map`/`flatMap`/`where`/`filter`/`not`/`and`/`or` (33e353dc + 6b7b8fac: the slices join `SIDE_EFFECT_FREE_BARRIERS` and the hosts `PER_TRAVERSER_HOSTS` in `src/compiler/ir/strategies.ts` — a host child resets per traverser, so nothing carries across iterations; an emit unroll over a random-drawing body declines via `nondeterministic` in `src/compiler/ir/step.ts`; L3 → 1988, remains: nothing); a per-traverser host NESTED inside a child body — an inner `local`/`map`/`flatMap` whose body is one value, plus scalar-route recursion, seeded continuations, gated list values and deep nesting (42beba55 + 5ec1079b + f341d307: `nestedHostChild`/`valueRun` in `src/compiler/rel/lower/reduction.ts`, `flatMapRejoin` under an enclosing origin via `nestRowOrigin`; a mid-run decline is final, never a re-entry; on trunk it also admits the local-emit-repeat witness `g_V_localXemit_repeatXlocalXout_order_byXnameXXX_timesX2X_valuesXnameXX` through the bounded unroll; L3 → 1991, remains: the ProductiveByStrategy form of `group().by(k).by(<list value that may be absent>)` declines — supporting it needs `mapNodePayload` to frame a null list value); `until(loops().is(P))` on an unnamed `repeat()` is a compile-time count, canonicalized to `times(k*)` with k* minimized over k≥0 for until-first and k≥1 for until-last (5d831b68 + d89ec6a7 + 0dc7f3ce: the canonicalization in `src/compiler/ir/strategies.ts`, unrolling only a body that needs phases, under a count ceiling with DO-spelled SQLite limits in `src/storage.ts` and a linear render in `src/sql/kernel/q.ts`; L4 witness `test/L4-addendum/repeat-until-loop-count.feature`; L3 → 1994, remains: nothing). Set ops over a per-row-typed scalar (f47a0fe6, re-landed on the setop-operand-relation prerequisite b15c9897): `values('tags').intersect/difference/combine/disjunct/merge/product/conjoin(…)` re-enter the per-row collection readers (`perRowListFunction` → `perRowCollectionStep`, reader `listFunction`, `src/compiler/rel/lower.ts`) — one fenced WHERE raises the reference text on a null or non-collection row and the List/Set rows run the existing list tail; L4 `test/L4-addendum/per-row-list-functions.feature`; L3 2000 → 2010; remains: the four `g_V_valuesXnameX_{combine,merge,disjunct,product}XV_foldX` declines (o-setop-mixed), the element-host depth limit and the other clean declines, all filed on the **Values** line below.

## 0. Trunk CI is RED (fix first)

- ✅ **LANDED (83be7569→0e13f52b, 2ca3bfb6→d4c248a1, d86bd6b0→0152983f): the Rel tree's depth is bounded along a
  long step chain**, so the unroll's query-text ceiling (`MAX_UNROLLED_STEPS`), not the compiler's stack, is the
  binding limit and `g.V().repeat(__.out().limit(1)).times(1200).count()` answers on every host. Mechanism: the
  root spine of an effect-free program is cut into CTEs every `SPINE_DEPTH_BOUND` levels (`hoist.cut`,
  `src/compiler/rel/lower.ts`; walks iterative in `src/rel/walk.ts`); every SQLite statement-shape limit (the
  FROM-list cap included, `src/storage.ts`) declines clearly; a cut spine is declared before the effects that
  read it. Residue, stated rather than fixed:
  - **Recursion over shape-changing bodies is still unbounded.** `continueAs` over a body like
    `repeat(out().as('x').select('x')).times(n)` is not bounded by the cut. `tooDeep` is the backstop there,
    as before.
  - **Long walk with a later effect stops at SQLite's depth limit.** A long walk followed by a reducing side
    effect hits "Expression tree is too large (max depth 1000)" at around 200 hops, both with and without the
    cut. It is a clean decline.
  - **The spine is evaluated once per step.** A guard step and the result each re-evaluate the plain cut CTEs.
    The uncut plan inlined the spine twice in the same way, so this is not a regression.

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
  9ec195ad copied the null-member rule into `elementScan` a second time (its own `nonEmpty` and
  `CONSTANT.false`) — the extraction deletes both copies.
- **A Map-valued property under `project()` (cr-fu14)** — `g.V().project('n','m').by('name').by(values('m'))
  .select('m')` leaks `TypeError: pairs.flatMap is not a function` (`src/execute.ts`); a `group()` nested in
  `local()` is not reached by ProductiveByStrategy. **Re-check first:** a 2026-11-03 reviewer reports the
  project form now answers (with the `map(values('m'))` crash fix in the typeOf work); drop the first half
  if a FRAMED run confirms it.
- **`dedup()` keeps `[a:1,b:2]` and `[b:2,a:1]` apart** — `g.inject([x:1,y:2],[y:2,x:1]).dedup().count()`
  gives 2; a map's identity should be its entries in any order, read by every dedup/group/set-op site.
- **`barrier(Barrier.normSack)` mis-executes instead of declining** — `withSack(1.0).V().both()
  .barrier(normSack).sack()` gives twelve `1`s; the reference divides each sack by the total.
- **`g.V(1,1)` is one traverser** — the reference gives two (a repeated literal id is a lost row).
- **Untagged whole REAL re-injected by a value barrier frames as an Int** (`lowerValueResume`).
- **Set-op literal operand loses member class** — `combine([1.0d])` reads a whole Double back as an Int.
- **Intermediate `sum` overflow not widened** — a running total that leaves the Long range and returns.
- **`mean()` of a BigInteger** answers a Double (reference: BigDecimal).
- **`path().from(label)` after a mid-chain `inject` keeps the injected row (inject-fresh-traversers)** —
  `g.V(1).as('a').values('age').inject(1).path().from('a')` gives `[[], [v1,29]]`, ref raises "Could not
  locate path from-label: a" (`Path.java:275`); `simplePath().from('a')` likewise. Newly reachable since
  90518dfa (it declined before). Cause: the "this step mints fresh traversers" rule was added as a name
  peephole (`i > 0 && name === 'inject'`) in `labelsBoundBefore` only, not in `unlocatableSubPath`
  (`src/compiler/ir/labels.ts`). Fix by consolidation: one named fact (stream barrier OR a root inject past
  the source) read by both scans and by `injectTail`'s alias reset.
- **`reverse()` over a list-valued property returns it unreversed** — `g.V().values('lst').reverse()` with
  `[1,2,3]` gives `[1,2,3]`, ref `[3,2,1]` (`ReverseStep.java:55-57` reverses an Iterable); also via
  `properties().value()`, `as()/select()`, `coalesce`, `local`. `reverseValue` (`src/compiler/rel/reverse.ts`)
  is identity for every non-String type; trunk before e4b29d47 reversed the JSON text, also wrong. Also: a
  `select('a').reverse()` over a `project().by('lst')` leaks `TypeError node.v.map is not a function`.
- **A Set frames as a List inside a `select()` record and a `group()` value** — over a set-valued `m`,
  `g.V().as('v').values('m').is(typeOf(GType.SET)).as('a').select('v','a')` gives `a:['p','q']` (List), and
  `group().by('name').by(values('m').is(typeOf(SET)).fold())` a List of a List. The record-field and
  group-value framers do not read `ListOf.set`. Pre-existing; `typeof-framing.exec.test.ts` asserts only the
  single-key select.
- **A malformed `g:Binary` in a GraphSON load throws a bare `Error`** (`src/formats/graphson.ts`, the same
  pattern as `g:Duration`), which reaches the user through `io().read()` — raise the named load error.
- **A label bound before a local `order()` is lost (order-local-alias-drop)** — `g.V(1).as('a').values('name')
  .fold().order(Scope.local).select('a')` gives `[]` (probed on trunk 0dc7f3ce), ref `[v[1]]`; likewise
  `elementMap().order(Scope.local).by(Column.keys).select('a')` and `valueMap()…` (whose `.count()` says 1).
  The order(local) value-transform barrier (`src/compiler/rel/order-dedup-local.ts`) re-roots the stream and
  drops the alias channel — the same root as §3 "Value barriers carry the traverser's channels"; a clear
  decline would already beat the lost row.
- **`count(local)` after a `local(…fold())` in a `group()` value answers 1 per key (group-local-count-local)** —
  `g.V().group().by(id).by(__.local(__.out().fold()).count(Scope.local))` gives 1 for every key (probed on
  trunk), ref `{1:3,2:0,3:0,4:2,5:0,6:1}` (value traversal with no barrier reduces by `Operator.assign`,
  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-101`).
- **A Scope.local reader in a `group()` VALUE `by()` over a list-valued property skips the per-row split
  (group-value-local-reader)** — with `l=[3,1,3]`, `group().by('name').by(values('l').max(local))` gives the raw
  list JSON as a String, ref `{a:3}`; `by(values('l').count(local))` gives 1, ref 3. Route the group value-by
  child seam through `perRowCollectionStep` (`src/compiler/rel/lower.ts`) as the chain and other child hosts
  now do (`Grouping.java:92`).
- **`project().by(out().count().fold())` frames the count as Int (project-count-fold-class)** — reported `[3i]`,
  ref `[3L]` (`CountGlobalStep` yields a Long); the top-level `g.V().out().count().fold()` is right. Re-check
  under a FRAMED run before building.
- **L3-ledgered wrong answers** — each is a `defect` in `test/L3-conformance/expected-outcomes.ts`; the
  fix deletes its names there.
  - **`with('multilabel')` frames an edge's own label as a String (l3-multilabel-edge-label)** —
    `E().elementMap()` gives its endpoints' labels as Sets but its own as a String. 1.

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
- **Binary carrier guard, residue (binary-carrier-guard).** LANDED `dce7072b` (2026-11-04): a literal String `within`/`without` set now hoists
  one tag guard off its `IN` list (`hoistedStringSet`, `src/compiler/rel/predicate.ts`) and keeps the
  `vp_key_value(key=?,value=?)` multi-seek, for hex-, UUID- and number-spelled members alike. Left: a set
  MIXING a number-spelled member with another (`within('CA','10')`) keeps the per-member disjunction and so a
  key-only seek (graph-sized, measured 0.086 → 0.855 ms N=1k → 8k; trunk-identical, not a regression). MAJOR
  review follow-up, do this rather than a seekable-prefix residue: `hoistedStringSet` decides the guard by
  REBUILDING each member's `textSpaced`/`stringOnly` Expr and `JSON.stringify`-comparing it to
  `sameSpaceEquality`'s output — a peephole over constructed Exprs, and the `numberSpelling`/`perRow`
  condition is now written twice. On a perRow subject a String equals only a String
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:239-275`),
  so the one per-row String guard `stringOnly` holds for EVERY String member and the hoist covers every String
  set; or have `sameSpaceEquality` return `(raw, guard-kind)` so the set composes guards without re-matching
  JSON. Either deletes the shape recognizer. First confirm no non-String text vtype (e.g. `char`) is meant to
  equal a String. Pin the mixed-set plan (`within('CA','10')`) in `test/plan-stability.test.ts` so the change
  shows; fix `spaces.size > 1 ||same` spacing in `predicateExpr`. Do the `tagExcludes` proposal under "Next
  round" first — it makes the guards byte-equal by construction.
  The carrier-prefix format change (`\u0001`+hex, so ordinary text never spells a carrier) is a persisted
  format change with GraphSON/CSV/`hex()` blast radius and no answer change — only worth it if a measured
  cost of the guard itself remains.
- **The bounded EMIT unroll's statement text is O(n²) in `times(n)` (emit-unroll-frontier) — MAJOR.** Each
  emitted level is its own UNION arm holding k copies of the body, so every prefix is recomputed per arm
  (against "an expression referenced N times is computed ONCE"). With per-traverser hosts admitted a phase is
  ~1.2 KB: `g.V().emit().repeat(__.local(__.out().order().by('name').limit(1))).times(13).count()` is 119 KB
  (over DO's 100 KB; times(12) 101.9 KB), and `emit().repeat(out().order().by('name')).until(loops().is(16))`
  101 KB, k=32 402 KB. Since 0dc7f3ce this is a clean query-text decline (`statement too long` in
  `STATEMENT_SHAPE_LIMIT`, `src/storage.ts`; `MAX_UNROLLED_STEPS` in `src/compiler/ir/strategies.ts`), not a
  raw error — but ordinary depths decline on DO only. Prerequisite (build before more emit-unroll admissions):
  a per-level FRONTIER relation computed once — a MATERIALIZED CTE per level that level k+1 extends, or the
  RelIR tree-Plan promotion. It also lets every emitted level share ONE random draw, which retires the
  emit-over-`sample()`/`shuffle` decline in `tryUnroll` (`RepeatStep.java:334-353`). Related DO-only wall:
  each unrolled `order().by().limit()` phase nests ~18 levels of SQLite expression depth; if DO's cap is 100,
  `repeat(out().order().by('k').limit(5)).times(6)` declines on DO only, and `CfLimitedSql`
  (`src/cf-limits.ts`) checks bytes and binds but not depth — teach it depth so CI sees the wall.
- **`fold().as('x').select('x').unfold()` is quadratic in the folded list (fold-label-history-copy)** —
  `g.V().values('name').fold().as('x').select('x').unfold().count()` 30.7 ms → 1595.8 ms N=1k → 8k (52×;
  a map-valued `values('m')` 67×), on trunk before this round too. The label-history column
  `a0 = jsonb_array(jsonb_object('k',3,'v',json(fd8.list)))` is projected onto every exploded member row,
  copying the whole list N times (`src/compiler/rel/list.ts`). Drop the history entry through the explode
  when nothing downstream reads it, or reference the folded row by key instead of copying the blob.

## 2. Needs a human call

- **Numeric STRING ids (string-id-coercion).** 🔴 Verbatim: "Should a numeric string id like '1' address
  the element whose rowid is 1, as TinkerGraph's LONG id manager does? Or are ids typed, so that '1' names
  only a uid '1'? In the typed case these 8 scenarios are recorded as an expected outcome with a §17 line."
  Context: the 8 L3 scenarios assume TinkerGraph's LONG id manager; today ids are typed (the §17 "String vs
  integer element id" row; `V(5)` and `V('5')` coexist). Not built; no branch. Either answer is one change:
  coercion at `routedExternalId`/`externalIdIs` (`src/compiler/rel/source.ts`), or ledger the 8 as
  `divergence`s. rf3-reuse1 (§1) is the one hole in "both may exist" — fix it under either answer.

- **Map-key order: SQL `storedCompareOn` vs the JS orderability barrier (map-key-order-authority).** 🔴
  Verbatim (local-scope-over-scalar, f1639e8a): "Decision for you: the SQL map-key sort uses storage order
  (`storedCompareOn`), while a top-level map's order(local) still goes through the JS orderability barrier.
  They agree for keys of a single type. They could differ for a map whose keys mix booleans or dates with
  numbers. I did not add a §17 line for this." Context: a reviewer found them agreeing on every plausible key
  mix probed. The "mapEntriesLocal takes the barrier's Map arm" proposal under "Next round" removes the
  question by making SQL the one authority (plus one §17 line for mixed-type keys) — answer yes/no to that.

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
   (r6-m-orderby), record-field `{t,v}` round trip (r6-s9-6); the math label-variable fold spelled 3×;
   `correlatedReduce`'s v/vtype pair recomputes the whole aggregate twice per row — now on the common
   `values('age').local(sum())` route too (~6× per-row overhead, linear; `lower/reduction.ts`); the
   per-row `typeOf` CASE inlines the inferred-vtype `coalesce(vtype, nullif(…typeof(v)…))` twice
   (`predicate.ts`); `collectionMembersOrSelf` (`list.ts`, 5d500199) — `g.V().V(__.values('ref')).count()`
   over a plain String key went 919 → 2499 B and 12.0 → 19.3 ms at 8k: the member value expression is
   inlined 4×, vtype 2×, the `vtype IN (list,set)` flag ~10× (project them once behind a fence, as
   `V(__.out().id())`'s `LIMIT -1 OFFSET 0` does), and `positionedMembers` adds a full-stream
   `row_number()` even under `count()` (skip it when nothing reads the order); **`producedOnlyWhere` (the
   nested-host presence gate, `lower/reduction.ts`) — MAJOR, common reach** — inlines the handed value's
   correlated subquery twice (`CASE WHEN (<value>) IS NOT NULL` and again in the body:
   `project('x').by(values('name').local(fold()))` reads `name` twice, 10 SELECTs; the un-nested
   `by(values('name').toUpper())` once; sql-hygiene's `respelled` misses it — different EXPLAIN parents). It is
   also a near-copy of the presence authority in `src/compiler/rel/child.ts` (`hostPresence`/`gatedByHost`/
   `caseWhen`/`presenceDischarged`): gate through `gatedByHost`, lower the rest over `presenceDischarged(host)`
   with the value projected once.
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
   fold, scalar-host group reducer, `tail`, child-label escape, `map` first-result window. A per-traverser
   host NESTED in a child body now composes (`nestedHostChild`/`valueRun` for a one-value body,
   `flatMapRejoin` under an enclosing origin with `nestRowOrigin` for a per-origin window — L4
   `nested-local.feature`); its residue: a per-origin GROUPING barrier inside a nested fan-out body
   (`local(__.both().local(__.both().fold().unfold()))` — `GROUP BY` names one origin and the enclosing one
   has no group policy to ride it as a passenger), and a path-hiding `flatMap` under an enclosing origin
   (`local(__.out().flatMap(__.out())).path()`). Also: `flatMapRejoin` mints an outer `row_number() OVER ()`
   origin nothing reads (`local(__.out().local(__.count()))`; inherited from any fan-out local body) — skip it
   when no barrier in the body needs an origin; `nestedHostChild` should cite
   `vendor/tinkerpop/gremlin-core/.../step/map/TraversalMapStep.java` `processNextStart`. A reducer arm of a BATCHED `union` over the one-row self (`local(__.union(__.count()))`, L3
   `g_VX1_2X_localXunionXcountXX`) is the union-residue. min/max over a SCALAR host's self seed
   (`values('age').local(max())`) declines: the correlated argmax re-inlines an outer column in its
   ORDER BY, which SQLite cannot resolve (`valueColIsDetached`).
9. **Branch / slice** (10 open) — MAP/RECORD/PATH/PROPERTY variant arm, batched `choose`, alias through a
   collapsed arm, nested branch in a sliced arm.
10. **`repeat()` residue** — an unbounded body whose UNION is not the top node (join-union distribution),
    the UNORDERED bulked slice, `times($x)` → walk; the emit-unroll frontier (§1b emit-unroll-frontier).
    **✅ LANDED (0451a9d1) — the counted-until regime is chosen by what the walk refuses (until-regime-authority).**
    `needsPhases` (`src/compiler/ir/strategies.ts`) now asks: a top-level call/unrollable barrier, OR a
    fan-out host (`FAN_OUT_HOSTS`, `src/compiler/ir/step.ts`) whose child holds a stream barrier at ANY depth
    (`someStepDeep`) — the shapes the recursive term refuses (`BARRIER_IN_TERM`). The unroll's host set is
    derived (`PER_TRAVERSER_RESET_HOSTS`). Scaling linear (≤7.4× at 1k→8k). What remains: nothing.

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
  A Cardinality wrapper inside a driver map — `g.inject([name:'x', age:Cardinality.single(1)]).mergeV()`,
  the `mergeE` twin, bare `inject([k: single(1)])` — declines (correctly, writes nothing): the map-literal
  blob (`mapLiteralBlob`/`valueNodeOf`) and the merge driver must carry and unwrap a `{cardinality, value,
  type}` value (`MergeVertexStep.java` unwraps `CardinalityValueTraversal`); three `@Unsupported` scenarios
  in `test/L4-addendum/binary-values.feature` fail loudly when it lands. Likewise `mergeE`/`E().property`
  with a `Cardinality.single(…)` map value, and wrapper writes inside `union`/`sideEffect`/`local` (S3).
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
- **Values** (corpus) — set ops lose member types (o-setop-types); global `order()` over element lists (o-order-elemlist); local split (o-split); sack merge
  seed and `normSack` (o-sack); inject list/set residue `g.inject({1,1})` (r6-fu2-r); `combine`/`merge`/`disjunct`/`product`
  between a scalar-membered list and an ELEMENT-list operand (`values('tags').combine(V().fold())`, and the
  four `g_V_valuesXnameX_{combine,merge,disjunct,product}XV_foldX` scenarios, whose name rows would raise)
  need a mixed scalar/element member encoding in `listSetOp` (o-setop-mixed) — the decline is the query
  text's (a stored list never holds an element), and the reference's per-row raise is unreachable until a
  list row can frame both kinds. A per-row-typed scalar's list functions (`perRowListFunction`) answer
  inside a SCALAR-host body (`values('tags').order().by(intersect(['a']).count(local))`,
  `group().by(conjoin('-'))`, `where(intersect([…]).count(local).is(1))`) but share the per-row collection
  readers' ELEMENT-host depth limit: `V().map(values('tags').intersect(…))`, `order().by(values('tags')…)`,
  `map()`/`optional()`/`choose()` over `values('m').<reader>` decline (`map(values('tags').count(local))` too).
  Its other clean declines: a correlated operand (`__.select('a')…`), `merge()` whose operand is not
  provably a List (a Map row would merge), `merge([y:2])` over a map-valued property, `union` mixing
  different list functions or a constant arm, `filter`/`not(intersect([…]).unfold())`. Separately, any set op with a
  `__.inject(1)` operand declines because `inject` is not lowered as a rooted operand.
- **Depth gaps** — Column/multi-key select inside arms (`path().select(Column.keys)`); `values('m')
  .select(k)` over a Map-capable scalar; federate tails beyond values/count/order;
  `project().by()` after an `emit().repeat(…simplePath())` walk.
- **Depth gaps found by the 2026-11-03 reviews** (all clean `UnsupportedTraversal`, none a wrong answer;
  several decline with the generic "no lowering covers …", which should name the composition):
  - **An element-valued operand in a value comparison** — `has(k, <body yielding the element>)`, i.e.
    `P.eq(traversal)`: L3 `g_V_hasXname_notXidentityXX`. The operand route (`nestedFirstValue`/`scalarChild`)
    takes only scalar-producing bodies.
  - **Edge properties beyond the stream** — `g.E().properties('weight').fold()`, `path()`,
    `aggregate().cap()`, `as().select()`, `project().by(properties())`, `sideEffect()`, union/coalesce/
    choose/optional arms. The `Shape`/node-tag owner discriminant (781a352c) is the seam to frame them.
  - **Mid-chain `inject` past count/fold/limit** — over an element stream: `g.V(1).out().inject(7).path()`,
    `V().as('a').inject(1).select('a')`, `withSack(1).V().inject(5).sack()`, `inject(1).inject(2)`; over a
    collection stream: `values('age').fold().inject([1])`, `project('a').by('age').inject([a:1])`,
    `valueMap().inject([…])`, `out().path().inject(1)` (list+list arms whose `of` differs and computed-map
    arms do not merge in `mergeArms`); after `coalesce`/`sideEffect`/`sum`. `inject` in a child body declines
    with the advisory `inject-in-child` reason by design.
  - **`V(<traversal>)` in more hosts** — `where/filter/not/optional/coalesce/repeat(__.V(__.out().id()))`,
    `group().by(__.V(…))`, any `path()` after a lookup, `withSack(1).V(1).V(__.out()).sack()`; a list-headed
    child (`V().fold().V(__.unfold().id())`, `id().fold().V(__.unfold())`, a list-valued label
    `V(__.select('ids'))`). The ceiling is the flatMap-in-body substrate (§3.8).
  - **The MAP retype as a child or before a barrier** — `project().by(values('m').is(typeOf(MAP))
    .count(local))`, `coalesce`/`optional`/`sideEffect` hosts; after it, `where(count(local)…)`,
    `groupCount()`, `order().by(count(local)|select('a'))`, `aggregate('x').cap('x')`; mixed-element meets
    `union(outE(), out()).is(typeOf(VERTEX))`. A branch mixing a Set arm with a List arm now declines
    (trunk sent the List arm as a Set): a mixed-shape variant has no Set arm.
  - **`discard()` inside a bounded `repeat()` body** — `repeat(out().discard()).times(2)`. (A
    `where`/`filter`/`not`/`and`/`or`/`local`/`map`/`flatMap` host in a bounded body now unrolls —
    `PER_TRAVERSER_HOSTS`, `ir/strategies.ts`; a host whose child reads `loops()` still declines.)
  - **Constant filters in non-filter hosts** — `coalesce(__.discard(), …)`, `map(__.discard())`,
    `fold().discard()`, `valueMap()/elementMap()/path()` + `where(identity())`; `g.V().discard().sum()`
    declines while `values('age').discard().sum()` answers `[]`.
  - **A repeat region with an interior `as()`** — `g.V(1).repeat(out()).as('a').times(2)` and
    `repeat(out()).as('z').emit().times(1)`: `verifyRepeatDefined` accepts it (correctly, as() is
    transparent to TinkerPop's slot rule) but `gatherRepeatRegion` splits at `as()`. Lands with the
    region-grouping proposal under "Next round", as its own item with an L4 witness.
  - **A scalar or element tail after a list-host slice** — `by(__.unfold().tail(1).id())` with no trailing
    fold, `by(__.unfold().limit(1))`, `values('name').tail(1)`, `is(neq(null)).count()`, `groupCount()`,
    `path()`; the edge-bearing `select(Pop.all,'a').by(__.unfold().label().fold())`.
  - **A strict suffix that `producesWithoutInput` misreads by name** —
    `where(__.hasLabel('person').out('created').fold().unfold())` (seeded then re-strictified).
  - **Scalar-host child shapes** — `values('age').local(__.max()|identity().min()|math('_+1').max())`
    (§3.8), `values('age').coalesce(__.sum(), __.constant(0))`; path/VertexProperty/list hosts of
    `local(count())`.
  - **`hasLabel(P)`** — `g.V().hasLabel(within('person','software'))`, `hasLabel(P.eq('person'))`,
    `g.E().hasLabel(within('knows','created'))` decline (probed on trunk) while `hasLabel('person','software')`
    answers; legal TinkerPop 4 grammar. Route a `P` through the existing label predicate.
  - **A filter + `count()` inside a `by()` modulator** — `project('k','m').by('name')
    .by(values('name').is('marko').count())` declines.
  - **A Scope.local reducer under an ELEMENT host** — `g.V().project('t').by(values('m').sum(local))`,
    `map(values('age').max(local))`, `where(values('age').sum(local).is(gt(30)))`,
    `order().by(values('age').max(local))`, `coalesce/optional`, `groupCount().by(values('l').max(local))`;
    also `values('l').union(sum(local), count(local))`, `values('m').order(local).unfold()`,
    `group().by('name').by(values('l').order(local)|dedup(local))`. Totalling a list property per vertex in
    `project()` is a realistic app query. The `docs/feature-support-matrix.md` §9 ✅ row overclaims — mark
    the element-host `by()`/map/where child ❌ (depth gap).
  - **`merge()` hosts and operands** — `project(…).merge([…]).order().by(select('n'))` and
    `…merge(…).project('z').by(select('n'))` (the record becomes a map and `mapTail` has no
    `order().by(select)`/`project().by(select)`); `merge(__.project('a2').by(select('a')))`, `merge(__.select('n'))`
    (should raise not-a-Map); a non-string-key literal `groupCount().by('age').merge([29i:100L])`;
    `project().by(__.elementMap('name').merge([…]))`. Also fix `mapMerge`'s docblock: `merge($param)` is not
    reachable — `Gremlin.g4:711-712` `traversalMethod_merge` takes `genericLiteral` only.
  - **Nested per-traverser host residue** — a leading fan-out host whose result is the first value
    (`project('a').by(__.local(__.out().values('name')))`, `where(__.map(__.out().values('name')).is('lop'))`);
    `by(__.values('age').local(__.math('_*2')))` while `by(__.local(__.out().count()).math('_*2'))` answers;
    min/max after a nested count host (`local(__.out().local(__.out().count()).max())`, sum answers); a filter
    or seeded reducer after one (`local(__.local(__.out().count()).is(0).count())`); `.path()` after a nested
    count host; `local(__.out().map(__.out().limit(1)))` (the flatMap form answers); `aggregate()` after one.
  - **A `call()` map traversal that reads the traverser, inside a child** — `where(__.call(dc, xin,
    __.project('direction').by(values('name'))).is(3))` gives the generic "no lowering covers" instead of
    "call() parameter value traversal must be __.constant(literal)": `servicesNamedBy`
    (`src/services/params/call-params.ts`) swallows the scan's error; catch parse errors only.
  - **A top-level `coin()` in a bounded repeat body** — `g.V(1).repeat(both().coin(0.5)).emit().times(3)`
    gets the generic message; `coin` is not an unrollable body step, so the explanatory random-body decline
    never runs.
  - **Binary in more steps** — `values('blob').asBool()`, `local(fold()).unfold()`,
    `optional(values('blob')).is(typeOf(BINARY))` decline instead of raising by class like `asNumber`.
- **gremlin-lang's `UUID()` random literal** — `g.inject(UUID())` raises "no lowering covers
  g.inject(UUID())". L3's `g_injectXUUIDXXX` is excluded as GLV-lossy (gremlin.js sends a concrete
  `uuid.v4()`), so L3 never sees the random-literal form; any client sending the Gremlin string does.
  Either lower it to a random v4 carrier tagged `uuid` (read the grammar visitor in
  `vendor/tinkerpop/gremlin-language` for when it is evaluated first) or add a §12 matrix line naming it
  unsupported — today the gap is tracked nowhere else.
- **Keyed `choose` with a reducing option arm, then `branch()` (keyed-choose-reducing-arm → branch-step-options).**
  In order:
  1. **keyed-choose-reducing-arm — LANDED (9adf67d7, L3 1994 → 2000), residue only.** Every branch merge asks `reconcileCollapsed`
     (`src/compiler/rel/lower/branch.ts`), and `map()` shares `flatMapRejoin` where `atMostOnePerTraverser`
     (`src/compiler/rel/lower/reduction.ts`, over `ONE_TO_ONE` in `src/compiler/ir/step.ts`) proves at most one
     result per start; L4 `test/L4-addendum/branch-mixed-reducing-arms.feature`. Still declining, each shared
     by `local`/`flatMap` so not a `map` gap: `local()` keyed `count()` arms beside the pass-through (no
     per-start key in the rejoin); a rejoin's list/variant result then a local op, fold/sum/where/select or
     `select(<outer label>)`; repeat bodies; a rejoin under `path()`. `map()` over a FAN-OUT body
     (`g_V_mapXin_hasIdX1XX_limitX2X_valuesXnameX`) needs a per-start "first" and stays declined; the
     `withPath…mapXselectXaX_valuesXnameX_concatXselectXbX…` witness declines on `concat(<traversal>)` itself
     (needs `concat(<traversal>)`, unrelated to this item).
     **Follow-up (pre-existing, also on trunk's `local(choose(p, values('name').fold(), out()…fold()))`):** under
     a rejoin, `routedReduction`'s `EXISTS` probe is emitted over a SECOND copy of the routed input — its own
     `row_number() OVER ()` origin and, keyed, its own option `CASE` — instead of the CTE the arms read. Linear
     (≈4× for 8× rows) and the two numberings agree on one scan, but it is an expression computed twice and
     a correlation between two independently minted origins; find which tree rewrite does not reach the probe's
     subplan (`src/rel/passes/prune.ts` DAG pruning is the first suspect) and make it one relation.
  2. **branch-step-options — unblocked.** `branch(<traversal>).option(…)` on `chooseOptions`,
     parametrized by a match policy (all-matching, `Pick.any`, no implicit default); `choose()` refuses a
     Traversal option key with the reference error. Not started.
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
- **`is(typeOf(LIST|SET))` over a LIST framing** — `fold().is(typeOf(GType.LIST))`,
  `aggregate('x').cap('x').is(typeOf(GType.SET))`, `inject(['t']).is(typeOf(GType.LIST))`. Every other
  framing answers through `typeOfExpr`'s static mode (`framingTypeOf`), but a list framing does not name its
  GType: `cap()` of an undeclared `aggregate`/`store` frames a `BulkSet` (a SET by GType —
  `BulkSet extends AbstractSet`) as a plain list. (The `set` marker itself now rides through labels and
  folded members, and a branch meet no longer merges a Set arm with a List arm.) Needs the list framing to
  carry the collection's GType (List / Set / BulkSet) from every producer; folding off today's marker would answer `cap('x').is(typeOf(LIST))` TRUE. The two
  `…_groupCount` witnesses also need `groupCount()` keyed by a collection value.
- **`where(without('x'))` after `aggregate('x')`** — lower as `NOT IN (SELECT … FROM <collection>)`.
- **`choose()` with mixed list-shaped arms** — `choose(hasLabel('person'), out().fold(), values('name').fold())`.
- **`group().by(k).by(out().limit(1).fold())`** — a per-key `ROW_NUMBER` window.
- **Keyed-label seeded merge** — `withSideEffect("a", <map>).group("a")…` (per-key `GroupBiOperator`;
  `collection.ts` `registerGrouping`).
- **Bare-list `[1L]`/`[1.0f]` literal** declines at `listLiteralBlob`.
- **A MAP stream's child bodies beyond `select(k)`** — `inject([x:1]).map(__.count(local))`,
  `valueMap().project('c').by(__.count(local))`, `withSideEffect('k',[x:1]).V().values('n').select('k')
  .map(__.count(local))` (`mapHostChild` reads only `select(k)`). Tests:
  `test/L4-addendum/per-row-collection-readers.feature` (the `@Unsupported` side-effect form).
- **A `map()` body whose ELEMENT result may be absent** — `V().map(__.out('created'))`,
  `E().map(__.outV().hasLabel('person'))`, `E().map(__.hasLabel('knows').outV())` decline: `scalarChild`
  has no first-result element arm, so a leading filter has nowhere to conjoin either (not a dispatch at
  the predicate seam's position). `flatMap`/`local` answer all three; a predicate body (`where`/`not`/
  `choose`/`until`/strategy criteria) takes a leading filter via `bodyPredicate`, but only over a STRICT suffix (`producesWithoutInput`): a filter-led body whose suffix holds a seeded/supplying step and that the whole-body shapes decline (`where(hasLabel(..).out().groupCount())`) still declines.
- **`property(T.label)` on an existing element** (label append) — genuine future work; see debt for `T.id`.

## 5. Product capabilities

- **Strategies** (`src/compiler/ir/strategies.ts`) — the largest L3 clusters:
  `SubgraphStrategy(vertexProperties:)`, `includeMetaProperties`,
  ProductiveByStrategy on a non-standard host. No rule yet wraps a criterion around a mutation.
- **Step vocabulary (matrix-fill).** `tree`, `subgraph('sg')`, `withSack(seed, Operator)`,
  string steps inside `repeat`, null carriage under `path()`,
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
- **Pins and tests** — `test/cf-constructs.test.ts` binds fixed port 8977 and `test/cloudflare.test.ts`
  8976 (rf3-ci-port; both reddened local `ci` this round when worktrees ran in parallel); the L8 browser
  bracket's `failover.test.ts` "hard-killed leader" went red on CI for 90518dfa (count `4`, expected `3`:
  most likely a write retried across failover and applied twice) and green on the next push — treat it as
  the §5 exactly-once gap (idempotency keys) surfacing, not noise, until shown otherwise; no test pairs
  `mergeV`/`mergeE` keyed on a Binary (`test/L4-addendum/binary-values.feature`);
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
- **The Number family is spelled five times (number-family-one-authority) — MAJOR.** 7b3d623a added
  `SUBTYPES.number` (`src/gremlin/types.ts`) beside `NUMBER_TAGS` (`receiver.ts`, documented as THE
  family), `NUMBER_FAMILY` (`transform.ts`), `NUMERIC_VTYPES` (`predicate.ts`) and `NUMERIC`
  (`orderability.ts`). Define it once in `gremlin/types.ts` beside `CANONICAL`; derive the rest, so a
  corrected or added numeric type cannot change `typeOf(NUMBER)` without `asNumber`/receiver checks.
- **"Terminal global reducer" is tested by name in five places (terminal-reducer-fact)** —
  `nestedHostScopes` (`isStreamBarrier(last) && (REDUCERS.has(last.name) || last.name==='fold')`,
  `lower/reduction.ts`), `ir/analyze.ts:151/292/347`, `rel/write.ts:1169`; and `nestedHostChild` restates
  `perTraverserChild`'s map→one / local,flatMap→all policy. One fact, fail-closed today. See also
  `selfCollapses` under "Next round".
- **`PER_TRAVERSER_HOSTS` is declared twice with different members** — `ir/strategies.ts`
  (`local,map,flatMap,where,filter,not,and,or`: children reset per traverser) and `rel/lower/slice.ts`
  (`map,flatMap,local`: hosts `perTraverserChild` dispatches). Rename one or derive it; joins cr-fu15.
- **Unroll pins prove nothing for a random body** — `test/compiler/repeat-unroll-boundary.exec.test.ts`
  compares the emit unroll's SQL with a hand-written union, which has the same independent draw; add a
  coupling check (every emitted level-k path extends an emitted level-(k-1) path) and deny pins for
  `emit().repeat(both().sample(1)).times(2)` and a host-wrapped shuffle. The counted-until L4 file lacks the
  simplePath+emit, 64-table and large-k emit cases.
- **Ordering pins** — the T-token tie-break (`'id'` property vs `T.id`) is ordered String-first in JS
  (`orderability.ts`) and left by input position in SQL; add the same type tiebreak to the SQL ORDER BY or a
  §17 line. 73d25fc6 also moved `g.E().order().by(elementMap())` to `7,9,11,12,8,10` (Direction.IN sorts
  first by name) — correct, unpinned; pin it.
- **L3 ledger citations that do not say what they cite (l3-ledger-cites).** `list-default-cardinality`
  (`g_V_hasXname_fooX_propertyXname_setXbarX_age_43X`) is a `wall` citing a code literal (`src/api.ts`
  `DEFAULT_VERTEX_CARDINALITY`): an undeclared `property(k,v)` APPENDS, which changes ordinary write
  answers versus TinkerGraph's `single` — file it as a `divergence` with a §17 row ("Default vertex
  cardinality is list, the `Graph.Features` default — `Graph.java:671`; TinkerGraph's is single").
  `oncreate-override` cites the §17 "Error timing" row, which covers constant names only — cite matrix row
  ~199 (mergeV/mergeE "onCreate may restate a merge key, never change it") or add the clause. The §17
  "String vs integer element id" row should cross-reference rf3-reuse1. The three `wall`s that ANSWER
  (graph-computer-inert, vertex-property-ids, list-default-cardinality) are held to no check.
- **`hasLabel` on a joined EDGE re-reads the edge (label-probe-edge-col)** — when `ownScan(row, id,
  'edges')` resolves, read `col(scan,'label')` instead of a correlated rowid probe:
  `outE().as('e').inV().inE().hasLabel('created').where(neq('e'))` ~1.5× slower than before 7915c526
  (linear; output-bound). Same in the old IN form.
- **A `CONSTANT.true` conjunct is emitted as `WHERE (1 = 1)`** — f5b66932 routes `identity()` arms/bodies
  through `sourceFilter`, so 11 corpus plans (`emit().repeat(out()).times(2).path()`,
  `union(identity(), out())`, `choose(…, identity())`, …) gained it (its commit says no plan changed).
  Runtime-free (SQLite hoists it); elide it in the filter composer.
- **`dropEffectFreeSideEffect`'s effect test** (`OPAQUE_OR_RAISING`, `ir/strategies.ts`) is a hand
  denylist — see the effect-vocabulary proposal under "Next round".
- **Binary carrier size** — hex doubles a Binary's stored size, so DO's ~2 MB value cap holds ~1 MB of
  bytes (base64 would hold ~1.5 MB); add the line to §17/§10 so it is not found in production. A Binary's
  hex text is also indexed in `property_fts` (as a UUID's is) — wasted index space.
- **Docs** — the C3 §17 line (name `not()`, the `order()` route, the seats it covers, and that the concat
  raise is not Java's); the r7-m §17 lines for NUL and surrogates.
- **Stale comments**: `src/services/catalog/olap/shortest-path.ts` header (old recursive-CTE walk);
  `src/compiler/ir/strategies.ts` ~539 (stream/mutate/stats modes).
- Keep the `antlr4ng` patch until upstreamed; regenerate and diff `parser/` on a TinkerPop bump.

## Next round — reuse sweep and shared prerequisites

Proposals from the 2026-11-03 reuse sweep, each answer-neutral unless it says otherwise. Order matters only
where stated.

- **Landed: a per-traverser child body INSIDE a child body (§3.8).** `valueRun`/`scalarChild` take a
  `local`/`map`/`flatMap` step (`nestedHostChild`), and `flatMapRejoin` composes under an enclosing origin
  (`bodyScopesPerOrigin`, `nestRowOrigin`). Items it parked (`V(<traversal>)` under
  `where/filter/coalesce/optional/repeat`) should be re-probed against it; do not special-case
  `V(<traversal>)` hosts.
- **Prerequisite for inject-fresh-traversers (§1): one "mints fresh traversers" fact** in
  `src/compiler/ir/labels.ts`, read by `labelsBoundBefore`, `unlocatableSubPath` and `injectTail`'s alias
  reset — replaces the `i > 0 && name === 'inject'` peephole and fixes the §1 wrong answer.
- **One correlated-probe builder** — replace ~19 hand-rolled `project(['one', 1])` EXISTS probes
  (`source.ts` `hasLabelPredicate`/`hasPropertyPredicate`/`hasTokenPredicate`, 3 new in 7915c526;
  `write.ts` ×5; `list.ts` ×2; `map.ts` ×2; `lower.ts`) and the two private `existsOf` copies
  (`boundgraph.ts`, `decorate.ts`) with one `existsProbe(matched, fresh, {negated, prefix})` beside `make`.
  Pass the id prefix through so alias spelling and L2 snapshots stay byte-identical. ~25 lines.
- **One column-lineage walker** — `columnOrigin(rel, name)` in `src/rel` after
  `vendor/calcite/core/src/main/java/org/apache/calcite/rel/metadata/RelMdColumnOrigins.java`, returning
  scan+column / computed-at-rel / opaque, with the passthrough list and window/join rules once. Serves
  `ownScan` (`source.ts`, 7915c526) and `valueColIsDetached` (`lower/reduction.ts`, 202bdbce) — which
  already disagree on joins — and the passthrough lists in `src/rel/subtype.ts` and `block.ts`
  `aggregateCols`. ~30–40 lines; plan-only.
- **`hasTokenPredicate`'s direct own-scan test is `ownScan`'s base case** — spell it
  `ownScan(row, id, table) === row`, so the direct/uncorrelated/correlated choice is a switch on one answer.
  (Small constant-factor cost noted: `out().hasId(P.without(1,4))` 13.6 → 24.8 ms at 8k, linear.) Do after
  the lineage walker if both are taken.
- **Effect/opaque step vocabularies on the existing authorities** — export
  `GRAPH_ALGO_NAMES = Object.keys(GRAPH_ALGO_SERVICE)` (`ir/strategies.ts`); build `write.ts` `OPAQUE_STEPS`
  from `MUTATING_STEPS` ∪ that ∪ `['call','io','read','write','subgraph','profile']`, `OPAQUE_OR_RAISING`
  from `{'fail','call','io', …GRAPH_ALGO_NAMES}`, and `desugarGraphAlgos`'s gate as
  `s.name in GRAPH_ALGO_SERVICE` (`ir/passes.ts`). `MUTATING_STEPS`' own doc ("not in two places") is
  violated today. ~6 lines, sets identical.
- **Repeat-region grouping stated once** — export one `repeatSlot(name)` (times→until) plus the shared
  REPEAT_CLUSTER walk and build `verifyRepeatDefined` on `gatherRepeatRegion`'s grouping (~10 lines,
  answer-neutral). Letting `gatherRepeatRegion` absorb an interior `as()` (TinkerPop's rule) turns the §4
  `repeat(out()).as('a').times(2)` decline into an answer — a SEPARATE item with an L4 witness.

Proposals from the 2026-11-04 reuse sweep (answer-neutral unless stated):

- **`mapEntriesLocal` takes the JS orderability barrier's Map arm for scalar keys/values** — bare
  `order(local)` and `order(local).by(keys|values)` over a Map (`order-dedup-local.ts`
  `buildOrderDedupSegment`'s `op === 'order'` arm, `entryComparators`, `orderability.ts`
  `orderMapLocalValue`) move to `src/compiler/rel/map.ts` `mapEntriesLocal`, which takes the
  `EntryComparator` list (`$[0]`/`$[1]`, asc/desc). One authority for top-level and per-row Maps (the
  §2 map-key-order-authority question), ~20 lines of barrier gone, and `g.V().map(valueMap('name','age')
  .order(Scope.local))` stops declining. Answers change only for maps whose keys mix types — one §17 line.
- **Record-local branch recognizes steps via `collectionReaderOf`** — `continueAs`'s record host
  (`src/compiler/rel/lower.ts`) hand-tests count/slice/merge before `recordToMap → mapTail`; reuse
  `collectionReaderOf` so `project(…).dedup(Scope.local)` and `local(project(…).order(Scope.local))` lower as
  inline SQL (both decline today). Do after the proposal above (same storedCompareOn caveat).
- **`selfCollapses(step)` owns the `!isLocalScope` check** — two of its four callers add it by hand
  (`branch.ts` `isReductionArm`, `branch.ts:1064`), two do not (`reduction.ts:269` `reductionArm`,
  `reduction.ts:1414` `selfCollapsed`); `map.ts` `reducesPool` re-spells it. Probe:
  `project('x').by(values('age').fold().sum(Scope.local))` declines while `…count(Scope.local)` answers —
  whether the missing check causes it is unmeasured; measure as part of the item.
- **`dedupLocalValue` in N log N** (`src/compiler/rel/orderability.ts`) — stable sort on
  `(orderabilityCompare, index)`, keep the first of each equal run, re-emit in index order (LinkedHashSet
  first-occurrence kept). Safe since 73d25fc6 made `compare()==0` type-spaced. A runtime fix at production
  size (`fold()` of 8k members ≈ 32M comparisons); scaling-probe 1k/8k, expect ~64× → ~10×.
- **call-params: `constFromValueTraversal` on `resolveValueTraversal`**, and one `paramValue(v)` for the
  static-map and `with()` loops in `parseCallSpec` (`src/services/params/call-params.ts`); keeps the
  per-traverser refusal message. ~6 lines.
- **One `tagExcludes(tag, vtypes)` guard** for the `NOT coalesce(tag,'') IN (others)` tree `typeSpaced` and
  `textSpaced` each build (`src/compiler/rel/predicate.ts`) — `hoistedStringSet`'s `JSON.stringify` match
  relies on them being byte-equal. Byte-identical SQL. Prerequisite of the §1b binary-carrier-guard follow-up.
- **`firstRootedColumn` on `build.ts` `firstOf`** for the ordered case (the typed `firstRootedValue` branch is
  a third copy, differing only by a fence). Confirm with the sql-hygiene baseline that no plan moves.

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
