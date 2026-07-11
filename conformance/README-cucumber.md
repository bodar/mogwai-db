# L3 — the official TinkerPop cucumber suite

The conformance number. TinkerPop's own JS cucumber runner drives the 164
official Gherkin feature files over GraphBinary against a live mogwai-db.
`conformance/conformance.test.ts` is a self-contained mini-L3 (runs under
`bun test`, no external deps) that proves the wiring; this file is how to run
the *full* suite for a published score.

## 1. Start the conformance host

```bash
bun run conformance/conformance-server.ts     # listens on :45940/gremlin
```

Hosts the named toy graphs the runner opens, selected by traversal-source name
in the request `g` field (the runner's convention):

| graph   | source name | state                       |
|---------|-------------|-----------------------------|
| modern  | `gmodern`   | seeded, canonical ids       |
| empty   | `ggraph`    | empty, writable (reset via `g.V().drop()`) |
| classic/crew/grateful/sink | `gclassic` … | empty until seeds land |

The runner defaults to `http://localhost:45940/gremlin` (hardcoded in
`gremlin-js/gremlin-javascript/test/helper.js`) — no edit needed. Add seeds to
`SEEDS` in `conformance-server.ts` as more reference graphs come online.

## 2. Run the suite, narrowed to the implemented step set

In the TinkerPop checkout (`~/Projects/tinkerpop/gremlin-js/gremlin-javascript`),
once: `bun install` (bun runs the GLV's TS source and the cucumber step defs
natively — no `npm install`, no ts-node).

```bash
CLIENT_MIMETYPE='application/vnd.graphbinary-v4.0' \
  bunx --bun cucumber-js \
  --tags "(@StepCount or @StepHasLabel or @StepHas or @StepValues or @StepId or @StepLabel or @StepDedup or @StepLimit or @StepRange or @StepOrder or @StepValueMap or @StepElementMap or @StepDrop or @StepInject or @StepSelect or @StepProject or @StepOut or @StepIn or @StepBoth or @StepProperties or @StepGroup or @StepGroupCount or @StepFold or @StepSum or @StepIs or @StepWhere or @StepNot or @StepFilter or @StepAnd or @StepOr or @StepUnion or @StepOptional) and not @StepWrite and not @GraphComputerOnly and not @AllowNullPropertyValues" \
  --import test/cucumber \
  ../../gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/
```

**Current live number: 517 scenarios run, 126 pass** (P2-tail). Progression:
P2c-2 cleared the `BeforeAll` gate and published 85; P2b (is/where/not/filter/
TextP) → 119; P2-tail (and/or/union/optional) → 126. Before P2c-2 it was 0 — the
gate blocked every scenario. Ratchet only upward as steps land.

`bunx --bun` forces the cucumber-js bin to run under the **bun** runtime, not
node (its shebang is `#!/usr/bin/env node`). Bun then resolves the GLV's `.ts`
sources and the `.js`→`.ts` imports natively, so the old
`NODE_OPTIONS='--loader ts-node/esm' TS_NODE_PROJECT='tsconfig.test.json'`
dance is gone. Verified: cucumber loads the harness and drives the live server
over GraphBinary under bun.

**The `BeforeAll` gate (CLEARED in P2c-2).** The harness `BeforeAll`
(`test/cucumber/world.js`) caches every seeded graph via three aggregation
traversals — `g.V().group().by('name').by(__.tail())`, an `g.E().group()` with a
`project(o,l,i)` composite key, and `g.V().properties().group()` with a
`project(n,k,v)` key. All three now compile and frame (P2c-2's `compileGroup` +
`compileNestedScalar`), so the runner gets past setup and scenarios execute.
Before P2c-2 this blocked the entire suite at 0.

The passing-scenario count is **THE conformance number** — publish it per commit
and ratchet only upward. Widen the `--tags` set as each new step lands (P2+).

## 3. Ignore-list for out-of-scope scenarios

Scenarios needing lambdas/OLAP/side-effect exotica are skipped by adding an
entry (keyed by scenario name) to `ignoredScenarios` in
`test/cucumber/feature-steps.js`, or excluded via `--tags`. Keep the list short.

## Notes

- `--tags` is the ratchet: start with the set above (all P1 steps), expand as
  P2 (`as`/`select`/`by`/`where`/`union`) and P3 (`repeat`/`mergeV`) land.
- `@StepWrite` scenarios are skipped by upstream anyway; the empty-graph
  write/reset path is still exercised by every `Given the empty graph` step,
  which is why `drop()` shipped in P1.
- Runs under bun (`bunx --bun`), same runtime as `bun test` — no node/ts-node
  toolchain needed. `bun install` in the GLV checkout is the only setup.
