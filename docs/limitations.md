# mogwai-db — limitations

This page lists what mogwai-db does not do, and where its answers differ from Java TinkerPop. For what
it does do, see [feature-support-matrix.md](feature-support-matrix.md).

There are three kinds of limitation:

1. **Not supported yet.** The query fails with an `UnsupportedTraversal` error that names the problem.
   It never runs with a wrong answer. The decision depends only on the query text, never on the size
   or content of the graph.
2. **Number limits.** SQLite stores numbers in a fixed way. Some values cannot be stored or computed.
3. **Differences from Java.** mogwai-db is a faithful port, not a copy of Java's execution. It gives
   the answer a user would call correct, under JavaScript and SQLite rules. The rows and the counts
   are always the same; details such as row order, number formatting and error text can differ.

---

## 1. Not supported yet

Most of these are rare combinations of steps that work on their own.

**Start and move**

- `V()` mid-traversal after `path()`.
- `V()`/`E()` in a child traversal, after a value that some rows do not have
  (`optional(…as('a')).map(__.select('a').V()…)`). The answer would depend on which rows had the value.
- `otherV()` with no entry vertex (`E().otherV()`), or after a mix of vertices and edges
  (`union(outE(), out()).otherV()`).
- `to(Direction, …)` and `toE(Direction, …)`.
- `inject()` with a set literal.

**Filter**

- `where(P)` and `where('a', P)`:
  - a comparison between value labels (`values('age').as('a') … where('a', P.lt('b'))`);
  - `by(key)` that reads an edge label;
  - a side effect as the key, except `P.within`/`P.without` over an `aggregate` collection.
- `is(P)` after `path()`, or with an operand that reads a label of the same row
  (`is(P.gt(__.select('x').values('age')))`).
- `is(typeOf(GType))` over a list.
- `regex` and `notRegex` in `is()`, `where()` or `match()`. They work in `has()`.
- `coin(p)`.

**Read element data**

- `valueMap().with(WithOptions.tokens, …)`.
- Reading meta-properties: `properties().properties()`.
- `propertyMap()`.
- `select(k)` of an element out of a `project()` map after `fold().unfold()`.

**Count, aggregate and order**

- `fold(seed, Operator.assign)`.
- `fold(seed, Operator)` with a list seed other than `[]`, or with a `byte`, `short`, `float`,
  `bigint` or `bigdecimal` seed or value.
- `fold(seed, Operator)` with a result of Infinity or NaN. It raises an error.
- `order()` by a list, map or path inside a child traversal, in a query that writes, or over a
  federated list. (`order().by(keys)` over list-valued keys compares the JSON text.)

**Write**

- `addE()` directly after `addE()`.
- `addV(<traversal>)` or `addLabel(<traversal>)` whose label is a list.
- `dropLabel(<traversal>)`.
- `property(k, <traversal>)` where the traversal could read a value that another row writes.
- `mergeV`/`mergeE` with maps that come from `unfold()`.
- `mergeV`/`mergeE` that write a meta-property with no declared cardinality.

**Branch and nest**

- `union()` with one arm that reduces (`union(count())`).
- `union()` that mixes maps and plain values.
- `choose(identity()).option(P.gt(1), …)` — an ordering or text predicate key over an element.
- `branch()` with only one arm left, when the order of results must be kept.
- After `coalesce()` or `union()` with mixed result types: `unfold()`, a member transform, or
  `dedup()` with a key. (`count()`, slices and plain `dedup()` work.)
- `sideEffect()` whose only effect is a write or an error (`sideEffect(addV(…))`).

**Repeat**

- `repeat(…).until(…)` or `repeat(…).emit(…)` with `dedup()`, an aggregate or a side effect
  (`aggregate`, `groupCount('k')`) in the body. A recursive SQL query cannot hold these. With
  `times(n)` they work.

**Paths and labels**

- `unfold()` over a path that mixes vertices and edges (`outE().inV().path().unfold()`).
- `path().group()`.
- `tree('k')` (the side-effect form), and a step after `tree()` (`tree().count(local)`).
- `subgraph('k')`.

**Lists and maps**

- `order(local).by(<traversal>)` over a map.
- `dedup(local)` with labels or with `by(…)`.
- A list of properties as a local collection.
- `merge()` of a non-empty map literal into `valueMap()`.
- `combine`/`merge`/`disjunct`/`product` between a list of values and a list of elements.
- `index()`.

**Strings**

- `split(Scope.local, …)`, `split()` over a list, `split()` inside a child traversal, and reading a
  label bound before `split()`.
- `reverse()` of a string inside a child traversal.

**Side effects and sacks**

- `aggregate`, `group` or `groupCount` inside a child traversal, when the same child also reads the
  collection (`local(aggregate('a').cap('a'))`).
- In a child traversal: a `group(k)` whose `by()` can raise an error, or whose value `by()` reduces;
  a keyed `group(k)` in a query that writes.
- `withSack(seed, Operator)`.
- A `bigint` or `bigdecimal` operand to `sack(Operator)`.

**Pattern matching** — see the ❌ rows in the
[support matrix](feature-support-matrix.md#12-pattern-matching-match).

**Services and federation**

- `tinker.search`: terms shorter than 3 characters, and `regex`.
- `federate`: a parameter or `null` as an edge label, `order()` over the bound stream, `path()` or
  `as()` across the call, and movement over a result that is not a subgraph.

**Strategies**

- `SubgraphStrategy` with `vertexProperties`, or on a query that writes.
- `PartitionStrategy` with `mergeV`/`mergeE`, or with `includeMetaProperties`.
- `ProductiveByStrategy` on a `by()` whose host step is not supported.
- `EarlyLimitStrategy` disabled: a slice after a side effect is not supported.

**Import and export**

- CSV export cannot write list, set or map values, or meta-properties. It writes `bigint`,
  `bigdecimal`, `uuid`, `char` and `duration` as strings.

## 2. Known issues

These give a wrong answer today. They are bugs, not design choices.

- `barrier(Barrier.normSack)` acts as a plain `barrier()`. It does not normalize the sacks.
- `tinker.search` with `type: 'VertexProperty'` always returns nothing, also when a meta-property
  matches.

## 3. Number limits

| Limit | What happens |
|---|---|
| 128-bit arithmetic | Not supported. |
| 64-bit integer overflow | Raises an error. |
| 32-bit float arithmetic | Runs as 64-bit double. SQLite has only one real type. |
| `NaN` | SQLite stores NaN as NULL. So a NaN literal as a value (`inject`, `constant`, a list member, a property) is not supported. NaN works as a predicate operand. `±Infinity` works. A NaN made by `math()` or a sack raises an error. A NaN `sum()` or `mean()` is `null`. |
| Map and set equality | Maps and sets are stored as JSON text, and JSON key order is not fixed. So you cannot compare against a map or set: in `has(k, [a:1])`, `is`, `eq`, `neq`, `within`, `without`, or as a `mergeV`/`mergeE` match key. The query fails with an explanation. List operands work. `onCreate`/`onMatch` maps are written, not compared, so they work. |
| Bounded `repeat` inside a child traversal | `repeat(…).times(n)` inside `local`, `map`, `flatMap`, `where` or `by()` works up to `times(63)`. From 64 it would pass SQLite's 64-table join limit, so it is not supported. A top-level `times(n)` has no limit. |
| Very large or small doubles | Outside about 1e-80 to 1e116, a value can change in its last digit (`1.5e-300` → `1.4999999999999998e-300`). |

## 4. Differences from Java TinkerPop

### Text

| Topic | mogwai-db |
|---|---|
| Regex | JavaScript `RegExp`, not `java.util.regex`. `$` is the end of input. `\s` includes Unicode spaces. `\Q…\E` is not supported. A pattern that JavaScript cannot read raises an error. |
| String order | By code point. This differs from Java only for some rare characters (above U+FFFF vs U+E000–U+FFFF). |
| Upper and lower case | `toUpper` and `toLower` change ASCII letters only. |
| String length | `length()` and `substring()` count characters, not UTF-16 units: `'😀'.length()` is 1. |
| NUL character | Stored whole, but `length`, `substring`, `like` and `tinker.search` stop at it. A NUL in the query text is not supported. |
| Invalid characters | A lone surrogate in a parameter or JSON becomes U+FFFD (`'a\ud800b'` → `'a�b'`). In the query text it is not supported. |
| Full-text search | `tinker.search` is case-insensitive. Java's is case-sensitive. |

### Numbers

| Topic | mogwai-db |
|---|---|
| Equality | By value: `1`, `1L` and `1.0` are equal. `true` and `1` are not. A UUID and a string are not. When equal keys merge (in `groupCount()`), the key keeps one of the types: `inject(1, 1.0).groupCount()` is `{1.0: 2}`. |
| Comparison | Exact SQLite comparison, no Java widening: `9007199254740993L > 9007199254740992d` is true. `bigdecimal` compares at double precision. |
| Float | Stored as a double. `0.1f` equals `0.1d`. |
| Signed zero | `-0.0` is `0.0`. |
| `sum()` and `mean()` | Add as doubles, then return the common type. `Infinity + -Infinity` is `null`. |
| `min()` and `max()` | The result keeps its own type: `inject(5, 2.0d).max()` is the integer `5`. When two values are equal but typed differently, either one can be the result. |
| `bigdecimal` scale | A whole double converted to `bigdecimal` has scale 0 (`100.0` → `100`). |
| Sack type | Double if either side is a double. Else long if either side is a long or the value needs more than 32 bits. Else integer. |
| Number as text | `asString()`, `format()` and `conjoin()` use SQLite's format: 15 significant digits, `1.0` keeps `.0`, an exponent below 1e-4 or from 1e15 (`1e-5` → `1.0e-05`), infinity is `Inf`. A float prints as written (`0.1f` → `0.1`). |

### Order of results

Without `order()`, rows come in the order of the SQL plan. Wherever the query asks for an order
(`order()`, `tail()`, `fold()`, `path()`, the arms of a branch for one row), the order is kept.

| Topic | mogwai-db |
|---|---|
| `limit(n)` without `order()` | Returns some n rows. |
| `sample(n)` | A uniform sample, not in Java's draw order. |
| "First result" | Where a step takes the first result of a child traversal (`map`, `project().by`, a computed label or key in a write), it takes the first in the child's own order, then by value. |
| `order().by(shuffle).limit(1)` | Same as `sample(1)`. |
| Ties in `order()` | Equal values tie, whatever their type (`1m` and `1.0d`). |
| `merge()` of maps | Keeps insertion order: the input map's keys, then the argument's new keys. Java uses `HashMap` order. |
| Branches | Each row's arms in written order. `order()` inside an arm sorts only that row's output. Put `order()` after the branch to sort everything. |
| `flatMap` and `local` | Keep each row's sorted run. `coalesce()` or `optional()` at the end over a sorted arm is not sorted. |
| Group values | A slice or sort of a group value sees all the values for that key together. |
| `federate` | Results come in the other graph's order. |

### Errors

| Topic | mogwai-db |
|---|---|
| When errors happen | Errors are eager. A type error can raise where Java would stop first. A constant label or key in the query text (`addLabel(constant(5))`) is checked at compile time, so it raises even when no rows reach it. |
| Filter before error | A later filter can remove a row before its error happens: `inject(1).toUpper().is('x')` is `[]`. |
| Unread values | An error in a value that nothing reads is not raised. |
| Error text | Messages name the value (`encountered 1.`), not the Java class. A few other messages differ in wording from Java (`merge()`, list functions over a non-list, set operations). A `null` argument to `merge()` raises `encountered null`, not a `NullPointerException`. |
| Writes in a read-only child | The error names our step, not Java's internal class. |

### Missing values and null

| Topic | mogwai-db |
|---|---|
| `by()` with no value | The row is skipped: `project()` leaves out the key; `select`, `order`, `dedup`, `where` and `sack` drop the row. A child that returns a real `null` keeps it. |
| Label with no value | `where(k, …)` or `dedup(labels)` drops a row where `k` is not bound. Java raises an error. |
| A re-sourced value of `null` | A child that starts with `V()` and returns `null`, when used as a single value (a `concat()` operand, a `P` operand, a `project()` value), counts as no result. In `map`, `local`, `flatMap`, `where` and `group` it is a real `null`. |
| `null` label in a branch | A label bound to `null` inside a branch arm reads as not bound. |
| `format()` over a property with many values | Uses the first value. Java raises an error. |

### Writes

| Topic | mogwai-db |
|---|---|
| Visibility | A write step sees its input as it was before the step. Later steps see all of its writes. `g.V().not(out()).drop()` drops exactly the leaf vertices. |
| Bulked rows | One element per row: `g.V().both().addV('x')` creates 12 vertices. Java creates 6. |
| String vs integer id | A string id does not match the integer it spells: `V('1')` does not find vertex `1`. Both kinds of id can exist, so a conversion would be ambiguous. |

### Side effects, sacks and labels

| Topic | mogwai-db |
|---|---|
| Reading a side effect | A read sees the complete collection, also when a child traversal fills it. |
| `barrier()` | Passes rows through unchanged, in order. `barrier(n)` too. |
| Seeded `fold()` over repeated values | Every row is folded: `inject(1,1,2).fold(0, sum)` is `4`. |
| Seeded `fold()` in a child | Starts from a new seed for each parent row. Java shares one seed. |
| A label bound again after a branch | `select(Pop.all, k)` can list it once more, or once less, than Java. |
| Disabled strategies | `withoutStrategies(IdentityRemovalStrategy, LazyBarrierStrategy, PathRetractionStrategy, RepeatUnrollStrategy)` gives the normal answer. |
| `SeedStrategy` | Has no effect, so `sample()` is not repeatable with a seed. |

### Maps

| Topic | mogwai-db |
|---|---|
| `select(k)` over stored maps | If a side effect, collection or path label named `k` exists, `select(k)` reads it. Else it reads the map's own `k`. Else it drops the row. When a map may hold `k` **and** a side effect or path label is also named `k`, the query is ambiguous and fails with an explanation. `mergeV`/`mergeE` follow the same rule. |
| `select(keys)` on a non-map | Raises `does not have accessible keys`. |
| String vs UUID with no type | A value with no known type (an unfolded list member, an injected string) compares by its text. So a string that spells a UUID equals that UUID there. Stored and typed values stay different. |
| List functions | `combine`, `intersect` and the other list functions decide per row whether the value is a list. |

### Untyped JSON output

| Topic | mogwai-db |
|---|---|
| Map keys | One spelling rule. Keys that collide become `[key, value]` entries, so nothing is lost. NaN and Infinity are strings. |
| Shapes | A path is `{labels, objects}` with empty labels. A vertex property is `{id, key, value}`. An edge property is `{key, value}`. An edge end is its id. |
