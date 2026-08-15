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
| `Compiled` | `{kind:'read', sql, binds, shape}` | **yes** |
| `Program` | `{kind:'program', program: RelPlan, tail?: {sql, binds}, shape}` | **yes** |

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

### 4·3 Residency — where a barrier's `apply` runs, declared not derived

A `rel` contribution is SQL inline in the plan; it has no placement choice — it runs wherever the
plan runs. Only a `barrier` has an `apply` that *could* run elsewhere, so **only the barrier arm
carries a residency**, and it is a plain, explicit, deployment-honest binary:

```ts
residency: 'do' | 'worker'
```

`kind` (`rel`/`barrier`) names the **essence** — what the contribution is to the plan. `residency`
names the **deployment** — where `apply` runs. Two orthogonal fields, each named for what it is; we do
not derive one from a checklist of capabilities (that is just a clumsier declaration) and we do not
overload `kind`. Default and overwhelming case: **`do`**.

**The rule for `worker`: a barrier leaves the DO only to get off a REMOTE WAIT.** §1's worst
occupancy is the DO idle-but-holding while *another object* works. That — and only that — is worth
hoisting: the Worker drives the wait, the DO's request closes, and the graph's other callers are
served meanwhile. A barrier with no remote wait has nothing to free the DO *across*, so it stays `do`
however much CPU it burns — because its working set is already in the DO, and shipping it out to a
Worker to compute and shipping the result back is more transport than the compute saved.

| barrier | needs local store? | remote wait? | residency | why |
|---|---|---|---|---|
| **federate** | no | yes — siblings | **`worker`** | hot, per-request, shared graph; free the DO across the sibling wait |
| regex (future) | no | **no** | `do` | pure CPU; input (candidates) > output (survivors) and already in the DO — moving it ships the *larger* set out to save microseconds of V8 regex |
| OLAP (future) | **yes**, every iteration | no | `do` | host-driven convergence loop, O(E) over this graph's edges per iteration; must be at the store, and can't be a static `Program` |
| `io()` | **yes** | yes — R2 | `do` | see below |

So today exactly **one** thing is `worker`: `federate`. The field is still worth declaring
explicitly — it lets OLAP and regex *state* `do` rather than lean on the drive loop's hardcoded
knowledge, and it is where the next barrier says which it is.

**The fail-closed invariant that keeps explicit honest: a `worker` barrier's `apply` is store-free.**
It is handed no store and closes over no store binding — federate closes over the FederationSource,
not the store; io closes over both, which is exactly why io is `do`. The residency value therefore
cannot contradict the code: a `worker` barrier that reached for the store would be reaching for
something it was never given.

**Why `io` is `do`, not a movable or a "split".** `io()` is a rare, whole-graph, **root-level admin
op** (backup / restore / seed), not a hot per-request barrier — it takes no input from the traversal
above it (its `apply` ignores its rows and returns none) and produces no traversers. Its R2 wait is
real, but the DO-pinned leg (whole-graph read for `write`; the set-based load for `read`) *is* the
bulk of the work, and during a wholesale load/dump the graph is under maintenance — freeing the DO to
serve concurrent callers of a half-written graph is dubious value, not a win. So there is nothing to
gain by moving io's R2 half off the DO. **io is `do`.**

**There is no `split` residency.** A barrier is never both — the binary is complete. If some *future*
barrier genuinely needed a DO leg and a Worker leg, that is **desugaring, not a third value**: express
it as two calls, each a single residency, with the byte payload flowing between them as ordinary
segment data — which is already how the async seam works (`io()` itself desugars to a `call()`,
`ir/strategies.ts` `desugarIo`). We do not build that ahead of a measured need; the mechanism is there
the day one appears.

**io ≈ federate?** Cousins on shared substrate, not aliases — and the difference is *persistence*, not
deployment. Both cross "rows from elsewhere" as one `json_each` bind (federate's `foreignRelation`;
io-read's set-based writer). But federate lands **detached, transient** rows (this query only, no
adjacency), while io-read is a **permanent mutation** (`loadGraphson` writes the store, persisted). A
*future* federate that imports part of a graph is the transient version of what io-read does
permanently — a distinct operation on the same landing machinery, not a collapse of the two.

### 4·4 The enabling refactor — LANDED (Phase 0, 2026-08-15)

`drive()` was a private `Executor` method closing over `this.store` and `this.app`. It is now
`driveSegments` (`src/drive.ts`) — a free function over an injected `SegmentHost` (`compile` +
`readHead`), so the same loop runs in-process on Bun (readHead a sync `store.query`) and, in Phase 2,
Worker-side on Cloudflare (readHead an RPC to the DO) with no second copy. `readHead` returns
Promise-or-value so the Worker host is async without touching the loop. `Executor` supplies the
in-process host and delegates. Pure refactor; the loop's semantics are pinned in isolation by
`test/drive.test.ts`.

---

## 5. What this is not

- **Not a rewrite of the compiler.** Lowering does not change — only *where* the function is called
  and *what* crosses the RPC.
- **Not Bun-affecting.** In-process there is no boundary; §4·4's injected-store version runs the
  identical loop. **Any design that only makes sense on Cloudflare is wrong — one router, two
  runtimes.**
- **Not a security boundary change in intent, but one in fact.** The DO grows an "execute this plan"
  RPC method — `runFramed(plan: Compiled)`, landed in Phase 1 (`graph-store-do.ts`). Where
  `framed(gremlin)` runs only what the compiler produces from a Gremlin string, `runFramed` runs raw
  SQL + binds the CALLER supplies. Same trust domain today (only the paired Worker holds the DO
  binding), but a real widening the moment anything else can reach that binding — said out loud here
  and in a comment on the method.

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

**Phase 0 — the refactor safe today. ✅ LANDED (2026-08-15).** `drive()` is now `driveSegments`
(`src/drive.ts`), a free function over an injected `SegmentHost` (§4·4). Pure refactor, no behaviour
change, pinned in isolation by `test/drive.test.ts`. The segment loop's ownership no longer belongs to
the store tier. (§4·3's residency field landed alongside — `barrier` declares `'do' | 'worker'`.)

**Phase 1 — the plan RPC (reads). ✅ LANDED (2026-08-15).** The DO method `runFramed(plan: Compiled)`
runs + frames a pre-compiled read via the shared `frameResolved`. The edge compiles in a store-free
`createCompileScope(extendedRegistry)` (`src/scopes.ts`) and `EdgeExecutor`
(`cloudflare-graph-manager.ts`) branches: a non-segment read → `runFramed`; a segment (federation), a
program (write), or ANY compile throw → the `framed(gremlin)` fallback, so the DO stays the single
authority for the plan and for errors. Correctness proven in-process (`test/cloudflare-edge.test.ts`:
store-independence, §2·1 zero store-touches, and the structural payoff — the DO's compile path is not
hit for a shipped read) and end to end on real workerd via `test/cloudflare.test.ts`'s contract. The
occupancy MILLISECONDS remain the workerd-only measurement (§8).

**Phase 2 — writes and the segment loop.** Gated on §7 (now MET). `Program` over the same RPC; the
Worker drives federation (§4·2) — supplying a Worker-side `SegmentHost` whose `readHead` is an RPC to
the DO; the residency field (§4·3) tells it which barriers may leave.

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
