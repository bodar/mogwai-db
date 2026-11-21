# Engineering quality — four missing mechanisms

**Status: PROPOSED (2026-11-21).** Source: the engineering quality audit,
`docs/reports/2026-11-21-production-readiness/07-engineering-quality.md`. Nothing here is started. The owner
decides scope and order (section 6).

## 1. Goal

Close four gaps that the audit found in the quality mechanisms. Each gap is a mechanism that does not exist
today. None of them changes what a query answers.

| ID | Gap | Audit section |
|---|---|---|
| Q1 | Layer direction and two latent RelIR laws are not checked | 1, 2 |
| Q2 | Four physical passes have no "pass on ≡ pass off" differential | 2 |
| Q3 | The wire boundary does not tell a decline from an internal bug | Error handling |
| Q4 | No generated-input comparison against an independent engine | 6 |

## 2. Current state

- **Layering.** `src/rel/` imports nothing from `src/compiler/` or `src/gremlin/` (measured with `grep`).
  The rule is prose only (`src/rel/obligations.ts:19`). `scripts/arch-check.ts` checks only the Pass role
  rules (`scripts/arch-check.ts:1-28`).
- **Set union.** A `Union` with `all: false` has no channel law. `Distinct` has one
  (`src/rel/obligations.ts:133-139`). Today one site builds a set union, with no channels
  (`src/compiler/rel/write.ts:3307`).
- **Function names.** `call.fn` is an open `string` (`src/rel/expr.ts:19`). The lowering uses 43 distinct
  names. A typo fails only at execution.
- **Physical passes.** The pipeline is `fuseAll → leadingAll → magicAll → dropUnreadJoins → semijoinAll`
  (`src/compiler/rel/lower.ts:4372`). Only the two `semijoinAll` strategies have switches
  (`ftsSubstringPredicate`, `propertySeek`; `src/compiler/options/fast-paths.ts:102-110`). L5's
  differential toggles only `FastPathConfig` switches (`test/CLAUDE.md:99-104`).
- **Error boundary.** `runQuery` sends every error message the same way (`src/router.ts:116-119`).
  `errorResponse` always writes trailer status 500 (`src/http.ts:49-52`). The default logger is silent
  (root `CLAUDE.md`, "A query failure is not a crash").
- **Reference differential.** L6 compares 312 fixed queries against goldens generated once from
  TinkerGraph in docker (`scripts/workload-goldens/generate.ts`, `test/L6-workload/`). L5 generates
  traversals but has no external oracle (`docs/property-based-testing-l5.md`, "The blind spot").

## 3. Design

### Q1 — Static laws

1. Add a layer rule to `scripts/arch-check.ts`. No file under `src/rel/` may import a module under
   `src/compiler/` or `src/gremlin/`. Zero violations is the gate, as for the existing rules.
2. Add a `union` obligation: a `Union` with `all: false` may not carry any channel. Same reason as the
   `Distinct` law: a set union over traverser rows changes multiplicity.
3. Make `call.fn` a closed string-literal union, `SqlFn`, in `src/rel/expr.ts`. The union lists the
   functions the emitter may write. The emitter keeps its current spelling.

### Q2 — Pass ablation differential

1. Add a test-only `PassConfig` to the lowering request: `fuse`, `leading`, `magic`, `dropUnreadJoins`, each
   default `true`. It is not part of `FastPathConfig`, so no user can turn it off.
2. Extend the L5 differential to run each generated traversal with each pass off, one at a time.
3. A disagreement is a defect in the pass. The generic plan (pass off) is the authority.

A pass that is off must still produce a valid plan. If a pass is needed for a plan to be legal (for example
to stay under the 64-table join limit), the differential records that as "not evaluable", not as a defect.

### Q3 — Error classification at the boundary

1. Add one classifier at the executor seam. It maps an error to `decline`, `query-error` or `internal`.
   `UnsupportedTraversal` is a decline. `ValueParseError` and `RaisedByQuery` are query errors. Anything
   else is internal.
2. Keep the message text for all three. Add a stable prefix for `internal` so a client can tell them apart.
3. Log `internal` errors even when the query logger is silent. Do not log declines or query errors.

### Q4 — Offline reference differential for generated traversals

1. Reuse the L6 golden generator. Feed it a fixed sample of L5-generated traversals (for example 1,000 at
   one seed).
2. Commit the goldens. Compare them in the ordinary suite with L6's canonical value strings
   (`test/L6-workload/canon.ts`).
3. Re-generate only by a command, as L6 does. Docker never runs in CI.

## 4. Work items

| # | Item | Acceptance test |
|---|---|---|
| Q1a | Layer rule in `arch-check.ts` | A scratch import from `src/rel/` to `src/compiler/` fails `mise run arch`; trunk passes with 0 violations |
| Q1b | `union` set-union channel law | A new `test/rel.test.ts` case: a `Union {all: false}` with a `bulk` channel throws; the `write.ts:3307` site still passes `mise run ci` |
| Q1c | `SqlFn` closed union | `mise run check` passes; a misspelled function name in a scratch lowering fails `tsc` |
| Q2a | `PassConfig` plumbing, test-only | Default compile output is byte-identical over the L1 corpus (census unchanged) |
| Q2b | L5 differential per pass | `mise run L5` reports per-pass results; any disagreement is a `known.ts` entry with a diagnosis or a fix |
| Q3a | Boundary classifier | `test/error-surface.test.ts` gains one case per class; a forced internal error carries the prefix |
| Q3b | Internal errors logged | A test with the silent logger sees one log line for an internal error and none for a decline |
| Q4a | Generated sample through the golden generator | Goldens committed; re-run with `mise run workload-record` style command only |
| Q4b | Comparison in the suite | A new test compares results; wrong answers are ratcheted at the measured count, each with a reason |

Order: Q1 first (small, static). Then Q3. Then Q2. Q4 last, because it needs docker time and owner review
of every difference found.

## 5. Risks

- **Q1c** touches every `call` site in the lowering (5 local `call` helpers and many inline sites). It is
  a type-only change, but the diff is wide.
- **Q2** can find real defects in `fuse`, `leading` or `magic`. Each one is a wrong answer today. That is
  the purpose, but it can add work to `docs/outstanding-work.md` §1.
- **Q2** doubles L5 work per pass. L5 run time grows. Measure it against the 2× regression bar.
- **Q3** changes the message text for internal errors. Clients that match message text may see a change.
- **Q4** differences include deliberate divergences (`docs/limitations.md` §3). Each one needs a
  classification, as L6 already does.

## 6. Open decisions for the owner

1. **Q3 logging.** Root `CLAUDE.md` says a query failure is not logged. Is an internal error a "query
   failure" for that rule, or an incident that must be logged?
2. **Q3 wire status.** Keep trailer status 500 for every class, or use a different status for a decline?
   A change here affects GLV client behaviour.
3. **Q4 scope and cost.** How large a sample, and how often to re-generate? Docker is already used offline
   for L6; no new dependency is needed. Confirm that this use is acceptable.
4. **Q2 placement.** Run per-pass ablation in every `mise run ci`, or only in `mise run L5-random`?
5. **Q1c.** Is a closed `SqlFn` union worth the wide diff, given that a typo already fails at the first
   test that executes it?
