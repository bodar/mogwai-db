# Regex as a barrier service — research note, NOT a commitment

**Status: exploratory, 2026-08-12. No code change, no plan, no scheduled work.** This is a design
sketch of ONE way the platform's regex wall *could* be loosened if we ever chose to, written down so
the reasoning isn't lost. It is deliberately **not** in `docs/outstanding-work.md`: nothing here is
scheduled, and the current decision (regex fails closed, never JS-filtered) stands until explicitly
revisited. Read this as "if we ever wanted to, here is the shape and here is what it would cost",
not as "we should".

## The wall today, and why it exists

DO SQLite has no user-defined functions, and the project does not filter in JS
(`.claude/rules/wire-protocol.md`; root decision #3). So anything SQL cannot express — `regex`,
`typeOf` — **fails closed with a deferral** rather than being evaluated row-at-a-time in the app
tier. `containing`/`startingWith`/`endingWith` stay in SQL as `LIKE`; `regex` does not, and stays
deferred.

The wall's real justification is **not** "we can't run regex efficiently outside SQLite." It is that
row-at-a-time JS interpretation of a traversal is the failure mode this project exists to avoid, and
that TinkerPop's regex semantics are Java `Pattern`, which JS `RegExp` does not match. The first is an
architecture constraint; the second is a correctness one. This note argues the first is already
solved by machinery we shipped for federation, and that the second is the actual blocker.

## The observation

The segmented-plan barrier model (`src/compiler/segment.ts`) is **generic**, not federate-specific —
its own header says "any future barrier service returns this shape" (`segment.ts:43`). A barrier is
"an opaque async transform BETWEEN SQL-compiled stages, not a row-at-a-time interpreter"
(`segment.ts:11-14`). That is exactly the home a non-SQL predicate wants:

```
[ SQL segment: all SQL-expressible narrowing ]
      -> drain candidate (id, value) rows
      -> (barrier: run the regex in JS over the WHOLE batch)
      -> re-inject survivors as within(<ids>)
[ SQL segment: everything downstream, still compiled SQL ]
```

The re-injection is not new plumbing either. `mogwai.graph.federate` already pushes a distinct value
set into a following segment under `INJECT_VALUES_KEY`, where `has()`/`is()` compilation substitutes a
`within(<values>)` for a `T.value` marker operand (`src/compiler/ir/injection.ts:11-14`,
`src/services/catalog/federate.ts:81-82`). injection.ts calls this a **SPARQL bound-join**
(`injection.ts:13`): N inputs collapse to the distinct set, one batched hop, results scattered back by
a SQL join in `resume`. A regex barrier is the same bound-join with a JS predicate in the middle
instead of a sibling-graph hop.

## Why this is less-bad than the usual implementations

There are only three ways to do regex on this substrate:

1. **A SQLite UDF** — impossible on the DO runtime (no user functions). This is the root constraint,
   not a preference.
2. **Pull-everything-and-filter** — the naive app-tier approach, and the one that makes everything
   *downstream* of the regex also fall out of the engine into row-at-a-time app code.
3. **A barrier** — the strongest form of (2): the JS step is a single batched set-transform sitting
   **after all SQL-expressible narrowing and before all SQL-expressible continuation**. The head
   segment applies label, other `has()`, ranges — so JS sees only what survived everything SQL could
   do, and the survivors flow back into SQL for the rest.

Critically, (3) does **not** violate decision #3 the way (2) does. "Compile to SQL, never interpret"
is about not interpreting the *traversal* row-at-a-time. One batched opaque barrier is not that; the
traversal stays compiled on both sides of it. This is the whole point of the barrier abstraction, and
it is why a regex barrier is philosophically admissible where a sprinkled `.filter()` is not.

## The catch: batching alone doesn't save the regex-only case

Batching helps only when *something else narrows first*. For `has('name', regex('^a.*'))` as the
**only** predicate over the whole graph, the head segment has nothing to filter on, so every `name`
string crosses into JS — which is precisely the "move everything outside storage" case one is trying
to beat. The barrier shape is identical whether the batch is 10 rows or 10 million; the abstraction
contains the blast radius but does not shrink it.

## The piece that makes it actually good: trigram prefilter

The `property_fts` FTS5 **trigram** index already backs `tinker.search` and the `TextP` substring
predicates (`src/services/CLAUDE.md`; the `ftsSubstringPredicate` fast path in
`src/compiler/plan/plan.ts` + `src/compiler/options/fast-paths.ts`). Almost every real regex carries a
required literal run (`^SKU-\d+` must contain `SKU-`). So:

```
extract mandatory literal substrings from the regex (AST walk)
  -> trigram prefilter in SQL, in the head segment   (candidates only)
  -> exact JS regex in the barrier over trigram hits
  -> within(<survivor ids>) re-join in SQL
```

This is how trigram-indexed regex search works in general (Cox, *Regular Expression Matching with a
Trigram Index* / Google Code Search; `grep -P` over a trigram store). It turns the worst case
(regex-only predicate) from "all rows" into "trigram candidates", and it reuses two mechanisms already
in the tree — the barrier and the trigram index. **This variant, not the bare barrier, is the one
worth remembering.** A regex with no extractable literal (`^.{3}\d$`) has no prefilter and degrades to
the full-scan case honestly — which is a fine place to keep failing closed.

## The two real costs — both must be paid deliberately, not stumbled into

1. **Semantics commitment (the actual blocker).** JS `RegExp` ≠ Java `Pattern`: unicode property
   escapes (`\p{...}`), possessive quantifiers, `\A`/`\z`, named-group syntax, and more all diverge.
   The current fail-closed deferral never has to answer for this. Loosening the wall means *explicitly*
   choosing JS-regex semantics and documenting the divergence from TinkerPop, OR bringing a
   Java-compatible engine — a dependency, which needs approval under the root working rules. This is a
   correctness decision, and it is why the wall exists. It is not moved by any amount of barrier
   cleverness.

2. **Only the membership positions map cleanly.** `has(key, regex)` → a subset of elements with stable
   identity → `within(<ids>)` re-join. Clean. But regex deeper in an expression — a scalar mid-stream
   `is(regex)`, inside `where(...)`/`match(...)`, or feeding a projection — has no stable identity to
   scatter back onto, so lifting it to a barrier risks answering a subtly different question. Those
   should stay fail-closed deferrals even if `has(key, regex)` got the treatment. A partial,
   correct-by-construction loosening beats a total, subtly-wrong one — the same principle behind the
   write path's guard-binding refusals (`src/rel/plan.ts` `Guard`).

## What is REFUTED here

- A **general** lift of the regex wall (regex admitted everywhere it can appear). Position 2 above
  makes this either wrong or a much larger design than the bound-join reuse suggests.
- Any framing that treats this as a **performance** unlock. The barrier + trigram makes it *tractable
  and contained*; the thing standing between us and shipping it is the semantics commitment, which is
  not a perf question.

## If it were ever picked up

The minimal honest scope would be: **`has(key, regex)` only, trigram-prefiltered, committed to JS-regex
semantics with the divergence documented, everything else still deferred.** That is a small, testable,
correct-by-construction slice — not a wall removal. Everything above the semantics decision is reuse of
existing machinery (`segment.ts` barrier, `injection.ts` bound-join, `property_fts` trigram); the
decision itself is the gate, and it is a product/correctness call, not an engineering one.

## Anchors

| Claim | Location |
|---|---|
| Regex fails closed, never JS-filtered | `.claude/rules/wire-protocol.md`; root `CLAUDE.md` decision #3 |
| Barrier model is generic, not federate-specific | `src/compiler/segment.ts:9-14`, `:43` |
| Bound-join re-injection (`within` over distinct set) | `src/compiler/ir/injection.ts:11-14`, `:22`; `src/services/catalog/federate.ts:81-82` |
| One batched hop, scatter in SQL `resume` | `src/services/catalog/federate.ts:68-83` |
| Trigram index + substring fast path | `src/services/CLAUDE.md`; `src/compiler/plan/plan.ts` (`ftsSubstringPredicate`); `src/compiler/options/fast-paths.ts` |
