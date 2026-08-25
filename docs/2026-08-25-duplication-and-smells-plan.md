# Duplication & architectural-smell consolidation — plan

> **Status: NOT STARTED — audit + plan (2026-08-25).** A whole-`src/` sweep for large-scale
> duplication (syntactic and semantic) and architectural smells. Nothing here is a bug; every item is a
> behaviour-preserving consolidation, and almost all of them have a working precedent already in-repo.
> This is a menu, sequenced by risk, not a commitment — pick items when a file is open for other reasons.

## The one finding behind most of the others

The codebase is **disciplined** about duplication. Exact copy-paste is rare (a whole-tree normalized
6-line-block scan finds only the OLAP catalog and `reverse.ts`↔`split.ts` as cross-file exact clones),
the shared-helper leaves exist and mostly work (`src/compiler/rel/build.ts`,
`src/services/catalog/olap/kernel.ts`, `src/compiler/rel/modulator.ts`, `src/formats/drain.ts`), and a
lot of apparent twinning is deliberate and documented — the two `GraphSource` implementations
(`src/compiler/rel/source.ts:13`), the totality `Record<RelKind,…>` tables across
walk/emit/check/block, the `bindCount`-vs-`renderStep` two-authority split, GraphQL emitting a Gremlin
*string* into the one tested front-end (`src/graphql/translate.ts:14`), the Bun↔Cloudflare runtime
seams. Those are NOT smells and must not be "fixed".

The real debt is one recurring shape:

> **A shared helper was extracted for its first caller, and the siblings — often in the same file or
> directory — still hand-roll the same thing.** The fix usually already exists as a precedent a few
> lines away, which is exactly why these are low-risk.

So the work is mostly *finishing* factorings the code already began, and aligning files with design
intent their own comments already state.

## Findings, by theme

### Theme A — `src/compiler/rel/lower.ts` (7,978 lines), the largest concentration

The file's own comments assert the goal "one lowering at both hosts / a shape works wherever it is
legal" (§6·6), but only partially realize it. The coarse dispatch is fine — intentionally
shape-sensitive and already `Set`-driven (`PER_TRAVERSER_HOSTS`, `BRANCH_HOSTS`, …); **do not
table-drive it.** The duplication is in the arm *bodies*.

- **A1 [HIGH] — parallel folds copy-paste shared step arms.** `scalarTail` (`lower.ts:2508`) and
  `elementTail` (`lower.ts:4851`) handle 19 identical step names. The `cap` arm is **byte-identical**
  (`lower.ts:3066-3093` ≡ `lower.ts:5073-5100`, comments included — verified). `group`/`groupCount`
  (`lower.ts:2651` vs `5008`), `fold`, `aggregate`, the write family (`addV/addE/mergeV/mergeE`),
  `path`/`simplePath`/`cyclicPath`, `sack`, `select`, `project` differ *only* in how the `ChildHost` /
  framing is built (`host` vs `elementHost(rel, elem, labels)`) — the abstraction seam already used
  everywhere else in the file. `detachedTail` (`lower.ts:4694`) re-implements `terminal`'s
  `id`/`label`/`values`/`labels`/`count`/`dedup` arms; the `labels()` two-key renumber is spelled 3×
  (`lower.ts:2183`, `4816`).
  → Extract shape-agnostic handlers keyed off a `ChildHost` + framing pair that both folds consult
  before their shape-specific arms; parameterize `terminal()` by source so `detachedTail` folds in.

- **A2 [HIGH] — "explode a collection column into a member stream" block ×6.** Identical
  explode+project+channel-carry+ordinal-passthrough shape at `list.ts:805`, `831`, `853`, `1462`,
  `1485` and `map.ts:1247`; the three-column member `typeOf(...)` triple recurs ~8× in `list.ts`. Only
  the payload column and its expression differ.
  → `explodeMembers(rel, column, as, payload, fresh)` in `build.ts`. Single largest concrete win in the
  step-family files. (`build.ts`'s `withPayload` covers only the "replace payload, keep channels" case;
  the unfold family needs *extra* passthrough columns, so widen the carry helper.)

- **A3 [MED] — god-file / separable subsystems.** ~8k lines, ~140 imported symbols, 8 exports, mixing
  the shape folds (the cohesive nucleus) with three self-contained satellites that already talk through
  narrow interfaces: the branch/merge cluster (`branchArms`…`mixedBranch`, `lower.ts:5860-6645`, ~800
  lines) → `branch.ts`; the child/reduction cluster (`scalarChild`…`flatMapRejoin`,
  `lower.ts:6916-7594`, ~600 lines) → `correlated.ts`; the filter cluster (`sourceFilter` `lower.ts:717`
  + `has*Clause` `lower.ts:896-972` + `movement`) → `filter.ts`. Lifting these cuts the core file ~half
  with no behaviour change. Also: `scalarTail` is a 674-line function whose reducer arm
  (`lower.ts:2943-3039`) is a self-contained `scalarReducer(...)` extraction.

- **A4 [MED] — "project one value column, carry channels through" idiom ×9** (`lower.ts:2132`, `2163`,
  `2241`, `2772`, `2804`, + detached variants); `constantRetype` (`lower.ts:1977`) and `sackRead`
  already encapsulate the move. → `projectScalar(input, expr, {tag, valueType, framing})`; removes the
  "forgot the `carriedCols` carry" bug class the comments at `lower.ts:2803`, `4906` document.

- **A5 [MED] — 6 resume entry points share prologue/epilogue** (`lowerToRel` `lower.ts:4203` +
  `lower*Resume`); `lowerValueResume`/`lowerListResume` are near-twins. → a `resume(seed, framing, …)`
  wrapper owning minter/settle/chainCtx/`lowered`.

### Theme B — the OLAP algorithm catalog (`src/services/catalog/olap/`)

The convergence loops are **already well-factored** via `kernel.ts` (`iterateInSql`, the delta scalars,
`adjacencyCte`, `syncBarrier`) — the classic "everyone reimplements the fixpoint" smell is solved. The
residue is structural scaffolding around the Service object.

- **B1 [HIGH] — decorate-barrier Service shell copy-pasted across 8 files** (`pagerank.ts:30`,
  `articlerank.ts:42`, `wcc.ts:37`, `peer-pressure.ts:22`, `hits.ts:41`, `betweenness.ts:32`,
  `kcore.ts:26`, `scc.ts:26`). The `{ name, type:'barrier', internal, describeParams, resolve →
  {kind:'barrier', residency:'do', decorate, ...syncBarrier(...)} }` shell is ~half of each ~65-line
  file; only the SQL core and channel spec are unique. **The fix already exists twice in the same
  directory** — `triangle.ts:28 oneShotDecorate` and `centrality.ts:47 distanceCentralityService`.
  → `decorateBarrier(spec)` in `kernel.ts`; the two local helpers become thin callers; `scc`/`triangle`
  /`node-similarity` (`round:0`) fall out as the trivial case. Estimated ~200 lines removed.

- **B2 [MED] — `propertyName` override parsed 3 ways across ~11 sites** (bare inline
  `typeof x==='string' && x.length>0 ? x : default`, a `~tinkerpop.<algo>.propertyName` namespaced key,
  and a private `componentKey()` helper), with no stated rule for which. → `stringParam(params, key,
  default)` folded into B1's factory; decide the namespaced-vs-bare key convention once.

- **B3 [MED] — `mode`-guard and empty-graph (`N===0`) short-circuit applied inconsistently.** Five
  barriers reject a non-`decorate` mode, five ignore it; `SELECT COUNT(*)` empty-guard is explicit in
  four and omitted in the rest, re-typing the same scalar ~7× (also `kernel.ts:202`). This is
  correctness-adjacent — only ~half the algorithms exercise the empty-graph path. → fold both into B1's
  factory; add `store.nodeCount()`.

- **B4 [MED] — two ~16-entry registry lists re-typed** (`standard.ts:50` `standardRegistry`,
  `standard.ts:59` `extendedRegistry` = the same list + 2). Adding an algorithm edits both arrays + an
  import + a name constant in `types.ts`. → compose a shared base list.

- **B5 [LOW] — `UND` undirected-adjacency CTE byte-identical** in `kcore.ts:22` and `triangle.ts:17`
  (doc comment included). → export from `kernel.ts` beside `adjacencyCte`.

### Theme C — "extracted for one caller" leftovers (the cleanest, lowest-risk wins)

- **C1 [HIGH] — `factory.ts` ↔ `check.ts` re-validate the same construction-time laws with identical
  error strings.** Every node reaching `check` was factory-minted, yet the `STRUCTURE` table
  re-asserts join width (`factory.ts:90` ≡ `check.ts:235` — verified), join ON presence, aggregate
  arity, values shape, project/recursive header laws — several with verbatim strings. A rule change
  edits one and silently leaves the other stale. **Highest silent-drift risk in the repo despite being
  small.** → make the factory the sole construction-time authority; reduce `STRUCTURE` to the
  scope/tree laws only a whole-tree pass can see (distinct `RelId`, left-join nullability, `Ref`↔binding
  agreement, `SelfRef`, `recursiveViolation`). Or extract shared predicates both call.

- **C2 [HIGH] — value-transform barrier builders near-identical ×3.** `buildReverseSegment`
  (`reverse.ts:47`), `buildSplitSegment` (`split.ts:67`) are the same function modulo transform +
  resume fn + error string (cross-file exact clone confirmed by the block scan); `buildRegexSegment`
  (`regex.ts:168`) shares the head-lower + `head.kind!=='read' || head.shape.kind!=='value'` guard.
  → `buildValueTransformSegment(steps, at, transform, resumeLowering, label)` (in `spine.ts` or a new
  `barrier-value.ts`) + a `valueHead(lowered)` helper (4 sites incl. `segment.ts:200`).

- **C3 [MED] — format drain writers re-derive the membership reads `drain.ts` exists to own.** The
  vertex-labels / vertex-properties / edge-properties owner-scoped reads are byte-identical between
  `csv.ts:451-484` and `graphson.ts:431-446` (differing only by the GraphSON `VALUE_AS_TEXT` wrapper),
  and `interface PropRow` is declared verbatim in both (`csv.ts:361`, `graphson.ts:367`). `drain.ts`'s
  own header warns of exactly this re-derivation-drift hole. → push `labelsForOwners` /
  `vertexPropsForOwners` / `edgePropsForOwners` + `PropRow` into `drain.ts`.

- **C4 [MED] — property side-table scan reimplemented ×4** (`modulator.ts:482`, `658`, `680`;
  `property.ts:347`) — the `scan(properties) → filter(owner, key)` relation, differing only in the final
  projection (`firstOf {value,vtype}` / vtype / `exists`). The module comments already flag these as
  "the same rows" read three ways. → `propertyRowFor(host, key, fresh)`.

- **C5 [MED] — `segment.ts` async segment shell + `path`/`pair` twin builders** (`segment.ts:231-359`):
  the 6-field async `SegmentPlan` object ×5, and `pathSegment`/`pairSegment` near-twins (same
  `Array.isArray(out)` guard + resume + not-supported error, differ only in resume fn + spec). →
  `barrierShell(...)`, `relationHandleSegment(...)`, `idHead(...)`.

- **C6 [MED] — `BaseGraph` never adopted the EXISTS-probe / side-scan helpers `boundGraph` did.**
  `boundgraph.ts:57` factored `rowById`/`existsOf`; the `BaseGraph` half of the same interface inlines
  the `project one=1 → {kind:'exists'}` probe 5× (`source.ts:354`, `366`, `380`, `389`, `508`) and the
  label scan/join ~5×. Asymmetric duplication a maintainer will accept fixing because the sister proves
  it clean. → give `BaseGraph` `existsOf` + `labelsScan`/`labelJoin`.

- **C7 [MED] — correlated single-column scalar reads ×5 in `element.ts`** (`element.ts:89`, `112`,
  `128`, `374`, `386`). `edgeEndpoint` (`112`) and `edgeColumn` (`374`) are literal duplicates. →
  `correlatedColumn(table, cols, rowid, proj, fresh)`; at minimum delete one of the endpoint/column pair.

- **C8 [MED] — identity-preserving nested-arg recursion hand-rolled ×3** in `strategies.ts` (`1142`,
  `1245`, `1666`): map chain → map args → `stepChain` → recurse → **return the original arg by
  reference when unchanged** (load-bearing for `traversal-param.ts`'s `tree.accept`). Error-prone; a 4th
  copy is a latent regression. → `mapNestedArgs(steps, params, perLevel, {preserveIdentity})`.

- **C9 [MED] — byte-identical repeat-region gathering loop** (`strategies.ts:1340` ≡ `1481`). →
  `gatherRepeatRegion(steps, i)`.

### Theme D — small shared utils (LOW, batchable)

- `sameColumns` byte-identical in `check.ts:66` and `recursive.ts:121`; `sameNames` in `check.ts:71`
  and `obligations.ts:24` (verified). → hoist to `rel/types.ts`.
- Per-`RelKind` "preserves vs extends columns" classification re-encoded 3× (`prune.ts:108`,
  `obligations.ts:66`, `check.ts:182`) — and the sets **differ subtly** (prune includes
  `window`/`explode`, check carves them out), which is the drift already happening. → one
  `preservesColumns(kind)` + `mintedColumns(node)`.
- `execute.ts` open-codes the GraphBinary MAP container prefix 5× (`139`, `181`, `319`, `581`, `587`);
  `listBuffer`/`setBuffer` (`execute.ts:239`/`249`) identical modulo one tag byte. → `sizedContainer`.
- `json_extract(e,'$.x')` helper redefined in 5 files (`list.ts:183`, `path.ts:100`, `map.ts:1289`,
  `property.ts:100`, `record.ts:265`). → `jsonField` beside `build.ts`'s `jsonOf`.
- `freeze`/`uniqueNames` duplicated (`factory.ts:9` / `stmt-factory.ts:7`); Expr composite builders
  (`and`/`or`/`eq`/`not`) missing from `expr.ts`, so `semijoin.ts:134` hand-rolls them + inline
  `{kind:'binary'}` literals. → shared `rel/util.ts`; extend `expr.ts`.
- `parseAnonBodyIR` shared by `kernel.ts:33 edgeScopeOf` and `shortest-path.ts:33 targetBody`.

## Checked and deliberately NOT flagged

The two `GraphSource` implementations (documented strategy pattern, `source.ts:13`); the
`Record<RelKind,…>` totality tables (walk/emit/check/block/obligations — each answers a distinct
question, totality is the design, `walk.ts:8`); `check.bindCount` (IR count) vs `emit.renderStep`
(rendered count) — two intentional authorities (`check.ts:73`); the `ir/step.ts` overlapping step-name
`Set`s (each encodes a load-bearing difference, merging forbidden by the file's own doctrine); GraphQL
/`gql` emitting Gremlin strings into the one front-end; the Bun↔Cloudflare manager/store/io seams;
`drive.ts`'s async/sync trampoline twins (function-coloring, hard to DRY without obscuring the hot
path); the `passes.ts` Pass registry (a registry with a `group()` constructor, not per-Pass
boilerplate; named functions required by the `arch-check` call-hierarchy gate). Re-auditing these is
wasted effort.

## Suggested sequencing

Risk-ascending; each is independently shippable and behaviour-preserving. `mise run ci` + the L1–L5
ladder is the safety net; validate before every push (`bash scripts/ci.sh` for the truthful verdict).

1. **C1** — smallest, highest silent-drift risk. Make the factory the construction-time authority.
2. **Theme B (B1+B2+B3 as one factory)** — self-contained, ~200 lines, template exists twice in-dir;
   closes the empty-graph/mode parity gap while there. Then B4, B5.
3. **Theme C leftovers** (C2, C3, C4, C6, C7, C8, C9) — clean helper extractions, sister proves each.
4. **Theme D** — batch the small utils in one pass.
5. **Theme A** — largest payoff, touch last and carefully: A1 (finish "one lowering at both hosts") →
   A2 (`explodeMembers`) → A3 (split `branch.ts`/`correlated.ts`/`filter.ts`). Hot path; lean on the
   conformance ladder.

Do not do all of this at once, and do not treat it as a rename campaign — each item is a real
extraction with a test surface. The value is finishing factorings the code already started; the risk is
turning a documented-deliberate twin into a wrong "fix", so re-read the "NOT flagged" list before
touching anything that looks parallel.
