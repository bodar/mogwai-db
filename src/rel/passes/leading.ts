import { type Expr, and, col, compilerInt, compilerNull, conjuncts, eq, isNot } from '../expr.ts';
import * as make from '../factory.ts';
import { brandRel, type Rel } from '../rel.ts';
import { freshCopy, minter, type Minter } from '../mint.ts';
import { atMostOneRow } from '../bounds.ts';
import { columnAt, reSourceCross, spinePath } from '../lineage.ts';
import { columnLineage, nestsCorrelatedSubplans } from '../copies.ts';
import { propertyOwner } from './semijoin.ts';
import type { ColMeta, RelId, RelType, SortTerm } from '../types.ts';
import { deepColsRead, exprHasSubquery, forEachExpr, forEachRel, freeRelIds, mapColsDeep, mapRelChildren, mapRelExprs, relExprs, rewriteExpr, rewriteRels, substRelId } from '../walk.ts';

/**
 * `leading` — a PHYSICAL rewrite: a CORRELATED read of a re-source is read ELEMENT BY ELEMENT, so it stops at its
 * first hit. Same rows, same pick; a different access path.
 *
 * ## The shape
 *
 * A correlated body that re-sources (`V()`/`E()` mid-traversal, GraphStep's cross with the one seed row — the
 * re-source cross, `reSourceCross` in `src/rel/lineage.ts`) has the graph scan as its OUTERMOST loop, and its
 * emission order leads with that scan's rowid. Two reads of such a body want only its first hit:
 *
 * - a FIRST-ROW pick (`Limit 1` over a `Sort` whose leading term is the scan's rowid — `correlatedFirst`'s pick,
 *   a slice's top row): `TraversalMapStep`'s one `next()` reads the scan only up to the first element the rest of
 *   the body keeps;
 * - an EXISTENCE probe (`EXISTS` of a one-column projection of the body): `TraversalFilterStep`'s `hasNext()`
 *   stops at its first traverser.
 *
 * ## Why SQLite does not stop early by itself
 *
 * A pick sorting by more than the rowid (a hop's target, a property row, the payload) is a PARTIAL sort, which
 * SQLite stops early only if it plans the scan in rowid order. With no statistics it does not: it scans the
 * narrower covering index `nodes_gid`, whose order is effectively random, and sorts the whole cross. A body whose
 * filter the emitter computes once behind a fence is a co-routine SQLite cannot read in order at all. Either way
 * one host row × G, so N × G over the hosts (measured: `map(V().where(neq('a')).out().values('name'))` 1.2 s at
 * 1k, 5.3 s at 2k vertices; the lookup `map(V().where(eq('a')).by('age').values('name'))` 0.9 s → 3.6 s).
 *
 * ## What it becomes
 *
 * The leading element is found FIRST, as the reference finds it: the scan alone, in rowid order, each element
 * asked whether the body restricted to it has a row — `k = (SELECT s.id FROM <scan> s WHERE EXISTS(<body at s.id>)
 * ORDER BY s.id LIMIT 1)`, a one-table rowid-ordered read that stops at the first hit — and the body is then read
 * at that one element (a rowid seek), its full sort ordering only that element's results (`leadingFirst`). An
 * existence probe is the same read without the second half (`leadingProbe`). Same rows, same pick: the
 * lexicographic first row has the least leading key, and restricting the scan commutes with every operator on
 * the spine (`elementSource`). Calcite pushes a `Sort`+fetch toward the side that owns its leading key the same
 * way (`SortJoinTransposeRule`, `vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/SortJoinTransposeRule.java`);
 * here the other side may drop the outer row, so the push is an `EXISTS` rather than a limit on the side alone.
 *
 * ## Why it is a pass
 *
 * It recognises the ALGEBRA, not the step that produced it, so every host that reads a correlated body's first
 * row or existence — `map`, `project().by`, a landed `by()`, `where`/`not`, a walk condition — gets it at any
 * depth, with no list of positions. It is restricted to CORRELATED reads (the cross's seed reads an outer row):
 * a root-level re-source is read once, and its `Sort`/`Limit` over the cross is SQLite's to plan. A total
 * identity on every other shape, like `semijoin`; it runs after `fuse` and before `semijoin`, so the candidate
 * filters it pushes onto the scan reach the property-seek strategies.
 */
export function leading(plan: Rel): Rel {
  return leadingAll([plan])[0]!;
}

/** `leading` over a PROGRAM's relations as one plan: fresh names minted against all of them, one rewrite memo. */
export function leadingAll(plans: readonly Rel[]): readonly Rel[] {
  const mint = minter(...plans);
  const memo = new Map<Rel, Rel>();
  return plans.map((plan) => rewriteRels(plan, (mapped, original) => firstHit(probes(mapped, mint), original, mint), memo));
}

/** `Limit 1` over a `Sort` of a correlated re-source, led by the scan's rowid: the sort reads one element. */
function firstHit(r: Rel, original: Rel, mint: Minter): Rel {
  if (r.kind !== 'limit' || r.offset || r.count?.kind !== 'lit' || r.count.value !== 1 || r.input.kind !== 'sort') return r;
  const sorted = r.input;
  // The rewrite spells the body twice (once to find the element, once to read it), so a body whose own subplans
  // nest subplans — each of which this pass may already have rewritten — would be `2^depth` spellings.
  if (original.kind !== 'limit' || nestsCorrelatedSubplans(original.input)) return r;
  const base = sorted.input;
  const read = leadingRead(base, mint);
  const led = read ? leadingFirst(base, sorted.terms, read, mint) : base;
  if (led === base) return r;
  const sort = make.sort({ id: sorted.id, input: led, channels: sorted.channels, type: sorted.type, terms: sorted.terms.map((term) => ({ ...term, expr: substRelId(term.expr, base.id, led.id) })) });
  return make.limit({ id: r.id, input: sort, channels: r.channels, type: r.type, count: r.count });
}

/** Every `EXISTS` of a correlated re-source among `r`'s own expressions, read element by element. */
function probes(r: Rel, mint: Minter): Rel {
  let any = false;
  for (const e of relExprs(r)) forEachExpr(e, (node) => { if (node.kind === 'exists' && probed(node.plan)) any = true; });
  if (!any) return r;
  return mapRelExprs(r, (e) => rewriteExpr(e, (node) => {
    if (node.kind !== 'exists') return node;
    const rows = probed(node.plan);
    const read = rows && leadingRead(rows, mint);
    return read ? { ...node, plan: leadingProbe(read, mint) } : node;
  }));
}

/** The rows an existence probe tests — a one-column projection of a relation — or `null`. */
function probed(plan: Rel): Rel | null {
  if (plan.kind !== 'project' || plan.exprs.length !== 1) return null;
  const e = plan.exprs[0]![1];
  return e.kind === 'col' && e.rel === plan.input.id && elementSource(plan.input) ? plan.input : null;
}

const typeOf = (...cols: readonly ColMeta[]): RelType => ({ cols });
const meta = (name: string, type: ColMeta['type'], nullable = false): ColMeta => ({ name, type, nullable });

/** The existence probe over a leading read: `(SELECT key FROM kept LIMIT 1) IS NOT NULL`, over one unit row. */
function leadingProbe(read: LeadingRead, mint: Minter): Rel {
  const first = make.limit({ id: mint.id('spl'), input: read.kept, channels: read.kept.channels, type: read.kept.type, count: compilerInt(1) });
  const any: Expr = read.guarded({ kind: 'scalar', plan: make.project({ id: mint.id('spk'), input: first, channels: [], type: typeOf(meta('k', 'int', true)), exprs: [['k', col(first.id, read.key)]] }) }, meta('k', 'int', true));
  const unit = make.values({ id: mint.id('spu'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
  const hit = make.filter({ id: mint.id('spf'), input: unit, channels: [], type: unit.type, pred: isNot(any, compilerNull()) });
  return make.project({ id: mint.id('sp'), input: hit, channels: [], type: typeOf(meta('one', 'any', true)), exprs: [['one', col(hit.id, 'n')]] });
}

/** `base` read at the least element of its leading read, or `base` unchanged where the sort's leading term is not
 *  that element's rowid (a hop off the seed row is already a seek per host). */
function leadingFirst(base: Rel, sorted: readonly SortTerm[], read: LeadingRead, mint: Minter): Rel {
  const lead = sorted[0];
  if (sorted.length < 2 || lead?.expr.kind !== 'col' || lead.expr.rel !== base.id) return base;
  if (columnAt(base, lead.expr.name, read.side) !== read.key) return base;
  const least = make.limit({
    id: mint.id('cll'), input: make.sort({ id: mint.id('csl'), input: read.kept, channels: read.kept.channels, type: read.kept.type, terms: [{ ...lead, expr: col(read.kept.id, read.key) }] }),
    channels: read.kept.channels, type: read.kept.type, count: compilerInt(1),
  });
  const plan = make.project({ id: mint.id('clv'), input: least, channels: [], type: typeOf(meta('k', 'int', true)), exprs: [['k', col(least.id, read.key)]] });
  return read.at(read.guarded({ kind: 'scalar', plan }, meta('k', 'int', true))) ?? base;
}

/**
 * A re-sourcing correlated body read ELEMENT BY ELEMENT: the re-source's elements as CANDIDATES, each kept where
 * the body held to it has a row (`kept`), and the body held to any one element (`at`). `null` where the body is
 * not a re-source crossed with a correlated seed row.
 *
 * The candidates carry every filter above the cross that reads only the element and the HOST (the seed row's
 * columns are the host's): a `has()` after the re-source, which the property seek then drives, so a lookup that
 * matches nothing reads its index rather than the graph; and a test of the host alone (`where(eq('a')).by('age')`
 * over a host with no age), which SQLite evaluates once per read, ahead of the scan. A filter over a property row
 * joined to the element by its owner (`values(k).is(c)`) is carried as the property `EXISTS` a `has(k, c)` is
 * (`ownerScan`; every conjunct over one property row goes in ONE `EXISTS`, `ownerProbe`), so the same seek
 * drives it. Each stays in the body too —
 * a candidate only NARROWS, the `EXISTS` decides. Every copy is FRESH (`freshCopy`), so it may stand beside the
 * original: two relations never share an id.
 */
interface LeadingRead {
  readonly side: Rel;
  readonly key: string;
  readonly kept: Rel;
  readonly at: (key: Expr) => Rel | null;
  /** `value` asked only where the host passes the body's host-only tests, NULL elsewhere. */
  readonly guarded: (value: Expr, type: ColMeta) => Expr;
}

function leadingRead(base: Rel, mint: Minter): LeadingRead | null {
  const found = elementSource(base);
  if (!found) return null;
  const { side, key, seed, spine } = found;
  const at = (value: Expr): Rel | null => {
    const held = holdSource(base, side, (copy) => eq(col(copy.id, key), value), mint);
    const copied = held && freshCopy({ kind: 'scalar', plan: held }, mint);
    return copied?.kind === 'scalar' ? copied.plan : null;
  };
  const source = freshCopy({ kind: 'scalar', plan: side }, mint);
  if (source?.kind !== 'scalar') return null;
  // A seed column as the HOST expression it copies (`seedRow` reads the host's columns over one unit row), through
  // the projections over it (`ensureBulk`); one read off the seed's own rows is not the host's.
  const inSeed = new Set<RelId>();
  forEachRel(seed, (r) => inSeed.add(r.id));
  const seedExpr = (name: string): Expr | null => {
    const path = definingSeed(seed, name);
    if (!path) return null;
    let own = false;
    forEachExpr(path, (node) => { if (node.kind === 'col' && inSeed.has(node.rel)) own = true; });
    return own || exprHasSubquery(path) ? null : path;
  };
  // Candidate conjuncts in SPINE ORDER; a group of owner-joined conjuncts holds the place of its FIRST member. The
  // narrowing seek does not depend on it — `semijoin`'s `narrowFilter` intersects every seekable term
  // (`allOwners`) — but the candidate filter then reads in the query's own order.
  const pushed: (Expr | OwnerScan[])[] = [];
  const guards: Expr[] = [];
  // Conjuncts over an owner-joined property row, grouped by the one scan each resolves to (`ownerScan`).
  const owned = new Map<RelId, OwnerScan[]>();
  for (const filter of spine) {
    if (filter.kind !== 'filter') continue;
    for (const conjunct of conjuncts(filter.pred)) {
      const mapped = new Map<string, Expr>();
      const traced = [...deepColsRead(conjunct, filter.input.id)].every((name) => {
        const onSide = columnAt(filter.input, name, side);
        const onSeed = onSide === null ? columnAt(filter.input, name, seed) : null;
        const e = onSide !== null ? col(source.plan.id, onSide) : onSeed !== null ? seedExpr(onSeed) : null;
        if (e) mapped.set(name, e);
        return e !== null;
      });
      const moved = traced && freshCopy(mapColsDeep(conjunct, filter.input.id, (name) => mapped.get(name)!), mint);
      if (moved && [...mapped.values()].some((e) => e.kind === 'col' && e.rel === source.plan.id)) pushed.push(moved);
      else if (moved) guards.push(moved);
      else {
        const scan = ownerScan(conjunct, filter.input, spine, side, key);
        if (!scan) continue;
        const group = owned.get(scan.props.id);
        if (group) group.push(scan);
        else {
          const first = [scan];
          owned.set(scan.props.id, first);
          pushed.push(first);
        }
      }
    }
  }
  const narrowing = pushed.flatMap((term) => {
    if (!Array.isArray(term)) return [term];
    const probe = ownerProbe(term, col(source.plan.id, key), mint);
    return probe ? [probe] : [];
  });
  // A test of the HOST alone is asked ONCE per read, over one unit row ahead of the scan: SQLite places a WHERE
  // term that reads none of the scan's tables inside the scan's loop all the same, so as a candidate filter it
  // would be asked per element — and a host it rejects (no age to compare) would still scan the graph.
  const guard = guards.length ? guards.reduce((a, b) => and(a, b)) : undefined;
  const guarded = (value: Expr, type: ColMeta): Expr => {
    if (!guard) return value;
    const unit = make.values({ id: mint.id('clu'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
    const held = make.filter({ id: mint.id('clg'), input: unit, channels: [], type: unit.type, pred: guard });
    return { kind: 'scalar', plan: make.project({ id: mint.id('clq'), input: held, channels: [], type: typeOf({ ...type, nullable: true }), exprs: [[type.name, value]] }) };
  };
  const candidates = narrowing.length
    ? make.filter({ id: mint.id('clc'), input: source.plan, channels: source.plan.channels, type: source.plan.type, pred: narrowing.reduce((a, b) => and(a, b)) })
    : source.plan;
  const one = at(col(candidates.id, key));
  if (!one) return null;
  const probe = make.project({ id: mint.id('clp'), input: one, channels: [], type: typeOf(meta('one', 'any', true)), exprs: [['one', col(one.id, one.type.cols[0]!.name)]] });
  const kept = make.filter({ id: mint.id('clf'), input: candidates, channels: candidates.channels, type: candidates.type, pred: { kind: 'exists', plan: probe, negated: false } });
  return { side, key, kept, at, guarded };
}

/**
 * A spine conjunct over a PROPERTY ROW joined to the leading element by its owner — `values(k).is(c)`,
 * `properties(k).hasValue(c)`, any filter whose every column is spelled (`columnLineage`) over one property scan
 * `B` that a spine join holds as `B.owner = <the element's rowid>`: that scan (`props`), its owner column, the
 * join's own conditions on `B` alone (`own`), and the conjunct re-spelled over `B` (`spelled`). `null` on any other
 * conjunct — one reading the host, a hop's property, a subquery — which the body alone then decides.
 */
interface OwnerScan {
  readonly props: Extract<Rel, { readonly kind: 'scan' }>;
  readonly owner: string;
  readonly own: readonly Expr[];
  readonly spelled: Expr;
}

function ownerScan(conjunct: Expr, input: Rel, spine: readonly Rel[], side: Rel, key: string): OwnerScan | null {
  if (exprHasSubquery(conjunct)) return null;
  let foreign = false;
  forEachExpr(conjunct, (node) => { if (node.kind === 'col' && node.rel !== input.id) foreign = true; });
  if (foreign) return null;
  const leaves = new Map<RelId, Rel>();
  const spelled = new Map<string, Expr>();
  for (const name of deepColsRead(conjunct, input.id)) {
    const e = columnLineage(input, name, leaves);
    if (!e) return null;
    spelled.set(name, e);
  }
  const props = leaves.size === 1 ? [...leaves.values()][0]! : null;
  if (props?.kind !== 'scan') return null;
  const owner = propertyOwner(props.table);
  if (!owner) return null;
  const join = spine.find((r): r is Extract<Rel, { readonly kind: 'join' }> => r.kind === 'join' && r.right === props);
  if (!join?.on || join.join !== 'inner') return null;
  const own: Expr[] = [];
  let owned = false;
  for (const on of conjuncts(join.on)) {
    const reads = new Set<RelId>();
    forEachExpr(on, (node) => { if (node.kind === 'col') reads.add(node.rel); });
    if (exprHasSubquery(on)) continue;
    if (reads.size === 1 && reads.has(props.id)) { own.push(on); continue; }
    // `B.owner = <left column>`, where the left column is the leading element's rowid.
    if (on.kind !== 'binary' || on.op !== '=' || on.left.kind !== 'col' || on.right.kind !== 'col') continue;
    const other = on.left.rel === props.id && on.left.name === owner ? on.right : on.right.rel === props.id && on.right.name === owner ? on.left : null;
    if (other?.kind === 'col' && other.rel === join.left.id && columnAt(join.left, other.name, side) === key) owned = true;
  }
  if (!owned) return null;
  return { props, owner, own, spelled: mapColsDeep(conjunct, input.id, (name) => spelled.get(name)!) };
}

/**
 * Every spine conjunct over ONE owner-joined property scan `B` (`ownerScan`) as ONE NECESSARY candidate conjunct:
 * `EXISTS(SELECT B'.owner FROM B' WHERE B'.owner = cand.key AND <own> AND c1 AND c2 …)`. Necessary because a body
 * row restricted to the candidate carries exactly ONE such `B` row, and every spine conjunct holds of it TOGETHER —
 * so the grouped conjunction is strictly tighter than a probe per conjunct, each of which a DIFFERENT row of a
 * list-cardinality key could satisfy; and `B`'s value spelling is read once per probe, not once per conjunct. It
 * is the shape `has(k, c)` lowers to (`ownerColumn`, `src/rel/passes/semijoin.ts`), so the property seek
 * (`indexSeek`, or `trigramSeek` for a TextP) lifts the WHOLE conjunction and narrows the candidates once per
 * statement, rather than every candidate being asked the body. The body still decides; this only narrows.
 */
function ownerProbe(group: readonly OwnerScan[], candidate: Expr, mint: Minter): Expr | null {
  const { props, owner, own } = group[0]!;
  const pred = [eq(col(props.id, owner), candidate), ...own, ...group.map((scan) => scan.spelled)].reduce((a, b) => and(a, b));
  const held = make.filter({ id: mint.id('clo'), input: props, channels: [], type: props.type, pred });
  const probe = make.project({ id: mint.id('clop'), input: held, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', col(held.id, owner)]] });
  // Fresh ids throughout (`freshCopy`): `B` stays in the body, and two relations never share an id.
  return freshCopy({ kind: 'exists', plan: probe, negated: false }, mint);
}

/** Seed column `name` as the expression of the seed that DEFINES it, through its renaming projections; `null` where
 *  a non-projection defines it (the seed's own unit row). */
function definingSeed(seed: Rel, name: string): Expr | null {
  for (let r: Rel = seed, at = name; ;) {
    if (r.kind !== 'project') return null;
    const e = r.exprs.find(([column]) => column === at)?.[1];
    if (!e) return null;
    if (e.kind !== 'col' || e.rel !== r.input.id) return e;
    r = r.input;
    at = e.name;
  }
}

/**
 * The re-source a CORRELATED body reads as its OUTERMOST loop: down the body's spine (copying projections,
 * row-wise filters and sorts, a join's left side — the outer loop of a hop) to the re-source cross
 * (`reSourceCross`) whose seed reads an outer row. Its element relation (`side`), the column that is the scanned
 * element's rowid (`key`), the seed, and the spine above the cross. Every operator on the spine commutes with
 * restricting the element's rows; a `limit`, a window or an aggregate does not, and stops the walk (`null`).
 */
function elementSource(base: Rel): { readonly side: Rel; readonly key: string; readonly seed: Rel; readonly spine: readonly Rel[] } | null {
  const spine: Rel[] = [];
  for (let r: Rel = base; ;) {
    if (r.kind === 'project' || r.kind === 'filter' || r.kind === 'sort') { spine.push(r); r = r.input; continue; }
    if (r.kind !== 'join' || (r.join !== 'cross' && r.join !== 'inner')) return null;
    if (!r.on) {
      const cross = reSourceCross(r);
      if (cross) return freeRelIds(cross.seed).size ? { ...cross, spine } : null;
      if (atMostOneRow(r.left)) return null;
    }
    spine.push(r);
    r = r.left;
  }
}

/** `r` with `source` (on its spine) filtered by `pred` over a renamed copy of it; the filter takes its id. */
function holdSource(r: Rel, source: Rel, pred: (copy: Rel) => Expr, mint: Minter): Rel | null {
  const path = spinePath(r, source.id);
  if (!path || path.at(-1) !== source) return null;
  const copy = brandRel({ ...source, id: mint.id('clr') } as Rel);
  let held: Rel = make.filter({ id: source.id, input: copy, channels: source.channels, type: source.type, pred: pred(copy) });
  for (let i = path.length - 2; i >= 0; i--) {
    const below = path[i + 1]!;
    const replaced = held;
    held = mapRelChildren(path[i]!, (child) => (child === below ? replaced : child));
  }
  return held;
}
