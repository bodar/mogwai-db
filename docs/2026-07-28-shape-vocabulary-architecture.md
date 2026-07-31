# Shape vocabularies across the layers — what to unify, what to finish, what to leave alone

**Status: design session, 2026-07-28. No code landed.** Seven agents (three research sweeps, four
architects including a designated skeptic) against `fa6c0aa`. Every claim below is cited to a
`file:line` or a measurement; the ones that decide the recommendation were re-verified by hand and
are marked **[verified]**. Read this before proposing a cross-layer shape refactor — three of the
obvious ones are already refuted here, one of them by prior art in this repo.

**Names here predate the 2026-07-29 rename** (`Carry`/`Carried` → `LoweringState`/
`TraverserLayout`, `PStep` → `IRStep`, and the whole `carry*` family). The measurements below are
dated and left as they were taken; decode them with the rename map in
[tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md).

## The question that framed it

> The IR-vs-lowering lesson: a non-productive `by()` drop as a decoration Pass broke all six
> non-element `order().by(key)` shapes because the IR has no shape information. Is there
> architecturally a bright line here? All the JSON structures with `kind` and other params make me
> wonder whether we have just shoved stuff into them. And those shapes are not consistent across
> layers — is that correct? We grew them organically; is it time to design them properly?

Yes to all three observations. But the remedy they imply — a designed, consistent, total cross-layer
shape algebra — is the wrong one, and the evidence for that is in this repo's own history.

## 1. The diagnosis: "shape" is doing three jobs under one word

Every shape vocabulary answers exactly one of three questions, and nothing in the code says which:

| | Question | Today's answers |
|---|---|---|
| **L** | What Gremlin object is this traverser? | `Stream.kind`, `Shape.kind`, `ListOf`, `MapOf`, `MapEntry.sub`, `GroupKey`/`GroupVal`, `PathPos.render`, `ElemShape`, `Elem`, `AliasShape`, `ChildShape` |
| **P** | Which relational columns hold it? | `streamPayloadCols` (`stream.ts:328`), `groupColumns` (`:275`), `pathColumns` (`:294`), `recordFieldColumns` (`:301`), `elemColumns` (`:269`), `PROPERTY_PAYLOAD` (`:131`), `foreignPayload` (`:164`), `perRowCols` (`render.ts:147`) |
| **W** | How does the framer turn rows into buffers? | `Shape` again (`render.ts:150`), consumed by `frameValues` (`execute.ts:538`) |

`Shape` answers **L+W**. `Stream.kind` answers **L+P**. **The N:M mismatch between them is precisely
the P-vs-W mismatch** — two physical encodings of one logical value get two `Shape`s but one
`Stream`, or the reverse.

This is the same category error `docs/archive/2026-07-25-type-channel-unification.md:80` already recorded:
*"Uniform typing is a compile-time property; the physical encoding stays free. Conflating those two
is what caused the dead end."* `ScalarType` (`render.ts:120`) is the only vocabulary in the codebase
that got the separation right, and it is the template for everything worth doing below.

## 2. The inconsistency is real, and mostly load-bearing

**Seven spellings of element kind:** `Elem` (`plan.ts:382`), `ElemShape` (`render.ts:46`),
`ListOf.elem`/`MapOf.elem` (`render.ts:14,32` — the `node` spelling inside the file that declares
the `vertex` one), `AliasShape` (`alias.ts:19`), `OwnerElem` (`fts-index.ts:27`, **persisted** in
`property_fts`), `ForeignRow.kind` (`api.ts:49`), and `ScalarCtx.elem` (`plan.ts:396`, which uses
`Elem`'s spelling with `ElemShape`'s membership). Bridged by 11 inline `x === 'edge' ? 'edge' :
'vertex'` ternaries.

**Eight carriers of scalar type:** `CanonicalType`, `TypeNode`, `ValueNode.t`, `ValueType`,
`ScalarType`, the legacy `as?: ValueType` pair, `TypeCtx` (`plan.ts:152`), `GTYPE_SQL`.

**Six shape vocabularies:** `Stream.kind` (11+1), `Shape.kind` (22), `AliasShape` (6),
`ChildShape`/`BranchArmShape` (3/4), the L5 generator's lattice (`test/L5-properties/shape.ts:32`, 7).

**But most of this must stay**, and confusing "duplicated" with "accidental" is how a refactor here
does damage:

- **`Stream` is not a shape vocabulary — it is a capability partition.** `ForeignStream` and
  `PropertyStream` are deliberately *not* `ElementStream` so that movement over them is
  structurally unreachable (`stream.ts:12-14,117-125,145-159`). `valOf(foreign) === valOf(elements)`
  logically, and the streams must still differ.
- **`Elem` vs `ElemShape` are different questions**: a storage-table selector (`nodes`/`edges`,
  `nodeProp*`/`edgeProp*`) versus a wire-framing selector (`vertexBuffer`/`edgeBuffer`/
  `propertyBuffer`). Different member sets, not two spellings.
- **`MapOf`'s fieldless scalar arm encodes an enforced invariant** — the scalar side of a map is
  *always* a self-describing `{t,v}` node (`render.ts:27-30`). Giving it `ListOf`'s three optionals
  re-creates the two-optionals trap and is literally the reverted `{t,v}` experiment.
- **`ChildShape` is deliberately narrow** (`outstanding-work.md:158-160`): admitting `'map'` would
  tell the branch triage a map arm is mergeable when no merge covers one — *converting a clean
  deferral into a wrong answer*.

**Genuinely accidental, and worth deleting:** `ValueType` vs `CanonicalType` (14 names differing on
exactly two — `bool`/`boolean`, `date`/`datetime`; the divergence already shipped a bug, `853a416`),
and the `node`/`vertex` spelling collision.

### The one failure mode that has recurred independently

A coarse hand-written shape vocabulary that **does not record what a list is a list of**:

- The L5 lattice was wrong twice for exactly this — *"letting one shape stand for two things
  (`element` covering vertex and edge, so it emitted `E().bothE()`; `list` not recording what it was
  a list of, so it emitted `fold().sum(local)` over vertices)"*
  (`2026-07-28-property-based-testing-l5.md:83-86`).
- `AliasShape` has the same live defect: `outstanding-work.md` item 1 — *"`AliasEntry` does not
  record the member shape, so a path/element-list label cannot frame its members as vertices."*

`ListOf` records it. The two vocabularies that don't, both have logged bugs from not doing so. That
is the strongest *structural* argument in the session — two independent confirmations of one
mechanism — and it argues for **deriving coarse projections from the fine one**, not for merging
the fine ones together.

## 3. The `kind` structures: values without types

The front-end mints **14 ad-hoc tagged tokens** in `walkArgs` (`frontend.ts:214-368`) — `{order}`,
`{pop}`, `{column}`, `{token}`, `{direction}`, `{merge}`, `{cardinality}`, `{gtype}`, `{pick}`,
`{withOption}`, `{dt}`, `{operator}`, `{scope}`, `{nested}` — and **12 have no declared type
anywhere**. Detection is `'tag' in a` at every consumer. Consequences:

- `{gtype}` unwrapping (`'gtype' in a ? String(a.gtype) : typeof a === 'string' ? a : null`) is
  re-implemented at **7 sites**.
- `{order}` is scanned inline at **7 sites**, despite `classifyBy` (`child-shape.ts:857`) existing
  to centralise exactly that.
- Only `{nested}` has a guard (`isNested`, `frontend.ts:102`).

Top optional-field grab bags: `ScalarCtx` (`plan.ts:395` — 3-way discriminant, **10 optionals**, 5
property-only, 2 edge-only, one fully orthogonal; read with `!` at 5+ sites); `Shape.variant`
(`render.ts:162` — 5 optionals, **zero required fields**); `Shape.jsonbList` (`render.ts:166` —
three mutually-exclusive item-type channels that `execute.ts:606` reconstructs into a fourth);
`IRStep` (`ir/step.ts` — 7 optionals, each owned by one pass); `TraverserLayout` (`context.ts` — 8
optionals mixing column names, a chain-global boolean, and pure diagnostics).

Two undeclared unions worth closing regardless: `frameTypedNode` (`execute.ts:228,234`) accepts two
**bare** forms not in the `ValueNode` union, and write-plan result rows are discriminated by *key
presence* (`{vertex:…}` vs `{edge:…}`, `execute.ts:518,521`) with no type at all.

## 4. Not organic growth — three unfinished consolidations

The designs already exist, are already written down, and are already right. What failed three times
is *finishing* them; in each case the first consumer was converted and the rest kept a local alias
or a hand-written copy so their call sites would not move.

1. **`ScalarType`** — landed for `ScalarStream` and `Shape.value`. Still on the old raw `as?:
   ValueType`: `ListOf.scalar`, `Shape.variant`, `Shape.list`, `Shape.jsonbList`, `VariantStream`,
   `AliasEntry`, and `TypeCtx` (`plan.ts:152`, whose own comments call it "Mode 1/2/3" — the
   two-optionals-plus-implicit-third pattern verbatim). `MapEntry{sub:'value'}` (`render.ts:39`)
   carries **no type channel at all**, and `recordFieldColumns` emits only `${prefix}_v`, so a
   sibling vtype column is not even possible: `project('x').by('someUuid')` frames by JS inference
   while the same value via `values()` frames exactly. The step-3 build order in
   `archive/2026-07-25-type-channel-unification.md:127` names this and was never done.
2. **`VALUETYPE_TO_CANONICAL`** — its comment (`types.ts:150-153`) says it replaced three
   hand-written copies. It missed `execute.ts:355` (`VTYPE_TO_VALUETYPE`, a 14-entry verbatim
   duplicate) **[verified]**, and `write.ts:66`/`plan.ts:144` survive as pure renames.
3. **`streamPayloadCols`** — landed for the child-seam rejoin; the element arm (`['id']`) and scalar
   arm are re-derived by hand at ~22 sites. The `result === 'number' → ['v','vt']` implication alone
   is rewritten in **8** places. The element payload column list exists in **5** independent
   derivations (`stream.ts:269`, `stream.ts:301`, `group.ts:89`, `select.ts:106` and `:127`,
   `execute.ts:271`), agreeing by convention.

## 5. The decisive evidence: what actually generates bugs

36 defects with a written diagnosis (docs + 68 commit bodies, 2026-07-25 → 07-28):

| Category | n | share |
|---|---|---|
| **A carried/optional field dropped at a barrier, merge or rejoin** | **12** | **33%** |
| Other (fail-closed contract violations 5, second-implementation drift 4, SQL hazards 2, plumbing 2, grammar fidelity 1) | 14 | 39% |
| TinkerPop semantics misunderstood | 7 | 19% |
| Cross-layer vocabulary inconsistency | 2 | 6% |
| Missing shape information | 1 | 3% |

**Shape-in-the-IR plus the unified algebra together target 8%.** The single vocabulary defect
(`853a416`) is already prevented by the `satisfies` bridge (`types.ts:154-158`). The single
shape-information defect *is* the `order().by()` revert, which argues the opposite of the proposal.

**And 6 of the 12 carried-channel defects are in `bulk`/`encounter`/`origins`/aliases** — orthogonal
to shape by construction, because carried columns ride *alongside* the payload. A unified shape
algebra would have prevented **zero** of them.

What did kill the other six was not unification but three narrow mechanisms: **totality**
(`ScalarType` as a union the compiler forces you to handle), **a runtime contract assertion**
(`assertStreamColumns`, `stream.ts:345`, which "earned its keep"), and **a named preserving rebuild**
(`rebuildScalar`, `stream.ts:392`, whose comment reads *"every barrier bug in that area was one of
those sites forgetting a field"*).

### The base rate that should govern any proposal here

Structural need predicted by reasoning forward from an architecture sketch has been falsified by
measurement roughly 12 times: per-concern compiler objects (rejected as net churn,
`2026-07-23-directory-restructure-plan.md:55-79`); the uniform `{t,v}` encoding (built, cost 15
tests, reverted); "Mode C" flat accumulation (the audit's own *"one structural finding"*,
**retracted** after 14 probes, `669cd0f`); four predicted new substrates, all one-line unlocks
(`steps/CLAUDE.md:69-80`); two hypotheticals escalated as blocking and then withdrawn — *"The check
is one grep"* (`82f1d68`); the rooted-union widening (`56a8a6f`); `asNumber` as "just more
`scalarTx`" — *"That was wrong."*

The wins were all **reachability** fixes: change a guard from "I have a parse tree" to "I have a
body"; spell a `json_each` explode as an `ElementStream` by putting `(pk, ord)` in the `origins`
slot that already means that; make an optional field a total union. One genuine cross-file
vocabulary unification *did* land and kill a bug class — `ScalarType`, 31 files, 4 commits. So the
lesson is not "refactors fail here." It is: **the burden on a structural proposal is a measurement,
not a design.**

## 6. The bright line for shape in the IR

The recorded post-mortem (`modulation.ts:40-52`, `2026-07-28-property-based-testing-l5.md:143-168`)
draws the boundary one notch too wide. The `order().by()` Pass did not fail for want of information;
it failed as an **unchecked shape claim**. The two shape-specific injectors that are *correct*
anchor on `VERTEX_PRODUCERS`/`EDGE_PRODUCERS` (`strategies.ts:201-203`) — step names whose output
shape is fixed by the name alone. `order()`'s output shape is its input shape. It carried no local
proof.

Two facts make this worth stating precisely rather than as folklore. `PassContext`
(`ir/pass.ts:39-55`) has no shape field *and no `ChainFacts` field*, and `analyze()` runs **after**
`runPasses()` (`compiler.ts:46,58`) — so "the IR has no shape" is currently a property of a struct
definition. And `child-shape.ts` already contains a syntax-only engine that, given
`(entry shape, LabelEnv, params)`, is pure `Step[]` reasoning with no Query, CTE or table schema —
it is a shape **propagation** engine, not an inference one; it cannot manufacture the entry shape.

**The reason not to simply add the field is the asymmetry that makes it dangerous:**

> A fail-closed *lowering* throws. A declining *decoration Pass* is **silent**. A shape-guarded Pass
> that hits `unknown` silently reproduces the original wrong answer — and the L5 differential cannot
> see it, because both configs decline identically.

Hence the rule to adopt, which generalises the type-channel rule that already worked here:

> **Shape may be an annotation a Pass CONSULTS and may decline on. It must never be a representation
> a Pass CONSTRUCTS or lowering CONSUMES. Sharing across shapes is by registration into a Map, never
> a widening fallback chain.**

That is why a typed core IR is refused: it turns "the shape is knowable" into "here is a `Core[]`
every consumer must construct", which is structurally the `{t,v}` envelope move that converted 15
working traversals into deferrals.

## 7. The concept that is missing: row→traverser cardinality

Two architects derived this independently from opposite directions, which is the strongest signal in
the session.

From the wire side: three cardinalities exist in `frameValues` and **none is named** — `perRow`
(most), `whole` (`list`, `group`, `variant{list:true}`), and `runs-by-pk` (`pathGrouped`). Because
it is unnamed, it had to be encoded as *separate `Shape` kinds*: `Shape.list` and `Shape.jsonbList`
differ **only** in this (`execute.ts:593-600` vs `:606`).

From the lowering side: `count()` is why row-ops cannot be naively shared. `lowerGlobalCount`
(`barrier.ts:19`) already takes `RelationalStream` and is total **[verified]**; it is registered
separately in six shape tables and absent from map/mapEntry/foreign. But `group.ts:659`
(`COUNT(DISTINCT gk)`) and `path.ts:377` (`COUNT(DISTINCT pk)`) are **not** drift — a grouped
`PathStream` has one row *per position*, so `COUNT(*)` would count positions, not paths
**[verified]**. They are the same *name* over relations where rows ≠ traversers.

**This correction matters operationally:** blindly spreading a shared `countRows`/`sliceRows` into
every shape table would produce wrong answers, not free coverage. The axis has to be named first.

Real drift does exist alongside it: `variantSlice` (`variant.ts:200`) emits `LIMIT n` with **no
`ORDER BY`**, and `recordSlice`'s global branch likewise, while `rowPreserving` (`scalar.ts:100`)
emits `ORDER BY <encounter>` when the chain carries emission order **[verified]**. So
`g.V().values('x').limit(2)` picks a deterministic window and the variant/record equivalents pick an
arbitrary one.

The criterion for *what* can be shared is already written in the code. `applyChildCardinality`
(`child.ts:204-243`) generalised because it needs only payload column **names** (opaque strings),
the carried schema, and a spread-rehome — **it never needs an expression denoting the traverser's
value**. `partitionedDedup` (`scalar.ts:261`) does not generalise, and fails on exactly that
criterion: `PARTITION BY …, p.c.v`. Three classes follow — row-algebraic (one implementation each),
current-object (needs a named authority generalising `foldMember`, `barrier.ts:54`, allowed to
return `null`), and shape-interpreting (per-shape forever, correctly).

One live mis-execution risk to design against: a naive list `dedup()` over blob equality is unsound,
because `foldMember` makes the typed-`{t,v}` vs bare member encoding a **runtime, per-relation**
decision — two logically equal lists from different producers can be different JSONB blobs.

## 8. The plan, ordered by evidence

**0 — Two oracles first. ✅ LANDED as ONE instrument (`test/census/`).** The L5 *differential* is
structurally blind to refactor regressions: it compares two lowerings, so a defect in both is
invisible. Oracle 2 (metamorphic laws, `fa6c0aa`, `laws.ts`) mitigates a different axis — 19
semantic identities, not "this traversal returns what it returned yesterday" — so it does not
substitute. And 873 of 2,298 corpus traversals do not execute: a 38% surface no oracle touches,
where every silent-`[]` defect in the record has lived.

P1 and P2 were specified as two artifacts; they shipped as one, because **executing a traversal
surfaces its compile failure anyway**, so one pass yields both halves for 11s instead of 17.5s and
strictly more information — the transition that matters most (*used to fail closed, now returns
rows*) is only visible when both facts live in one record. Measured at the baseline: 1,425 `ran`,
475 `deferred`, 381 `unbound`, **17 `crashed`**. Determinism was the gate on the whole approach and
was verified over 7 runs including separate processes, plus a `reverse_unordered_selects` planner
perturbation. Two corrections the probe forced:
- **Sorting the outer multiset is NOT order-immune.** When `fold()`/`cap()`/`group()` collapses a
  stream to one traverser, member order lives *inside* its GraphBinary buffer — 50 traversals are
  order-sensitive this way. `ms` gates; `ord` is telemetry (356 move under perturbation, so gating
  it guarantees a suite that flaps on a Bun bump).
- **A bare `compile()` is the wrong instrument** — it resolves no service registry, so all 12
  `call()` traversals would have been committed as false deferrals.

Both gates were verified against a *real* injected regression, not a doctored artifact: an
artifact edit can only simulate a gain, never a loss.

**1 — Free deletions. ✅ LANDED** (`19f5b34`, `283453e`, `4c5ce5c`). All four, each verified by the
census not moving from 1425/475/381/17:
- `ValueType = Exclude<CanonicalType,'list'|'map'|'set'>`; all five adapter names deleted. Owning
  it in `gremlin/types.ts` also broke the latent `types.ts → render.ts → storage.ts → types.ts`
  cycle. One care point: a naive `vt as ValueType` in `vtypeToValueType` would let a stored
  `'list'` reach `frameValue`, fall off its deliberately non-exhaustive switch and return
  `undefined` as a `Buffer` — a corrupt frame with no throw. Guarded with `isCollectionType` +
  `hasSerializer`.
- `Shape{kind:'count'}` deleted, scoped to the Shape arm — `ScalarStream.result === 'count'` is
  separable, and all five of its producers already pass `'long'`, which is *why* the arm was
  redundant.
- Element kind unified to `'vertex'|'edge'`, `ElemShape = Elem | 'property'`. 13 of the 17 bridge
  ternaries were then identities and are gone; the 4 survivors are genuine narrowings.
  **The persisted `property_fts.owner_elem` seam held** — minted only by `sqlElem()`, pinned by a
  test written *before* the rename, because that failure mode (pre-existing rows say `node`, new
  code queries `vertex`, every TextP predicate returns `[]` with no error) is invisible to the
  census, which seeds a fresh graph each run.

Two defects fixed in passing: `outV()`'s deferral read "not a node", and `group.ts`'s element-key
path silently collapsed `ElemShape`'s `'property'` arm to a vertex rather than failing closed.

**2 — Make `Carried` total.** The largest measured category (33%), still firing (`4cefade`,
2026-07-28: `repeat()` emitting `1 AS bulk` without declaring it).

> **STALE as of 2026-07-29 — the construction is DONE; what remains is deployment.** This section said
> the designated authority "does not exist, defined nowhere in `src/` **[verified]**". It exists as
> **`mergeLayouts`** (`steps/context/context.ts:269`) — the name changed in the 2026-07-29 rename, so
> the original grep was correct about `mergeCarried` and wrong about the concept. `carryThrough` exists
> too. The live work is the remaining deployment + the ONE assertion extension, tracked as item 18 in
> [outstanding-work](./outstanding-work.md); read it there rather than re-deriving from this paragraph.
> Note also that `mergeLayouts` deliberately has one caller — `steps/tail/variant.ts` documents why a
> child-scoped arm cannot satisfy its rigid-role assertion. **Do not weaken that assertion to make a
> call type-check.**

The seven non-alias roles are merged ad hoc across four merge builders, the
child rejoin, the keyed relation and the recursive term. `carriedWith` (the total, role-naming
helper) has 31 call sites against **109 hand-written `...carried` spreads** **[verified]**,
concentrated in `steps/tail/`. Convert the spreads so each survivor must *say* what it drops; extend
`assertStreamColumns` to check declared roles against present columns.

**3 — The matrix ratchet. ✅ BUILT** (`test/L5-properties/capability.test.ts` +
`capability-baseline.ts`, 2026-07-29). It is oracle #4 from the L5 design doc, which still lists it as
unbuilt. For every `(shape, transition)`, synthesize a witness and classify: compiles / throws a
**declared** deferral / **anything else fails the gate**. That third case checks the fail-closed claim
itself for the first time. Ratchet discipline copied from `known.ts`. **Still open, and now cheap
because the ratchet exists:** generate the per-step shape strip into `feature-support-matrix.md`, whose
legend claims a ✅ step works *"anywhere in a traversal"* — which item 5c falsifies for ~35 steps.
Keep the L5 lattice independent (`shape.ts:11-18`); reflecting it out of the dispatch maps would
define validity as "what we already support".

**4 — Name the cardinality axis, then share row-ops** (§7). Only after naming it. **The axis is now
NAMED** (`RelationalCardinality` / `cardinalityOf`, `steps/context/stream.ts`) and has exactly one
consumer, so the gate is open and the sharing is the live work — tracked as item 17 in
[outstanding-work](./outstanding-work.md), where the matrix is measured at 55/100 gaps. The
variant/record `ORDER BY` half landed (`variantSlice` passes `orderByEncounter: true`); **pinning each
newly-deterministic result in an L4 `.feature` did NOT** — a shipped semantic still unspecified.

**5 — The IR-shape question as an experiment, not a design. ✅ RAN, and the answer is NO — do not
re-propose it.** `shape-annotation.test.ts` measured **56.8% ⊤ against a 10% kill criterion**, so the
classifiers stay in `steps/`. The committed-in-advance kill criterion did its job; §9 records this as
settled. Original design, for the record: a **test-only** oracle (~150 lines,
zero `src/` changes) reusing the existing classifiers, over L1 + L5's generated set, reporting
soundness (must be 0) and ⊤-rate, with the kill criterion committed *before* the run. Under ~10% ⊤ →
hoisting the classifiers into `ir/` is viable (nearly free: `ir/` imports nothing from `steps/`
today, and the only obstacles are one 16-name `Set` and ~35 lines of frame types; the precedent is
`ALWAYS_PRODUCTIVE_TERMINAL`, `ir/productivity.ts:5-13`). Above → kill it and record the number.
Independently: add the anchor rule as a **type-level** prohibition on shape-dependent Passes — ship
only the half the compiler enforces, because this repo already has the receipt where
`FastPath.equivalentWhen` was made a required non-empty string and *"the claim behind it had never
been checked."*

## 9. Do NOT relitigate

- **The cross-layer shape algebra as a whole-repo refactor.** Targets 6% of defects, structurally
  cannot see the 33%, and the R1 arithmetic (hundreds of mechanical conversions to remove a handful
  of indirections) reproduces almost exactly. Its individual deletions are excellent and are step 1;
  the algebra waits until a new shape is actually landing through the child seam.
- **A typed core IR.** §6.
- **Merging `Stream` into `Shape`.** `Stream` is a capability partition holding a live `Query`;
  `Shape` rides in `Compiled` into the handler. Merging drags the SQL kernel into the wire layer.
  The real residue is the six orphan `Shape` kinds serving `ResultStream` (8 `toResultStream` call
  sites) — retiring *that* is finishing a migration, and it has zero corpus demand today.
- **Widening `ChildShape` to `'map'`.** Converts a clean deferral into a wrong answer.
- **Organizing item 5c by parent shape.** The measurement (84 parent-shape failures, above 5c's 67,
  and a lower bound) sorts by *mechanism* — set drift, shared row-ops, `ResultStream` residue,
  genuinely-per-step — and those cut across parent shapes. "One parent shape at a time" does four
  unrelated kinds of work at once and leaves each mechanism half-done in six other shapes.
- **Any coercion not triggered by an explicit language marker.** `order()` over a list value must
  stay a deferral: `order(Scope.local)` reorders members, bare `order()` orders the stream of list
  traversers. `PATH_LIST_OPS` (`path.ts:344-348`) is the reference implementation, and its
  *exclusion* list is the reason it is correct.

## 10. Honest caveats

- Most of step 2 will show **L3 delta = 0**. That is exactly why step 0 comes first: with the
  current instrumentation, "behaviour preserved" is indistinguishable from "20 deferrals quietly
  became wrong answers". If we are not willing to build P1 and P2, we should not do step 2 — or any
  of the others.
- The ⊤-rate in step 5 is **unmeasured**. The prior is that it will be higher than expected
  (`call()`'s shape comes from the registry, which is not on `PassContext`; `match()`/`repeat()` are
  already opaque in `analyze()`), which would kill the idea — a fine outcome.
- `outstanding-work.md` item 5c's *count* and *family split* should be re-filed against the
  measurement in §7, but the index is left unchanged here pending that decision.
