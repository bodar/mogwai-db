# `repeat()` — the two-regime plan

**Status: APPROVED 2026-08-09.** This supersedes the RelIR build plan's Phase 3 step 4
(`docs/2026-08-01-relir-build-plan.md`), whose §4.3 Rel-level `unroll` is WITHDRAWN. Read this doc
first for anything `repeat()`-shaped; read the build plan for everything else.

**This doc is the index for the work.** Findings go HERE, not into `docs/outstanding-work.md`.

---

## 1. THE DECISION — a total function, not a preference

`repeat()` has TWO lowerings, and which one applies is decided from the traversal, never guessed:

| | body has **no** per-iteration barrier | body **has** a per-iteration barrier |
|---|---|---|
| **bounded** — a compile-time `times(n)` | **`Recursive`** + a depth predicate | **UNROLL** (IR level) |
| **unbounded** — `until()` / bare `emit()` | **`Recursive`** | **refuse, clearly** — the wall |

**Neither regime alone is sufficient, and neither insufficiency shrinks with effort.**

- **Unroll cannot express an unbounded walk.** No finite n exists for `until(pred)` or a bare
  `emit()`. That removes reachability, transitive closure and shortest path — the things a graph
  database is for.
- **`Recursive` cannot express a per-iteration barrier.** SQLite's recursive term is a restricted
  sub-language: no aggregate, no window, and `DISTINCT`/`LIMIT`/`ORDER BY` are ACCEPTED while meaning
  something else (P3). SQLite decides this; no amount of lowering work moves it.

The two failure sets are otherwise disjoint, so the union covers the language minus the bottom-right
cell — which is genuinely inexpressible in single-pass SQL and is the honest wall.

### Why each cell is what it is

- **bounded + no barrier → `Recursive`.** Both regimes are legal here; `Recursive` is preferred
  because its statement text is O(1) in depth rather than O(n), and because `times($x)` stays a BIND
  against the depth column instead of being reduced to a compile-time constant (the root
  `CLAUDE.md` parameter rule). **This cell is the DIFFERENTIAL population — see §4.**
- **bounded + barrier → unroll.** The only regime that can express it. Phase k's relation IS the
  frontier at iteration k, which is what makes a phase-local barrier equal a per-iteration one.
- **unbounded + no barrier → `Recursive`.** The only regime that can express it.
- **unbounded + barrier → refuse.** State the wall in the message; do not approximate.

### Why unroll lives at the IR level and not in RelIR

`unrollFixedRepeat` (`src/compiler/ir/strategies.ts`) splices the body into the FLAT step chain, so
every later pass and the whole lowering see ordinary chain steps. That gives combinatorial
completeness **by construction**: every step that works anywhere works inside a repeat body, at any
depth, with no per-step work. A Rel-level replicator would be a second place that has to reproduce
the body's lowering, and would only ever cover what it had been taught.

Corollary that makes the split compound in the right direction: **the recursive regime's obligation
SHRINKS over time.** Every future step family is inherited free by the unrolled route, so
`Recursive` only ever has to grow for the movement/filter vocabulary a walk actually needs.

---

## 2. ✅ What has LANDED (trunk, 2026-08-09)

Ordered as committed. All green on `mise run ci` + pushed.

1. **`3fc0443` — P1 legality is a structural analysis.** `src/rel/block.ts` states the emitter's
   fusion rules ONCE (`Slots`, `NEEDS_SUBQUERY` total over `RelKind`, `spliceable`) plus
   `shapeOf`/`fromTree`. `emit.ts`'s `Block` IS a `Slots` and its arms read the shared table, so the
   checker cannot admit a plan the emitter then wraps. **A join TREE is top level**, so
   `project(join(self, edges))` — the canonical one-hop body — is admitted where it used to say "run
   flatten first". Two defects fell out: a `Materialize` over the walk reference is refused by name,
   and `name` may no longer hoist ANY subtree holding a `SelfRef` (`freeRelIds` does not forbid it —
   a `SelfRef` names its walk positionally, so such a subtree looked bindable).
2. **`b6dfe13` — the barrier laws follow the SELECT, not the node children.** `fusedInto` (same
   walk, one more field on the shape). Measured on bun:sqlite 3.53.0: an aggregate, a window
   function, a `DISTINCT` and an `ORDER BY … LIMIT` are each LEGAL inside a derived table joined into
   a recursive term, while the same two fused into the term are `recursive aggregate queries not
   supported` / `cannot use window functions in recursive queries`. A node-children walk refused all
   four — i.e. any repeat body joining against a deduped, ranked or capped relation.
3. **`84b281c` — the anti-drift gate.** 22 shapes; `fromTree`'s answer must equal the aliases the
   emitted SQL actually puts in its top-level FROM. Verified to bite (dropping `mayFuse` from
   `sideShape` fails it) — and it took a LEFT/INNER pair over a filtered right side to make the rule
   observable at all.
4. **`6e0668a` — the Rel-level `unroll` withdrawn.** Restore point for the deleted code: **`9e0e307`**
   (`src/rel/passes/unroll.ts` + `refresh` + the `RelOverride` identity widening + `selfRef`).
   `minter` stays in `src/rel/mint.ts` — `seek` uses it.
5. **`2b4fd3c` — `freeRelIds` visits each node once.** `g.V().both()×20.count()` compiled in
   2 660 ms and `×24` in 50 s, while the emitted SQL stayed LINEAR (~310 bytes per hop). `both()` is a
   `Union` of two arms reading the SAME input, so a k-hop chain is a DAG with 2^k paths and the walk
   had no visited-guard; `name` calls it once per candidate node. After: k=20 7 ms, k=80 36 ms.
   Guarded in `test/performance.test.ts` — the one wall-clock assertion in a file that otherwise
   pins plan SHAPES, because the defect was time and nothing else.
6. **`91beb5d` — the IR unroll widened.** Body NORMALIZED before splicing (`childSteps`, injected),
   which retires the pass-order coupling that excluded every modulator host. `UNROLLABLE_BARRIERS`
   gains the slice family (`limit`, `range`) and `order`, each with its own argument and its own
   identity pin in `test/compiler/repeat-unroll-boundary.exec.test.ts`. `MAX_UNROLLED_STEPS = 100`,
   from the TEXT measurement (~1 KB/step worst case, ~300 b/step typical, 100 KB DO cap).
   **L3 1763 → 1775 (RelIR) and 1681 → 1692 (legacy)** — this pass is above the routing switch, so
   both floors move; neither shed a name. Census re-recorded, +6 (1063 → 1069).

---

## 3. 🚧 WHAT IS LEFT — in order

### 3.1 The `Recursive` regime — routing `repeat()`'s body through RelIR lowering

**This is the gate.** `repeat` is 40 of the 485 corpus traversals the route ANSWERS but RelIR
declines, and it is the only family whose absence disqualifies the server.

Shape of the work — a NEW module in `src/compiler/rel/` plus a minimal dispatch hook, agreed with the
other lane (see §5):

- A `repeat` arm in `elementTail` (`src/compiler/rel/lower.ts`), beside the existing `union`/`choose`
  arms. The body-lowering primitive already exists: `continueAs(input, framing, body, 0, …)` lowers a
  chain against a given input relation — for a walk, that input is the `SelfRef`.
- An element relation's row shape is `elementCols(channels)` = `id` + carried channel columns, and a
  `Recursive`'s seed and step types must be IDENTICAL, so the walk's header is that shape plus
  whatever the depth predicate needs.
- **`until()`/`emit()` predicates MUST route through `childPredicate`** (lower.ts, the other lane's
  new single predicate answer — filter-only conjunction / correlated EXISTS / value-compare,
  negation included). Do not grow a copy.
- **Negation must be NULL-safe**: `notProduced(pred)` (`build.ts`), never `{unary:'not'}`. `NOT NULL`
  is NULL, and TinkerPop KEEPS a traverser whose body produced nothing.
- **Productivity is its own conjunct**: a value-compare body needs `ChildValue.present` ANDed in.

Open sub-question to settle when starting: **how the depth bound is carried.** A plain extra column
in the walk header is the cheap answer; a `loops` CHANNEL ROLE is the substrate answer and would make
`loops()`, `until(loops().is(n))` and `times($x)`-as-a-bind all fall out of one mechanism. The channel
route touches `src/channels.ts` + `obligations.ts` (cross-cutting), so agree it with the other lane
before starting.

### 3.2 The differential over the overlap cell

**Required by the approval, not optional.** Bounded + barrier-free bodies are legal BOTH ways, so
nothing but a test stops the two regimes disagreeing. Same traversal, both regimes, same rows.

The natural home is L4 (`.feature`) plus a forced-regime switch, in the shape of the existing
fast-path differential: one side declares the semantic authority. Population: every
`repeat(<movement/filter body>).times(n)` in the L1 corpus.

### 3.3 Widen the unrolled body set further

The trigger gate is right (`unroll only when it BUYS something` — a barrier-free body stays on the
recursive path, so legacy churn stays zero). What is left is the ADMITTED set, one name at a time
with its own argument and its own identity pin:

- **`groupCount`/`group`/`aggregate`** — the 29-scenario cluster
  (`repeat(__.out().group('a').by('name').by(__.count())).times(2).cap('a')`). Side-effect labelled
  forms need an argument about accumulation ACROSS phases, which is not the stateless argument the
  landed names use.
- **`tail`, `sample`, `skip`** — each still refused; `sample` has no stable position, `tail` reads the
  order backwards. Both are expressible once unrolled; neither has been argued.
- **The non-barrier half of the allow-list** (`values`, `where`, `select`, `local`, …). Today a body
  containing one declines even though the spliced chain would compile. The allow-list is the
  accidental model — the transformation's validity is a property of `repeat`, not of the body's step
  names — so the end state is a DENY-list of exactly `loops()` (recursively), a named
  `repeat('a', …)`, `emit()` and `until()`. Moving to it needs the differential in §3.2 first.

### 3.4 Refusals that must stay refusals

`loops()` anywhere inside the body (recursively, including nested bodies), a named
`repeat('a', …)`, `emit()`, `until()` — the unrolled chain has no loop identity to attach them to.
Approximating any of them is the failure mode `RepeatUnrollStrategy`'s own comment warns about.

### 3.5 The `times($x)` parameter exception

Unrolling forces a parameter to a compile-time value — the ONE early-reduction exception the root
`CLAUDE.md` names. It is now reachable by more traversals. Two consequences to handle when §3.1
lands: a parameterised `times` should PREFER the `Recursive` regime (where it stays a bind), and the
unroll should only claim it when no other regime can.

---

## 4. The instruments this work answers to

- `mise run ci` — contains L1–L5, the census and every static gate. Do not re-run its parts beside it.
- **`mise run test:legacy-spine` EVERY time this pass changes.** `unrollFixedRepeat` runs ABOVE the
  routing switch, so it moves legacy's answers too — `ci` does not contain that differential.
- `mise run census-record` when coverage moves, with the reason in the commit message.
- `mise run L3:rel-only` — the cut measurement. Read it per increment, not as a proxy.

---

## 5. Lane split (concurrent session, agreed)

- **This lane:** `src/rel/**`, plus Phase 3 step 3 in `src/compiler/rel/` — a NEW walk module and a
  minimal dispatch hook. Rebase before every push.
- **Other lane:** `src/compiler/rel/**` — currently the Phase 2 filter family, next `local`/`map`/
  `flatMap` (the per-parent child host). **We meet at `local(...)` inside a `repeat()` body** — shout
  before going near it.
- Their landed helpers to reuse rather than copy: `childPredicate`, `notProduced`,
  `ChildValue.present`, `child.rows(...)` (the `origin` channel), `groupReduced` as the worked
  per-parent aggregation example.

---

## 6. Facts that cost a measurement — do not re-derive

- **A join tree is top level.** `FROM w INNER JOIN edges e`, the same with sides swapped, EITHER side
  of a `LEFT JOIN`, a cross join, nested joins, and a `w`-correlated `EXISTS` all return `1,2,3,4`
  over a 3-edge chain. `circular reference: w` for exactly two shapes: the walk behind a derived
  table, and the walk referenced ONLY from a correlated scalar.
- **A barrier inside a joined DERIVED TABLE is legal in a recursive term.** Aggregate, window,
  `DISTINCT` and `ORDER BY … LIMIT` all measured legal; the same aggregate/window FUSED into the term
  are refused by name.
- **SQL text per spliced step:** ~300 bytes for a movement or `dedup` body, ~1 KB for an
  `order().by(k)` body. DO caps a statement at 100 KB.
- **Compile cost is LINEAR in chain length** — since `2b4fd3c`. It was not; if it looks superlinear
  again, look for an un-memoised DAG walk before anything else.
- **`unrollFixedRepeat` is TinkerPop's `RepeatUnrollStrategy`, widened deliberately.** Upstream's
  `ALLOWED_STEP_CLASSES` admits movement + `has()` and NO barrier, because its concern is laziness
  under arbitrary providers. Ours is set-at-a-time by construction, so "the whole frontier at
  iteration k" is what phase k's relation IS — the very property `RepeatStep.standardAlgorithm` has
  to special-case to get. That is the licence, and it is per-barrier.
