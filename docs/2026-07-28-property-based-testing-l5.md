# Property-based testing (L5) — design rationale

Landed 2026-07-28. Current mechanics + how to run it: `test/L5-properties/README.md` (that file is
deliberately current-state only). This one holds the *why*, the design space we did not build, and the
architectural lessons the work produced.

## The problem L5 exists to solve

L1–L4 all assert things about traversals **someone wrote down** — a fixed corpus, a snapshot, a
Gherkin scenario. `test/CLAUDE.md` states the goal those cannot measure: the **ceiling**, "generic
lowering that composes the full nested Gremlin grammar at any valid depth/combination". A rising L3
count is a *side effect* of ceiling work, never a measurement of it: 2,297 scenarios sample the
compositions TinkerPop's authors happened to write, and say nothing about depth-4 nestings nobody
wrote.

A generator samples the composition space instead of enumerating a corpus, so it measures composition
directly. That is the whole argument for the level.

Second, narrower motive: `FastPathConfig`'s six switches each promise "Disabling routes through the
generic path — result-equivalent", and `FastPath.equivalentWhen` makes that a *required field*. The
field was enforced non-empty; the claim behind it had never been checked. **No test had ever executed
the compiler's generic lowering path.** That turned out to matter — see the findings below.

## The oracle design space

A generator is easy; the oracle is the hard part. Four designs were considered, all of which avoid a
reference implementation. Only the first is built.

| | Oracle | Cost | Covers | Status |
|---|---|---|---|---|
| 1 | **Fast-path differential** — `run(q, on) ≡ run(q, off)` | lowest | the six optimized lowerings | **built** |
| 2 | **Transparent-wrapper equivalence** — if `q` yields rows so must `local(q)` / `union(q)` / `filter(__.identity())`-wrapped `q` | low | the silent-`[]` class CLAUDE.md flags twice | not built |
| 3 | **Metamorphic laws** — `out(l) ≡ outE(l).inV()`, `count() ≡ fold().count(local)`, `where(b) ⊎ where(not(b)) = identity` | medium | semantics BOTH lowerings share | not built |
| 4 | **Fail-closed discipline** — every outcome is rows or a *clear deferral*, never a raw `TypeError`/SQLite error | low | the guardrail's own claim | not built |

Differential-vs-TinkerPop (a real JVM reference) was rejected: it is the gold oracle and needs a JVM
in CI, for a fraction more coverage than 1–4 give combined.

**Why 1 first.** It is self-oracling. `options/fast-paths.ts` declares the generic path the *semantic
authority*, so a disagreement is by definition a defect on the optimized side — no expected-value
table, no reference, nothing to maintain. It also happened to cover the code with the least prior
coverage, since nothing had ever run the generic path.

**Why 3 matters most next.** See the blind spot below.

## The blind spot — and why it is structural

The differential compares the two lowerings *against each other*. It can therefore only see a
**disagreement**. A defect present in both, or one whose two halves cancel, is invisible to it by
construction. This is not a gap to patch; it is what the design is.

Two such defects were found by hand while diagnosing the differential's output, and neither could ever
have been found by it:

- **Non-productive `by(key)` was not applied at `order()`.** `g.V().order().by('age')` returned all
  six modern-graph vertices; TinkerPop returns four (the two software vertices have no `age`). Both
  configs agreed. Fixed.
- **An unproductive `sum()`/`min()`/`max()`/`mean()` body in a filter position still keeps the
  traverser.** `g.V().where(__.out().values('age').sum())` returns all six; TinkerPop returns one.
  Both configs agree. **Still open** — `docs/outstanding-work.md` item 0.

Worse than invisible: the first of those **cancelled** one of the differential's own findings on the
traversal that surfaced it, so the corresponding L3 scenario *passed for entirely the wrong reason*
while its `@WithProductiveByStrategy` twin failed. Two compensating bugs read as conformance.

That is the case for oracle 3: a metamorphic law compares against a *law*, not against another
implementation, so shared defects have nowhere to hide.

## Why the shape lattice is hand-written

Gremlin's *string* grammar is far looser than Gremlin's *typing*: `chainedTraversal: traversalMethod
(DOT traversalMethod)*` admits `count().out()`. Generating from `Gremlin.g4` would spend its budget on
syntax noise. The real constraint is `Traversal<S,E>` — a step's legality depends on the **shape** of
the stream it applies to — so the generator is a state machine, state = shape, transition = step.

The compiler already encodes that lattice (a `Stream` union with a per-shape dispatch `Map` each).
Reflecting the generator's table out of those Maps was considered and **rejected**: validity would
then be *defined* as "what the compiler already supports", so a generated traversal could never be a
valid-but-unsupported one — and those are precisely the ceiling findings worth having. The table is
therefore an independent statement of Gremlin's typing, guarded behaviourally instead
(`table.test.ts`: every generated traversal must parse and chain, L1's bar applied to permutations).

The cost of independence is that the table can be *wrong*, and twice was — each time by letting one
shape stand for two things (`element` covering vertex and edge, so it emitted `E().bothE()`; `list`
not recording what it was a list *of*, so it emitted `fold().sum(local)` over vertices). Both were
caught by the parse-and-chain guard, which is why that guard exists.

## Why the ratchet runs the opposite way from L3's

| | L3 (`l3-state.json`) | L5 (`known.ts`) |
|---|---|---|
| Shape | a **count** floor | an **exclusion list** |
| Direction | ratchets **up** | ratchets **down**, to empty |
| Gate | count ≥ floor, no named regression | zero *unexplained* divergences — a fixed bar |
| Maintenance | machine-updated | hand-edited, diagnosis required |

There is no L5 number to improve; the bar is a constant zero, and the only thing that moves is how
much is exempted from it. An exemption is a reviewed edit to a committed file, not a regenerated
artifact — and it is always a bug we have not fixed, never an acceptable divergence, because the
generic path is the authority. A stale-entry test fails if a `KNOWN` entry stops reproducing, so a fix
cannot leave dead weight behind.

Entries are **one per root cause, not per traversal**: the first sweep's 22 divergent traversals fell
into 17 signature groups that reduced to four causes. Recording signatures would have written 17
near-identical entries and buried the fact that a couple of lines in one file explained most of them.

## Seeds: what a fixed one buys, and what it costs

CI runs seed 42, because a property test that flakes is a property test people disable. Be honest
about the consequence: **seed 42 + `numRuns: 300` is a deterministic generated corpus** — the same 300
traversals every run. In CI, L5 is a regression gate over generated inputs, not an explorer; after the
first run it discovers nothing new on its own. Its standing value there is holding the equivalence
property over inputs no human curated, plus re-checking the whole L1 corpus through the generic path.

Discovery lives in `mise run L5-random`, and **nothing invokes it automatically** — today it depends
on someone remembering, after touching a fast path, the child seam, or the predicate layer. The
intended fix is a scheduled run that *reports* rather than blocks (a nightly opening an issue on a new
signature). Deliberately not in `ci`: a random-seed failure blocking a PR is how this level would get
disabled.

## What it found (the case for the level)

First run: 22 divergent traversals, 17 signature groups, **four root causes** — every one of them a
real defect, two of them silent wrong answers. Fixing them took L3 from 1,479 to 1,494 (+15, −0).

1. Infix-composed predicates (`P1.or(P2)`, `TextP…and(…)`, `negate()`) were **flattened by the
   front-end** into sibling args, so the connective was lost before the compiler saw the chain and the
   second operand was silently dropped. Front-end fix; +11 L3 on its own.
2. 3-arg `has(LABEL,k,v)` inside any predicate body evaluated to constant FALSE (and constant TRUE
   under `not()`) — the inline leaf destructured two args regardless of arity.
3. `predicateInlining` was **not disable-safe**: a predicate body ending in a reducer/projection was
   lowerable only by the fast path, so disabling it *narrowed* support — the contract inverted. Plus a
   bogus `and()/or() needs at least two branches` guard that made the inline path narrower than the
   path it accelerates.
4. `bulkRepeatCount` seeded its frontier with `COUNT(*)` — rows, not traversers. The path forces
   `movementCollapse` on, so a movement prefix arrives already collapsed and `E().outV()` hands the
   seed one row with `bulk=3`; the input multiset was flattened.
   `g.E().outV().repeat(__.both("knows")).times(2).count()` gave 4 where 10 is correct — **a wrong
   answer in the default (production) config**.

Each is pinned in an L4 `.feature`, so the ceiling finding became floor.

## Architectural lesson: shape is a lowering concern, not an IR one

Worth recording because the wrong version was written first and looked better.

Non-productive `by(key)` at `order()` was initially implemented as a `decoration` **Pass** injecting
`has(key)` before the order — one central place, every one of `order()`'s four lowering routes
inheriting it for free. That is wrong, and the tests said so immediately: the rewrite is only valid
over an **element** stream, and the IR layer has no shape information at all. It broke all six
non-element `order().by(key)` forms (list, map, group, record, scalar, path), because `has(key)` means
nothing on any of them.

Shape is exactly what the lowering knows and the IR does not. So the boundary is:

> An IR Pass may rewrite what is decidable from the **chain**. Anything needing the **stream's shape**
> belongs in the lowering.

The way to avoid N divergent copies in the lowering is not to move the decision upstream, but to make
it one representation-neutral predicate builder that each site feeds its own key expression —
`orderProductivityFilter` (`steps/tail/modulation.ts`), sharing `classifyBy` with the sort terms so the
filter and the `ORDER BY` cannot disagree about which `by()`s project a key. `dedup().by()` had reached
the same conclusion independently; this generalised its one line rather than adding a second idea.

The same distinction cuts the other way for the always-productive filter (`alwaysProductiveFilterIsNoOp`,
a `simplify` Pass): "does this body always produce a traverser" is decidable from the chain alone, so it
*is* a Pass — and being one is what makes `predicateInlining` disable-safe by construction there, since
neither lowering ever sees the removed step.

## Open

`docs/outstanding-work.md` item 0 — the unproductive-reducer filter defect, plus oracles 2–4 above.
