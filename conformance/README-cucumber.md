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
once (`npm install` — pulls cucumber-js, ts-node, chai, cross-env):

```bash
cross-env NODE_OPTIONS='--loader ts-node/esm' TS_NODE_PROJECT='tsconfig.test.json' \
  CLIENT_MIMETYPE='application/vnd.graphbinary-v4.0' \
  cucumber-js \
  --tags "(@StepCount or @StepHasLabel or @StepHas or @StepValues or @StepId or @StepLabel or @StepDedup or @StepLimit or @StepRange or @StepOrder or @StepValueMap or @StepElementMap or @StepDrop or @StepInject) and not @StepWrite and not @GraphComputerOnly" \
  --import test/cucumber \
  ../../gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/
```

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
- Node compatibility: the runner uses the `ts-node/esm` loader. If the local
  Node rejects it, run under the Node version in the GLV's `.nvmrc`.
