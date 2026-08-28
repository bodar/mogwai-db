# Map support — the finishing plan (2026-08-28)

A systematic audit of MAP support in the current lowering, independent of federate. Every map producer and
consumer was tested against the live compiler over the modern graph; this doc catalogs what WORKS and
every gap that remains, so map support can be finished as one tracked body of work.

**Method:** each row below was run through `exec(store).framed(q)` (the Bun sync path) and decoded through
the real GraphBinary deserializer. "WORKS" = correct answer verified; "GAP" = declines or wrong answer,
with the exact reproduction. GraphBinary Maps decode to a JS `Map` and Sets to a JS `Set` — render those
explicitly when checking (a naive `JSON.stringify` shows `{}`, which masked one false alarm during the audit).

## What WORKS (verified — do not regress)

### Producers (a bare map value)
- `project(k…).by(…)` — `{n:marko}`, multi-key `{n:marko,a:29}`.
- `valueMap(k)` / `valueMap()` / `valueMap(true)` — `{name:[marko]}`, all-keys, token-bearing.
- `elementMap(k)` — flat with `T.id`/`T.label` tokens.
- `group().by(k).by(<sub>)` — all five value shapes (scalar/list/element-list/map/composite); `groupCount()`.
- `group().by(k).by(__.project()/__.valueMap()/__.elementMap())` — map-VALUED group (a `Map<K,Map>`).

### Consumers
- `select(<key>)` over project/valueMap/group — the key's value.
- `select(Column.keys)` (→ a Set) / `select(Column.values)` (→ a List); element keys re-enter (`groupCount().select(Column.keys).unfold()`).
- `valueMap(k).unfold()` — one entry per traverser.
- `group().by().by().unfold()` — one map-entry traverser per entry.
- Re-group: `unfold().group().by(Column.keys).by(Column.values | select(Column.values) | <V()-rooted sub>)`
  — the token, sub-traversal, and V()-rooted value bodies all frame vertices correctly (commits `ecff2eb9`,
  `82434fcc`, `9fec4146`); `within(select(Column.values))` over a list entry does membership (Stage E fix).
- Map-valued group `select(Column.values).unfold().select(<innerkey>)` — re-enters the inner map.

## Status (2026-08-28): G1, G3, G4, G5 LANDED; G2 now FAIL-CLOSED (was a silent wrong answer).
The finishing work is COMPLETE. Map support covers every producer→consumer path the audit catalogued,
including the three that needed new substrate: `project()` map unfold (G3, via a unified `{t:'string'}`
map-key encoding), a map bound to an `as()` label and read back (G4, via a `map` arm on the alias
vocabulary + static key sets for the map-key-vs-alias precedence), and a map literal as a produced value
(G5). See `[[g4-map-key-vs-alias-precedence]]` for the one design decision (static key sets, user-approved).
**G2 no longer mis-executes** — the double-group of an element-list value now DECLINES (commit f157d6d6)
rather than leaking rowids; the full nested-shape fix (carry the entry's `valOf`, expand recursively) is
the one remaining task, tracked below, and an L4 `@Unsupported` scenario fails loudly the day it lands.

## GAPS (the finishing work), in priority order

### G1 — a map-terminal federate sibling ERRORS  ✅ FIXED (2026-08-28)
`g.call("federate").with("graph","crew").with("traversal", __.V().group().by(T.label).by(__.count()))`
threw `federate: source traversal returned an internal mapValues result` (federate.ts:161) — a REGRESSION
the mapValues rewrite introduced (verified: at `f6b2ed3e~1` it returned `{person:4, software:2}`). The
source-form branch's `out.kind==='map'` guard conflated a USER's map terminal with the internal mapValues
injection result. **Fixed:** the source-form branch now resumes `out.kind==='map'` as a typed scalar map
traverser instead of throwing. Verified: group/groupCount/project siblings return their maps.

### G2 — re-group element-list value with NO value-by leaks raw ROWIDS  ✅ FAIL-CLOSED (2026-08-28, f157d6d6); full nested fix still TODO
**No longer a silent wrong answer** — `groupRows` now DECLINES a by()-less collecting arm over an entry
host whose `entry.valOf` is non-scalar, so this raises `UnsupportedTraversal` instead of leaking rowids.
The full fix (below) — carry the entry's `valOf` on the `GroupRecipe`, collect at root encoding, expand
recursively via `listNodeExpr` — is the one remaining map-support task. An L4 `@Unsupported` scenario
pins the refusal and fails loudly when it lands.
`g.V().hasLabel("person").group().by("name").by(__.out().fold()).unfold().group().by(Column.keys)`
→ `{josh:[{t:'list',v:[3,5]}], …}` — raw rowids. Should be `{josh:[[v[ripple],v[lop]]], …}`.
Same rowid-leak class as `ecff2eb9`, on the NO-VALUE-BY default-fold re-group path: `group().by(Column.keys)`
with no explicit value-by injects a default `fold()` whose value framing over an element-list entry value
does not expand rowids via `listNodeExpr` (the `by(Column.values)` token path does). **Not in the census**
(0 hits) — a genuine uncaught deferral→wrong-answer. **Root cause (fully traced 2026-08-28 — deeper than it
first looked; TWO failed quick attempts):** the collecting arm's `MEMBER_COL` holds the ENTRY'S WHOLE VALUE
— a `{t:'list', v:[rowids]}` node (`traverserMember` → `host.entry.val`, map.ts:434) — NOT a single element
rowid. So the correct value shape is a LIST-OF-LISTS: `{kind:'list', of:host.entry.valOf}` =
`{kind:'list', of:{kind:'list', of:{kind:'elem'}}}`, and the member is that entry list kept at ROOT encoding
and expanded RECURSIVELY by `listNodeExpr`. The `elementMembers`/`memberElem` single-element shortcut is
WRONG BY ONE LEVEL — the framer then reads a list node as a rowid (→ null). **Correct fix:** `groupMap` sets
the no-value-by re-group's `valOf` to `{kind:'list', of:<entryValOf>}` (nested) and collects the entry-value
node at root encoding, letting `listNodeExpr` recurse. `by(Column.values)` works because it reads the value
through `mapSide`/`sideList`, not a fresh `groupBarrier` — the two build the value differently. DEFERRED
pending careful nested-shape work (exotic: a double-group of an element-list value; low frequency).

### G3 — `project(k…).unfold()` declines  (asymmetry with valueMap)  ✅ FIXED (2026-08-28, commit a12957ce)
`g.V().hasLabel("person").limit(1).project("n","a").by("name").by("age").unfold()` → DECLINED, while
`valueMap("name").unfold()` WORKED. **Fixed** by wiring `recordTail`'s `unfold()` through the same
`recordToMap` → `mapTail` collapse that `fold()`/local-slice already use, so it reaches `mapTail`'s own
`unfold` handler (`unfoldMap` → `mapEntryTail`). The enabler was a UNIFICATION rather than a project
special-case: a record's map KEY was the last BARE-STRING holdout — every other producer emits a
`{t:'string'}` node key, and a bare key is not valid JSON so the entry framer's `json(mk)` threw
`malformed JSON` (and read null through `select(Column.keys)`). Encoding the record key as a node is
lossless for the fold/select paths and unifies the map-key encoding across all producers. **Compounding:**
+8 census traversals now execute (group/groupCount/select().by(…fold()) map producers whose unfold +
downstream ops lower over the unified key). Small SQL-byte rise banked in sql-hygiene; wire bytes and all
existing answers unchanged. Three L4 `map-unfold` scenarios added.

### G4 — `select(m).select(k)` — a key OUT of an aliased map declines  ✅ FIXED (2026-08-28, commit 78f86c07)
`g.V()…project("n").by("name").as("m").select("m").select("n")` → DECLINED (also without federate — this
is why the map-injection-via-alias federate case declines: it's the base gap, not federate). **Fixed** in
two parts: (1) a `map` arm across the alias vocabulary (`TraverserObject`/`AliasRead`/`AliasEntry.mapOf`,
history stores the pairs blob, `mapTail`/`recordTail` grow an `as` handler) so a map binds to a label and
`select(m)` re-enters the map; (2) STATIC KEY SETS on the map framing (`keys?: string[]`, user-approved)
so `select(m).select(k)` resolves `k` against the map's compile-time key set — TinkerPop's map-first
precedence (`Scoping.java`). A key provably not in the set re-enters the alias unambiguously; an ambiguous
or unknown-key case stays FAIL-CLOSED. Also unblocks the federate map-injection-via-alias case (see
`[[federate-mapvalues-rewrite-plan]]`). No SQL/wire change. L4 gains `map-alias-select.feature`.

### G5 — a map LITERAL as a constant/inject value declines  ✅ FIXED (2026-08-28, commit 1cbd9039)
`g.inject(1).constant(["a":1,"b":2])` and `constant([a:1])` → DECLINED. **Fixed:** `constant([k:v])` is
now the per-row twin of `inject([k:v])` (`injectMap`) — `constantRetype` builds the pairs blob
(`mapLiteralBlob`) and produces a `{kind:'map'}` framing with the literal's string keys as the static key
set, so the whole re-enterable map tail composes (unfold/select/count(local)/as-select). Fixing it also
surfaced a LATENT scalar-tail bug: `scalarTail`'s `constant` continued the scalar loop even on a
non-scalar retype (only reachable now that a constant can be a map) — it now hands off to `continueAs`.
L4 gains `map-literal-constant.feature`. (`inject([k:v])` as an argument already worked.)

## Sequencing
- **G1 + G2 first** — G1 is a rewrite regression (a lost capability), G2 a silent wrong answer. Both are
  references-settled and being fixed now (2026-08-28).
- **G3/G4/G5** — general map-shape completeness, no federate coupling. G3 (project unfold) ✅ and
  G4 (aliased-map select) ✅ both landed 2026-08-28. G5 (map literal as a constant/inject value) is the
  last, lowest-priority corner. G2 (double-group element-list value) remains DEFERRED (exotic nested shape).

## Verification discipline
Every fix: `bun test test/L4-addendum/l4.test.ts test/federation.test.ts test/services.test.ts` + `census`
(0 changed / 0 stopped, read any newly-executing row against the reference) + `bash scripts/ci.sh` (grep
the `CI: PASS` verdict line) + L1 100%. Add an L4 oracle pinning each fixed shape. Cite `vendor/tinkerpop`
for the semantics (Column.java, GroupStep.java's fold injection, PropertyMapStep for valueMap).
