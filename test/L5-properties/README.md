# L5 — property-based testing

Run with `mise run L5` (fixed seed, part of `bun test`). Explore with `mise run L5-random`.

Both need the **submodule**, unlike L1/L2: the differential executes its traversals through the real
`Executor`, which frames via `src/io.ts` → `gremlin/io`, an export only the submodule-linked client
has. Parsing and compiling are submodule-free; running is not.

L1–L4 assert things about traversals **someone wrote down**. L5 asserts things about traversals
**nobody wrote down**: it generates well-typed Gremlin and checks a property that must hold for all
of it. That makes it the instrument for the *ceiling* `test/CLAUDE.md` describes — "generic lowering
that composes the full nested Gremlin grammar at any valid depth/combination" — which the L3 count,
by construction, cannot measure.

## The oracle: fast paths on ≡ fast paths off

`src/compiler/options/fast-paths.ts` defines six independently switchable optimized lowerings, and
each one's own doc comment promises the same thing: *"Disabling routes through the generic path —
result-equivalent."* `FastPath.equivalentWhen` makes that a required field and
`test/compiler/fast-paths.exec.test.ts` enforces the field is non-empty — but nothing checked the
claim. L5 is that check:

> for every traversal `q`: `run(q, fast paths on)` ≡ `run(q, fast paths off)`

No reference implementation, no expected-value table, no JVM. The generic path is the declared
semantic authority, so any disagreement is a defect on the optimized side — the property is
self-oracling. `differential.test.ts` also runs each of the six switches **in isolation**, which
attributes a divergence to one path and catches pairs whose errors cancel when both are off.

### The blind spot: a defect both paths share

The differential compares the two lowerings against *each other*, so it can only ever see a
**disagreement**. A bug present in both — or one whose two halves cancel — is invisible to it by
construction. There is a live example: `g.V().order().by('age')` returns all 6 modern-graph vertices
under both configs, where TinkerPop returns 4 (a non-productive `by(key)` drops traversers lacking the
key). Both sides agree, so L5 reports nothing.

Worse, that defect **cancels** one of the three findings on the traversal that first surfaced it, and
the resulting L3 scenario *passes* — for entirely the wrong reason (see the second entry in
`known.ts`). So: this oracle is strong evidence about the optimized lowerings and no evidence at all
about shared semantics. The oracles in "Where this could go next" below — metamorphic laws in
particular — are what cover that gap, because they compare against a *law* rather than against
another implementation.

### What "equivalent" means

A **bulk-weighted multiset**: `hex(GraphBinary value) → Σ bulk`. This is the only comparison that
survives the `movementCollapse` switch, which emits one row carrying `SUM(bulk)` where the generic
form emits `bulk` separate rows — the same traverser multiset in two representations. It is also
just what a traverser multiset *is* (CLAUDE.md: "Traversers are multisets"). Expanding bulk into
literal copies would be equivalent but is not an option: collapse exists because the walk count it
folds can be exponential.

Three divergence kinds; two of them gate:

| Kind | Gates | Meaning |
|---|:--:|---|
| `support` | ✅ | One side ran, the other threw. A fast path must never change *whether* a traversal is supported. |
| `multiset` | ✅ | Both ran, different traverser multisets. The headline defect — a fast path answering a different question. |
| `order` | ❌ | Same multiset, different emission order. **Telemetry only** — see below. |

`order` does not gate because `order().by(key)` establishes only a *partial* order: tied traversers
have unspecified relative order, so a diff there is within spec. Distinguishing a tie reordering from
a genuine mis-ordering needs the projected sort keys, and this oracle compares encoded values.
Gating on the coarse "does the source contain `order(`" test produced exactly one false positive of
the tie kind, so that test was withdrawn rather than kept and ratcheted.

## Two input sources

**Corpus** (`../L1-corpus/corpus.txt`) — the 2,298 canonical TinkerPop traversals, ~1,368 of which
execute against the modern graph. Real Gremlin, deterministic, no generator risk; but fixed, so it
only reaches compositions somebody already wrote.

**Generated** (`shape.ts` + `generate.ts`) — fast-check walking a shape lattice. Narrower vocabulary,
unbounded composition: it reaches nesting depths and step combinations no corpus contains. In the
first sweep it found 16 of 17 divergence signatures; the corpus found the other one.

## Confining generation to valid permutations

Gremlin's *string* grammar is far looser than Gremlin's *typing*. `chainedTraversal: traversalMethod
(DOT traversalMethod)*` admits `count().out()` — syntactically fine, semantically nonsense — so
generating from `Gremlin.g4` would spend its budget on noise. The real constraint is
`Traversal<S,E>`: a step's legality depends on the **shape** of the stream it applies to. So the
generator is a state machine — **state = shape, transition = step** — and the next step is drawn only
from the current shape's legal set. `count().out()` is unreachable by construction.

`shape.ts` is that lattice: seven shapes (`vertex`, `edge`, `scalar`, `list`, `record`, `group`,
`path`), 108 transitions. Child bodies recurse through the same walk from the body's own input shape,
so nesting depth is a parameter rather than a list of hand-written cases.

**Why the table is hand-written and not reflected out of the compiler's dispatch maps.** The compiler
already encodes this lattice — a `Stream` union with a per-shape dispatch `Map` each (`TAIL`,
`SCALAR_TAIL`, `LIST_TAIL`, …). Deriving the table from those Maps would keep it permanently in sync
and make it useless: validity would be *defined* as "what the compiler already supports", so a
generated traversal could never be a valid-but-unsupported one — and those are exactly the findings
worth having. The table is therefore independent, and `table.test.ts` guards it behaviourally instead:
every generated traversal must **parse and chain** (L1's bar, applied to permutations), every
transition must actually get drawn, and the gap against the corpus vocabulary is printed as a
table-growth list.

Shrinking is why this is fast-check and not a hand-rolled loop. A divergence found at depth 4 inside
two nested branches is unusable until minimised; fast-check shrinks the underlying choice sequence,
walking the traversal back to the smallest chain that still diverges. The first run shrank a 7-step
nested counterexample to a 4-step one.

## The ratchet — which runs the opposite way from L3's

`known.ts` is a ratchet in the sense that it's a committed baseline a run cannot silently slip past,
but it is **not** L3's kind and the difference matters:

| | L3 (`l3-state.json`) | L5 (`known.ts`) |
|---|---|---|
| Shape | a **count** floor | an **exclusion list** |
| Direction | ratchets **up** — more scenarios passing | ratchets **down** — fewer known defects |
| Target state | maximal count | **empty list** |
| Gate | count ≥ floor, no named regression | zero *unexplained* divergences (a fixed bar) |
| Maintenance | machine-updated | hand-edited, diagnosis required |

So "the L5 number went up" is never good news, and there is no number to go up: the bar is a constant
zero, and the only thing that moves is how much of the world is exempted from it. Adding an exemption
is a visible edit to a reviewed file, not a regenerated artifact.

Two rules:

- **One entry per root cause, not per traversal.** The first sweep produced 22 divergent traversals
  in 17 signature groups that reduce to 3 causes. Recording signatures would have buried the fact
  that two lines of one file explain most of them.
- **Every entry states the defect and the fix.** An entry without a diagnosis is a silenced test.
  A `family` matcher (keyed on the divergence *message* where possible, not guessed query shapes)
  covers the variants a generator keeps rediscovering.

An entry is always a bug we haven't fixed — never an acceptable divergence. There is no such thing
here: the generic path is the authority. Emptying the list is the goal. A "stale entry" test fails if
a KNOWN entry stops reproducing, so a fix can't leave dead weight behind.

## Seeds — and the honest limit of a fixed one

CI runs a **fixed seed** (42), because a property test that flakes is a property test people disable.
Be clear about what that buys and what it costs:

Seed 42 + `numRuns: 300` is a **deterministic generated corpus** — the same 300 traversals every run.
So in CI, L5 is a *regression gate over generated inputs*, not an explorer: after the first run it
will not discover anything new on its own. Its value there is that it holds the fast-path equivalence
property over inputs no human curated, and that it re-checks the whole L1 corpus (which *is* fresh
work, since nothing else executes the generic lowering path).

Discovery lives in `mise run L5-random` — random seed, 10× sample. **Nothing invokes it
automatically**, so today discovery depends on someone remembering. The natural fix is a scheduled
run that reports rather than blocks (a nightly job opening an issue on a new signature); until that
exists, run it by hand after touching a fast path, the child seam, or the predicate layer.

The six isolation tests use `SEED + i` rather than `SEED`, so they sample six *different* traversal
sets instead of re-examining one. `L5_SEED` and `L5_RUNS` override everything.

## Files

| File | |
|---|---|
| `oracle.ts` | the differential: run under two configs, compare bulk-weighted multisets |
| `shape.ts` | the shape lattice — shapes, transitions, and the graph vocabulary |
| `generate.ts` | the fast-check arbitrary that walks the lattice |
| `known.ts` | the ratchet: diagnosed divergences, one per root cause |
| `differential.test.ts` | the properties, over corpus + generated, all-off and one-at-a-time |
| `table.test.ts` | the lattice's own guards (parse/chain, transition coverage, corpus gap) |

## Where this could go next

The differential is the cheapest of four oracle designs and covers the optimized lowerings. Three
others need no reference implementation either:

1. **Transparent-wrapper equivalence** — if `q` yields rows, so must `local(q)` / `union(q)` /
   `filter(__.identity())`-wrapped `q`. Targets the silent-`[]` class CLAUDE.md flags twice.
2. **Metamorphic laws** — `out(l) ≡ outE(l).inV()`; `count() ≡ fold().count(local)`;
   `where(b) ⊎ where(not(b)) = identity`.
3. **Fail-closed discipline** — every generated traversal's outcome must be rows or a *clear
   deferral*, never a raw `TypeError` or SQLite error. (L5's first run already found the generic path
   emitting `Binding expected string, …` — a raw bind error where a deferral belongs.)
