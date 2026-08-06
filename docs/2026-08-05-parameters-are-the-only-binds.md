# Parameters are the only binds — a value that changed layers, not an optimisation

**Status: DESIGN / PROPOSAL.** Supersedes the framing of the constant-SQL-hygiene campaign
(`docs/archive/2026-08-05-compiler-constant-sql-hygiene-plan.md`) and reverses a locked decision
(`docs/2026-08-01-relir-build-plan.md` §3.4, "no `Param` node"). Written to be reacted to whole,
not yet actioned.

## The thesis

A SQL **bind exists to carry a user-supplied parameter** — a GValue the client sent over the wire in
the `bindings`/`parameters` map. That is the whole contract. It is the user's *strongest signal of
intent*: "this value is really variable and I expect it to change." A parameter is therefore a
**product concept**, and a product concept deserves a faithful representation at every layer it
crosses — wire → IR → plan → rendered SQL — not a bit that is inferred at one layer, destroyed at the
next, and re-guessed at the last.

Everything else that today becomes a bind is either a **constant the compiler already holds** (a
parsed literal, a structural ordinal, a class name, a JSON path) or a **value the compiler could not
spell as a literal** (a collection, a big-decimal tail). The first should be inlined as a typed SQL
literal and never touch the bind budget. The second is a mechanical necessity that is *not ideal* and
should be named as its own category, not smuggled in alongside real parameters.

## Why this is not "premature optimisation" and not "provenance tracking"

Two objections to pre-empt, because both were raised while reaching this design and both are wrong.

- **"Inlining a literal defeats the statement cache."** The statement cache is not ours to farm. It
  is the *payoff the user opts into* by sending a GValue. If the client wrote a literal `30` in the
  Gremlin string, it declared a constant, and minting a distinct cached statement per literal is the
  correct, requested behaviour — the same as any other compiler that constant-folds. We do not
  manufacture binds to serve a cache the user did not ask for.
- **"Keeping parameters as binds requires tracking where a value came from."** No. It requires *not
  destroying* a concept the wire layer already carries perfectly. `wire.ts:102–111` decodes the
  binding map into `params` **and** keeps each parameter's typed identity in `paramTypes`. The
  concept is intact and typed right up to one seam — `frontend.ts:415` — where `stepChain` resolves
  `$x` into `params[name]` and **drops the name**, flattening a parameter into a plain value
  indistinguishable from a parsed literal. That flattening is the single point of loss. Undoing it is
  not adding provenance; it is deleting a lossy step.

## The budget leak this fixes (the user-visible defect)

The DO caps a statement at **100 bound parameters**. In the ideal world that is a clean platform
fact a user can reason about: *you may use up to 100 parameters.* Today it is not, because the bind
list is polluted by binds the user never asked for — a parsed literal, an `as()` label, a storedValue
class list, an arm ordinal. So whether a user hits the wall **depends on which unrelated features
their query happens to use**, a coupling they cannot see or predict. Making parameters the only
"free-standing" binds restores the clean fact: the 100 budget is 100 *parameters*, minus only the two
named mechanical exceptions, which we then work to remove.

## The three categories (replacing the two-way `lit`/`compiler*` split)

The RelIR `Lit.source` union (`src/rel/expr.ts:9–12`) is where the current conflation lives:
`source: 'bound'` means *both* "user parameter" *and* "query/store data that needed a bind." Split it.

| Category | What it is | Renders as | Budget |
|---|---|---|---|
| **Parameter** | a wire GValue (`$x` in the binding map) | a bind (`?`) | counts against 100 — *this is what the 100 is for* |
| **Constant** | a parsed literal, an ordinal, a class name, a JSON path, an `as()` label — any value the compiler holds at compile time | a **typed** escaped SQL literal | zero |
| **Oversized** | a value that cannot be a literal: a collection `{t,v}` tree, a big-decimal / duration / >2⁵³ tail | a bind (`jsonb(?)` / decimal-TEXT) | counts today — *the leak we want to close* |

"Constant" is decided by **where the value entered**, exactly as the archived plan already said ("the
source is the rule, not the apparent value"), with one correction: the source it keys on is not
"compiler vs query" but **"parameter vs everything the compiler holds."** A parsed literal is a
constant even though it came from the query string, because by compile time the compiler holds it and
knows its type.

## The type is already known — stop throwing it away

The claim that inlining loses storage-class fidelity is false. The parser records every argument's
canonical Gremlin type in lockstep (`frontend.ts:33–39`, `Step.argTypes`), and after
`coerceBindValue` (`gremlin/types.ts:281`) every scalar that crosses the seam is `number | string |
null`. Each maps to a trivially safe, correctly-typed SQL literal (`1`/`0`, an integer or numeric
literal, an `''`-escaped string, `NULL`) whose *storage class follows the literal's syntactic form* —
which we control because we know the type. Yet `operandLit` (`compiler/rel/lower.ts:1770–1773`)
**re-derives** `text`/`real`/`int` from the JS runtime type and discards `argTypes`. That is the
type-preservation work of the whole pipeline being tossed at the final hop, and it is independently a
bug worth fixing whichever way the parameter question lands.

## Where the binds are minted from held constants today (RelIR; legacy is dead, ignore it)

Every site below feeds `lit()` (→ a bind) with a value the compiler already holds. The chokepoint is
`operandLit` plus a handful of direct sites.

- **`operandLit` (`lower.ts:1770`), 5 callers** — predicate operands (`1084`, `1363`), inject rows
  (`1534`), list members (`1570`), `constant()` (`2517`). The general "parsed scalar → bind" leak.
- **`has` key** — `lit(key, 'text')` (`lower.ts:440–441`, `1118`).
- **`V(ids)`/`E(ids)`** — `lit(n,'int')` / `lit(s,'text')` (`lower.ts:529–530`).
- **`range`/`limit`/`tail` counts** — `lit(countArg, 'int')` (`704`), `lit(window.limit, 'int')`
  (`769–770`), range bounds (`823–829`). **These are the sharpest case**: `sliceOf`/`countArg` already
  *read the value to shape the plan* (reject `range(2,1)`, compute `lo + limit`), so the value is
  definitionally a compile-time constant — yet it is then spent as a runtime bind. Pure contradiction.

Correctly-bound data that must stay a bind: `foreign.ts:72` `value(payload)` (a collection),
genuine wire parameters, retained rows.

## What "a parameter at every layer" touches

1. **Front-end (`frontend.ts:415`, `VariableContext`).** Stop flattening. A `$x` reference becomes a
   distinct IR argument shape carrying `{ name, value, type }` — analogous to the existing `TaggedArg`
   union, so `Step.args` stays `any[]` and consumers narrow through a guard (`isParamArg`). This is
   **not** a wire concept leaking into the IR: "this argument is a parameter" is a legitimate IR
   statement, and `argTypes` already sets the precedent that per-parameter typed metadata rides the
   boundary without violating locked-decision #5.
2. **IR value shape.** A parameter arg vs a plain-value arg. Steps that must *compute* on a value
   (`sliceOf`, constant-folding) read `.value` off either — a parameter still exposes its resolved
   value; it is not opaque. (A parameter used as a `LIMIT` count is a design edge — see open
   questions — because the count shapes the plan.)
3. **RelIR `Lit.source`.** Rename/split: `'parameter'` (the only free-standing bind), the existing
   `compiler-*` constant sources, and a new `'oversized'` for the mechanical binds. `emit.ts:122–129`
   grows the arms; `lit()` callers fed by held constants switch to a **typed** compiler-literal
   constructor (the type from `argTypes`).
4. **The hygiene gate (`scripts/sql-hygiene.ts`).** Its `countExpr` already counts by `source`; it
   starts asserting the invariant directly — **a free-standing bind's source is `'parameter'`** — so a
   held constant rendered as a bind fails the build at the site, not as an aggregate regression.
5. **The `oversized` category, ideally, shifts into JSON.** The `json_each` move already used for
   >100-element sets (`plan.ts` `jsonbArrayBind` / `SET_BIND_LIMIT`) generalises: an oversized value
   rides as one JSON bind so it stops competing per-value with the parameter budget. This is what turns
   "100 minus mystery overhead" back into "100 parameters."

## The reference implementation is this exact design (TinkerPop 4 `GValue`)

Checked against `vendor/tinkerpop/gremlin-core` at the pin, not reasoned out.

- **`GValue` (`.../step/GValue.java:36–64`) is a name→value pair that carries BOTH a variable and a
  literal through the same wrapper**; `name != null` means variable (`isVariable()`), `name == null`
  means "provided literally in the traversal." So the parameter-vs-constant distinction TinkerPop 4
  keys on is *the presence of a name* — not provenance, **identity**: a named parameter is a
  first-class thing that knows its own name at every layer. This is precisely "represent the parameter
  at every layer," and it is the reference design.
- **A step begins as a `Placeholder` holding `GValue`s** (`RangeGlobalStepPlaceholder`, etc.) and only
  later collapses to a concrete step via `ProviderGValueReductionStrategy` →
  `GValueHolder.reduce()` (`.../step/GValueHolder.java:29–35`). The strategy's javadoc says reduction
  is *"not an optimization in and of itself"* — it exists so downstream provider optimizations can
  reason about concrete steps, and explicitly: **"Providers hoping to do more advanced optimizations
  that require GValue objects to be present... will need to remove ProviderGValueReductionStrategy and
  offer their own mechanism."** That sentence is addressed to providers like us. Our `frontend.ts:415`
  flattening behaves as if reduction fires *immediately and unconditionally at parse time* — which is
  exactly why we lose the parameter. The fix is to defer reduction to **the last responsible moment**:
  a parameter stays a parameter (a bind) unless a specific lowering genuinely must compute on its
  concrete value, and *that lowering* reduces it, locally.

## `LIMIT` settled: SQL is NOT the obstacle — our arithmetic is

The open question "is a parameterised `limit($x)` forced to inline because SQL forbids a bind there?"
is answered NO, measured on `bun:sqlite`: `LIMIT ?`, `LIMIT ? OFFSET ?`, and even `LIMIT ?+?` all bind
fine. So there is no SQL reason to inline a `limit`/`range` parameter. The *only* reason our lowering
wants a concrete number is that `sliceOf`/`countArg` (`lower.ts:734,750`) do **compile-time arithmetic**
— reject `range(2,1)`, compute `lo + limit`. The generic fix honours the user's bind: **express the
arithmetic in SQL** (`LIMIT ?-? OFFSET ?`) so the bind survives, and reduce a count operand only where
SQL genuinely cannot carry it.

**Where SQL genuinely CANNOT carry it — the one honest reduction site.** `unrollFixedRepeat`
(`ir/passes.ts:107`) replicates a `repeat` body `times(n)` times: `n` changes the *statement structure*,
not a value inside it, so it must be a concrete number. If `times($x)` ever arrives as a parameter, the
unroller is the lowering that reduces it — the textbook "last responsible moment," done by the one pass
that structurally requires it, exactly like TinkerPop's `reduce()`. (Also the `land`/JSON path already
exists as the alternative when even a value set is too big for binds.)

## Resolved answers to the earlier open questions

1. **Parameter in a count position → keep the bind; express arithmetic in SQL.** Only `times(n)`-style
   *structural* uses reduce, and only in the pass that unrolls them. This is the generic version.
2. **The decimal tail — measure whether it can be a TEXT literal.** A canonical-decimal TEXT literal
   (`'123…'`) is spellable and the read path already CASTs; if the CAST-compare holds, `oversized`
   shrinks to just collections. (Making the decimal a JSON bind, as floated, adds a bind either way —
   a TEXT *literal* is strictly better if it holds.)
3. **Reverse §3.4 and sweep for siblings.** Reintroduce `Param` as a first-class layered concept;
   §3.4's argument was descriptive of the flattening, so reversing the flattening reverses it. Sweep
   root `CLAUDE.md` locked-decision #5, the build plan §3.4, and any doc asserting "wire params are
   resolved before the IR" / "no `Param` node"; update each to cite this doc.
4. **Scope: go generic (encouraged).** Not the minimal patch. The coherent target is a genuine
   `Param` representation from wire → IR → RelIR `Param` expr node, with reduction deferred to the last
   responsible moment per the TinkerPop model. First landable increment can still be the unambiguous
   part — the `operandLit` type-preservation fix + inlining the constant count/key/id/ordinal sites,
   which need no `Param` node — but the destination is the general one.

## The phased build

**Phase A — LANDED (commit `2c99c50`).** Banked the unambiguous savings with no `Param` concept.
Everything here is a value the compiler already holds as a constant; none needed a parameter
representation. `operandLit` became the typed `constLit` (`compiler/rel/lower.ts`); `compilerReal` +
the `'compiler-real'` source landed in `src/rel/expr.ts`/`emit.ts`; `bindCount` now counts only
`source: 'bound'` lits (the shared `bindsAsParameter` predicate) so the budget pre-check reflects the
real 100; the hygiene gate ratchets `bound` downward. Measured: corpus `bound` lits 829 → 701, binds
dropped in 40+ families and rose in none. The items below are done:
- **A1. Stop discarding the type in `operandLit` (`lower.ts:1770–1773`).** Take the arg's canonical
  type from `Step.argTypes` instead of re-deriving `text`/`real`/`int` from the JS runtime value. This
  is a bug on its own.
- **A2. Add typed compiler-literal spellings.** Today `src/rel/expr.ts` has `compilerText`/
  `compilerInt`/`compilerNull`. Add the arms a typed scalar literal needs (real/bool, and the
  decimal-TEXT form pending the Phase-C measurement), so a held scalar of any canonical type inlines
  as a correctly-typed SQL literal. `emit.ts:122–129` grows arms; `walk.ts`/`check.ts` switch on
  `kind` only, so they are untouched.
- **A3. Inline the held-constant sites** now on `lit()`: `has` key (`440–441`, `1118`), count sites
  (`704`, `769–770`, `823–829` — express `range` arithmetic in SQL, `LIMIT ?-? OFFSET ?`), `V/E` ids
  (`529–530`) where the id is a parsed literal, and the `operandLit` callers whose value is a literal.
  **Do NOT touch a value that is (or will be) a parameter** — that is Phase B; until B exists these are
  all literals anyway (the front-end flattens them), so A is a pure win with no behaviour change.
- **A4. Tighten the hygiene gate.** `scripts/sql-hygiene.ts`'s `countExpr` already splits `bound` vs
  `compiler`; assert the target directly and ratchet the freed families down.

**Phase B — the `Param` concept, wire → IR → RelIR. LANDED (commit `583d150`), top-level scope.**

**Encoding — the parallel array was the convenient choice; the OBJECT is the right one. REVERSED
(commit `52abcc6`).** B1 proposed `{ param, value, type }` with consumers narrowing through `isParamArg`;
the original Phase B measured that as ~62 value-reading sites and instead rode the name as a parallel
`Step.paramNames` array beside `argTypes`, keeping `args` plain values. That was the least-resistance
move, not the correct one: three parallel arrays are an index-coupling invariant maintained by hand,
littered with "in lockstep" comments, and the one site that forgot (`flattenListArgs`) silently
desynced the metadata from its value — the exact class of bug the deferred `V($x)`/collection-param
gaps trace back to. The refactor now unifies value+type+name into ONE `Arg` object (`gremlin/frontend.ts`),
`Step.args: Arg[]` — which is literally TinkerPop 4's `GValue` (a name→value pair, `name != null` ⇒
variable) plus the canonical type the JS value can't spell. `walkArgs` is the one producer emitting
`Arg[]`; every consumer reads `.value`/`.type`/`.name`; `sliceParamNames` collapses from an
index-realignment dance to a `filter`+`map` because dropping the scope token now drops its name with
it. The boundary value stays `any` (locked #5), but the wrapper is fully typed, so "treat the whole arg
as a value" is a compile error rather than a silent `false`. ~50 files, behaviour-preserving (census
answer-change oracle clean, full ladder green). The one class tsc could NOT catch — a guard/`typeof`
that accepts `unknown`, and a synthetic step built with raw args behind an `as IRStep` cast — was swept
by grep + the census/L1–L5 net; the two that slipped through both (`edgeLabelFilter(s.args)` binding an
`Arg`, `reads.matching`'s cast-hidden synthetic steps) are recorded here as the tells for the next chunk.

- **B1 (done, re-encoded, then re-unified in `52abcc6`). Front-end stops flattening.**
  `walkArgs`/`extractArgs` produce `Arg[]`; a top-level `$x` records its name on its `Arg` (`frontend.ts`),
  and every arg now carries its own value+type+name so there is no separate `paramNames` array to attach.
- **B2 (done). RelIR `param()` + `source: 'parameter'`** in the `lit` union (no new `kind` — `walk`/
  `check` untouched); `emit.ts` renders it `value(?)`. `bindsAsParameter` and the hygiene counter treat
  `'parameter'` and mechanical `'bound'` alike as binds; a `compiler-*` constant is not.
- **B3 (LANDED for `limit`/`skip`; `range` reduces BY DESIGN — commit `3d3d1cd`).** A scalar parameter
  stays a `param()` bind through lowering, now including a slice count where SQL can carry it untouched:
  `limit($x)` → `LIMIT ?`, `skip($x)` → `LIMIT -1 OFFSET ?`, in both the global (`lower.ts`) and local
  (`list.ts`) slice paths through one `sliceBound` seam. The `LIMIT ?-? OFFSET ?` idea for `range` was
  **refined, not implemented**: `range`'s count is `hi−lo` (arithmetic on the value) *and* its `lo>hi`
  raises a validation SQL cannot carry, so `range` REDUCES its parameter — the last responsible moment,
  exactly like `unrollFixedRepeat` reduces `times($x)`, and required by root `CLAUDE.md` "fail closed"
  (a bound `range` would silently mis-limit an illegal range instead of throwing). The collapsed-relation
  band reduces for the same arithmetic reason; `tail`/`sample` keep their own count derivations.
  `sliceParamNames` decodes the numeric args' names in lockstep with `sliceOf` (scope tokens skipped).
- **B4 (done, for scalars).** The hygiene gate counts a bind by `bindsAsParameter`, so a held constant
  rendered as a bind is caught by the ratchet at the family it inflates.

**Nested predicate/set parameters — LANDED (commit `ff7397d`).** `P.gt($x)`, `within($x, $y)`,
`P.between($x, $y)` now bind their parameters, closing the inconsistency where a `$x`'s budget cost
depended on whether it sat bare or in a predicate. `parsePredicate` keeps the `names` array
`extractArgs` produces and attaches `Pred.paramNames`; `predicateExpr` threads each operand's name to
the `constLit` seam. No churn (corpus uses literals), census clean.

**Deferred still (documented, correct-result gaps — no budget saving, never a wrong answer):**
- A `$x` inside a **collection LITERAL** (`within([$x])`, `inject([$x])`) inlines — a lone bracketed
  list is unwrapped to members of one arg, which are not individually tracked (a list-param is the
  oversized bucket, not N params).
- **`V($x)`/`E($x)` ids** inline (the `flattenListArgs` index desync is why elementScan doesn't thread a
  name); ids-as-parameters are exotic.
- **`range($x, $y)`** reduces its parameters (inlines) BY DESIGN — validation + arithmetic force the
  last-responsible-moment reduction (B3, landed). `limit($x)`/`skip($x)` now bind. A `range` param over
  a set too big to validate cheaply is not a concern: the reduction is O(1) here.
- **hasId($x)** — RelIR declines `hasId` entirely (routes to legacy, which binds); a coverage gap, not
  an operand-seam one.

**Phase C — shrink `oversized`, expose the budget honestly. C1-predicate LANDED; the rest scoped below.**

- **C1. The decimal-TEXT literal — context-dependent; three INDEPENDENT per-site changes, not one
  `constLit` edit.** SQLite comparison holds: `CAST(col AS REAL) > '9.5'` returns the numeric answer, so
  a canonical-decimal TEXT literal compares correctly through the existing `compareKey`/`compareBound`
  CAST. But inlining the tail is only safe where the FRAMING carries the type:
    - **Predicate operand — DONE (commit `6787a33`).** `predicate.ts` `operand` accepts the tail →
      canonical TEXT literal (equality is TEXT=TEXT) / param; `ordered` widens `numericBound` and wraps
      the bound `CAST(… AS REAL/INTEGER)` to line up with `compareKey`. RelIR now covers
      `has/is/within/between` over BigDecimal/Duration/bigint; verified rel≡legacy. `constLit` is
      untouched (the `operand` guard keeps the two seams independent), so the two below are unaffected.
    - **`inject(Duration(…))` — LANDED; `inject(9.99m)`/bigint deliberately NOT inlined.** `injectSource`
      inlines a DURATION tail as its canonical total-nanos TEXT (a `$x` binds); it frames
      `STATIC('duration')`, so it reads back as a Duration. Only Duration, and the restraint is
      load-bearing: **BigDecimal** frames `STATIC('bigdecimal')`, a static type that ALSO arrives NATIVE
      from `values(…).asNumber(GType.BIGDECIMAL)` / a reducer (which compares correctly on `rel` — the
      census witness `asNumber(BIGDECIMAL).is(P.gt(0))`), and the type name alone cannot tell the TEXT
      inject literal from the native REAL, so inlining it would create a static subject the ordering arm
      can neither compare nor safely decline. A **bigint** (`inject(9…L)`) frames `STATIC('long')` — the
      SAME type native `count()` carries — same collision. Duration has NO native static-subject source,
      so it is the one tail safe to inline. `constLit` is untouched (still declines the tail).
    - **Static-subject ORDERING fails closed for temporals (fixes a live bug).** `ordered`'s STATIC arm
      mis-handled a temporal subject: `datetime`/`duration` were folded to `CONSTANT.false` — a wrong
      EMPTY result (`inject(datetime(…)).is(P.gt(…))` returned nothing on `rel`, PRE-EXISTING and unrelated
      to inject). A temporal static subject's only source is a literal with no per-row `vtype` to drive
      `compareKey`'s cast, so `ordered` now DECLINES (`→ null → legacy`) an ordering over a
      `datetime`/`duration` static subject rather than answering wrong. `bigdecimal` is deliberately NOT
      declined (its native `asNumber` case compares correctly and must stay on `rel`). Making a TEXT
      bigdecimal/duration static subject COMPARABLE on `rel` is the deferred bigger fix: it needs the
      subject's storage class threaded into `SubjectType`, since the type name cannot distinguish a TEXT
      inject literal from a native REAL/INT.
    - **`constant(9.99m)` — TODO, blocked.** It frames `UNKNOWN` by design, so an inlined `'9.99'` reads
      back as a *string*. Needs a typed `constant` framing first (or keeps declining) — and, for an
      ordering comparison over it, the same `SubjectType` storage-class enrichment as above.
- **C2·a — the `land` pass is now WIRED (fixes item-38, a production DO refusal).** An over-budget
  LITERAL row set — a big `inject(v1…v101)` — now rides as ONE JSON bind exploded by `json_each` and
  stays on the RelIR spine within the 100-bind cap. `lowerToRel` runs `land` over the whole plan
  (result + each Rel binding) just before the bind-budget gate (`compiler/rel/lower.ts` `landPlan`), so
  the set crosses the seam as one value exactly as the root `CLAUDE.md` rule requires. Before, this set
  DECLINED to legacy, where it compiled to N binds a Durable Object refuses (`docs/outstanding-work.md`
  the `land`-unwired note + item 38 — "parked on the spine this migration deletes *and* broken on the
  spine it is parked on"). `land` only rewrites an over-budget `Values` OF LITERALS and is a no-op
  otherwise, so it is safe over every plan; a non-literal row is left for the budget to fail closed on.
  Test: `test/rel-spine.test.ts` (101-row inject → 1 bind, DO-legal, rel≡the 101 values).
- **C2·b — the PARAM-LIST `within` case remains** (`plan.ts` `jsonbArrayBind`/`SET_BIND_LIMIT`). Today a
  RelIR `within(<set>)` over `SET_BIND_LIMIT` (25) members DECLINES to legacy (`predicate.ts`); the
  generalisation is a coverage move, not a budget one (legacy already JSON-binds the big set).

  **Refined by Phase B — this is now specifically the PARAM-LIST case.** With operand inlining, a big
  set of LITERALS is already 0 binds (each member inlines), so the only set that still needs the JSON
  bind is a `within(namesParam)` where the members are DATA — inlining those would make the statement
  text a function of the data (the exact thing `textLiteral`'s doc forbids). The blocker is that
  `parsePredicate` DROPS the single-vs-varargs distinction on unwrap (`single ? undefined`), so
  `predicateExpr` cannot tell a param list (→ one JSON bind, `json_each` in-query) from literal varargs
  (→ inline). C2 therefore needs: (a) `parsePredicate` to preserve "this set is one collection arg"
  (and its param name), and (b) a `json_each` in-query landing in the `within` case — which needs a
  `Minter` threaded into `predicateExpr`, or a post-pass over the `in-list` Expr mirroring `land`'s
  Values landing. Substantial; coverage-only (legacy is correct today).

## Discovered while landing Phase A (follow-ups, not yet done)

- **The `by(key)` modulator constant — DONE on the RelIR spine.** `order()/group().by('name')` renders
  the key as an inlined `compilerText` literal (`compiler/rel/modulator.ts`), so `by('name')` is 0 binds
  on `rel` (verified). A `by($x)` would become a parameter through the same `constLit` seam once a
  modulator param name is threaded — not currently wired, and exotic. (Legacy still binds the key, but
  legacy is dead.)
- **The census baseline carried pre-existing drift**: 9 `all()/any()/none()`-over-scalar traversals
  already ran on clean trunk but were recorded `deferred` (a prior commit added the support without
  re-recording; `deferred → ran` trips no census gate, so it stayed invisible). Re-recorded in
  `2c99c50`. Nothing to do, noted so the next reader does not attribute it to Phase A.

## Handoff + guardrail

**Status (current).** Phases A, B, B3 (limit/skip), nested predicate/set params, C1-predicate,
C1-inject(Duration) + the static-temporal ordering fail-closed fix, and C2·a (the `land` pass wired for
over-budget literal injects) are all LANDED. The parameters-are-the-only-binds thesis is complete for
every common case: a user parameter is the only free-standing bind, a parsed literal inlines as a typed
literal, and an over-budget literal set rides as one JSON bind. The `by(key)` constant is inlined too.

**Encoding follow-through — the `Arg` object LANDED (`Step.args` `52abcc6`, `Pred.operands` `8ac00ad`).**
The Phase B parallel-array deviation is reversed on both shared IR types: a step argument is one
`Arg { value, type, name }` (`Step.args: Arg[]`) and a predicate's operands are `Pred.operands: Arg[]`,
the faithful GValue representation the thesis called for — no parallel `argTypes`/`paramNames`/`values`
arrays left on either. Remaining consolidation of the SAME shape, each its own gated chunk (all
behaviour-preserving):
- **RelIR `constLit` takes an `Arg` — LANDED (`fe3bcf7`).** `constLit(value, type, paramName)` →
  `constLit(a: Arg)`, so the same object the front-end carries flows into the bind-vs-inline seam and
  the step-arg callers drop their `?? null` trio. (`sliceBound` left as-is — a count + name, no type.)

**Now a DESIGN DECISION, not a mechanical chunk — the collection-member case.** `literalItems` returns
`{values, items}` (member VALUES paralleling member TYPES in the arg's `type.items`), and
`flattenListArgs` / `parsePredicate`'s bracketed-list unwrap spread the values while DROPPING the
per-member type and name. Unifying collection members to `Arg[]` is what would dissolve that desync
"for real" — but it is NOT a behaviour-preserving refactor like chunks 1/2/4. It would REVERSE the
documented decision that a `$x` inside a collection literal (`within([$x])`, `inject([$x])`) inlines as
part of the **oversized** bucket (correct result, no budget saving), by making each member a tracked
parameter that BINDS. That is a capability/semantics change (member params start counting against the
100), so it wants an explicit decision before landing rather than being swept in with the encoding
tidy. Two independent pieces: (a) the TYPE half — LANDED (`85bf026`). `predicate.ts` now threads each
operand's `Arg.type` (was `null`) and `parsePredicate` threads a bracketed member's `type.items[i]`,
so `P.gt(2.0)` and `within([1L, 2L])` members inline as TYPED literals — the thesis's "stop throwing
the type away", finished for predicate operands. Measured result-invariant (SQLite compares INTEGER
and REAL alike): census clean, every L2 snapshot unmoved. (b) The NAME half — STILL OPEN, and it is a
product decision, not a refactor: tracking a collection member's `$x` so it BINDS requires the
front-end to stop flattening the member, which REVERSES the documented "collection params inline as
oversized" rule and changes what counts against the 100-parameter budget. Left untouched pending that
call.

**What remains is coverage-only / exotic / an open design question — each needs a decision before it is
worth the risk on the shared spine:**
- **C1-constant + TEXT exact-tail static ORDERING** both want the same enrichment: `SubjectType` (and
  behind it `ScalarType`) carrying the subject's STORAGE CLASS, so `ordered`'s static arm can cast a
  TEXT-stored `bigdecimal`/`duration` subject instead of declining. Cross-layer; exotic trigger
  (`inject(9.99m).is(P.gt(…))`, `constant(9.99m).is(…)`).
- **C2·b — the PARAM-LIST `within`** needs `parsePredicate` to preserve the single-collection-arg
  distinction plus a `json_each` in-query landing (a `Minter` in `predicateExpr` or an in-list post-pass
  mirroring `land`). Substantial; coverage-only (legacy JSON-binds the big set correctly today).
- **The RelIR pass pipeline** (`docs/outstanding-work.md` item 37) is an OPEN DESIGN QUESTION for
  `prune`/`fuse` — `land` is now wired ad-hoc at its one site, but whether the four passes become one
  ordered pipeline object, and whether `fuse` is wanted at all, is undecided.

This doc is the contract. The decisions that must NOT be
relitigated by a fresh context (they were each reached against a plausible opposite and the opposite is
wrong):
- A bind serves a **user parameter**; the statement cache is the user's payoff, not ours to farm.
- A **parsed literal is a constant** — inline it as a typed SQL literal; we know the type (`argTypes`).
- The **100-bind cap is a parameter budget**; polluting it with compiler binds is the defect.
- `oversized` (collection / decimal tail) binds are a **mechanical necessity, a separate category**,
  not evidence that "data must bind."
- TinkerPop's `GValue` **is** this design; the alignment doc's "buys nothing without a plan cache" is
  superseded — the payoff is the bind budget + honouring intent, both real without a cache.
- **Legacy is dead** — do not spend effort classifying or fixing `src/compiler/steps/**` or `plan.ts`
  legacy binds.
