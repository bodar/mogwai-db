# Side-effect state — `aggregate`/`store`/`cap`, `sack`, `group('a')` (design + plan)

**Status:** LANDED 2026-07-13 (L3 618→634: sack +4, aggregate/cap +8, group('a')/cap +4).
The standalone analysis §12 of the feature-support matrix pointed at (and
`docs/2026-07-12-conformance-structural-bets.md` #3 promised) but never written. This is it
— written as the plan, kept as the record. Note: TinkerPop 4 dropped `store()` (no grammar
rule; `aggregate(Scope.local)` replaces it), so Stage 2 is `aggregate` only.

The one genuinely-new execution notion left: **state that is not the current
id-relation.** Everything so far is one id-relation flowing through CTEs. Side-effects
are *named collections* that outlive the current relation and are read back later; a
`sack` is a *per-traverser scalar* that rides alongside the id. Both stay inside locked
#3 (compile to SQL, never interpret) — one `WITH … SELECT` statement, no interpreter.

## Two mechanisms, one home (`Carry`)

Both new pieces are new fields on `Carry` (`src/steps/context.ts`), threaded through the
fold and preserved across retypes (`carryOf`, `stream.ts`).

```ts
export interface Carry {
  // … existing: q, aliases, indexKeys, params, path?, origin?
  readonly sack?: string;               // sack: the carried scalar column name (e.g. 'sk')
  readonly sideEffects?: SideEffectMap; // named side-effect registry
}

export type SideEffectDef =
  | { kind: 'list'; rel: Relation; of: ListOf }   // aggregate/store → a JSONB list CTE
  | { kind: 'group'; src: GroupSource; isCount: boolean; bys: any[][]; indexKeys: string[] };
export type SideEffectMap = ReadonlyMap<string, SideEffectDef>;
```

- **Side-effects** are a *registry*, sibling to `aliases` — a name → its materialized CTE
  handle (aggregate/store) or a stashed group-spec (group('a')). NOT a per-row column.
  Registered where the step appears (may be mid-chain), read at `cap`. Each lives as an
  extra CTE in the one shared `Query`, so the whole thing is still one SQL statement.
- **`sack`** is a *carried column*, sibling to `origin`/`path` — threaded through movement
  CTEs by the existing `carryFrag`/`carriedCols`/`advance` plumbing. `advance` gains a
  `sack?: string | null` opt (set/keep/clear, same tri-state as `origin`).

`carryOf` and `advance` must both preserve the two new fields (advance already spreads
`...st`; add `sack` to its opts and `carryOf` to its projection).

## Why it stays one SQL statement

- `aggregate('x')` mints a JSONB-list CTE (`jsonbGroupArray`, exactly like `compileFold`)
  and registers it under `'x'`; the main stream continues **unchanged** (pass-through).
- `cap('x')` (terminal, or `cap('x').unfold()`) looks the name up and produces a
  `ListStream` from the stashed CTE → `dispatchNext` → `compileFromList` (§9). **cap
  composes with the list substrate for free — zero new list code.** `cap('x').unfold()`,
  `cap('x').sum(local)`, plain `cap('x')` framing all already work.
- `group('a')` is a **pass-through barrier**: it stashes the group-spec (source relation
  + ctx + bys) and returns the stream unchanged; `cap('a')` re-runs `compileGroup` over
  the stashed source → the existing `{kind:'group'}` Shape → `groupBuffer`.

## Framing: no new serializer

Conformance asserts `l[v[..]]` (List) and `m[{..}]` (Map). Reuse `listBuffer`/`jsonbList`
and `groupBuffer`. The client ships **no BulkSet serializer and none is needed** — a
capped aggregate frames as a List (multiset), a capped group as a Map. `aggregate`
(eager BulkSet) and `store` (lazy list) are set-identical in a single pass and **compile
identically**; they differ only in mid-traversal incremental visibility, which is the
deferred-readback line below.

## Deliberately deferred (fail closed)

- **All mid-chain readback predicates** — `where(within('x'))`/`where(without('x'))`,
  the `aggregate('x').by(k).where(without('x'))` dedup idiom. This is exactly where
  eager/lazy diverge; a set-based join can't honour incremental visibility. Clear throw.
- `sack` through `repeat()` (needs the sack col in `walkCols` + the recursive term),
  `withSack` split/merge operators (fork/bulk), `sack(BiFunction)` lambda form.
- `withSideEffect(...)` + the `sideEffect(__.…)` step (SideEffect.feature) — a side
  mutation, not a collection; defer initially.
- multi-key `cap('x','y')` (a Map of side-effects) — defer to a follow-on.
- `cap('a').unfold()` where `'a'` is a **group** (Map-unfold) — gated on Map-unfold (§9).

## Frontend prerequisites (all small)

1. `withSack(init[, splitOp, mergeOp])` is dropped today (`frontend.ts:69` skips
   `TraversalSourceSelfMethod`). Add `extractSack(tree)` mirroring `extractStrategies`,
   returning `{ initialValue, mergeOp?, splitOp? } | null`; thread `initialValue` to
   `seedSource`/`seedUnion` (seed `<init> AS sk`, set `sack:'sk'`). split/merge → defer.
2. `TraversalOperatorContext` (`Operator.sum/minus/mult/div/min/max/assign`) has no
   `walkArgs` case (`frontend.ts:152-231`) — add `{ operator: enumSuffix(node) }`, so
   `sack(Operator.sum)` is distinguishable from bare `sack()`. Same class of bug the
   other enum tokens (Column/T/Pop/…) were fixed for.
3. `aggregate`/`store` → `BY_HOSTS` (`strategies.ts:32`) so `.by(k)` folds onto them.
4. `group('a')`/`groupCount('a')`'s string arg (`args[0]`) is parsed already — the
   compiler just needs to read it (today `compileGroup` ignores it).

## Dispatch changes

- **`sack(op).by(k)`** → a PREFIX `StepFn` (element→element, mutates the carried column):
  `advance` with a body projecting `<op>(p.sk, <by-value-of-current>) AS sk` + the other
  carried cols. The by-value resolves via `propExtract`/`compileNestedScalar` on the
  current element. It hand-rolls its SELECT (replaces `sk`), so — like the `ORIGIN_UNSAFE`
  steps — it excludes `sk` from `carryFrag` and re-appends the new expr.
- **bare `sack()`** (read) → a tail projection in `compileTail`: `SELECT sk AS v`,
  `{kind:'value'}`. Requires `st.sack` to exist (else clear throw).
- **`aggregate`/`store`** → PREFIX `StepFn`s (pass-through): build the list CTE, register,
  return `st` with the extended registry, `last` unchanged.
- **`group('a')`/`groupCount('a')`** → PREFIX `StepFn`s **guarded** on a string arg. In
  `foldBody`, mirror the choose/options guard: a `group`/`groupCount` WITHOUT a
  side-effect key `break`s (falls to the terminal tail barrier, unchanged); WITH one it
  dispatches to the registering StepFn. `.bys` already folded on (group is in BY_HOSTS).
- **`cap('x')`** → handled in `compileTail`: look up the registry; a `list` def →
  `ListStream` → `dispatchNext`; a `group` def → `compileGroup` over the stashed source.
  Missing key → clear throw.

## Build sequence (staged commits on one branch)

Each stage lands independently, ratchets L3, keeps corpus 100%, adds its cucumber tag(s)
to `tags.ts`, and ships SQL snapshot tests.

**Stage 1 — `sack`** (~29 scenarios). Carried column; the smaller, fully separable half.
`Carry.sack` + `advance`/`carryOf`/`carriedCols` plumbing; frontend `extractSack` +
`TraversalOperatorContext`; `sack(op).by(k)` StepFn; bare `sack()` tail read; seed via
`withSack`. Defer: repeat, split/merge, BiFunction.

**Stage 2 — `aggregate`/`store` + `cap` (list side-effects)** (~57 + list-cap scenarios).
`Carry.sideEffects` registry; `aggregate`/`store` StepFns (reuse `compileFold`'s
list-build, factored to a shared helper); `cap('x')` → ListStream → §9 substrate;
`BY_HOSTS` += aggregate/store. Defer: within/without, multi-key cap.

**Stage 3 — `group('a')`/`groupCount('a')` + `cap` (Map side-effects)** (SideEffectCap's
dominant idiom + Group/GroupCount side-effecting rows). `foldBody` string-arg guard;
group/groupCount registering StepFns; `cap('a')` → `compileGroup` over the stashed
source. Defer: cap-unfold of a group (Map-unfold), composite side-effecting keys beyond
what `compileGroup` already does.

## Testing

- SQL snapshots for each new step (sack mutate/read, aggregate list CTE, cap→list,
  group('a')→cap Map).
- Cucumber tags per stage: `@StepSack`, `@StepAggregate`/`@StepStore`, `@StepCap`,
  and the side-effecting `@StepGroup`/`@StepGroupCount` rows (baseline ratchets up).
- Corpus stays 2298/2298 parse+chain.
- Update `docs/feature-support-matrix.md` §12 (and §4 `group('a')`, §13
  ProductiveByStrategy gate) in the same commits.
