# One type channel — collapsing `as` + `vtype` into a single scalar type

**Status: designed, partly landed (2026-07-25).** Three fixes landed standalone (below); the
unification itself is scoped and NOT started. Read the "dead end" section before writing code —
the obvious fix was implemented and reverted, and the reason is structural.

## The question that framed it

> *If we fixed every type problem so it was completely uniform, would we ever have code paths
> that are untyped? And if not, wouldn't that be simpler? And how would storage types interact?*

Working through every source of a value, exactly one is irreducibly unknown:

| Source | Type known? | From |
|---|---|---|
| Stored property | always | `vtype` column (written from the wire/parse channel) |
| Typed literal `datetime(…)`, `5L` | always | ANTLR-parsed subtype |
| Bound param, typed GLV | always | GraphBinary DataType byte |
| `count()`/`sum()`/`id()`/`label()`/`math()` | always | statically known from the step |
| **Bound param from a JS client** | **never** | JS cannot distinguish UUID from string |

So the answer is yes — with one caveat that turns out to be a feature: the JS-client case is an
**unknown** type, not an *absent* one. Making `unknown` a member of the type vocabulary (rather
than a missing field) keeps the model total: every value has a type; sometimes that type is
"we don't know, infer at the wire", which is exactly today's behaviour, named.

## Why uniform is simpler, concretely

Today there are three channels and every barrier must decide which to propagate:

- `ScalarStream.as?: ValueType` — ONE compile-time tag for the whole stream (from a cast).
- `ScalarStream.vtype?: string` — the NAME of a per-row column holding the canonical type the
  write channel recorded. The only channel that can describe a HETEROGENEOUS stream.
- implicit "no tag" → infer from the JS value at framing (`anySerializer`).

Two optional fields plus an implicit third means a step author must remember three things, so
they remember one. That is not hypothetical — it is the shape of every bug found in this area:

- `barrier.ts:37,56` (fold), `sideeffect.ts:~111` (aggregate), `group.ts:~519` (groupCount key)
  each propagate `as` and drop `vtype`.
- `scalar.ts` root `dedup()` hand-rolled its projection and dropped `vtype` (**fixed**, `a9393dd`).
- `inject.ts` compared a `CanonicalType` against a `Set<ValueType>` (**fixed**, `853a416`).

One field with three cases the compiler FORCES you to handle removes the class:

```ts
type ScalarType =
  | { kind: 'static'; type: CanonicalType }   // a cast, a literal, count()→long
  | { kind: 'perRow'; column: string }        // the stored vtype column — heterogeneous-safe
  | { kind: 'unknown' };                      // JS client dropped it; infer at the wire
```

`unknown` is reachable ONLY from the JS-client seam. If the upstream client is ever fixed (or the
opt-in UUID/ISO-date shim covers it), the variant becomes unreachable and deletable.

## How storage types interact — the layering rule

`.claude/rules/schema-storage.md` deliberately leaves the `value` column untyped so SQLite's
storage class survives (numeric order/range predicates work). That gives two layers:

- **Storage class** (INTEGER/REAL/TEXT/BLOB) — what SQL *operates* on: ordering, comparison,
  indexes.
- **Gremlin type** (`vtype`) — what the value *means*: framing, `typeOf`, equality.

Storage class is a LOSSY projection of the Gremlin type — `int`/`long`/`bigint≤2^53` all land on
INTEGER; `uuid`/`string`/`char`/`bigdecimal` all land on TEXT. That loss is the entire reason a
type must be carried separately, and it yields the rule the physical encoding should follow:

> **Carry the type explicitly exactly when the storage class does not already determine it.
> Never redundantly; never omit it when the projection is lossy.**

`plan.ts inferVtypeSql` is the authoritative statement of what a bare value CAN recover:
`string`, `double`, `int`, `long`. Everything else — datetime, uuid, bigint, bigdecimal, char,
duration, boolean, byte, short, float — is genuinely ambiguous and must carry its type.

**Uniform typing is a compile-time property; the physical encoding stays free.** The type is
uniformly KNOWN either way; whether it rides bare, as a sibling column, or in a `{t,v}` envelope
is a per-site representation choice. Conflating those two is what caused the dead end below.

## The dead end — do NOT re-try this

The obvious fix: make a container fold self-describing `{t,v}` nodes and set `ListOf.typed`, the
encoding a STORED typed collection already uses (so `compileUnfold` and `frameTypedNode` apply
free). Implemented, tested, **reverted**. Two independent walls:

1. **Always wrapping breaks the list transforms.** The rebuild/transform ops —
   `order`/`dedup`/`limit` under `Scope.local`, and the set-op family
   (combine/intersect/difference/disjunct/…) — read members as BARE SQL values. They fail closed
   on a `typed` list (`assertUntypedList`, `steps/tail/list.ts`) rather than mis-execute. So
   always-wrapping converts working traversals into clear deferrals: **15 tests**, including L3.
   An envelope is not a neutral wrapper — `ORDER BY` over `{"t":"int","v":5}` string-orders JSON.
2. **Wrapping only the rows that need it mixes encodings inside one list**, which the typed
   readers do not handle: `compileUnfold` does `je.value ->> '$.v'` unconditionally, so a bare
   member reads as NULL. Fixing that means changing every typed reader — i.e. this item, not a
   barrier-local patch.

A uniform per-list encoding therefore needs a RUNTIME, per-list decision (the members' types are
in a column, unknown at compile time). That is the unification, and it is why the narrow fix was
stopped rather than pushed through.

## What landed standalone (2026-07-25)

- `07ce78a` — `typedScalarNode(valExpr, {staticType?, vtypeExpr?})`: a caller can now supply a
  per-row vtype COLUMN, not just a literal. Adds `GroupKey.vtypeCol` (unset). Behaviour-inert.
- `a9393dd` — root `dedup()` reuses `payload()`/`cols()` instead of a hand-rolled projection, so
  the per-row type survives. Also corrects the SEMANTICS: `DISTINCT` now spans `(v, vtype)`, and
  equal values of different stored types are distinct Gremlin values (a long `5` and a string
  `'5'` are two traversers). Can only split, never merge.
- `853a416` — a bare `inject(datetime(…)/UUID(…))` keeps its declared type. The comparison was
  across two vocabularies (`CanonicalType` vs `ValueType`), which coincide for five types and
  diverge for `datetime`/`date` — so a typed inject lost its type at the seed and a following
  `is(typeOf(DATETIME))` returned `[]` rather than failing. **L3 1345 → 1347.**
  The correspondence now lives once in `gremlin/types.ts` as
  `VALUETYPE_TO_CANONICAL`/`CANONICAL_TO_VALUETYPE`, `satisfies Record<ValueType, CanonicalType>`
  so the compiler enforces completeness, replacing three hand-written copies (`plan.ts`
  `AS_TO_CANONICAL`, `write.ts` `VT_TO_CANON` — which had silently omitted
  bigdecimal/char/duration — and `inject.ts`'s implicit cast).

## Build order when picked up

1. Introduce `ScalarType` and make `ScalarStream` carry it, keeping `as`/`vtype` as derived
   accessors so nothing else moves. Inert.
2. Migrate producers to set it; migrate consumers to read it. Delete the accessors — the compiler
   then names every site that must decide.
3. Give `ListOf`/`GroupKey`/`Shape{kind:'value'}` the same union (this absorbs the `as?` xor
   `perRowType?` debt item and `GroupKey.vtypeCol`).
4. Make the container encoding a runtime per-list decision derived from the type; the typed
   readers handle one uniform encoding per list.
5. Retire `assertUntypedList` — it exists only to guard the two-encoding split — which lands
   `Scope.local` transforms over typed elements (a transform RETYPES its output; not a special
   case once the type is uniform).

Expect ~8–14 L3 scenarios from step 4 (the `test.todo`s in `test/typed-collections-e2e.test.ts`
are the specification), plus the whole "a new barrier forgot a channel" class going away.
