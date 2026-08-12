# `ScalarType` as a pattern — the one vocabulary refactor that paid, and how to reuse it

**Status: retrospective, 2026-07-28. No code change.** Distilled from
`archive/2026-07-25-type-channel-unification.md` (the migration that landed it) and §5 of
`2026-07-28-shape-vocabulary-architecture.md` (the measurement that vindicated it). Those two
docs hold the narrative; this one states the *pattern* so the next vocabulary cleanup can copy
it deliberately rather than rediscover it. Line citations and counts re-verified against `82992c7`
(several of the shape doc's had drifted since `fa6c0aa`, and one of its findings has since been
fixed — see the `Carried` item).

**Names here predate the 2026-07-29 rename** (`Carry`/`Carried` → `LoweringState`/
`TraverserLayout`, `PStep` → `IRStep`, and the whole `carry*` family). The measurements below are
dated and left as they were taken; decode them with the rename map in
[tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md).

## Why this one gets held up

`ScalarType` (`sql/kernel/render.ts:126-133`) is the only cross-file vocabulary unification in this
repo that landed **and** killed a bug class — 31 files, 4 commits (`78e2508`, `bc212ca`, `6997533`,
`715ba07`). That matters because the base rate here is bad: structural need predicted forward from
an architecture sketch has been falsified by measurement roughly twelve times
(`2026-07-28-shape-vocabulary-architecture.md:164-180`) — the uniform `{t,v}` envelope was built
and reverted at a cost of 15 tests, "Mode C" flat accumulation was retracted after 14 probes, four
predicted new substrates turned out to be one-line unlocks.

So `ScalarType` is not held up because it is tidy. It is the receipt that a vocabulary refactor
*can* pay here, and the shape doc names it as one of exactly three mechanisms that killed real
defects — alongside `assertStreamColumns` (a runtime contract) and `rebuildScalar` (a named
preserving rebuild). All three ship together in this pattern; see rule 5.

The second reason it is singled out (`:36`): it is the only vocabulary in the codebase that
**separates the logical question from the physical encoding**.

## What it replaced

Two optional fields on `ScalarStream` plus an implicit third case:

- `as?: ValueType` — one compile-time tag for the whole stream (from a cast or literal).
- `vtype?: string` — the NAME of a per-row column holding the canonical type the write channel
  recorded. The only channel that can describe a HETEROGENEOUS stream.
- neither set → infer from the JS value at framing (`anySerializer`).

> Two optionals plus an implicit third means a step author must remember three things, so they
> remember one.

That is not a hypothesis, it is the shape of every bug found in the area: fold (`barrier.ts`),
aggregate (`sideeffect.ts`) and the groupCount key (`group.ts`) each propagated `as` and dropped
`vtype`; root `dedup()` hand-rolled its projection and dropped it (`a9393dd`); `inject.ts` compared
a `CanonicalType` against a `Set<ValueType>` (`853a416`).

## The seven properties worth copying

**1. Totality replaces optionality.** One union, three cases the compiler forces you to handle. The
"forgot a channel" class does not survive it, because there is no second channel to forget.

**2. The unknown is a member, not an absence.** Naming the "no statically-known type" case keeps
the model total — an absent field could not carry the next distinction.

> **Correction, 2026-08-12.** This property originally claimed `unknown` is *reachable ONLY from the
> JS-client seam*, and therefore "deletable if the client is fixed". That is FALSE and was refuted by
> `refs.ts UNKNOWN` (45 `src` references): `unknown` is the compiler's BOTTOM, produced at ~30 lowering
> sites — a `sack()` value, an untyped `group()`/`select()` key, a transform's output, a value read
> with no `vtype` channel, a lattice join over disagreeing arms. Fixing a client would not remove any
> of those. The JS-client seam is the one *inbound* source of a genuinely type-lost value — a UUID the
> JS GLV sends as a bare string, JS having no UUID wrapper class (a datetime does not lose type: JS has
> `Date` → GraphBinary DATETIME; and the `UUID(...)`/`datetime(...)` literal constructors carry the
> type too) — not the only source of the variant. The corrected authority is the `ScalarType` comment
> in `render.ts`. The pattern point still stands: a member beats an absent field precisely because it
> *can* be reasoned about like this.

**3. Compile-time property, free physical encoding.** The type is uniformly KNOWN either way;
whether it rides bare, as a sibling column, or in a `{t,v}` envelope inside a JSON blob stays a
per-site choice. Conflating the two IS the reverted dead end
(`archive/2026-07-25-type-channel-unification.md:78-101`): always-wrapping breaks the list transforms,
because `ORDER BY` over `{"t":"int","v":5}` string-orders JSON.

**4. The fine case records what it is a case OF.** `perRow` carries a *column name*, so a
heterogeneous stream is expressible at all. The two vocabularies that omit their member content
both have logged bugs from exactly that: the L5 lattice (`list` not recording what it was a list
of → emitted `fold().sum(local)` over vertices) and `AliasShape` (`outstanding-work.md` item 1 — a
path/element-list label cannot frame its members as vertices). Two independent confirmations of one
mechanism.

**5. It shipped with a bridge, then deleted the bridge.** `scalarType(as?, vtypeCol?)`
(`render.ts:138`) encodes the priority rule ONCE — *the per-row column is the truth channel, so it
beats a compile-time tag* — which made step 1 of the migration behaviour-inert. Deleting the
derived accessors afterwards is what made the compiler enumerate every remaining site. Migrate
under a bridge; delete the bridge to get your worklist.

**6. Lossy projections are named once, not inlined.** `staticTypeOf`, `perRowColumnOf`,
`perRowCols` (`render.ts:144-154`) — one accessor per consumer *class*: "I can only act on a
compile-time type", "I need the column name", "I need the physical columns this adds to a
projection". No consumer re-narrows with an inline `.kind ===` chain.

**7. The derived rule became statable once.** `scalar.ts:170`:

```ts
const outType = transformed ? scalarType(as) : s.type;
```

*A transform RETYPES its output; a pure `is()`-only segment preserves the channel it was handed.*
One line, replacing reasoning about an interaction of two fields.

## The pattern, as rules

1. **N optional fields answering ONE question → one union with N+1 cases.** The implicit case
   becomes a member (property 2).
2. **One question per vocabulary.** The shape doc's diagnosis is that "shape" does three jobs under
   one word — *what Gremlin object is this traverser* (L), *which relational columns hold it* (P),
   *how does the framer turn rows into buffers* (W). `Shape` answers L+W, `Stream.kind` answers
   L+P, and the N:M mismatch between them IS the P-vs-W confusion. `ScalarType` answers exactly
   one.
3. **The finest representation must record what it is a case of** (property 4). Coarse projections
   are DERIVED from the fine one — never the other way round, and never by merging two fine ones
   together.
4. **Ship the coarse views as named accessors** (property 6). A consumer that narrows inline is a
   consumer that will narrow differently next time.
5. **Totality alone is not enough — pair it with a named preserving rebuild and a runtime
   contract.** A total union still rides in a `{...spread}` that can drop it. `rebuildScalar`
   (`stream.ts:392`) exists because "same traversers, new relation" was spelled out longhand at
   ~15 sites; naming it means the preserving case CANNOT drop a channel and a non-preserving site
   has to say so. `assertStreamColumns` (`stream.ts:345`) caught the complement during the
   migration: a merge that cannot carry a per-row type must degrade to `unknown` explicitly rather
   than claim a column the relation lacks.
6. **Verify by measurement, not by design.** The migration's gate was L3 + the `test.todo`s in
   `test/typed-collections-e2e.test.ts`, which were written as the specification first. Step 1 of
   the shape doc's plan used `test/census/` the same way (four deletions, each verified by the
   census not moving from 1425/475/381/17).

## What it does NOT license

`ScalarType` succeeding is not an argument for the cross-layer shape algebra as a whole-repo
refactor. That targets 6% of measured defects and structurally cannot see the 33%
(`2026-07-28-shape-vocabulary-architecture.md:138-156`, §9). **The burden on a structural proposal
here is a measurement, not a design** — this pattern tells you how to execute one that has already
cleared that bar, not how to clear it.

Two specific non-targets, for the same reason `ScalarType` worked (rule 2 — ask what question the
vocabulary answers):

- **`Stream` is not a shape vocabulary, it is a capability partition** holding a live `Query`.
  `ForeignStream`/`PropertyStream` are deliberately not `ElementStream` so that movement over them
  is structurally unreachable.
- **`Elem` and `ElemShape` answer different questions** — a storage-table selector versus a
  wire-framing selector. Different member sets, not two spellings.

And one prerequisite: **row→traverser cardinality has to be NAMED before row-ops are shared**
(shape doc §7). `group.ts` `COUNT(DISTINCT gk)` and `path.ts` `COUNT(DISTINCT pk)` are not drift —
a grouped `PathStream` has one row per *position*, so `COUNT(*)` would count positions. Spreading a
shared `countRows` blind produces wrong answers, not free coverage. That is rule 2 applied to the
axis the current vocabulary is silent about.

## Where to apply it, ordered by evidence

**1. `Carried` — the largest measured category (33% of defects), still firing (`4cefade`).** The
analogue here is rule 5, not rule 1: the roles are already a struct of typed roles on purpose
(`context.ts:118-126`).

**Its designated authority `mergeCarried` now exists** — `context.ts:233`, landed in `82992c7`,
after the shape doc recorded it as cited-but-undefined. It is worth reading as a live confirmation
of rule 5 rather than a closed item, because its own rationale comment is the pattern's argument
verbatim: the element merge and the scalar merge each grew the alias union independently, and the
list and variant merges never grew it at all, so
`g.V(1).union(__.as("x").out().fold(), __.as("x").in().fold()).select("x")` returned 0 rows where
the element-shaped twin returns 3 — *"a silent empty result, which is the failure mode this project
treats as worse than a crash."* An authority nobody had written, exactly where the pattern says the
next dropped channel will be.

What is left of step 2 on this base:

- `mergeCarried` merges `aliases` and `path` and *asserts* the remaining rigid roles agree
  (`rigidCols`, throwing a declared deferral when an arm binds new sack/origin state). So the alias
  role now has a single authority; the other roles are validated rather than merged, and
  `variant.ts:68` documents a deliberate non-use (child-scoped arms already re-homed onto the
  parent, where the rigid-role assertion would be false).
- **`carryThrough` — the `rebuildScalar` of this channel — still does not exist**, and that is the
  half of rule 5 that addresses the measured defect: `carriedWith` has **32** call sites against
  **104** hand-written `...carried` spreads (re-measured at `a4c7a23`; the shape doc's 31/109 was
  the `fa6c0aa` count). Convert the spreads so each survivor must SAY what it drops, and extend
  `assertStreamColumns` to check declared roles against present columns.

**2. Finish `ScalarType` itself.** Still on the raw `as?: ValueType`: `ListOf.scalar`,
`Shape.variant`, `Shape.list`, `Shape.jsonbList`, `VariantStream.scalarAs`, `AliasEntry`, and
`TypeCtx` (`plan.ts:151`, whose own comments spell out "staticAs / vtypeExpr / neither" — the
two-optionals-plus-implicit-third pattern verbatim, in the one place that already knows it is a
three-way decision). The strongest single case is `MapEntry{sub:'value'}`, which carries **no type
channel at all** and whose `recordFieldColumns` emits only `${prefix}_v`, so a sibling vtype column
is not even possible: `project('x').by('someUuid')` frames by JS inference while the same value via
`values()` frames exactly. That is an observable inconsistency, not a tidiness argument.

**3. `Shape.variant` and `Shape.jsonbList` — textbook rule 1.** `render.ts:168` has five optionals
and **zero required fields**. `render.ts:171` has three mutually-exclusive item-type channels
(`as` / `typed` / `of`) that `execute.ts:603` reconstructs into a fourth
(`shape.of ?? {kind:'scalar', as: shape.as, typed: shape.typed}`) — the reconstruction is the proof
that one union was wanted.

**4. `AliasShape` — rule 3, the confirmed-twice failure.** Record the member shape.

**5. The front-end's 14 ad-hoc tagged tokens** (`frontend.ts` `walkArgs`), 12 with no declared type
anywhere and detection by `'tag' in a` at every consumer — rule 4: `{gtype}` unwrapping is
re-implemented at **7** sites (verified), and `{order}` is scanned inline at 7 despite `classifyBy`
(`child-shape.ts`) existing to centralise exactly that. Declare the union, one guard, one accessor.

Other optional-field grab bags the pattern fits, lower priority because no defect is filed against
them: `ScalarCtx` (`plan.ts:402` — a 3-way discriminant with 10 optionals, read with `!` at 5+
sites) and `IRStep` (`ir/step.ts` — 7 optionals, each owned by one pass).

## Caveat

Most of the above will show **L3 delta = 0**, which is exactly why the census exists: with weaker
instrumentation, "behaviour preserved" is indistinguishable from "20 deferrals quietly became wrong
answers". Rule 6 is not optional garnish — it is the only reason the four step-1 deletions could be
called safe.
