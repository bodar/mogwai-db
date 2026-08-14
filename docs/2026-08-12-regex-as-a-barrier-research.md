# Regex as a barrier service — INTENDED, not scheduled

**Status: intended future work. Reviewed 2026-08-13 against the RelIR spine; no code change yet, no
date.** `regex` is **no longer a locked non-goal** — the intention is to implement it. What is still
open is the SEMANTICS COMMITMENT below (§"The two real costs", item 1), which is a product decision
and the only thing standing in the way; the engineering is reuse of machinery that has since shipped.
Not in `docs/outstanding-work.md` because nothing is scheduled, and until it lands the behaviour is
unchanged: `regex` fails closed with a deferral and is never JS-filtered.

⚠️ **Reviewed against the single-spine cut.** Everything below held up, and two things got STRONGER —
see "What the RelIR spine changed". The grammar spelling is `TextP.regex(…)` (`Gremlin.g4:1327`), not
`P.regex`.

## The wall today, and why it exists

DO SQLite has no user-defined functions, and the project does not filter in JS
(`.claude/rules/wire-protocol.md`; root decision #3). So anything SQL cannot express **fails closed
with a deferral** rather than being evaluated row-at-a-time in the app tier.
`containing`/`startingWith`/`endingWith` stay in SQL as `LIKE`; `regex` does not, and stays deferred.

⚠️ **`typeOf` is no longer in that set** — it was when this note was written. It lowers as a per-row
`vtype` comparison with a storage-class fallback (`typeOfExpr`, `compiler/rel/predicate.ts`), and
`is(typeOf(GType.LIST))` even RETYPES the stream. So `regex` is now the ONLY member of the
"SQL cannot express it" class, which is what makes it worth a note of its own.

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
predicates (`src/services/CLAUDE.md`; the live rewrite is `src/rel/passes/semijoin.ts`'s `trigramSeek`, applied over the
finished algebra in `lowered` and gated by the `ftsSubstringPredicate` flag from
`src/compiler/options/fast-paths.ts`). Almost every real regex carries a required literal run
(`^SKU-\d+` must contain `SKU-`). So:

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

## What the RelIR spine changed (reviewed 2026-08-13)

The single-spine cut deleted the legacy route this note was written against. Every mechanism it leans
on survived, and two of them got materially better for this purpose:

- **The barrier boundary moved into the algebra and is now the ordinary fold on both sides.**
  `compiler/rel/segment.ts` decides only WHERE the boundary is; the head is a plain compile of the
  prefix and the resume is `lowerForeignResume` — "the same tail vocabulary, seeded from a landed
  relation instead of a scan". So a regex barrier inherits the whole tail vocabulary rather than a
  hand-written continuation.
- **A DATA-SIZED row set already crosses the boundary as ONE JSON bind** exploded by `json_each`
  (`compiler/rel/foreign.ts`, §6·2). This is the piece the note was missing and it is the crux: a
  regex barrier's SURVIVOR SET is data-sized by definition, and a `VALUES (?,?,…)` re-injection would
  hit the DO's 100-bind wall (measured: a 26-row federated hop was a hard DO failure in exactly that
  form, invisible on Bun at 65 535). The mechanism to re-inject survivors already exists and is
  already proven against the platform cap.
- **A resume CANNOT decline** — an unsupported step after a barrier RAISES, naming the step
  (`rel/segment.ts` `resumed`). A regex barrier therefore cannot silently answer a narrower question
  downstream, which is precisely the failure mode option (2) below has.
- **The head projects only what the barrier reads.** `BarrierInput` is `{injectedValue?}`, so a head
  compiles the one value its barrier consumes rather than a whole element payload. A regex barrier
  wants exactly one column (the candidate string) plus its owner id, which is that shape.

⚠️ **One correction the new machinery forces.** `foreignRelation` lands DETACHED elements, and a
detached element has NO live adjacency (`detachedTail` serves `id`/`label`/`values` and declines
everything else). A regex barrier's survivors are LOCAL elements, so it must NOT land them as foreign
rows — it must re-inject the surviving IDS and let the next segment scan this graph's own tables, which
is what §"The observation" already says (`within(<ids>)`). The right shape for that today is RelIR's
own retained-binding concept (§3.0 of the build plan: a `Ref` resolving to retained rows as one JSON
bind), not the federate return path. Getting this backwards would trade live adjacency for a snapshot.

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
- ⚠️ **Landing survivors as DETACHED rows.** They are local elements; see the correction above.

## If it were ever picked up

The minimal honest scope would be: **`has(key, regex)` only, trigram-prefiltered, committed to JS-regex
semantics with the divergence documented, everything else still deferred.** That is a small, testable,
correct-by-construction slice — not a wall removal. Everything above the semantics decision is reuse of
existing machinery (`segment.ts` barrier, `injection.ts` bound-join, `property_fts` trigram); the
decision itself is the gate, and it is a product/correctness call, not an engineering one.

## Anchors

| Claim | Location |
|---|---|
| Regex fails closed, never JS-filtered (today) | `.claude/rules/wire-protocol.md`; root `CLAUDE.md` decision #3 |
| `regex` is the ONLY "SQL cannot express" predicate left | `typeOfExpr`, `src/compiler/rel/predicate.ts` |
| Barrier model is generic, not federate-specific | `src/compiler/segment.ts:9-14`, `:43` |
| Bound-join re-injection (`within` over distinct set) | `src/compiler/ir/injection.ts:11-14`, `:22`; `src/services/catalog/federate.ts:81-82` |
| One batched hop, scatter in SQL `resume` | `src/services/catalog/federate.ts:68-83` |
| Trigram index + substring fast path | `src/services/CLAUDE.md`; **`src/rel/passes/semijoin.ts`'s `trigramSeek`** (the live physical rewrite over the finished algebra, gated `ftsSubstringPredicate`); `src/compiler/options/fast-paths.ts` |
| Barrier boundary + resume on the RelIR route | `src/compiler/rel/segment.ts` |
| A data-sized row set crosses as ONE JSON bind | `src/compiler/rel/foreign.ts` (`foreignRelation`) |
| A detached element has no live adjacency | `detachedTail` in `src/compiler/rel/lower.ts` |
| Retained binding / `Ref` (the survivor-set shape) | `docs/2026-08-01-relir-build-plan.md` §3.0 |
