# Federate mid-traversal injection — the mapValues redesign (LANDED, archived 2026-08-28)

**✅ LANDED AND ARCHIVED (2026-08-28).** Federate mid-traversal injection is now PURE standard Gremlin —
a value aliased before the barrier (`as('e')`) and read across it (`select('e')`), carried as a
`{parentId → parentValue}` map through a synthesized standard `inject($map).unfold().group().by(Column.keys)
.by(<sub>)` on the sibling. The bespoke `__.call("parent",<read>)` marker + minted-`origin` corrId substrate
are DELETED (0 references). 9 commits (`f6b2ed3e` as()/select() recognition · `2f1dd3e1` inject($map) grammar ·
`9fec4146` V()-in-group-value · `e2254b50` bound-map json_each · `82434fcc` the transport · `431dd693`
reduction subsumption · `5d92ccf6` delete marker/corrId), each CI-green local + remote. Every staged-build
item below shipped. The authority is now the CODE (`src/services/catalog/federate.ts`, `segment.ts`,
`lower/reduction.ts`'s `mapEntryChild`, `execute.ts`'s `runForeign`); this doc is the DESIGN RATIONALE.

The still-OPEN federate work (multi-graph mixing, side-effect boundary) and the durable reference
(reducer algebra, output transport, hard edges) stay in the live doc `docs/2026-08-26-federate-pushdown-design.md`.

---

## Injection — a `{parentId → parentValue}` map and a STANDARD `mapValues` on the sibling

_This section is the TARGET design (planned 2026-08-28). It SUPERSEDES the `parent`-marker + minted-`origin`
corrId substrate that shipped first — see "Where the marker substrate went" under Landed. The staged build
is at the end of this section._

A mid-traversal federate injects each parent traverser's value into the sibling, batches all parents into
ONE sibling hop, and scatters results back per parent. The load-bearing decision: **the batched injection
flows as STANDARD Gremlin + standard parameters, and the sibling compiles it with ZERO federate-awareness.**

The batched injection is a **`{parentId → parentValue}` map**, crossing as ONE ordinary bound parameter
(the parent set is DATA-scaled — one row per parent traverser, unbounded — so it MUST be one `json_each`
bind of any size, never N per-parent binds, which would breach the DO 100-bind wall; root `CLAUDE.md`'s
data-not-in-text rule). The sibling runs a STANDARD Gremlin `mapValues`:

    inject($map).unfold().group().by(Column.keys).by(<the user's per-parent sub-traversal over the entry value>)

transforming `{parentId → parentValue}` into `{parentId → result}`. **Correlation is the ordinary
`group().by(Column.keys)` KEY** — not a hidden channel — and it is correct for distinct parents that inject
EQUAL values, because two parents are two distinct KEYS whatever their values. The shape is legal,
GLV-portable Gremlin (`vendor/tinkerpop/gremlin-test/.../features/sideEffect/Group.feature:186-201`).

### User syntax — `as()` / `select()`, NOT a marker

The user marks the injection point with a standard **`as()` alias in the parent, `select()` in the
sibling** — a value bound before the barrier, read across it:

    g.V().hasLabel("person").values("email").as("e")
      .call("federate", ["graph":"amazon"])
      .V().has("email", select("e")).count()

Pure standard Gremlin with a federate call in the middle — instantly readable, nothing invented. It aligns
with machinery that ALREADY exists: `content-demand.ts:141`/`labelsBoundBefore` tracks exactly "a label
bound BEFORE the barrier, read across it" (`as('x') … call(federate) … where(eq('x'))`). The old
`__.call("parent", <read>)` marker was a bespoke reinvention of this, and is retired.

### Inbound — the returned map lands via the EXISTING BoundGraph; downstream stays polymorphic

`GraphSource`/`BoundGraph` (`src/compiler/rel/source.ts`, `boundgraph.ts`) exists so a foreign graph's
elements land as a temporary relation and downstream ops (`out()`/`values()`/`has()`) join across them
WITHOUT knowing they are foreign. The redesign preserves that — a hard requirement.

- The `t:'map'` FrameNode transport, framing `{t:'vertex'}`/`{t:'edge'}`/`{t:'list'}` values recursively at
  any depth, already exists (`src/execute.ts`'s `frameTypedNode`/`typedMapBuffer`, the `mapValue` arms in
  `runForeign`/`foreignValueNodes`). Reused unchanged.
- The returned map explodes DIRECTLY to `(parentId, element)` rows — ONE entry per parent already (no
  distinct-value dedup to undo), so FEWER hops than the corrId path: `foreignRelation` explode +
  `foreignRejoin` re-scatter (two hops) collapses to one map explode. `foreignRelation`
  (`src/compiler/rel/foreign.ts`, two callers) already carries a per-row correlation column via its `extra`
  param — parentId rides where corrId rode. Those rows feed a BoundGraph CTE as a source-form pool does.
- The inbound seam is the result-tag dispatch `resumed` (`src/compiler/rel/segment.ts`), NOT GraphSource —
  a new arm correlating each entry to its parent by the parentId KEY (an ordinary join replacing
  `foreignRejoin`'s hidden-corrId join).

**A subgraph is not a single value** (`subgraph()` is a top-level side-effect step, never a `by()`-value).
A neighbourhood-as-value is the idiomatic composite `project('vertices','edges').by(V-list.fold())
.by(E-list.fold())` — ordinary shapes, existing framing.

### The staged build — each stage CI-green and committed to trunk

The ordering is forced by the largest hidden dependency (Stage 1): the `mapValues` shape is grammatically
legal but does NOT lower in our engine today.

0. **Grammar enablement (`inject($map)`) + parser regen.** `inject()` takes `genericLiteralVarargs`
   (literals only; `Gremlin.g4:136,629`); loosen to `genericArgumentVarargs` (already includes `variable`)
   — a strict superset, standard clients unaffected, only OUR sibling query uses `inject($map)`. The parser
   is generated from `git show origin/master:Gremlin.g4` — a git blob, NOT the on-disk file
   (`scripts/generate-parser.sh:44`), so the `.g4` edit rides as a `patches/upstream/` patch `git apply`-ed
   to the exported temp `.g4` before antlr-ng (indexed + paired with an upstream PR). Front-end likely
   unchanged (`frontend.ts:581-590,642-646` already resolves a bound-Map `VariableContext`). Note the ONE
   carried grammar delta in root `CLAUDE.md` locked-decision #2.
1. **Make `group().by(Column.keys).by(<child over entry value>)` lower.** ⚠️ HIGHEST RISK — was a
   COMMITTED DEFERRAL (`map.ts`'s `groupRows` had no `Column`-token group key over an unfolded-map
   stream). **✅ MOSTLY LANDED (commit `0986f359`, 2026-08-28):** `Column.keys` is admitted as a `by()`
   projection resolving against an unfolded map entry, entry-value `by()` bodies route through the
   ordinary map-entry/list/scalar tail, and the entry host reaches `group()`/`groupCount()`. Verified:
   scalar (`by(select(Column.values).count(Scope.local))` → `{josh:2,marko:3,…}`), list-valued child,
   the re-group by `Column.keys`/`Column.values`. THE LOAD-BEARING SUBSTRATE THAT UNBLOCKED IT:
   **element-list map values now retain rowids** (`{kind:'list', of:{kind:'elem'}}`), so
   `select(Column.values).unfold()…out()` re-enters element traversal at ANY depth (see the top-level
   `map-value-element-reentry.feature` oracle), and `dedup()` in a group value-fold scopes per group key.
   **Nested-re-group element value ✅ LANDED (commit `ecff2eb9`):** an element-list value that becomes a
   Map.Entry value and is re-read in `…unfold().group().by(Column.keys).by(<...>)` now expands correctly —
   the token `by(Column.values)`, the bare `by(select(Column.values))`, and the deep
   `by(select(Column.values).unfold().unfold().values('name').fold())` all frame vertex nodes / re-enter
   the element loop (was a rowid-leak + null before).

   **✅ ALL FIVE RESULT SHAPES now lower as a group value-by (commit `6c61756f`):** scalar (count), list
   (fold), element-list (`out().fold()`), MAP (`project`/`valueMap`/`elementMap` — valueMap/elementMap
   added last, framing a bare correlated map per traverser, `Grouping.java:92-101` confirms no fold
   injection for a valueMap step traversal), and composite (`project('vs','es')`). **The five-shape
   isolation gate for Stage 3 is MET** — the group-value-shape substrate is complete. Remaining Stage-1
   work is now only the sibling-synthesis stages (2 inbound map reception, 3 outbound synthesis), which
   consume this substrate rather than extending it.
2. **Inbound per-parent-map reception (dormant behind the old path).** A `foreignRelation` variant
   consuming the `{parentId → [elements]}` map via two-level `json_each` → `(parentId, element)` rows, and a
   new `resumed` arm landing them into a BoundGraph CTE by the parentId KEY, reusing the existing
   landing/subgraph/id-carry.
3. **Outbound synthesis (first end-to-end).** `federate.ts` builds the `{parentId → parentValue}` map and
   synthesizes the `mapValues` query; `midSegment` still projects the parent's read (via the `as()` alias)
   to build the map, rewriting the parent's `as("e")` reference to `select("e")` in the synthesized `by()`.
4. **Reduction-pushdown subsumption.** A per-parent reduction becomes `group().by(Column.keys)
   .by(<sub>.count())` — but NOT fully (see "Reducer algebra"): the monoid `count`-over-empty→0 for a
   parent that matched nothing (no group key) still needs a per-parentId LEFT-JOIN completion. Keep a
   slimmed parentId-keyed empty-completion.
5. **Delete the old substrate** (only after 3–4 green): the reserved key, the marker + its recognizers, the
   `if(marker)` sibling block, `ctx.injectionCell` + the two resolver hooks, the `origin`→corrId
   projection, `foreignRejoin`'s injected arm, `groupBarrierByOrigin`, `InjectionKind`/`injectionTraversal`/
   the reduction-pushdown flags. `bash scripts/ci.sh` (orphans/refs/arch) is the correctness check.

