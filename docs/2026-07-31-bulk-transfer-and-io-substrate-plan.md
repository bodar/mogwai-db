# Bulk transfer + the `io()` substrate — one primitive under five threads

**Status: research + build plan.** Origin: five separately-filed threads that turned out to be one
missing primitive — the L3 `io()` exclusion, an R2/filesystem write side, import/export formats,
the federated-call transfer format, and slow conformance seeding. Written after measuring, so the
numbers below are this repo's, not a vendor's.

> **The finding that reorders everything: Cloudflare DO SQLite allows a maximum of 100 BOUND
> PARAMETERS PER QUERY** ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
> That is not a footnote for a future bulk path — **two shipped code paths already breach it**, and
> it is also the constraint that fixes the shape of every thread here. Read §2 before §3.

---

## 1. The measurements

All on this tree, Bun 1.3.11 / SQLite 3.51.2, grateful-dead (808 v / 8,049 e / 9,023 property rows)
unless stated. Scripts were throwaway; the numbers are reproducible from the recipes described.

### 1a. What seeding actually costs, and where

| | |
|---|---|
| `ggrateful` seed today (8,857 write traversals) | **5,918 ms** |
| SQL statements issued | **98,198** = 11.1 per element |
| Time actually spent *inside* SQLite | **951 ms — 17%** |
| Time spent in `parseGremlin` | 846 ms — 17% |

**The write path is not SQLite-bound. 83% of it is JS per-element round-tripping.** The statement
census says exactly what of:

| count | statement | why it exists |
|---|---|---|
| 16,098 | `WITH c0(id,bulk) AS (SELECT id … FROM nodes …)` | **a whole read plan compiled + run per edge ENDPOINT** (2 × 8,049) |
| 16,098 | `SELECT COALESCE(uid,id) … WHERE id=?` | `nodeExtId` — framing the write RESPONSE |
| 8,936 | `INSERT INTO property_fts…` | one statement per FTS row |
| 8,857 | `INSERT INTO labels(name) … ON CONFLICT` | label interning, **not memoized across elements** |
| 8,857 | `SELECT key, CASE WHEN vtype IN ('list','map','set')…` | reading properties back to echo them |
| 8,049 | `SELECT 1 AS found FROM edges WHERE id=?` | `assertAvailableElementId` |
| 1,976 | `DELETE FROM vertex_properties WHERE node=? AND key=?` | the single-cardinality overwrite check |

So a bulk path does not win by "multi-row INSERT". It wins by **not compiling a traversal per
element, not framing a response, and not reading back what it just wrote.**

### 1b. The ceiling, measured — and it is DO-legal

Same file, same process, landed through the ordinary `GraphStore.query` seam in fixed-shape batches
of **≤ 100 bound parameters** (so every statement is legal on Cloudflare):

```
today   (8,857 write traversals) : 5918 ms   98,198 statements
batched (max 100 binds/statement):  143 ms    1,364 statements
                                   ─────────  41×
```

Identical row counts in `nodes`/`edges`/`vertex_properties`/`edge_properties`.

**Two things this measurement settles that intuition gets backwards:**

- **The 100-bind cap costs nothing.** Compared against inlining literals to dodge it — 1,000 rows
  per `INSERT` at 37 KB of SQL text, comfortably under DO's 100 KB statement cap — the bind-bounded
  form is **4.6× FASTER** (38 ms vs 176 ms for 20,000 rows). A fixed-shape statement hits the
  prepared-statement cache (`bun:sqlite`'s `db.query` caches by SQL text; DO caches too); a big
  inlined statement is a fresh parse every time and evicts the cache. **So there is no reason to
  inline, and no reason for a runtime-divergent fast path.** One chunked loader is both the portable
  answer and the fast one.
- **The batch size falls out of the cap, not out of tuning.** `floor(100 / columns)` — 20 rows for a
  5-column property row, 25 for a 4-column edge. That is the whole policy.

### 1c. The `VALUES`-CTE transfer breaks on DO at 25 rows

`landForeignElements` (`steps/tail/foreign.ts`) lands each federated result row as a `VALUES` row
built from `value(…)`, and `value` is a real bind (`q.ts` re-exports lazyrecords' `Value`;
`ordinalPlaceholder` renders `?`). Rendered and counted:

| foreign vertex rows | bound parameters | DO |
|---|---|---|
| 5 | 20 | ok |
| **25** | **100** | **the ceiling** |
| 40 | 160 | ✗ |
| 100 | 400 | ✗ |

**A federated call returning more than 25 vertices cannot execute on Cloudflare.** No test covers
it: `test/federation.test.ts` asserts `fed.length > 0` and `=== 1`, and the whole suite runs on Bun,
where `SQLITE_MAX_VARIABLE_NUMBER` is 65,535.

Probed the boundary for the worse failure mode: at exactly 65,536 binds `bun:sqlite` **throws**
("expected 0 values, received 65536" — the index wraps mod 2^16) rather than silently mis-binding.
Good: the Bun-side wall is loud. It is the DO-side wall at 100 that is silent, because nothing runs
there.

### 1d. `g.V().drop()` is the second breach, and it is worse

`compileDrop`'s `run` (`steps/write/write.ts:165-186`) snapshots the target ids and then binds one
`?` per id — twice, for `src IN (…) OR tgt IN (…)`:

- `DELETE FROM edges WHERE src IN (ph) OR tgt IN (ph)` binds `[...ids, ...ids]` → **fails on DO past
  50 vertices**.
- `deleteFtsForOwners(store,'edge',incidentEdges)` (`services/fts-index.ts:95`) binds one per
  incident edge → **fails past 99 edges**.

On grateful-dead, `g.V().drop()` would emit **16,098 binds in one statement**. The conformance
runner cleans graphs with `g.V().drop()` between scenarios — on Bun, forever, so this has never
been seen.

`jsonbArrayOf` (`plan/plan.ts:154`) is the third exposure: it backs `within(collection)` **and the
federated bind-join's `INJECT_VALUES_KEY` distinct set**, so a bind-join pushing more than 100
distinct keys — precisely the optimization the federation prior-art calls "the hinge between a demo
and something you'd run" — fails on DO. `hasLabel`'s `values(names)` (`plan.ts:38`) and `V(id…)` are
bounded by the user's query text, so they are fine.

### 1e. The id-width question, measured

50,000 vertices / 500,000 edges, same schema and same `(src,label,tgt)`/`(tgt,label,src)` covering
indexes, 3-hop `out()` over a 500-vertex frontier (5 runs, warmed):

| primary key | load | db size | 3-hop |
|---|---|---|---|
| **`INTEGER` sequential (today)** | **1,994 ms** | **30.5 MB** | **41.4 ms** |
| `INTEGER`, snowflake (`ms<<20 \| ctr`, monotonic) | 3,137 ms (1.6×) | 59.4 MB (1.9×) | 45.6 ms (1.1×) |
| `INTEGER`, random 52-bit | 10,503 ms (5.3×) | 60.5 MB (2.0×) | 115.3 ms (2.8×) |
| `BLOB(16)` `WITHOUT ROWID` | 12,771 ms (6.4×) | 105.8 MB (3.5×) | 151.4 ms (3.7×) |
| `TEXT` uuid `WITHOUT ROWID` | 22,327 ms (11.2×) | 220.7 MB (7.2×) | 207.3 ms (5.0×) |

**It is randomness that costs, not width.** A monotonic wide integer is nearly free on the read hot
path (1.1×) and only 1.6× on load; a *random* one costs 2.8× on the hot path because it destroys
B-tree insert locality and thrashes the page cache. A UUID `TEXT` PK costs 5× on traversal and 7× on
disk. §7 uses this to answer the question rather than to dismiss it.

---

## 2. The primitive

Five threads, one missing thing:

| thread | what it needs |
|---|---|
| bulk import (Neptune/Neo4j CSV, GraphSON, GraphML) | land N rows into this graph's tables |
| `io(…).read()` — 6 L3 scenarios, deliberately in scope | land N rows, from bytes the server resolves |
| federated `call()` returning a large result | land N rows in a relation (§1c breaks today) |
| conformance + L3 seeding (5.9 s → 0.14 s) | land N rows |
| `io(…).write()` / export / our→our replication | the inverse: **drain** rows to bytes |

So the deliverable is not a format. It is:

> **`RowBatch` — a bind-bounded, chunked, runtime-uniform way to land rows into (and drain rows out
> of) one graph's SQLite, sitting directly on the existing `Sql` seam.**

Formats are then *adapters over it*, and every one of them is additive. The invariants:

1. **No statement exceeds 100 bound parameters.** Chunk at `floor(100 / columns)`, fixed shape so
   the prepared statement is reused, one ragged tail statement. §1b says this is also the fast
   choice, so the invariant costs nothing.
2. **Runtime-uniform.** No `ATTACH` (dead on CF, already recorded), no literal inlining, no
   `:memory:` second database, no Bun-only branch. The same statements run on both.
3. **It reuses the write path's semantics, never reimplements them.** In particular the FTS indexer
   must be the *existing* `ftsRowsFor` walk, not a re-derivation — my probe's simplified version
   produced 9,023 rows where the real path produces 8,936, because it skipped empty-text rows and
   the nested collection walk. **A bulk loader that writes its own FTS rows is a silent index
   divergence.** The refactor is: extract row *construction* from row *insertion* in
   `indexProperty`, and let both paths share the construction.
4. **The loader mints property ids.** Landing `vertex_properties` and `property_fts` in one pass
   needs `pid` before insert, and multi-row `RETURNING` has no defined row order. So the loader
   allocates from `SELECT max(id)` — one query per table, not per row. (This is the only place the
   id question actually bites, and §7 shows it does not need wide ids to answer it.)

### The gate that stops this class of defect recurring

`mise run arch` and `mise run lint` are both at zero and both fail the build rather than ratchet.
Add a third in the same mould — **`mise run binds`**: statically reject a bind list whose length is
a function of row count outside `RowBatch`. It is the gate that would have caught §1c and §1d, and
without it §1e-style walls come back the next time someone writes `ids.map(() => '?')`.

The complement is a **CF-parity harness** (outstanding-work item 11, filed *Low-Med*): a `Sql`
decorator that throws when a statement carries > 100 binds or exceeds 100 KB, wrapped around the
Bun store for one suite run. That is a ~20-line instrument that converts every DO-only wall into a
Bun-visible failure, and it is the highest-value item in this whole plan — it re-prices item 11
upward on its own.

---

## 3. The `IoStore` seam — R2 on Cloudflare, the filesystem on Bun

`io("data/tinkerpop-modern.json").read()` names a path the **server** resolves; the corpus ships no
such file (checked — `features/data/` holds only `.feature` files; the actual fixtures live under
`structure/io/{graphson,graphml,gryo}/`). The reference provider resolves it from its own working
directory. So we get to define the namespace, and the user's instinct is right: this is a second
storage seam, exactly parallel to `Sql`.

```
interface IoStore {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

- **Bun** → the local filesystem, rooted at one configured directory (rooted, so a path cannot
  escape it).
- **Cloudflare** → an **R2 bucket binding**. Confirmed: bindings are available as a property on a
  `DurableObject`, so `this.env.BUCKET.get(key)` works inside the DO exactly as in a Worker
  ([Use R2 from Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/),
  [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)). R2 is an object
  store, not a filesystem — `get`/`put`/`list`/`delete`, all async, `ReadableStream` bodies,
  multipart for large objects. That is a strictly better fit than a filesystem for whole-graph
  dumps, and it makes `io().write()` — currently written off in `outstanding-work.md:395` as
  *"needs a filesystem a DO does not have"* — **available**. That line is wrong and this plan
  retires it.
- **The L3 host** → maps `data/` onto the submodule's `structure/io/*` resource directories, which
  is what makes the 6 `Read.feature` scenarios adjudicable at all.
- **Binding absent** → `io()` fails closed with a message naming the missing binding. Never a
  silent no-op; R2 is optional infrastructure and its absence is a configuration fact, not a
  capability gap.

**`io()` is a barrier service, not new machinery.** It is async (R2 is async), it collects, and it
lowers to nothing at compile time — which is the exact shape of `Contribution` `{kind:'barrier'}`
that `mogwai.graph.federate` already occupies, run by the executor's one `await` in the segment
loop. So `io()` desugars to a `call()` on an internal service and inherits the whole async seam.
The alternative — teaching the compiler a second async step kind — is the thing to avoid.

One honest consequence: `io()` in the *source* position means a traversal that today compiles to
one synchronous statement becomes async. `framed`/`buffers` already throw a clear "use the async
path" error for a federated traversal; `io()` joins that set. No new failure mode.

---

## 4. Formats — which, in what order, and the two genuine walls

`RowBatch` is format-free. Each format is a reader (bytes → row batches) and/or a writer (rows →
bytes). Ranked by ratio of capability unlocked to work:

| format | direction | unlocks | verdict |
|---|---|---|---|
| **GraphSON v3 adjacency (`.json`)** | read + write | 2 of 6 `io()` scenarios; **replaces `seed-graphson.ts` and the 5.9 s seed**; our own dump format for free | **first.** The reader already exists as `test/fixtures/seed-graphson.ts` — promote it from a test fixture to a real reader that emits row batches instead of Gremlin strings |
| **Neptune/Neo4j CSV-with-typed-headers** | read + write | the interop story (`~id`,`~label`,`prop:type` / `:ID`,`:LABEL`,`:START_ID`) | **second.** Cross-vendor de-facto standard, no deps, and the format the earlier analysis already converged on |
| **our compact typed dump** | read + write | our→our replication/backup, and the whole-graph R2 dump | **third**, and it is nearly free — same producer as CSV, shared header, `vtype` per column not per cell |
| **GraphML (`.xml`)** | read (+ write) | 2 of 6 `io()` scenarios | **fourth, scope with care.** Workers has no `DOMParser`; `HTMLRewriter` is an HTML streaming transformer, not an XML DOM. So this needs a hand-rolled pull parser. GraphML is a regular enough subset that ~150 lines is realistic, but it is the only format here that is *new code rather than new plumbing* |
| **Gryo / `.kryo`** | — | 2 of 6 `io()` scenarios | **a genuine wall.** JVM serialization; not reimplementable without a dependency, and no dependency exists. Fail closed naming the format |

**So the honest `io()` scope is 4 of 6 scenarios, not 6** — and the `tags.ts` note should say so, in
its own three-kind vocabulary: `.json`/`.xml` are *NOT YET*, `.kryo` is *WE REFUSE* (a platform
wall, like the regex UDFs). The two kryo scenarios should never be counted as a gap in our engine.

**Not a bulk format, and this stays decided:** GraphBinary. It is a row-oriented, per-value
self-describing *wire* protocol — every cell carries `type_code+type_info+value_flag`, no shared
schema, no cursor streaming on DO. It is right at the client edge and wrong everywhere else. The
internal cross-DO hop already avoids it (JS RPC structured-clones `ForeignRow[]`), which is correct
and unchanged. Likewise **Apache GraphAr** stays a cited north star, not a dependency.

---

## 5. What changes for federation

Almost nothing structural, and that is the point — the detached-reference merge was the right call
and this plan does not reopen it.

- `landForeignElements` stops building one `VALUES` CTE and lands through `RowBatch` into a
  **scratch relation**, chunked. That is a mechanical change at one call site and it removes the
  §1c wall. Measured for reference: 40,000 rows into a scratch table via chunked multi-row inserts
  is 23 ms.
- `jsonbArrayOf`'s bind-join set gets the same treatment, which is what makes the bind-join
  pushdown usable at real cardinality rather than at 25 keys.
- **A scratch relation is an ordinary `CREATE TABLE`**, not a SQLite `TEMP`/`:memory:` table — we
  already create our whole schema through `Sql.exec` on both runtimes, so an ordinary table needs no
  new capability, whereas DO `TEMP` support is unverified and DO storage is the DO's own SQLite with
  no second database to attach. This is the direct answer to *"is there a way to do an in-memory
  table for federated calls?"*: **yes, and we already ship it** — the `VALUES` CTE is that
  mechanism, it simply needs to be chunked. Which means the id question's stated precondition
  ("only if there is no way of doing it in memory") is not met.
- Unchanged and still correct: no cross-graph edge traversal (graph-local identity — a category
  error, not a gap), no cross-DO transaction, no cost-based planning, no `ATTACH`.
- **What federation gains that it did not have:** *materializing* a foreign subgraph locally. The
  prior-art addendum called this out as the one thing needing bulk-write machinery — "only that
  persist path needs the bulk-write machinery below". This plan builds exactly that machinery, so
  `call(federate,…)` followed by a local persist becomes reachable. Its blocker is then §7's
  id-remapping question, not a missing loader.

---

## 6. What changes for the test suite

- `startConformanceServer` seeds via readers over `RowBatch` instead of 8,857 write traversals.
  Measured 5,918 ms → 143 ms for `ggrateful` alone. That also removes the `beforeAll` timing cliff
  the current header documents (within ~20 ms of bun's 5,000 ms hook default, flaking "about half
  the time"), which the named-graphs workaround currently papers over.
- **The seed must stay verifiable, and this is the one real risk of the change.** Today's seed is
  self-validating: it goes through the same `parse → compile → execute` path a client uses, so a
  broken write path cannot produce a correct fixture. A bulk loader bypasses that. So: keep
  `MODERN_SEED`-through-the-query-path as the *reference*, and gate the loader with an equivalence
  test — **load the modern graph both ways, assert byte-identical table contents including
  `property_fts`.** That test is what makes invariant 3 (§2) enforced rather than aspirational, and
  it is cheap because modern is 6 vertices.
- The census's five gates already cover "did an executing traversal change its answer", so a
  seeding change that altered a fixture would be caught — provided the loader lands *identical*
  rows, which the equivalence test is there to prove.

---

## 7. The id question — answered, and the answer is no, for a reason worth recording

The proposal: move primary ids from rowids to UUIDs or 128-bit numbers, so collisions become
negligible and a cross-graph load is a blind copy. Four findings, in the order that settles it:

1. **The stated precondition is not met.** It was conditioned on there being no in-memory-relation
   route for federated calls. There is one, it ships, and §5 shows it needs chunking rather than
   replacing.

2. **The identity slot already exists and is already faced.** `nodes.uid TEXT UNIQUE` /
   `edges.uid TEXT UNIQUE` are the TinkerPop user-supplied id, elements report `COALESCE(uid, id)`,
   and `V(uid)` resolves through the UNIQUE index. **A graph that wants globally-unique ids can
   already have them today, at zero schema cost**, and `guid` in the conformance host proves the
   read path frames them. Putting global identity in the *rowid* buys nothing that `uid` does not
   already give, and costs §1e's 1.9–7.2× storage.

3. **128-bit is not merely expensive, it is structurally impossible in our stack.** Two independent
   ceilings: a SQLite rowid is a signed 64-bit integer (max 9,223,372,036,854,775,807), and
   `coerceBindValue` (`gremlin/types.ts:199`) converts a `bigint` above 2^53 to **decimal TEXT** so
   it binds losslessly on a DO that throws on `bigint`. So our own bind seam is exact only to 2^53 —
   an id wider than that cannot round-trip as an integer through the one seam both runtimes cross.
   And 53 bits is not "so unlikely": by the birthday bound a random 52-bit id collides with
   probability ≈ 1.1% at 10^7 elements (≈ 1 in 9,000 at 10^6). Reaching 10^-12 at 10^7 elements
   needs ~86 bits — above the rowid ceiling, let alone the bind ceiling. **The collision argument
   fails at the width we can actually represent.**

4. **If it were ever needed, the answer would be monotonic, never random.** §1e is the useful part
   of this thread: a snowflake-style monotonic wide integer costs 1.1× on the traversal hot path
   where a random one costs 2.8×, because the whole covering-index story is B-tree locality. Anyone
   revisiting this should reach for monotonic-wide and should not reach for UUIDs at all — the
   `TEXT` uuid PK is 5× on traversal and 7× on disk.

**What the cross-graph-load problem actually needs** — and it is much smaller than a schema change:
a **remap pass** in the loader. `labels.id` and `nodes.id`/`edges.id` are local rowids with no
cross-graph meaning, so a load into a non-empty target re-interns labels (already a one-line
memoized `labelId`) and offsets/remaps element ids from `SELECT max(id)`, keeping the source id in
`uid` when the caller wants source identity preserved. One pass, two queries, no schema change, and
it composes with §5's federated materialize.

**So: do not widen the primary key.** Recorded here with the measurements so it does not have to be
re-derived — and note that the reasoning is *not* "this is a database change and we have users". We
have no users and the change would be legitimate; it is simply the wrong trade on its own numbers.

---

## 8. Build order

Each phase lands green and is useful alone.

| # | deliverable | gate |
|---|---|---|
| **0** | **CF-parity `Sql` decorator** (throws > 100 binds / > 100 KB) + one suite run under it | the two §1c/§1d walls reproduce **on Bun**, as failures |
| **1** | `RowBatch` load/drain on the `Sql` seam; FTS row *construction* extracted from `indexProperty` | modern graph loads batched ≡ loads via write traversals, byte-identical incl. `property_fts` |
| **2** | Fix §1d (`drop`) and §1c (`landForeignElements`, `jsonbArrayOf`) through `RowBatch` | phase 0's harness goes green; `g.V().drop()` on grateful-dead passes under it |
| **3** | `mise run binds` static gate | at zero, fails the build (not a ratchet) |
| **4** | GraphSON reader/writer over `RowBatch`; conformance host seeds through it | L3 count unchanged; seed ≤ 0.5 s; census unchanged |
| **5** | `IoStore` (Bun FS / CF R2 / L3 host mapping) + `io()` as a barrier service | 4 of the 6 `Read.feature` scenarios pass; `.kryo` fails closed naming the format; `tags.ts` reclassified |
| **6** | Neptune/Neo4j CSV reader/writer; `io().write()` to R2 | round-trip: export a graph, load into an empty graph, compare |
| **7** | remap pass (non-empty target, label re-interning, `uid` preservation) | load-into-non-empty round-trip |
| — | GraphML pull parser; federated *materialize* | scope after 5–7 land |

Phases 0–3 are the ones that fix live defects. Phases 4–7 are the capability. **If only part of this
gets built, build 0–3** — they are small, they are gates, and they close two wrong-answer walls on
the production runtime.

---

## 9. Parked, with its connection stated

**The `write.ts` interleaved read/write item** (`outstanding-work.md`: *"`run` interleaves reads with
INSERTs and reads back what it wrote, so a set-based form must decide match-vs-create for the whole
driver set before writing"*) — the instinct to park it is right, but it is not unrelated, and the
relationship decides a scoping choice here:

- **Append-into-empty sidesteps it entirely.** No match-vs-create decision exists, so phases 1–6
  never touch it. That is why phase 7 (non-empty target) is last.
- **A merge/upsert bulk mode inherits it exactly.** "Decide match-vs-create for the whole batch
  before writing" *is* the interleaving item, restated for a batch. So a bulk loader with upsert
  semantics is not a separate feature — it is that item's set-based form, and building it would
  resolve the item rather than work around it.

Conclusion: park it, scope bulk v1 as **append-only**, and note that whoever picks up the
interleaving item should build it as `RowBatch`'s upsert mode rather than as a fix inside the
per-element `run`.

---

## 10. Deliberately out of scope

- **Cross-graph edge traversal** — graph-local identity; a category error, unchanged.
- **A wider primary key** — §7, refuted on measurement.
- **`ATTACH` / raw SQLite file dumps** — dead on CF, already recorded; not revived by a bulk path.
- **GraphBinary as a bulk format** — §4; it stays the client wire only.
- **A new dependency for CSV, XML, or Parquet/Arrow** — the no-new-dependencies lock holds. GraphAr
  stays a cited north star.
- **Gryo/`.kryo`** — a platform wall, fails closed.
- **Cross-DO transactions / snapshot consistency** across a load — best-effort, as federation
  already is.

---

## 11. Corrections this plan makes to existing docs

Recorded so they get swept rather than rediscovered:

- **`outstanding-work.md:395`** — *"`io().write()`, which needs a filesystem a DO does not have"* is
  **wrong**: R2 bindings are reachable from inside a DO, and an object store is a better fit than a
  filesystem for a whole-graph dump. The `io()` source/sink asymmetry in that line dissolves.
- **`outstanding-work.md:298` (item 11)** — "CF-parity test on the DO harness *(Low-Med)*" is
  mispriced. It is the gate that catches §1c and §1d, both live wrong-answer/hard-failure walls on
  the production runtime. It is phase 0 here.
- **`storage.ts:13-14`** — *"DO `ctx.storage.sql.exec` runs a single statement, so we never rely on
  multi-statement exec"*: the DO docs now state multiple semicolon-separated statements **are**
  supported. The one-statement-per-entry `SCHEMA` array is still the right shape (it is clearer and
  costs nothing), but the stated *reason* is stale. Not worth a behaviour change; worth not citing
  as a constraint.
- **`feature-support-matrix.md`** already over-promises "no form is known to mis-execute"
  (a known debt). §1c/§1d add two DO-only entries to whatever replaces that claim — and they are
  the first entries that are runtime-specific, which the matrix has no column for.
