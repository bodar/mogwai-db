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

## GAPS (the finishing work), in priority order

### G1 — a map-terminal federate sibling ERRORS  ✅ FIXED (2026-08-28)
`g.call("federate").with("graph","crew").with("traversal", __.V().group().by(T.label).by(__.count()))`
threw `federate: source traversal returned an internal mapValues result` (federate.ts:161) — a REGRESSION
the mapValues rewrite introduced (verified: at `f6b2ed3e~1` it returned `{person:4, software:2}`). The
source-form branch's `out.kind==='map'` guard conflated a USER's map terminal with the internal mapValues
injection result. **Fixed:** the source-form branch now resumes `out.kind==='map'` as a typed scalar map
traverser instead of throwing. Verified: group/groupCount/project siblings return their maps.

### G2 — re-group element-list value with NO value-by leaks raw ROWIDS  ⚠️ WRONG ANSWER (silent, uncensused)
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

### G4 — `select(m).select(k)` — a key OUT of an aliased map declines
`g.V()…project("n").by("name").as("m").select("m").select("n")` → DECLINES (also without federate — this
is why the map-injection-via-alias federate case declines: it's the base gap, not federate). A nested
`select` that reaches into an aliased map value is not a lowered shape. Base-compiler gap.

### G5 — a map LITERAL as a constant/inject value declines
`g.inject(1).constant(["a":1,"b":2])` and `constant([a:1])` → DECLINE. A `[k:v]` map literal as a produced
VALUE (constant/inject) does not lower, though a map literal AS AN ARGUMENT (`inject([k:v])` unfolded) does.
Lowest priority.

## Sequencing
- **G1 + G2 first** — G1 is a rewrite regression (a lost capability), G2 a silent wrong answer. Both are
  references-settled and being fixed now (2026-08-28).
- **G3/G4/G5** — general map-shape completeness, no federate coupling. G3 (project unfold) ✅ landed
  2026-08-28. G4 (nested select) is next — the other natural GraphQL-shaped read; G5 is a corner.

## Verification discipline
Every fix: `bun test test/L4-addendum/l4.test.ts test/federation.test.ts test/services.test.ts` + `census`
(0 changed / 0 stopped, read any newly-executing row against the reference) + `bash scripts/ci.sh` (grep
the `CI: PASS` verdict line) + L1 100%. Add an L4 oracle pinning each fixed shape. Cite `vendor/tinkerpop`
for the semantics (Column.java, GroupStep.java's fold injection, PropertyMapStep for valueMap).
