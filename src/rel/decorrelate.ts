import { atMostOneRow, rowBounds, rowBoundsWith } from './bounds.ts';
import { ownDraws } from './copies.ts';
import type { Expr } from './expr.ts';
import { and, col, compilerInt, compilerNull, compilerText, eq } from './expr.ts';
import * as make from './factory.ts';
import type { Rel } from './rel.ts';
import type { ColMeta, RelId, SortTerm } from './types.ts';
import { exprRels, forEachExpr, forEachRel, freeRelIds, mapRelChildren, mapRelExprs, recursiveStep, relChildren, relExprs, rewriteExpr, substRelId } from './walk.ts';

/**
 * GENERAL DECORRELATION — a plan correlated to ONE outer row, re-expressed as an ordinary relation KEYED by
 * the outer relation's scope key, so it can be JOINED back rather than evaluated per row.
 *
 * Neumann & Kemper's dependent-join elimination (*Unnesting Arbitrary Queries*, BTW 2015; *Improving
 * Unnesting of Complex Queries*, BTW 2025): `T ⋈ₓ B(x)` ≡ `T ⋈_{x=d} (D ⋈ₓ B)` where `D` is the DOMAIN of
 * the free variables, pushed down into `B` until every operator of `B` is an ordinary one keyed by `D`.
 * Calcite ships the 2025 top-down form, vendored here:
 * `vendor/calcite/core/src/main/java/org/apache/calcite/sql2rel/TopDownGeneralDecorrelator.java` — the domain
 * push-down (`:444`), the per-operator rules (`:737-812`), and `ROW_NUMBER` for a per-domain top-N (`:657`).
 * Two of its properties are what this module keeps:
 *
 * - **TOP-DOWN, correlation-free subtrees untouched.** The domain enters only the subtrees that reference the
 *   outer row (`touches`); an uncorrelated subtree is the same relation for every key, so a join against it
 *   needs no key at all. Depth adds key columns, never work proportional to the outer stream.
 * - **One rule per ALGEBRA node, total over the closed node set** (`src/rel/rel.ts`). The decorrelation is a
 *   property of the relational operator, not of the Gremlin step that produced it, which is why it lives
 *   here and knows nothing of traversers: an `Aggregate` is grouped by the key, a `Window` partitioned by
 *   it, a `Limit` becomes a per-key `ROW_NUMBER`, two keyed join sides are equated on it.
 *
 * ## The one subtle rule: a SCALAR aggregate over an empty key
 *
 * A correlated aggregate with no `GROUP BY` emits ONE row for every outer row, including one whose input is
 * empty — SQL's own rule (`COUNT` 0, `SUM` NULL, `json_group_array` `[]`). Grouped by the key it emits
 * nothing for an empty key: the classic "count bug". So a scalar aggregate LEFT JOINs the domain and gives
 * a missing key the value the aggregate expression takes over ZERO rows — each `Agg` replaced by its empty
 * value (`emptyAgg`) and the expression evaluated as is. That reproduces the correlated plan's answer
 * EXACTLY, whatever the expression wraps the aggregate in (`COALESCE(SUM(bulk), 0)`, a `CASE`), so the
 * per-barrier seeds the lowering already states (`fold`→`[]`, `count`→`0`, an unseeded `sum`'s
 * `HAVING`-style filter emitting nothing) carry over by construction rather than being restated per step.
 *
 * ## The contract
 *
 * `decorrelate(plan, outer, key, fresh, projection, owns)` — `plan` may reference columns of `outer` (a relation
 * carrying a column `key` that is UNIQUE per row) anywhere, including inside correlated subqueries. The answer
 * is a relation with `plan`'s columns followed by the domain's: `key` and a copy of each `outer` column the plan
 * read (or, under a `KeyProjection`, the projected columns), such that its rows whose `Decorrelated.key`
 * matches an outer row are exactly `plan`'s rows evaluated for that outer row. `null` where a node cannot be rewritten (a multi-row correlated `Values`, a
 * correlated `LIMIT` count) — the caller declines.
 *
 * `owns` names the nodes the CALLER built for this plan, and it is REQUIRED: an own-everything default keys an
 * upstream draw per outer row, splitting one shared pick into one per scope (a wrong count and an N×N cross —
 * `g.V().sample(1).aggregate('x').V().local(cap('x').unfold())`). A random draw in an owned node is drawn per
 * outer row, so it is keyed like a read of the outer row; a draw in a node it does not own is a value drawn
 * ONCE elsewhere (an upstream side effect the plan reads), so it stays one shared relation. A connector body
 * gets it from `keyedBody` (`src/compiler/rel/lower/scoped.ts`), which records what the body minted.
 *
 * Every rewritten node keeps its ORIGINAL id, so the expressions above it still resolve; a wrapper the
 * rewrite adds takes a fresh one and the parent's references are moved onto it (`substRelId`).
 *
 * ## The domain that IS its input's key projection (`KeyProjection`)
 *
 * Calcite eliminates `D` unconditionally (`TopDownGeneralDecorrelator`: a correlated equi-filter's column is
 * read off the input instead of the domain), which suits an executor that hash-joins. On SQLite, a nested-loop
 * engine, `D ⋈ B(d)` runs as an index SEEK per domain row, and eliminating `D` from a SELECTIVE host turns that
 * seek into a scan of the body's whole input — `g.V(1).map(outE().count())` would aggregate every edge to
 * answer one vertex. So elimination is never inferred from the plan here: it fires only on a fact the CALLER
 * states, that the outer relation's rows are DISTINCT key tuples (`cols`) and every key tuple of `input` is one
 * of them — `π_cols(input) ⊆ outer`, and `= outer` where the caller also says every outer row has a member
 * (`covers`). A host that POOLS its own input (`group().by(k).by(b)`, `lower/scoped.ts` `pooledGroup`) knows
 * this by construction: its domain is the DISTINCT keys of the members it pools. Under it, and only where the
 * plan reads nothing of the outer row but those columns:
 *
 * - the FILTER `input.c IS outer.d` (null-safe, so a NULL key keeps its bucket) is the key projection itself:
 *   the input is keyed by its own columns, read in place of the domain's — `D` is never joined;
 * - the KEY is then those columns jointly (`Decorrelated.key`), not the outer relation's row key;
 * - a SCALAR aggregate whose input COVERS the domain (every key has at least one row) needs no LEFT JOIN to
 *   `D`, whatever the aggregate is. Covering is `rowBounds` of the CORRELATED input, `min >= 1` (read per
 *   outer row, `src/rel/bounds.ts`), told one fact the plan does not state: the eliminated filter, under
 *   `covers`, has a row for every key tuple (`covered`). That is a STRONGER fact than the one Calcite's `Aggregate` rule keys on: it
 *   keeps the join for a `COUNT` (the count bug), because it knows the key is equi-correlated, not that each
 *   key has a row. Without `covers` the LEFT JOIN stays, matched null-safely on the key tuple.
 */
export interface Decorrelated {
  readonly rel: Rel;
  /** The key `rel`'s rows are keyed by: each `col` of `rel` equals the outer relation's column `outer`, and
   *  jointly they name ONE outer row. Without a `KeyProjection` it is the single `key` the caller passed. */
  readonly key: readonly [KeyColumn, ...KeyColumn[]];
  /** Each outer column the domain carries → its name in `rel`: the key, every column the plan read, and the
   *  columns the caller asked to `carry`. */
  readonly domain: ReadonlyMap<string, string>;
}

export interface KeyColumn {
  readonly outer: string;
  readonly col: string;
  /** May hold NULL — matched null-safely (`IS`), since a NULL key is a key. */
  readonly nullable: boolean;
}

/** THE CALLER'S FACT (see "The domain that IS its input's key projection" above): the outer relation's rows are
 *  distinct tuples of `cols` (each outer column → the `input` column it projects), and `π_cols(input) ⊆ outer` —
 *  equal where `covers` (every outer row has an `input` row). */
export interface KeyProjection {
  readonly input: RelId;
  readonly cols: ReadonlyMap<string, string>;
  readonly covers: boolean;
}

/** The predicate pairing a key with another relation's copy of it — null-safe where a key column may be NULL. */
export function keyMatch(key: readonly KeyColumn[], left: (k: KeyColumn) => Expr, right: (k: KeyColumn) => Expr): Expr {
  return key.map((k): Expr => (k.nullable ? { kind: 'binary', op: 'is', left: left(k), right: right(k) } : eq(left(k), right(k))))
    .reduce((a, b) => and(a, b));
}

type Minter = (hint: string) => RelId;

/** The columns of relation `id` that `e` reads, inside the subplans it correlates included. */
function columnsRead(e: Expr, id: RelId): ReadonlySet<string> {
  const out = new Set<string>();
  const visit = (node: Expr): void => { if (node.kind === 'col' && node.rel === id) out.add(node.name); };
  forEachExpr(e, (node) => {
    visit(node);
    for (const sub of exprRels(node)) forEachRel(sub, (rel) => relExprs(rel).forEach((x) => forEachExpr(x, visit)));
  });
  return out;
}
interface Out { readonly rel: Rel; readonly keyed: boolean }

/** The value an aggregate function takes over ZERO rows — SQL's own rule, which the correlated plan obeyed. */
function emptyAgg(e: Extract<Expr, { kind: 'agg' }>): Expr {
  switch (e.fn) {
    case 'count': return compilerInt(0);
    case 'total': return { kind: 'lit', value: 0, type: 'real', source: 'compiler-real' };
    case 'json_group_array': return compilerText('[]');
    case 'json_group_object': return compilerText('{}');
    case 'jsonb_group_array': return { kind: 'call', fn: 'jsonb', args: [compilerText('[]')] };
    case 'jsonb_group_object': return { kind: 'call', fn: 'jsonb', args: [compilerText('{}')] };
    case 'sum': case 'min': case 'max': case 'avg': case 'group_concat': case 'arg_min': case 'arg_max': return compilerNull();
  }
}

export function decorrelate(
  plan: Rel, outer: Rel, key: string, fresh: Minter, projection: KeyProjection | undefined, owns: (r: Rel) => boolean,
): Decorrelated | null {
  return decorrelateAll([plan], outer, key, fresh, projection, owns)?.[0] ?? null;
}

/**
 * SEVERAL PLANS correlated to the SAME outer row, decorrelated in ONE pass — one domain, ONE memo. A plan that
 * shares a subtree with another (a connector body's tail and the side-effect sites it collected on the way,
 * `keyedBody` in `src/compiler/rel/lower/scoped.ts`) gets the SAME keyed node for that subtree, so the shared
 * prefix stays one relation the `name` pass makes one CTE — two `decorrelate` calls would each rewrite it afresh
 * (the memo is per call) and compute it twice. The answers are in `plans`' order, each under `decorrelate`'s
 * contract; `null` where any plan cannot be rewritten.
 */
export function decorrelateAll(
  plans: readonly Rel[], outer: Rel, key: string, fresh: Minter, projection: KeyProjection | undefined, owns: (r: Rel) => boolean,
  carry: readonly string[] = [],
): readonly Decorrelated[] | null {
  const drawn = ownDraws(owns);
  const h = outer.id;
  // THE DOMAIN: the key and every outer column the plan reads, renamed so it cannot collide with a column
  // of the plan. One row per outer row (the key is unique), so D IS the domain of the free variables.
  const read = new Set<string>();
  const noteReads = (e: Expr): void => {
    rewriteExpr(e, (n) => { if (n.kind === 'col' && n.rel === h) read.add(n.name); return n; }, (p) => { walkPlan(p); return p; });
  };
  const seen = new Set<Rel>();
  const walkPlan = (r: Rel): void => {
    if (seen.has(r)) return;
    seen.add(r);
    relExprs(r).forEach(noteReads);
    if (r.kind === 'recursive') walkPlan(recursiveStep(r));
    relChildren(r).forEach(walkPlan);
  };
  plans.forEach(walkPlan);
  // A column the CALLER reads off each answer's domain (a host's encounter, `scopedSite`) is one the domain carries.
  carry.forEach((name) => read.add(name));
  // The key projection is usable only where the plan reads nothing of the outer row but its projected columns.
  const eliminating = projection && [...read].every((name) => projection.cols.has(name)) ? projection : undefined;
  read.delete(key);
  const dName = new Map<string, string>();
  if (eliminating) for (const name of eliminating.cols.keys()) dName.set(name, fresh('dk') as string);
  else {
    dName.set(key, fresh('dk') as string);
    for (const name of read) dName.set(name, fresh('dc') as string);
  }
  const outerCol = (name: string): ColMeta => {
    const c = outer.type.cols.find((column) => column.name === name);
    if (!c) throw new Error(`RelIR decorrelate: outer relation ${h} has no column '${name}'`);
    return c;
  };
  const dMeta: readonly ColMeta[] = [...dName].map(([from, to]) => ({ ...outerCol(from), name: to }));
  const dNames = dMeta.map((c) => c.name);
  // THE KEY among the domain columns: the outer row key, or — eliminating — every projected column jointly.
  const keyAt = eliminating ? dNames.map((_, i) => i) : [0];
  const keyNames = keyAt.map((i) => dNames[i]!);
  const outerNames = [...dName.keys()];
  const keyOf = (names: readonly string[]): KeyColumn[] =>
    keyAt.map((i) => ({ outer: outerNames[i]!, col: names[i]!, nullable: dMeta[i]!.nullable }));
  /** `l`'s key equal to `r`'s, each read under its own names for the domain columns. */
  const keysEqual = (l: RelId, lNames: readonly string[], r: RelId, rNames: readonly string[]): Expr =>
    keyMatch(keyOf(lNames), (k) => col(l, k.col), (k) => col(r, rNames[lNames.indexOf(k.col)]!));
  const domain = make.project({
    id: fresh('dom'), input: outer, channels: [], type: { cols: dMeta },
    exprs: [...dName].map(([from, to]) => [to, col(h, from)] as const),
  });
  const rename = (name: string): string => dName.get(name) ?? name;

  /** Does `e` (or a plan it correlates) read the outer row? */
  const exprTouches = (e: Expr): boolean => {
    let hit = false;
    rewriteExpr(e, (n) => { if (n.kind === 'col' && n.rel === h) hit = true; return n; }, (p) => { if (freeRelIds(p).has(h)) hit = true; return p; });
    return hit;
  };
  /** The outer row's columns, read off a keyed relation's domain copy instead. */
  const fromDomain = (e: Expr, keyed: RelId): Expr => substRelId(e, h, keyed, rename);
  const dPass = (from: RelId): (readonly [string, Expr])[] => dNames.map((n) => [n, col(from, n)] as const);
  const withD = (cols: readonly ColMeta[], nullable = false): ColMeta[] =>
    [...cols, ...dMeta.map((c) => (nullable ? { ...c, nullable: true } : c))];

  /** A relation that does not carry the domain, crossed with it — the domain DRIVES (left), so a correlated
   *  seek under it (`nodes.id = d.x`) stays a seek. Re-projected to the invariant column order (the
   *  relation's own columns, then the domain's) under a fresh id the caller moves its references onto. */
  const ensureKeyed = (out: Out): Out => {
    if (out.keyed) return out;
    const r = out.rel;
    const crossed = make.join({
      id: fresh('dx'), left: domain, right: r, join: 'cross', channels: r.channels,
      type: { cols: [...dMeta, ...r.type.cols] },
    });
    return {
      keyed: true,
      rel: make.project({
        id: fresh('dxp'), input: crossed, channels: r.channels, type: { cols: withD(r.type.cols) },
        exprs: [...r.type.cols.map((c) => [c.name, col(crossed.id, c.name)] as const), ...dPass(crossed.id)],
      }),
    };
  };
  /** Re-point an expression read against `from` (an input that was rewritten under a new id) at `to`, and
   *  every outer-row read at `to`'s domain copy. */
  const moved = (e: Expr, from: RelId, to: RelId): Expr => fromDomain(from === to ? e : substRelId(e, from, to), to);
  const keyTerms = (rel: RelId): SortTerm[] => keyNames.map((n) => ({ expr: col(rel, n), dir: 'asc' as const }));

  /** Rename a keyed relation's domain columns, so a JOIN of two keyed sides has one copy of each name. */
  const renamedD = (r: Rel): { readonly rel: Rel; readonly names: readonly string[] } => {
    const names = dNames.map(() => fresh('dr') as string);
    const own = r.type.cols.slice(0, r.type.cols.length - dNames.length);
    const rel = make.project({
      id: fresh('drp'), input: r, channels: r.channels,
      type: { cols: [...own, ...dMeta.map((c, i) => ({ ...c, name: names[i]! }))] },
      exprs: [...own.map((c) => [c.name, col(r.id, c.name)] as const), ...dNames.map((n, i) => [names[i]!, col(r.id, n)] as const)],
    });
    return { rel, names };
  };

  /** The key-projection filters eliminated with no conjunct left, under `covers`: each has a row for EVERY
   *  key tuple (every outer row has a member) — the one fact `covered` adds to `rowBounds`. */
  const coveringFilters = new Set<Rel>();
  /** THE COVERING QUESTION — does `input` (the CORRELATED plan, read per outer row: `rowBounds`' per-evaluation
   *  reading) yield at least one row for every key? `rowBounds` decides it, told the one fact the plan does not
   *  state: an eliminated key-projection filter in `coveringFilters` keeps a row for every key. */
  const covered = (input: Rel): boolean =>
    rowBoundsWith(input, (x) => (coveringFilters.has(x) ? { min: 1, max: rowBounds(x).max } : undefined)).min >= 1;

  /** The filter `input.c IS outer.d` over the projection's own input, for every projected pair: the input keyed
   *  by its own columns, `D` never joined. Under `covers` with no other conjunct, every key tuple has a member
   *  (`coveringFilters`). `null` where the filter is not that (a pair missing, `=` rather than the null-safe
   *  `IS`, another conjunct reading the outer row). */
  const keyProjected = (r: Extract<Rel, { kind: 'filter' }>): Out | null => {
    const projection = eliminating!;
    const conjuncts: Expr[] = [];
    const split = (e: Expr): void => { if (e.kind === 'binary' && e.op === 'and') { split(e.left); split(e.right); } else conjuncts.push(e); };
    split(r.pred);
    const matched = new Set<string>();
    const rest = conjuncts.filter((e) => {
      if (e.kind !== 'binary' || e.op !== 'is') return true;
      const [inner, outerSide] = e.left.kind === 'col' && e.left.rel === h ? [e.right, e.left] : [e.left, e.right];
      if (inner.kind !== 'col' || inner.rel !== r.input.id || outerSide.kind !== 'col' || outerSide.rel !== h) return true;
      if (projection.cols.get(outerSide.name) !== inner.name) return true;
      matched.add(outerSide.name);
      return false;
    });
    if (matched.size !== projection.cols.size || rest.some(exprTouches)) return null;
    const base = rest.length
      ? make.filter({ id: fresh('dkf'), input: r.input, channels: r.channels, type: r.input.type, pred: rest.reduce((a, b) => and(a, b)) })
      : r.input;
    if (projection.covers && !rest.length) coveringFilters.add(r);
    return {
      keyed: true,
      rel: make.project({
        id: r.id, input: base, channels: r.channels, type: { cols: withD(r.type.cols) },
        exprs: [...r.type.cols.map((c) => [c.name, col(base.id, c.name)] as const),
          ...[...dName].map(([from, to]) => [to, col(base.id, projection.cols.get(from)!)] as const)],
      }),
    };
  };

  const memo = new Map<Rel, Out | null>();
  /** Self-refs of a recursive node that became keyed, mapped to the keyed self-ref. */
  const selfs = new Map<RelId, Rel>();

  const go = (r: Rel): Out | null => {
    if (memo.has(r)) return memo.get(r)!;
    const out = rewriteNode(r);
    memo.set(r, out);
    return out;
  };

  const touchesSelf = (r: Rel): boolean => {
    if (!selfs.size) return false;
    let hit = false;
    const visit = (x: Rel): void => {
      if (hit) return;
      if (x.kind === 'self-ref' && selfs.has(x.id)) { hit = true; return; }
      relChildren(x).forEach(visit);
    };
    visit(r);
    return hit;
  };

  /** Does `e` (or a plan it correlates) read relation `id`? */
  const exprReads = (e: Expr, id: RelId): boolean => {
    let hit = false;
    rewriteExpr(e, (n) => { if (n.kind === 'col' && n.rel === id) hit = true; return n; }, (p) => { if (freeRelIds(p).has(id)) hit = true; return p; });
    return hit;
  };
  /** Does `e` read a recursive term's self-reference that this rewrite keyed? */
  const exprTouchesSelf = (e: Expr): boolean => {
    let hit = false;
    rewriteExpr(e, (n) => n, (p) => { if (touchesSelf(p)) hit = true; return p; });
    return hit;
  };

  /**
   * A SEMI/ANTI JOIN WHOSE RIGHT SIDE IS A ROW-WISE FUNCTION OF ITS OWN LEFT needs no scope key on the right.
   *
   * `Semi(L, R, on x = R.x)` where R's spine bottoms out at L ITSELF (the same node) through ROW-WISE operators
   * only — `project`, `filter`, `distinct`, `materialize` — and no expression of R reads the outer row (or a
   * keyed recursive term, or draws). Decorrelated by the general rule, R would be keyed by scope like any
   * subtree over a keyed input: its DISTINCT per scope (merging nothing across scopes), its filter asked once
   * per scope row. But for a row-wise `f = σ_P ∘ π_x`, `x ∈ f(L_d) ⟺ x ∈ π_x(L_d) ∧ P(x)`, and the left row
   * `(d, x)` is itself in `L_d`, so the test reduces to `P(x)` — the same answer under the WHOLE keyed `L`. So
   * R is rebuilt over the keyed L with the domain projected away, and the join is on `x` alone (no key
   * equality): one passing set for every scope, asked once per distinct `x` across scopes.
   *
   * The row-wise restriction IS the soundness condition: an `aggregate`, `window`, `limit` or `sort` in R would
   * observe the scope's ROW SET (a count, a rank, the first n), which is not a function of `x` alone — such an R
   * keeps the general rule. The producer this serves is `perState` (`src/compiler/rel/walk.ts`), whose emit
   * condition is asked of the walk's distinct states; any producer of the same algebra gets it. This is
   * Calcite's semi-join over a self-derived right side seen as a FILTER of the left
   * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/SemiJoinRule.java`): `L ⋉ σ_P(π_x L)` is
   * `σ_{P(x)} L`, whose predicate never reads the scope.
   */
  const existenceOverOwnRows = (r: Extract<Rel, { kind: 'join' }>): Out | null => {
    if (r.join !== 'semi' && r.join !== 'anti') return null;
    const spine: Extract<Rel, { kind: 'project' | 'filter' | 'distinct' | 'materialize' }>[] = [];
    for (let x: Rel = r.right; x !== r.left; ) {
      if (x.kind !== 'project' && x.kind !== 'filter' && x.kind !== 'distinct' && x.kind !== 'materialize') return null;
      const lowest = x.input === r.left;
      if (relExprs(x).some((e) => exprTouches(e) || exprTouchesSelf(e) || drawn.expr(e) || (!lowest && exprReads(e, r.left.id)))) return null;
      spine.push(x);
      x = x.input;
    }
    if (!spine.length || !r.on) return null;
    // `on` must PAIR the left row with its own image: every conjunct `L.c = R.b` where R's `b` is L's `c` carried
    // unchanged down the spine. Those columns are `paired`.
    const carried = (name: string): string | null => {
      let at = name;
      for (const node of spine) {
        if (node.kind !== 'project') continue;
        const e = node.exprs.find(([n]) => n === at)?.[1];
        if (e?.kind !== 'col' || e.rel !== node.input.id) return null;
        at = e.name;
      }
      return at;
    };
    const paired = new Set<string>();
    const conjuncts: Expr[] = [];
    const split = (e: Expr): void => { if (e.kind === 'binary' && e.op === 'and') { split(e.left); split(e.right); } else conjuncts.push(e); };
    split(r.on);
    for (const e of conjuncts) {
      if (e.kind !== 'binary' || (e.op !== '=' && e.op !== 'is')) return null;
      const [l, rt] = e.left.kind === 'col' && e.left.rel === r.left.id ? [e.left, e.right] : [e.right, e.left];
      if (l.kind !== 'col' || l.rel !== r.left.id || rt.kind !== 'col' || rt.rel !== r.right.id) return null;
      if (carried(rt.name) !== l.name) return null;
      paired.add(l.name);
    }
    // …and the spine COMPUTES only with paired columns, so `P` is a function of the pair: an image matching the
    // left row passes iff the left row's own image does. A filter on an unpaired column (`π_x(σ_{P(y)} L)`) asks
    // whether SOME row of the scope with that `x` passes — the scope's row set — and keeps the general rule.
    // Bottom-up: each spine column's L columns, and the L columns some expression computes with.
    const spelled = new Set<string>();
    let deps = new Map(r.left.type.cols.map((c) => [c.name, new Set([c.name])] as const));
    const depsOf = (e: Expr, input: RelId): Set<string> => {
      const out = new Set<string>();
      columnsRead(e, input).forEach((c) => deps.get(c)?.forEach((x) => out.add(x)));
      return out;
    };
    for (const node of [...spine].reverse()) {
      if (node.kind === 'project') {
        const input = node.input.id;
        deps = new Map(node.exprs.map(([n, e]) => {
          const from = depsOf(e, input);
          if (e.kind !== 'col') from.forEach((c) => spelled.add(c));
          return [n, from] as const;
        }));
      } else if (node.kind === 'filter') depsOf(node.pred, node.input.id).forEach((c) => spelled.add(c));
    }
    if ([...spelled].some((c) => !paired.has(c))) return null;
    const left = go(r.left);
    if (!left?.keyed) return null;
    // L's own columns, the domain projected away: the right side cannot see the scope.
    const stripped = make.project({
      id: fresh('dsl'), input: left.rel, channels: r.left.channels, type: r.left.type,
      exprs: r.left.type.cols.map((c) => [c.name, col(left.rel.id, c.name)] as const),
    });
    // Rebuilt bottom-up, keeping each node's id: only the lowest node read L's id, now the stripped copy's.
    let right: Rel = stripped;
    for (const node of spine.reverse()) {
      const below = right;
      const rebuilt = mapRelChildren(node, () => below);
      right = node.input === r.left ? mapRelExprs(rebuilt, (e) => substRelId(e, r.left.id, stripped.id)) : rebuilt;
    }
    const on = substRelId(r.on, r.left.id, left.rel.id);
    const joined = make.join({
      id: fresh('dj'), left: left.rel, right, join: r.join, channels: r.channels,
      type: { cols: [...r.type.cols, ...dMeta] }, on,
    });
    return {
      keyed: true,
      rel: make.project({
        id: r.id, input: joined, channels: r.channels, type: { cols: withD(r.type.cols) },
        exprs: [...r.type.cols.map((c) => [c.name, col(joined.id, c.name)] as const), ...dPass(joined.id)],
      }),
    };
  };

  const rewriteNode = (r: Rel): Out | null => {
    if (r.kind === 'self-ref') {
      const self = selfs.get(r.id);
      return self ? { rel: self, keyed: true } : { rel: r, keyed: false };
    }
    // The plan's OWN DRAW counts as touching the scope (`ownDraws`, `src/rel/copies.ts`): the correlated plan
    // drew once PER OUTER ROW, so a subtree that draws is NOT the same relation for every key, even where it reads
    // nothing of the outer row (`local(inject(1,2,3).sample(1))`, a re-source's `V().sample(1)`). Left unkeyed it
    // would be one pick shared by every key. Keyed, the domain enters beneath the draw and the existing rules
    // scope it — the `ORDER BY RANDOM()` of a `Sort`/`Window` partitioned by the key, a `Limit` a per-key
    // `ROW_NUMBER` — so it is one sort over the rows drawn from, never a draw per key evaluated separately.
    // A drawn relation the plan only READS (a node `owns` rejects: a side effect collected upstream of the host)
    // was drawn once, before the plan, and stays the one shared value it is.
    if (!freeRelIds(r).has(h) && !touchesSelf(r) && !drawn.rel(r)) return { rel: r, keyed: false };
    const own = relExprs(r).some((e) => exprTouches(e) || drawn.expr(e));
    switch (r.kind) {
      case 'scan': case 'ref': return { rel: r, keyed: false };
      case 'values': {
        if (!own) return { rel: r, keyed: false };
        if (r.rows.length !== 1) return null;
        // A one-row correlated VALUES is the outer row itself: read it off the domain.
        const row = r.rows[0]!;
        return {
          keyed: true,
          rel: make.project({
            id: r.id, input: domain, channels: r.channels, type: { cols: withD(r.type.cols) },
            exprs: [...r.type.cols.map((c, i) => [c.name, fromDomain(row[i]!, domain.id)] as const), ...dPass(domain.id)],
          }),
        };
      }
      case 'project': {
        const input = go(r.input);
        if (!input) return null;
        if (!input.keyed && !own) return input.rel === r.input ? { rel: r, keyed: false } : { rel: mapRelChildren(r, () => input.rel), keyed: false };
        // A correlated projection over a one-row, uncorrelated VALUES (the seed of a child body) reads
        // the domain directly — no cross join with a constant row.
        const unit = r.input.kind === 'values' && !input.keyed && r.input.rows.length === 1 ? r.input : null;
        if (unit) {
          const literal = (e: Expr): Expr => rewriteExpr(e, (n) => {
            if (n.kind !== 'col' || n.rel !== unit.id) return n;
            const at = unit.type.cols.findIndex((c) => c.name === n.name);
            return at < 0 ? n : unit.rows[0]![at]!;
          });
          return {
            keyed: true,
            rel: make.project({
              id: r.id, input: domain, channels: r.channels, type: { cols: withD(r.type.cols) },
              exprs: [...r.exprs.map(([n, e]) => [n, fromDomain(literal(e), domain.id)] as const), ...dPass(domain.id)],
            }),
          };
        }
        const k = ensureKeyed(input);
        return {
          keyed: true,
          rel: make.project({
            id: r.id, input: k.rel, channels: r.channels, type: { cols: withD(r.type.cols) },
            exprs: [...r.exprs.map(([n, e]) => [n, moved(e, r.input.id, k.rel.id)] as const), ...dPass(k.rel.id)],
          }),
        };
      }
      case 'filter': case 'sort': case 'distinct': case 'materialize': {
        if (r.kind === 'filter' && eliminating && r.input.id === eliminating.input) {
          const projected = keyProjected(r);
          if (projected) return projected;
        }
        const input = go(r.input);
        if (!input) return null;
        if (!input.keyed && !own) return input.rel === r.input ? { rel: r, keyed: false } : { rel: mapRelChildren(r, () => input.rel), keyed: false };
        const k = ensureKeyed(input);
        const at = (e: Expr): Expr => moved(e, r.input.id, k.rel.id);
        const base = { id: r.id, input: k.rel, channels: r.channels, type: k.rel.type };
        switch (r.kind) {
          case 'filter': return { keyed: true, rel: make.filter({ ...base, pred: at(r.pred) }) };
          // The key LEADS: an order inside one key is the plan's order, and a consumer reads it per key.
          case 'sort': return { keyed: true, rel: make.sort({ ...base, terms: [...keyTerms(k.rel.id), ...r.terms.map((t) => ({ ...t, expr: at(t.expr) }))] }) };
          case 'distinct': return { keyed: true, rel: make.distinct(base) };
          case 'materialize': return { keyed: true, rel: make.materialize({ ...base, ...(r.name ? { name: r.name } : {}), ...(r.fenced ? { fenced: r.fenced } : {}) }) };
        }
      }
      case 'limit': {
        const input = go(r.input);
        if (!input) return null;
        if (!input.keyed && !own) return input.rel === r.input ? { rel: r, keyed: false } : { rel: mapRelChildren(r, () => input.rel), keyed: false };
        // A LIMIT is per outer row: the top-N PER KEY, a `ROW_NUMBER` partitioned by it (Calcite `:657`).
        const constant = (e: Expr | undefined): number | null | undefined =>
          e === undefined ? undefined : e.kind === 'lit' && typeof e.value === 'number' ? e.value : null;
        const count = constant(r.count), offset = constant(r.offset);
        if (count === null || offset === null) return null;
        const k = ensureKeyed(input);
        const keeps = !offset && (count === undefined || count >= 1);
        // LIMIT n ≥ 1 over at most ONE row per outer row (a scalar aggregate, `atMostOneRow`) is the identity:
        // no per-key window. A PARAMETER count is the user's to vary, so the plan does not depend on it.
        if (keeps && (!r.count || (r.count.kind === 'lit' && r.count.source !== 'parameter')) && atMostOneRow(r.input)) {
          return {
            keyed: true,
            rel: make.project({ id: r.id, input: k.rel, channels: r.channels, type: k.rel.type, exprs: k.rel.type.cols.map((c) => [c.name, col(k.rel.id, c.name)] as const) }),
          };
        }
        // A domain of at most ONE row (the outer is a correlated body's one-row seed — `local(in().limit(1))`
        // inside a correlated `EXISTS`) has ONE key: top-N per key IS the plain top-N, so it stays a `LIMIT`,
        // which stops at the n-th row. The per-key `ROW_NUMBER` would number the WHOLE input first — a hub's
        // entire neighbourhood per outer row, super-linear wherever many outer rows reach one hub (measured).
        if (atMostOneRow(outer)) {
          return { keyed: true, rel: make.limit({ id: r.id, input: k.rel, channels: r.channels, type: k.rel.type, ...(r.count ? { count: r.count } : {}), ...(r.offset ? { offset: r.offset } : {}) }) };
        }
        // Ranked over the SORT the limit reads, where there is one (its terms resolve against its own
        // input, so the window replaces the sort rather than sitting above it).
        const sorted = k.rel.kind === 'sort' ? k.rel : null;
        const base = sorted ? sorted.input : k.rel;
        const order = sorted ? sorted.terms.filter((t) => !(t.expr.kind === 'col' && t.expr.rel === base.id && keyNames.includes(t.expr.name))) : [];
        const RN = fresh('drn') as string;
        const windowed = make.window({
          id: fresh('dw'), input: base, channels: base.channels, type: { cols: [...base.type.cols, { name: RN, type: 'int', nullable: false }] },
          specs: [[RN, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: keyNames.map((n) => col(base.id, n)), orderBy: order } }]],
        });
        const rn = col(windowed.id, RN);
        const lower: Expr = { kind: 'binary', op: '>', left: rn, right: compilerInt(offset ?? 0) };
        const pred: Expr = count === undefined ? lower
          : { kind: 'binary', op: 'and', left: lower, right: { kind: 'binary', op: '<=', left: rn, right: compilerInt((offset ?? 0) + count) } };
        const kept = make.filter({ id: fresh('dlf'), input: windowed, channels: windowed.channels, type: windowed.type, pred });
        return {
          keyed: true,
          rel: make.project({
            id: r.id, input: kept, channels: r.channels, type: k.rel.type,
            exprs: k.rel.type.cols.map((c) => [c.name, col(kept.id, c.name)] as const),
          }),
        };
      }
      case 'window': {
        const input = go(r.input);
        if (!input) return null;
        if (!input.keyed && !own) return input.rel === r.input ? { rel: r, keyed: false } : { rel: mapRelChildren(r, () => input.rel), keyed: false };
        const k = ensureKeyed(input);
        const at = (e: Expr): Expr => moved(e, r.input.id, k.rel.id);
        const specs = r.specs.map(([name, spec]) => {
          const mapped = at(spec);
          if (mapped.kind !== 'window-expr') throw new Error('RelIR decorrelate: a Window spec must stay a WindowExpr');
          return [name, { ...mapped, spec: { ...mapped.spec, partitionBy: [...keyNames.map((n) => col(k.rel.id, n)), ...mapped.spec.partitionBy] } }] as const;
        });
        const minted = r.type.cols.slice(r.input.type.cols.length);
        const windowed = make.window({
          id: fresh('dwn'), input: k.rel, channels: r.channels, type: { cols: [...k.rel.type.cols, ...minted] }, specs,
        });
        return {
          keyed: true,
          rel: make.project({
            id: r.id, input: windowed, channels: r.channels, type: { cols: withD(r.type.cols) },
            exprs: [...r.type.cols.map((c) => [c.name, col(windowed.id, c.name)] as const), ...dPass(windowed.id)],
          }),
        };
      }
      case 'explode': {
        const input = r.input ? go(r.input) : null;
        if (r.input && !input) return null;
        if (!(input?.keyed) && !own) return !input || input.rel === r.input ? { rel: r, keyed: false } : { rel: mapRelChildren(r, () => input.rel), keyed: false };
        // A source-less (correlated) `json_each` reads the outer row: drive it from the domain.
        const k = input ? ensureKeyed(input) : { rel: domain, keyed: true };
        const expr = input ? moved(r.expr, r.input!.id, k.rel.id) : fromDomain(r.expr, k.rel.id);
        const minted = r.input ? r.type.cols.slice(r.input.type.cols.length) : r.type.cols;
        const exploded = make.explode({
          id: fresh('dex'), input: k.rel, channels: r.channels, type: { cols: [...k.rel.type.cols, ...minted] }, expr, as: r.as,
        });
        return {
          keyed: true,
          rel: make.project({
            id: r.id, input: exploded, channels: r.channels, type: { cols: withD(r.type.cols) },
            exprs: [...r.type.cols.map((c) => [c.name, col(exploded.id, c.name)] as const), ...dPass(exploded.id)],
          }),
        };
      }
      case 'aggregate': {
        const input = go(r.input);
        if (!input) return null;
        if (!input.keyed && !own) return input.rel === r.input ? { rel: r, keyed: false } : { rel: mapRelChildren(r, () => input.rel), keyed: false };
        if (r.having && !r.groupBy.length) return null;
        const k = ensureKeyed(input);
        const at = (e: Expr): Expr => moved(e, r.input.id, k.rel.id);
        const keyNames = r.type.cols.slice(0, r.groupBy.length);
        const aggCols = r.type.cols.slice(r.groupBy.length);
        // The domain copies LEAD the group keys under fresh names (a scalar aggregate's are joined back
        // against the domain itself, whose names they would otherwise repeat).
        const gNames = dNames.map(() => fresh('dg') as string);
        const grouped = make.aggregate({
          id: fresh('dag'), input: k.rel, channels: r.channels,
          type: { cols: [...dMeta.map((c, i) => ({ ...c, name: gNames[i]! })), ...keyNames, ...aggCols] },
          groupBy: [...dNames.map((n) => col(k.rel.id, n)), ...r.groupBy.map(at)],
          aggs: r.aggs.map(([n, e]) => [n, at(e)] as const),
          ...(r.having ? { having: at(r.having) } : {}),
        });
        // A grouping emits a group per key it has rows for, and nothing for one it has none for — as the
        // correlated plan did. A SCALAR one over an input that COVERS the domain (`covered`: a row for every
        // key) has no empty key, so needs no LEFT JOIN to the domain for one, whatever the aggregate is.
        if (r.groupBy.length || covered(r.input)) {
          return {
            keyed: true,
            rel: make.project({
              id: r.id, input: grouped, channels: r.channels, type: { cols: withD(r.type.cols) },
              exprs: [...r.type.cols.map((c) => [c.name, col(grouped.id, c.name)] as const),
                ...dNames.map((n, i) => [n, col(grouped.id, gNames[i]!)] as const)],
            }),
          };
        }
        // SCALAR: every key emits, an empty one with the aggregate's value over zero rows.
        // A key that may be NULL cannot say a key is missing by being NULL: the grouped side carries a marker.
        const marker = keyOf(dNames).some((k) => k.nullable) ? fresh('dgm') as string : undefined;
        const marked = marker
          ? make.aggregate({ ...grouped, aggs: [...grouped.aggs, [marker, compilerInt(1)] as const], type: { cols: [...grouped.type.cols, { name: marker, type: 'int', nullable: false }] } })
          : grouped;
        const joined = make.join({
          id: fresh('daj'), left: domain, right: marked, join: 'left', channels: [],
          type: { cols: [...dMeta, ...marked.type.cols.map((c) => ({ ...c, nullable: true }))] },
          on: keysEqual(domain.id, dNames, marked.id, gNames),
        });
        const missing: Expr = { kind: 'binary', op: 'is', left: col(joined.id, marker ?? gNames[0]!), right: compilerNull() };
        const overNothing = (e: Expr): Expr => substRelId(rewriteExpr(e, (n) => (n.kind === 'agg' ? emptyAgg(n) : n)), k.rel.id, joined.id);
        return {
          keyed: true,
          rel: make.project({
            id: r.id, input: joined, channels: r.channels, type: { cols: withD(r.type.cols) },
            exprs: [
              ...r.aggs.map(([n, e]) => [n, { kind: 'case', whens: [[missing, overNothing(at(e))]], else: col(joined.id, n) } as Expr] as const),
              ...dPass(joined.id),
            ],
          }),
        };
      }
      case 'join': {
        const selfTest = existenceOverOwnRows(r);
        if (selfTest) return selfTest;
        const left = go(r.left), right = go(r.right);
        if (!left || !right) return null;
        if (!left.keyed && !right.keyed && !own) {
          return left.rel === r.left && right.rel === r.right ? { rel: r, keyed: false }
            : { rel: mapRelChildren(r, (c) => (c === r.left ? left.rel : right.rel)), keyed: false };
        }
        // Which sides must carry the key: a side that is keyed, and — for every join but an inner/cross one
        // with a single keyed side — the left, because a per-key LEFT/SEMI/ANTI join is one per key.
        const inner = r.join === 'inner' || r.join === 'cross';
        let L = left, R = right;
        if (!L.keyed && !R.keyed) L = ensureKeyed(L);
        if (!inner && R.keyed && !L.keyed) L = ensureKeyed(L);
        const leftOut = L.rel, rightIn = R.rel;
        const both = L.keyed && R.keyed;
        const renamed = both ? renamedD(rightIn) : null;
        const rightOut = renamed ? renamed.rel : rightIn;
        const fix = (e: Expr): Expr => {
          let x = e;
          if (leftOut.id !== r.left.id) x = substRelId(x, r.left.id, leftOut.id);
          if (rightOut.id !== r.right.id) x = substRelId(x, r.right.id, rightOut.id);
          return fromDomain(x, L.keyed ? leftOut.id : rightOut.id);
        };
        const on0 = r.on ? fix(r.on) : undefined;
        const keyEq = renamed ? keysEqual(leftOut.id, dNames, rightOut.id, renamed.names) : undefined;
        const on = on0 && keyEq ? { kind: 'binary', op: 'and', left: on0, right: keyEq } as Expr : on0 ?? keyEq;
        const kind = r.join === 'cross' && on ? 'inner' : r.join;
        const existence = r.join === 'semi' || r.join === 'anti';
        const nullableRight = r.join === 'left';
        // A join's output NAMES are its declared type's, positionally (two sides routinely share a name), so
        // each side's own part keeps the original join's names and its domain part takes the domain's.
        const leftN = r.left.type.cols.length;
        const ownLeft = r.type.cols.slice(0, leftN), ownRight = r.type.cols.slice(leftN);
        const rightD = !R.keyed ? [] : dMeta.map((c, i) => ({ ...c, name: renamed ? renamed.names[i]! : c.name, nullable: nullableRight || c.nullable }));
        const joined = make.join({
          id: fresh('dj'), left: leftOut, right: rightOut, join: kind, channels: r.channels,
          type: { cols: [...ownLeft, ...(L.keyed ? dMeta : []), ...(existence ? [] : [...ownRight, ...rightD])] },
          ...(on ? { on } : {}), ...(r.ordered && kind === 'inner' ? { ordered: true } : {}),
        });
        // The domain is read off the side that carries it (the left whenever the left is keyed).
        const dFrom = L.keyed ? dNames : (renamed?.names ?? dNames);
        return {
          keyed: true,
          rel: make.project({
            id: r.id, input: joined, channels: r.channels, type: { cols: withD(r.type.cols) },
            exprs: [...r.type.cols.map((c) => [c.name, col(joined.id, c.name)] as const),
              ...dNames.map((n, i) => [n, col(joined.id, dFrom[i]!)] as const)],
          }),
        };
      }
      case 'union': {
        const inputs = r.inputs.map(go);
        if (inputs.some((x) => !x)) return null;
        const outs = inputs as Out[];
        if (!outs.some((x) => x.keyed))
          return outs.every((x, i) => x.rel === r.inputs[i]) ? { rel: r, keyed: false } : { rel: mapRelChildren(r, (c) => outs[r.inputs.indexOf(c)]!.rel), keyed: false };
        const keyed = outs.map(ensureKeyed);
        return { keyed: true, rel: make.union({ id: r.id, channels: r.channels, type: { cols: withD(r.type.cols) }, inputs: keyed.map((x) => x.rel), all: r.all }) };
      }
      case 'recursive': {
        const seed = go(r.seed);
        if (!seed) return null;
        const body = recursiveStep(r);
        const stepTouches = freeRelIds(body).has(h);
        if (!seed.keyed && !stepTouches) return seed.rel === r.seed ? { rel: r, keyed: false } : { rel: mapRelChildren(r, (c) => (c === r.seed ? seed.rel : c)), keyed: false };
        const keyedSeed = ensureKeyed(seed);
        const type = { cols: withD(r.type.cols) };
        let failed = false;
        const rec = make.recursive({
          id: r.id, name: r.name, channels: r.channels, type, cols: [...r.cols, ...dNames], seed: keyedSeed.rel,
          step: (self) => {
            selfs.set(r.id, self);
            const stepped = go(body);
            if (!stepped) { failed = true; return keyedSeed.rel; }
            return ensureKeyed(stepped).rel;
          },
        });
        recursiveStep(rec);
        if (failed) return null;
        return { rel: rec, keyed: true };
      }
    }
  };

  const [first, ...more] = keyOf(dNames);
  const answers: Decorrelated[] = [];
  for (const plan of plans) {
    const out = go(plan);
    if (!out) return null;
    answers.push({ rel: ensureKeyed(out).rel, key: [first!, ...more], domain: dName });
  }
  return answers;
}
