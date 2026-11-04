import type { Expr } from './expr.ts';
import { recursiveSelf } from './factory.ts';
import * as make from './factory.ts';
import { isRel, type Rel } from './rel.ts';
import { isStmt, type Stmt } from './stmt.ts';
import type { FrameBound, RelId, SortTerm, WindowSpec } from './types.ts';

/** The structure of a node is declared ONCE, here. Every analysis and every rewrite folds over
 * these functions instead of re-deriving the shape of the union, so a new kind is a compile error
 * in one place rather than a silent omission in fifteen. No switch below has a `default` arm: with
 * `noImplicitReturns`, a new kind makes each of these fail to compile, which is the whole contract.
 * A `default` here would restore exactly the fail-open behaviour this module exists to delete. */

/**
 * ONE PER-NODE FACT, COMPUTED ONCE PER NODE — the memo every synthesized fact below is built on.
 *
 * A `Rel` is frozen at construction (`brandRel`, `factory.ts`) and an `Expr` is never mutated after it
 * is built, so a fact that reads only the node and what lies beneath it is a property of the node's
 * IDENTITY: computed on first ask, it is the answer for every later asker, in every pass, for the rest
 * of the node's life. That is Calcite's discipline — `RelMetadataQuery` answers a metadata question
 * per `RelNode` through a per-node cache
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/metadata/RelMetadataQuery.java`) — and it
 * is what keeps a whole-plan question linear when lowering, the passes, `check` and the emitter all ask
 * it of the same DAG. A WeakMap per fact, so a node the compile has dropped takes its facts with it.
 *
 * ⚠️ ONLY a fact of the node. Anything that also reads a caller's context (a scope, a binding list) is
 * not keyed by the node alone, and memoising it here would hand one caller's answer to another.
 */
export function nodeFact<N extends object, T>(compute: (node: N) => T): (node: N) => T {
  const memo = new WeakMap<N, T>();
  return (node) => {
    const known = memo.get(node);
    if (known !== undefined || memo.has(node)) return known as T;
    const value = compute(node);
    memo.set(node, value);
    return value;
  };
}

const NONE: readonly never[] = Object.freeze([]);
/** A computed child list, frozen: it is handed to every asker, so no asker may edit it. */
const fixed = <T>(items: T[]): readonly T[] => (items.length ? Object.freeze(items) : NONE);

/**
 * A recursive term is only reachable through its builder, so enumerating it needs the self-ref.
 * Memoised per `Recursive` node, so every walker — `check`, `obligations`, the emitter, every pass —
 * sees the ONE step tree, the same node identities, and one `SelfRef` for it. (The factory already
 * builds the term once per node, `factory.ts` `recursive`; this keeps the self-ref it is asked with
 * from being minted again per ask.)
 */
export const recursiveStep: (r: Extract<Rel, { readonly kind: 'recursive' }>) => Rel =
  nodeFact((r) => r.step(recursiveSelf(r)));

/**
 * Child relations, in declaration order.
 *
 * ⚠️ Deliberately NOT a cached list per node. A one- or two-element array is cheaper to allocate than a
 * WeakMap lookup is to make — measured: caching `relChildren`/`relExprs`/`exprChildren` per node made the
 * corpus compile ~3% SLOWER and `times(400)` no faster. The facts below are what is worth caching: each
 * replaces a WALK, not an allocation.
 */
export function relChildren(r: Rel): readonly Rel[] {
  switch (r.kind) {
    case 'scan': case 'values': case 'self-ref': case 'ref': return [];
    case 'project': case 'filter': case 'aggregate': case 'sort': case 'limit':
    case 'distinct': case 'window': case 'materialize': return [r.input];
    // A source-less `Explode` has no relational child at all — its input is an OUTER-scope
    // expression (see `rel.ts`), so the walk must not invent one.
    case 'explode': return r.input ? [r.input] : [];
    case 'join': return [r.left, r.right];
    case 'union': return r.inputs;
    case 'recursive': return [r.seed, recursiveStep(r)];
  }
}

/** Expressions a node owns, in declaration order. Correlated subplans inside them are reached
 * through `exprRels`, never by an analysis re-walking the expression union itself. */
export function relExprs(r: Rel): readonly Expr[] {
  const some = (...maybe: readonly (Expr | undefined)[]): readonly Expr[] => maybe.filter((e): e is Expr => e !== undefined);
  switch (r.kind) {
    case 'scan': case 'self-ref': case 'ref': return [];
    case 'values': return r.rows.flat();
    case 'project': return r.exprs.map(([, e]) => e);
    case 'filter': return [r.pred];
    case 'aggregate': return [...r.groupBy, ...r.aggs.map(([, e]) => e), ...some(r.having)];
    case 'sort': return r.terms.map((term) => term.expr);
    case 'limit': return some(r.count, r.offset);
    case 'distinct': return [];
    case 'window': return r.specs.map(([, e]) => e);
    case 'explode': return [r.expr];
    case 'materialize': return [];
    case 'join': return some(r.on);
    case 'union': case 'recursive': return [];
  }
}

/** An ordered aggregate, a window's partition/order keys and a frame bound all hold expressions.
 * Missing them is not cosmetic: a `Lit` in `partitionBy` is a bind, and `partitionBy` is the field
 * the whole per-origin/global collapse depends on (§3.2). */
const boundExprs = (bound: FrameBound): readonly Expr[] =>
  bound.kind === 'preceding' || bound.kind === 'following' ? [bound.count] : [];
const specExprs = (spec: WindowSpec): readonly Expr[] => [
  ...spec.partitionBy,
  ...spec.orderBy.map((term) => term.expr),
  ...(spec.frame ? [...boundExprs(spec.frame.start), ...boundExprs(spec.frame.end)] : []),
];

/** Does an expression tree contain a SUBQUERY node (a correlated `scalar`/`exists`/`in-query`)?
 *  A fact of the expression, memoised per node (`nodeFact`). */
export const exprHasSubquery: (e: Expr) => boolean = nodeFact((e: Expr): boolean =>
  e.kind === 'scalar' || e.kind === 'exists' || e.kind === 'in-query' || exprChildren(e).some(exprHasSubquery));

/** Sub-expressions, in declaration order. Allocated per ask, like `relChildren` and for its reason. */
export function exprChildren(e: Expr): readonly Expr[] {
  const some = (...maybe: readonly (Expr | undefined)[]): readonly Expr[] => maybe.filter((x): x is Expr => x !== undefined);
  switch (e.kind) {
    case 'col': case 'lit': case 'scalar': case 'exists': return [];
    case 'unary': case 'cast': return [e.arg];
    case 'binary': return [e.left, e.right];
    case 'case': return [...e.whens.flatMap(([when, then]) => [when, then]), ...some(e.else)];
    case 'call': return e.args;
    case 'agg': return [...e.args, ...(e.orderBy ?? []).map((term) => term.expr), ...some(e.filter)];
    case 'window-expr': return [...e.args, ...specExprs(e.spec)];
    case 'json-object': return e.entries.map(([, value]) => value);
    case 'json-array': return e.items;
    case 'in-list': return [e.expr, ...e.values];
    case 'in-query': return [e.expr];
  }
}

/** Relations an expression correlates against — the only way a subplan hangs off an Expr. */
export function exprRels(e: Expr): readonly Rel[] {
  switch (e.kind) {
    case 'col': case 'lit': case 'unary': case 'binary': case 'case': case 'cast':
    case 'call': case 'agg': case 'window-expr': case 'json-object': case 'json-array':
    case 'in-list': return [];
    case 'scalar': case 'exists': case 'in-query': return [e.plan];
  }
}

const mapTerm = (term: SortTerm, f: (e: Expr) => Expr): SortTerm => ({ ...term, expr: f(term.expr) });
const mapBound = (bound: FrameBound, f: (e: Expr) => Expr): FrameBound =>
  bound.kind === 'preceding' || bound.kind === 'following' ? { ...bound, count: f(bound.count) } : bound;
const mapSpec = (spec: WindowSpec, f: (e: Expr) => Expr): WindowSpec => ({
  partitionBy: spec.partitionBy.map(f),
  orderBy: spec.orderBy.map((term) => mapTerm(term, f)),
  frame: spec.frame && { ...spec.frame, start: mapBound(spec.frame.start, f), end: mapBound(spec.frame.end, f) },
});

/**
 * Replace a node's child relations, rebuilding through the kind's factory. Never a spread: a spread
 * keeps an obsolete field and loses the construction brand.
 *
 * `retype` overrides the declared columns AS THE NODE IS CONSTRUCTED, which is the only moment a
 * width change can be expressed: a factory validates its declared type against its children, so a
 * caller that rebuilds first and re-declares afterwards never reaches its own second step — the
 * `Join` throws inside this function (`a inner Join emits its sides' 2 columns; its type declares
 * 4`). `prune` is that caller, and the alternative was a private per-kind copy of this switch.
 */
export function mapRelChildren(r: Rel, f: (child: Rel) => Rel, retype?: Rel['type']): Rel {
  const { id, channels } = r;
  const type = retype ?? r.type;
  switch (r.kind) {
    case 'scan': case 'values': case 'self-ref': case 'ref': return r;
    case 'project': return make.project({ id, channels, type, input: f(r.input), exprs: r.exprs });
    case 'filter': return make.filter({ id, channels, type, input: f(r.input), pred: r.pred });
    case 'aggregate': return make.aggregate({ id, channels, type, input: f(r.input), groupBy: r.groupBy, aggs: r.aggs, having: r.having });
    case 'sort': return make.sort({ id, channels, type, input: f(r.input), terms: r.terms });
    case 'limit': return make.limit({ id, channels, type, input: f(r.input), count: r.count, offset: r.offset });
    case 'distinct': return make.distinct({ id, channels, type, input: f(r.input) });
    case 'window': return make.window({ id, channels, type, input: f(r.input), specs: r.specs });
    case 'explode': return make.explode({ id, channels, type, ...(r.input ? { input: f(r.input) } : {}), expr: r.expr, as: r.as });
    case 'materialize': return make.materialize({ id, channels, type, input: f(r.input), name: r.name, fenced: r.fenced });
    case 'join': return make.join({ id, channels, type, left: f(r.left), right: f(r.right), join: r.join, on: r.on, ordered: r.ordered });
    case 'union': return make.union({ id, channels, type, inputs: r.inputs.map(f), all: r.all });
    /**
     * ⚠️ **THE TERM IS REWRITTEN NOW, not on first use, and the laziness it replaces was a silent
     * wrong PLAN.** A pass whose callback has an effect beyond its return value — `name` PUSHES a
     * `Plan` binding — must have that effect while the plan is still being built. With the rewrite
     * deferred into the returned closure, a node the pass hoisted out of the recursive term was bound
     * only when the EMITTER first asked for the step, which is after `plan()` has copied the binding
     * list: the term then held a `Ref` to a binding the plan did not contain at all
     * (`checkPlan`: *"Ref 'r0' is not a Plan binding declared before this point"*). Reachable from any
     * term with a SHARED subtree in it — a seeded fold over a multi-site collection is the first one
     * built (`compiler/rel/collection.ts`, `seededFold`).
     *
     * The seed is rewritten FIRST so its bindings are declared before the term's, which is the order
     * the `WITH` list renders them in.
     *
     * `recursiveSelf(r)` is the right argument even though `r` is the OLD node: it reads only
     * `{id, name, channels, type}`, and all four are preserved by this rebuild — so the self-ref the
     * term captures is the one the new node's own `recursiveStep` would hand it.
     */
    case 'recursive': {
      const seed = f(r.seed);
      const step = f(r.step(recursiveSelf(r)));
      return make.recursive({ id, channels, type, name: r.name, cols: r.cols, seed, step: () => step });
    }
  }
}

/** Replace the expressions a node owns, position for position. */
export function mapRelExprs(r: Rel, f: (e: Expr) => Expr): Rel {
  const { id, channels, type } = r;
  const pair = ([name, e]: readonly [string, Expr]) => [name, f(e)] as const;
  switch (r.kind) {
    case 'scan': case 'self-ref': case 'ref': case 'materialize': case 'union': case 'recursive': return r;
    case 'values': return make.values({ id, channels, type, rows: r.rows.map((row) => row.map(f)) });
    case 'project': return make.project({ id, channels, type, input: r.input, exprs: r.exprs.map(pair) });
    case 'filter': return make.filter({ id, channels, type, input: r.input, pred: f(r.pred) });
    case 'aggregate': return make.aggregate({ id, channels, type, input: r.input, groupBy: r.groupBy.map(f), aggs: r.aggs.map(pair), having: r.having && f(r.having) });
    case 'sort': return make.sort({ id, channels, type, input: r.input, terms: r.terms.map((term) => mapTerm(term, f)) });
    case 'limit': return make.limit({ id, channels, type, input: r.input, count: r.count && f(r.count), offset: r.offset && f(r.offset) });
    case 'distinct': return r;
    case 'window': {
      const specs = r.specs.map(([name, spec]) => {
        const mapped = f(spec);
        if (mapped.kind !== 'window-expr') throw new Error('RelIR: a Window spec must stay a WindowExpr');
        return [name, mapped] as const;
      });
      return make.window({ id, channels, type, input: r.input, specs });
    }
    case 'explode': return make.explode({ id, channels, type, ...(r.input ? { input: r.input } : {}), expr: f(r.expr), as: r.as });
    case 'join': return make.join({ id, channels, type, left: r.left, right: r.right, join: r.join, on: r.on && f(r.on), ordered: r.ordered });
  }
}

/** Replace sub-expressions, position for position. Correlated subplans are left to `rel`. */
export function mapExprChildren(e: Expr, f: (child: Expr) => Expr, rel: (plan: Rel) => Rel = (plan) => plan): Expr {
  switch (e.kind) {
    case 'col': case 'lit': return e;
    case 'unary': case 'cast': return { ...e, arg: f(e.arg) };
    case 'binary': return { ...e, left: f(e.left), right: f(e.right) };
    case 'case': return { ...e, whens: e.whens.map(([when, then]) => [f(when), f(then)] as const), else: e.else && f(e.else) };
    case 'call': return { ...e, args: e.args.map(f) };
    case 'agg': return { ...e, args: e.args.map(f), orderBy: e.orderBy?.map((term) => mapTerm(term, f)), filter: e.filter && f(e.filter) };
    case 'window-expr': return { ...e, args: e.args.map(f), spec: mapSpec(e.spec, f) };
    case 'json-object': return { ...e, entries: e.entries.map(([key, value]) => [key, f(value)] as const) };
    case 'json-array': return { ...e, items: e.items.map(f) };
    case 'in-list': return { ...e, expr: f(e.expr), values: e.values.map(f) };
    case 'scalar': case 'exists': return { ...e, plan: rel(e.plan) };
    case 'in-query': return { ...e, expr: f(e.expr), plan: rel(e.plan) };
  }
}

/** Bottom-up expression rewrite, including the relations an expression correlates against. */
export function rewriteExpr(e: Expr, f: (node: Expr) => Expr, rel: (plan: Rel) => Rel = (plan) => plan): Expr {
  const go = (node: Expr): Expr => f(mapExprChildren(node, go, rel));
  return go(e);
}

/** Substitute one relation id for another throughout an expression, INCLUDING correlated subplans —
 *  a `simplePath()` filter's `COUNT(DISTINCT)` reads the body's path column through a scalar subquery,
 *  so a rewrite that reparents the expression must follow the reference into that subquery, or the
 *  moved copy still reads a column from the relation it was lifted off of. `rename` maps a column name
 *  of `from` to its name in `to`, for a move through a renaming projection (`fuse`'s filter transpose). */
export function substRelId(e: Expr, from: RelId, to: RelId, rename: (name: string) => string = (name) => name): Expr {
  const inSubplan = (plan: Rel): Rel =>
    mapRelExprs(mapRelChildren(plan, inSubplan), (x) => substRelId(x, from, to, rename));
  return rewriteExpr(e, (node) => (node.kind === 'col' && node.rel === from ? { ...node, rel: to, name: rename(node.name) } : node), inSubplan);
}

/**
 * Bottom-up relation rewrite that PRESERVES SHARING. The memo is the whole point: the plan is a
 * DAG (§3.4 of the build plan), and a pass that rebuilds per parent occurrence silently turns it
 * into a tree — which defeats `name`, and makes `unroll`'s replicated subplans multiply the SQL
 * text instead of sharing it.
 *
 * The callback receives the node with its children already rewritten AND the original node, so a
 * pass that pre-computed an analysis over the input plan can still key it by the node it analysed.
 *
 * `memo` is passed in by a pass that rewrites SEVERAL roots of one program (a plan's bindings and its
 * result, `rewriteAll`): one memo keeps a node two roots share one node after the rewrite as well.
 */
export function rewrite(plan: Rel, f: (mapped: Rel, original: Rel) => Rel, memo: Map<Rel, Rel> = new Map()): Rel {
  const go = (r: Rel): Rel => {
    const seen = memo.get(r);
    if (seen) return seen;
    const out = f(mapRelChildren(r, go), r);
    memo.set(r, out);
    return out;
  };
  return go(plan);
}

/**
 * `rewrite`'s counterpart for `forEachRel`'s coverage: rewrite every relation in the DAG, INCLUDING
 * the ones correlated from an expression, preserving sharing across both.
 *
 * It is a separate entry point rather than a widening of `rewrite`, and the asymmetry is deliberate
 * and load-bearing. `prune`'s analysis is keyed on the relational SPINE — a subplan node has no
 * entry in its `needs` map, so a `rewrite` that descended into subplans would prune every projection
 * inside a correlated subquery down to its channels. The two coverages are different questions and a
 * pass must say which one it is asking.
 */
export function rewriteRels(plan: Rel, f: (mapped: Rel, original: Rel) => Rel, memo: Map<Rel, Rel> = new Map()): Rel {
  const go = (r: Rel): Rel => {
    const seen = memo.get(r);
    if (seen) return seen;
    const out = f(mapRelExprs(mapRelChildren(r, go), (e) => rewriteExpr(e, (node) => node, go)), r);
    memo.set(r, out);
    return out;
  };
  return go(plan);
}

/**
 * The relation ids an expression inside this subtree references but the subtree does not DEFINE —
 * i.e. what it is correlated against.
 *
 * A subtree with a free reference is not a self-contained relation: hoisting it to a named CTE moves
 * it out of the scope its `Col`s resolve in, and the reference silently becomes either an error or,
 * worse, a same-named relation elsewhere in the statement. `name` uses it to decide what may be
 * bound; `flatten` (§4) needs the same fact to decide what it must decorrelate, which is why it is
 * here rather than private to a pass.
 *
 * A `SelfRef` defines nothing and names its walk positionally, so it is not a free reference.
 *
 * ⚠️ **ANSWERS EACH NODE ONCE — the plan is a DAG (§3.4) and the memo is not an optimization.**
 * The answer is a union over what lies beneath, so recomputing a shared node adds nothing; what it
 * costs is TIME, exponentially. Any chain of nodes that each read one shared input twice shows it — a
 * `Union` of two arms over ONE input, repeated k times, is 2^k visits without this guard. `both()` was
 * that shape until it learned to read its frontier once (`hopJoin`); measured then, on
 * `g.V().both()…count()`: 3 ms at k=8, 169 ms at k=16, 2 660 ms at k=20, while the DAG grew LINEARLY
 * throughout — the giveaway that the cost was a traversal of a shared node and never the plan itself.
 */
export const freeRelIds: (plan: Rel) => ReadonlySet<string> = nodeFact((r: Rel): ReadonlySet<string> => {
  // SYNTHESIZED from what lies beneath, not re-walked per ask: a candidate is an id this node's own
  // expressions name or one free in something beneath it, and it stays free unless the subtree defines
  // it. `name` asks this of every shared node and the lowering of every long spine, so each node is
  // answered once for all of them. What is NOT cheaper is proving a correlated id ABSENT from a subtree
  // (`definesId`): that is one search of the subtree, as the walk was, and the spine cut
  // (`boundedSpine`) is what bounds it.
  const beneath = relsBeneath(r);
  const freeBeneath = beneath.map(freeRelIds);
  const candidates = unionOf([exprReach(r).cols, ...freeBeneath]);
  if (!candidates.size) return candidates;
  // EVERY direct child's id first, and only then a subtree search: searching the left child for the right
  // one's id made each link of a long chain search the whole chain beneath it (see `definesId`).
  const free = [...candidates].filter((id) => id !== r.id
    && !beneath.some((child) => child.id === id)
    && !beneath.some((child, i) => !freeBeneath[i]!.has(id) && definesId(child, id)));
  return free.length === candidates.size ? candidates : free.length ? new Set(free) : NO_NAMES;
});

/**
 * Is `id` the id of `r` or of a relation beneath it? Asked only of a candidate that is neither the node's
 * id nor a directly-beneath node's — over the corpus, a correlated (outer) reference ~4 200 times and a
 * deeper definition 79 times, of ~34 000 own-expression references.
 *
 * BREADTH-FIRST, because a deeper definition sits a level or two down (a fused expression reading through
 * the relation beneath it) and depth-first would dive to the bottom of a long chain first. A correlated
 * reference is the costly case: proving it ABSENT is one search of the subtree, as the walk-per-ask was.
 * An exhausted search records "not here" for EVERY node it visited — each of their subtrees was searched
 * whole — so one id rising through n ancestors costs O(n) in all, not a search per ancestor.
 *
 * ⚠️ That amortisation is PER ID, and it holds for an exhausted FALSE search only. A TRUE answer stops at the
 * first hit and records it for the node asked alone, so each one is up to O(n); and n links each asking a
 * DIFFERENT id pay a search apiece — O(n²) — whatever is cached. The id a link most often asks about is its
 * own direct child's (a join's `on` reading its right side), which is why `freeRelIds` tests every DIRECT
 * child's id before asking this of any child: asked first of the left child, which does not hold the right
 * one's id, it searched the whole chain beneath at every link (measured:
 * `g.V(1).where(repeat(out()).times(2000))` spent ~4 s here).
 */
const idsDefined = new WeakMap<Rel, Map<string, boolean>>();
const recordDefines = (r: Rel, id: string, answer: boolean): void => {
  let asked = idsDefined.get(r);
  if (!asked) idsDefined.set(r, asked = new Map());
  asked.set(id, answer);
};
function definesId(r: Rel, id: string): boolean {
  if (r.id === id) return true;
  const known = idsDefined.get(r)?.get(id);
  if (known !== undefined) return known;
  const seen = new Set<Rel>([r]);
  let frontier: readonly Rel[] = [r];
  while (frontier.length) {
    const next: Rel[] = [];
    for (const node of frontier) for (const child of relsBeneath(node)) {
      if (seen.has(child)) continue;
      seen.add(child);
      const answer = child.id === id || idsDefined.get(child)?.get(id);
      if (answer === true) { recordDefines(r, id, true); return true; }
      if (answer === undefined) next.push(child);
    }
    frontier = next;
  }
  seen.forEach((node) => recordDefines(node, id, false));
  return false;
}

/**
 * Does this subtree contain a walk's own reference — SelfRef of `name`, or of ANY walk when no name
 * is given?
 *
 * ⚠️ **A `SelfRef` may not leave the recursive term it belongs to**, and that one fact has two
 * consumers, which is why it is here rather than private to either. `name` may not hoist such a
 * subtree into a CTE beside the statement — SQLite answers `circular reference`, because its rule is
 * POSITIONAL rather than a count (P1). And `check` refuses a `Materialize` over one for exactly the
 * same reason: a fence's whole purpose is to force that CTE boundary, so over the walk's own
 * reference it is a shape with no legal spelling rather than a hint the emitter may ignore.
 *
 * ⚠️ It counts a reference inside a CORRELATED SUBPLAN too. Hoisting the subplan moves that
 * reference just as surely as hoisting the spine would.
 */
export function containsSelfRef(plan: Rel, name?: string): boolean {
  let found = false;
  forEachRel(plan, (r) => { if (r.kind === 'self-ref' && (name === undefined || r.name === name)) found = true; });
  return found;
}

/**
 * Does this subtree reference a walk DEFINED OUTSIDE it — the FREE-reference question, and the one
 * `name` must ask rather than `containsSelfRef`.
 *
 * A `Recursive` node BINDS its own name, so its `SelfRef` is not free and moving the whole node
 * moves the definition with it. Asking the containment question instead makes every walk unbindable,
 * because a walk always holds its own reference — which silently costs a SHARED walk its CTE and has
 * it spelled, and computed, once per occurrence. Measured on
 * `g.V(1).until(hasLabel("software")).repeat(out()).emit()`, whose two output arms read one walk:
 * the whole `WITH RECURSIVE` block appeared verbatim twice, 1,025 → 1,928 bytes.
 *
 * This is `freeRelIds`' rule for the OTHER kind of reference, and it is deliberately the same shape:
 * a subtree is movable when nothing in it resolves against something it left behind. A `SelfRef`
 * names its walk positionally rather than through a `Col`, which is exactly why `freeRelIds` cannot
 * see it and this exists beside it.
 */
export const hasFreeSelfRef = (plan: Rel): boolean => {
  const { referenced, bound } = walkNames(plan);
  return [...referenced].some((name) => !bound.has(name));
};
/** The walk names a subtree REFERENCES (a `SelfRef`) and BINDS (a `Recursive`), each over the WHOLE
 *  subtree — a recursive node's step and every correlated subplan included, `forEachRel`'s coverage, so
 *  a reference inside either is found and a definition inside either binds it. Synthesized bottom-up,
 *  one fact per node; a node that adds nothing shares its child's answer (`unionOf`), so the sets cost
 *  memory only where walks are. */
interface WalkNames { readonly referenced: ReadonlySet<string>; readonly bound: ReadonlySet<string>; }
const walkNames: (r: Rel) => WalkNames = nodeFact((r: Rel): WalkNames => {
  const beneath = relsBeneath(r).map(walkNames);
  const referenced = unionOf(beneath.map((names) => names.referenced), r.kind === 'self-ref' ? r.name : undefined);
  const bound = unionOf(beneath.map((names) => names.bound), r.kind === 'recursive' ? r.name : undefined);
  return beneath.find((names) => names.referenced === referenced && names.bound === bound) ?? { referenced, bound };
});

/** The union of some sets plus one optional member, SHARING an input that already IS the answer — what
 *  keeps a bottom-up set fact linear in memory on a long chain, where most nodes add nothing. */
const NO_NAMES: ReadonlySet<string> = new Set();
function unionOf(sets: readonly ReadonlySet<string>[], plus?: string): ReadonlySet<string> {
  let largest: ReadonlySet<string> = NO_NAMES;
  for (const set of sets) if (set.size > largest.size) largest = set;
  const covered = (plus === undefined || largest.has(plus))
    && sets.every((set) => set === largest || [...set].every((name) => largest.has(name)));
  if (covered) return largest;
  const out = new Set<string>(largest);
  if (plus !== undefined) out.add(plus);
  sets.forEach((set) => set.forEach((name) => out.add(name)));
  return out;
}

/**
 * Can this subtree stand as its OWN CTE — the one "is it self-contained" question every hoist asks
 * (`name`'s binding, a lowering's fence). Nothing in it resolves against a relation it left behind:
 * no outer row (`freeRelIds`) and no walk defined outside it (`hasFreeSelfRef`). A CLOSED walk — a
 * whole `Recursive` node — is self-contained: it binds its own reference, so asking `containsSelfRef`
 * instead refused every fence downstream of an `emit()`/`until()` walk, and a reader that needed its
 * fence for CORRECTNESS (a tag test SQLite would otherwise fold into `json(value)`) leaked a bare
 * `malformed JSON`.
 */
export const isSelfContained = (plan: Rel): boolean => freeRelIds(plan).size === 0 && !hasFreeSelfRef(plan);

/**
 * HOW MANY DOUBLED READS LIE BENEATH THIS RELATION — the most nodes, along any one path from `r` to a
 * leaf, that each read two non-base inputs. So 2^`doubledReads(r)` bounds how many copies of any one
 * relation beneath `r` SQLite spells when it prepares `r`.
 *
 * SQLite has no LATERAL and expands every reference to a derived table or CTE into its own copy of the
 * definition — at PREPARE time, even when it then materializes the result once. So naming a relation
 * twice copies everything beneath it, and a chain of k operators that each read their input twice is 2^k
 * copies of the first (the `both()` UNION ALL wall: `g.V().both()×16` refused, `local(both()×8.count())`
 * 46 KB). A consumer about to read an input twice bounds this fact first (`hopJoin`,
 * `src/compiler/rel/lower/movement.ts`), which caps the text at a CONSTANT factor of the plan.
 *
 * - A `Scan`/`Values` is 0.
 * - A single-input node is the max over its input and the subplans its expressions correlate.
 * - A join or union is that max PLUS ONE when two or more of its inputs are not base reads
 *   (`isBaseRead`). A copy of a base read is one more scan of the same index, a constant that cannot
 *   compound, so only a non-base pair counts. Two DIFFERENT non-base inputs count too: over-counting
 *   costs only the faster form, never an answer or text.
 * - A `Ref`, a `SelfRef` and a `Recursive` are UNBOUNDED: each can stand for an arbitrarily deep
 *   definition this fact cannot see. So is any node kind not named here, because UNDER-counting is the
 *   dangerous direction — it re-enables 2^k.
 *
 * Memoized per node (`nodeFact`), so a fold that re-asks it after every step pays only for the nodes
 * built since: O(DAG) in total.
 */
export const doubledReads: (r: Rel) => number = nodeFact((r: Rel): number => {
  switch (r.kind) {
    case 'scan': case 'values':
    case 'project': case 'filter': case 'aggregate': case 'sort': case 'limit': case 'window':
    case 'distinct': case 'materialize': case 'explode':
      return beneathMax(r, 0);
    case 'join': case 'union':
      return beneathMax(r, relChildren(r).filter((input) => !isBaseRead(input)).length >= 2 ? 1 : 0);
    default: return Infinity;
  }
});
/** The most `doubledReads` beneath `r` — over its children and the subplans its expressions correlate
 *  (`relsBeneath`) — plus what `r` itself adds. */
const beneathMax = (r: Rel, adds: number): number =>
  relsBeneath(r).reduce((most, beneath) => Math.max(most, doubledReads(beneath) + adds), adds);

/**
 * IS A COPY OF THIS RELATION ONE MORE INDEX SCAN? — a base-table read: a `Scan` or `Values` under nothing
 * but row-wise `Project`/`Filter`, whose expressions correlate only against relations of the same kind.
 * `doubledReads` counts a join's or union's inputs by it. A `Ref` (a named CTE), a `SelfRef` and every
 * multi-input or barrier node answer NO: each can stand for an arbitrarily deep definition.
 */
const isBaseRead: (r: Rel) => boolean = nodeFact((r: Rel): boolean => {
  if (r.kind === 'scan' || r.kind === 'values') return true;
  if (r.kind !== 'project' && r.kind !== 'filter') return false;
  return isBaseRead(r.input) && relExprs(r).every(exprIsBaseRead);
});
const exprIsBaseRead = (e: Expr): boolean => exprRels(e).every(isBaseRead) && exprChildren(e).every(exprIsBaseRead);

/**
 * WHAT A NODE'S OWN EXPRESSIONS REACH — the relation ids their `Col`s name, and the correlated subplans
 * they hang, each ONCE and in first-visit order. A fact of the node: every whole-plan walk asks it of
 * every node it passes, so it is computed once rather than re-walking the expressions per walk, and an
 * expression SHARED within the node (fusion spells one `Expr` at several positions) is walked once.
 */
interface ExprReach { readonly cols: ReadonlySet<string>; readonly subplans: readonly Rel[]; }
const NO_REACH: ExprReach = { cols: NO_NAMES, subplans: NONE };
const exprReach: (r: Rel) => ExprReach = nodeFact((r: Rel): ExprReach => {
  const exprs = relExprs(r);
  if (!exprs.length) return NO_REACH;
  const cols = new Set<string>();
  const subplans = new Set<Rel>();
  const seen = new Set<Expr>();
  const go = (e: Expr): void => {
    if (seen.has(e)) return;
    seen.add(e);
    if (e.kind === 'col') cols.add(e.rel);
    exprRels(e).forEach((plan) => subplans.add(plan));
    exprChildren(e).forEach(go);
  };
  exprs.forEach(go);
  return cols.size || subplans.size ? { cols, subplans: fixed([...subplans]) } : NO_REACH;
});

/** The relations directly beneath `r` that a walk descends into: every relation an expression it owns
 *  correlates, then its children (`forEachRel`'s coverage, one level). Built per ask, like `relChildren`,
 *  which keeps `relChildren` the honest meter of how often a node is enumerated
 *  (`test/compiler/node-facts.test.ts`). */
const relsBeneath = (r: Rel): readonly Rel[] => {
  const { subplans } = exprReach(r);
  const children = relChildren(r);
  return subplans.length ? [...subplans, ...children] : children;
};

const depthMemo = new WeakMap<Rel, number>();
/**
 * HOW DEEP A WALK OVER THIS RELATION RECURSES — the longest chain of nodes from `r` to a leaf, counting a
 * correlated subplan as beneath the node that owns it, and a `Ref` as the leaf it is to every walker.
 *
 * Every analysis, pass and the emitter recurse over this depth, so it is the quantity a JS stack bounds
 * (`boundedSpine`, `src/compiler/rel/lower.ts`). MEMOISED per node and computed ITERATIVELY: a fold that
 * asks it after every step pays only for the nodes built since it last asked, so a chain of n steps costs
 * O(n) in total — re-measuring the spine at every step would be O(n²), on exactly the long chains that ask.
 */
export function relDepth(r: Rel): number {
  const known = depthMemo.get(r);
  if (known !== undefined) return known;
  const stack: { readonly rel: Rel; expanded: boolean }[] = [{ rel: r, expanded: false }];
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (depthMemo.has(top.rel)) { stack.pop(); continue; }
    const beneath = relsBeneath(top.rel);
    if (!top.expanded) {
      top.expanded = true;
      for (const child of beneath) if (!depthMemo.has(child)) stack.push({ rel: child, expanded: false });
      continue;
    }
    stack.pop();
    depthMemo.set(top.rel, 1 + beneath.reduce((deepest, child) => Math.max(deepest, depthMemo.get(child) ?? 0), 0));
  }
  return depthMemo.get(r)!;
}

const spelledMemo = new WeakMap<object, number>();
/**
 * HOW MANY NODES A TREE WALK OVER THIS NODE VISITS — the DAG read as the TREE every spelling of it is.
 *
 * The plan is a DAG: a node built once and referenced twice is ONE object. But `check` walks it, and the
 * emitter SPELLS it, once per reference — SQL has no `let` inside a statement, so a shared `Expr` is
 * written out at each use and a correlated subplan shared by two parents is a subquery written twice.
 * Sharing that compounds (a running value named in both arms of a `CASE`, a correlated body that reads the
 * body before it twice) is therefore 2^k text for k levels while the DAG is only k nodes — the class
 * `project()`'s accumulator shipped (`record.ts`, `recordPairs`' invariant) and the guarded transform
 * chain still has.
 *
 * This answers the TREE size from the DAG in O(DAG): memoised per node (a node is immutable, so its tree
 * size is a fact of its identity — `nodeFact`'s argument) and computed ITERATIVELY, for `relDepth`'s
 * reason: a bounded repeat's spine is thousands of nodes deep. A `Ref` is a leaf, as it is to every walker
 * — a named binding is spelled once, in the `WITH` list, however often it is read. A node referenced twice
 * by one parent is counted twice: that is a second spelling, not a duplicate visit.
 *
 * Every node spells at least one byte, so this is a lower bound on the text one walk of the node writes
 * (`CompileBudget`, `src/sql/kernel/budget.ts`, is what reads it).
 */
export const spelledSize = (root: Rel | Stmt | Expr): number => treeSize(root, spelledMemo, (node) => {
  if (isStmt(node)) return [...stmtChildren(node), ...stmtExprs(node)];
  if (isRel(node)) return [...relExprs(node), ...relChildren(node)];
  return [...exprChildren(node), ...exprRels(node)];
},
// An expression holding no subquery IS its `expressionSize`, usually already known: the passes rebuild
// relations but keep their expressions, which the lowering's own charge measured before them.
(node) => (isRel(node) || isStmt(node) || exprHasSubquery(node) ? undefined : expressionSize(node)));

const expressionMemo = new WeakMap<object, number>();
/**
 * `spelledSize` of ONE EXPRESSION, its correlated subplans counted as one node each — the part of the tree
 * no rewrite can share. A shared `Rel` may yet become one named CTE (`name`), so before naming only an
 * `Expr`'s own sharing is certain to be spelled per use: an `Expr` is never hoisted, at any stage.
 */
const expressionSize = (root: Expr): number =>
  treeSize(root, expressionMemo, exprChildren, (node) => (node.kind === 'col' || node.kind === 'lit' ? 1 : undefined));

/** The largest `expressionSize` among every expression of a program's roots — their relations', their
 *  correlated subplans' and their statements' — each node visited once. */
export function largestExpression(roots: readonly (Rel | Stmt)[]): number {
  let largest = 0;
  const measure = (e: Expr): void => { largest = Math.max(largest, expressionSize(e)); };
  const rels: Rel[] = [];
  const seen = new Set<Expr>();
  for (const root of roots) {
    if (!isStmt(root)) { rels.push(root); continue; }
    rels.push(...stmtChildren(root));
    stmtExprs(root).forEach(measure);
    const stack = [...stmtExprs(root)];
    while (stack.length) {
      const e = stack.pop()!;
      if (seen.has(e)) continue;
      seen.add(e);
      rels.push(...exprRels(e));
      stack.push(...exprChildren(e));
    }
  }
  forEachRel(rels, (r) => relExprs(r).forEach(measure));
  return largest;
}

/**
 * The tree size of a DAG node, memoised per node in `memo` and computed with an explicit stack. `direct`
 * answers a node without a frame or a memo entry when it can (a leaf, a size another fact already holds) —
 * most nodes of a plan are leaves, and a memo entry each is most of what this would otherwise cost.
 */
function treeSize<N extends object>(
  root: N, memo: WeakMap<object, number>, beneath: (node: N) => readonly N[], direct: (node: N) => number | undefined,
): number {
  const size = (node: N): number | undefined => direct(node) ?? memo.get(node);
  const known = size(root);
  if (known !== undefined) return known;
  // Each frame holds its node's children once enumerated, so a node is enumerated once however it is reached.
  const stack: { readonly node: N; children?: readonly N[] }[] = [{ node: root }];
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (memo.has(top.node)) { stack.pop(); continue; }
    if (!top.children) {
      top.children = beneath(top.node);
      for (const child of top.children) if (size(child) === undefined) stack.push({ node: child });
      continue;
    }
    stack.pop();
    let total = 1;
    for (const child of top.children) total += size(child)!;
    memo.set(top.node, total);
  }
  return memo.get(root)!;
}

/** Visit every relation in the DAG once, plus every relation correlated from an expression. Several
 *  ROOTS (a program's bindings and its result) are one walk: a node they share is visited once. */
export function forEachRel(plan: Rel | readonly Rel[], visit: (r: Rel) => void): void {
  const seen = new Set<Rel>();
  const go = (r: Rel): void => {
    if (seen.has(r)) return;
    seen.add(r);
    visit(r);
    relsBeneath(r).forEach(go);
  };
  (isRel(plan) ? [plan] : plan).forEach(go);
}

/**
 * Visit every sub-expression SQLite evaluates WHENEVER the root is evaluated — not one a `CASE` branch,
 * the right operand of a short-circuit `AND`/`OR`, a `coalesce`/`ifnull`/`iif` fallback or an aggregate's
 * per-member arguments hold back. A window's spec runs for every row it numbers, so it is not held back. A rewrite that moves a RAISING subquery may move only one of these:
 * anywhere else the guard around it is what keeps it off the rows it would raise for.
 */
export function forEachUnconditional(e: Expr, visit: (node: Expr) => void): void {
  visit(e);
  const always: readonly Expr[] = (() => {
    switch (e.kind) {
      case 'case': return e.whens.length ? [e.whens[0]![0]] : [];
      case 'binary': return e.op === 'and' || e.op === 'or' ? [e.left] : [e.left, e.right];
      case 'call': return ['coalesce', 'ifnull', 'iif'].includes(e.fn) ? e.args.slice(0, 1) : e.args;
      case 'agg': return [];
      default: return exprChildren(e);
    }
  })();
  always.forEach((child) => forEachUnconditional(child, visit));
}

/** Visit an expression and every sub-expression. Correlated subplans are the caller's business. */
export function forEachExpr(e: Expr, visit: (node: Expr) => void): void {
  visit(e);
  exprChildren(e).forEach((child) => forEachExpr(child, visit));
}

/** Child relations a STATEMENT owns, in declaration order — its target scan, and the relation it
 * reads (an `Insert`'s source, an `Update`'s `from`). Declared here beside the relational cases for
 * the same reason they are: an analysis that walked a statement by re-deriving its shape is one a
 * new statement field would silently skip. */
export function stmtChildren(s: Stmt): readonly Rel[] {
  switch (s.kind) {
    case 'insert': return [s.target, s.source];
    case 'update': return s.from ? [s.target, s.from] : [s.target];
    case 'delete': return [s.target];
  }
}

/** Expressions a STATEMENT owns, in declaration order. */
export function stmtExprs(s: Stmt): readonly Expr[] {
  const returning = s.returning.map(([, e]) => e);
  switch (s.kind) {
    case 'insert': return [...(s.onConflict?.set ?? []).map(([, e]) => e), ...returning];
    case 'update': return [...s.set.map(([, e]) => e), ...(s.where ? [s.where] : []), ...returning];
    case 'delete': return [...(s.where ? [s.where] : []), ...returning];
  }
}

/**
 * HOW ONE STATEMENT READS EACH BINDING IT NAMES — how many times its `Ref` is SPELLED (saturating at
 * 2, which is all the one caller asks) and whether any spelling is a REPEATED read: a side of a join
 * that may run as its inner loop, or a CORRELATED subplan. `ref` is the first spelling, which carries the binding's declared type.
 *
 * Counted by spelling, not by node: the emitter inlines a shared subtree at every parent, so a node
 * reached twice is read twice. Memoised per node, so the walk stays linear in the DAG. An UNCORRELATED
 * subplan (`IN (SELECT …)`) runs once, so it is one more read but not a repeated one — SQLite already
 * builds its ephemeral index. A statement's `Update … FROM` is joined against its target, so it is
 * inner too.
 */
export interface RefRead { readonly ref: Extract<Rel, { readonly kind: 'ref' }>; readonly count: number; readonly inner: boolean; }
type RefReads = ReadonlyMap<string, RefRead>;
const addRefReads = (into: Map<string, RefRead>, from: RefReads, inner: boolean): void => {
  for (const [name, read] of from) {
    const prior = into.get(name);
    into.set(name, { ref: prior?.ref ?? read.ref, count: Math.min(2, (prior?.count ?? 0) + read.count), inner: (prior?.inner ?? false) || read.inner || inner });
  }
};
const exprRefReads = (e: Expr, into: Map<string, RefRead>): void =>
  forEachExpr(e, (node) => exprRels(node).forEach((plan) => addRefReads(into, relRefReads(plan), freeRelIds(plan).size > 0)));
const relRefReads: (r: Rel) => RefReads = nodeFact((r: Rel): RefReads => {
  const out = new Map<string, RefRead>();
  if (r.kind === 'ref') out.set(r.name, { ref: r, count: 1, inner: false });
  relExprs(r).forEach((e) => exprRefReads(e, out));
  if (r.kind === 'join') {
    // The LEFT side is the outer loop only where the join pins it: an `ordered` or `cross` join renders
    // `CROSS JOIN`, a `left` join's order is its meaning, and a semi/anti join is the outer query of its
    // EXISTS. An unordered inner join is the planner's to turn around — measured: it put a spooled
    // snapshot outer and scanned the `json_each` beside it for every row.
    addRefReads(out, relRefReads(r.left), r.join === 'inner' && !r.ordered);
    addRefReads(out, relRefReads(r.right), true);
  } else relChildren(r).forEach((child) => addRefReads(out, relRefReads(child), false));
  return out;
});
export function refReads(node: Rel | Stmt): RefReads {
  if (!isStmt(node)) return relRefReads(node);
  const out = new Map<string, RefRead>();
  if (node.kind === 'insert') addRefReads(out, relRefReads(node.source), false);
  if (node.kind === 'update' && node.from) addRefReads(out, relRefReads(node.from), true);
  stmtExprs(node).forEach((e) => exprRefReads(e, out));
  return out;
}

/** Every `Ref` NAME a node reaches, relations and expression subplans alike — "which bindings does
 * this step read". One fact for both halves of the union, because a program's steps are of both
 * kinds and the question asked of them is the same. Synthesized bottom-up per node, sharing a child's
 * set wherever a node adds nothing (`unionOf`): the lowering, `check` and the emitter all ask it of the
 * same bindings, so each is answered once. */
export const refNames = (node: Rel | Stmt): ReadonlySet<string> => (isStmt(node) ? stmtRefNames(node) : relRefNames(node));
const stmtRefNames: (s: Stmt) => ReadonlySet<string> = nodeFact((s: Stmt): ReadonlySet<string> =>
  unionOf([...stmtChildren(s), ...stmtExprs(s).flatMap(exprSubplans)].map(relRefNames)));
const relRefNames: (r: Rel) => ReadonlySet<string> = nodeFact((r: Rel): ReadonlySet<string> =>
  unionOf(relsBeneath(r).map(relRefNames), r.kind === 'ref' ? r.name : undefined));
/** The correlated subplans anywhere in an expression tree. */
const exprSubplans = (e: Expr): readonly Rel[] => {
  const out: Rel[] = [];
  forEachExpr(e, (node) => out.push(...exprRels(node)));
  return out;
};
