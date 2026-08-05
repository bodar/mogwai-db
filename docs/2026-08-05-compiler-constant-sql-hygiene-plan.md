# Compiler constants and SQL hygiene — plan

**Status: PLANNED.** This is the plan to finish the distinction begun by `compilerText()`:
query/store data is a bind; a value the compiler itself chose is SQL syntax. The aim is not to make
RelIR's SQL text byte-identical to legacy's. RelIR is normalized and can legitimately require a
different CTE shape. The aim is that neither route emits a statement the Durable Object rejects,
and that RelIR never spends a bind on a constant it authored.

**The two existing instruments are inputs, not the finished gate.** `src/cf-limits.ts` is the one
authority for the platform's 100-bind and 100-KB walls. `scripts/rel-sweep.ts` renders every admitted
RelIR plan over corpus prefixes and asks that authority about each statement. `test/rel-spine.test.ts`
compares the wire-visible answer of paired, covered traversals and now checks both statements against
the same authority. They prove important halves; neither classifies where a bind came from, nor does
either give a per-family no-regression metric.

## 1. The boundary

There are exactly two sources of an `Expr` literal.

| Source | Examples | SQL spelling | Reason |
|---|---|---|---|
| Query/store data | Gremlin arguments, GLV parameters, property keys/values, IDs, user text, retained rows | bind | It may vary per request; inlining is an injection surface, makes statement text data-dependent, and defeats statement caching. |
| Compiler constant | canonical type names, storage classes, JSON paths/keys, empty JSON, internal truth/ordinal values | escaped SQL literal | Its value is fixed by code, so consuming one of the DO's 100 binds gains nothing. |

**The source is the rule, not the apparent value.** A query argument of `"int"` is data and stays a
bind even though the compiler also has a canonical type named `int`. Conversely, a comparison against
the compiler's own `CanonicalType` vocabulary is compiler syntax. Do not classify from runtime type
or from a string's contents.

The present algebra spells the distinction as `lit()` (bound data) and `compilerText()` (compiler
string). It must stay narrow. This plan may add `compilerInt()` and `compilerNull()` if the inventory
shows real fixed numeric/null syntax; it must not add `compilerValue(unknown)` or a boolean that lets a
caller silently choose inlining. A narrow constructor is both the injection boundary and the audit
surface.

## 2. What “same or better” means

Raw SQL text length is not a valid universal comparison. A RelIR `Materialize` CTE can be semantically
and planner-correct where legacy uses a shorter hand-written subquery; rewarding the shorter string
would make the hygiene gate oppose the algebra.

For every **paired, comparable executable statement**, RelIR must be the same or better on these
properties:

1. both pass `cfLimitViolation` (bind count and UTF-8 statement bytes);
2. both prepare and execute under the same seeded SQLite schema when the traversal is read-only;
3. RelIR has zero binds whose provenance is compiler-constant;
4. the two routes frame the same answer, and keep the existing access-path differential where that
   test already applies;
5. RelIR's compiler-constant bind count is never greater than legacy's (zero is the target).

The final item deliberately does **not** say total binds or bytes are less than legacy in every shape:
the remaining binds can be query data, and RelIR may correctly duplicate a query operand where a
different relational form needs it. Those are separate optimization questions. The sweep records them
as diagnostics, but does not call a correct plan worse merely for a different normal form.

Unpaired statements are still gated absolutely. This includes a RelIR program's individual effects,
the RelIR-only coverage frontier, and legacy `WritePlan` closures, which do not expose one generated
statement to compare. A missing counterpart is never a loophole in either DO wall.

## 3. Inventory before migration

There are currently more than a hundred `lit()` call sites across `src/compiler/rel/` and `src/rel/`.
Do not bulk-replace them by text. The same file commonly contains both categories — for example,
`lower.ts` has an internal bulk `1` and user-supplied `V(id)` arguments.

Build a checked inventory with one entry per construction site:

| Class | Typical homes | Expected constructor | Required witness |
|---|---|---|---|
| Canonical/SQLite type vocabulary | `predicate`, `reducer`, `build`, `list`, `map` | `compilerText` | rendered SQL contains the escaped token; binds do not |
| JSON syntax | `list`, `map`, `path`, `alias`, `history` | `compilerText` | apostrophe-containing generated token is escaped; query JSON remains bound |
| Internal scalar syntax | `lower`, `list`, `path`, `write` | narrow numeric/null constructor only if needed | a query argument with the same value still binds |
| Query/store data | `lower`, `predicate`, `modulator`, `transform`, `write` | `lit` | hostile strings and bound parameters remain `?` values |
| Deferred/mixed | any site whose origin cannot be shown locally | no change | named decision with a caller trace |

The inventory is a temporary review artifact, not a second source of truth. The durable authority is
the explicit constructor at the site plus tests that distinguish its provenance. Delete the inventory
when every deferred row has a disposition.

## 4. Migration order

### 4.1 Fixed vocabulary first

Finish type names, storage classes, shape tags and reducer eligibility lists in `predicate.ts`,
`reducer.ts`, `build.ts`, `map.ts` and `modulator.ts`. These are the highest-value, lowest-risk sites:
their values are finite compiler tables. The initial `compilerText()` change belongs here.

Exit: L2 asserts the token is in SQL rather than binds, and the representative `order().by()` /
range-predicate plans have materially fewer binds without changing their rows or access path.

### 4.2 JSON and path syntax

Migrate compiler-owned JSON paths (`$.…`, `$[#]`), empty JSON and typed-node tags in the list/map/path
families. Preserve the existing special handling of `json-object` keys: those are already compiler
strings and render through `textLiteral` in the emitter.

Exit: typed collections, `path()`, `as()` history and GraphBinary framing pass on both Bun and the CF
limit run. A JSON document supplied through Gremlin remains one bind, even where an equivalent empty
document is compiler syntax.

### 4.3 Numeric and null syntax

Only after the string audit, decide whether internal `0`, `1`, fixed ordinals and `NULL` deserve
dedicated constructors. The decision is per origin: a query `limit(1)` is data; the compiler's
`row_number() = 1` survivor test is syntax. Do not infer the source from the number.

Exit: tests pair each compiler numeric/null use with a query value of the same spelling and prove the
former is raw syntax while the latter is bound.

### 4.4 Writes last

Audit `write.ts` and retained-row transport separately. A write's labels, property keys, values, JSON
payloads and external IDs are overwhelmingly user/store data and must stay bound. The only candidates
are fixed SQL/JSON/type vocabulary that the compiler generated itself.

Exit: `mise run test:cf-limits`, write-program tests and the JSON transport refusal tests pass; no
write input changes statement text when only its data changes.

## 5. The hygiene sweep and ratchet

Add a dedicated `scripts/sql-hygiene.ts` gate rather than overloading `rel-sweep` with paired-spine
policy. `rel-sweep` remains the product-of-prefixes decline-contract instrument; its input has synthetic
chains the legacy compiler cannot reconstruct. The hygiene sweep uses complete authored corpus
traversals, where both spines can be asked the same question.

For each traversal:

1. compile with the RelIR and legacy spine pinned;
2. split a RelIR `Program` into its emitted effects and tail, and a read into one statement;
3. apply `cfLimitViolation` to every statement in either route;
4. for read-only paired plans, prepare/execute against the seeded store and compare framed answers;
5. inspect RelIR expressions before emission to count bound versus compiler literals, rather than
   guessing provenance from a rendered `?`;
6. record per-family maxima for statement bind count, UTF-8 bytes, and compiler-constant binds.

The artifact records **maxima by vocabulary family**, not one global number. A global max cannot say
whether a change made predicates better while making path framing worse. The gate is monotone in the
right direction: no wall violations, zero compiler-constant binds, and no family maximum may rise
without an explicit new-family baseline. It prints the traversal and statement role for each failure.

SQL preparation is hygiene, not a replacement for semantic tests: an `EXPLAIN QUERY PLAN` can prove
that SQLite accepts the generated statement, but only the GraphBinary differential/census can prove it
answers Gremlin correctly.

## 6. Final gate and exit criteria

Enable `mise run sql-hygiene` in `ci` only when:

- every inventory row is migrated or has a named, tested reason to remain a bind;
- the paired corpus sweep has zero DO wall, provenance, preparation and answer violations;
- the unpaired RelIR sweep has zero DO-wall violations for every rendered executable statement;
- `mise run test:cf-limits`, `mise run test:legacy-spine`, the census, L2–L5 and the access-path
  differential are green; and
- the ratchet artifact is committed with a short explanation for every new family baseline.

At that point, a new compiler-authored bind fails immediately, while a new query-data bind remains
legal and visible. That is the intended rule: the gate protects the finite compiler vocabulary without
turning legitimate query parameters into SQL text.
