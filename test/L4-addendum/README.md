# L4 — the mogwai conformance addendum

Our own conformance scenarios, in TinkerPop's **exact Gherkin `.feature` format**, for *valid*
traversals the official corpus (L3) doesn't cover — combinations we implemented for
combinatorial completeness. `../l4.test.ts` runs them end-to-end and the gate is simple: **all
must pass** (these are ours; a failure is a regression).

## How L4 runs them

The official cucumber harness binds each scenario *name* to a pre-generated traversal in a
vendored `gremlin.js`. We don't need that — **we parse Gremlin natively**. So `l4.test.ts`
reads each scenario's embedded Gremlin string and runs it straight through the real stack:

```
parse → compile → SQLite → frame → GraphBinary   (executeQuery)
        → decode with the gremlin client `ioc`    (exercises our extended serializers)
        → compare vs the | result | table (TinkerPop typed notation: d[32].i / d[1].l / l[…])
```

So a scenario exercises the *same* wire/framing/serialization path a real client hits — not
just the compiler.

## Adding a scenario

Drop it into any `*.feature` here — no code change. Use a seeded graph (`Given the modern
graph` / `the crew graph`) or build data inline (`Given an empty graph` + `inject(...)`/`addV`).
Author the expected `| result |` in TinkerPop typed notation. Then `bun test test/L4-addendum/l4.test.ts`.

Supported result notations today: `d[n].i` (int), `d[n].l` (long → BigInt), `d[n].d`/`.f`
(double/float), `l[…]`/`s[…]` (list/set, ordered within), bare strings, `null`. Add more in
`l4.test.ts` `parseTyped`/`canon` as scenarios need them (maps/vertices next).

## Why Gherkin (the give-back)

Because these are real TinkerPop-format feature files, the `@gap:<area>` set harvests directly
into an Apache TinkerPop `gremlin-test` PR: *"here are valid traversals your suite doesn't
exercise."* Same energy as contributing the missing GraphBinary serializers (BigDecimal/Char/
Duration) upstream. See `../README-cucumber.md` for the L3 runbook this complements.
