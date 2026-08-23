# Property-based testing (L5) — design rationale

Mechanics + how to run it: `test/L5-properties/README.md` (current-state only). This holds the *why*:
the design space, the oracles not built, and the architectural lessons the work produced.

## The problem L5 exists to solve

L1–L4 all assert about traversals **someone wrote down** — a fixed corpus, a snapshot, a Gherkin
scenario. The goal `test/CLAUDE.md` states they cannot measure is the **ceiling**: "generic lowering
that composes the full nested Gremlin grammar at any valid depth/combination". A rising L3 count is a
*side effect* of ceiling work, never a measurement of it — the corpus samples the compositions
TinkerPop's authors happened to write, and says nothing about depth-4 nestings nobody wrote. A
generator samples the composition space instead of enumerating a corpus, so it measures composition
directly. That is the whole argument for the level.

Second, narrower motive: `FastPathConfig`'s six switches each promise "Disabling routes through the
generic path — result-equivalent", and `FastPath.equivalentWhen` makes that a *required field*.
Enforced non-empty, but the claim behind it had never been checked — **no test had ever executed the
compiler's generic lowering path.** That mattered; see the findings.

## The oracle design space

The generator is easy; the oracle is hard. Four designs, all avoiding a reference implementation.
Three built.

| | Oracle | Cost | Covers | Status |
|---|---|---|---|---|
| 1 | **Fast-path differential** — `run(q, on) ≡ run(q, off)` | lowest | the six optimized lowerings | **built** |
| 2 | **Transparent-wrapper equivalence** — if `q` yields rows so must `local(q)` / `union(q)` / `filter(__.identity())`-wrapped `q` | low | the silent-`[]` class CLAUDE.md flags twice | **built** — folded into 3 (same comparison + harness) |
| 3 | **Metamorphic laws** — `out(l) ≡ outE(l).inV()`, `count() ≡ fold().count(local)`, `where(b) ⊎ where(not(b)) = identity` | medium | semantics BOTH lowerings share | **built** (`laws.ts`, `metamorphic.test.ts`) |
| 4 | **Fail-closed discipline** — every outcome is rows or a *clear deferral*, never a raw `TypeError`/SQLite error | low | the guardrail's own claim | **built** (below) |

Differential-vs-TinkerPop (a real JVM reference) was rejected: it is the gold oracle but needs a JVM
in CI, for a fraction more coverage than 1–4 give combined.

**Why 1 first.** Self-oracling: `options/fast-paths.ts` declares the generic path the *semantic
authority*, so a disagreement is by definition a defect on the optimized side — no expected-value
table, no reference, nothing to maintain. It also covered the code with least prior coverage, since
nothing had ever run the generic path.

**Why 3 mattered most.** It is the only oracle that sees a defect the two lowerings *share* — e.g.
`otherV()` miscounting under live path tracking, and a non-terminal `fold()` after `dedup()` folding
the un-deduplicated multiset, both invisible to the differential. A found-but-unfixed break is carried
as a `knownBroken` entry on its law (like `known.ts`: a tracked bug, never an acceptable exception),
and a stale-entry check fails if an entry stops reproducing.

Two design points worth keeping. **A law is instantiated over a GENERATED prefix** — `out(l) ≡
outE(l).inV()` as a fixed pair is one assertion; over a few hundred generated vertex-shaped contexts
it is a claim about composition, and shrinking reduces a break to the smallest context that causes it.
**Gating differs from the differential**: there, one side throwing IS a defect (a fast path must not
change what is supported); here it only means the law is not evaluable, so it is counted and reported,
split by whether the PREFIX or the law's own FORM was unsupported — the latter the more interesting
signal.

Oracle 4 (fail-closed discipline) is built twice: `test/census/` separates `crashed` from `deferred`
over the whole corpus and gates the count from growing; `test/L5-properties/capability.test.ts` +
`capability-baseline.ts` permit executions and *declared* deferrals over generated compositions while
failing on any new raw failure. The census covers what somebody wrote down; the capability ratchet
covers what the lattice can compose.

## The blind spot — and why it is structural

The differential compares the two lowerings *against each other*, so it sees only a **disagreement**.
A defect present in both, or one whose two halves cancel, is invisible by construction. This is not a
gap to patch; it is what the design is.

Four such defects were found this way — the first two by hand while diagnosing differential output,
the last two by oracle 3, which exists precisely to find them. The value is the FAILURE MODE each
names:

- **Non-productive `by(key)` was not applied at `order()`.** `g.V().order().by('age')` returned all
  six modern-graph vertices; TinkerPop returns four (the two software vertices have no `age`). Both
  configs agreed.
- **An unproductive `sum()`/`min()`/`max()`/`mean()` body in a filter position still keeps the
  traverser.** `g.V().where(__.out().values('age').sum())` returned all six; TinkerPop returns one.
  Both configs agreed.
- **`otherV()` miscounts while path tracking is live** — `g.V().out().simplePath().bothE('created')
  .otherV()` disagreed with `.both('created')`, though the `simplePath()` is provably a no-op there.
- **A non-terminal `fold()` after `dedup()` folds the un-deduplicated multiset** — `dedup()` gave 4,
  `dedup().fold().unfold()` 6.

Worse than invisible: the first **cancelled** one of the differential's own findings on the traversal
that surfaced it, so the corresponding L3 scenario *passed for entirely the wrong reason* while its
`@WithProductiveByStrategy` twin failed. Two compensating bugs read as conformance. That is the case
for oracle 3: a metamorphic law compares against a *law*, not another implementation, so shared defects
have nowhere to hide.

## Why the shape lattice is hand-written

Gremlin's *string* grammar is far looser than its *typing*: `chainedTraversal: traversalMethod (DOT
traversalMethod)*` admits `count().out()`. Generating from `Gremlin.g4` would spend its budget on
syntax noise. The real constraint is `Traversal<S,E>` — a step's legality depends on the **shape** of
the stream it applies to — so the generator is a state machine, state = shape, transition = step.

The compiler already encodes that lattice (a `Stream` union with a per-shape dispatch `Map`).
Reflecting the generator's table out of those Maps was **rejected**: validity would then be *defined*
as "what the compiler already supports", so a generated traversal could never be a
valid-but-unsupported one — precisely the ceiling findings worth having. The table is therefore an
independent statement of Gremlin's typing, guarded behaviourally instead (`table.test.ts`: every
generated traversal must parse and chain, L1's bar over permutations).

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

There is no L5 number to improve; the bar is a constant zero, and the only thing that moves is how much
is exempted. An exemption is a reviewed edit to a committed file, not a regenerated artifact — and it is
always a bug we have not fixed, never an acceptable divergence, because the generic path is the
authority. A stale-entry test fails if a `KNOWN` entry stops reproducing, so a fix cannot leave dead
weight behind.

Entries are **one per root cause, not per traversal**: the first sweep's 22 divergent traversals fell
into 17 signature groups that reduced to four causes. Recording signatures would have written 17
near-identical entries and buried the fact that a couple of lines in one file explained most of them.

## Seeds: why a fixed one is a dead instrument

**The invariant everything here is subordinate to: CI runs exactly what a developer runs.** `ci → test
→ L5`, no CI-specific seed, sample size or skip. L5 derives its seed from `HEAD`, so the same commit
draws the same corpus on a laptop and a runner while each commit explores a new one. Any scheme making
those two builds behave differently is rejected on that ground alone.

A fixed seed buys determinism and costs the entire point of the level. Seed 42 + `numRuns: 300` is a
deterministic corpus — the same 300 traversals every run, every machine — so L5 becomes a regression
gate, not an explorer, discovering nothing new after the first run. The original argument was sound but
drew the wrong conclusion: *a property test that flakes is one people disable* — true, but the fix is
to make a fresh seed non-flaky, not to stop drawing one.

**The scheme: a HEAD-derived seed plus a witness ratchet, inside the standard build.** Every `mise run
test` — laptop or runner, same task, no `$CI` branch — derives a seed from the commit, PRINTS it, and
gates against the committed witness lists rather than "did anything fail":

- **The seed changes per commit and is printed.** `L5 generated: 300 traversals @ seed 81423
  (HEAD-derived; L5_SEED=81423 to reproduce)`. Reproduction is one env var — non-negotiable regardless
  of how clever the rest gets.
- **The gate is NEW signatures only.** A raw failure already in `capability-baseline.ts` (with its
  diagnosis) is drawn, counted, reported — it does not fail the build. A signature in no ratchet fails
  it. Green on a novel seed that only re-finds tracked defects; red exactly when the seed found
  something nobody has diagnosed.
- **That is what makes rotation safe.** The flake objection assumes a fresh seed means a fresh failure;
  with the ratchet consulted, a fresh seed means fresh *coverage*, and only genuinely new information
  stops the build.

Two properties fall out that a scheduled run could never have. Discovery becomes **unmissable rather
than remembered** — on the build everyone already runs, so no step to skip after touching a fast path.
And a new signature arrives **attached to the change that exposed it**, when its author has the context
to diagnose it.

The cost is honest: the ratchets become load-bearing at build time, so **an undiagnosed entry silences
a real finding on every future run.** Both files say exactly that, and both have stale-entry checks —
this scheme is what those checks were written for.

**Reproducibility of a red build.** The printed seed makes any failure re-runnable verbatim
(`L5_SEED=81423 mise run L5`), and because CI and local run the same task with the same draw rule, a
runner failure reproduces on a laptop by construction, not by luck.

**Draw rule — settled.**

| | Per-run `$RANDOM` | Derived from `HEAD` |
|---|---|---|
| Discovery | every run, maximal | every commit |
| Re-running the SAME commit | a different corpus | identical — retry-stable |
| A red build | reproduces via the printed seed | reproduces by checking out the commit |

`HEAD`-derived fits "CI runs what you run": the same commit gives the same corpus everywhere, so CI
cannot fail on a draw the author's identical local run never made. Per-run `$RANDOM` finds more per
unit time and suits `L5-random`, the deep sweep — not the gate.

## What it found (the case for the level)

First run: 22 divergent traversals, 17 signature groups, **four root causes** — every one a real
defect, two of them silent wrong answers. Each is pinned in an L4 `.feature`, so the ceiling finding
became floor.

1. Infix-composed predicates (`P1.or(P2)`, `TextP…and(…)`, `negate()`) were **flattened by the
   front-end** into sibling args, so the connective was lost before the compiler saw the chain and the
   second operand was silently dropped.
2. 3-arg `has(LABEL,k,v)` inside any predicate body evaluated to constant FALSE (constant TRUE under
   `not()`) — the inline leaf destructured two args regardless of arity.
3. `predicateInlining` was **not disable-safe**: a predicate body ending in a reducer/projection was
   lowerable only by the fast path, so disabling it *narrowed* support — the contract inverted. Plus a
   bogus `and()/or() needs at least two branches` guard that made the inline path narrower than the
   path it accelerates.
4. `bulkRepeatCount` seeded its frontier with `COUNT(*)` — rows, not traversers. The path forces
   `movementCollapse` on, so a movement prefix arrives already collapsed and `E().outV()` hands the seed
   one row with `bulk=3`; the input multiset was flattened.
   `g.E().outV().repeat(__.both("knows")).times(2).count()` gave 4 where 10 is correct — **a wrong
   answer in the default (production) config**.

## Architectural lesson: the anchor rule (superseded framing — see the bright line)

**This section originally drew the wrong lesson from its own evidence.** Corrected here rather than
deleted, because the coarse version got cited. The durable authority on the boundary is the bright line
in `src/compiler/CLAUDE.md`.

The case: non-productive `by(key)` at `order()`, implemented as a `decoration` **Pass** injecting
`has(key)` before the order — one central place, all four of `order()`'s lowering routes inheriting it.
It broke all six non-element `order().by(key)` forms (list, map, group, record, scalar, path), because
`has(key)` means nothing on any of them.

The rule this section used to conclude — *"an IR Pass may rewrite what is decidable from the chain;
anything needing the stream's shape belongs in the lowering"* — is **too wide, refuted by two correct
Passes in the same file.** `injectSubgraphRec` and `injectPartitionRec` inject shape-specifically from
the IR and are right to: they anchor on `VERTEX_PRODUCERS`/`EDGE_PRODUCERS` (`ir/strategies.ts:201-203`),
step names whose output shape is fixed **by the name alone**. `order()`'s output shape is its input
shape, so it had no such anchor. The failure was not missing information — it was an **unchecked shape
claim.**

One adjacent fact: "the IR has no shape" is not a law but a property of a struct definition —
`PassContext` (`ir/pass.ts`) has no shape field *and no `ChainFacts` field* by construction, and
`ChainFacts` (`ir/analyze.ts`) annotates the chain without rewriting it.

So the rule to apply is the bright line, which subsumes this section:

> **Shape may be an annotation a Pass CONSULTS and may decline on. It must never be a representation a
> Pass CONSTRUCTS or lowering CONSUMES. Sharing across shapes is by registration into a Map, never a
> widening fallback chain.**

And the sharper half — the reason not to simply add the field: **a fail-closed lowering throws; a
declining decoration Pass is silent.** A shape-guarded Pass hitting `unknown` silently reproduces the
original wrong answer — and L5's differential cannot see it, because both configs decline identically.
The loud variant is no better: throwing when element-ness is unprovable would reject every non-element
`order().by(key)` form that works today, violating "never reject a valid input to keep scope small".
Both failure modes argue for the anchor rule as a **type-level prohibition** rather than a documented
convention — this repo has the receipt in `FastPath.equivalentWhen`, a required field whose claim had
never been checked.

Keep the proportion in view: of 36 diagnosed defects, exactly **one** was missing shape information —
this revert — and it argues against shape-in-the-IR rather than for it (`src/compiler/CLAUDE.md`, the
base rate).

What survives unchanged is the *mechanical* conclusion: the way to avoid N divergent copies in the
lowering is one representation-neutral predicate builder each site feeds its own key expression —
`orderProductivityFilter` (`steps/tail/modulation.ts`), sharing `classifyBy` with the sort terms so the
filter and the `ORDER BY` cannot disagree about which `by()`s project a key. `dedup().by()` had reached
that independently; this generalised its one line.

The contrast still holds for `alwaysProductiveFilterIsNoOp` (a `simplify` Pass): "does this body always
produce a traverser" is decidable from the chain alone — no shape claim, anchored or otherwise — so it
*is* correctly a Pass, and being one is what makes `predicateInlining` disable-safe there, since neither
lowering ever sees the removed step.

## Open

Remaining compiler and oracle work lives in `docs/outstanding-work.md`. `L5-random` (`mise run
L5-random`) is the larger, deliberately random sweep — its findings get diagnosed into `known.ts` (or
fixed) and, per `test/CLAUDE.md`, promoted into an L4 `.feature` so the floor rises permanently.
