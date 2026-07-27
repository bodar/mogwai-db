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

## The ratchet

`known.ts`, in the spirit of `l3-state.json`: a committed floor, so a run fails on anything new while
diagnosed gaps don't block the gate. Two rules:

- **One entry per root cause, not per traversal.** The first sweep produced 22 divergent traversals
  in 17 signature groups that reduce to 3 causes. Recording signatures would have buried the fact
  that two lines of one file explain most of them.
- **Every entry states the defect and the fix.** An entry without a diagnosis is a silenced test.
  A `family` matcher (keyed on the divergence *message* where possible, not guessed query shapes)
  covers the variants a generator keeps rediscovering.

An entry is always a bug we haven't fixed — never an acceptable divergence. There is no such thing
here: the generic path is the authority. Emptying the list is the goal. A "stale entry" test fails if
a KNOWN entry stops reproducing, so a fix can't leave dead weight behind.

## Seeds

CI runs a **fixed seed** (42). A property test that flakes is a property test people disable.
`mise run L5-random` takes a random seed and a 10× sample for exploration; anything it finds gets
diagnosed into `known.ts` or fixed, and then — per `test/CLAUDE.md` — promoted into an L4 `.feature`,
so exploration permanently raises the floor. `L5_SEED` and `L5_RUNS` override both.

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
