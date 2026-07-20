# L3 — the official TinkerPop cucumber suite

The conformance number. TinkerPop's own JS cucumber runner drives the official
Gherkin feature files over GraphBinary against a live mogwai-db.

**This now runs automatically as a ratchet under `bun test`** —
`test/conformance/l3.test.ts` boots the host in-process, runs the cucumber suite
against the pinned `vendor/tinkerpop` submodule, and diffs this run against the
last-known run committed in `l3-state.json` (`{passing, total, passed[], failed[]}`).
Telemetry is **always on**: a live `.`/`E` progress line during the run, then the
DELTA (`✅ NEWLY PASSING` + `❌ REGRESSED`) and the systematic-gap summary after.
Gates: any regression → fail (named); count below `passing` → fail. A clean local
run re-records `l3-state.json` + count-quoting prose; CI never rewrites. The step
scope lives in `tags.ts`. `conformance.test.ts` is a self-contained mini-L3 (no
submodule) that proves the wiring. **This file is the runbook for running the full
suite manually** (e.g. to inspect individual failures).

## 1. Start the conformance host

```bash
bun run test/conformance/conformance-server.ts     # listens on :45940/gremlin
```

Hosts the named toy graphs the runner opens, selected by traversal-source name
in the request `g` field (the runner's convention):

| graph   | source name | state                       |
|---------|-------------|-----------------------------|
| modern  | `gmodern`   | seeded, canonical ids       |
| empty   | `ggraph`    | empty, writable (reset via `g.V().drop()`) |
| classic/crew/grateful/sink | `gclassic` … | empty until seeds land |

The runner defaults to `http://localhost:45940/gremlin` (hardcoded in
`gremlin-js/gremlin-javascript/test/helper.js`) — no edit needed; the router's bare
`/gremlin` endpoint resolves the `traversalSource` (`g` field) to the graph. Add
seeds to `SEEDS` in `conformance-server.ts` as more reference graphs come online —
each seed is a list of gremlin write traversals (`seed-*.ts`) run through the normal
query path, so seeding is identical on both runtimes.

## 2. Run the suite, narrowed to the implemented step set

In the pinned submodule runner (`vendor/tinkerpop/gremlin-js/gremlin-javascript`);
`mise run submodule` has already `bun install`ed the workspace (bun runs the GLV's
TS source and the cucumber step defs natively — no `npm install`, no ts-node).
The `--tags` scope is the single source of truth in `test/conformance/tags.ts`
(the ratchet lever). Read it from there so this command never drifts:

```bash
# from the mogwai-db repo root:
TAGS="$(bun -e 'import{L3_TAGS}from"./test/conformance/tags.ts";console.log(L3_TAGS)')"

cd vendor/tinkerpop/gremlin-js/gremlin-javascript
CLIENT_MIMETYPE='application/vnd.graphbinary-v4.0' \
  bunx --bun cucumber-js \
  --tags "$TAGS" \
  --import test/cucumber \
  ../../gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/
```

**The live number lives in `l3-state.json`** (`passing` = `passed.length`), which the
ratchet auto-records — treat that file, not this doc, as authoritative; the same record
also syncs the count in `README.md` and `docs/feature-support-matrix.md` (the `SYNC_FILES`
list in `l3.test.ts`), so commit them together. Historical progression: P2c-2 cleared the `BeforeAll` gate and published 85;
P2b (is/where/not/filter/TextP) → 119; P2-tail (and/or/union/optional) → 126; P3
repeat/times/emit → 130; W2 (addV/addE/mergeV/mergeE writes + property update) → 204;
a full-suite tag-scope correction → 445; the path family → 455; per-traverser branching +
match + types/dates/math → 608; side-effects (sack/aggregate/cap) → 634; W4 multi/meta
properties → 648; `local` → 661; the re-enterable collection tail (MapStream) → 685;
string transforms → 728; the sink reference graph → 730; the set-op / list-algebra family
(combine/intersect/…/all/any, incl. standalone operands) → 804; `format` → 810;
unfold-of-scalar + min/max over Strings → **822**. Before P2c-2 it was 0 — the gate blocked
every scenario. Ratchet only upward.

`@StepWrite` (excluded) is the `io().write()` graph-serialization feature, NOT
our element writes — those live under `@StepAddV/@StepAddE/@StepMergeV/@StepMergeE`
(now in the set). Remaining W2 misses are out of scope: nested-traversal merge
maps (`mergeV(__.select(...))`), `Cardinality.list/set` multi-property (W4),
`with()`, `hasId`.

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
the property-group scalar reader, `tryPropertyGroupScalar`), so the runner gets past
setup and scenarios execute. Generic child streams own language support; this reader
is the property-group case, which has no live ElementStream parent (so no child seam).
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
