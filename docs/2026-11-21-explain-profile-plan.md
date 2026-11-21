# `explain()` and `profile()` — show the algebra, the SQL and the cost

**Status: PROPOSED (2026-11-21).** Not started. The owner decides the open decisions in §8 before work
item E3 starts. Items E0–E2 need no decision and change no behaviour.

**Evidence:** `docs/reports/2026-11-21-production-readiness/04-query-plan-inspection.md` (the report).
It holds the measured worked example, the hook inventory and the TinkerPop reference facts. This plan
cites it as "the report".

## 1. Goal

*Diátaxis type: Explanation.*

Give every user, through any TinkerPop 4 client, two answers:

1. **`explain()`** — what the compiler did with a traversal, WITHOUT running it:
   - the step chain before and after the IR passes (TinkerPop's own `explain()` keys);
   - the RelIR plan, before and after the physical rel passes;
   - every SQL statement, with its binds;
   - SQLite's `EXPLAIN QUERY PLAN` for each statement.
2. **`profile()`** — what one RUN cost:
   - compile time, split by stage;
   - per SQL statement: time, rows returned, and on a Durable Object (DO) rows read and rows written;
   - framing time and result count.

The second purpose is a demonstration. `explain()` shows in one response that mogwai-db compiles Gremlin
to relational algebra and then to SQL that SQLite plans with indexes. No other Gremlin server can show
this, because no other one has this pipeline.

**Non-goals:**

- No Java `TraversalStrategy` names. mogwai-db's passes have their own names (root `CLAUDE.md`, Naming).
- No per-GREMLIN-STEP timing. Steps fuse into one statement, so a per-step time does not exist. §3.4
  says why and what replaces it.
- No new dependency. No new HTTP route (see open decision D3).

## 2. Current state

*Diátaxis type: Reference.* Full detail is in the report, §4.

| Fact | Status | Evidence |
|---|---|---|
| `g.V().explain()` declines | missing | `src/compiler/compiler.ts:122`; `src/gremlin/frontend.ts:489-498` |
| `g.V().profile()` declines | missing | `profile` is in `OPAQUE_STEPS`, `src/compiler/rel/write.ts:894`; measured |
| Each pipeline stage is a separate value | exists | the report §1.1 |
| The IR pass loop has one rewrite line | exists | `src/compiler/ir/passes.ts:452` |
| The logical and physical RelIR plans are both in scope at one point | exists | `src/compiler/rel/lower.ts:4372-4377` |
| The plan renders once; the run uses that rendering | exists | `src/rel/emit.ts:1353`; `src/compiler/rel/spine.ts:194` |
| All SQL passes through one method | exists | `GraphStore.query`, `src/storage.ts:364` |
| A program runs its steps through one loop | exists | `src/program.ts:85-121`, query at `:105` |
| A `RowSource` interface a decorator can wrap | exists | `src/program.ts:10-13`; precedent `CfLimitedSql`, `src/cf-limits.ts:94` |
| An out-of-band terminal flag from an extract Pass | exists | `stripTerminal` sets `ctx.out.discard`, `src/compiler/ir/passes.ts:58-59`; `src/compiler/ir/pass.ts:63` |
| RelIR walkers | exists | `src/rel/walk.ts:62` `relChildren`, `:98` `relExprs`, `:153` `exprRels` |
| RelIR or `Step[]` printer | missing | the report §4.2 |
| EQP on bun:sqlite | works, measured | the report §4.3 |
| EQP on DO (local workerd) | works, measured 2026-11-02 | `test/cf-probe/spool-autoindex.probe.ts:68-92` |
| Timer resolution inside a DO | unknown | the report §4.4 |
| DO `rowsRead`/`rowsWritten` | available, discarded | `src/cloudflare/DurableObjectSqlite.ts:14-15` |
| On Cloudflare, the Worker compiles and the DO runs | exists | `src/cloudflare/cloudflare-graph-manager.ts:29-38` |
| The JSON response path compiles on the DO | exists | `src/cloudflare/cloudflare-graph-manager.ts:60` |
| Two plan-reader debt items | open | `explain-reader`, `explain-classify-tests`, `docs/outstanding-work.md` §6 |

## 3. Design

*Diátaxis type: Explanation.*

### 3.1 One spine: a trace that only observes

`explain()` and `profile()` must not compile a different plan from the one a normal request runs. So
neither adds a compile mode. Both pass an optional **trace sink** into the existing compile.

```ts
// src/compiler/trace.ts (new) — the whole interface
export interface CompileTrace {
  steps(stage: 'front-end', steps: readonly Step[]): void;
  pass(name: string, category: PassCategory, steps: readonly IRStep[]): void; // only when the chain changed
  plan(stage: 'logical' | 'physical', plan: Plan): void;
  mark(stage: 'parse' | 'passes' | 'lower' | 'rel-passes' | 'render'): void;   // timing
}
```

| Hook | path:line today | What it records |
|---|---|---|
| after `stepChain` | `src/compiler/compiler.ts:132` | the front-end `Step[]` |
| after each `pass.run` | `src/compiler/ir/passes.ts:452` | the chain, if `chain !== before` |
| before the rel passes | `src/compiler/rel/lower.ts:4372` | the logical plan (`hoisted` + `wire.rel`) |
| after naming and effects | `src/compiler/rel/lower.ts:4407` (`const plan = built`) | the physical plan |
| stage ends | `compiler.ts:119`, `:132`, `lower.ts:4372`, `:4407`, `:4420` | `mark(...)` |

The sink travels as `CompileOptions.trace → RelRequest.trace → Lowering.trace`. It is set only on the
wire read (`src/compiler/rel/spine.ts:137`). A segment head and a resume carry it through
`loweringOptions` (`src/compiler/rel/spine.ts:148`).

**Why this keeps one spine.** The trace has no return value and the compile never reads it. The same
`compileUnguarded` runs. Work item E3 proves this with a byte-identity test over the corpus.

**Why this costs nothing when off.** With no sink, each hook is one `undefined` check. There are about
5 hooks per compile, plus 1 per pass. That is under 50 checks per compile, against a 1.43 ms warm
compile (the report §2.6). E3 measures it.

**The architecture gate.** `mise run arch` forbids a Pass from reaching `ChainFacts` or a fast path.
The trace is neither. The pass loop calls it, not a Pass.

### 3.2 `explain()` — a terminal method

`explain()` is a terminal method in the grammar, like `next()` (the report §3.1). So it is recognised at
the parse tree, not in the step chain.

1. `terminalMethod(tree)` (a rename of `unansweredTerminalMethod`, `src/gremlin/frontend.ts:489`)
   returns `'explain()'`.
2. A new `explainPlan(gremlin, params, options)` in `src/compiler/compiler.ts` runs `compileUnguarded`
   with a `CompileTrace` that keeps everything. `compilePlan` itself stays unchanged and still declines
   `explain()` for any caller that did not ask for an explanation.
3. The executor (`src/execute.ts`, `Executor`) checks the terminal method first. For `explain()` it calls
   `explainPlan`, then runs `EXPLAIN QUERY PLAN` on each statement against its own store.
4. It frames ONE result: a `Map`.

**Nothing runs.** `g.V().drop().explain()` deletes nothing. EQP prepares a statement and does not run
it (measured on a `DELETE`: the report §4.3).

**Where it runs on Cloudflare.** The DO, through the existing string fallback (`runOnDo`,
`src/cloudflare/cloudflare-graph-manager.ts:34`). The DO has both the compiler and the store. The RelIR
`Plan` cannot cross an RPC (`src/program.ts:15-24`), so compile and EQP must be in one isolate. An
explanation is rare, so the extra DO compile is acceptable.

**A segment plan.** A barrier (`call()`, `io()`, regex, ranked `order()`) compiles its resume only after
the head rows arrive (`src/drive.ts`). `explain()` runs nothing, so it shows the head and names each
barrier: `"mogwai:segments": [{barrier: 'call(tinker.search)', resume: 'compiled at run time'}]`. To
see a resume's SQL, use `profile()`.

**Answer shape.** TinkerPop's three keys first, so a tool that reads TinkerPop's shape still works
(`TraversalExplanationSerializer.java:61-83`). Then implementer keys under a `mogwai:` prefix, the same
convention as the GraphQL `mogwai:explain` extension (`src/graphql/edge.ts:53`).

```jsonc
{
  "original":     ["V()", "has(\"person\", \"name\", $who)", "out(\"knows\")", "values(\"name\")"],
  "intermediate": [ { "strategy": "foldConstantPredicateOperands", "category": "canonicalize",
                      "traversal": ["V()", "…"] } ],                       // only passes that changed the chain
  "final":        ["V()", "has(\"person\", \"name\", $who)", "out(\"knows\")", "values(\"name\")"],
  "mogwai:relir": { "logical": "<text>", "physical": "<text>" },
  "mogwai:sql":   [ { "role": "result", "sql": "SELECT …", "binds": ["marko"] } ],
  "mogwai:plan":  [ [ { "id": 7, "parent": 2, "detail": "SEARCH rsk0 USING INDEX vp_key_value (key=? AND value=?)" } ] ],
  "mogwai:text":  "<the whole explanation as one human-readable block>"
}
```

- `role` is `effect`, `guard` or `result`. A program lists every step in run order, with its binding
  name.
- A retained-rows bind prints as its marker, `{"rowsOf":"pw10"}`. EQP fills that hole with `'[]'`.
  `json_each`'s cost estimate does not depend on its content, so the plan shape is the same (inferred;
  E4 tests it on the write shapes).
- If SQLite refuses an EQP (for example, a statement near the DO's 100 KB text cap gets 19 more bytes),
  that statement's `mogwai:plan` entry is `{"error": "<message>"}`. The explanation still answers. This
  is a diagnostic field, not a decline.

**Wire.** GraphBinary `MAP` of `STRING` keys to `LIST`/`MAP`/`STRING` values. Every GLV decodes these.
The untyped JSON path renders the same value. The framer already frames maps and lists
(`src/execute.ts:163` `frameTypedNode`).

### 3.3 `profile()` — a step

`profile()` is a step in TinkerPop (the report §3.2). mogwai-db treats it like `iterate()`: an
out-of-band terminal flag.

1. The extract Pass `stripTerminal` (`src/compiler/ir/passes.ts:58`) also removes a trailing
   `profile()` and sets `ctx.out.profile = true`.
2. A `profile()` that is not last, and the side-effect form `profile('k')`, decline with a named reason
   (`UnsupportedTraversal.because`, `src/compiler/unsupported.ts:97`). Both are a property of the query
   text.
3. The executor runs the plan through a **`ProfilingRowSource`**: a decorator over `RowSource`
   (`src/program.ts:10`), the same pattern as `CfLimitedSql`. It records each statement: SQL, binds
   count, start and end time, rows returned. On a DO it also reads `rowsRead` and `rowsWritten` from the
   cursor.
4. The compile runs with a `CompileTrace` that keeps only the `mark()` times.
5. The result rows are framed and counted, then dropped. The answer is ONE `Map`.

**Writes run.** TinkerPop's `profile()` iterates the traversal, so `g.V().drop().profile()` deletes. The
write runs in the same atomic unit as without `profile()` (`src/program.ts:75-82`).

**Answer shape.** GraphBinary 4 has no metrics type, so the answer is a `Map`. The key names are the
GraphSON metrics keys (`GraphSONSerializersV3.java:391-417`), so the shape is familiar:

```jsonc
{
  "dur": 1.52,                                         // Double, ms, whole request on this isolate
  "metrics": [
    { "id": "compile", "name": "compile", "dur": 1.43,
      "metrics": [ {"id":"parse","dur":0.05}, {"id":"passes","dur":0.20}, {"id":"lower","dur":0.81},
                   {"id":"rel-passes","dur":0.22}, {"id":"render","dur":0.15} ] },
    { "id": "s0", "name": "result", "dur": 0.04,
      "counts": { "traverserCount": 2, "elementCount": 2 },
      "annotations": { "percentDur": 2.6, "sql": "SELECT …", "rowsRead": 9, "rowsWritten": 0 } },
    { "id": "frame", "name": "frame", "dur": 0.03, "counts": { "traverserCount": 2 } }
  ]
}
```

- `traverserCount` is the sum of `bulk`; `elementCount` is the row count (TinkerPop's two counts).
- Number classes follow the wire rules: `dur`/`percentDur` are Double; counts are Long
  (`.claude/rules/wire-protocol.md`).
- A segment plan adds one metric per head read, per barrier await, and per resume compile. So
  `profile()` sees what `explain()` cannot.

### 3.4 Why per statement and not per step

One Gremlin traversal becomes one SQL statement for a read (the report §2.3). SQLite runs the join as
one nested loop. There is no moment when `out('knows')` is "done". A per-step time would be invented.

The statement is the true unit of cost. Inside a statement, `mogwai:plan` (EQP) names each loop and its
index. The RelIR node ids (`j21`, `mv15`) appear as SQL aliases (`rme16`, `rp24`), so a reader can follow
one Gremlin step to its loop. E1 makes that link explicit: the printer annotates each `scan` with the
alias that EQP prints.

### 3.5 Parameters and redaction

- **Names in the chain, values in the SQL.** The `Step[]` text prints a parameter as `$who` (the
  `Arg.name`, root `CLAUDE.md` locked decision 5). The SQL keeps `?` and the binds list carries values.
- **Values are the caller's own.** The caller sent every bind value and every literal in the same
  request. One DO is one graph. So an explanation returned to the caller leaks nothing new.
- **Server-side logs are different.** A literal is inlined into the SQL by design (the bind rule). If a
  log ever records SQL, it must redact string and number literals and drop the binds. E8 adds a
  `redactSql` helper and uses it in any log path. The default logger stays silent (`src/router.ts:89`).
- **Schema exposure.** EQP shows index names. This is not data. With no authentication
  (`docs/outstanding-work.md` §5 `operations`), anyone who can query can already read all data. Open
  decision D2 covers a switch to turn the feature off.

### 3.6 Plan stability

The plan-stability gate (`test/plan-stability.test.ts`) asserts that the same access path is chosen with
and without `ANALYZE`. `explain()` must not hide a change in that. So:

- `explain()` reports the access path that SQLite will use for the SQL that would run. It is the same
  string, from the same render (§3.1).
- E4 asserts, for each `SHAPES` entry in `plan-stability.test.ts`, that `accessPaths` computed from
  `mogwai:plan` equals `accessPaths` computed from `compile(q).sql`.
- `explain()` passes the real binds to EQP. SQLite can use bound values to plan only with STAT4. The
  real binds keep the explained plan equal to the run plan in that case too.

### 3.7 Timing on Cloudflare

Cloudflare documents that timers advance only on I/O inside a Worker or DO. If this holds, a
synchronous compile and a synchronous `sql.exec` both read 0 ms there. E0 measures it before E5 builds
the timing.

- If timers are frozen: `profile()` on a DO reports `rowsRead`/`rowsWritten` (exact, and what Cloudflare
  bills) and omits `dur` for the in-DO parts. The Worker can time the RPC round trip, because an RPC is
  I/O.
- On Bun and in the browser, timers work (measured on Bun, the report §2.6).

The clock is injected through the app scope (`src/scopes.ts`), so tests use a fake clock.

## 4. Work items

*Diátaxis type: Reference.* Each item lands on its own with `mise run ci` green. Order is load-bearing:
E0 informs E5; E1–E2 are pure functions with no behaviour change; E3 is the only change to the compile
path.

### E0 — Measure the DO facts (probe, no product change)

Extend `test/cf-probe/` with one probe. Under `wrangler dev`, it measures:

1. whether `performance.now()` advances across a synchronous `sql.exec` that runs 50 ms of work;
2. `cursor.rowsRead` and `cursor.rowsWritten` on a read, a write and an EQP;
3. EQP on one compiled read, one compiled program step and one `WITH RECURSIVE`.

**Acceptance:** the probe runs with `bun test/cf-probe/<name>.probe.ts` and its result is recorded in a
`RESULT` comment, as in `spool-autoindex.probe.ts:84-92`. Production DO is still unmeasured, because
there is no deployment (`docs/outstanding-work.md` §5 `operations`); the comment says so.

### E1 — RelIR printer `src/rel/show.ts`

A pure function `showPlan(plan: Plan): string`. One line per node: kind, id, key fields (table and
alias, join kind and `ordered`, columns, sort terms, limit). Expressions print in a compact infix form.
A correlated subplan inside an expression prints indented under its node. `recursive` prints its seed
and its step through `recursiveStep`. `insert`/`update`/`delete` print their target, columns and source.
The printer imports only from `src/rel/`.

**Acceptance:**
- Snapshot tests for 6 shapes: the report's 1-hop read, a nested `where()`, `repeat().emit()`,
  `union()`, `group().by()`, a `property()` write.
- A totality test: for every L1 corpus traversal that lowers, `showPlan` returns a string and does not
  throw. It runs inside the existing `rel-sweep` loop, so it adds no second corpus walk.
- Determinism: the same plan prints the same text twice.

### E2 — Step printer `showSteps(steps): string[]`

Prints each `Step`/`IRStep` as Gremlin-like text. A parameter prints as `$name`. A child chain prints
nested, through `eachChildChain` (`src/compiler/ir/walk.ts`), never through a private walk
(`src/compiler/CLAUDE.md`). Folded regions (`repeatRegion`, `optionArms`) print in Gremlin form.

**Acceptance:** for every L1 traversal, `showSteps(stepChain(q))` does not throw. For the L2 snapshot
traversals with no folded region, the joined text parses again with `parseGremlin`.

### E3 — `CompileTrace` (the only compile-path change)

Add the interface and the hooks from §3.1.

**Acceptance:**
- **Byte identity.** For every L1 corpus traversal, `compile` with a full trace and without one return
  deep-equal results (`sql`, `binds`, `shape`, program steps), or the same decline message. This test is
  the proof of "one spine".
- **Zero cost.** Compile the L1 corpus 3 times with no trace, before and after the change. The median
  wall time must not rise by more than 1%. (`docs/outstanding-work.md` sets 2× as the regression bar;
  1% is stricter on purpose, because this path runs on every request.)
- `mise run arch`, `lint`, `binds` stay at zero.

### E4 — `explain()`

Build §3.2. Route `explain()` on the Bun `Executor`, the DO, and the browser worker. Add rows to
`docs/feature-support-matrix.md` (a new "Inspection" row group).

**Acceptance (`test/explain.test.ts`):**
- `mogwai:sql[i].sql` equals the corresponding `compile(q)` SQL, byte for byte.
- For each `SHAPES` entry in `test/plan-stability.test.ts`, the access paths from `mogwai:plan` equal
  `accessPaths` (`test/support/sql-core.ts:69`).
- `g.V().drop().explain()` leaves the node count unchanged.
- A parameterized traversal shows `$who` in `original` and `["marko"]` in binds.
- A segment plan names its barriers and does not run them.
- GLV decode: the JS client from the submodule, through the in-memory transport, receives one `Map`
  with the 3 TinkerPop keys (`test/support/in-memory-transport.ts`).
- Untyped JSON: `GET /gremlin/g?gremlin=g.V().explain()` returns the same keys.
- The census and L3 do not change (no corpus traversal uses `explain()`; the report §3.2).

### E5 — `profile()`

Build §3.3, using E0's result for the timing fields on a DO.

**Acceptance (`test/profile.test.ts`):**
- A read: 1 statement metric; its `elementCount` equals the result row count of the same query run
  without `profile()`.
- A write program: one metric per program step, in run order. Run the write with and without
  `profile()` on twin stores; the graphs are equal afterwards.
- A failing guard (for example `addV().property(T.id, 1)` twice): the error reaches the client on the
  trailer as without `profile()`, and the graph is unchanged (the atomic unit holds).
- `profile('k')` and a non-terminal `profile()` decline with their named reason.
- With a fake clock, every `dur` is the difference of the fake times, so the test is deterministic.
- Zero cost: the non-profile path does not construct `ProfilingRowSource` (assert by a spy on its
  constructor in one test).

### E6 — Text form and CLI

- `mogwai:text`: one block with the four stages, as in §6. Built from E1 and E2.
- `scripts/explain.ts`: `bun scripts/explain.ts "<gremlin>" [--graph modern|zoo] [--profile]`. It prints
  `mogwai:text`. It uses the same `Executor`, not a copy.

**Acceptance:** the script's output for the report's example contains the SQL from `compile(q).sql` and
at least one `SEARCH … USING INDEX` line. A smoke test runs the script on `modern`.

### E7 — GraphQL and API docs

- Extend the GraphQL `mogwai:explain` extension (`src/graphql/edge.ts:236`) to return the explanation of
  the translated Gremlin, beside the Gremlin string.
- Add an `explain()` example to the OpenAPI document (`src/docs.ts`), so the browser docs page "Test
  Request" button shows it.

**Acceptance:** `test/graphql.test.ts` gains one case with the extension on; the OpenAPI example
validates in the existing docs test.

### E8 — Redaction helper and docs

- `redactSql(sql)`: replaces string and number literals with `?`. Used by any log path that would print
  SQL.
- A how-to section in the README or a docs page: "Find why a query is slow".
- Divergence lines (one line each) in `docs/limitations.md` §3: `explain()` lists mogwai-db passes, not
  TinkerPop strategies; `profile()` reports per SQL statement, not per step.

**Acceptance:** a unit test for `redactSql` on the report's SQL leaves no `'marko'` and no `'knows'`.

### E9 (optional, D4) — Shared EQP reader

Put the EQP tree reader in `src/` (for `mogwai:plan` and the text form). The two debt items
`explain-reader` and `explain-classify-tests` (`docs/outstanding-work.md` §6) can then import it from
`test/support/` and `scripts/`. This removes one copy instead of adding a fourth.

**Acceptance:** as written in those two debt items, plus `scripts/sql-plan.ts` reads its rows through the
shared reader.

## 5. Test strategy summary

*Diátaxis type: Reference.*

| Risk | Test | Item |
|---|---|---|
| Explain shows a plan that does not run | byte identity over L1; SQL equality in `explain.test.ts` | E3, E4 |
| Explain hides a plan-stability change | `SHAPES` access paths through `mogwai:plan` | E4 |
| The trace slows normal compiles | corpus compile timing, ≤ 1% | E3 |
| Profile changes a write | twin-store comparison | E5 |
| A printer crashes on a rare plan | totality over the L1 corpus | E1, E2 |
| A GLV cannot decode the answer | JS client through the in-memory transport | E4 |
| Explain runs a write | node count before and after `drop().explain()` | E4 |
| Flaky timing assertions | injected fake clock | E5 |

The L8 perturbation run needs no special case: neither answer depends on row order, except the order of
statements, which the program fixes.

## 6. Demo — what makes mogwai-db different

*Diátaxis type: Tutorial (the target state after E4–E6; the SQL and plan lines below are real output
from the report §2).*

**Step 1.** Start the Bun server with the modern graph. Send:

```
g.V().has('person','name','marko').out('knows').values('name').explain()
```

**Step 2.** Read `mogwai:text`:

```
GREMLIN   V().has("person","name","marko").out("knows").values("name")
PASSES    (no pass changed the chain)
RELIR     join ordered
            join ordered
              distinct ← filter(key='name' AND value='marko') ← scan vertex_properties   [property seek]
              scan nodes
            scan edges                                                                     [out('knows')]
          scan vertex_properties                                                           [values('name')]
SQL       1 statement, 806 bytes, 0 binds
          SELECT … FROM (SELECT DISTINCT rsk0.node … ) sd0 CROSS JOIN nodes rn … CROSS JOIN edges rme16 …
SQLITE    SEARCH rsk0 USING INDEX vp_key_value (key=? AND value=?)
          SEARCH rn USING INTEGER PRIMARY KEY (rowid=?)
          SEARCH rme16 USING COVERING INDEX e_out (src=? AND label=?)
          SEARCH rp24 USING INDEX vp_node_key (node=? AND key=?)
```

What this shows:

- A four-step Gremlin traversal is **one** SQL statement. Nothing runs step by step.
- `has()` became an **index seek** that drives the whole join. The algebra placed it first.
- Every loop is a `SEARCH`. No table is scanned.

**Step 3.** Change the query to `…repeat(out()).emit()…`. The RelIR shows a `recursive` node; the SQL is
`WITH RECURSIVE`; SQLite prints `RECURSIVE STEP` with `SEARCH … e_pair`. A graph walk is a recursive
query.

**Step 4.** Change it to `….property('age', 30).explain()`. The answer lists 6 statements in one atomic
program: a snapshot, two deletes, two inserts, one update, then the read. Nothing was written.

**Step 5.** Replace `explain()` with `profile()`. The answer shows compile ≈ 1.4 ms and SQL ≈ 0.04 ms
(the report §2.6). On a small graph, the compiler is the cost; at scale, the SQL is.

## 7. Risks

*Diátaxis type: Explanation.*

| Risk | Effect | Mitigation |
|---|---|---|
| Frozen timers on Cloudflare | `profile()` reads 0 ms on a DO | E0 first; report rows read/written instead; time the RPC on the Worker |
| EQP refused by the production DO authorizer | no `mogwai:plan` on production | E0 measures locally; the field degrades to `{error}`, the explanation still answers |
| Plan text grows large | a deep plan's `mogwai:relir` can be large | the compile budget already bounds plan size (`src/sql/kernel/budget.ts`); print shared nodes once by id |
| The trace drifts from the real compile | a misleading explanation | E3 byte-identity test is a CI gate |
| `profile()` of a write surprises a user | data changes | matches TinkerPop; documented in the matrix row |
| A second plan reader appears | debt grows | E9 / D4 |
| The `explain()` terminal and the `profile()` flag widen `compilePlan`'s type | ripple through callers | keep `compilePlan` unchanged; `explainPlan` is a separate entry over the same `compileUnguarded` |

## 8. Open decisions for the owner

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Show bind VALUES in `explain()`? | (a) values; (b) `?` only; (c) a request option | (a): the caller sent them; logs use `redactSql` |
| D2 | A switch to disable `explain()`/`profile()` in production? | (a) none; (b) env `MOGWAI_INSPECT=off`; (c) wait for authentication | (b): cheap, and it protects a public deployment before `operations` lands |
| D3 | A separate HTTP route (`/gremlin/{g}/_explain`)? | (a) no route — `GET ?gremlin=….explain()` already returns JSON; (b) add a route | (a): one mechanism; curl and the docs page already work through `GET` |
| D4 | Do E9 (shared EQP reader) inside this plan? | (a) yes; (b) leave to the debt items | (a): otherwise this plan adds a fourth reader |
| D5 | Opt-in `Server-Timing` header (compile, sql) on every response? | (a) no; (b) behind a request option | (b) later, after E5: it gives the performance area a number on every request without `profile()` |
| D6 | Do `profile()` metrics follow GraphSON key names? | (a) yes; (b) a mogwai-only shape | (a): familiar to TinkerPop users and to existing tools |

No item needs a new dependency.

## Glossary

| Term | Meaning here |
|---|---|
| Trace sink | An object the compile calls at fixed points. It records; it never changes the compile. |
| Logical plan | The RelIR plan before the physical rel passes |
| Physical plan | The RelIR plan after `fuse`, `leading`, `magic`, `dropUnreadJoins`, `semijoin` and naming |
| EQP | SQLite `EXPLAIN QUERY PLAN` |
| Terminal method | A grammar element after the traversal (`next()`, `toList()`, `explain()`), not a step |
| `ProfilingRowSource` | A `RowSource` decorator that records each statement's time and row count |
| Segment plan | A plan split at a barrier whose input arrives later |
