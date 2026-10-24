# Simplification — a faithful port, not an emulation of Java (2026-10-18)

**✅ LANDED AND ARCHIVED (2026-10-24).** All 24 work items are on trunk. Items 1 and 22's EarlyLimit
revert landed inside `58d3d800`, item 23 is `62c27089`, and item 24 is `b4b3c32d`; the rest are the
`simplify(...)`/`revert(order)`/`fix(dedup)`/`refactor(write)` commits. The durable rules are in `CLAUDE.md`,
and the accepted answers are in feature matrix §17. The residue moves to `docs/outstanding-work.md`: the
wf16 split-label carry, which is already covered there; the four sensible queries still declined under
"Where effort should go instead", which still decline on 2026-10-24; and cluster 8's federate/journal
follow-ups. The trunk `toUpper()` regression was fixed in `4171f792`. The coalesce/choose arm merge positions
stay DROPPED.

**Status: APPROVED by the user 2026-10-18 — the full plan, with SNAPSHOT write semantics.** This is the
rationale and the work order; each item lands independently and records its own commit. The durable
rules it produced live in `CLAUDE.md` (Semantics traps) and the accepted answers in
`docs/feature-support-matrix.md` §17 *Deliberate divergences* — this doc must not be needed to apply them.

## Why

mogwai-db is a FAITHFUL port of TinkerPop, MECHANICALLY SYMPATHETIC to SQLite and the JS runtime — not a
port of Java's execution. A review of everything that landed between `a34c4df6` and trunk `7e2bb240`
found that most of it copies how Java *executes* (laziness, LazyBarrier/TraverserSet merge order, when an
error fires, how a number prints, signed zero, UTF-16 code units, `java.util.regex`), and very little of it
changes what answer a user gets. That code is also where nearly all the slowdown came from, and in places
it turned answered queries into refusals — two of them dependent on graph SIZE, i.e. production-only.

| | base `a34c4df6` | trunk `7e2bb240` |
|---|---|---|
| src lines | 64,588 | 76,239 (+11.6k net) |
| L3 conformance | 1869/2286 | 1873/2286 (+4, none lost) |
| total SQL emitted, corpus | 3.50 MB | 6.20 MB (+77%; median 1.5×, worst 88×) |
| total compile time, corpus | 3.56 s | 6.91 s (median 1.63×, worst 55×) |
| total execution time, corpus | 0.88 s | 2.13 s (median 1.18×, worst 297×) |
| test suite (L3, census, L5) | | ~1.7× slower |

Of the four L3 gains, two come from the per-start reducing-option gate and two from the scalar-host
presence claim; both stay. **Everything else added zero L3 scenarios** — it was driven by our own L4
addendum and by reading the Java code for HOW, not WHAT.

### Actively harmful on trunk at `7e2bb240`

1. **Merge-window refusal (2500 distinct traversers).** `g.V().out().values('name')`,
   `g.V().out().out().limit(10).id()`, `…values('name').fold()` fail at runtime once more than 2,500
   distinct traversers pass a merge point. L3's largest graph has 808 vertices, so it cannot see this.
2. **A write guard that depends on graph size (`barrierHoldsAll`).** `g.V(1,4).out().out().addE('k').to(V(3))`
   answers on modern and refuses once the graph has ≥2,500 vertices.
3. **Everyday writes refused:** `g.V().out().drop()`, `g.V().not(out()).drop()`,
   `g.V().as('a').out().addE('k').from('a')`, `g.V().out().property('visited',true)` — ~6.6k forms by our
   own count.
4. **Sensible reads declined:** `values('f').sum()` over Floats; `values('x').order()` over `{1m, 1.0d}` or
   `{0m, -0.0d, 0.0d}`; `values('name').toUpper().dedup().limit(2)`;
   `optional(out().order().by('name')).values('name').is(neq('x'))`; regex with `\b`, `(?i)`, `\p{L}`;
   `length()` of a string holding an emoji.
5. **Execution blow-up from re-inlined correlated subqueries** (one query 269 ms → 72 s on 3k vertices).
6. **A real bug:** dedup keys built twice (`typedEquality` applied inside `dedupOn` again,
   `src/compiler/rel/lower/slice.ts`), so `g.inject(3,1,2,3).dedup()` returns `[1,2,3]` not `[3,1,2]`.

## Principles (now in `CLAUDE.md`)

1. **Semantic equivalence, not output equivalence.** The reference decides WHICH rows and values a query
   returns — not evaluation order, laziness, when an error fires, the order of an unordered stream, or
   number spelling.
2. **Numbers:** keep the CLASS (Int, Long, Double, Float, BigDecimal, Boolean) on output. Values compare and
   merge by SQLite value plus a coarse family (boolean, number, string, other). JS doubles; no signed zero;
   no out-of-range carriers; no NumberHelper/Float32 emulation in SQL; the result class from a cheap static
   or storage-class meet.
3. **Text:** JS `RegExp`, SQLite code-point order, SQLite `length`/`substr`, ASCII case mapping.
4. **Writes:** a write step sees a SNAPSHOT of its input; steps after it see all of its writes.
5. **Errors:** eager and in-statement; a query containing a type error may raise wherever SQLite
   evaluates the bad value.
6. **Never decline on data size.**
7. **A decline costs the user something** — never one only to protect an emulation.
8. **Every new per-row SQL term needs a user-visible reason** in the commit that raises the
   `sql-hygiene` baseline; an expression referenced N times is computed once.

Still never: lost or duplicated rows, wrong counts, wrong elements written or dropped, a wrong number class
where it shows (3 vs 3.0), crashes, internal/bare `Error`s reaching a user.

## Per-cluster verdicts (≈8,000 src lines to remove, ~70% of the net growth; L3 expected to hold 1873)

| # | Cluster | Verdict | Keep |
|---|---|---|---|
| 1 | Number class, Double exactness, typed equality (+5.6k) | simplify, ~2,000 lines | the class authority; tagged/untagged merge; stored whole Double groups with computed 1.0; the variant class column; alias-rebind class; `numberClassOf`; federate `leafStore` + bigint guard; atomic write programs / bulk load / replication; all-null `mean()` = null; `within(null)`; `mergesNothing`; `inject(1m).is(1)`; the 17-digit JSON spelling. REVERT the Float authority (store a Float as the Double of its literal, `Math.fround` at the framer) and the out-of-range Double carrier; min/max winner keeps its own class over a plain ranked window; sum/mean keep the class bitmask, drop the signed-zero/NaN/BigDecimal+Double deferrals; predicates compare by numeric value; typed equality = SQLite value + coarse family, so dedup returns to `DISTINCT` |
| 2 | Signed zero and big-zero ordering/compare (~640) | revert, ~600 | a child `by()` key carries its vtype so a stored BigDecimal sorts numerically — re-express as `storedCompareOn(childValue.vtype)` |
| 3 | Java strings, regex, format (~1.15k) | revert most, ~700 | per-position regex survivor binds; TextP exact case; `necessaryTextAtom` (and-walk); `unescapeJava`; the NUL literal decline; `split()` in JS; ResumeGap and `format()`-absent-property fixes. REVERT UTF-16 order in `emit.ts`, `javaPatternAsJs` (plain `RegExp`: try `u`, fall back, one `UnsupportedTraversal` if both fail; a small conservative trigram scanner), NUL/astral guards + `assertCarriable`, `format()`'s multi-valued raise and T/Direction key test. SIMPLIFY `format()` tokens to one CASE; `toUpper`/`toLower` to SQLite ASCII |
| 4 | Raise channel and error surface (+2.3k) | revert to eager (`593317fe`), ~1,300 | the five guards as one raise; `hostTag`; every no-bare-`Error` change; ±Infinity in collections; per-value `dateAdd` message; ReadOnly verification as one walk with a `ValueParseError` |
| 5 | Bulking positions and TraverserSet merges (+3.4k) | revert, ~1,700 | `count(1)` (SQLite bug); per-start reducing-option gate (+2 L3); `optional(count())` per start; `mergePeerArms`; mergeV origin key; `path().by()` value positions. Branch key becomes `row_number() OVER (ORDER BY input.encounter, arm_ordinal, arm.encounter)`; start-major for flatMap/local bodies; revert the EarlyLimit broadening |
| 6 | Write interleave (+1.66k) | revert, ~1,300 | side-effect-under-slice decline; `iterate()` → `discard()`; `where(as(unbound))` decline; the `name()` mint; shared-creation onMatch without `ProgramWrites.reads`/`overwritten` |
| 7 | Presence, map scope, path entries, collections (+1.5k) | simplify, ~700 | pooled group regroup; non-reducing group value bodies; `recordValOf`; select-reads-record-fields; `writesAnywhere`; nested map `json()`; `withEnclosing`; the correlated collector decline; `where(P)` scope keys; `mapScopeMayHold`. Presence = `value IS NOT NULL`; `coalesce()` = SQL `COALESCE`; the traverser's own map wins over a same-named label/side effect; no path-entry maybe lattice; read the completed collection |
| 8 | Federate and bulk atomicity (~300) | mostly keep, ~70 | bulk expansion, journal, atomic replication, element ids as map keys, `leafStore`, `unifiedBoundGraph` decline. DELETE `wireCarrier`, `BINARY64_WRITE_TAGS`, `keyCanon`; the `by(select('a'))` key reuses the `as()` site's JSON spelling. Follow-ups: bulk as `[id, bulk]` pairs; clear the journal in bounded chunks |

## Work order (value per unit of risk; each lands alone)

1. Delete the merge-window raise.
2. Delete `barrierHoldsAll`.
3. Fix the double `typedEquality`.
4. Revert UTF-16 ordering.
5. Revert signed-zero and big-zero ordering/compare.
6. Remove the remaining signed-zero code.
7. Revert the write-interleave guards (snapshot writes).
8. Revert the raise channel (eager raises).
9. Revert the merge-position emulation.
10. Simplify the branch emission key.
11. Revert the Float authority.
12. Revert the out-of-range carrier.
13. Simplify the sack.
14. Typed equality to value + family.
15. Simplify min/max, sum and BigDecimal.
16. Simplify predicate compare cells.
17. Simplify asString and format.
18. Revert the Java regex translation.
19. Remove the text guards.
20. Simplify presence.
21. Map scope, path entries, lazy collections.
22. Small items (JSON key spelling, ReadOnly message, EarlyLimit, the `by(select)` key).
23. Substrate: compute multiply-referenced expressions once.
24. Docs and CLAUDE.md (this doc, the principles, §17 of the matrix, the pruned RelIR plan and
    outstanding-work residue).

Items 7, 8 and 9 touch many call sites: diff each site against its pre-cluster form (`a34c4df6`, or
`593317fe` for the raise channel) rather than re-deriving it. Re-run L3, L5 and the census after each item
and re-record `sql-hygiene` intentionally, with the reason in the commit.

**Tests.** L4 addendum features and unit tests that pin only Java's EXECUTION are deleted or rewritten to
the natural answer by the item that removes their machinery — not kept as `@Unsupported`:
`traverser-set-merge`, `raise-extent`, `raise-order`, `write-interleave`, `side-effect-lazy-read`,
`by-productive-null` (plus the signed-zero / UTF-16 / Java-regex / number-spelling exec tests). Tests for
genuinely-wrong-answer fixes stay. L3 must not lose a scenario unless the commit names it as a
Java-execution detail. Ownership (the feature goes in the SAME commit as its machinery, never before, so
trunk stays green): `traverser-set-merge` and `sorted-host-merge` → item 9; `raise-extent`, `raise-order`
→ item 8; `write-interleave`, `write-after-write-one-traverser-at-a-time`,
`merge-one-traverser-at-a-time` → item 7; `side-effect-lazy-read` → item 21; `by-productive-null` →
item 20 (rewritten to the presence answer, not deleted, where it pins a row).

## The unfinished wf16 backlog

- **coalesce/choose arm merge positions — DROPPED** (extends the merge emulation).
- **split label carry across a JS resume — KEPT, low priority, rescoped**: carry the label column through
  the resume, no order or merge semantics.
- **where Map-first scope — FOLDED** into item 21 ("the traverser's own map wins").

## Where effort should go instead (sensible queries still declined)

The genuine-answer residue the simplification does NOT touch — `g.V(1,1)` as one traverser, unordered-map
`dedup()`, the untagged whole REAL at `lowerValueResume`, `combine([1.0d])`'s member class, the bare-list
`[1L]` decline, an un-widened intermediate overflow — is listed in `docs/outstanding-work.md` ("Still open —
genuine answers") and stays open work. Beyond it:

- `where(without('x'))` after `aggregate('x')`, as `NOT IN (SELECT … FROM <collection>)`.
- `repeat(...).until(where(eq('a')))`.
- `choose()` with mixed list-shaped arms.
- `group().by(...).by(out().limit(1).fold())` as a per-key `ROW_NUMBER` window.
- The trunk regression `g.V().hasLabel('person').where(values('name').toUpper().is('MARKO'))`, probably
  from `792b9816`.
