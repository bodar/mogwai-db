import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compiler/compiler.ts';
import { read, runWith, seededStore } from './support/harness.ts';
import { CF_MAX_BINDS as DO_BIND_CAP, cfLimitViolation } from '../src/cf-limits.ts';

/**
 * THE RelIR SPINE — routing, coverage and the per-traversal differential (§10·4).
 *
 * The corpus-wide differential is `mise run test:legacy-spine` (the whole suite with the switch
 * off) and the coverage ratchet is the census `spine` column. This file holds the three things
 * neither of those can state directly:
 *
 *   1. a covered traversal actually ROUTES to RelIR, so a lowering that silently stopped firing is
 *      a failure here rather than a coverage number nobody read;
 *   2. the two spines return the SAME ROWS for it, asserted side by side at the traversal level;
 *   3. an UNCOVERED shape declines rather than throwing — the decline is the contract that keeps
 *      "not learned yet" from becoming a support regression.
 */

const store = seededStore();
const rowsVia = (gremlin: string, spine: 'rel' | 'legacy') => {
  const plan = read(gremlin, { spine });
  expect(plan.spine).toBe(spine === 'rel' ? 'rel' : 'legacy');
  return store.query(plan.sql, plan.binds).map((row) => JSON.stringify(row)).sort();
};

/** Every shape the lowering covers today. Growing coverage means growing this list. */
const COVERED = [
  'g.V()', 'g.E()', 'g.V(1)', 'g.V(1,2)', 'g.V([1,2])',
  "g.V().hasLabel('person')", "g.V().hasLabel('person','software')", "g.E().hasLabel('knows')",
  "g.V().has('name')", "g.V().has('name','marko')", "g.V().has('age',29)", "g.E().has('weight',0.5)",
  // A RUN of filters is the shape worth pinning: legacy gives each its own CTE that re-joins the
  // element table to reach a column its predecessor projected away, so `has(a).has(b)` costs two
  // redundant self-joins. RelIR conjoins them into one WHERE over one scan — measured, the same
  // index decisions with those SEARCH-by-rowid steps simply absent.
  "g.V().hasLabel('person').has('age',29)", "g.V().has('name','marko').has('age',29)",
  // The P/TextP vocabulary as RelIR expressions. Range comparisons go through the vtype-aware
  // ordering key, so a value stored as TEXT because it does not fit a numeric storage class (a
  // long past 2^53, a bigint, a bigdecimal, a duration) still orders numerically — the one arm
  // where a plausible-looking lowering is silently wrong.
  "g.V().has('age',P.gt(30))", "g.V().has('age',P.lte(29))", "g.V().has('name',P.neq('marko'))",
  "g.V().has('name',P.within('marko','josh'))", "g.V().has('name',P.without('marko'))",
  "g.V().has('name',P.within())", "g.V().has('age',P.between(20,30))", "g.V().has('age',P.inside(20,35))",
  "g.V().has('age',P.gt(20).and(P.lt(30)))", "g.V().has('age',P.not(P.gt(30)))", "g.E().has('weight',P.gte(0.5))",
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
  // Both spines answered these WRONG until 2026-08-02 — see the semantics test below.
  "g.V().values('name','age')", "g.V().values('name','age',null)", 'g.V().values()', 'g.E().values()',
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
  // legacy emits the ORDER BY as a relation (`SELECT p.v FROM c0 p ORDER BY p.v ASC`), whereas over
  // elements it folds into the FRAMING projection, which is Phase 4.2's. `by(Order.asc|desc|shuffle)`
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
  // THE REDUCER FAMILY — four step names, one `Aggregate`, and Phase 4.3's named deliverable. The
  // `min`/`max` pair over a STRING stream is the arm a numeric-only guard would silently answer nothing
  // for, so both are here.
  "g.V().values('age').sum()", "g.V().values('age').min()", "g.V().values('age').max()",
  "g.V().values('age').mean()", "g.V().values('name').min()", "g.V().values('name').max()",
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
  // relation property; `sample(n)` is `ORDER BY RANDOM() LIMIT n`, so it is covered but compared for
  // SIZE rather than for rows (see the test below — `rowsVia` would be comparing two dice).
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
  // error on a collection, which legacy raises TinkerPop's own message for (see the DECLINED list).
  "g.inject(['a','b']).toUpper(Scope.local)", "g.inject([' a ']).trim(Scope.local)",
  "g.inject([' a ']).lTrim(Scope.local)", "g.inject([' a ']).rTrim(Scope.local)",
  "g.inject(['ab','cd']).substring(Scope.local,1)", "g.inject(['ab']).replace(Scope.local,'a','z')",
  "g.inject(['ab','c']).length(Scope.local)", "g.inject([1,2]).asString(Scope.local)",
  // member predicates — `all` is "no member FAILS", which differs from "every member passes" once a
  // predicate can be NULL. Both spines had this wrong until 2026-08-03 (L4 list-member-predicate).
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
  "g.V().values('name').fold().toUpper(Scope.local)", "g.V().values('name').fold().limit(Scope.local,2)",
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
  // `unfold()` of a NESTED list (a `product()`'s pair-lists) stays in the list vocabulary — one LIST
  // traverser per member, which is the same explode with a different payload column.
  "g.inject(['a','b']).product(['c']).unfold()", "g.inject(['a','b']).product(['c','d']).unfold().count(Scope.local)",
  // `is(P.typeOf(LIST|SET))` is a type ASSERT that RETYPES the stream — §11's trap, and expressible
  // now that the list shape exists. A MAP retype still declines (see DECLINED).
  "g.V().values('list').is(P.typeOf(GType.LIST))", "g.V().values('list').is(P.typeOf(GType.SET))",
  "g.V().values('list').is(P.typeOf(GType.LIST)).unfold()",
  "g.V().values('list').is(P.typeOf(GType.LIST)).count(Scope.local)",
  "g.V().values('age').is(P.typeOf(GType.LIST))",
  // THE LEADING COERCION PREFIX, folded at COMPILE TIME by the same function legacy uses. `asNumber`/
  // `asBool`/`asDate` raise TinkerPop's exact parse and overflow messages, which SQL cannot raise at
  // all — a `CAST` answers `1` for `'1,000'` and epoch 0 for an invalid date, which is §11's "a
  // required error became a plausible value". So the fold is reused rather than re-expressed, and a
  // value that does not parse declines (see DECLINED) so legacy raises the message it owns.
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
  // VALUE, not the traverser. Framed `unknown`, which is what legacy frames (a compile-time tag would
  // be a claim the argument's declared type does not support).
  'g.V().constant(1)', 'g.V().constant(null)', "g.V().constant('x')", 'g.V().out().constant(true)',
  "g.V().values('name').constant('x')", "g.inject(1).constant('a')", 'g.V().constant(1).count()',
  'g.V().constant(123).is(P.gt(1))',
  // …and `constant(c).fold()` as a set-op OPERAND is the same fact rather than a special case: a
  // one-member list known at compile time, which is how legacy resolves it too.
  "g.V().values('age').fold().merge(__.constant(27).fold())",
  "g.V().values('age').fold().intersect(__.constant(27).fold())",
  "g.inject(['a']).merge(__.constant('b').fold())",
  // A rooted SUB-READ operand: the members are only known at RUN TIME, so the operand is a relation —
  // lowered by the SAME fold into the same algebra and read through a `Scalar` expression. No opaque
  // escape node (§10·4), and if the inner chain is not covered the decline propagates outward.
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
  'g.V().as("a").out().as("a").select(Pop.first,"a")', 'g.V().as("a").out().as("a").select(Pop.last,"a")',
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
];

/**
 * Shapes that must DECLINE, one per reason, so a decline lost to an over-eager lowering is caught
 * by name. `g.V().count()` is the ordinary "step not learned yet"; the rest are the guards.
 */
const DECLINED = [
  "g.V().bothE().otherV()",           // otherV reads the entering vertex — carried state not modelled
  "g.V().as('a').out().select('a','b')", // MULTI-label select is the map/record shape, not this one
  "g.V().as('a').out().as('a').select(Pop.all,'a')", // Pop.all is the history as a LIST value
  "g.V().as('a').out().select('a').by('name')", // a modulated select reads the SELECTED element
  "g.V().out().select('a')",           // a label bound NOWHERE drops every traverser — the empty relation
  'g.inject()',                       // the EMPTY relation, which `Values` refuses to express (§3.3)
  "g.inject([1,2],3)",                // MIXED list/scalar args: the VARIANT shape, not either of them
  "g.inject(['a','b']).order(Scope.local)",   // a member SORT needs the vtype-aware compare key
  "g.inject(['a','a']).dedup(Scope.local)",   // a member dedup keeps the FIRST occurrence per value
  "g.inject(['a','b']).reverse()",    // on a list `reverse` reverses ORDER, not each member
  "g.V().values('age').is(P.typeOf(GType.MAP))", // a MAP retype needs the map shape, not a decode
  'g.V().has(null)',                  // a null KEY is neither a property name nor a token
  'g.V().has(T.label,null)',          // a null label VALUE: legacy owns what that means
  "g.inject('a').inject('b')",        // a second inject is a UNION with the first, not a source
  'g.inject(1,2).order(Scope.local)', // LOCAL scope: a per-traverser sort of a LIST, a different arm
  "g.V().dedup().by(__.out().count())", // a SUB-TRAVERSAL projection: a child lowering, not an expr
  'g.withSack(0).V()',                // a carried sack the source seed would have to declare
  'g.withSideEffect("a",1).V()',      // a side effect
  'g.addV("person")',                 // a write
  "g.V().has('name',TextP.containing('ark'))",  // ftsSubstringPredicate's — see below
  "g.V().has('name',P.within(__.V().values('name').fold()))", // a run-time member list, not a set
  "g.V().has('name',null)",           // a null value: not a literal this route can compare
  "g.V().where(__.has('name','marko'))", // a filter-only body is a predicate on the SAME traverser
  "g.V().where(__.out().order())",    // a body step the child fold has not learned
];

describe('the RelIR spine', () => {
  for (const gremlin of COVERED) {
    test(`${gremlin} routes to RelIR and agrees with legacy`, () => {
      expect(compile(gremlin, {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
      expect(rowsVia(gremlin, 'rel')).toEqual(rowsVia(gremlin, 'legacy'));
    });
  }

  for (const gremlin of DECLINED) {
    test(`${gremlin} declines to the legacy spine`, () => {
      const plan = compile(gremlin, {}, { spine: 'rel' });
      expect(plan.kind === 'read' ? plan.spine : 'legacy').toBe('legacy');
    });
  }

  test('a slice takes its window from the emission order, not from the scan', () => {
    // Compared UNSORTED and against legacy row-for-row: a slice is the one place where the wrong
    // ORDER is the wrong ANSWER, so sorting before comparing would hide exactly the defect this
    // covers. `ms` (the census gate) would not see it either — same multiset size, different rows.
    for (const gremlin of ['g.V().limit(2)', 'g.V().range(1,3)', 'g.V().skip(2)', 'g.V().skip(1).limit(2)',
      'g.V().out().limit(2)', 'g.V().both().limit(3)', 'g.V().out().out().limit(2)', 'g.V().out().range(1,3)',
      "g.V().values('name').limit(2)", "g.V().values('name').skip(1)", "g.V().out().values('name').limit(2)"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
  });

  test('a scalar order() pins the SEQUENCE, not just the multiset', () => {
    // `rowsVia` SORTS, so the COVERED loop above is a multiset comparison and structurally cannot
    // see the two defects an `order()` actually has: a sort in the wrong DIRECTION, and a sort the
    // assembler fused away entirely. Both leave the multiset untouched, so the census cannot see
    // them either (`ms` is the gate, `ord` is telemetry). Row-for-row against legacy is what can.
    for (const gremlin of ['g.inject(3,1,2).order()', "g.inject('c','a','b').order()",
      "g.inject('c','a','b').order().by(Order.desc)", 'g.inject(3,1,2).order().limit(2)',
      'g.inject(3,1,2).order().skip(1)', "g.V().values('age').order()", "g.V().values('name').order()",
      "g.V().values('name').order().by(Order.desc)", "g.V().values('age').order().range(1,3)",
      "g.V().out().values('name').order()", "g.V().values('age').order().is(P.gt(29))"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
    // …and one ABSOLUTE assertion, because a differential agrees when both sides are wrong: the
    // ascending sequence itself, which no scan order can produce by luck three times over.
    const asc = read('g.inject(3,1,2).order()', { spine: 'rel' });
    expect(store.query(asc.sql, asc.binds).map((row: any) => row.v)).toEqual([1, 2, 3]);
  });

  test('an element order() pins the SEQUENCE, and every composition of it', () => {
    // The MINT is only observable as an ORDER, so `rowsVia`'s sorted comparison structurally cannot
    // see any of this: a wrong direction, a sort the assembler fused away, a mint that renumbered
    // per arm rather than once over the fan-out, or a slice reading the stale seed. Row-for-row
    // against legacy is what can — and every one of these is a chain `analyzeChain` reports
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
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
    // …plus two ABSOLUTE assertions, because a differential agrees when both sides are wrong. The
    // modern graph's names ascending, and the same list reversed — no scan order produces either by
    // luck six times over.
    const names = (gremlin: string) => {
      const plan = read(gremlin, { spine: 'rel' });
      return store.query(plan.sql, plan.binds).map((row: any) => JSON.parse(row.props).name[0].v);
    };
    expect(names("g.V().order().by('name')")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    expect(names("g.V().order().by('name',Order.desc)")).toEqual(['vadas', 'ripple', 'peter', 'marko', 'lop', 'josh']);
    // A non-productive `by('age')` DROPS the two software vertices rather than sorting them first.
    expect(names("g.V().order().by('age')")).toEqual(['vadas', 'marko', 'josh', 'peter']);
  });

  test('the bind budget is decided on the number the PLATFORM measures', () => {
    // A traversal legacy answers must not become a compile error because this route spells its
    // predicate more expensively, so an over-budget plan DECLINES (§11). The number that decision
    // reads has to be the rendered bind list and not the IR-occurrence count: the assembler can
    // spell one `Lit` twice, and measured over every corpus prefix, 50 of them rendered MORE binds
    // than were counted (widest 42 against 31). None crossed 100 on today's corpus, which is exactly
    // why the cheap count looked correct.
    //
    // The vtype-aware compare key is the knowable place: one element `order().by(k)` is ~26 binds
    // against legacy's 2, so a chain of them walks up to the cap and over it.
    const binds = (gremlin: string) => read(gremlin, { spine: 'rel' }).binds.length;
    expect(binds("g.V().order().by('name')")).toBeLessThan(DO_BIND_CAP);
    expect(binds("g.V().order().by('name').order().by('age').order().by('lang')")).toBeLessThan(DO_BIND_CAP);

    // Four of them is over, so it declines WHOLE and legacy answers it — with its own 2-binds-per-key
    // spelling, which is why the same traversal is cheap over there.
    const over = read("g.V().order().by('name').order().by('age').order().by('lang').order().by('x')", { spine: 'rel' });
    expect(over.spine).toBe('legacy');
    expect(over.binds.length).toBeLessThan(DO_BIND_CAP);

    // THE PROPERTY, not the example: nothing this route admits may exceed the cap. `rel-sweep`
    // holds it over all 38k admitted corpus prefixes; here it is stated where a reader will find it.
    for (const gremlin of [...COVERED, "g.V().order().by('name').order().by('age')"]) {
      const plan = read(gremlin, { spine: 'rel' });
      if (plan.spine !== 'rel') continue;
      expect(cfLimitViolation(plan.sql, plan.binds)).toBeNull();
    }
  });

  test('tail(n) reads the emission order backwards, and sample(n) is a size not a sequence', () => {
    // `tail` is the one slice where the order IS the answer twice over: which n, and in what order
    // they are reported (backwards from the end, forwards on the wire). Row-for-row against legacy.
    for (const gremlin of ['g.V().tail(2)', 'g.V().tail()', 'g.E().tail(1)', 'g.V().out().tail(2)',
      "g.V().values('name').tail(2)", "g.V().order().by('name').tail(2)", "g.V().hasLabel('person').tail(2)"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
    // …and an ABSOLUTE one: the LAST two names in emission order, reported forwards.
    const last = read("g.V().order().by('name').tail(2)", { spine: 'rel' });
    expect(store.query(last.sql, last.binds).map((row: any) => JSON.parse(row.props).name[0].v)).toEqual(['ripple', 'vadas']);

    // `sample(n)` is deliberately nondeterministic, so the differential is over the SIZE and the
    // membership — comparing two rows of dice would be comparing the dice. What must hold is that it
    // routes, that it takes n, and that n is bounded by what there is.
    const sampled = read('g.V().sample(2)', { spine: 'rel' });
    expect(sampled.spine).toBe('rel');
    expect(store.query(sampled.sql, sampled.binds)).toHaveLength(2);
    const all = read('g.V().sample(99)', { spine: 'rel' });
    expect(store.query(all.sql, all.binds)).toHaveLength(6);
    // A WEIGHTED sample (`by()`) has no shared form — the weight is a per-shape expression — so it
    // declines through the modulator gate, and LEGACY raises the message it owns. Pinned as the
    // throw rather than as a route, because RelIR throwing FIRST is how "not learned yet" becomes a
    // support regression.
    expect(() => read("g.V().sample(2).by('age')", { spine: 'rel' })).toThrow('by() is only supported');
  });

  test('a coercion that cannot PARSE declines, so the error stays the reference\'s', () => {
    // The fold is where TinkerPop's parse and overflow messages live, and SQL can raise neither — so
    // the arms that RAISE are the ones a `CAST` would silently answer for (`1` for `'1,000'`, epoch 0
    // for an invalid date). What is pinned here is that RelIR does not throw FIRST: it declines, and
    // legacy raises the message the reference specifies. A family whose members raise needs its error
    // cases enumerated as tests, because no differential covers them (§11).
    for (const [gremlin, message] of [
      ["g.inject('1,000').asNumber()", "Can't parse string '1,000' as number."],
      ["g.inject('nope').asBool()", "Can't parse"],
      ["g.inject('not-a-date').asDate()", "Can't parse"],
    ] as const) {
      expect(() => compile(gremlin, {}, { spine: 'rel' })).toThrow(message);
      expect(() => compile(gremlin, {}, { spine: 'legacy' })).toThrow(message);
    }
  });

  test('a scalar order() narrows on its MODULATOR rather than declining wholesale', () => {
    // `by()` is the one modulator the scalar tail reads, because on `order()` it names a DIRECTION
    // and not a projection. So the arms split: a direction routes, and a form that needs a value a
    // scalar stream has not got — `by(key)`, `by(traversal)`, `by(token)`, or two keys at once —
    // declines and legacy raises the message it owns. These are not `DECLINED` entries because
    // legacy THROWS for them: what is being pinned is that RelIR does not throw FIRST, since a
    // deferral raised by the wrong spine is how "not learned yet" turns into a support regression.
    expect(compile("g.V().values('name').order().by(Order.desc)", {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
    expect(() => compile("g.V().values('name').order().by('age')", {}, { spine: 'rel' }))
      .toThrow('order().by(key/traversal) on a scalar stream not supported');
    // SEVERAL comparators is legal Gremlin — `ComparatorHolder` takes one per key — and legacy refuses
    // it as "not yet supported" rather than as the reference's answer, so RelIR ANSWERS it: two
    // direction-only `by()`s over a value stream sort the same value twice, which the second term makes
    // a no-op tie-break. §11's rule cuts this way round only because the refusal is a legacy gap; the
    // legacy spine still raises its own message, which is what the differential compares.
    expect(compile("g.V().values('name').order().by(Order.asc).by(Order.desc)", {}, { spine: 'rel' }))
      .toMatchObject({ spine: 'rel' });
    expect(() => compile("g.V().values('name').order().by(Order.asc).by(Order.desc)", {}, { spine: 'legacy' }))
      .toThrow('multiple order().by() modulators');
  });

  test("a by()'s PRODUCTIVITY is honoured, both ways round", () => {
    // TinkerPop's default `by()` DROPS a traverser it yielded nothing for; `ProductiveByStrategy`
    // keeps it. Both positions are asserted with absolute counts rather than against legacy, because
    // this is the arm where "agrees with the other spine" is the weakest available evidence: a
    // productivity filter omitted on BOTH sides is a shared defect a differential cannot see, and the
    // reference graph makes the difference visible — 6 vertices, only 2 with a `lang`.
    const dropped = read("g.V().dedup().by('lang')", { spine: 'rel' });
    expect(dropped.spine).toBe('rel');
    expect(store.query(dropped.sql, dropped.binds).length).toBe(1);
    const kept = read("g.withStrategies(ProductiveByStrategy).V().dedup().by('lang')", { spine: 'rel' });
    expect(kept.spine).toBe('rel');
    // One survivor per distinct `lang` (java) PLUS one for the null key — SQL groups NULLs together in
    // a `PARTITION BY`, which is what TinkerPop's "all non-productive traversers share a key" means.
    expect(store.query(kept.sql, kept.binds).length).toBe(2);
  });

  test("a reducer's three policies each have a witness the others cannot provide", () => {
    // ELIGIBILITY, BULK WEIGHTING and the DYNAMIC result type are three independent rules, and the
    // reference fixture makes each visible only under a different traversal — so each gets its own
    // assertion rather than trusting one differential to cover all three.
    //
    // 1. ELIGIBILITY is arithmetic-vs-comparable: `min`/`max` admit TEXT because Gremlin's Comparable
    //    does, and a numeric-only guard would answer NULL here rather than a wrong number.
    const minText = read("g.V().values('name').min()", { spine: 'rel' });
    expect(minText.spine).toBe('rel');
    expect(store.query(minText.sql, minText.binds).map((row: any) => row.v)).toEqual(['josh']);

    // 2. BULK WEIGHTING applies to sum/mean and NOT to min/max, and it is only observable once a
    //    collapse upstream has made bulk anything but 1 — `both().both()` is that. A weighted min would
    //    still be the min, which is why the pair is asserted together against legacy.
    for (const gremlin of ["g.V().both().both().values('age').sum()", "g.V().both().both().values('age').mean()",
      "g.V().both().both().values('age').min()", "g.V().both().both().values('age').max()"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }

    // 3. THE MEAN IS FORCED REAL. Integer division answers 30 for the reference ages where the mean is
    //    30.75 — right shape, plausible number, and the ONLY thing that catches it is the value. RelIR
    //    forces it with a `Cast` because §3.2 makes every `Lit` a bind and a JS `1.0` binds as INTEGER,
    //    so legacy's `* 1.0` is not expressible. This assertion is that limit's regression test.
    const mean = read("g.V().values('age').mean()", { spine: 'rel' });
    expect(store.query(mean.sql, mean.binds).map((row: any) => row.v)).toEqual([30.75]);
    // The mechanism is the CAST, asserted directly — `* ?` also appears in this SQL and legitimately so
    // (that is the bulk weighting), which is why the absence of a multiplier is not the thing to check.
    expect(mean.sql).toMatch(/CAST\(sum\([^]*AS REAL\) \//);

    // …and the result's storage class rides out as the `vt` column, because a sum of integers is an
    // integer and of reals a real — there is no compile-time tag to give.
    const sum = read("g.V().values('age').sum()", { spine: 'rel' });
    expect(store.query(sum.sql, sum.binds)).toEqual([{ v: 123, vt: 'integer' }]);
    const real = read("g.V().values('age').asNumber(GType.DOUBLE).sum()", { spine: 'rel' });
    expect(store.query(real.sql, real.binds)).toEqual([{ v: 123, vt: 'real' }]);
  });

  test('a cast over a LITERAL must RAISE, so RelIR declines the constant-folded transforms', () => {
    // The one place a differential is blind by construction: these six traversals must produce an
    // ERROR, and comparing rows against legacy cannot see a missing throw. TinkerPop requires the exact
    // parse/overflow messages and SQL cannot raise them, so legacy folds `asNumber`/`asDate`/`asBool`
    // at COMPILE time over an inject literal. RelIR lowered them as SQLite casts instead, which
    // answered `1` for `'1,000'` and epoch 0 for an invalid date string — a required error turned into
    // a plausible value, which is the worst direction the "never answer a different question" rule has.
    //
    // Caught by L3 (six official scenarios, 1701 → 1695), not by the census, not by the row-for-row
    // probe, and not by the shape assertions. Promoted here so the decline is pinned by name.
    for (const [gremlin, message] of [
      ['g.inject(1694017709000d).asDate()', "Can't parse"],
      ["g.inject('1,000').asNumber(GType.BIGINT)", "Can't parse string '1,000' as number."],
      ['g.inject(300).asNumber(GType.BYTE)', "Can't convert number of type Integer to Byte due to overflow."],
      ['g.inject(32768).asNumber(GType.SHORT)', "Can't convert number of type Integer to Short due to overflow."],
      ["g.inject('invalid str').asDate()", "Can't parse"],
      ['g.inject(null).asDate()', "Can't parse"],
    ] as const) expect(() => compile(gremlin, {}, { spine: 'rel' })).toThrow(message);

    // …and the decline is the CAST SUBFAMILY over a literal, not the family: a string transform of a
    // literal has no parse to fail, so it still routes.
    expect(compile("g.inject('a','b').toUpper()", {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
    // Over a RUNTIME value there is nothing to fold and the SQL cast is the answer, so it routes there.
    expect(compile("g.V().values('age').asNumber(GType.DOUBLE)", {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
  });

  test('P.typeOf resolves through all THREE modes, and each is a different question', () => {
    // A differential is the weakest evidence here, because a `typeOf` that resolved through the WRONG
    // mode still returns rows — and on a fixture where every value's storage class happens to match
    // its declared type, the wrong mode agrees with the right one. So each mode is pinned by what it
    // must and must not touch.
    //
    // Mode 1, COMPILE-TIME type → constant fold, and the tell is that it reads no row at all:
    // `count()` is a `long`, so the predicate resolves before the query does.
    const folded = read('g.V().count().is(P.typeOf(GType.LONG))', { spine: 'rel' });
    expect(folded.spine).toBe('rel');
    expect(folded.sql).not.toMatch(/typeof\(/i);
    expect(folded.sql).not.toMatch(/vtype/);
    expect(store.query(folded.sql, folded.binds).length).toBe(1);
    const wrong = read('g.V().count().is(P.typeOf(GType.STRING))', { spine: 'rel' });
    expect(store.query(wrong.sql, wrong.binds).length).toBe(0);

    // Mode 2, PER-ROW `vtype` → compare the column, with the storage class as the fallback for a row
    // whose vtype is NULL. Both halves must be present: the column is the only thing that tells a
    // `datetime` from a `long`, and the fallback is the only thing that answers for a raw-inserted row.
    const perRow = read('g.V().values("age").is(P.typeOf(GType.INT))', { spine: 'rel' });
    expect(perRow.sql).toMatch(/vtype/);
    expect(perRow.sql).toMatch(/typeof\(/i);

    // Mode 3, NOTHING KNOWN → the storage-class test alone, and FALSE for every type SQLite's classes
    // cannot distinguish. False rather than a decline, because that is the answer the reference gives.
    const boolean = read('g.V().values("age").is(P.typeOf(GType.BOOLEAN))', { spine: 'rel' });
    expect(store.query(boolean.sql, boolean.binds).length).toBe(0);

    // A GType naming something a property value can never be is FALSE (valid syntax); an unregistered
    // NAME is an ERROR, and the two must not be confused — so the second declines and legacy raises.
    expect(compile('g.V().values("age").is(P.typeOf(GType.VERTEX))', {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
    expect(() => compile('g.V().values("age").is(P.typeOf("bogus-name"))', {}, { spine: 'rel' }))
      .toThrow("unregistered type 'bogus-name'");
  });

  test('dedup().by() keeps ONE traverser per key, deterministically', () => {
    // The survivor must be a NAMED row, not "whichever SQLite produced first" — a `PARTITION BY key`
    // with no `ORDER BY` in the window is right-arity and arbitrary, and the reference fixture is
    // small enough that the arbitrary choice is reliably the flattering one. So: row-for-row against
    // legacy, unsorted, plus the perturbation instrument (`MOGWAI_REVERSE_UNORDERED=1`) over this file.
    for (const gremlin of ["g.V().dedup().by('name')", "g.V().dedup().by('lang')",
      "g.V().dedup().by(T.label)", "g.E().dedup().by(T.label)", "g.V().dedup().by(T.id)",
      "g.E().dedup().by('weight')", "g.V().out().dedup().by('lang')",
      "g.V().dedup().by('lang').values('name')", "g.V().out().dedup().by('lang').limit(2)"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
  });

  test("a scalar order()'s key is vtype-aware, so a TEXT-stored number sorts numerically", () => {
    // The arm where a plausible-looking lowering is silently wrong, and it needs its own fixture:
    // every `age` in the reference graph fits an INTEGER storage class, so a key that skipped the
    // compare CASE would agree with legacy on all eleven traversals above. A long past 2^53 does not
    // fit, is stored as TEXT, and a lexical sort then puts it BETWEEN 12 and 300 — right multiset,
    // wrong sequence, and nothing else in the suite looks.
    const graph = seededStore();
    for (const value of ['12L', '9007199254740993L', '300L'])
      runWith(graph, `g.addV("n").property("k",${value})`);
    const plan = read("g.V().hasLabel('n').values('k').order()", { spine: 'rel' });
    expect(plan.spine).toBe('rel');
    expect(graph.query(plan.sql, plan.binds).map((row: any) => String(row.v))).toEqual(['12', '300', '9007199254740993']);
  });

  test('a positional step with no position to read fails CLOSED', () => {
    // The decline that is a SAFETY property rather than a coverage gap, and it survived the whole
    // row-algebraic class landing: a slice's answer depends on which rows come first, so a step that
    // reads a position the relation does not carry must DEFER. Omitting the channel would not defer,
    // it would pick a different window from the same multiset — right arity, plausible rows, and a
    // census that structurally cannot see it (`ord` is telemetry, `ms` is the gate).
    //
    // `tail` is where that is reachable: "the last n" is a question ABOUT emission order, and a
    // barrier has consumed the position by the time it is asked. Legacy refuses the same shape from
    // its own side, so what is being pinned is that RelIR does not answer it — nor throw first.
    expect(read('g.V().count().tail(1)', { spine: 'rel' }).spine).toBe('legacy');
    // A WEIGHTED `sample().by()` declines through the modulator gate, and legacy raises the message
    // it owns — pinned in the `tail`/`sample` test above.
    // …and it is a GATE, not a blanket: everything whose order the route DOES thread still routes,
    // including across a fan-out, where the position has to be re-minted rather than carried.
    for (const gremlin of ['g.V().limit(2)', 'g.V().dedup().limit(2)', 'g.V().out().limit(2)',
      'g.V().out().dedup().limit(1)', 'g.V().tail(2)', 'g.V().out().tail(2)', 'g.V().sample(2)']) {
      expect(read(gremlin, { spine: 'rel' }).spine).toBe('rel');
    }
  });

  test('a fast-path switch selects a STRATEGY, and RelIR covers the side it implements', () => {
    // `predicateInlining` chooses between two lowerings of a `where()` body: the correlated EXISTS
    // (which RelIR emits) and a MATERIALIZED child-existence gate — a pushed ordinal, a LEFT JOIN
    // and a rejoin — which it has not learned. With the switch off it therefore declines, exactly
    // as it declines an unlearned step, and both positions stay live for L5's differential.
    //
    // This is NOT the FTS rule inverted. There, reading the flag would have let spine choice dodge
    // an optimization RelIR cannot state at all (an index seek). Here the flag names two strategies
    // and RelIR implements one; covering only what it implements is ordinary coverage.
    expect(read("g.V().where(__.out('knows'))", { spine: 'rel' }).spine).toBe('rel');
    expect(read("g.V().where(__.out('knows'))", { spine: 'rel', fastPaths: { predicateInlining: false } }).spine).toBe('legacy');
    // `movementCollapse` is the other side of the same coin: RelIR states BOTH forms, so it covers
    // the traversal either way and the flag only changes what it emits.
    for (const movementCollapse of [true, false]) {
      expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse } }).spine).toBe('rel');
    }
    // Matched on `sum(…) AS bulk`, not on `GROUP BY`: the element framing projection has a GROUP BY
    // of its own (the property aggregation), so that alone would pass either way. And not on
    // `sum(p.bulk)` either — the assembler fuses the aggregate into the join's block, so the
    // multiplicity is spelled as the expression that computes it, which here is the seed literal.
    const collapsed = /sum\([^)]*\) AS bulk/i;
    expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse: true } }).sql).toMatch(collapsed);
    expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse: false } }).sql).not.toMatch(collapsed);
  });

  test('a fast path is never silently dropped', () => {
    // THE RULE, and it is general: coverage measures whether the new spine can EXPRESS a
    // traversal, not whether it should take it from a specialized lowering. `has(k, containing(t))`
    // routes through the `property_fts` trigram index; expressing it here as a base-table LIKE scan
    // would be a performance regression the census cannot see, reported by the coverage number as
    // progress. §4.7 is where the fast paths become plan rewrites and this decline lifts.
    expect(read("g.V().has('name',TextP.containing('ark'))", { spine: 'rel' }).spine).toBe('legacy');
    expect(read("g.V().has('name',TextP.containing('ark'))").sql).toContain('property_fts');
    // The decline is a function of the CHAIN alone, never of the fast-path config: making spine
    // choice read `fastPaths` would couple two decisions that have to stay independent.
    expect(read("g.V().has('name',TextP.containing('ark'))", { spine: 'rel', fastPaths: { ftsSubstringPredicate: false } }).spine).toBe('legacy');
  });

  test('the switch is a preference, never a claim about coverage', () => {
    // Asking for RelIR does not make an uncovered chain route there, and asking for legacy always
    // works. Coverage is a property of the CHAIN; if these ever diverge the router has started
    // deciding something the lowering should own.
    // Any chain the fold has not learned serves — this one is the MAP shape (`valueMap`), and it will
    // need replacing when that lands, which is the point: there is no permanently uncovered chain and
    // pinning one would be pinning a gap rather than the rule.
    expect(read('g.V().valueMap()', { spine: 'rel' }).spine).toBe('legacy');
    expect(read('g.V()', { spine: 'legacy' }).spine).toBe('legacy');
    expect(read('g.V()', { spine: 'rel' }).spine).toBe('rel');
  });

  test('a retyping terminal frames as the same Shape on both spines', () => {
    // Rows agreeing is not enough at the shape boundary: `Compiled.shape` is what the wire framer
    // reads, so a lowering that produced the right VALUES under the wrong shape would round-trip
    // as the wrong GraphBinary type and every row assertion would still pass.
    for (const gremlin of ['g.V().count()', "g.V().values('name')", "g.E().values('weight')"]) {
      expect(read(gremlin, { spine: 'rel' }).shape).toEqual(read(gremlin, { spine: 'legacy' }).shape);
    }
    expect(read('g.V().count()', { spine: 'rel' }).shape).toEqual({ kind: 'value', type: { kind: 'static', type: 'long' } });
    expect(read("g.V().values('name')", { spine: 'rel' }).shape).toEqual({ kind: 'value', type: { kind: 'perRow', column: 'vtype' } });
  });

  test('values(k…) is the KEY SET, on both spines', () => {
    // Both spines read only `args[0]` until 2026-08-02, so `values('name','age')` returned just the
    // names and `values()` bound null and returned nothing — right arity, plausible rows, and the
    // census recorded both as `ran`. Found by re-expressing the step in RelIR: a second
    // implementation asks questions of the first that no test in the suite was asking.
    //
    // TinkerPop's `PropertiesStep` is `element.properties(keys)` — no keys means EVERY key, several
    // mean membership in the set, and a null key never matches (`Properties.feature:91` pins
    // `values("name","age",null)` as names AND ages). Asserted on both spines, because the fix
    // landed in both and the differential requires them to agree.
    for (const spine of ['legacy', 'rel'] as const) {
      const rows = (g: string) => (store.query(read(g, { spine }).sql, read(g, { spine }).binds) as any[]).map((r) => r.v).sort();
      expect(rows("g.V().values('name')")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows("g.V().values('name','age')")).toEqual([27, 29, 32, 35, 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows("g.V().values('name','age',null)")).toEqual([27, 29, 32, 35, 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows('g.V().values()')).toEqual([27, 29, 32, 35, 'java', 'java', 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows('g.E().values()')).toEqual([0.2, 0.4, 0.4, 0.5, 1, 1]);
    }
  });

  test('the emitted SQL does not depend on how many traversals were compiled before it', () => {
    // Relation ids are minted per lowering. A module-global counter would make two compiles of one
    // query produce two different strings — silently breaking every snapshot and any cache keyed
    // on the text, and only under a particular compile order.
    const first = read('g.V(1)', { spine: 'rel' });
    read('g.E()', { spine: 'rel' });
    expect(read('g.V(1)', { spine: 'rel' }).sql).toBe(first.sql);
  });
});
