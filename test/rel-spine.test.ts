import { describe, expect, test } from 'bun:test';
import { compile, UnsupportedTraversal } from '../src/compiler/compiler.ts';
import { idAlreadyExists, read, runWith, seededStore } from './support/harness.ts';
import { cfLimitViolation } from '../src/cf-limits.ts';
import { exec, executeQuery } from './support/executor.ts';
import { decodeAll } from './support/decode.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { createAppScope } from '../src/scopes.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { PER_ROW, STATIC } from '../src/sql/kernel/render.ts';

/**
 * THE RelIR SPINE — coverage and the fail-closed boundary.
 *
 * There is ONE spine: the legacy route and its corpus-wide differential are gone, so this file pins
 * the boundary directly rather than as a divergence between two routes.
 *
 *   1. COVERED — every shape the lowering handles compiles to a DO-legal plan, so a lowering that
 *      silently stopped firing is a failure HERE rather than a coverage number nobody read;
 *   2. DECLINED — an UNCOVERED shape raises `UnsupportedTraversal` rather than mis-answering, which
 *      is the fail-closed contract that keeps "not learned yet" from becoming a plausible wrong
 *      answer. Growing coverage moves a shape from DECLINED to COVERED.
 */

const store = seededStore();


/** Every shape the lowering covers today. Growing coverage means growing this list. */
const COVERED = [
  'g.V()', 'g.E()', 'g.V(1)', 'g.V(1,2)', 'g.V([1,2])',
  "g.V().hasLabel('person')", "g.V().hasLabel('person','software')", "g.E().hasLabel('knows')",
  "g.V().has('name')", "g.V().has('name','marko')", "g.V().has('age',29)", "g.E().has('weight',0.5)",
  // A RUN of filters is the shape worth pinning: a per-step lowering would give each its own CTE
  // that re-joins the element table to reach a column its predecessor projected away, so
  // `has(a).has(b)` would cost two redundant self-joins. The lowering conjoins them into one WHERE
  // over one scan — measured, the same index decisions with those SEARCH-by-rowid steps simply absent.
  "g.V().hasLabel('person').has('age',29)", "g.V().has('name','marko').has('age',29)",
  // The P/TextP vocabulary as RelIR expressions. Range comparisons go through the vtype-aware
  // ordering key, so a value stored as TEXT because it does not fit a numeric storage class (a
  // long past 2^53, a bigint, a bigdecimal, a duration) still orders numerically — the one arm
  // where a plausible-looking lowering is silently wrong.
  "g.V().has('age',P.gt(30))", "g.V().has('age',P.lte(29))", "g.V().has('name',P.neq('marko'))",
  "g.V().has('name',P.within('marko','josh'))", "g.V().has('name',P.without('marko'))",
  "g.V().has('name',P.within())", "g.V().has('age',P.between(20,30))", "g.V().has('age',P.inside(20,35))",
  "g.V().has('age',P.gt(20).and(P.lt(30)))", "g.V().has('age',P.not(P.gt(30)))", "g.E().has('weight',P.gte(0.5))",
  // TextP is the same predicate vocabulary at a stored-property host: positive, negative and
  // composed forms all retain the property row's vtype rather than asking SQLite to stringify it.
  "g.V().has('name',TextP.containing('ark'))", "g.V().has('name',TextP.startingWith('mar'))",
  "g.V().has('name',TextP.endingWith('as'))", "g.V().has('name',TextP.notContaining('ark'))",
  "g.V().has('name',TextP.startingWith('m').or(TextP.startingWith('p')))",
  // A non-start GraphStep CROSS JOINs its incoming traversers with the graph while carrying aliases.
  // The scalar child form exercises the same operation through the framing dispatcher rather than a
  // second source loop.
  "g.V().has('name','marko').as('a').V().has('name','vadas')",
  "g.V().hasLabel('person').values('age').map(__.V().count())",
  // SQLite has no reverse scalar function, so the transform is a correlated Recursive relation
  // embedded as one scalar expression. Non-string and null values are ReverseStep identities.
  "g.V().values('name').reverse()", 'g.inject("abc").reverse()', 'g.inject(3).reverse()', 'g.inject(null).reverse()',
  // THE SHAPE BOUNDARY: both of these retype element -> scalar, so they exercise the framing
  // bridge's second stream kind rather than one more step in the same one.
  'g.V().count()', 'g.E().count()', "g.V().hasLabel('person').count()", "g.V().has('age',P.gt(29)).count()",
  "g.V().values('name')", "g.V().values('age')", "g.E().values('weight')", "g.V().hasLabel('person').values('name')",
  // `is(P)` past the shape change — the SAME predicate module the source filters use, over the
  // scalar's own `v`, which is the payoff for having built it as a module rather than a helper.
  'g.V().count().is(P.gt(2))', 'g.V().count().is(2)', "g.V().values('age').is(P.gt(29))",
  "g.V().values('name').is('marko')", "g.V().values('age').is(P.between(28,33))",
  "g.V().values('name').is(P.within('marko','josh'))", "g.V().values('name').is(TextP.containing('ark'))",
  "g.V().hasLabel('person').values('age').is(P.gte(30)).is(P.lt(40))", "g.E().values('weight').is(P.gt(0.3))",
  // `values()` is `element.properties(keys)`: no keys means EVERY key, several mean membership.
  // These were answered WRONG until 2026-08-02 — see the semantics test below.
  "g.V().values('name','age')", "g.V().values('name','age',null)", 'g.V().values()', 'g.E().values()',
  // An ALL-NULL key set is a legal set that matches nothing — the case `propertyKeyArgs` exists to keep
  // apart from an ABSENT set, at every one of the four sites that reads a key list.
  'g.V().values(null)', 'g.V().properties(null)', 'g.V().valueMap(null)',
  // A NULL where a string was allowed is now CARRIED by the front end (it is a bare `K_NULL` token in the
  // grammar, which the arg walk used to drop), so each site states what a null MEANS instead of never
  // seeing one. All four are the corpus's own answers: a null property key is absent by construction
  // (`Has.feature:565`), a null label matches no element or edge, and a null concat part is skipped.
  'g.V().has(null)', "g.V().has(null, 'test-null-key')", "g.V().hasLabel(null, 'person')", 'g.V().hasLabel(null)',
  'g.V().hasNot(null)', 'g.V().out(null)', "g.V().out(null,'knows')", "g.inject(null, 'a').concat(null, 'b')",
  // THE PROPERTY STREAM AS A ROW PARTICIPANT — `order()`, `dedup()`, the slices and its own two filters,
  // over BOTH owner kinds, because that is where the natural-order and identity rules differ
  // (`propertyOrderTerms`/`propertyIdentityKey`).
  'g.V().properties().order()', 'g.E().properties().order()', 'g.E().properties().order().by(desc).value()',
  'g.V().properties().dedup()', 'g.V().both().properties().dedup().count()', 'g.V().bothE().properties().dedup().count()',
  'g.V().properties().limit(2)', 'g.V().properties().range(1,3).value()',
  "g.V().properties().hasKey('age')", "g.V().properties().hasKey(null,'age').value()", 'g.V().properties().hasKey(null)',
  'g.V().properties().hasValue(P.gt(30))', "g.V().properties().hasValue(null,'josh').value()",
  // THE WHOLE BRANCH FAMILY over a PROPERTY stream — `branchArms` re-entered at the property framing, so
  // the arms (`key()`/`value()`/`constant()`) retype through `propertyTail` and merge. `union` needs no
  // condition; `choose`/`coalesce` fold their condition/arm bodies through a property `branchSubject`
  // (`branchSubject` now answers the property framing), so all three compose.
  'g.V().properties().union(__.key(), __.value())', 'g.V().properties().union(__.value(), __.constant("x"))',
  'g.V().properties().choose(__.key().is("name"), __.value(), __.key())',
  'g.V().properties().coalesce(__.key(), __.value())',
  // A CORRELATED FILTER over a property stream — `where`/`filter`/`not`/`and`/`or` fold their body
  // through the property `Subject` and PRESERVE the shape. `is` still declines (a property has no single
  // value), which `SCALAR_FILTER_HOSTS` excludes.
  'g.V().properties().where(__.value().is(P.gt(30))).value()',
  'g.V().properties().filter(__.value().is(P.gt(30))).key()',
  'g.V().properties().not(__.key().is("name")).key().dedup()',
  'g.V().properties().and(__.key().is("age"), __.value().is(P.gt(30))).value()',
  // `constant(c)` is the ONE shape-independent retype (`constantRetype`) — it ignores the traverser and
  // emits a literal, so it composes over EVERY tail: element, scalar, list, property and map. The list/
  // property/map tails had no caller for it before, so these declined for want of a caller, not algebra.
  'g.V().fold().constant("x")', 'g.V().properties().constant("x")', 'g.V().group().by("name").constant("x")',
  'g.V().fold().constant(1).math("_+1")',
  "g.V().bothE().properties().dedup().hasKey('weight').hasValue(P.lt(0.3)).value()",
  // A PROPERTY's own `by()` TOKENS and its two Element-only retypes — both legal per HOST, not per
  // grammar, so an element declines `T.key` (asserted in DECLINED) and an edge `Property` declines
  // `id()`/`label()` because it is not an Element at all.
  'g.V().properties().order().by(T.key, Order.desc).key()', 'g.V().properties().order().by(T.value)',
  'g.V().properties().dedup().by(T.key)', 'g.V().bothE().properties().dedup().by(value).count()',
  'g.V().properties().group().by(T.key)',
  'g.V().properties().id()', 'g.V().properties().label()', 'g.V().properties().order().id()',
  // A LIST's own member ops, all three of which were unreachable rather than unbuilt: the blanket
  // modulator guard declined `order(Scope.local).by(desc)` whose whole content is the comparator, the
  // scope TOKEN counted as an argument and declined every `dedup(Scope.local)`, and `reverse()` had no
  // arm because its meaning on a list is a different operation rather than a per-member transform.
  "g.V().values('age').fold().order(local).by(desc)", "g.V().values('name').fold().order(local).by()",
  "g.V().values('age').fold().dedup(local)", "g.inject(['a','a']).dedup(Scope.local)",
  "g.V().out().in().values('name').fold().dedup(Scope.local).unfold()",
  "g.inject(['a','b']).reverse()", "g.V().values('age').fold().order(local).by(desc).reverse()",
  "g.V().values('name').fold().reverse().unfold()",
  // AN ELEMENT-MEMBER list. Member admission is per ARM: the ops that read a member as a VALUE still
  // decline (a rowid is not a string), and the ops that do not — the local slices, and `order`/`dedup`
  // whose compare key and identity an Element answers by its id — now serve it. `by(k)`/`by(T.label)`/
  // `by(<body>)` are the ordinary `by()` vocabulary over a member-as-`ChildHost`.
  "g.V().fold().order(local)", "g.V().fold().order(local).by('age')", "g.V().fold().order(local).by('age', desc)",
  "g.V().fold().order(local).by(T.label)", "g.V().fold().order(local).by(__.values('age'))",
  'g.V().fold().dedup(local)', 'g.V().fold().range(local, 0, 2)',
  "g.V().fold().order(local).by('age').unfold().values('name')",
  // THE BRANCH FAMILY as one dispatcher over three builders, at BOTH per-row shapes: `coalesce` is a
  // UNION WITH PRIORITY (each arm's input gated on the earlier arms producing nothing), and `choose`
  // reaches a value stream now that its condition's subject comes from the FRAMING.
  "g.V().coalesce(__.out('knows'), __.out('created'))", "g.V().coalesce(__.out('foo'), __.out('bar'))",
  "g.V().coalesce(__.out('likes'), __.out('knows'), __.out('created')).groupCount().by('name')",
  "g.V().values('name').coalesce(__.constant('a'), __.constant('b'))",
  // A bare value-projection arm/condition: its productivity is `scalarChild(...).present` — a property
  // EXISTS — so `coalesce`/`choose`/`where` take a `values(k)`-headed body as a producing gate.
  "g.V().coalesce(__.values('name'), __.constant('x'))",
  "g.V().coalesce(__.values('lang'), __.values('name'))",
  // …over an ORDERED input: a `coalesce` is unordered in the corpus and a terminal one's per-traverser
  // order is unobserved, so the incoming position is dropped and the arms merge (mirrors `union`).
  "g.V().out('created').order().by('name').coalesce(__.values('name'), __.constant('x'))",
  "g.V().where(__.values('name'))", "g.V().not(__.values('lang'))",
  "g.V().choose(__.values('age'), __.values('name'))",
  "g.V().hasLabel('person').values('age').choose(__.is(P.gt(29)), __.constant('older'), __.constant('younger'))",
  "g.V().hasLabel('person').values('age').choose(P.eq(29), __.constant('matched'))",
  "g.V().hasLabel('person').values('age').choose(P.eq(29), __.constant('matched'), __.constant('other'))",
  // AN EXPLICIT EMPTY `by()` is the same request as NO `by()` — the traverser itself. Both `group()`
  // slots, at every host, and the `by()`-hosting exemption is now the whole `BY_HOSTS` set so a value
  // stream's `group().by(…)` reaches the arm that could always answer it.
  'g.V().group().by()', "g.V().group().by('name').by()", 'g.V().groupCount().by()',
  'g.V().properties().group().by()', "g.V().values('name').groupCount().by()", "g.V().values('age').group().by()",
  "g.V().values('name').groupCount().by(__.constant(1))",
  // A `T` TOKEN as the `choose()` CHOICE — no child body at all, so it needed carriage rather than a
  // projection: `byExpr` already knows every host's tokens, and a token is ALWAYS present, which is the
  // claim that proves the `Pick.unproductive` arm dead.
  "g.V().choose(T.label).option('person', __.out('knows')).option(Pick.none, __.identity())",
  "g.V().choose(T.label).option('blah', __.out('knows')).option('bleep', __.out('created')).option(Pick.none, __.discard()).values('name')",
  // `inject()` — a SCALAR source, and the largest single blocker measured over the corpus: 387 of
  // the 2,298 traversals begin with one. Its relation has NO channels: an injected row is one
  // traverser by construction, so there is no multiplicity to carry and nothing has established an
  // emission order. `count()` reads that off the CHANNEL rather than the step name, which is why it
  // becomes `COUNT(*)` here and `SUM(bulk)` over an element source.
  'g.inject(1)', 'g.inject(1,2,3)', "g.inject('a','b')", 'g.inject(null)', 'g.inject(true)',
  'g.inject(1).count()', 'g.inject(1,2,3).count()', 'g.inject(1,2).is(P.gt(1))',
  'g.inject(1,2).limit(1)', 'g.inject(1,2).skip(1)', 'g.inject(1,2,2).dedup()',
  // The scalar tail is now ONE fold whichever source fed it, so these reach the same arms.
  "g.V().values('name').dedup()", 'g.V().count().count()', "g.V().out().values('name').dedup()",
  // A SCALAR `order()` — a `Sort`, which is what separates it from the element one: over values
  // the lowering emits the ORDER BY as a relation (`SELECT p.v FROM c0 p ORDER BY p.v ASC`), whereas
  // over elements it folds into the FRAMING projection. `by(Order.asc|desc|shuffle)`
  // is a DIRECTION the algebra can state, so the modulator is covered rather than declining.
  'g.inject(1,2).order()', 'g.inject(3,1,2).order().limit(2)', "g.inject('b','a').order().by(Order.desc)",
  "g.V().values('age').order()", "g.V().values('age').order().range(1,3)",
  "g.V().values('name').order().by(Order.desc)", "g.V().values('age').order().is(P.gt(29))",
  "g.V().values('age').order().dedup()", "g.V().values('age').order().count()",
  // THE MODULATOR SEAM — `by()` as one vocabulary (`modulator.ts`), so a host gains all three
  // projections at once: identity, a property, and a `T` token. `dedup()` is the first ELEMENT host to
  // take a real one, and the projections are the same objects `order()` reads.
  "g.V().dedup().by('name')", "g.V().dedup().by('lang')", "g.E().dedup().by('weight')",
  "g.V().dedup().by(T.label)", "g.E().dedup().by(T.label)", "g.V().dedup().by(T.id)",
  "g.V().out().dedup().by('lang')", "g.V().dedup().by('lang').values('name')",
  "g.V().dedup().by('name').count()", "g.V().values('name').dedup().by()",
  // THE REDUCER FAMILY — four step names, and Phase 4.3's named deliverable. `sum`/`mean` are here;
  // `min`/`max` are NOT — they compare in Gremlin TYPE SPACE and project the winning row's own
  // Gremlin vtype (`int`/`long`/`string`) rather than a SQLite storage class, so they are asserted
  // in their own test below (`min/max compare in type space and frame the winner's own vtype`).
  "g.V().values('age').sum()", "g.V().values('age').mean()",
  "g.inject(1,2,3).sum()", "g.inject(1,2,3).mean()", "g.V().out().values('age').sum()",
  "g.V().values('age').asNumber(GType.DOUBLE).sum()", "g.V().values('age').sum().is(P.gt(100))",
  // `ProductiveByStrategy` is the OTHER side of the productivity rule, and it must stay a live
  // position: with it on, a traverser whose `by()` yielded nothing is KEPT.
  "g.withStrategies(ProductiveByStrategy).V().dedup().by('lang')",
  // `P.typeOf` — the whole FAMILY at once, which is the payoff for the predicate vocabulary being a
  // module: one arm serves `is`, `has`, `where` and every nesting inside `P.not`/`and`/`or`. All three
  // resolution modes are here, because each is a different question and only one of them reads a row.
  "g.V().values('age').is(P.typeOf(GType.INT))", "g.V().values('name').is(P.typeOf(GType.STRING))",
  "g.V().values('age').is(P.typeOf('Integer'))", "g.V().has('name',P.typeOf(GType.STRING))",
  "g.V().values('age').is(P.not(P.typeOf(GType.STRING)))", "g.inject(1).is(P.typeOf(GType.INT))",
  "g.V().count().is(P.typeOf(GType.LONG))", "g.V().count().is(P.typeOf(GType.STRING))",
  "g.V().values('age').is(P.typeOf(GType.BOOLEAN))", "g.V().values('age').is(P.typeOf(GType.NULL))",
  "g.V().values('age').is(P.typeOf(GType.VERTEX))",
  "g.V().values('age').is(P.typeOf(GType.INT)).is(P.gt(29))",
  // ELEMENT `order()` — a MINT of the emission-order channel, which is what made the channel set a
  // property of each RELATION rather than of the chain (`analyzeChain` reports `demandsEncounter`
  // FALSE for every one of these). The `by()` projections are the SAME vocabulary the scalar sort and
  // `dedup().by()` read, so all three arrive together; `by('lang')` is the productivity arm, where a
  // vertex without the key is DROPPED rather than sorted last.
  'g.V().order()', 'g.E().order()', "g.V().order().by('name')", "g.V().order().by('age')",
  "g.V().order().by('name',Order.desc)", "g.V().order().by(T.label)", "g.V().order().by(T.id)",
  "g.V().order().by('lang')", "g.withStrategies(ProductiveByStrategy).V().order().by('lang')",
  "g.V().hasLabel('person').order().by('age')", "g.V().out().order().by('name')",
  // …and it COMPOSES, which is the whole reason to mint a channel rather than fold an ORDER BY into
  // the framing SELECT: a slice after it reads the position, a movement after it re-mints, and a
  // retyping terminal carries it into the scalar tail.
  "g.V().order().by('name').limit(2)", "g.V().order().by('name').range(1,3)",
  "g.V().order().by('age').skip(1)", "g.V().order().by('name').dedup()",
  "g.V().order().by('name').count()", "g.V().order().by('name').values('name')",
  "g.V().order().by('name').out()", "g.V().out().order().by('name').limit(2)",
  // The BULKED slice: `movementCollapse` merges convergent walks into (element, N) rows, so a slice
  // after the order has to count TRAVERSERS and trim the boundary row's multiplicity (`bulkSlice`).
  // `LIMIT n` over those rows would answer a different question — the same rows, the wrong count.
  "g.V().both().order().by('name').limit(2)", "g.V().both().order().by('name').range(1,4)",
  "g.V().both().both().order().by('name').limit(3)",
  // `tail(n)` is the same slice read BACKWARDS, which is the whole of it once the position is a
  // relation property; `sample(n)` ranks by RANDOM() and filters the rank, so it is covered but
  // compared for SIZE rather than for rows (see the test below — `rowsVia` would compare two dice).
  'g.V().tail(2)', 'g.E().tail(1)', 'g.V().tail()', "g.V().hasLabel('person').tail(2)",
  'g.V().out().tail(2)', "g.V().values('name').tail(2)", 'g.V().tail(2).count()',
  "g.V().order().by('name').tail(2)", 'g.V().out().values("name").tail(1)',
  // THE LIST SHAPE — a traverser whose VALUE is a collection, ranked first by `rel-blockers` at 194
  // corpus traversals. A collection LITERAL is the larger half of the `jsonbList` arm, and the member
  // FRAME (`json_each` → an op per member → re-aggregate) is what the four vocabularies plug into:
  // `transform.ts` per member, `predicate.ts` over a member, `reducer.ts` over a member.
  'g.inject([1,2])', "g.inject(['a','b'])", 'g.inject([1,2],[3])', 'g.inject([])', 'g.inject([null,1])',
  "g.inject(['a','b']).unfold()", 'g.inject([1,2]).unfold().is(P.gt(1))', "g.inject(['a','b']).unfold().toUpper()",
  "g.inject(['a','b']).unfold().count()", "g.inject(['b','a']).unfold().order()",
  // member transforms — `Scope.local` maps over the members; the GLOBAL spelling is a permanent type
  // error on a collection (GLOBAL_STRING_ERRORS below), and a `StringLocalStep` local form carries a
  // per-member RUNTIME guard, so it is a PROGRAM (see LOCAL_STRING_GUARDED below), not a plain read.
  // `asString(Scope.local)` stays a read: `AsStringLocalStep` stringifies each member (no throw).
  "g.inject([1,2]).asString(Scope.local)",
  // member predicates — `all` is "no member FAILS", which differs from "every member passes" once a
  // predicate can be NULL. This was wrong until 2026-08-03 (L4 list-member-predicate).
  "g.inject(['a','a']).all(P.eq('a'))", "g.inject(['a','b']).all(P.eq('a'))",
  "g.inject(['a','b']).any(P.eq('a'))", "g.inject(['a','b']).none(P.eq('z'))",
  'g.inject([null,null]).all(P.eq(null))', 'g.inject([null,1]).none(P.eq(null))',
  "g.inject(['a','b']).any(P.gt('a'))",
  // member reductions — `conjoin` joins them, the reducer family reduces them, `count(Scope.local)`
  // counts them. All three retype the traverser, so the scalar tail continues from there.
  "g.inject(['a','b']).conjoin('+')", "g.inject(['a','b']).conjoin('')",
  'g.inject([1,2]).sum(Scope.local)', 'g.inject([1,2]).mean(Scope.local)',
  'g.inject([1,2]).min(Scope.local)', 'g.inject([1,2]).max(Scope.local)',
  "g.inject(['a','b']).count(Scope.local)", "g.inject(['a','b']).count(Scope.local).is(P.gt(1))",
  // member slices — position order, and `tail(Scope.local)` from the far end. A GLOBAL slice on the
  // same relation takes the stream's ROWS instead, which is the distinction the two arms draw.
  "g.inject(['a','b','c']).limit(Scope.local,2)", "g.inject(['a','b','c']).range(Scope.local,1,3)",
  "g.inject(['a','b','c']).skip(Scope.local,1)", "g.inject(['a','b','c']).tail(Scope.local,2)",
  "g.inject(['a','b']).limit(Scope.local,1).unfold()", 'g.inject([1,2],[3]).limit(1)',
  // `fold()` — the other half of the `jsonbList` arm, and the one whose MEMBER ENCODING is a runtime
  // decision: over a per-row-typed stream the members become self-describing `{t,v}` nodes iff SOME
  // member's type is lossy under its storage class, asked once for the whole list so the encoding
  // stays uniform. Every member reader then detects the envelope per member.
  "g.V().values('name').fold()", "g.V().values('age').fold()", 'g.V().count().fold()',
  'g.inject(1,2,3).fold()', "g.inject('a','b').fold()", "g.V().out().values('name').fold()",
  "g.V().values('name').order().fold()", "g.V().hasLabel('person').values('age').fold()",
  // …and the member frame over a FOLDED list is the same frame, which is the whole point of having
  // one: the typed decode rides inside `memberPayload`, so no op below knows which encoding it is on.
  "g.V().values('name').fold().unfold()", "g.V().values('age').fold().unfold().is(P.gt(29))",
  "g.V().values('name').fold().count(Scope.local)", "g.V().values('age').fold().sum(Scope.local)",
  "g.V().values('age').fold().max(Scope.local)", "g.V().values('age').fold().min(Scope.local)",
  "g.V().values('age').fold().mean(Scope.local)", "g.V().values('name').fold().conjoin(';')",
  "g.V().values('name').fold().limit(Scope.local,2)",
  "g.V().values('name').fold().tail(Scope.local,2)", "g.V().values('name').fold().all(P.eq('marko'))",
  "g.V().values('name').fold().any(P.eq('marko'))", "g.V().values('name').fold().unfold().toUpper()",
  // THE SET-OP FAMILY over a list OPERAND — six semantics, one frame, and the operand crosses the seam
  // as ONE bind (`jsonb('[…]')`) because its size is a function of DATA. `IS`, not `=`, so a null
  // member matches a null member; the four deduping results NAME their member order rather than
  // inheriting the dedup implementation's.
  "g.inject(['a','b']).combine(['c'])", "g.inject(['a','b']).intersect(['b','c'])",
  "g.inject(['a','b']).difference(['b'])", "g.inject(['a','b']).disjunct(['b','c'])",
  "g.inject(['a','b']).merge(['b','c'])", "g.inject(['a','b']).product(['c','d'])",
  "g.inject(['a',null]).intersect([null])", "g.inject(['a',null]).difference([null])",
  "g.inject(['a']).disjunct([])", "g.inject([]).merge(['a'])",
  "g.inject(['a'],['b']).combine(['c'])", "g.inject(['a','b']).combine(['c']).unfold()",
  "g.inject(['a','b']).merge(['c']).unfold()", "g.inject([1,2]).combine([3]).sum(Scope.local)",
  "g.V().values('name').fold().combine(['x'])", "g.V().values('name').fold().intersect(['marko'])",
  // THE SAME SIX over an ELEMENT-membered list — members compared by ROWID, which IS the element's
  // identity (`ElementHelper` hashes/equals an Element by id AND class). Both sides must be the same
  // element kind: `product` and a cross-kind operand decline (see DECLINED). The corpus only names the
  // ERROR forms (`combine(__.V())` — a non-folded stream is not iterable), so this is combinatorial
  // completeness: the element list works and set ops work, so set-ops-over-element-lists must.
  'g.V().fold().combine(__.V().fold())', 'g.V().fold().intersect(__.V().fold())',
  'g.V().fold().difference(__.V().fold())', 'g.V().fold().disjunct(__.V().hasLabel("person").fold())',
  'g.V().fold().merge(__.V().fold())',
  'g.V().hasLabel("person").fold().intersect(__.V().fold()).unfold().values("name")',
  'g.E().fold().combine(__.E().fold())',
  // `unfold()` of a NESTED list (a `product()`'s pair-lists) stays in the list vocabulary — one LIST
  // traverser per member, which is the same explode with a different payload column.
  "g.inject(['a','b']).product(['c']).unfold()", "g.inject(['a','b']).product(['c','d']).unfold().count(Scope.local)",
  // `is(P.typeOf(LIST|SET))` is a type ASSERT that RETYPES the stream — §11's trap, and expressible
  // now that the list shape exists. A MAP retype still declines (see DECLINED).
  "g.V().values('list').is(P.typeOf(GType.LIST))", "g.V().values('list').is(P.typeOf(GType.SET))",
  "g.V().values('list').is(P.typeOf(GType.LIST)).unfold()",
  "g.V().values('list').is(P.typeOf(GType.LIST)).count(Scope.local)",
  "g.V().values('age').is(P.typeOf(GType.LIST))",
  // THE LEADING COERCION PREFIX, folded at COMPILE TIME. `asNumber`/
  // `asBool`/`asDate` raise TinkerPop's exact parse and overflow messages, which SQL cannot raise at
  // all — a `CAST` answers `1` for `'1,000'` and epoch 0 for an invalid date, which is §11's "a
  // required error became a plausible value". So the fold raises those messages itself rather than
  // emitting a `CAST`, and a value that does not parse raises the reference's message (see the coercion test below).
  "g.inject('1').asNumber()", "g.inject('1','2').asNumber(GType.INT)", 'g.inject(1).asNumber(GType.LONG)',
  "g.inject('true').asBool()", "g.inject('2023-08-02T00:00:00Z').asDate()",
  "g.inject('1','2').asNumber(GType.INT).sum()", "g.inject('1').asNumber().is(P.gt(0))",
  // `has()`'s three ARGUMENT SHAPES, all of one step. The 3-arg form is the label constraint AND the
  // property one, exactly as `HasStep` composes them; a `T`-token key asks about the ELEMENT rather
  // than a property row. Each was its own decline and each is a composition of clauses already built.
  "g.V().has('person','name','marko')", "g.V().has('person','age',P.gt(30))",
  "g.V().has('person','name',P.within('vadas','peter'))", "g.E().has('knows','weight',0.5)",
  "g.V().out().has('person','name','josh')",
  // `T.label` is ANY label, not the first — a vertex may carry several, so it is an EXISTS over its
  // label rows and NOT `modulator.ts`'s token projection (which takes the first by insertion order).
  "g.V().has(T.label,'person')", "g.V().has(T.label,P.eq('person'))",
  "g.V().has(T.label,P.within('person','software'))", "g.E().has(T.label,'knows')",
  "g.V().out().has(T.label,'software')", "g.V().has(T.label,'person').has('age',29)",
  // `T.id` is the EXTERNAL id (`COALESCE(uid, id)`), read through a correlated scan so the clause is
  // the same at the source and after a movement.
  'g.V().has(T.id,1)', 'g.E().has(T.id,7)', 'g.V().has(T.id,P.gt(2))',
  // `constant(c)` REPLACES the traverser's value with a literal — a shape boundary over an element
  // stream, a projection over a value one, and channel-preserving either way: a constant changes the
  // VALUE, not the traverser. Framed `unknown`, because a compile-time tag would
  // be a claim the argument's declared type does not support.
  'g.V().constant(1)', 'g.V().constant(null)', "g.V().constant('x')", 'g.V().out().constant(true)',
  "g.V().values('name').constant('x')", "g.inject(1).constant('a')", 'g.V().constant(1).count()',
  'g.V().constant(123).is(P.gt(1))',
  // …and `constant(c).fold()` as a set-op OPERAND is the same fact rather than a special case: a
  // one-member list known at compile time.
  "g.V().values('age').fold().merge(__.constant(27).fold())",
  "g.V().values('age').fold().intersect(__.constant(27).fold())",
  "g.inject(['a']).merge(__.constant('b').fold())",
  // A rooted SUB-READ operand: the members are only known at RUN TIME, so the operand is a relation —
  // lowered by the SAME fold into the same algebra and read through a `Scalar` expression. No opaque
  // escape node, and if the inner chain is not covered the refusal propagates outward.
  "g.inject(['a','b']).merge(__.V().values('name').fold())",
  "g.V().values('age').fold().merge(__.V().values('age').fold())",
  "g.V().values('name').fold().intersect(__.V().values('name').fold())",
  "g.V().values('name').fold().difference(__.V().hasLabel('person').values('name').fold())",
  "g.V().values('name').fold().combine(__.V().values('nonexistant').fold())",
  "g.V().values('age').fold().disjunct(__.V().values('age').fold())",
  "g.V().values('name').fold().product(__.V().values('name').order().fold())",
  // THE ALIAS CHANNEL — `as()` writes a JSONB path HISTORY (array-always, appended on rebind) and
  // `select(label)` re-enters whatever shape the label holds. Both are shape-PRESERVING/shape-DECIDED
  // rather than position-specific, so the same lowering serves every host, and `select` back to an
  // ELEMENT is what makes the shape boundary two-way (`elementTail` is re-entered, not duplicated).
  'g.V().as("a")', 'g.V().as("a").out()', 'g.V().as("a","b").out()',
  'g.V().as("a").out().as("b")', 'g.V().as("a").out().as("a")',
  'g.V().as("a").out().select("a")', 'g.V().as("a").out().as("b").select("b")',
  'g.V().as("a").out().select("a").out()', 'g.V().as("a").out().select("a").count()',
  // THE SACK — a per-traverser accumulator, and an ordinary carried CHANNEL here rather than a
  // shoehorn: `src/channels.ts` already declared the role's merge/barrier/group policies, so seeding,
  // folding and reading it is three projections. It composes with the alias and path channels for
  // free.
  'g.withSack(0).V()', 'g.withSack(0L).V().sack(sum).by("age").sack()',
  'g.withSack(0.0d).V().outE().sack(Operator.sum).by("weight").inV().sack().sum()',
  'g.withSack(2).V().sack(Operator.div).by(__.constant(4.0d)).sack()',
  'g.V().sack(assign).by("age").sack()',
  // A MODULATED select reads the SELECTED element and a MULTI-label one packages several — one
  // lowering at every arity (`selectKeys`). A property `by()` carries the label's stored `vtype`
  // beside the value, and a multi-label select is a RECORD. Both are pinned in
  // `test/L2-sql/scalar.sql.test.ts`.
  "g.V().as('a').out().select('a').by(__.out().count())",
  'g.V().as("a").out().as("a").select(Pop.first,"a")', 'g.V().as("a").out().as("a").select(Pop.last,"a")',
  // A multi-bound label's history is an ordinary LIST: Pop.all always returns it, and Pop.mixed
  // does too once the linear binding count proves it is not a singleton.
  'g.V().as("a").out().as("a").select(Pop.all,"a")', 'g.V().as("a").out().as("a").select(Pop.mixed,"a")',
  // …over a VALUE stream, where the label's own `t` field is the only place a per-row `vtype` COLUMN
  // can survive becoming JSON — which is what keeps the comparison numeric after the round trip.
  'g.V().values("age").as("a").select("a")', 'g.V().values("age").as("a").select("a").is(P.gt(30))',
  'g.V().values("name").as("a").select("a").count()',
  'g.V().as("a").values("name").select("a")', 'g.V().as("a").values("name").select("a").values("name")',
  // …and over a LIST stream, where the whole collection is ONE entry tagged `list`, carrying the
  // member encoding the fold produced so the member frame is re-entered with it rather than a guess.
  'g.V().values("name").fold().as("a").select("a")',
  'g.V().values("name").fold().as("a").select("a").unfold()',
  'g.inject(["a","b"]).as("a").select("a").count(Scope.local)',
  // THE ARM MERGE — `union()` as an n-ary `Union`, and the arms need no machinery of their own: an
  // arm body over the current traverser IS the ordinary fold started at that relation, so the input
  // node is simply referenced once per arm and `name` decides whether it becomes a CTE.
  'g.V().union(__.out(), __.in())', 'g.V(1).union(__.out("knows"), __.out("created"))',
  'g.V().union(__.out().out(), __.in())', 'g.V().union(__.out(), __.in(), __.both())',
  'g.V().union(__.out(), __.in()).count()', 'g.V().union(__.out(), __.in()).values("name")',
  'g.V().hasLabel("person").union(__.out("knows"), __.out("created")).dedup()',
  // …composing with the alias channel, with nothing written between the two features.
  'g.V().as("a").union(__.out(), __.in()).select("a")',
  // …and over a VALUE parent, where the arms are scalar bodies rather than movements.
  'g.V().values("name").union(__.identity(), __.identity())',
  // …over an ORDERED input, and with an ORDER inside an arm: a `union` is a fresh UNORDERED stream
  // (every scenario of `Union.feature` asserts unordered), so the incoming position and an arm-local
  // `order().limit()`'s spent position are both dropped and the ordered/limited arms merge.
  "g.V().order().by('name').union(__.out(), __.in())",
  'g.V().union(__.out("created").order().by("name"), __.out("knows").order().by("name"))',
  'g.V().union(__.out("created").order().by("name").limit(2), __.out("knows").order().by("name").limit(1))',
  // `choose(cond, then[, else])` is the SAME merge over arms GUARDED by the condition and its
  // negation — so it is the arm merge plus a predicate, not a second branch implementation. An absent
  // `else` is `identity`: a non-matching traverser passes through, which an empty arm body expresses
  // exactly (`continueAs` over zero steps returns what it was handed).
  'g.V().choose(__.has("name","vadas"), __.out("knows"), __.in("knows"))',
  'g.V().choose(__.hasLabel("software"), __.in("created"))',
  'g.V().choose(__.hasLabel("person"), __.out(), __.in())',
  'g.V().choose(__.out("created"), __.out("knows"), __.in("knows"))',
  'g.V().choose(__.has("name","marko"), __.out(), __.in()).count()',
  // …over an ORDERED input, and with an ORDER inside an arm: a `choose` is a `BranchStep` like `union`
  // (`Choose.feature` asserts every scenario unordered), so the incoming/arm-local position is dropped
  // and the ordered/limited arms merge.
  'g.V().order().by("name").choose(__.hasLabel("person"), __.out(), __.in())',
  "g.V().choose(__.values('age').is(P.lte(30)), __.out().order().by('name').limit(1), __.out().order().by('name').limit(2))",
  // A CORRELATED child body is the ordinary fold too, started at the correlated child — so every step
  // the loop knows is available inside a `where`/`filter`/`not` body at once, not one at a time.
  'g.V().where(__.out().order())', 'g.V().where(__.out().count().is(P.gt(1)))',
  'g.V().where(__.out().hasLabel("person").order().by("name").range(1,2))',
  'g.V().where(__.out().limit(1))', 'g.V().not(__.out().count().is(P.gt(2)))',
  // A body that PROJECTS a value and then TESTS it is a COMPARISON, not an existence question — the
  // seam's third predicate answer. `correlatedExists` declines every body whose head is not a
  // movement, so these were the branch/where family's shared gap.
  "g.V().where(__.values('age').is(P.gt(30)))", "g.V().not(__.values('age').is(P.gt(30)))",
  "g.V().choose(__.values('age').is(P.gt(30)), __.out(), __.in())",
  // PRODUCTIVITY does NOT fall out of SQL's null semantics, and these are the shapes that proved it.
  // `predicateExpr` spells `neq` null-safely — right for a property ROW, wrong for a projection that
  // may not exist — so a productivity conjunct is its own term; and a NEGATION must be null-safe,
  // because `NOT NULL` is NULL and dropped the traverser from both sides at once. Both directions of
  // each predicate are listed, since the defect was visible only by comparing them.
  "g.V().where(__.values('age').is(P.eq(29)))", "g.V().not(__.values('age').is(P.eq(29)))",
  "g.V().where(__.values('age').is(P.neq(29)))", "g.V().not(__.values('age').is(P.neq(29)))",
  "g.V().where(__.values('age').is(P.within(29,32)))", "g.V().not(__.values('age').is(P.within(29,32)))",
  // A FILTER-ONLY body is the seam's FIRST predicate answer, and `where`/`filter`/`not` had been
  // offered only the other two — a body every clause of which the source-filter builder already made.
  "g.V().where(__.has('name','marko'))", "g.V().filter(__.has('age',P.gt(27)))",
  "g.V().not(__.has('age'))", "g.V().where(__.hasLabel('person').has('age',P.gt(30)))",
  // THE CONNECTIVE STEPS, which are the connective over the answers their arms already have. They
  // land in the one clause builder `bodyPredicate` loops over, so they compose at every filter
  // position: at the source, nested in a `where()`, inside each other, and under a `not()`.
  "g.V().and(__.has('age',P.gt(27)), __.outE().count().is(P.gte(2)))",
  "g.V().or(__.has('age',P.gt(27)), __.outE().count().is(P.gte(2)))",
  "g.V().and(__.outE(), __.has(T.label,'person').and().has('age',P.gte(32)))",
  "g.V().or(__.outE('knows'), __.has(T.label,'software').or().has('age',P.gte(35)))",
  "g.V().not(__.or(__.has('age',P.gt(30)), __.hasLabel('software')))",
  "g.V().where(__.and(__.has('age'), __.out('created')))",
  // THE PER-TRAVERSER CHILD HOSTS — `map`/`flatMap`/`local`, one lowering and three cardinality
  // policies over the same correlated scalar. `map` takes the body's FIRST result and drops the
  // traverser when there is none (`TraversalMapStep.processNextStart`); the other two emit every
  // result, so they may take that expression only where the body had exactly ONE to give.
  "g.V().map(__.outE().count())", "g.V().flatMap(__.outE().count())", "g.V().local(__.outE().count())",
  "g.V().map(__.out().count())", "g.V().hasLabel('person').map(__.out('created').count())",
  // A MULTI-VALUED property read is the case the policies disagree about, so both directions are
  // listed: `map` picks the insertion-order first, `local` declines (see DECLINED).
  "g.V().map(__.values('name'))", "g.V().map(__.values('age'))",
  // …and an ENDPOINT re-root is single-valued BY THE SCHEMA without being a reducer, which is the
  // shape that proved the policy could not be read off the framing.
  "g.E().map(__.outV())", "g.E().local(__.outV())", "g.E().flatMap(__.inV())",
  // A FAN-OUT body under `flatMap`/`local` — the general child REJOIN (`flatMapRejoin`), not a
  // correlated scalar. A barrier-free body is TRANSPARENT (`flatMap(__.out())` is `out()`), so it
  // lowers via the seam's `rows` arm with `origin` dropped after. `map` is excluded (takes the first,
  // a per-origin window) and a barrier in the body declines (per-origin scoping, a later increment).
  "g.V().flatMap(__.out())", "g.V().local(__.out())", "g.V().local(__.out().out())",
  "g.V().flatMap(__.out().values('name'))", "g.V().local(__.out().values('name'))",
  "g.V().local(__.outE().inV())", "g.V().local(__.out().has('lang','java'))",
  "g.V().local(__.out()).dedup()",
  // A TRAILING GLOBAL SLICE is scoped PER ORIGIN — n per HOST, a `row_number` window
  // PARTITIONED by `origin` (`partitionedSlice`). limit/skip/range; `tail` (count-from-end) declines.
  "g.V().local(__.out().limit(1))", "g.V().local(__.out().range(0,2))", "g.V().local(__.out().skip(1))",
  "g.V().local(__.outE('knows').limit(1)).inV()", "g.V().local(__.outE().limit(1)).inV().values('name')",
  // A PER-ORIGIN FOLD — a list per HOST, the correlated subquery `scalarChild` builds; a sink emits `[]`
  // from `foldElements`' own `COALESCE` seed (no per-origin seed machinery). List tail (`unfold`) reads it.
  "g.V().local(__.out().fold())", "g.V().local(__.out().values('name').fold())",
  "g.V().local(__.outE().fold())", "g.V().local(__.outE().values('weight').fold())",
  "g.V().local(__.out().fold()).unfold()", "g.V().local(__.outE().fold()).unfold()",
  // A body that DROPS — `map(__.values('age'))` above emits nothing for the two software vertices,
  // which is the productivity signal being required rather than assumed.
  "g.V().map(__.values('age')).count()",
  // A SUB-TRAVERSAL `by()` projection — the child seam. A flat value body is an EXPRESSION over the
  // outer row; a body that MOVES and then REDUCES is `correlatedExists` minus the EXISTS, read for its
  // value. Both arms reach every by() host at once, which is why one entry per host is worth having.
  "g.V().dedup().by(__.out().count())", "g.V().order().by(__.out().count()).values('name')",
  "g.V().order().by(__.values('name'))", "g.V().dedup().by(__.values('name').toUpper())",
  // A GROUP host is deliberately absent from this list: a group row's shape and answer are pinned by
  // `test/compiler/group-properties.exec.test.ts`, which is where that belongs.
  // A MAP LITERAL as a source — the SOURCE half of the map shape. `injectMap` builds the same
  // self-describing pairs-array blob `group()`/`valueMap()` aggregate, only at compile time, so the whole
  // re-enterable map tail (`select(Column.*)`, `select(<key>)`, `unfold()`, `count(Scope.local)`, a slice)
  // works over a literal the moment the producer exists. A non-string key (a `T` token) and an
  // unserializable value decline (the write substrate owns those).
  'g.inject([a:"a",b:"b"])', 'g.inject([name:"marko",age:null])', 'g.inject([a:"a",b:2])',
  'g.inject([a:1,b:2]).count(Scope.local)', 'g.inject([a:1,b:2]).select("a")',
  'g.inject([a:1,b:2]).select(Column.keys)', 'g.inject([a:1,b:2]).select(Column.values)',
  'g.inject([a:1,b:2]).unfold()', 'g.inject([a:1],[b:2]).count()',
  // MULTI-KEY `select(k1,k2,…)` over a map — a SUB-MAP projection in select order, filtered when a key
  // is absent (`SelectStep` → `EmptyTraverser`). A present-null key is KEPT (`Scoping.getScopeValue`
  // reads `containsKey`), which the corpus case pins.
  'g.inject([name:"marko",age:null]).select("name","age")', 'g.inject([a:1,b:2,c:3]).select("a","c")',
  'g.inject([a:1,b:2]).select("b","a")', 'g.inject([a:1,b:2]).select("a","b").unfold()',
];

/**
 * Shapes that must be REFUSED, one per reason, so a refusal lost to an over-eager lowering is caught
 * by name. `g.V().count()` is the ordinary "step not learned yet"; the rest are the guards.
 */
const DECLINED = [
  "g.V().bothE().otherV()",           // otherV reads the entering vertex — carried state not modelled
  // `g.V().out().select('a')` LEFT this list: a label bound nowhere is the EMPTY RESULT rather than a
  // refusal (`Select.feature:578-596` pins `g.V().select("a")` as empty and its `count()` as `0`), and
  // RelIR now expresses that as the `Filter(false)` §3.3 names. The remaining guard is the one where
  // being empty would be WRONG: a name that resolves in a scope this record builder cannot see.
  "g.V().groupCount('a').select('a')", // a NAMED COLLECTION resolves as a side effect, not as a label
  // NOTE: `union(__.out())` used to sit here — a SINGLE arm. `union(t)` IS `t` (`UnionStep`'s one branch
  // takes every traverser), so it is no longer refused; a single REDUCTION arm still declines (it owes the
  // batched empty-input gate), which is what `union(__.count())` below pins.
  "g.V().union(__.count())",           // a SINGLE reduction arm: still owes the arm-major `Exists(input)` gate
  "g.V().union(__.as('b').out(), __.in())",  // an arm that BINDS a label owes each arm a remap + NULL pad
  // NOTE: `union(__.values('name'), __.constant('x'))` used to sit here — two scalar arms that
  // disagree only on their TYPE TAG. That is no longer refused: §6·7's lattice meets them at a
  // per-row `vtype` column (`meetScalarArms`), so the payload agrees and the Union is positional
  // again. A SHAPE disagreement (a variant merge) is also covered now for a `count`/`out()`/`fold()`
  // mix — `union(__.out(), __.count())`, `union(__.fold(), __.out())` are arm-major over a variant
  // (`mixedBranch`, a list-of-elements member framed by `listPayloadExpr`) — so they are no longer here.
  // What still declines is a variant with a MAP arm, which has no variant `vk`.
  "g.V().union(__.count(), __.valueMap('name'))", // scalar + MAP: variantArmOf has no vk for a map
  "g.V().where(__.out().values('age').sum())",  // a NUMERIC reducer over an EMPTY child: SQL yields one
  // NULL row where Gremlin yields NO traverser, so a bare EXISTS would answer true where the
  // reference rejects. count()/fold() are not this — both emit a traverser for an empty child.
  // NOTE: the OPTION-MAP form used to sit here and is covered now — see the option-map test below.
  // What it needed was not a new gate but a PRESENCE signal, because `Pick.none` and
  // `Pick.unproductive` are distinguishable only where the choice reports productivity BESIDE its
  // value. What still declines is a choice whose body cannot report one, and a `T`-TOKEN choice
  // (`choose(T.label)`, no nested body at all), which is a different projection.
  'g.inject()',                       // the EMPTY relation, which `Values` refuses to express (§3.3)
  "g.inject([1,2],3)",                // MIXED list/scalar args: the VARIANT shape, not either of them
  // `g.inject(['a','b']).order(Scope.local)` LEFT this list: the member sort landed, and it takes the
  // vtype-aware compare key from `byExpr` rather than a second policy. The guard that REPLACES it is
  // the one that still holds — an ELEMENT list's members are ROWIDS, so every member op declines
  // (`isBareList`): a question about the element is the child seam's, not the list module's.
  // ELEMENT-list set ops are covered same-kind (see COVERED), but two shapes stay refused. A CROSS-KIND
  // operand never matches on identity (`ElementHelper.areEqual` demands the same class) AND its merge/
  // combine would frame a MIXED-element result the payload layer cannot; `product` over elements makes
  // PAIR-lists whose rowids would frame bare (as integers), losing the element objects — a distinct shape.
  'g.V().fold().intersect(__.E().fold())',
  'g.V().fold().product(__.V().fold())',
  "g.V().values('age').is(P.typeOf(GType.MAP))", // a MAP retype needs the map shape, not a decode
  // A `T` TOKEN IS LEGAL PER HOST, NOT PER GRAMMAR. All four parse; each host answers its OWN pair and
  // declines the other, because answering off the wrong row is the plausible-wrong-answer class.
  'g.V().order().by(T.key)',          // an element has no key
  'g.E().properties().id()',          // an edge `Property` is not an Element — no id, no label
  'g.E().properties().label()',
  "g.inject('a').inject('b')",        // a second inject is a UNION with the first, not a source
  'g.inject(1,2).order(Scope.local)', // LOCAL scope: a per-traverser sort of a LIST, a different arm
  'g.V().order().by(__.constant(null))', // productive null: ByChild does not yet carry emission separately
  'g.V().dedup().by(__.constant(null))', // productive null: ByChild does not yet carry emission separately
  // A `groupCount` site beside a `group` site on ONE label is not one grouping: `registerIfAbsent` keeps
  // the FIRST reducer, so the reference merges a `Map<K,Long>` with a `Map<K,List<V>>` through
  // `GroupCountBiOperator` and raises. Refusing is what comparing the aggregation recipe as DATA buys —
  // picking one site's recipe would answer a plausible map (`sameGroupRecipe`, `compiler/rel/map.ts`).
  'g.V().groupCount("a").by("name").out().group("a").by("name").cap("a")',
  // A POOLED value (`group("a").by(k).by(<reducing traversal>)`) has no `(key, contribution)` row behind
  // it — the members' child rows pool and the barrier reduces the pool once — so a SECOND site has
  // nothing to union onto it, and the label declines rather than keeping one site's finished map.
  'g.V().group("a").by(T.label).by(__.outE().values("weight").sum()).out().group("a").by(T.label).by(__.outE().values("weight").sum()).cap("a")',
  // `select(label).by(key)` as a CHILD BODY — the by() modulator over an alias read, inside a host.
  // The `select(label).values(key)` spelling of the same thing is covered; this one is not.
  'g.V().as("a").out("knows").map(__.select("a").by("name"))',
  // The per-traverser hosts' own refusals, each a CARDINALITY the correlated scalar cannot honour.
  // A vertex property key is MULTI-VALUED, so an every-result policy needs the rejoin rather than the
  // first; a fan-out body has no "first" a correlated subquery can name; a bare `count()` is a barrier
  // with no movement to correlate. (A per-origin `fold()`/slice now LOWERS — see COVERED.)
  "g.V().local(__.values('name'))",
  "g.V().map(__.out())",
  "g.V().local(__.count())",
  // A numeric reducer over an EMPTY child: the seam cannot state productivity (the aggregate is NULL
  // both there and over an all-null input that `MaxLocalStep` genuinely emits), and `map` must drop.
  "g.V().local(__.out().values('age').sum())",
];

describe('the RelIR spine', () => {
  // COVERED — the traversal compiles, and to SQL the platform will actually run. `cfLimitViolation`
  // is asked rather than assumed: a plan that renders over the DO's caps is not coverage, it is a wall
  // only Bun cannot see.
  for (const gremlin of COVERED) {
    test(`${gremlin} compiles to a DO-legal plan`, () => {
      const plan = read(gremlin);
      expect(cfLimitViolation(plan.sql, plan.binds), gremlin).toBeNull();
    });
  }

  // DECLINED — the KNOWN GAPS, asserted as gaps. An uncovered shape raises `UnsupportedTraversal`,
  // so what this pins is that the compiler fails CLOSED on each: a clear refusal, never a
  // plausible answer to a different question. A name that starts compiling FAILS here, which is the
  // prompt to move it into COVERED — the list is a worklist, not a permanent exclusion.
  for (const gremlin of DECLINED) {
    test(`${gremlin} is refused, not mis-answered`, () => {
      expect(() => compile(gremlin, {}), gremlin).toThrow(UnsupportedTraversal);
    });
  }

  // A GLOBAL (non-`Scope.local`) string transform over a LIST is a permanent type error, not a gap:
  // every `*GlobalStep` throws `IllegalArgumentException` on a non-String receiver, and the traverser
  // IS the list (`vendor/tinkerpop/gremlin-core/.../map/*GlobalStep.java`). So the ANSWER is that error
  // and the message is the reference's verbatim (§6·5) — the corpus checks the prefix `containing text`,
  // which is what these assert. `asString` is deliberately absent: its global form stringifies (see
  // COVERED — `g.inject([1,2]).asString(Scope.local)` and its global answer are real values, not errors).
  const GLOBAL_STRING_ERRORS: [string, string][] = [
    ['toUpper', "g.inject(['a','b']).toUpper()"], ['toLower', "g.inject(['a','b']).toLower()"],
    ['trim', "g.inject(['a','b']).trim()"], ['lTrim', "g.inject(['a','b']).lTrim()"],
    ['rTrim', "g.inject(['a','b']).rTrim()"], ['length', "g.inject(['a','b']).length()"],
    ['substring', "g.inject(['aa','bb']).substring(1,2)"], ['replace', "g.inject(['a','b']).replace('a','b')"],
  ];
  for (const [step, gremlin] of GLOBAL_STRING_ERRORS) {
    test(`${gremlin} raises TinkerPop's type error`, () => {
      expect(() => compile(gremlin, {}), gremlin)
        .toThrow(`The ${step}() step can only take string as argument`);
    });
  }

  // `range(low, high)` with `low > high` (both != -1) is a `RangeGlobalStep`/`RangeLocalStep` CONSTRUCTOR
  // throw (`Not a legal range: [low, high]`, `RangeGlobalStep.java:65-66`) — the traversal's ANSWER is
  // that error, so `sliceOf` raises a `ValueParseError` that PROPAGATES (§6·5) rather than declining. Both
  // scopes, though the corpus names only the global form — logical completeness, one authority.
  test('an illegal range raises, at either scope', () => {
    for (const gremlin of [
      'g.V().range(2, 1)', 'g.V().range(3, 2)',
      'g.V().fold().range(Scope.local, 2, 1)', "g.inject(['a','b','c']).range(Scope.local, 2, 1)",
    ]) expect(() => compile(gremlin, {}), gremlin).toThrow('Not a legal range:');
  });

  // A NULL OPERAND is `Compare`'s null-space rule (comparable(f,s) is false unless BOTH null,
  // `GremlinValueComparator.java:314-316`): `eq(null)`→IS NULL, `neq(null)`→IS NOT NULL, `gt/lt(null)`
  // never, `gte/lte(null)`→IS NULL. Verified against `semantics/Comparability.feature`.
  test('a null predicate operand is the null-space compare', async () => {
    const cases: [string, unknown[]][] = [
      ['g.inject(1.0d).is(P.eq(null))', []], ['g.inject(1.0d).is(P.neq(null))', [1.0]],
      ['g.inject(1.0d).is(P.gt(null))', []], ['g.inject(1.0d).is(P.gte(null))', []],
      ['g.inject(1.0d).is(P.lt(null))', []], ['g.inject(1.0d).is(P.lte(null))', []],
      ['g.inject(null).is(P.eq(null))', [null]], ['g.inject(null).is(P.gte(null))', [null]],
      ['g.inject(null).is(P.neq(null))', []],
    ];
    for (const [gremlin, want] of cases)
      expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toEqual(want);
  });

  // ⚠️ NaN IS null on this substrate — a DOCUMENTED DEVIATION (feature-support-matrix §10). SQLite has
  // no NaN, so `inject(NaN)` folds to `null` at the front door (`const.ts`), a constant not a bind.
  // `±Infinity` is representable (a real overflow literal) and inlines faithfully.
  test('NaN folds to null; Infinity inlines as a constant, no bind', () => {
    for (const [gremlin, sql] of [
      ['g.inject(NaN)', 'VALUES (NULL)'], ['g.inject(Infinity)', 'VALUES (9e999)'],
      ['g.inject(-Infinity)', 'VALUES (-9e999)'],
    ] as const) {
      const plan = read(gremlin);
      expect(plan.binds.length, gremlin).toBe(0);
      expect(plan.sql, gremlin).toContain(sql);
    }
    // The deviation's consequence: NaN matches the null-space eq (Java returns empty).
    expect(read('g.inject(NaN).is(P.eq(null))').sql).toContain('IS NULL');
  });

  // A LOCAL (`Scope.local`) `StringLocalStep` transform maps over the members, but throws on any member
  // that is neither null nor a String (`StringLocalStep.java:54-58`). The member type is per-row/unknown
  // here (never a static tag), so the check is a RUNTIME guard binding — the plan is a PROGRAM whose
  // guard raises iff a non-string member EXISTS. Not a decline (that would refuse the valid all-string
  // case) and not silent coercion (SQLite `upper(1)`=`'1'` is the wrong answer §12). `asString(local)`
  // takes NO guard — `AsStringLocalStep` stringifies each member — so it stays a plain read (COVERED).
  test('a local StringLocalStep transform is a guarded program', () => {
    for (const gremlin of [
      "g.inject(['a','b']).toUpper(Scope.local)", "g.inject([' a ']).trim(Scope.local)",
      "g.inject([' a ']).lTrim(Scope.local)", "g.inject([' a ']).rTrim(Scope.local)",
      "g.inject(['ab','cd']).substring(Scope.local,1)", "g.inject(['ab']).replace(Scope.local,'a','z')",
      "g.inject(['ab','c']).length(Scope.local)", "g.V().values('name').fold().toUpper(Scope.local)",
    ]) expect(compile(gremlin, {}).kind, gremlin).toBe('program');
  });

  // The guard FIRES on a provably-non-string member (a literal int list, an `age` fold), keeps a valid
  // all-string list (a `name` fold, a null-bearing string list), and never fires for `asString`.
  test('a local StringLocalStep guard raises on a non-string member, passes strings', async () => {
    for (const gremlin of [
      'g.inject([1,2]).trim(Scope.local)', 'g.inject([1,2]).length(Scope.local)',
      "g.inject(['a',1]).trim(Scope.local)",
      'g.V().hasLabel("person").values("age").order().fold().trim(Scope.local)',
    ]) expect(() => exec(seededStore()).buffers(gremlin, {}, {}), gremlin)
      .toThrow('step can only take string or list of strings');
    const want: [string, unknown[]][] = [
      ["g.inject(['a','b']).trim(Scope.local)", [['a', 'b']]],
      ['g.inject(["feature","tESt",null]).toUpper(Scope.local)', [['FEATURE', 'TEST', null]]],
      ["g.V().values('name').order().fold().toUpper(Scope.local)", [['JOSH', 'LOP', 'MARKO', 'PETER', 'RIPPLE', 'VADAS']]],
      ['g.inject([1,2]).asString(Scope.local)', [['1', '2']]],
    ];
    for (const [gremlin, expected] of want)
      expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toEqual(expected);
  });

  test('a re-source carries an alias into a following write', async () => {
    // `GraphStep` splits the incoming traverser, rather than creating a fresh one: `from('a')`
    // therefore still names marko after the current object was replaced by vadas. Counting the
    // graph before and after checks the semantic carriage, not merely that the program compiled.
    const graph = seededStore();
    const count = async () => Number((await decodeAll(exec(graph).buffers("g.E().hasLabel('knows').count()", {}, {})))[0]);
    const before = await count();
    await decodeAll(exec(graph).buffers("g.V().has('name','marko').as('a').V().has('name','vadas').addE('knows').from('a')", {}, {}));
    expect(await count()).toBe(before + 1);

    // A scalar source has an implicit bulk of one. GraphStep makes it explicit before the cross
    // join, so `both()` may take the collapse path and `count()` still sees every traverser.
    expect(await decodeAll(exec(seededStore()).buffers('g.inject(0).V().both().count()', {}, {})))
      .toEqual([12]);
    // The outer inject position is also real order: GraphStep exhausts its graph iterator for the
    // first injected traverser before moving to the second, so this limit takes ids 1 and 2.
    expect(await decodeAll(exec(seededStore()).buffers('g.inject(0,1).V().limit(2).id()', {}, {})))
      .toEqual([1, 2]);
  });

  test('Pop.all and a non-singleton Pop.mixed re-enter as typed lists', async () => {
    // `as()` stores a history entry, not a second representation of the value. Pop.all projects
    // every entry through the list member encoding; Pop.mixed has the same list answer once its
    // linear binding count is known to exceed one.
    for (const pop of ['all', 'mixed']) {
      const gremlin = `g.inject("a").as("x").concat("b").as("x").select(Pop.${pop},"x")`;
      expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toEqual([['a', 'ab']]);
    }
  });


  test('a withSideEffect CONSTANT is resolved by the write parse, not refused by the router', async () => {
    // §6·6's third piece. `withSideEffect(k, <literal>)` is a compile-time constant the front-end
    // already extracted, and the shared write parse (`parseProperty`/`mergeMaps`) has always taken
    // one — but `compiler.ts` gated compilation on `sideEffects.size === 0`, so these
    // never reached the lowering at all and read as uncovered vocabulary. They are WRITES, so they
    // compile to a `program` rather than a `read`, which is why the COVERED loop above cannot hold
    // them: it compares rendered SQL, and a program is a sequence of statements.
    const cases = [
      'g.withSideEffect("a", "marko").addV().property("name", __.select("a")).values("name")',
      'g.withSideEffect("a", "name").addV().property(__.select("a"), "marko").values("name")',
      'g.withSideEffect("c", [(T.label):"person", "name":"stephen"]).mergeV(__.select("c"))',
      'g.withSideEffect("c", [(T.label):"person", "name":"marko"]).withSideEffect("m", ["age":19]).mergeV(__.select("c")).option(Merge.onMatch, __.select("m"))',
    ];
    for (const gremlin of cases) {
      const plan = compile(gremlin, {});
      expect(plan.kind, gremlin).toBe('program');
      // The ANSWER, not just that it compiled: the wire bytes are compared decoded rather than as
      // rendered SQL (a write's plan is a sequence of statements).
      // `decodeAll` is ASYNC (the client's deserializers read from a StreamReader), so this AWAITS —
      // an unawaited promise is truthy and `toBeDefined` would pass on it trivially.
      expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toBeDefined();
    }
  });



  test('a T token on addE supplies the edge\'s id and label, behind BOTH graph-dependent guards', () => {
    // `AddEdgeStep` carries `T.id` (`getElementId`/`setElementId`) and reads `T.label` out of the same
    // `internalParameters` its constructor writes the step's own label into, so both tokens configure
    // the edge being created — `addV`'s partition on the other host.
    for (const gremlin of [
      "g.V(1).addE('knows').to(__.V(2)).property(T.id,7).property('weight',0.5)",
      "g.V(1).addE('knows').to(__.V(2)).property(T.id,'e7')",
      "g.V(1).addE('knows').to(__.V(2)).property(T.label,'other')",
      // THE SOURCE FORM, and it is here because leaving it out cost a red CI: its input is the one-row
      // `Values` seed, which carries no `id` column at all, so a row-count guard that reads one throws
      // out of a lowering whose contract is `null`. Both positions of the same step, always.
      "g.addE('knows').from(__.V(1)).to(__.V(2)).property(T.id,7)",
      "g.addE('knows').from(__.V(1)).to(__.V(2)).property(T.id,'e7')",
    ]) expect(compile(gremlin, {}).kind, gremlin).toBe('program');

    const store = () => new GraphStore(new BunSqlite(':memory:'));
    const write = (s: GraphStore, gremlin: string) =>
      exec(s).buffers(gremlin, {});
    const twoPeople = (s: GraphStore) => {
      for (const i of [1, 2]) write(s, `g.addV('person').property(T.id,${i})`);
      return s;
    };

    // A NUMERIC id is the rowid and a STRING id is the `uid` — `addVertex`'s rule on `edges`.
    for (const [supplied, expected] of [['7', { id: 7, uid: null }], ["'e7'", { id: 1, uid: 'e7' }]] as const) {
      const rows = () => {
        const s = twoPeople(store());
        write(s, `g.V(1).addE('knows').to(__.V(2)).property(T.id,${supplied})`);
        return JSON.stringify(s.query('SELECT id, uid, src, tgt FROM edges', []));
      };
      expect(JSON.parse(rows()), supplied).toEqual([{ ...expected, src: 1, tgt: 2 }]);
      expect(rows(), supplied).toEqual(rows());
    }

    // `property(T.label, l)` REPLACES the step's own label rather than adding to it.
    const relabelled = twoPeople(store());
    write(relabelled, "g.V(1).addE('knows').to(__.V(2)).property(T.label,'other')");
    expect(relabelled.query('SELECT l.name FROM edges e JOIN labels l ON l.id = e.label', []))
      .toEqual([{ name: 'other' }]);

    // THE TWO GUARDS, and the second is the one `addV` does not need. `addV` proves single-row at
    // compile time (its one-row case is a literal `Values`); an `addE` mid-chain input is a traverser
    // relation, so "N rows would insert N edges carrying one id" becomes a guard binding — and the
    // message is upstream's own, raised on its second loop iteration. Both directions.
    {
      const taken = twoPeople(store());
      write(taken, "g.V(1).addE('knows').to(__.V(2)).property(T.id,7)");
      expect(() => write(taken, "g.V(1).addE('knows').to(__.V(2)).property(T.id,7)"))
        .toThrow(idAlreadyExists('Edge', '7'));
      // …and from the SOURCE form too, whose guard runs over a seed relation rather than a traverser one.
      expect(() => write(taken, "g.addE('knows').from(__.V(1)).to(__.V(2)).property(T.id,7)"))
        .toThrow(idAlreadyExists('Edge', '7'));

      const many = store();
      for (const i of [1, 2, 3]) write(many, `g.addV('person').property(T.id,${i})`);
      expect(() => write(many, "g.V().addE('knows').to(__.V(2)).property(T.id,9)"))
        .toThrow(idAlreadyExists('Edge', '9'));
    }
  });



  // `addE` folds a ConstantTraversal label to its literal — a nested `addE(__.constant("knows"))`
  // resolves the reference's ConstantTraversal and names the edge "knows" (`addV` folds it the same
  // way).
  test('addE folds a ConstantTraversal label to its literal', () => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      const write = (gremlin: string) => exec(store).buffers(gremlin, {});
      for (const person of ['a', 'b']) write(`g.addV("${person}")`);
      write('g.V(1).addE(__.constant("knows")).to(__.V(2))');
      expect(store.query('SELECT src, tgt FROM edges', [])).toEqual([{ src: 1, tgt: 2 }]);
    });


  test('a RUNTIME label resolves through the seam, and its validity is a GUARD not a decline', () => {
    // `ElementHelper.validateLabel` is three PURE PREDICATES over the value — null, empty, hidden — so
    // a label nobody sees until execution is still checkable, in ONE statement over the whole set,
    // before anything is written. That is better than evaluating the body per row and validating the
    // first bad one reached, which is why this is a guard rather than "we cannot know, so decline".
    for (const gremlin of [
      'g.addV(__.V().has("name","marko").values("name"))',
      'g.addV(__.V().has("name","marko").properties("name").key())',
    ]) expect(compile(gremlin, {}).kind, gremlin).toBe('program');

    const store = () => {
      const s = new GraphStore(new BunSqlite(':memory:'));
      for (const seed of MODERN_SEED) exec(s).buffers(seed, {});
      return s;
    };
    const write = (s: GraphStore, gremlin: string) => exec(s).buffers(gremlin, {});

    const created = store();
    write(created, 'g.addV(__.V().has("name","marko").values("name"))');
    expect(created.query(
      'SELECT l.name FROM nodes n JOIN vertex_labels vl ON vl.node = n.id JOIN labels l ON l.id = vl.label WHERE n.id > 6', []))
      .toEqual([{ name: 'marko' }]);

    // EVERY MESSAGE IS THE REFERENCE'S. `Element.java:212-222` owns the three
    // `Label can not be …`; `TraversalUtil.java:41-53` owns the absent one (stable prefix, since its
    // tail interpolates Java object descriptions nothing else can reproduce).
    //
    // **AN ABSENT BODY AND A NULL VALUE ARE DIFFERENT ERRORS AND ARE DISTINGUISHED.** A scalar subquery
    // collapses them to one NULL; `EXISTS` over the same relation does not. Getting this wrong would be
    // invisible — one plausible message, always — since no corpus scenario asserts either string.
    for (const [gremlin, message] of [
      ['g.addV(__.V().has("name","zzz").values("name"))', 'The provided traverser does not map to a value'],
      ['g.addV(__.V().has("name","marko").values("nokey").fold().unfold())', 'The provided traverser does not map to a value'],
      ['g.addV(__.inject(null))', 'Label can not be null'],
      ['g.addV(__.inject(""))', 'Label can not be empty'],
      ['g.addV(__.inject("~h"))', 'Label can not be a hidden key: ~h'],
    ] as const) {
      expect(compile(gremlin, {}).kind, gremlin).toBe('program');
      expect(() => write(store(), gremlin), gremlin).toThrow(message);
    }
  });

  test('addE takes a RUNTIME label through the same seam and the same guards', () => {
    // The edge host reuses `addV`'s resolution rather than growing its own — a second copy is a second
    // chance to fold a constant differently or to forget a guard. An edge label is singular by spec, so
    // there is no `Collection` arm here and none of `resolveLabelCollection`'s messages apply.
    for (const gremlin of [
      'g.V(1).addE(__.constant("knows")).to(__.V(2))',
      'g.V(1).addE(__.V().has("name","marko").values("name")).to(__.V(2))',
    ]) expect(compile(gremlin, {}).kind, gremlin).toBe('program');

    const seeded = () => {
      const s = new GraphStore(new BunSqlite(':memory:'));
      for (const seed of MODERN_SEED) exec(s).buffers(seed, {});
      return s;
    };
    const store = seeded();
    exec(store)
      .buffers('g.V(1).addE(__.V().has("name","marko").values("name")).to(__.V(2))', {});
    expect(store.query('SELECT l.name, e.src, e.tgt FROM edges e JOIN labels l ON l.id = e.label WHERE e.id > 12', []))
      .toEqual([{ name: 'marko', src: 1, tgt: 2 }]);

    // The SAME three guards, on the edge host — the validity rules belong to the value, not to the host.
    for (const [gremlin, message] of [
      ['g.V(1).addE(__.V().has("name","zzz").values("name")).to(__.V(2))', 'The provided traverser does not map to a value'],
      ['g.V(1).addE(__.inject("")).to(__.V(2))', 'Label can not be empty'],
      ['g.V(1).addE(__.inject("~h")).to(__.V(2))', 'Label can not be a hidden key: ~h'],
    ] as const)
      expect(() => exec(seeded()).buffers(gremlin, {}), gremlin).toThrow(message);
  });

  test('label() is a scalar retype off an element relation', async () => {
    // NOTHING WAS BUILT FOR THIS: `byExpr`'s token arm already projected the label — one indirection
    // into `labels` for an edge, the side table's first-interned name for a vertex — which is why
    // `by(T.label)` and a `label()` CHILD body have always worked. The element tail had simply never
    // been handed that expression — the "cannot be HANDED" vs "cannot EXPRESS" distinction
    // applied to a step. It was the last thing blocking a nested label on BOTH write hosts.
    for (const gremlin of [
      'g.V().label()', 'g.E().label()', 'g.V().label().dedup()',
      'g.V().has("name","marko").label()', 'g.V().label().count()',
      'g.V().hasLabel("person").label().dedup()', 'g.V().label().order()',
    ]) {
      expect(read(gremlin).kind, gremlin).toBe('read');
      expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toBeDefined();
    }

    // The WRITE host is the payoff and is a program, not a read — this is the shape that was blocked
    // on the read gap above, on both `addV` and `addE`.
    expect(compile('g.addV(__.V().has("name","marko").label())', {}).kind).toBe('program');

    // `id()` RIDES THE SAME ARM. `g.E().id()` emits its MULTISET in an order nothing pins (no
    // `order()`, no slice), so the comparison below is by multiset. Determinism — the property that
    // actually matters for an unordered answer — is `test:perturbed`'s to assert, not this test's.
    const sorted = (rows: readonly unknown[]): unknown[] => [...rows].sort((a, b) => String(a).localeCompare(String(b)));
    for (const gremlin of ['g.V().id()', 'g.E().id()', 'g.V().id().count()', 'g.V().hasLabel("person").id()']) {
      expect(read(gremlin).kind, gremlin).toBe('read');
      const via = () =>
        decodeAll(exec(seededStore()).buffers(gremlin, {}, {}));
      expect(sorted(await via()), gremlin).toEqual(sorted(await via()));
    }
  });

  test('labels() is label()\'s FLAT-MAP twin, and a zero-label vertex contributes no rows', async () => {
    // `LabelsStep` is a `FlatMapStep` over `element.labels()` and its javadoc states BOTH arms —
    // *"For vertices with multiple labels, each label is emitted individually. For edges, the single
    // label is emitted"* (`vendor/tinkerpop/gremlin-core/.../step/map/LabelsStep.java`). The edge arm
    // is therefore `label()` exactly and shares its projection; the vertex arm is `values()`' join with
    // the label side tables in place of the property one.
    //
    // This is the read step every `addLabel`/`dropLabel` scenario ENDS in, so it was the shape holding
    // that whole write family back while the writes themselves already lowered.
    for (const gremlin of [
      'g.V().labels()', 'g.E().labels()', 'g.V().labels().fold()', 'g.V().labels().count()',
      'g.V().labels().dedup()', 'g.V().has("name","marko").labels()', 'g.V().labels().order()',
    ]) {
      expect(read(gremlin).kind, gremlin).toBe('read');
      expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toBeDefined();
    }

    // THE INNER JOIN IS THE SPECIFIED ANSWER, not a default: under `ZERO_OR_MORE` a vertex may carry
    // no labels at all, and `labels()` must then emit NOTHING for it — an outer join would emit one
    // NULL row and `count()` would answer 1 where the reference answers 0. Only a zero-label graph can
    // state that, so it needs its own store.
    const none = new GraphStore(new BunSqlite(':memory:'));
    exec(none).buffers('g.addV()', {});
    {
      expect(await decodeAll(exec(none).buffers('g.V().labels()', {}, {}))).toEqual([]);
      expect(await decodeAll(exec(none).buffers('g.V().labels().count()', {}, {}))).toEqual([0]);
    }
  });

  // The lowering resolves a nested `addE` label by running the body and naming the edge from its
  // first value, as the reference does. `addV` has no such gap, so only the edge host needs this
  // form of assertion.
  test('addE resolves a nested label() body', () => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      for (const seed of MODERN_SEED) exec(store).buffers(seed, {});
      exec(store).buffers('g.V(1).addE(__.V().has("name","marko").label()).to(__.V(2))', {});
      expect(store.query('SELECT l.name, e.src, e.tgt FROM edges e JOIN labels l ON l.id = e.label WHERE e.id > 12', []))
        .toEqual([{ name: 'person', src: 1, tgt: 2 }]);
    });

  test('the hand-authored modern seed compiles WHOLE on RelIR', () => {
    // The reference graphs are GraphSON-bulk-loaded, so `MODERN_SEED` and its crew sibling are the two
    // that go through the compiler. Every statement must compile to a `program`, and the build must be
    // deterministic — a seed that differs silently re-bases every test above it.
    for (const gremlin of MODERN_SEED)
      expect(compile(gremlin, {}).kind, gremlin).toBe('program');

    const built = () => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      for (const gremlin of MODERN_SEED) exec(store).buffers(gremlin, {});
      return JSON.stringify({
        nodes: store.query('SELECT id, uid FROM nodes ORDER BY id', []),
        edges: store.query('SELECT id, uid, src, label, tgt FROM edges ORDER BY id', []),
        vprops: store.query('SELECT node, key, value FROM vertex_properties ORDER BY node, key', []),
        eprops: store.query('SELECT edge, key, value FROM edge_properties ORDER BY edge, key', []),
      });
    };
    expect(built()).toEqual(built());
  });

  test('addLabel adds labels idempotently over a vertex stream (multi-label graph)', () => {
    // A MULTI-LABEL graph (mutable cardinality) is what makes `addLabel` legal; an immutable graph or
    // an edge refuses.
    const multi = createAppScope({ });
    for (const gremlin of [
      'g.addV("person").addLabel("employee").property("name","marko")',
      'g.V().addLabel("employee")',
      'g.V().addLabel("a","b")',
      'g.V().addLabel(constant("x"))',
      'g.V().addLabel(constant(["a","b"]))',
    ]) expect(compile(gremlin, {}, { app: multi }).kind, gremlin).toBe('program');

    // Over a fresh multi-label store: the resulting label set is the specified one,
    // and a repeated label is a no-op (PRIMARY KEY(node,label) + ON CONFLICT DO NOTHING).
    const labelRows = () => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      for (const write of [
        'g.addV("person").property("name","marko")',
        'g.addV("person").property("name","josh")',
        'g.V().addLabel("employee")',   // a new label on both
        'g.V().addLabel("person")',     // an EXISTING label — idempotent
      ]) exec(store).buffers(write, {});
      return JSON.stringify(store.query(
        'SELECT vl.node, l.name FROM vertex_labels vl JOIN labels l ON l.id = vl.label ORDER BY vl.node, l.name', []));
    };
    const rel = labelRows();
    // Two vertices, each carrying exactly {employee, person} — the repeated `addLabel("person")`
    // added no duplicate row.
    expect(JSON.parse(rel)).toEqual([
      { node: 1, name: 'employee' }, { node: 1, name: 'person' },
      { node: 2, name: 'employee' }, { node: 2, name: 'person' },
    ]);

    // THERE IS NO IMMUTABLE GRAPH TO REFUSE ANY MORE. Every mogwai-db vertex carries a label set
    // (`src/api.ts`), so `addLabel` is always legal on one — the assertion that used to live here
    // pinned `LabelCardinality.ONE`, which is a declared wall rather than a configuration.
    //
    // An EDGE still refuses, and that is the SPEC rather than this decision: edge label cardinality
    // is fixed at ONE by TinkerPop itself, so it is the one refusal that survives.
    {
      const store = new GraphStore(new BunSqlite(':memory:'));
      exec(store).buffers('g.addV("a").as("x").addV("b").as("y").addE("knows").from("x").to("y")', {});
      expect(() => exec(store).buffers('g.E().addLabel("x")', {}))
        .toThrow('Label mutation is not supported');
    }
  });

  test('dropLabel/dropLabels are addLabel\'s mirror, and the cardinality FLOOR splits them', () => {
    // `LabelCardinalityValidator` is where the two steps come apart, and it decides the shape of the
    // work rather than merely the messages (`structure/util/LabelCardinalityValidator.java`):
    // `validateDropAll` raises for ANY `min > 0` whatever the element carries — a COMPILE-TIME
    // question once the cardinality is threaded — while `validateDrop` SIMULATES the removal and
    // raises only if the survivors fall below `min`, which is arithmetic over the DATA and therefore
    // a guard binding (§6·5).
    for (const gremlin of [
      'g.V().dropLabel("a")', 'g.V().dropLabels()', 'g.V().dropLabel("a","b")',
      'g.V().dropLabel(constant("a"))', 'g.V().dropLabel(constant(["a","b"]))',
      'g.V().dropLabel("a").labels().fold()',
    ]) expect(compile(gremlin, {}, { app: createAppScope({ }) }).kind, gremlin)
      .toBe('program');

    // Over a fresh zero-or-more store, per DropLabel.feature's own fixtures: a named
    // drop, a name the vertex does NOT carry (a no-op, not an error), and dropping every label.
    const labelRows = (drop: string) => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      exec(store).buffers('g.addV("a","b","c")', {});
      exec(store).buffers(drop, {});
      return store.query('SELECT l.name FROM vertex_labels vl JOIN labels l ON l.id = vl.label ORDER BY l.name', [])
        .map((r: any) => r.name);
    };
    for (const [drop, left] of [
      ['g.V().dropLabel("a")', ['b', 'c']],
      ['g.V().dropLabel("a","b")', ['c']],
      ['g.V().dropLabel("xyz")', ['a', 'b', 'c']],   // a name it does not carry is a NO-OP
      ['g.V().dropLabels()', []],
      ['g.V().dropLabel(constant(["a","b"]))', ['c']],
    ] as const) {
      expect(labelRows(drop), drop).toEqual([...left]);
    }

    // THE GUARD IS GONE WITH THE FLOOR. `validateDrop` raises only where the survivors fall below
    // `min`, and `min` is 0 for every mogwai-db graph — so a named drop can never fall below it and
    // `dropLabels()` can never be refused. Both were real refusals under `ONE_OR_MORE`; that regime
    // is a declared wall now, so what replaces the assertion is that neither raises.
    const stripped = new GraphStore(new BunSqlite(':memory:'));
    exec(stripped).buffers('g.addV("solo")', {});
    exec(stripped).buffers('g.V().dropLabel("solo")', {});
    expect(stripped.query('SELECT COUNT(*) AS n FROM vertex_labels', [])).toEqual([{ n: 0 }]);
    // And `dropLabels()` compiles rather than declining — the arm that used to be a compile-time
    // refusal for any `min > 0`.
    expect(compile('g.V().dropLabels()', {}).kind).toBe('program');

    // An EDGE still refuses — the spec's rule, not a cardinality we chose.
    {
      const edges = new GraphStore(new BunSqlite(':memory:'));
      exec(edges).buffers('g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b")', {});
      expect(() => exec(edges).buffers('g.E().dropLabel("knows").labels().fold()', {}))
        .toThrow('Label mutation is not supported');
    }
  });

  test('a creation or a merge over a SCALAR stream is the same write with a different multiplier', () => {
    // §6·6's rule at the WRITE seam. What `addV`/`addE`/`mergeV`/`mergeE` take from their input is its
    // ROW COUNT, and a scalar relation has one exactly as an element relation does — the reference
    // draws no distinction at all, since `MergeVertexStep` never looks at the traverser except to
    // materialize a map from it. What declined was the SNAPSHOT, which projected an `id` column a
    // scalar relation does not have; `traverserCol` is the fix, and it is one line in `write.ts`
    // rather than a scalar-specific write path.
    for (const gremlin of [
      'g.inject(0).mergeV([:])',
      'g.inject(0).mergeV([(T.label):"person"])',
      'g.inject(0).as("a").mergeV([(T.label):"person"])',
      'g.inject(1).addV("person")',
      'g.inject(1).addV("person").property("name","x")',
      'g.V().values("name").addV("person")',
      'g.inject(0).addE("knows").from(__.V(1)).to(__.V(2))',
      'g.inject(0).mergeE([(T.label):"knows",(Direction.OUT):1,(Direction.IN):2])',
    ]) expect(compile(gremlin, {}).kind, gremlin).toBe('program');

    // AND THE FORMS THAT READ THE TRAVERSER AS AN ELEMENT STILL REFUSE, which is the whole of the
    // safety: an implicit `addE` endpoint IS the incoming traverser, and a scalar is not a vertex.
    // `AddEdgeStartStep` defaults both ends to `null` and raises, so this is the reference's own rule
    // and not a conservatism — the `elem !== 'vertex'` tests that already guarded it now see `null`.
    // The compiler RAISES, which is why the assertion is on the compile: an implicit endpoint over a
    // scalar is an error, and the only question this settles is that it is not silently invented.
    expect(() => compile('g.inject(0).addE("knows")', {})).toThrow();

    // A MERGE over a scalar source builds the SAME graph on every run — `merged()` is compared to
    // itself, and the graph it produces is the specified one.
    const merged = () => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      for (const gremlin of [
        'g.addV("person").property("name","alice")',
        'g.inject(0).mergeV([(T.label):"person","name":"alice"])',   // MATCHES the vertex above
        'g.inject(0).mergeV([(T.label):"person","name":"bob"])',     // CREATES a second
        'g.inject(0).mergeE([(T.label):"knows",(Direction.OUT):1,(Direction.IN):2])',
      ]) exec(store).buffers(gremlin, {});
      return JSON.stringify({
        nodes: store.query('SELECT id FROM nodes ORDER BY id', []),
        edges: store.query('SELECT src, tgt FROM edges ORDER BY id', []),
        vprops: store.query('SELECT node, key, value FROM vertex_properties ORDER BY node, key', []),
      });
    };
    const rel = merged();
    expect(rel).toEqual(merged());
    // Two vertices and one edge — the second `mergeV` MATCHED rather than creating a third, which is
    // the whole point of routing a merge here rather than a creation.
    expect(JSON.parse(rel).nodes).toEqual([{ id: 1 }, { id: 2 }]);
    expect(JSON.parse(rel).edges).toEqual([{ src: 1, tgt: 2 }]);
    // A MULTI-ROW scalar source is a real multiplier, not a formality: three injected values create
    // three vertices, exactly as three traversers would.
    const many = new GraphStore(new BunSqlite(':memory:'));
    exec(many).buffers('g.inject(1,2,3).addV("person").property("k","v")', {});
    expect(many.query('SELECT COUNT(*) AS n FROM nodes', [])).toEqual([{ n: 3 }]);
    expect(many.query('SELECT COUNT(*) AS n FROM vertex_properties', [])).toEqual([{ n: 3 }]);
  });

  test('a T.label on mergeV\'s onMatch arm is APPEND-ONLY addLabel', () => {
    // The reference handles it apart from every other entry and says so in a comment:
    // *"Handle T.label separately: append-only addLabel semantics for multi-label support"*
    // (`MergeVertexStep.java:106-113` → `ElementHelper.applyLabelsToVertex`,
    // `.../structure/util/ElementHelper.java:293-305`). So it is `addLabel`'s statement over the
    // MATCHED vertices — which is why `bindLabels` is now shared rather than a second insert — and an
    // EMPTY collection is a NO-OP rather than a clear (`applyLabelsToVertex` returns without touching
    // the vertex at `:298`).
    //
    // NEITHER COUNTER MOVES FOR THIS: the corpus cannot spell a bound merge map, so the L3 total is
    // unchanged. This test IS the record.
    const labels = (arm: string) => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      exec(store).buffers('g.addV("person").addLabel("employee").property("name","marko")', {});
      exec(store).buffers(`g.mergeV([(T.label):"person","name":"marko"]).option(Merge.onMatch,${arm})`, {});
      return store.query('SELECT l.name FROM vertex_labels vl JOIN labels l ON l.id = vl.label ORDER BY l.name', [])
        .map((r: any) => r.name);
    };
    for (const [arm, expected] of [
      ['[(T.label):"manager"]', ['employee', 'manager', 'person']],   // APPENDED, nothing replaced
      ['[(T.label):"person"]', ['employee', 'person']],               // already carried — idempotent
      ['[(T.label):[]]', ['employee', 'person']],                     // an EMPTY collection is a no-op
      ['[(T.label):["manager","director"]]', ['director', 'employee', 'manager', 'person']],
    ] as const) {
      expect(labels(arm), arm).toEqual([...expected]);
    }

    // An INVALID name is still an ERROR rather than a write to skip — and it RAISES rather than
    // declining, because the merge parse validates a `T.label` value and that parse runs in the
    // `writeArguments` verify Pass (§6·5). No graph can refuse label mutation
    // outright any more, so this is the only refusal this host contributes.
    expect(() => compile('g.mergeV([(T.label):"person","name":"marko"]).option(Merge.onMatch,[(T.label):"~hidden"])',
      {})).toThrow('Label can not be a hidden key: ~hidden');
  });

  test('a mergeE search reads the MERGE map and only the merge map', () => {
    // `searchEdges` is handed the resolved MATCH map alone, and `onCreateMap` is built afterwards and
    // only once the search came back empty (`MergeEdgeStep.flatMap`,
    // `vendor/tinkerpop/gremlin-core/.../step/map/MergeEdgeStep.java:258-311`). Reading the UNION of
    // the two — which is what the endpoint resolution used to do — narrows the search by a constraint
    // the reference does not have, and then creates a duplicate whenever a matching edge existed
    // somewhere else. A wrong ANSWER that no scenario named.
    const seeded = () => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      for (const gremlin of [
        'g.addV("person").property("name","marko")',
        'g.addV("person").property("name","josh")',
        'g.addV("person").property("name","vadas")',
        'g.V().has("name","marko").addE("knows").to(__.V().has("name","josh"))',
      ]) exec(store).buffers(gremlin, {});
      return store;
    };
    // A `knows` edge already exists (1→2). The merge map names only the LABEL, so the search finds it
    // and NOTHING is created — even though `onCreate` describes a different pair entirely.
    const store = seeded();
    exec(store)
      .buffers('g.mergeE([(T.label):"knows"]).option(Merge.onCreate,[(Direction.OUT):1,(Direction.IN):3])', {});
    expect(store.query('SELECT src, tgt FROM edges', [])).toEqual([{ src: 1, tgt: 2 }]);

    // And with the search narrowed by an endpoint the map DOES name, the same traversal creates.
    const narrowed = seeded();
    exec(narrowed)
      .buffers('g.mergeE([(T.label):"knows",(Direction.OUT):1,(Direction.IN):3])', {});
    expect(narrowed.query('SELECT src, tgt FROM edges ORDER BY id', [])).toEqual([{ src: 1, tgt: 2 }, { src: 1, tgt: 3 }]);
  });


  test('mergeE routes to RelIR for both endpoint kinds, and duplicates get ONE edge', async () => {
    // The corpus cannot see this and neither can L3: every parameterized `mergeE` arrives as a bound
    // Map (`m[{"t[label]":…,"D[OUT]":"M[outV]"}]` on the wire), so no counter the build gates on
    // moves. This test IS the record.
    const T = (name: string) => ({ typeName: 'T', elementName: name });
    const D = (name: string) => ({ typeName: 'Direction', elementName: name });
    const M = (name: string) => ({ typeName: 'Merge', elementName: name });
    const self = new Map<any, any>([[T('label'), 'self'], [D('OUT'), M('outV')], [D('IN'), M('inV')]]);
    const opts = '.option(Merge.outV,__.select("v")).option(Merge.inV,__.select("v"))';
    const cases: [string, Record<string, unknown>][] = [
      // BOTH endpoints resolved by their option — the shape every L3 mergeE scenario uses.
      [`g.V().as("v").mergeE(xx1)${opts}`, { xx1: self }],
      [`g.V().has("person","name","marko").as("v").mergeE(xx1)${opts}`, { xx1: self }],
      // MIXED: one endpoint from an option, one a constant id in the map — one lowering serves both.
      ['g.V().hasLabel("person").as("v").mergeE(xx1).option(Merge.outV,__.select("v"))',
        { xx1: new Map<any, any>([[T('label'), 'pt'], [D('OUT'), M('outV')], [D('IN'), 3]]) }],
      // A ROOTED read as the endpoint, at the SOURCE, where there is no incoming traverser at all.
      ['g.mergeE(xx1).option(Merge.outV,__.V(1)).option(Merge.inV,__.V(2))',
        { xx1: new Map<any, any>([[T('label'), 'knows'], [D('OUT'), M('outV')], [D('IN'), M('inV')]]) }],
      // DUPLICATE incoming rows must get ONE edge and two traversers — upstream's second loop
      // iteration matching what its first created, which here is `Distinct` over the endpoint pair
      // rather than a re-read. `both().both()` revisits vertices, which is what makes it a witness.
      [`g.V(1).both().both().as("v").mergeE(xx1)${opts}`,
        { xx1: new Map<any, any>([[T('label'), 'dup'], [D('OUT'), M('outV')], [D('IN'), M('inV')]]) }],
    ];
    for (const [gremlin, params] of cases) {
      const plan = compile(gremlin, params);
      expect(plan.kind, gremlin).toBe('program');
      // The ANSWER and the GRAPH, because a merge that creates a duplicate edge still emits a
      // plausible traverser count — the edge total is the half that sees it.
      const via = async () => {
        const store = seededStore();
        const run = exec(store);
        const emitted = await decodeAll(run.buffers(gremlin, params, {}));
        return { emitted: emitted.length, edges: await decodeAll(run.buffers('g.E().count()', {}, {})) };
      };
      // Run twice against a fresh store: the deterministic lowering must agree row for row. The
      // fallback (`relirAhead`) only pins a non-empty answer where a second run cannot be compared.
      const answer = await via();
      let baseline: typeof answer | null = null;
      try { baseline = await via(); } catch { baseline = null; }
      if (baseline) expect(answer, gremlin).toEqual(baseline);
      else expect(answer.emitted, `${gremlin} (relirAhead)`).toBeGreaterThan(0);
    }
  });

  test('a Merge.outV token in the map REQUIRES its option — from the Pass tier', () => {
    // `MergeEdgeStep.resolveVertex` (gremlin-core .../step/map/MergeEdgeStep.java:231-251): the token
    // is a REFERENCE to `option(Merge.outV, …)`, not to the incoming traverser, and its absence is an
    // error. Substituting the current traverser is a wrong answer no corpus scenario catches, because
    // every scenario that uses the token also supplies the option. The check is decidable from the
    // TEXT, so it raises in the verify Pass (§6·5).
    const gremlin = 'g.V().mergeE([(T.label):"self",(Direction.OUT):Merge.outV,(Direction.IN):Merge.inV])';
      expect(() => compile(gremlin, {}))
        .toThrow('option(outV) must be specified if it is used for OUT');
  });

  test('mergeE with CONSTANT endpoints is mergeV\'s shape plus a guard', async () => {
    // The endpoints are what mergeE adds, and a constant one keeps the search input-independent —
    // so this is mergeV's two-total-statement shape exactly, and `crossed()` applies unchanged.
    // `Merge.outV`/`Merge.inV` make the search vary per input row and are the next arm.
    const cases = [
      // matches the seeded marko->vadas knows edge
      'g.mergeE([(T.label):"knows",(Direction.OUT):1,(Direction.IN):2])',
      // no such edge -> the create arm
      'g.mergeE([(T.label):"zzz",(Direction.OUT):1,(Direction.IN):2])',
      'g.mergeE([(T.label):"knows",(Direction.OUT):1,(Direction.IN):2]).option(Merge.onMatch,["weight":0.9])',
      'g.mergeE([(T.label):"zzz",(Direction.OUT):1,(Direction.IN):2]).option(Merge.onCreate,["w":"new"])',
    ];
    for (const gremlin of cases) {
      const plan = compile(gremlin, {});
      expect(plan.kind, gremlin).toBe('program');
      expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toBeDefined();
    }
    // The GUARD's other direction (§6·5): a missing endpoint is `raiseWhen: 'empty'`, and the
    // message is `MergeEdgeStep`'s.
    const missing = 'g.mergeE([(T.label):"zzz",(Direction.OUT):1,(Direction.IN):999])';
    expect(compile(missing, {})).toMatchObject({});
      expect(() => exec(seededStore()).buffers(missing, {}, {}))
        .toThrow('Vertex does not exist for mergeE');
  });

  test('a large literal inject inlines as 0-bind literals and stays on RelIR', () => {
    // There is no >100-value conversion. A literal inject spends NO binds — each member inlines as a
    // typed SQL literal (`constLit`) — so even 101 members is 0 binds and trivially DO-legal on RelIR.
    // The 100-bind cap is a PARAMETER budget and a held literal is not a parameter (root CLAUDE.md).
    const gremlin = `g.inject(${Array.from({ length: 101 }, (_, i) => i).join(',')})`;
    const plan = read(gremlin);
    expect(plan.kind).toBe('read');
    expect(plan.binds).toHaveLength(0);
    expect(cfLimitViolation(plan.sql, plan.binds)).toBeNull();
    expect(store.query(plan.sql, plan.binds).map((row: any) => row.v)).toEqual(Array.from({ length: 101 }, (_, i) => i));
    const small = read('g.inject(1,2,3)');
    expect(small.binds).toHaveLength(0);
  });

  test('limit($x)/skip($x) bind their count as a user parameter (B3)', () => {
    // A parameter is the only free-standing bind by intent, so a `$x` count is a `?`, not inlined —
    // the plan is one cached statement over every value. A parsed LITERAL count inlines (0 binds).
    for (const [gremlin, count] of [['g.V().limit(n)', 2], ['g.V().skip(n)', 1]] as const) {
      const plan = compile(gremlin, { n: count });
      if (plan.kind !== 'read') throw new Error('expected a read');
      expect(plan.binds, gremlin).toContain(count);
    }
    const literal = compile('g.V().limit(2)', {});
    if (literal.kind === 'read') expect(literal.binds).not.toContain(2);
  });

  test('a slice takes its window from the emission order, not from the scan', () => {
    // A slice must be compared UNSORTED — it is the one place where the wrong
    // ORDER is the wrong ANSWER, so sorting before comparing would hide exactly the defect this
    // covers. `ms` (the census gate) would not see it either — same multiset size, different rows.
    for (const gremlin of ['g.V().limit(2)', 'g.V().range(1,3)', 'g.V().skip(2)', 'g.V().skip(1).limit(2)',
      'g.V().out().limit(2)', 'g.V().both().limit(3)', 'g.V().out().out().limit(2)', 'g.V().out().range(1,3)',
      "g.V().values('name').limit(2)", "g.V().values('name').skip(1)", "g.V().out().values('name').limit(2)"]) {
      expect(read(gremlin).kind, gremlin).toBe('read');
    }
  });

  test('a scalar order() pins the SEQUENCE, not just the multiset', () => {
    // `rowsVia` SORTS, so a multiset comparison structurally cannot
    // see the two defects an `order()` actually has: a sort in the wrong DIRECTION, and a sort the
    // assembler fused away entirely. Both leave the multiset untouched, so the census cannot see
    // them either (`ms` is the gate, `ord` is telemetry). An ABSOLUTE assertion on the sequence is what can.
    for (const gremlin of ['g.inject(3,1,2).order()', "g.inject('c','a','b').order()",
      "g.inject('c','a','b').order().by(Order.desc)", 'g.inject(3,1,2).order().limit(2)',
      'g.inject(3,1,2).order().skip(1)', "g.V().values('age').order()", "g.V().values('name').order()",
      "g.V().values('name').order().by(Order.desc)", "g.V().values('age').order().range(1,3)",
      "g.V().out().values('name').order()", "g.V().values('age').order().is(P.gt(29))"]) {
      expect(read(gremlin).kind, gremlin).toBe('read');
    }
    // …and one ABSOLUTE assertion, because a self-comparison agrees even when the answer is wrong: the
    // ascending sequence itself, which no scan order can produce by luck three times over.
    const asc = read('g.inject(3,1,2).order()');
    expect(store.query(asc.sql, asc.binds).map((row: any) => row.v)).toEqual([1, 2, 3]);
  });

  test('an element order() pins the SEQUENCE, and every composition of it', () => {
    // The MINT is only observable as an ORDER, so `rowsVia`'s sorted comparison structurally cannot
    // see any of this: a wrong direction, a sort the assembler fused away, a mint that renumbered
    // per arm rather than once over the fan-out, or a slice reading the stale seed. An ABSOLUTE
    // assertion is what can — and every one of these is a chain `analyzeChain` reports
    // `demandsEncounter` FALSE for, which is exactly why the channel had to become the relation's.
    for (const gremlin of ['g.V().order()', 'g.E().order()', "g.V().order().by('name')",
      "g.V().order().by('name',Order.desc)", "g.V().order().by('age')", "g.V().order().by(T.label)",
      "g.V().order().by('name').limit(2)", "g.V().order().by('name').range(1,3)",
      "g.V().order().by('age').skip(1)", "g.V().order().by('name').values('name')",
      "g.V().hasLabel('person').order().by('age')", "g.V().out().order().by('name')",
      "g.V().out().order().by('name').limit(2)", "g.V().order().by('name').out()",
      // The BULKED slice: a collapsed row stands for N traversers, so the boundary row's
      // multiplicity is TRIMMED. `LIMIT n` over those rows returns the same rows with the wrong
      // count — right arity per row, wrong number of traversers, invisible to a sorted compare.
      "g.V().both().order().by('name').limit(2)", "g.V().both().order().by('name').range(1,4)",
      "g.V().both().both().order().by('name').limit(3)"]) {
      expect(read(gremlin).kind, gremlin).toBe('read');
    }
    // …plus two ABSOLUTE assertions, because a self-comparison agrees even when the answer is wrong. The
    // modern graph's names ascending, and the same list reversed — no scan order produces either by
    // luck six times over.
    const names = (gremlin: string) => {
      const plan = read(gremlin);
      return store.query(plan.sql, plan.binds).map((row: any) => JSON.parse(row.props).name[0].v);
    };
    expect(names("g.V().order().by('name')")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    expect(names("g.V().order().by('name',Order.desc)")).toEqual(['vadas', 'ripple', 'peter', 'marko', 'lop', 'josh']);
    // A non-productive `by('age')` DROPS the two software vertices rather than sorting them first.
    expect(names("g.V().order().by('age')")).toEqual(['vadas', 'marko', 'josh', 'peter']);
  });


  test('a repeated wire parameter is ONE bind, reused as a numbered placeholder', () => {
    // The budget is for PARAMETERS, not their USES: a `$p` threaded through two predicates must cost
    // ONE of the 100 (docs/archive/2026-08-05-parameters-are-the-only-binds.md, "Repeated parameters"). The
    // client sends one `p` map entry plus the name at each site; RelIR collapses the two `param()`s to
    // a single `?1` reused — legal on bun:sqlite AND on a Durable Object (test/cf-probe).
    const compileRel = (gremlin: string, params: Record<string, unknown>) => {
      const p = compile(gremlin, params);
      if (p.kind !== 'read') throw new Error('expected read plan');
      return p;
    };
    const gremlin = "g.V().has('age', gt(p)).has('age', gt(p))";
    const one = compileRel(gremlin, { p: 20 });
    expect(one.kind).toBe('read');
    expect(one.binds).toEqual([20]);                                // ONE bind, however many uses
    // The one placeholder is reused at every site — here 4 times, because the vtype-aware compare key
    // spells each operand twice and there are two predicates; the point is reuse, not the exact count.
    expect((one.sql.match(/\?1(?!\d)/g) ?? []).length).toBeGreaterThan(1);

    // Distinct parameters get distinct ordinals (`?1`, `?2`) and one bind each — dedup is BY NAME, so
    // different names never share a slot even though each is itself spelled twice by the compare key.
    const two = compileRel("g.V().has('age', gt(p)).has('age', lt(q))", { p: 20, q: 40 });
    expect(two.binds).toEqual([20, 40]);
    expect(two.sql).toContain('?1');
    expect(two.sql).toContain('?2');

    // A statement with NO wire parameter is untouched — mechanical/literal binds keep the anonymous-`?`
    // render byte-for-byte, so no existing SQL (or snapshot) moves.
    expect(read("g.V().has('age', 30)").sql).not.toContain('?1');
  });


  test('sample(n) returns exactly n traversers on every run', () => {
    // One run cannot see the defect: the old fused RANDOM() plan sometimes returned n by chance.
    // Repetition asserts the cardinality in both a source and a fan-out chain.
    for (const gremlin of ['g.V().sample(3)', 'g.V().both().sample(3)']) {
      for (let run = 0; run < 10; run++) expect(runWith(store, gremlin)).toHaveLength(3);
    }
  });

  test('a coercion that cannot PARSE declines, so the error stays the reference\'s', () => {
    // The fold is where TinkerPop's parse and overflow messages live, and SQL can raise neither — so
    // the arms that RAISE are the ones a `CAST` would silently answer for (`1` for `'1,000'`, epoch 0
    // for an invalid date). What is pinned here is that the compiler raises the message the reference
    // specifies rather than a `CAST` that would answer a plausible wrong value. A family whose members
    // raise needs its error cases enumerated as tests, because a result comparison never reaches them (§11).
    for (const [gremlin, message] of [
      ["g.inject('1,000').asNumber()", "Can't parse string '1,000' as number."],
      ["g.inject('nope').asBool()", "Can't parse"],
      ["g.inject('not-a-date').asDate()", "Can't parse"],
    ] as const) {
      expect(() => compile(gremlin, {})).toThrow(message);
    }
  });


  test("a by()'s PRODUCTIVITY is honoured, both ways round", () => {
    // TinkerPop's default `by()` DROPS a traverser it yielded nothing for; `ProductiveByStrategy`
    // keeps it. Both positions are asserted with ABSOLUTE counts, because a productivity filter simply
    // omitted is a defect no result comparison could catch, and the
    // reference graph makes the difference visible — 6 vertices, only 2 with a `lang`.
    const dropped = read("g.V().dedup().by('lang')");
    expect(dropped.kind).toBe('read');
    expect(store.query(dropped.sql, dropped.binds).length).toBe(1);
    const kept = read("g.withStrategies(ProductiveByStrategy).V().dedup().by('lang')");
    expect(kept.kind).toBe('read');
    // One survivor per distinct `lang` (java) PLUS one for the null key — SQL groups NULLs together in
    // a `PARTITION BY`, which is what TinkerPop's "all non-productive traversers share a key" means.
    expect(store.query(kept.sql, kept.binds).length).toBe(2);
  });

  test("a reducer's three policies each have a witness the others cannot provide", () => {
    // ELIGIBILITY, BULK WEIGHTING and the DYNAMIC result type are three independent rules, and the
    // reference fixture makes each visible only under a different traversal — so each gets its own
    // assertion rather than trusting one differential to cover all three.
    //
    // 1. ELIGIBILITY: `min`/`max` admit TEXT because Gremlin's Comparable does, and a numeric-only
    //    guard would answer NULL here rather than a wrong number.
    const minText = read("g.V().values('name').min()");
    expect(minText.kind).toBe('read');
    expect(store.query(minText.sql, minText.binds).map((row: any) => row.v)).toEqual(['josh']);

    // 2. BULK WEIGHTING applies to sum/mean and NOT to min/max, and it is only observable once a
    //    collapse upstream has made bulk anything but 1 — `both().both()` is that. A weighted min would
    //    still be the min, which is why the four are pinned together. `min`/`max` project the winner's
    //    own GREMLIN vtype (`int`) rather than a storage class (`integer`) — same answer, different
    //    internal spelling, and the value is what bulk weighting is about.
    for (const gremlin of ["g.V().both().both().values('age').sum()", "g.V().both().both().values('age').mean()",
      "g.V().both().both().values('age').min()", "g.V().both().both().values('age').max()"]) {
      expect(read(gremlin).kind, gremlin).toBe('read');
    }

    // 3. THE MEAN IS FORCED REAL. Integer division answers 30 for the reference ages where the mean is
    //    30.75 — right shape, plausible number, and the ONLY thing that catches it is the value. RelIR
    //    forces it with a `Cast`, which declares REAL arithmetic directly rather than depending on a
    //    spelling-level `1.0` token. This assertion is that regression test.
    const mean = read("g.V().values('age').mean()");
    expect(store.query(mean.sql, mean.binds).map((row: any) => row.v)).toEqual([30.75]);
    // The mechanism is the CAST, asserted directly — `* ?` also appears in this SQL and legitimately so
    // (that is the bulk weighting), which is why the absence of a multiplier is not the thing to check.
    expect(mean.sql).toMatch(/CAST\(sum\([^]*AS REAL\) \//);

    // …and the result's storage class rides out as the `vt` column, because a sum of integers is an
    // integer and of reals a real — there is no compile-time tag to give.
    const sum = read("g.V().values('age').sum()");
    expect(store.query(sum.sql, sum.binds)).toEqual([{ v: 123, vt: 'integer' }]);
    const real = read("g.V().values('age').asNumber(GType.DOUBLE).sum()");
    expect(store.query(real.sql, real.binds)).toEqual([{ v: 123, vt: 'real' }]);
  });

  test('min/max compare in type space and frame the winner\'s own vtype', () => {
    // §6·7. min/max ORDER within a Gremlin TYPE SPACE, not by SQLite storage class, and return the
    // ORIGINAL extremal row's value + its own Gremlin vtype (an argmin/argmax). The `vt` is a Gremlin
    // type (`int`/`string`), not a storage class, and the framer reads it through the same `values()`
    // path so a text-carried long frames as a `long` rather than a String.
    const val = (q: string) => { const p = read(q); return store.query(p.sql, p.binds); };
    expect(val("g.V().values('age').min()")).toEqual([{ v: 27, vt: 'int' }]);
    expect(val("g.V().values('age').max()")).toEqual([{ v: 35, vt: 'int' }]);
    expect(val("g.V().values('name').max()")).toEqual([{ v: 'vadas', vt: 'string' }]);

    // THE §6·7 rows the storage-class order gets WRONG: a `long` past 2^53 rides as decimal TEXT, so
    // `MIN`/`MAX` by storage class (INTEGER before TEXT) pick the wrong element AND frame it as text.
    // Type-space comparison + returning the original row fixes both, pinned in both directions.
    expect(val('g.inject(10L, -9007199254740993L).min()')).toEqual([{ v: '-9007199254740993', vt: 'long' }]);
    expect(val('g.inject(10L, -9007199254740993L).max()')).toEqual([{ v: 10, vt: 'long' }]);
    // A storage-class order would be the wrong one — min would pick 10 (INTEGER sorts before TEXT), not the numerically smaller long.

    // min/max over an EMPTY stream emit NOTHING (`ReducingBarrierStep` supplies no seed for them,
    // §92·1), where a raw `MIN()` aggregate would emit one NULL row.
    expect(val("g.V().hasLabel('nope').values('age').min()")).toEqual([]);
  });




  test('dedup().by() keeps ONE traverser per key, deterministically', () => {
    // The survivor must be a NAMED row, not "whichever SQLite produced first" — a `PARTITION BY key`
    // with no `ORDER BY` in the window is right-arity and arbitrary, and the reference fixture is
    // small enough that the arbitrary choice is reliably the flattering one. So the survivor is pinned
    // unsorted, by the perturbation instrument (`MOGWAI_REVERSE_UNORDERED=1`) over this file.
    for (const gremlin of ["g.V().dedup().by('name')", "g.V().dedup().by('lang')",
      "g.V().dedup().by(T.label)", "g.E().dedup().by(T.label)", "g.V().dedup().by(T.id)",
      "g.E().dedup().by('weight')", "g.V().out().dedup().by('lang')",
      "g.V().dedup().by('lang').values('name')", "g.V().out().dedup().by('lang').limit(2)"]) {
      expect(read(gremlin).kind, gremlin).toBe('read');
    }
  });

  test("a scalar order()'s key is vtype-aware, so a TEXT-stored number sorts numerically", () => {
    // The arm where a plausible-looking lowering is silently wrong, and it needs its own fixture:
    // every `age` in the reference graph fits an INTEGER storage class, so a key that skipped the
    // compare CASE would still pass on all eleven traversals above. A long past 2^53 does not
    // fit, is stored as TEXT, and a lexical sort then puts it BETWEEN 12 and 300 — right multiset,
    // wrong sequence, and nothing else in the suite looks.
    const graph = seededStore();
    for (const value of ['12L', '9007199254740993L', '300L'])
      runWith(graph, `g.addV("n").property("k",${value})`);
    const plan = read("g.V().hasLabel('n').values('k').order()");
    expect(plan.kind).toBe('read');
    expect(graph.query(plan.sql, plan.binds).map((row: any) => String(row.v))).toEqual(['12', '300', '9007199254740993']);
  });


  test('a fast-path switch changes what a covered traversal EMITS, never whether it is covered', () => {
    // THIS TEST ASSERTED THE OPPOSITE UNTIL L5 REFUTED IT, and the old reasoning is worth keeping
    // because it was plausible: `predicateInlining` names two lowerings of a `where()` body — the
    // correlated EXISTS (which RelIR emits) and a MATERIALIZED child-existence gate (which it has not
    // learned) — so with the switch off RelIR "should" decline exactly as it declines an unlearned
    // step, keeping both positions live for the differential.
    //
    // That holds only while turning the switch off still leaves the traversal covered.
    // The moment it did not, turning a FAST PATH off removed SUPPORT — which
    // `src/compiler/CLAUDE.md` forbids outright: a specialized lowering qualifies ONLY if disabling it
    // compiles the same traversal generically, and recognition failure falls through rather than
    // throwing. L5 produced the witness on a seed CI happened to draw:
    // `g.E().where(__.outV().group().by('name'))` answered 6 rows with the switch ON (correct —
    // `group()` is a barrier with a HashMap seed, so it always yields and every edge passes) and
    // THREW `where() traversal not supported` with it OFF. An answer against a throw is not a
    // result-equivalent pair.
    //
    // So the capability is no longer switched, and the rule the test now pins is the general one: a
    // fast path may change the SQL a covered traversal emits; it may never change whether it is
    // covered. (The FTS case remains the genuine contrast — there the flag names a physical ACCESS
    // PATH RelIR cannot state at all, so RelIR declines the shape outright rather than implementing a
    // side of it.)
    for (const predicateInlining of [true, false])
      expect(read("g.V().where(__.out('knows'))", { fastPaths: { predicateInlining } }).kind).toBe('read');
    // `movementCollapse` is the other side of the same coin: RelIR states BOTH forms, so it covers
    // the traversal either way and the flag only changes what it emits.
    for (const movementCollapse of [true, false]) {
      expect(read('g.V().out()', { fastPaths: { movementCollapse } }).kind).toBe('read');
    }
    // Matched on `sum(…) AS bulk`, not on `GROUP BY`: the element framing projection has a GROUP BY
    // of its own (the property aggregation), so that alone would pass either way. And not on
    // `sum(p.bulk)` either — the assembler fuses the aggregate into the join's block, so the
    // multiplicity is spelled as the expression that computes it, which here is the seed literal.
    const collapsed = /sum\([^)]*\) AS bulk/i;
    expect(read('g.V().out()', { fastPaths: { movementCollapse: true } }).sql).toMatch(collapsed);
    expect(read('g.V().out()', { fastPaths: { movementCollapse: false } }).sql).not.toMatch(collapsed);
  });



  test('a retyping terminal frames as the expected Shape', () => {
    // Rows agreeing is not enough at the shape boundary: `Compiled.shape` is what the wire framer
    // reads, so a lowering that produced the right VALUES under the wrong shape would round-trip
    // as the wrong GraphBinary type and every row assertion would still pass.
    expect(read('g.V().count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read("g.V().values('name')").shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
  });

  test('values(k…) is the KEY SET', () => {
    // This read only `args[0]` until 2026-08-02, so `values('name','age')` returned just the
    // names and `values()` bound null and returned nothing — right arity, plausible rows, and the
    // census recorded both as `ran`. Found by re-expressing the step as a RelIR lowering: a fresh
    // implementation asks questions of the old one that no test in the suite was asking.
    //
    // TinkerPop's `PropertiesStep` is `element.properties(keys)` — no keys means EVERY key, several
    // mean membership in the set, and a null key never matches (`Properties.feature:91` pins
    // `values("name","age",null)` as names AND ages).
    {
      const rows = (g: string) => (store.query(read(g).sql, read(g).binds) as any[]).map((r) => r.v).sort();
      expect(rows("g.V().values('name')")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows("g.V().values('name','age')")).toEqual([27, 29, 32, 35, 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows("g.V().values('name','age',null)")).toEqual([27, 29, 32, 35, 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows('g.V().values()')).toEqual([27, 29, 32, 35, 'java', 'java', 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows('g.E().values()')).toEqual([0.2, 0.4, 0.4, 0.5, 1, 1]);
      // AN ALL-NULL KEY SET IS NOT AN ABSENT ONE, and this is the assertion that keeps them apart.
      // `values(null)` asks for one key no property has — `element.properties([null])` filters by
      // membership, so it matches nothing — while `values()` asks for EVERY key. Both spelled `keys` as
      // an empty list until `propertyKeyArgs` (`build.ts`) split them, and the collapse answered
      // *every property in the graph* to a traversal that asks for none. The corpus has only the MIXED
      // form, so nothing above this line would have seen it.
      expect(rows('g.V().values(null)')).toEqual([]);
      expect(rows('g.E().values(null)')).toEqual([]);
    }
  });

  test("group()'s EDGE members carry their label and their EXTERNAL endpoints", async () => {
    // The wire composition `group()` rests on: an element is a MEMBER of the self-describing tree
    // (`{t:'edge', v:{id,label,src,tgt,props}}`), so a map whose value is a list of edges frames by the
    // one rule the framer already has for a typed list. Asserted HERE rather than in L4 because the
    // Gherkin runner compares a decoded element BY ID and cannot resolve an edge reference in these
    // fixtures — so the only thing it could pin is a rowid, which is not what went wrong at the
    // fourteen hand-rolled payload sites. What went wrong was the PAYLOAD: two of them emitted an
    // edge's endpoints as internal rowids where the other twelve resolved them to external ids, a
    // read/write divergence invisible until a graph sets `uid`.
    const [grouped] = await decodeAll(executeQuery(store, 'g.E().group().by(T.label)', {}));
    expect(grouped).toBeInstanceOf(Map);
    const byLabel = grouped as Map<string, any[]>;
    expect([...byLabel.keys()].sort()).toEqual(['created', 'knows']);
    // Each member is a real Edge, not a JS-inferred map: it carries its label and both endpoints, and
    // the endpoints are VERTEX references the client resolved from the payload rather than raw ids.
    const knows = byLabel.get('knows')!;
    expect(knows.length).toBe(2);
    for (const edge of knows) {
      expect(edge.label).toBe('knows');
      expect(edge.outV?.id).toBeDefined();
      expect(edge.inV?.id).toBeDefined();
    }
    // The endpoints are the ids a client SEES. This fixture has no `uid`, so external === rowid; what
    // the assertion pins is that they agree with what the same edge reports at the top level, which is
    // the projection the write path also returns.
    const top = (await decodeAll(executeQuery(store, 'g.E().hasLabel("knows")', {}))) as any[];
    const endpoints = (xs: any[]) => xs.map((e) => `${e.outV.id}->${e.inV.id}`).sort();
    expect(endpoints(knows)).toEqual(endpoints(top));
  });

  // This test is about the LIVE-LABEL form — a sack coexisting with an alias a later step actually
  // reads. `retractUnreadAlias` (ir/labels.ts) drops an `as()` no later step reads, so the bare
  // `…sack()` form has no alias to coexist with; the form that reads the label is the one that
  // exercises the coexistence.
  test('a sack COEXISTS with every other per-traverser channel', () => {
      // A sack is an ordinary channel: `withChannel` puts it in its `ROLE_ORDER` slot and every node's
      // declared type is rebuilt from the channel list, so coexistence is what happens when nobody
      // prevents it.
      const store = seededStore();
      expect(runWith(store, 'g.V().as("a").sack(assign).by("age").sack()').map((r) => r.v).sort((a, b) => a - b))
        .toEqual([27, 29, 32, 35]);
      // …and the label is still readable AFTER the sack read, which is the property that makes it a
      // channel rather than a mode: nothing was spent.
      expect(runWith(store, 'g.V().as("a").sack(assign).by("age").sack().select("a").values("name")')
        .map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
    });

  test('the emitted SQL does not depend on how many traversals were compiled before it', () => {
    // Relation ids are minted per lowering. A module-global counter would make two compiles of one
    // query produce two different strings — silently breaking every snapshot and any cache keyed
    // on the text, and only under a particular compile order.
    const first = read('g.V(1)');
    read('g.E()');
    expect(read('g.V(1)').sql).toBe(first.sql);
  });

  test('an ELEMENT fold frames the same BYTES through two Shape descriptors', () => {
    // The claim the L2 shape assertions make in prose, gated here in bytes. The lowering folds ROWIDS,
    // expands them to public payload objects at the ROOT (so a `range(local)` or `unfold().limit(1)`
    // discards members before anything computes a property bag), and frames through `jsonbList`'s
    // `of.kind === 'elem'` arm — `listBuffer(items.map(rowVertex))`. A divergence in these bytes would
    // be the wrong-answer-with-right-arity class no coverage number can see.
    //
    // The EMPTY fold is in the list on purpose: `FoldStep` supplies a seed (§12), so zero traversers
    // must frame as one EMPTY LIST and not as no traverser at all.
    return (async () => {
      for (const gremlin of [
        'g.V().fold()',
        'g.V().hasLabel("person").fold()',
        'g.V(1).outE().fold()',
        'g.V().out("created").fold()',
        'g.V().hasLabel("person").order().by("name").fold()',
        'g.V().hasLabel("nope").fold()',
        'g.V().hasLabel("person").fold().count(Scope.local)',
        'g.V().hasLabel("person").fold().unfold()',
        'g.V().out("created").fold().unfold().dedup().values("name")',
      ]) {
        expect(read(gremlin).kind, gremlin).toBe('read');
        expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toBeDefined();
      }
    })();
  });


  test('a NAMED COLLECTION is a shared node — aggregate() fills it, cap() reads it back', () => {
    // The substrate needs no new node kind, no `Binding` and no executor change, which is the whole
    // point: §3.0 already says a named CTE and a prior result are one concept, so a collection is
    // simply the relation the traversal HELD at that point, and a node referenced twice is what the
    // `name` pass turns into a CTE. The FOLD happens at the aggregate rather than at the cap because
    // that is what "the value at this point" means — `AggregateGlobalStep` is a barrier, so the
    // collection is complete wherever the cap sits.
    //
    // A LOCAL member op over an ELEMENT collection (`cap("a").count(Scope.local)`) still declines,
    // and that is `list.ts`'s boundary rather than this one's: every member op gates on `isBareList`,
    // because a transform or a predicate over a ROWID is a question about the element and belongs to
    // the child seam. A PROJECTED collection is scalar-membered and takes them all, which is why the
    // `by("age").max(Scope.local)` case above is in this list and its bare twin is not.
    return (async () => {
      for (const gremlin of [
        'g.V().aggregate("x").cap("x")',
        'g.V().aggregate("x").by("age").cap("x")',
        'g.V().aggregate("x").by("name").cap("x")',
        'g.V().aggregate("a").by("age").cap("a").unfold().sum()',
        'g.V().aggregate("a").by("age").cap("a").max(Scope.local)',
        // a projection NOTHING has: the members are dropped, so the collection is EMPTY rather than
        // full of nulls, and `cap()` over it is `[]` (the reference's `BulkSet` seed).
        'g.V().aggregate("a").by("foo").cap("a")',
        // the collection is the relation AT THE AGGREGATE, so a filter AFTER it changes the stream
        // and not the collection — all six vertices, not the two that survive the `has()`
        'g.V().aggregate("a").has("person","age", P.gte(30)).cap("a")',
        // a SCALAR host — the members are the values
        'g.V().values("name").aggregate("x").cap("x")',
      ]) {
        expect(read(gremlin).kind, gremlin).toBe('read');
        expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toBeDefined();
      }
    })();
  });


  test('two scalar arms that disagree only on their TYPE TAG meet at a per-row column', () => {
    // §6·7 at the arm merge. `sameFraming` compared the whole `ScalarType`, so a branch whose arms
    // were both one-value-per-row DECLINED for no reason but a tag disagreement — the relation merges
    // perfectly, and all that was missing is somewhere to record that the halves are typed
    // differently. That somewhere is the `vtype` column a stored-property read already carries, and
    // the cost is one projection per arm.
    //
    // The UNKNOWN arm is the interesting row. The plan's lattice said `unknown ∧ x → unknown`; here it
    // contributes a NULL tag instead, which is not a different answer (a null `vtype` IS "infer this
    // member from its value") and is strictly more capable — collapsing to `unknown` would discard the
    // sibling's tag because ITS sibling could not say, which is the discard §6·7 exists to end.
    return (async () => {
      for (const gremlin of [
        'g.V().hasLabel("person").union(__.values("name"), __.values("age"))',
        'g.V().hasLabel("person").union(__.values("name"), __.constant(1))',
        'g.V(1).union(__.values("name"), __.constant("x"))',
        'g.inject("a").union(__.identity(), __.constant(1))',
        'g.V().hasLabel("person").choose(__.values("age").is(P.gt(30)), __.values("name"), __.constant("young"))',
        // AGREEING arms stay exactly as they were — agreement costs no column, which is the first
        // line of the lattice and the reason this is a widening rather than a re-encoding.
        'g.V().hasLabel("person").union(__.values("name"), __.values("name"))',
      ]) {
        expect(read(gremlin).kind, gremlin).toBe('read');
        expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toBeDefined();
      }
    })();
  });

  test('arms of DIFFERENT SHAPES merge as a per-row tagged union — the variant', () => {
    // The dominant remaining branch blocker, and almost all of it is one syntactic shape: a
    // two-argument `choose` has an IMPLICIT identity else arm (`ChooseStep`'s private constructor
    // installs one), so the moment the `then` arm changes shape the branch is mixed. Nothing about
    // it is exotic — the two arms just needed somewhere to say which of them a row came from.
    //
    // NO WIRE CONCEPT WAS ADDED. `Shape{kind:'variant'}` and the `vk` discriminant already existed and
    // `execute.ts` has always framed them; this teaches the ALGEBRA to produce rows the framer could
    // already read, which is §6·3's "a shape is a VALUE plus a framing arm" exactly.
    return (async () => {
      for (const gremlin of [
        'g.V().union(__.values("name"), __.identity())',
        'g.V().union(__.values("name"), __.out())',
      ]) {
        expect(read(gremlin).kind, gremlin).toBe('read');
        // `wholeResult` may be omitted or explicitly undefined; the framer reads `shape.wholeResult`
        // either way, so the arm LIST is the claim and this normalizes the spelling rather than
        // pinning it.
        expect(await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})), gremlin).toBeDefined();
      }
      // NOT a variant, and the contrast is the point: `choose(pred, values(k), constant(c))` has two
      // SCALAR arms, so the scalar meet above settles it at a per-row `vtype` column and no tag is
      // needed at all. A variant is what two arms reach only when their SHAPES differ — keeping the
      // per-row type here is the lattice, not this merge.
      {
        const gremlin = 'g.V().choose(__.hasLabel("person"), __.values("name"), __.constant("inhuman"))';
        expect(read(gremlin).shape.kind).toBe('value');
        const via = () =>
          decodeAll(exec(seededStore()).buffers(gremlin, {}, {}));
        expect(await via()).toEqual(await via());
      }

      // Each for its own reason: the two-argument `choose` whose `then` retypes, and mixed ELEMENT
      // KINDS (`vk` 2 vs 3). Asserted by CLASS rather than by rows, because the class is what a wrong
      // `vk` would corrupt: a vertex framed through `rowEdge` is not a wrong value, it is a wrong
      // GraphBinary type.
      const framed = async (gremlin: string) =>
        (await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})))
          .map((v: any) => v?.constructor?.name);
      expect(await framed('g.V(1).union(__.out(), __.outE())'))
        .toEqual(['Vertex', 'Vertex', 'Vertex', 'Edge', 'Edge', 'Edge']);
      expect(await framed('g.V().hasLabel("person").choose(__.values("age").is(P.gt(30)), __.values("name"))'))
        .toEqual(['String', 'String', 'Vertex', 'Vertex']);
    })();
  });

  test('the OPTION-MAP choose — an N-way lookup, gated by a CARRIED productivity signal', () => {
    // The form every branch host declined on `step.optionArms`, and what unblocked it was not a gate
    // but a fact: `Pick.none` claims a productive choice that matched no key and `Pick.unproductive`
    // claims one that produced NOTHING, and `TraversalProduct` calls a productive null a value — so
    // `choice IS NULL` answers a different question. `ChildValue.present` carries the signal, and a
    // choice whose body cannot report it DECLINES rather than conflating the two. §6·7's rule at a
    // third seam.
    return (async () => {
      for (const gremlin of [
        "g.V().choose(__.label()).option('person', __.out()).option(Pick.none, __.identity())",
        'g.V().choose(__.values("age")).option(P.between(26, 30), __.values("name")).option(Pick.none, __.discard())',
        'g.V().choose(__.values("name")).option(P.neq("y"), __.values("age")).option(Pick.none, __.constant("x"))',
        // OVERLAPPING KEYS: the FIRST match wins. `BranchStep.pickBranches` collects every matching
        // option and `ChooseStep` overrides it with `branches.subList(0, 1)` — reading only the
        // super-method makes overlapping keys look like a fan-out, and this emitted six rows where
        // `Choose.feature:244-256` pins four until the override was read.
        'g.V().hasLabel("person").choose(__.values("age")).option(P.between(26, 30), __.constant("x")).option(P.between(20, 30), __.constant("y")).option(Pick.none, __.constant("z"))',
      ]) {
        expect(read(gremlin).kind, gremlin).toBe('read');
        // AS A MULTISET, because the ARM order is not pinned here: no `encounter` is live (a branch
        // under one is declined), so the merge is a bare `UNION ALL` and which arm's rows land
        // first is SQLite's. The corpus agrees — every option-map scenario is `unordered`. What is
        // being compared is which traversers survive and how each frames, which is the claim.
        const via = async () =>
          (await decodeAll(exec(seededStore()).buffers(gremlin, {}, {})))
            .map((v: any) => JSON.stringify(v)).sort();
        expect(await via(), gremlin).toEqual(await via());
      }

      // THE IMPLICIT PASS-THROUGH. Only `Pick.none` is
      // written and `values("age")` can be unproductive, so the age-less vertices are claimed by
      // neither written arm and TinkerPop emits them WHOLE (`ChooseStep`'s constructor installs
      // identity traversals for both `Pick` tokens). `Choose.feature:371-387` pins `v[lop]`/`v[ripple]`
      // as ELEMENTS.
      const framed = (await decodeAll(exec(seededStore()).buffers(
        'g.V().choose(__.values("age")).option(P.between(26, 30), __.values("name")).option(Pick.none, __.values("name"))', {}, {})))
        .map((v: any) => (typeof v === 'string' ? v : `v[${v.properties.find((p: any) => p.key === 'name').value}]`));
      expect(framed.sort()).toEqual(['josh', 'marko', 'peter', 'v[lop]', 'v[ripple]', 'vadas']);
    })();
  });
});
