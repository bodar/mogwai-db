# L5 — property-based testing

**Current state and how to run it.** Design rationale, the oracle design space, and the open work are
in `docs/2026-07-28-property-based-testing-l5.md` — this file deliberately describes only what is
there now.

```
mise run L5          # fixed seed 42, 300 generated traversals; also runs inside `mise run test`
mise run L5-random   # random seed, 3,000 traversals — exploration, NOT a CI gate
L5_SEED=n L5_RUNS=n  # override either
```

Both need the **submodule**, unlike L1/L2: the differential executes its traversals through the real
`Executor`, which frames via `src/io.ts` → `gremlin/io`, an export only the submodule-linked client
has. Parsing and compiling are submodule-free; running is not.

## Status

- **The ratchet (`known.ts`) is EMPTY.** No known fast-path divergence.
- Corpus: 2,298 traversals, **~1,368 executable**, 0 unexplained divergences.
- Generated: 300 @ seed 42, **~203 executable**, 0 unexplained divergences.
- Verified at a larger scale than CI runs: 4,000 generated traversals with every switch off, plus 900
  per switch with each one off alone — 0 divergences.
- Lattice: 7 shapes, 108 transitions, covering 54 step names (the corpus uses 131 — `table.test.ts`
  prints the gap as a table-growth list).

## The property

`src/compiler/options/fast-paths.ts` defines six independently switchable optimized lowerings, each
promising *"Disabling routes through the generic path — result-equivalent."* L5 checks that claim:

> for every traversal `q`: `run(q, fast paths on)` ≡ `run(q, fast paths off)`

The generic path is the declared semantic authority, so a disagreement is a defect on the optimized
side — the property is self-oracling. `differential.test.ts` also runs each switch **in isolation**
(seed `42 + i`, so the six sample different traversal sets), which attributes a divergence to one path
and catches pairs whose errors cancel when both are off.

### What "equivalent" means

A **bulk-weighted multiset**: `hex(GraphBinary value) → Σ bulk`. This is the only comparison that
survives `movementCollapse`, which emits one row carrying `SUM(bulk)` where the generic form emits
`bulk` separate rows — the same traverser multiset in two representations. It is also just what a
traverser multiset *is* (CLAUDE.md: "Traversers are multisets"). Expanding bulk into literal copies
would be equivalent but is not an option: collapse exists because the walk count it folds can be
exponential.

| Kind | Gates | Meaning |
|---|:--:|---|
| `support` | ✅ | One side ran, the other threw. A fast path must never change *whether* a traversal is supported. |
| `multiset` | ✅ | Both ran, different traverser multisets — a fast path answering a different question. |
| `order` | ❌ | Same multiset, different emission order. **Telemetry only** (8 in the corpus today). |

`order` does not gate because `order().by(key)` establishes only a *partial* order: tied traversers
have unspecified relative order, so a diff there is within spec. Telling a tie reordering from a real
mis-ordering needs the projected sort keys, which this oracle does not have — it compares encoded
values.

## Inputs

**Corpus** (`../L1-corpus/corpus.txt`) — the 2,298 canonical TinkerPop traversals. Real Gremlin,
deterministic, no generator risk; fixed, so it only reaches compositions somebody already wrote.

**Generated** (`shape.ts` + `generate.ts`) — fast-check walking a shape lattice. State = stream shape,
transition = step, so the next step is drawn only from the current shape's legal set and
`count().out()` is unreachable by construction. Seven shapes (`vertex`, `edge`, `scalar`, `list`,
`record`, `group`, `path`); child bodies recurse through the same walk from the body's own input shape,
so nesting depth is a parameter rather than a list of hand-written cases. fast-check (not a hand-rolled
loop) for **shrinking**: a divergence found at depth 4 inside two nested branches is unusable until
minimised.

The lattice is an independent statement of Gremlin's typing, not a reflection of the compiler's
dispatch maps (rationale in the design doc). `table.test.ts` guards it behaviourally: every generated
traversal must parse and chain, every transition must actually get drawn, and the corpus-vocabulary gap
is reported.

## The ratchet

`known.ts` holds diagnosed divergences — **one entry per root cause, not per traversal**, each stating
the defect and its fix. An entry is always a bug we have not fixed, never an acceptable divergence.
A `family` matcher (keyed on the divergence *message* where possible) covers the variants a generator
keeps rediscovering. A stale-entry test fails if an entry stops reproducing, so a fix cannot leave dead
weight behind.

The gate is a constant zero unexplained divergences — the list only ever shrinks. It is empty today.

## Files

| File | |
|---|---|
| `oracle.ts` | the differential: run under two configs, compare bulk-weighted multisets |
| `shape.ts` | the shape lattice — shapes, transitions, graph vocabulary |
| `generate.ts` | the fast-check arbitrary that walks the lattice |
| `known.ts` | the ratchet (currently empty) |
| `differential.test.ts` | the properties, over corpus + generated, all-off and one-at-a-time |
| `table.test.ts` | the lattice's own guards (parse/chain, transition coverage, corpus gap) |
