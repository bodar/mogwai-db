# CLAUDE.md — mogwai-db

Context file for Claude (Code or otherwise) working on this repo. Read PLAN.md
after this; it has the phased roadmap and test strategy. This file is the
things that took a whole investigation to learn — do not re-derive them.

## What this is

A TinkerPop 4 Gremlin server compiled onto SQLite, targeting Cloudflare
Durable Objects. One DO = one isolated graph database, created on first
request via `idFromName`. Any TinkerPop 4 GLV in any language connects over
plain HTTP. Verified working against unmodified `gremlin@4.0.0-beta.2`:
11/11 e2e checks (test/e2e.ts), 2177/2177 official corpus parse rate.

The name: mogwai are what gremlins start as. A DO that becomes a Gremlin
server when you feed it. npm name `mogwai-db` (bare `mogwai` is squatted by
a dead 2013 OGM).

## Locked decisions — do not relitigate without strong cause

1. **TinkerPop 4, not 3.7.** v4 dropped bytecode entirely; the wire format is
   a canonical Gremlin string + parameters over HTTP. We parse it with a
   generator-produced parser, not a hand-written one.
2. **Parser is generated, never edited.** `parser/` comes from TinkerPop's
   canonical `gremlin-language/src/main/antlr4/Gremlin.g4` via antlr4ng
   (TypeScript target). The grammar has zero embedded Java actions, so it
   generates cleanly. Track upstream by regenerating. If you find yourself
   editing generated files, stop.
3. **Compile to SQL, never interpret.** Each read step appends a CTE; SQLite's
   planner + covering indexes do the traversal. Row-at-a-time JS interpretation
   is the failure mode this project exists to avoid.
4. **Reuse the client package's GraphBinary code.** `gremlin`'s
   `build/esm/structure/io/binary` ships ~30 bidirectional type serializers
   (Apache-2.0). We wrote only response framing. Don't write serializers.
5. **Own IR = the step chain** `{name, args}[]`. Grammar visitor is a thin
   front-end; compiler consumes the IR. If the wire format ever changes,
   only the front-end moves.
6. **Multi-tenancy: tenant in the URL.** `POST /g/{graphId}` → Worker does
   `env.GRAPH.idFromName(graphId)` → DO. Auth tokens scope to the path. The
   request's `g` field (traversal source name) optionally selects a named
   graph *within* a tenant — two-level hierarchy for free. Do NOT route on
   the `g` field at the Worker layer; it would force body-parsing before
   routing. TinkerPop has no data-plane create/drop-database API — DO
   on-first-access *is* the provisioning story; deletion is a management
   endpoint on the Worker, out-of-band, as it always was in TinkerPop.

## Hard-won wire-protocol facts (each cost debugging time)

- beta.2 sends **requests in GraphBinary** (`0x84 + map(fields,bare) +
  string(gremlin,bare)`); master moved to JSON. Sniff first byte 0x84,
  accept both. Parameter field is named `bindings` in binary requests.
- Response frame: `0x84, bulked(0x00), values..., 0xFD 0x00 0x00,
  status int (bare), nullable message (0x00+string bare | 0x01),
  nullable exception (same)`. Always HTTP 200; errors ride the status
  trailer and the client raises ResponseError with the message.
- `iterate()` appends a `.discard()` step. Strip trailing discard/none,
  execute, return no values.
- Grammar node classes encode step + overload: `TraversalMethod_limit_long`.
  Overload suffixes are **lowercase** — step name is the segment before the
  first underscore, not a regex on capitalization.
- The client's `VertexSerializer.serialize()` **hardcodes empty properties**
  (client never sends them). To materialize properties, write our own vertex
  framing from ioc primitives: `[DataType.VERTEX, 0x00] + any(id) +
  list([label], bare) + list(vertexProps, qualified)`. Its deserialize side
  reads them fine. This is the known blocker for valueMap/elementMap.
- DO SQLite has **no user-defined functions**: regex TextP and anything SQL
  can't express filters post-SQL in JS inside the DO.

## Schema (src/storage.ts) — rationale

Integer rowid PKs; interned labels (small hot indexes); props as JSON text
(move to JSONB when DO SQLite ≥ 3.45); covering edge indexes
`(src,label,tgt)` and `(tgt,label,src)` so out()/in() are index-only scans.
Property filters bind the key: `json_extract(props, '$.' || ?)` — never
splice keys into SQL. Hot properties get on-demand expression indexes via a
future management endpoint.

## Semantics traps — encode as tests before touching related steps

- Traversers are multisets: UNION ALL everywhere; only dedup() collapses.
- `both()` on a self-loop yields the vertex twice.
- `repeat()` without `until()` is legal and infinite — max-depth guard
  (default ~32), documented deviation.
- Element ids are integer rowids; don't invent string ids.

## Testing (the build discipline)

- L1: `conformance/corpus-test.ts` — 2,177 canonical traversals from the
  official Gherkin features; parse+chain must stay 100%. Its step-frequency
  output is the implementation priority order. Notable: `inject` is #4 in
  the corpus (test-data setup idiom) — implement early to unlock scenarios;
  `drop()` early too because the official runner cleans graphs with it.
- L3: TinkerPop's own cucumber runner (in the tinkerpop repo:
  `gremlin-js/gremlin-javascript`, `npm run features-graphbinary`) pointed at
  a live mogwai-db seeded with `conformance/seed-modern.ts` (canonical ids).
  Server URL is hardcoded to `localhost:45940/gremlin` in test/helper.js.
  Start with `--tags` for implemented steps; the passing count is THE
  conformance number; ratchet only upward.
- Every new step lands with: SQL snapshot tests, its cucumber tag enabled,
  corpus still 100%.

## Immediate next work (P1 in PLAN.md)

1. Custom vertex framing → property materialization → valueMap/elementMap.
2. drop(), order().by, range/skip, inject.
3. Stand up the L3 cucumber run; publish first score.
4. Then P2: the as()/select() column-threading compiler — the structural
   piece everything Medium-tier hangs off. Design carefully; it's where this
   project is won or lost.

## Environment notes

- Runtime is Bun (pinned in `mise.toml`), not Node. `bun run start` serves
  via `Bun.serve`; `bun test` runs the suite (`*.test.ts`). No tsx/esbuild —
  Bun runs TS natively.
- Dev storage shim is `bun:sqlite` (synchronous, matching DO SQLite
  semantics). The DO port swaps `src/storage.ts` internals to
  `ctx.storage.sql` and adds the Worker router; compiler/server logic is
  storage-agnostic. `src/server.ts` exports `startServer(port, dbPath)` and
  only listens under `import.meta.main`, so tests run it in-process.
- Bundle budget verified: parser + antlr4ng + serializers ≈ 1 MB minified;
  ATN warm-up ~few ms once per isolate; warm parse ~0.27 ms.
- Useful references live in the Apache TinkerPop repo (sparse-clone it):
  grammar at `gremlin-language/src/main/antlr4/`, features at
  `gremlin-test/src/main/resources/.../features/`, JS GLV + cucumber runner
  at `gremlin-js/gremlin-javascript/`, v4 migration rationale at
  `docs/src/upgrade/release-4.x.x.asciidoc`.
