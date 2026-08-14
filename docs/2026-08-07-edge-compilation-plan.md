# Compiling at the edge — ship plans, not queries

**A PLAN. §7's gate is now MET** — `WritePlan` is deleted (2026-08-15); `Executable` is `Compiled | Program`,
both data. Phases 0/1 are unblocked and Phase 2 no longer waits on a write closure.

**This is not a performance optimization.** It is a consequence of the one hard constraint the
platform imposes; the numbers below are evidence the consequence is worth acting on, not the reason
for it.

---

## 1. The constraint: a Durable Object is single-threaded

One object, one request queue. No concurrency *within* a DO exists to be had — not by tuning, a
faster runtime, or more resources. Whatever it is doing, it is doing instead of everything else that
graph was asked to do.

So the unit is not latency, it is **occupancy**: what fraction of a DO's open-request time is spent
touching its own storage — the only thing it is uniquely able to do. Parsing, lowering, and *waiting
on another object* are all occupancy; the wait is the worst kind, because the DO is idle and
unavailable at once.

Today one DO does all of it: parse the Gremlin string, run the IR passes, lower, render SQL, execute,
frame, and — for a federated `call()` — hold its request open across every hop while siblings work.
**Exactly one of those needs the store.** Everything else is a serial resource doing, for one caller,
work a horizontally-scaled one could have done in parallel while every other caller for that graph
waits.

A Worker is elastic and stateless; a DO is a queue with a database attached. **Work belongs on the
elastic side unless it needs the database.**

---

## 2. Evidence that it is worth acting on

### 2·1 The enabling fact: compile touches nothing

`compilePlan` run for eight query shapes with `store.query` wrapped in a counter: **zero store
touches, every shape** (count, lookup+1hop, filter+order+limit, valueMap page, repeat×2, group,
project 2-field, long chain). `compile()` is a pure function of the query text and its parameters —
it does not read the graph at all, not "mostly" and not "for reads only". That is what makes
everything below possible. **Worth checking, not assuming:** label interning was the plausible place
for a compile-time lookup to hide, and it is not there — labels resolve through a join on
`labels.name`, not a compile-time id.

### 2·2 How much of a DO's occupancy is not storage

Same six queries, `ANALYZE`d graphs, warm, ms/op totals. Last column = the share of a DO's occupied
time that is NOT the thing only a DO can do:

| graph | parse | compile | total | exec+frame | compile% |
|---|---|---|---|---|---|
| modern, 6 v | 0.142 | 3.513 | 5.308 | 1.795 | **66.2%** |
| 200 v / 500 e | 0.379 | 4.000 | 5.163 | 1.163 | **77.5%** |
| 1 000 v / 2 500 e | 0.294 | 4.219 | 9.645 | 5.426 | **43.7%** |
| 4 000 v / 10 000 e | 0.312 | 4.436 | 22.719 | 18.283 | **19.5%** |

Compile is **constant regardless of graph size** (it must be, per §2·1) against execution that scales
with data. So on a small graph a DO spends **two thirds of its serial budget on work that did not
need to be there**; the share only falls as the graph grows.

One DO per graph is the target model, and the agent-memory workload
(`docs/2026-07-17-agent-memory-vision.md`) is many small graphs — the end of the curve where almost
none of a DO's occupancy is storage. The absolute ms are small; the **fraction** is what caps how
many callers a graph can serve.

### 2·3 It is the compiler, not the parser

Parse is **0.142 ms of 5.308 ms — 2.7%**. This kills the obvious version of the idea. Moving
*parsing* to the edge and shipping `Step[]` moves under 3% of the work and buys a bespoke traversal
serialization — **re-inventing the bytecode TinkerPop 4 deliberately deleted** (locked decision #1),
with a version-skew contract to maintain and `wrangler tail` going dark. Moving *compilation* and
shipping the plan moves 20–78% in a payload already serializable, debuggable, and versionless.

### 2·4 Cold start amortizes across tenants, not within one

First `parseGremlin` in a fresh process **45.2 ms**, warm **0.107 ms** — **422×** (conflates ANTLR's
prediction-DFA warm-up with JIT; a fresh isolate pays both). A DO's isolate is per graph, so N graphs
pay it N times; one warm Worker isolate serves every tenant that lands on it. For many-small-graphs
this is a larger effect than the per-request ratio.

---

## 3. What can cross the seam

Decided entirely by whether `Executable` is data.

`Executable` is now `Compiled | Program` — **both data** (the `WritePlan` closure is deleted, §7).

| variant | shape | crosses? |
|---|---|---|
| `Compiled` | `{kind:'read', sql, binds, shape, spine}` | **yes** |
| `Program` | `{kind:'program', program: RelPlan, tail?: {sql, binds}, shape, spine}` | **yes** |

`Program` is RelIR's several-statement form — **data the algebra produced, not a machine that walks
the store** (`src/sql/kernel/render.ts`), carrying a `RowsBind` marker the executor fills from
retained rows. A multi-statement write ships exactly as a read does. There is no longer a closure
variant to fail the seam: the legacy `WritePlan` that §7 gated on is gone.

`shape` travels with both, so the DO can frame or return rows for the edge to frame; framing where
the rows are is fewer bytes.

---

## 4. The design

### 4·1 Compile at the edge, always; branch on what comes out

The edge holds the plan before anything executes, so it needs no heuristic:

- `Compiled` / `Program` → send `{plan}` over RPC; the DO runs it, returns rows or framed buffers.
- anything else → send `{gremlin, params, paramTypes}` exactly as today.

**No flag day, no second correctness surface.** The fallback path is the current path, and stays
until §7 removes the only reason to take it.

### 4·2 Federation: the Worker drives the segment loop

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
window is a DO on an open request waiting for someone else's storage: the worst available use of the
one resource a DO makes scarce.

Once the edge compiles it already **has the segmentation** (`compilePlan` returns `{kind:'segment'}`
before anything runs), so the loop runs Worker-side:

- ask the top DO for the segment head rows → **its request closes**;
- fan out to siblings with `Promise.all` over stubs — **parallel by construction**, not by whether a
  service's `apply()` happened to be written that way;
- hand the foreign rows back for the next segment → another short DO request.

`ForeignRow[]` already suits it: detached element references as decoded rows, framed to GraphBinary
only at the client edge — **designed never to encode→decode→re-encode across a hop.**

It also removes an asymmetry: today a federated `call()` makes one DO an orchestrator over its peers;
Worker-driven, every DO is a leaf answering "run this plan" — the same shape §4·1 reaches from the
read side.

**The honest cost:**

| | round trips | DO occupied during sibling wait |
|---|---|---|
| today | 1 Worker→DO, N DO→DO | **yes, the whole time** |
| Worker-driven | N+1 Worker↔DO, N parallel Worker→DO | no |

Intermediate rows cross **twice** (sibling→Worker→topDO) where they crossed once. That is the real
price and it is shape-dependent: a reducing fan-out (counts, narrow projections) is cheap; one
shipping large row sets between barriers is worse. Sibling latency dominating is the case federation
exists for, so this should usually win — and "usually" is measurable before it is built (§8).

### 4·3 Which services can leave, and which cannot

`call()` is not only federation. Name the split before the loop moves, or it gets decided by
accident:

- a barrier needing the **local store** stays DO-side;
- a barrier needing an **external resource** — `io()`'s R2 binding — can run either side, and R2
  bindings are if anything more natural in a Worker.

`io()` on a graph's own data still needs the store for one half of the operation, so it is a **split**
barrier, not a movable one. Naming that distinction is part of Phase 3, not a detail of it.

**An iterative, store-bound barrier is DO-RESIDENT, and this is the constraint Phase 2 must not
regress.** The graph-algorithms plan (`docs/2026-07-24-graph-algorithms-plan.md`) lands OLAP
(pageRank/wcc/…) as a `barrier` whose body is a **host-driven convergence loop** — 20–50 bulk SQL
statements, each O(E) over *this graph's own edges*, stopping on a dynamic `MAX(ABS(Δ)) < tolerance`.
Every iteration needs the local store, and the loop is not expressible as a static `Program`. The
Worker drives the segment BOUNDARY (which segment runs where); a barrier whose body is a store-bound
loop must run that loop inside ONE DO call, **never** as Worker-driven per-iteration RPCs — that would
turn N in-DO statements into N round trips, each crossing the |V|-sized score relation twice (§4·2).
Federation and a future regex barrier (`docs/2026-08-12-regex-as-a-barrier-research.md`, whose JS
predicate touches no store) are the *movable* case; an iterative store-bound barrier is the
DO-resident one, beside `io()`'s split half. So `apply()`'s residence, not just its segmentation, is
part of the §4·3 classification.

### 4·4 The enabling refactor

`drive()` is a private method closing over `this.store` and `this.app`. Make it a free function over
an interface — read-head / apply / resume, with store access injected — so the same loop runs
in-process on Bun (no boundary, none of this matters) and Worker-side on Cloudflare, unchanged. Worth
doing while `call()` is mid-migration onto the `rel` arm, not retrofitting afterwards.

---

## 5. What this is not

- **Not a rewrite of the compiler.** Lowering does not change — only *where* the function is called
  and *what* crosses the RPC.
- **Not Bun-affecting.** In-process there is no boundary; §4·4's injected-store version runs the
  identical loop. **Any design that only makes sense on Cloudflare is wrong — one router, two
  runtimes.**
- **Not a security boundary change in intent, but one in fact.** The DO grows an "execute this plan"
  RPC method. Same trust domain today; a real widening the moment anything else can reach that
  binding, and the phase that adds it should say so out loud.

---

## 6. Priority against the other outstanding work

Not the most urgent thing in the tree, but no longer blocked: the thing that came first — a 1-hop
lookup taking 9.8 s on a 20 000-vertex graph because SQLite had no statistics, a traversal that
exceeded the request budget and failed, **a correctness problem wearing performance clothing** — has
landed (RelIR plan §1 P4). Edge-side compile is now the next throughput lever.

Different KINDS of problem: plan stability is a bug (a specific wrong decision, with a fix and a
number). This is architectural — no single request is broken, and the §1 constraint does not go away
when queries get faster. **Making execution 500× faster makes the compile share of a DO's occupancy
*worse*, not better.** Fix the bug first; let this land when §7 unblocks it.

---

## 7. The dependency — MET (2026-08-15)

**`WritePlan` is deleted.** Writes moved onto the RelIR `Program` arm (`kind:'program'`) — data an
executor runs, not a private `run(store)` closure — and the last thing keeping the closure type alive
(the union member, one framing branch, two shims) is gone. `Executable` is now `Compiled | Program`,
both data, and narrowing the union was itself the proof: `tsc` would error at any surviving write
construction site, and it is green.

Consequence for §4·1: the fallback arm no longer exists to carry a closure. It stays only as the
compile-failure / unsupported-traversal path — a plan that does not exist crosses nothing — not because
any *successful* compile can produce something the seam cannot take. No traversal has a plan that
cannot cross the seam.

The RelIR write path that made this possible landed via `docs/2026-08-01-write-path-plan.md` +
`docs/2026-08-01-relir-build-plan.md` §8. The phases below are unblocked.

### Phases

**Phase 0 — the refactor safe today.** Lift `drive()` out of `Executor` into a free function over an
injected store interface (§4·4). Pure refactor, no behaviour change, testable in-process; stops the
segment loop's ownership from setting further while `call()` migrates.

**Phase 1 — the plan RPC (reads).** A DO method taking a `Compiled`, returning rows or framed
buffers. Edge compiles, branches on `plan.kind` (§4·1), falls back otherwise. Measurable end to end
against the §2·2 numbers.

**Phase 2 — writes and the segment loop.** Gated on §7. `Program` over the same RPC; the Worker
drives federation (§4·2); the service split gets named (§4·3).

---

## 8. Open numbers

Every one is an OCCUPANCY question, measured on workerd. **Latency is not the unit** — halving a
client's wall-clock while leaving the DO occupied has not moved the §1 constraint.

- **What fraction of a DO request's open time is not storage, in production.** §2·2 is a proxy in one
  Bun process; this is the number that says how much occupancy is actually reclaimable, and the only
  one that justifies the whole plan.
- **Whether the top DO's occupancy actually falls under Worker-driven federation (§4·2)** — including
  the cost of re-entering it once per barrier, which is real and pulls the other way. Measure
  occupancy, not round-trip time: the extra hops are irrelevant if the DO is free during them, fatal
  if not.
- **What a large `Program` costs the DO to deserialize.** Shipping a plan moves parsing off the DO
  but puts decoding on it; if decode is a meaningful share of the occupancy it saves, the win is
  smaller than §2·2 suggests — and for a big multi-statement program nobody knows which way it goes.
- **Cold start's share of a DO's FIRST request** (§2·4), and how much of the 45 ms is the isolate vs
  ANTLR. Per-graph rather than per-request, so it matters exactly as much as graphs are numerous and
  short-lived — for agent memory, a lot.

---

## 9. Method

Timings from throwaway benchmark scripts, not committed. Synthetic graph: N `person` (`name`, `age`)
+ N `software` (`name`, `lang`) vertices, 4 `knows` + 1 `created` edge per person, bulk-loaded via
`loadBulk` into `new GraphStore(new BunSqlite(':memory:'))`. Queries run through
`test/support/executor.ts`, each warmed then timed over 20–200 iterations by cost.
`parseGremlin`/`compilePlan`/`framed` timed separately, so exec+frame is the residual
(`total − compile`). Every graph `ANALYZE`d — see RelIR plan §1 P4 for why that qualifier is
load-bearing (an unanalyzed graph gives a superlinear plan). The store-touch gate (§2·1)
wraps `store.query` with a counter and calls `compilePlan` alone, outside any executor.

All numbers `bun:sqlite` 3.53.0 in one process. **Nothing here has been reproduced on workerd**, and
the two facts this document most depends on — Worker↔DO round-trip cost and DO isolate cold-start —
cannot be observed anywhere else.
