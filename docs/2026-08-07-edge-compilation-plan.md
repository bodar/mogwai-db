# Compiling at the edge — ship plans, not queries

> **STATUS: PLAN. Nothing below has landed, and the first phase cannot start yet (§7).**
> Written 2026-08-07 against trunk at `6fa84f3`. Every number in §2 is a measurement; the method is
> at the bottom (§9). Extracted from `docs/2026-08-07-graphql-front-end-plan.md`, where it was a
> placement question for one front end before it turned out to be about the whole request path.

**The thesis in one line.** A Durable Object is a *serial* resource — one request queue per object —
and a Worker is an *elastic* one. Compilation reads nothing from the store, so it does not need to
be where the store is. Everything that can leave the DO's serial budget should.

---

## 1. Why this is a question at all

A DO serializes requests per object. Every millisecond a DO spends not touching its own storage is a
millisecond no other request to that graph can run, and duration is billed while the request is open.

Today the DO does all of it: parse the Gremlin string, run the IR passes, lower, render SQL, execute,
frame, and — for a federated `call()` — hold the request open while it waits on sibling objects.

Only one of those needs the store.

---

## 2. What was measured

### 2·1 The enabling fact: compile touches nothing

`compilePlan` was run for eight query shapes with `store.query` wrapped in a counter.

```
count 0 · lookup+1hop 0 · filter+order+limit 0 · valueMap page 0
repeat x2 0 · group 0 · project 2-field 0 · long chain 0
```

**Zero, every shape.** `compile()` is a pure function of the query text and its parameters. It is not
"mostly pure" or "pure for reads" — it does not read the graph at all. That is what makes everything
below possible, and it was worth checking rather than assuming: label interning was the plausible
place for a compile-time lookup to hide, and it does not (labels resolve through a join on
`labels.name`, not through a compile-time id).

### 2·2 Compile is fixed cost; execution scales

Same six queries, `ANALYZE`d graphs, warm, ms/op totals:

| graph | parse | compile | total | exec+frame | compile% |
|---|---|---|---|---|---|
| modern, 6 v | 0.142 | 3.513 | 5.308 | 1.795 | **66.2%** |
| 200 v / 500 e | 0.379 | 4.000 | 5.163 | 1.163 | **77.5%** |
| 1 000 v / 2 500 e | 0.294 | 4.219 | 9.645 | 5.426 | **43.7%** |
| 4 000 v / 10 000 e | 0.312 | 4.436 | 22.719 | 18.283 | **19.5%** |

Compile sits at **~4 ms regardless of graph size** — it must, given §2·1 — against execution that
scales with data. So the ratio is a curve: near-total at small scale, asymptotically zero at large.
Crossover ≈ **1 000 vertices**.

One DO per graph is the model this project targets, and the agent-memory workload
(`docs/2026-07-17-agent-memory-vision.md`) is many small graphs. That sits **left** of the crossover.

### 2·3 It is the compiler, not the parser

Parse is **0.142 ms of 5.308 ms — 2.7%**.

This kills the obvious version of the idea. Moving *parsing* to the edge and shipping `Step[]` across
the wire moves under 3% of the work and buys a bespoke traversal serialization — which is
re-inventing the bytecode TinkerPop 4 deliberately deleted (locked decision #1), with a version-skew
contract to maintain and `wrangler tail` going dark. Moving *compilation* and shipping the plan moves
20–78% and ships a payload that is already serializable, already debuggable, and already versionless.

### 2·4 Cold start amortizes across tenants, not within one

First `parseGremlin` in a fresh process: **45.2 ms**. Warm: **0.107 ms**. **422×.**

(That conflates ANTLR's prediction-DFA warm-up with JIT; a fresh isolate pays both regardless.) In a
DO the isolate is per graph, so N graphs pay it N times. In a Worker one warm isolate serves every
tenant that lands on it. For many-small-graphs this is a larger effect than the per-request ratio.

---

## 3. What can cross the seam

Decided entirely by whether `Executable` is data.

| variant | shape | crosses? |
|---|---|---|
| `Compiled` | `{kind:'read', sql, binds, shape, spine}` | **yes** |
| `Program` | `{kind:'program', program: RelPlan, tail?: {sql, binds}, shape, spine}` | **yes** |
| `WritePlan` | `{kind:'write', run: (store) => WriteResult[]}` | **no — a closure** |

`Program` is RelIR's several-statement form and is explicitly *data the algebra produced rather than
a machine that walks the store* (`src/sql/kernel/render.ts`), carrying a `RowsBind` marker the
executor fills from rows it retained. So a multi-statement write ships exactly as a read does.

`WritePlan` is the legacy write closure, and it is already on the deletion list `Program` exists to
replace. **This is the whole dependency** — see §7.

`shape` travels with both, so the DO can frame, or return rows and let the edge frame. Either works;
framing where the rows are is fewer bytes.

---

## 4. The design

### 4·1 Compile at the edge, always; branch on what comes out

The edge holds the plan before anything executes, so it needs no heuristic:

- `Compiled` / `Program` → send `{plan}` over RPC; the DO runs it and returns rows or framed buffers.
- anything else → send `{gremlin, params, paramTypes}` exactly as today.

No flag day, no second correctness surface. The fallback path is the current path, and it stays until
§7 removes the only reason to take it.

### 4·2 The statement cache is preserved, and we should not build a second one

Shipping `{sql, binds}` keeps SQLite's own prepared-statement cache working exactly as it does today:
same statement text, varying binds, statement reuse in the DO. That is the payoff the
parameters-are-the-only-binds rule is *for*, and this design costs nothing to keep it.

**A plan cache at the edge is a different thing, and it is deliberately not in this plan.** It would
save ~4 ms of *Worker* CPU per request — the elastic, horizontally-scaled side that §1 exists to move
work ONTO. Optimizing it is optimizing the resource we just declared abundant. It does not help cold
start either: a fresh isolate pays §2·4's warm-up before it serves anything, cached or not.

The cost is not the code (an in-isolate LRU keyed on the query text; compile is pure, so there is no
invalidation problem). The cost is the invariant. `unrollFixedRepeat` consumes a parameter
**structurally**, so a plan compiled at `times(3)` is invalid at `times(5)` — and reusing it does not
throw, it returns a confident wrong answer. Doing it safely means `compilePlan` must report which
parameters it consumed at compile time, which is a new obligation on the compiler's contract and a
new thing that can drift silently as more steps learn to read parameters early.

A silent-wrong-answer failure mode added to the compiler's public surface, to save milliseconds of
cheap CPU, against no measurement saying that CPU costs anything. If Worker CPU billing ever measures
material (§8), the cache is purely additive — it sits above `compilePlan` and is invisible to the
RPC, the DO and the fallback arm — so nothing here needs to accommodate it in advance.

### 4·3 Federation: the Worker drives the segment loop

Today `Executor.drive` is:

```ts
while (p.kind === 'segment') {
  const rows = p.head ? this.readSegmentHead(p.head) : [];   // local SQL, sync, fully drained
  const foreign = await p.apply(rows);                        // DO → sibling DO
  p = p.resume(foreign, rows);
}
```

The top DO holds one request open across every hop. Its own SQL is brief — `readSegmentHead` is
synchronous and fully drained, deliberately, so no cursor crosses an await — and the rest of that
window is a DO sitting on an open request waiting for someone else's storage. That is the worst
available use of the one resource a DO makes scarce, and it is exactly what a Worker is for.

Once the edge compiles, the edge already **has the segmentation**: `compilePlan` returns
`{kind:'segment'}` before anything runs. So the loop can run Worker-side:

- ask the top DO for the segment head rows → **its request closes**;
- fan out to siblings with `Promise.all` over stubs — parallel *by construction*, rather than by
  whether a given service's `apply()` happened to be written that way;
- hand the foreign rows back for the next segment → another short DO request.

The transfer format already suits it. `ForeignRow[]` is detached element references as decoded rows,
framed to GraphBinary only at the client edge — designed never to encode→decode→re-encode across a
hop.

It also removes an asymmetry. Today a federated `call()` makes one DO an orchestrator over its peers.
Worker-driven, every DO is a leaf that answers "run this plan" — the same shape §4·1 arrives at from
the read side.

**The honest cost:**

| | round trips | DO occupied during sibling wait |
|---|---|---|
| today | 1 Worker→DO, N DO→DO | **yes, the whole time** |
| Worker-driven | N+1 Worker↔DO, N parallel Worker→DO | no |

Intermediate rows cross **twice** (sibling→Worker→topDO) where they crossed once. That is the real
price and it is shape-dependent: a reducing fan-out (counts, narrow projections) is cheap, one
shipping large row sets between barriers is worse. Sibling latency dominating is the case federation
exists for, so this should usually win — and "usually" is measurable before it is built (§8).

### 4·4 Which services can leave, and which cannot

`call()` is not only federation. The split wants naming before the loop moves, or it gets decided by
accident:

- a barrier that needs the **local store** must stay DO-side;
- a barrier that needs an **external resource** — `io()`'s R2 binding — can run either side, and R2
  bindings are if anything more natural in a Worker.

`io()` on a graph's own data still needs the store for one half of the operation, so it is a split
barrier rather than a movable one. Naming that distinction is part of Phase 3, not a detail of it.

### 4·5 The enabling refactor

`drive()` is a private method closing over `this.store` and `this.app`. It becomes a free function
over an interface — read-head / apply / resume, with store access injected — so the same loop runs
in-process on Bun (where there is no boundary and none of this matters) and Worker-side on
Cloudflare, unchanged.

Worth doing while `call()` is mid-migration onto the `rel` arm rather than retrofitting afterwards:
the segment loop's ownership is already in play.

---

## 5. What this is not

- **Not a rewrite of the compiler.** Nothing about lowering changes. The change is *where* the
  function is called and *what* crosses the RPC.
- **Not Bun-affecting.** In-process there is no boundary; the injected-store version of §4·5 runs the
  identical loop. Any design that only makes sense on Cloudflare is wrong — one router, two runtimes.
- **Not a security boundary change in intent, but it is one in fact.** The DO grows an
  "execute this plan" RPC method. Same trust domain today; it is a real widening the moment anything
  else can reach that binding, and the phase that adds it should say so out loud.

---

## 6. Priority — this is the third lever, not the first

| lever | magnitude |
|---|---|
| query-plan stability (`docs/2026-08-07-query-plan-stability.md`) | ~9 800 ms → ~19 ms on a 20 k-vertex graph |
| edge-side compile (this doc) | ~4 ms fixed, 20–78% of a small-graph request |
| ANTLR cold start (this doc, §2·4) | ~45 ms, once per isolate |

A 9.8-second traversal is not slow, it exceeds the request budget and fails. Tuning 4 ms while that
is outstanding would be measuring the wrong thing — which is how this document came to exist, since
the plan-stability finding surfaced while benchmarking for §2.

---

## 7. The dependency, and it is checkable

**`WritePlan` must reach 0 in `scripts/deletion-ratchet.tsv`.** It is at **15**, filed under
Phase 2.6 — *"a write is `Plan.bindings`, not a private `run(store)`"* — alongside
`runWriteChainFull` (3) and `materializeElementDrivers` (4). `mise run deletion` gates the floor, so
this dependency is a CI-checkable number rather than a judgement call.

Until it is 0, `Executable` includes a closure and §4·1's fallback arm is load-bearing. After it is 0,
`Executable` narrows to `Compiled | Program`, both data, and there is no traversal whose plan cannot
cross the seam.

**That work is in flight** (the RelIR write path, `docs/2026-08-01-write-path-plan.md` +
`docs/2026-08-01-relir-build-plan.md` §8). Nothing here should be built ahead of it, and nothing here
asks it to change course — the phases below simply start after.

### Phases

**Phase 0 — the refactor that is safe today.** Lift `drive()` out of `Executor` into a free function
over an injected store interface (§4·5). Pure refactor, no behaviour change, testable in-process, and
it stops the segment loop's ownership from setting further while `call()` migrates.

**Phase 1 — the plan RPC (reads).** A DO method that takes a `Compiled` and returns rows or framed
buffers. Edge compiles, branches on `plan.kind` (§4·1), falls back otherwise. Measurable end to end
against the §2·2 numbers.

**Phase 2 — writes and the segment loop.** Gated on §7. `Program` over the same RPC; the Worker
drives federation (§4·3); the service split gets named (§4·4).

Three phases, and no caching phase — see §4·2 for why that is a decision rather than an omission.

---

## 8. Open numbers

- **Worker→DO vs DO→DO hop latency**, and whether §4·3's extra round trips are dominated by the
  parallelism they buy. Shape-dependent; measure with a reducing fan-out and a wide one.
- **Plan payload size** for a large `Program` versus the Gremlin string it replaces. A string is
  tiny; a plan is not. There is presumably a crossover where shipping the query wins, and nobody
  knows where it is.
- **Whether Worker CPU time is a cost worth attacking at all.** ~4 ms of compile per request is
  billable; nobody has looked at what that adds up to. This is the only number that would reopen the
  plan-cache decision in §4·2, and it should be a bill, not an intuition.
- **Whether the DO's isolate cold start dominates** the 45 ms in §2·4 rather than ANTLR, which would
  change how much §2·4 is actually worth.

---

## 9. Method

Timings from throwaway benchmark scripts, not committed. Synthetic graph: N `person` vertices
(`name`, `age`), N `software` vertices (`name`, `lang`), 4 `knows` + 1 `created` edge per person,
bulk-loaded via `loadBulk` into `new GraphStore(new BunSqlite(':memory:'))`. Queries run through
`test/support/executor.ts`; each warmed, then timed over 20–200 iterations depending on cost.
`parseGremlin`, `compilePlan` and `framed` were timed separately, so exec+frame is the residual
(`total − compile`) rather than an independent measurement. Every graph was `ANALYZE`d — see
`docs/2026-08-07-query-plan-stability.md` for why that qualifier is load-bearing and what an
unanalyzed run wrongly shows.

The store-touch gate (§2·1) wraps `store.query` with a counter and calls `compilePlan` alone,
outside any executor.

All numbers are `bun:sqlite` 3.53.0 in one process. **Nothing here has been reproduced on workerd**,
and the two facts this document most depends on — Worker↔DO round-trip cost, and DO isolate
cold-start — cannot be observed anywhere else.
