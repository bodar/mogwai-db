# Writes-through-the-read-spine — the one nested-arg seam (2026-07-17)

**Status:** plan, ready to execute cold. Closes the surviving §6.1 item of
`docs/2026-07-16-compiler-consolidation-plan.md` ("Writes-through-the-read-spine,
remainder"). Scope decided with the user: **do #1 + #2 + #3 together**, on one unified
nested-traversal-argument seam, and **widen the L3 ratchet to cover write steps** so the
work gains a conformance number + regression guard.

> **Read this first if resuming after a context clear.** Everything below lives in
> **`src/steps/write.ts`** (one file). The three items are not independent features — they
> are three call sites of the SAME question: *"a write-step argument is a nested
> `__.traversal`; evaluate it."* The plan's spine is: make one small family of resolver
> functions THE authority for every nested write-arg, then route all sites through it.

---

## 0. Why this is one job, not three

A write step can take a nested traversal as an argument in exactly these positions:

| Position | Example | Produces | Item |
|---|---|---|---|
| property **value** | `addV().property('age', __.constant(29))` | a scalar VALUE | #2 |
| property **value** | `g.V().property('deg', __.out().count())` | a scalar VALUE | (already works, line 168) |
| addE **endpoint** | `addE('x').to(V().has('name','lop'))` | an ELEMENT rowid | #1 (works via buildPrefix) |
| addE **endpoint** | `addE('x').to(__.select('a'))` | an as()-label rowid | #1 (NEW — alias) |
| addE **endpoint** | `addE('x').to(__.addV())` | a NEW element rowid | #1 (NEW — nested write) |
| merge **map value** | `mergeV([...]).option(onCreate, [k: __.trav])` | a scalar VALUE (per-merge) | #3 |

Every row is "run a nested traversal, take its (value \| rowid), maybe seeded at a driver
element." The existing seam already does the first flavour: `runNested` (write.ts:37) →
`compileRead` → store.query, wrapped by `nestedScalar`/`resolveSpecValue`. It just isn't
the sole authority: `resolveEndpoint` hand-rolls `buildPrefix`, the addV/addE inline-prop
appliers bypass `resolveSpecValue` entirely (throw at 295/321), and `resolveMergeArg`
only resolves compile-time constants.

**The structural move:** one resolver family, every site routed through it. Doing the
three apart means re-threading `params`/`sideEffects` through the same functions three
times, with rebase churn — they touch adjacent code.

---

## 1. Current seam (what exists, verified)

- `runNested(store, nestedNode, params, seed?) → {rows, shape}` (write.ts:37). Compiles a
  nested traversal via **`compileRead`** (the FULL read spine, incl. tail) and runs it.
  `seed?` prepends a synthetic `V(id)`/`E(id)` source on the driver's **internal rowid**,
  correlating the child at that element.
- `nestedScalar(store, nestedNode, params, seed) → {has, value, vtype}` (write.ts:57).
  First-row scalar of a `runNested`; fails closed on a non-scalar/count shape.
- `resolveSpecValue(store, sp: PropSpec, id, elem, params, sideEffects?) → {has,value,vtype}`
  (write.ts:72). Literal → passthrough; `constFromSelect` (a `__.select(k)` of a
  `withSideEffect(k,const)`) → the constant; else `nestedScalar` seeded at the element.
  **This is the value-resolution authority — already used by `compileProperty` (168/155).**
- `buildPrefix(steps, params) → {st, stop}` — movement/filter prefix only; `st.rel` is the
  element **id-relation carrying internal rowids** (`renderFrom(st.q, st.rel)` → rows with
  `id`). Used by `resolveEndpoint` and `mergeDrivers`.

**Key invariant (do not break):** `compileRead` frames **external** ids
(`COALESCE(uid,id)`); edge `src`/`tgt` and merge matching need **internal rowids**.
So endpoint/driver resolution uses `buildPrefix` (internal rowids), NOT `runNested`.
`runNested` is for VALUE resolution only.

**Verified conformance shapes** (from `vendor/tinkerpop/.../features`):
- addE endpoints that appear: `V(id)`, `V().has(...)` (both PREFIX-consumable → already
  work), `__.select('label')`, `__.addV()`. **No order/limit-past-prefix endpoints exist**
  — the `stop !== inner.length` throw (476) is a fail-closed wall with no consumer; leave
  it (do not build a full-spine→rowid seam for a fake case).
- property nested values on writes: `addV().property('age', __.…)`,
  `addV().property('name', __.values('name'))`, `addV(__.select('a').label())`,
  and `.property(__.values('name'), __.…)` (nested **key** too — see risk R3).
- merge map traversal values: `Merge.onCreate`/`onMatch` maps with `__.…` values.

---

## 2. Target seam (what to build)

Add to `write.ts`, keeping all three items on it:

```
// The nested-write-arg authority. One place that knows how to turn a {nested} arg into
// a value / a rowid, optionally correlated at a driver element.

nestedScalarValue(store, nested, params, seed?, sideEffects?) -> {has, value, vtype}
  // = today's resolveSpecValue core, generalized so merge (#3) reuses it. constFromSelect
  //   first, then nestedScalar seeded at `seed`.

nestedElementRowid(store, spec, ctx, params, sideEffects?) -> number
  // The endpoint resolver (#1). Dispatches on spec:
  //   string / __.select('lbl')  -> ctx.aliases.get(lbl)      (as()-label)
  //   __.addV(...)-rooted        -> insertVertex(parseVertexSpec(...)).id   (nested write)
  //   V()/E()-rooted read        -> buildPrefix(inner); rows[0].id           (internal rowid)
  //   past-prefix                -> throw (unchanged fail-closed wall)
```

`resolveEndpoint` becomes a thin wrapper over `nestedElementRowid`.

**No new "full-spine→rowid" machinery** — buildPrefix already yields internal rowids and
covers every real read-endpoint shape.

---

## 3. Item-by-item build

### Safety net FIRST — Step 0: widen the L3 write ratchet

Per the project ethos (the ratchet is the safety net that makes bold changes safe) and the
user's decision, establish the write baseline **before** touching resolution code.

1. `test/conformance/tags.ts`: remove `and not @StepWrite` from `L3_TAGS`. Leave the other
   exclusions (`@GraphComputerOnly`, `@AllowNullPropertyValues`, `@StepSample`,
   `@StepCoin`) intact.
2. Run `bun test test/conformance/l3.test.ts`. The ratchet counts **passing** scenarios;
   newly-included write scenarios that fail don't lower the count (only a DROP fails the
   suite), so the baseline can only rise. It auto-bumps `baseline.json` + `SYNC_FILES`
   (README + matrix) locally (`!CI`); commit them.
3. **Spike / fallback:** if including all `@StepWrite` destabilizes the harness (a write
   scenario that errors in the runner rather than cleanly failing, or shared-graph
   bleed-through), narrow to a curated subset by feature file
   (`AddVertex`/`AddEdge`/`MergeV`/`MergeE`/`AddProperty`) instead of the blanket tag, and
   note what was dropped (no silent caps).

This gives every subsequent item a live, committed number to move. Commit Step 0 on its
own so the "widening" bump is separated from each feature's bump.

### #2 — property nested VALUES on addV / addE (route through `resolveSpecValue`)

The appliers `applyVertexProperty` (295) / `insertEdgeProperty` (321) throw on a nested
`val`. They take an ALREADY-resolved value; resolution must happen upstream, exactly as
`compileProperty` does at 168. Two call sites bypass it:

- **addV inline props — `insertVertex` (356).** `spec.props: PropSpec[]` applied directly
  at 358.
  - Thread `params` + `sideEffects` into `insertVertex`.
  - Per prop: `const r = resolveSpecValue(store, p, row.id, 'node', params, sideEffects);
    if (r.has) applyVertexProperty(store, row.id, p.key, r.value, r.vtype, p.meta, p.cardinality);`
  - Callers to update: `compileAddV` (367 — has both), `runWriteChainFull` (452 — has
    both), `compileMergeV` create path (605 — passes `singleProps(props)`; those values are
    merge-resolved already, so nested won't appear there, but thread params anyway for
    uniformity).
  - **Seed semantics:** the vertex is freshly created (`row.id`), so
    `addV().property('deg', __.out().count())` seeds at the new (edge-less) vertex → 0.
    Correct per TinkerPop.

- **addE inline props — `insertEdge` (401).** `c.props: Record<string,any>` +
  `c.propTypes` applied at 403.
  - Thread `params` + `sideEffects` into `insertEdge` (and its caller `applyEdgeCluster`
    409, whose caller `compileAddE`/`runWriteChainFull` have params; `sideEffects` reaches
    `compileAddE`? — it currently does NOT take sideEffects; add the param, default
    undefined, thread from the WRITE_RULES dispatch).
  - Per `[k,v]`: build a synthetic `PropSpec {key:k, value:v, vtype:c.propTypes[k],
    meta:null, cardinality:'single'}`, `resolveSpecValue(..., id, 'edge', ...)`, then
    `insertEdgeProperty(store, id, k, r.value, r.vtype)` when `r.has`.
  - **Response echo:** line 405 returns `props: c.props` (the raw, possibly-nested values).
    Build a resolved `{k: r.value}` record and return THAT, else the write response frames
    a `{nested}` object.

Keep the 295/321 throws as defensive fail-closed guards (a caller that still forgets to
resolve should throw, not write a `{nested}` blob).

### #1 — addE endpoints (`resolveEndpoint` → `nestedElementRowid`)

`resolveEndpoint` (467) currently: `string` → alias; `{nested}` → `buildPrefix` (throws
past prefix); else throw. Add the two shapes that actually appear, via
`nestedElementRowid`:

- **`__.select('label')` → alias.** `inner = stepChain(spec.nested)`; if it is a single
  `select` with one string arg → `ctx.aliases.get(arg)` (same as the bare-string case).
  `to(__.select('a'))` ≡ `to('a')`.
- **`__.addV(...)` → nested write.** If `inner[0].name === 'addV'`: parse it with
  `parseVertexSpec(inner[0], inner.slice(1).filter(property), sideEffects, params)`,
  `insertVertex(...)`, use `.id`. (Reuses #2's threaded `insertVertex`.) Handle trailing
  `property()` on the nested addV; a non-addV/non-property tail throws.
  - **Ordering wrinkle:** `to(__.addV())` CREATES a vertex as a side effect of resolving
    the endpoint. Resolve endpoints in from-then-to order, once per driver row, before
    `insertEdge`. Confirm against the `addE("next").to(__.addV())` scenario's expected
    vertex count.
- **`__.V(id)` / `__.V().has(...)`** → unchanged (`buildPrefix`, internal rowid).

Thread `sideEffects` into `resolveEndpoint`/`applyEdgeCluster`/`compileAddE` (shared with
#2's threading — do both in one pass).

### #3 — merge map traversal VALUES, full correlated per-merge (the hard one)

Today `resolveMergeArg` (511) resolves the whole map arg at COMPILE time (constants only;
throws at 519 on a real traversal). Correlated per-merge requires deferring nested map
VALUES to RUN time, seeded at each driver.

**Design:**

1. **Stop fully-resolving at compile time.** `normalizeMergeMap` keeps nested-traversal
   values UNRESOLVED in `MergeSpec.props` (and `label`/`id`/`outV`/`inV` if nested — but
   those are rarer; scope: resolve nested **prop values** first, keep nested key/label/id
   deferred with a clear throw unless a scenario needs them). Tag unresolved values so the
   run-time pass knows to resolve (they're `{nested}` objects already — `isNested`).
2. **Per-driver resolution pass.** In `compileMergeV`/`compileMergeE`'s driver loop
   (`for (const cur of drivers(store))`), before building the match query, resolve each
   nested prop value via `nestedScalarValue(store, v.nested, params, seedFor(cur), sideEffects)`
   where `seedFor(cur)` = `{id: cur, elem: 'node'}` when `cur != null`, else undefined
   (global). Produce a fully-resolved `MergeSpec` for THIS driver.
3. **Match query per driver.** `mergeMatchQuery`/`edgeMatchQuery`/`commonMergeConds`
   currently take a compile-time spec. They must be built from the per-driver resolved
   spec (move their construction inside the loop, or pass resolved props). `commonMergeConds`
   already renders binds from `spec.props` values — feed resolved scalars.
4. **onCreate/onMatch prop application** (599/651) already loops per match — resolve their
   nested values per driver too (same `nestedScalarValue`, seeded at `cur` for the match
   case, or at the matched element `m.id`? — TinkerPop seeds the merge map traversal at the
   incoming traverser, not the matched element; use `cur`. Confirm against a scenario).

**This is genuinely more than plumbing** — it moves match-query construction from compile
time to per-driver run time. Land it LAST, on the resolver seam #2 establishes.

---

## 4. Ordering (work through in this sequence)

0. **Widen tags → write baseline** (safety net). Commit alone.
1. **#2 addV property values** — thread `insertVertex`, route through `resolveSpecValue`.
   Tests + ratchet bump. Commit.
2. **#2 addE property values** — thread `insertEdge`/`applyEdgeCluster`/`compileAddE`
   (incl. `sideEffects`), synthetic PropSpec, resolved response echo. Commit.
3. **#1 endpoints** — `nestedElementRowid`: `select(label)` alias + `to(__.addV())` nested
   write; `resolveEndpoint` becomes the wrapper. Commit.
4. **#3 correlated merge** — defer nested map values to per-driver run-time resolution;
   move match-query build into the driver loop. Commit.

Each step: **green `bunx tsc --noEmit` + `bun test` + L3 baseline holds-or-rises** before
committing. Each is independently committable/pushable via the trunk flow.

---

## 5. Verification

- **L3 ratchet** (Step 0 makes it live for writes) — the primary regression guard; each
  item should hold-or-rise.
- **Targeted tests in `test/`** mirroring each new shape, asserting result correctness
  (not just compile): `addV().property(k, __.constant/values/count)`, addE property nested,
  `addE().to(__.select('a'))`, `addE().to(__.addV())` (vertex + edge counts),
  `mergeV/mergeE` with a correlated `__.…` map value on onCreate + onMatch. Follow the
  existing write-test style (run the traversal through the query path, assert store state +
  framed response).
- SQL snapshots only where a shape emits interesting SQL; writes are imperative so most
  assertions are behavioral (store state), per the `write.ts` seam comment (81–87).

---

## 6. Risks / open wrinkles (resolve during implementation, not now)

- **R1 — as()-label property values in a write chain.** `addV().as('a').addE()…` then a
  property value `__.select('a')` references a WRITE-chain alias, not a read seed or a
  withSideEffect const. `resolveSpecValue`/`constFromSelect` won't resolve it. If a scenario
  needs it, extend the resolver to consult the write chain's `aliases` map (thread it in).
  Fail closed with a clear message otherwise.
- **R2 — merge match construction moving to run time.** Moving `mergeMatchQuery` into the
  driver loop changes when binds render; keep the existing behaviour bit-identical for the
  constant case (no nested values → same query as today). Add a nested-value test that
  proves correlation actually varies the match.
- **R3 — nested property KEY.** `.property(__.values('name'), __.…)` — a nested KEY, not
  just value. `parseVertexSpec` runs `constFromSelect` on the key (232) but a live nested
  key traversal is unhandled. Scope: resolve nested VALUES this pass; keep nested-key
  deferred with a clear throw unless the widened ratchet shows it costs real scenarios.
- **R4 — `to(__.addV())` side-effect ordering.** Resolving an endpoint now mutates. Ensure
  from/to resolve exactly once per driver, before `insertEdge`, and that the created-vertex
  count matches expectations. No double-creation on multi-driver chains.
- **R5 — widening noise.** If `@StepWrite` inclusion surfaces harness instability, fall
  back to curated feature-file tags (§3 Step 0 fallback) and log the drop.
- **R6 — seed element type for addE property values.** Seed at the new edge (`elem:'edge'`)
  — confirm `resolveSpecValue`'s edge seed (`E(id)`) is valid for the traversal shapes that
  appear (most are `__.constant`/`__.select`, which don't traverse from the edge).

---

## 7. What this closes / leaves

- **Closes:** `docs/2026-07-16-compiler-consolidation-plan.md` §6.1 in full — every nested
  write-arg site routes through one seam; `runNested`/`resolveSpecValue` become the sole
  authority; the merge traversal-arg throw (519) and the property nested-value throws
  (295/321 as reachable errors) and the endpoint gaps (select-label, addV) are gone.
- **Leaves (deliberate, fail-closed walls, no consumer):** endpoint traversals past the
  read prefix (476); nested property keys (R3) unless the ratchet demands them; nested
  merge label/id/direction values unless a scenario needs them.
- **Doc hygiene on completion:** update §6.1 of the consolidation plan to RESOLVED, and
  record the write-ratchet widening (new baseline, `tags.ts` change) in
  `docs/feature-support-matrix.md` + CLAUDE.md's testing section (the L3 scope note now
  includes write steps).
