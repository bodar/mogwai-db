# The census — the refactor guard

**Not a conformance level.** L1–L5 all ask *is this correct?*. The census asks the only question
none of them can: **did anything change?**

Run it: `mise run census`. Re-record it: `mise run census-record`.

## Why it exists

A behaviour-preserving refactor's success criterion is a number that does **not** move — which,
with L1–L5 alone, is indistinguishable from a refactor that quietly turned twenty fail-closed
deferrals into wrong answers. Two structural blind spots make that concrete:

- **873 of the 2,298 corpus traversals do not execute.** That 38% of the surface is exercised by no
  oracle at all. Every silent-`[]` defect in the project's history has lived there.
- **L5's differential cannot see a shared defect.** It compares the two *lowerings* against each
  other, so a change that moves both is invisible by construction — the differential's own README
  says so. L5's metamorphic oracle covers a different axis (19 semantic laws over generated
  prefixes); neither answers "does this traversal still return what it returned yesterday".

## The artifact

Two committed TSVs, both regenerated together:

| file | rows | holds |
|---|---|---|
| `goldens.tsv` | 1,425 | traversals that execute, and a digest of what they returned |
| `deferrals.tsv` | 873 | traversals that throw, and the normalized message |

Split because they churn on different schedules: a step landing **moves a row between the files**,
which is exactly the signal worth seeing in a diff.

### Status vocabulary

| status | n | meaning |
|---|---|---|
| `ran` | 1,425 | executed; `ms`/`ord` digests recorded |
| `nondet` | 0 | executed, digest deliberately withheld — see below |
| `deferred` | 475 | threw one of **our** clear deferrals. Fail-closed working as designed |
| `unbound` | 381 | `Unbound parameter` — a harness limit, not a product defect |
| `crashed` | 17 | threw a raw runtime error. **A fail-closed violation** |

**`unbound` is honest, not lazy.** 383 corpus traversals reference bound parameters (`vid1`, `xx1`,
…) and nothing in-tree reproduces TinkerPop's binding table. L1 passes a proxy that resolves every
name to `null`, which buys 66 more compiles by silently answering a *different* question
(`g.V(vid1)` → `g.V(null)`). The census passes `{}` instead. If a binding table ever lands, this
bucket is the work item.

**The 17 `crashed` rows are real defects, recorded rather than hidden.** 10 are a `bun:sqlite` bind
rejection, 3 are raw JS `TypeError`s (`node.constructor`, `child.stream`), 2 are a `RangeError`
framing an out-of-int32 date, 1 is a `UNIQUE constraint`, and **1 is us emitting syntactically
invalid SQL** (`near ",": syntax error`, from
`g.V().as("a").out("knows").as("a").select(Pop.all, __.constant("a"))`). Each should become a clear
deferral or a fix; the gate holds the count from growing meanwhile.

## The gates

1. **The artifact covers exactly the corpus** — catches a `regen-corpus` that shifts the input set.
2. **No traversal stops executing** — support lost.
3. **No executing traversal changes its answer** — *the regression nothing else can see.*
4. **No clean deferral becomes a crash**, and the crash count does not grow.
5. **Coverage floor** (1,400) — a run where everything throws cannot pass vacuously.

Telemetry, reported but never gating: newly-executing traversals, emission-order changes, and
reworded deferral messages.

## Two deliberate departures from the other ratchets

**It does not auto-record.** `l3-state.json` rewrites itself on a clean local run, and that is safe
*there* because its artifact is a monotone floor — the regression gate runs first, so an auto-record
can only ever bank an improvement. The census is a **two-way baseline** whose most dangerous
transition is *still runs, different answer*; an auto-record would launder precisely the regression
it exists to catch. So re-recording is a command, and `record.ts` prints the delta before writing.

**It executes; it never bare-`compile()`s.** `compile(q, {})` resolves no service registry, so all
12 `call()` traversals throw *unknown service* and would be committed as false deferrals. Executing
also makes the compile census free — every compile failure surfaces as a throw anyway — which is why
this is one instrument and not the two the design doc originally proposed.

## What the digest does and does not cover

`ms` (**gates**) is the weighed traverser multiset, sorted so hash-map ordering cannot leak in.
`ord` (**telemetry**) is emission order, isolated so it can be reported without failing a run:
TinkerPop constrains order only as far as the traversal establishes it, and 356 of these move under
a planner perturbation. Gating on `ord` guarantees a suite that flaps on a Bun bump.

**Sorting the outer multiset does not make `ms` order-immune.** When `fold()`/`cap()`/`group()`
collapses a stream into one traverser, member order lives *inside* that traverser's GraphBinary
buffer. **50 traversals are order-sensitive this way** — deterministic today, but a legitimate
lowering change can move them. When it does, re-record with a written reason.

`nondet` withholds the digest for traversals whose result is legitimately random: `sample()`,
`coin()`, `Order.shuffle` (→ SQL `RANDOM()`, 5 sites) and a bare `datetime()` (→ `Date.now()`,
`frontend.ts:335`). 24 corpus lines match and 23 currently throw, so the guard costs nothing today —
which is exactly why it went in now, rather than after those steps land and 23 goldens start
flapping with no diagnosis.

## Known limits

- **One fixture.** `regen-corpus.ts` discards the Gherkin `@GraphData` tag, so there is no
  corpus→fixture mapping and every traversal runs against the modern graph. **325 of the 1,425
  goldens legitimately return 0 rows** because they query crew/grateful data. Their goldens are real
  but vacuous; if that count ever drops, someone added the fixture column.
- **Bun-only messages.** 17 rows carry text from `bun:sqlite`, SQLite or the JS engine. Asserting
  this artifact on Cloudflare would need those compared on status only, not message.

## Never do this

Re-record to make a red build green without a written reason. That is the one thing this file
exists to prevent, and a re-record with no explanation in the commit message is indistinguishable
from the regression it hides.
