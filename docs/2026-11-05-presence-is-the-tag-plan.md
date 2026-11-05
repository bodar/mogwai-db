# Presence is the tag — plan

**Status: DECIDED by the owner (2026-11-05). Build as written; do not relitigate. Widening the scope to get
a better result is the intended direction.** It replaces outstanding-work §2 "Tier B — retire
`PresentWhen`?": the answer is neither to retire nor to keep. The side channel goes, and every correct
answer stays.

Evidence: the design study `.logs/presence-tag-study.md` (local) and its probes in `.logs/presence/`. It
has file:line maps of every producer, consumer and outside-attached tag, and measured costs.

## The idea

A child body (`map`, `local`, `flatMap`, `by()`, `where`, `coalesce`/`choose` arms) reaches its host as a
correlated scalar subquery. SQL folds two Gremlin states into one `NULL`: the body produced NOTHING
(unproductive), or it produced a NULL (productive). Today `PresentWhen {when, orValue?}`
(`src/compiler/rel/child.ts`) is a hand-built side channel that tells them apart. It has five producers,
about 33 readers and a history of regressions.

Both vendored references model it as ONE structure:

- **TinkerPop.** Productivity is one bit beside the value: `util/TraversalProduct.java`, set from
  `hasNext()` in `TraversalUtil.produce` (`util/TraversalUtil.java:108-140`). It is read uniformly by
  `ProjectStep.java:66`, `TraversalMapStep.java:49-53`, `CoalesceStep.java:58`, `SelectOneStep.java:64-65`,
  `DedupGlobalStep.java:77-83`, `OrderGlobalStep.java:183-184`, `BranchStep.java:161-162` and
  `TraversalUtil.test:143-151`.
- **Calcite.** `RelDecorrelator` projects a literal TRUE "null indicator" INSIDE the subquery (`:3157-3170`),
  rewrites `count(*)` onto it (`:3374-3388`), and gates any constant hoisted above the join on it
  (`visitLiteral`, `:2720-2726`).

We already carry that column: the per-row type tag (`vtype`; archived RelIR plan §6·7, "a static tag is
an optimization, never the carrier").

**THE RULE. Presence is `tag IS NOT NULL`.** The tag is TOTAL inside the body: it is never NULL for a row
the body produced, and it is `'null'` for a null value. "No row" therefore reads as a NULL tag. Three
corollaries:

1. **A tag is built INSIDE the body's own row** (a constant in its select list when static, so it costs
   nothing). It is never attached by the host.
2. **A tag is never inferred outside.** `typeof(v)` over a scalar-subquery result answers `'null'` on
   no-row, which is the inverse defect.
3. **Where a body's type admits no null, the value IS the presence column**, with zero extra cost.

## Steps

Each step lands green on its own. IDs are stable. `after` gives the order.

- **P0 schema-version** — a storage substrate. There is no schema version or migration mechanism today
  (`src/storage.ts` is all `CREATE … IF NOT EXISTS`). Add one: `PRAGMA user_version`, read when a store
  opens, and an ordered list of migrations, each a SET-BASED statement program (no row loops, no
  data-sized binds: CLAUDE.md's bind rule). The list runs once per graph, inside one transaction. It
  must work on `bun:sqlite`, a Durable Object (a DO migrates lazily on its first request), and the
  browser/WASM store. It refuses to open a store whose version is newer than the code. Tests cover a fresh
  store, an old store, an already-migrated store, a failure mid-migration that rolls back, and a store that
  is too new.

- **P1 total-tag encoding (after P0)** — every writer of a typed `{t,v}` tree and every alias-history entry
  `{k,v,t}` writes `t:'null'` for a null value. Today a null member is `{"t":null,"v":null}`, and a
  `constant(null).as('k')` entry has no `t` at all. **Find every persisted typed tree**: vertex and edge
  property values, and anything else stored as JSON (replication/sync tables, conflicts, tombstones, saved
  side effects; check `src/storage.ts`, `src/replicate.ts`, `src/setwrite.ts`, `src/formats/`). Then:
  - **Migration 1** (P0's first) rewrites legacy nodes set-based, with SQLite JSON1 over `json_tree`.
  - **Every import path** (GraphSON/CSV loaders, `BatchingLoader`, federation landings, replication
    apply) writes the total form.

  Tests: a store seeded in the legacy form migrates, and reads back identically; a byte-level check that no
  writer emits `t:null`.

- **P2 the inside-tag contract (after P1)** — ONE helper builds a child tag. It infers (`typeof(v)`) only
  where `v` is a real row column, and refuses on a scalar-subquery result. Gate every outside-attached
  static literal on its arm's presence, Calcite `visitLiteral` style:
  - coalesce's `ELSE armTag(final)` (`lower/reduction.ts` ~:1752), the clearest "no row looks present" site;
  - choose's arm tags (~:1657);
  - `hostTag` over a may-be-absent value (`child.ts` ~:368, and the call sites the study lists);
  - `staticTagExpr` (`modulator.ts`), `mergedVtypeOf` (`build.ts`), `record.ts`, and the write, collection
    and sack literals.

  **Enforce it mechanically**: extend `mise run arch` (or a lint rule) so a child tag can only come from
  the helper. A convention would regress.

- **P3 the `is()` predicate projected once (after P2)** — a tag gated by the same CASE as the value must
  not spell the predicate twice (the study measured 2.2× vs +12% when projected once). Route it through
  `once()` (`rel/build.ts`). This absorbs outstanding-work §3's "`once` consumers" item where the two
  overlap.

- **P4 producers, one commit each (after P2, P3)** — replace `{when}` with the tag column. Each producer
  deletes its stated branch and the declines that guarded it:
  - `oneRowPresence` (the tag projected inside `rel`, replacing EXISTS);
  - `aliasGuard`/`rerootPresence` (the history entry's own `t`; this fixes a label bound to null reading
    as unbound);
  - `selectedNodeChild` (the node column IS the Option);
  - `producedOnlyWhere`;
  - coalesce (`orValue` becomes a tag-driven CASE).

  These are the wrong answers that flip to right: study §5, including `map(__.V().constant(null).limit(1))`
  (`[]`→`[null]`), `where(…)` (`[]`→`[1]`), the null-bound union label under `project`/`map(select)`, and
  `inject(null,1).map(is(neq(1)))`. Add each as an L4 scenario citing its reference step, and record the
  census with reasons. Trace S9.9 (`inject(['a':null]).map(select('a'))`). If its decline is a separate
  map-host gap, fix that too: widen, don't defer.

- **P5 admit the `constant(null)` child (after P4)** — `reduction.ts` ~:2824 and its element-arm twin:
  value NULL, tag `'null'`, gated on the host. This lifts r4-fu4 (`project('x').by(constant(null))`,
  `project('nick').by(coalesce(values('nick'), constant(null)))`) and the `map`/`local`/`flatMap`/`group`
  declines.

- **P6 consumers read the presence column, and follow the REFERENCE (after P5)** — `reductionTail`,
  `record.ts` field presence (so `project` keeps a null key), filters, branches and `productivityFilter`.
  Delete `meetPresence`. **Delete the §17 divergences that only existed because we could not tell the two
  states apart**: "A null `by()` value" (`docs/feature-support-matrix.md`), where `project` omits the key,
  `order`/`dedup`/`sack`/`where` drop the row, and `coalesce` is SQL `COALESCE`. Follow the reference
  instead:
  - `OrderGlobalStep` / `DedupGlobalStep` keep a productive-null key and order it per orderability;
  - `CoalesceStep` lets a null first arm win.

  Keep a §17 line only where the reference's answer is genuinely impossible, and say why.

- **P7 delete the type (after P6)** — remove `PresentWhen`, `statedPresence`, `HostPresence` and every
  `'when' in` switch. `Presence` becomes:
  - `'always'`;
  - `'value'` (the value is the presence column);
  - `{tag: Expr}`;
  - `'unknown'`.

  Element hosts stay on `id IS NOT NULL`, which is already exact.

- **P8 NaN rides the tag (after P7)** — a numeric tag (`'double'`/`'float'`) with a NULL value is NaN, a pair
  that is unreachable once nulls are tagged `'null'`. JSON nodes get `{"t":"double","v":null}`. End to end:
  - **Literals and parameters:** lift the decline (`ir/uncarried-literal.ts`, the `const.ts` NaN fold).
  - **Storage:** a stored NaN is `(value NULL, vtype 'double')`, with no schema change (`value` is
    nullable). Every property read uses the tag or row existence for presence, never `value IS NOT NULL`
    (P6 makes that true).
  - **Framing and wire:** `execute.ts` frames it as a GraphBinary double NaN. The GraphSON and CSV
    formats, federation and replication all round-trip it.
  - **Predicates:** null tests become `tag = 'null'`. Comparisons follow the reference's NaN rules
    (`Comparability.feature`).
  - **Reducers:** `sum`/`mean`/`min`/`max` propagate NaN (`NumberHelper`), via a per-reducer "any NaN"
    term spent only where a NaN can occur.
  - **Ordering:** NaN sorts above +∞ among numbers (`orderability.ts`).
  - **Keys:** dedup, group and set keys keep NaN distinct from null.
  - **`math()`:** `0/0` and friends yield NaN where the reference does, instead of raising.

  This lifts the 6 `nan-literal` L3 scenarios. Delete their ledger reason
  (`test/L3-conformance/expected-outcomes.ts`) and the matrix NaN row.

- **P9 one read for value and tag (after P7)** — where a consumer needs both and they are two correlated
  subqueries today, read one packed jsonb instead. The study measured this 28% faster at 8k (V6 vs V1b),
  and it also recovers the second read that single-column consumers (window order keys, dedup partitions)
  would otherwise pay under P6. Measure on the common shapes before and after, and keep it only where it
  wins.

- **P10 a law, so the class cannot come back (after P6)** — an L5 property law: for a random body `b`, the
  child form agrees with the chain form. That means:
  - `map(b)` ≡ `b` per traverser;
  - `where(b)` keeps exactly the traversers for which `b` is productive;
  - `project('x').by(b)` holds key `x` exactly when `b` is productive, with `b`'s first value.

  This catches every future chain-vs-child presence inconsistency generically, rather than one witness at
  a time (`docs/property-based-testing-l5.md`).

## Cost discipline

- **The common shapes must not change.** The study measured six (`order().by(select('a'))`,
  `project('x').by('age')`, `map(values('age'))`, `where(out().count().is(gt(1)))`, `dedup().by('name')`,
  `project … coalesce`) and none carries a presence term today. A tag column is spent only where the body's
  type admits a productive null.
- **`sql-hygiene` may only go down** on the corpus. Any rise names the user-visible answer it buys (CLAUDE.md).
- **Scaling probe** at N≈1k and 8k on every step that touches a producer.

## Done when

- `PresentWhen` is gone.
- Every §5 wrong answer from the study matches the reference.
- The "A null `by()` value" §17 row and the NaN wall are deleted.
- The L5 law is green.
- Legacy stores migrate on open.
- No common shape got slower.
