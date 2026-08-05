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

**Phase B — the `Param` concept, wire → IR → RelIR.**
- **B1. Front-end: stop flattening (`frontend.ts:415`, `VariableContext`).** Emit a distinct arg shape
  `{ param: name, value, type }` (a new `TaggedArg` member with an `isParamArg` guard), so `Step.args`
  stays `any[]` and consumers narrow. A parsed literal stays a plain value. This is the un-reduction.
- **B2. RelIR `Param` expr.** Add `source: 'parameter'` to the `lit` union (NOT a new `kind` — keeps
  `walk`/`check` untouched); `emit.ts` renders it `value(e.value)`. A `param()` constructor;
  `lit(...)`'s doc narrows to "query/store data that must bind but is not a user parameter"
  (i.e. the `oversized` bucket).
- **B3. Deferred reduction — the last responsible moment.** A parameter stays a `Param` unless a
  lowering must compute on its concrete value. Today the only such site is `unrollFixedRepeat`
  (`ir/passes.ts:107`), which resolves `times(n)` — that pass reduces its own operand and nothing
  else does. `sliceOf`/count arithmetic move into SQL (Phase A3) so they no longer force reduction.
- **B4. Hygiene invariant flips to the real rule:** a free-standing bind's `source` is `'parameter'`
  (or `'oversized'`); a held constant rendered as a bind is a build failure at the site.

**Phase C — shrink `oversized`, expose the budget honestly.**
- **C1. Measure the decimal-TEXT literal** (open question 2). If the CAST-compare holds, the
  big-decimal/duration/>2⁵³ tail inlines and `oversized` is just collections.
- **C2. Generalise the `json_each` move** (`plan.ts` `jsonbArrayBind`/`SET_BIND_LIMIT`, `land`) so an
  oversized value rides as one JSON bind, stopping it competing per-value with the parameter budget —
  turning "100 minus mystery overhead" into "100 parameters."

## Discovered while landing Phase A (follow-ups, not yet done)

- **The `by(key)` modulator constant still binds.** `order()/select()/group().by('name')` renders the
  key as a bound `?` twice apiece (the ORDER BY read and the null-guard), via the modulator seam
  (`compiler/rel/modulator.ts`), NOT through any Phase-A site. It is the same principle — a parsed
  literal key is a constant — and inlining it is the obvious next constant-sweep increment. Deliberately
  left out of Phase A to keep the enumerated change reviewable. Do it as a Phase-A-style extension (it
  needs no `Param` node): a `by(key)` is a constant today because the front-end flattens; a `by($x)`
  becomes a parameter only once Phase B exists.
- **The census baseline carried pre-existing drift**: 9 `all()/any()/none()`-over-scalar traversals
  already ran on clean trunk but were recorded `deferred` (a prior commit added the support without
  re-recording; `deferred → ran` trips no census gate, so it stayed invisible). Re-recorded in
  `2c99c50`. Nothing to do, noted so the next reader does not attribute it to Phase A.

## Handoff + guardrail

Phase A is landed (`2c99c50`); Phase B is next. This doc is the contract. The decisions that must NOT be
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
