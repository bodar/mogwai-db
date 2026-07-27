// ---------- shared element modulation keys ----------
//
// order(), dedup().by(), and map-style child-first policies all observe a scalar
// modulation of an element. Keep direct key/token resolution and direction parsing
// here so consumers differ only in cardinality/productivity policy, not in how a key
// is read. Traversal-valued modulators still go through child.ts.

import { empty, list, q, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { elemCtx, labelNameSub, scalarProp, scalarPropSortKey } from '../../plan/plan.ts';
import { type PStep } from '../../ir/strategies.ts';
import { type ElementStream } from '../context/context.ts';
import { classifyBy } from './child-shape.ts';

export function directElementModulation(
  st: ElementStream,
  n: Relation,
  args: readonly any[] | undefined,
): Expression | null {
  const by = classifyBy(args);
  if (by.kind === 'none') return n.c.id;
  if (by.kind === 'key') return scalarProp(elemCtx(n, st.elem), by.key);
  if (by.kind === 'token') {
    if (by.token === 'id') return elemCtx(n, st.elem).extIdExpr!;
    if (by.token === 'label') return labelNameSub(n.c.label);
    throw new Error(`by(T.${by.token}) element modulation not yet supported`);
  }
  return null; // nested → the caller lowers it through the generic child seam
}

/**
 * The NON-PRODUCTIVE by() drop for an element `order()`, as a filter predicate — or null when
 * nothing should be dropped.
 *
 * TinkerPop's default by() modulator is non-productive: a traverser the modulator yields nothing for
 * is DROPPED, not carried with a null. `g.V().order().by('age')` therefore returns four rows on the
 * modern graph, not six — the two software vertices have no `age`. `ProductiveByStrategy` opts into
 * the other policy (keep them; nulls sort first, which this engine already does), so a marked host
 * returns null here.
 *
 * WHY THIS IS A LOWERING CONCERN AND NOT AN IR PASS. It was first written as a `decoration` Pass
 * injecting `has(key)` before the order() — one central place, every order() lowering path inheriting
 * it. That is wrong, and instructively so: the rewrite is only valid over an ELEMENT stream, and the
 * IR layer has no shape information at all. It duly broke all six non-element `order().by(key)`
 * forms — over a list (`fold().order(Scope.local).by(k)`), a map, a group, a record, a scalar and a
 * path — because `has(key)` means nothing on any of them. Shape is exactly what the lowering knows
 * and the IR does not, so the policy lives here, and the way it avoids N divergent copies is by
 * being ONE predicate builder that shares `classifyBy` with `elementOrderSql` above: the sort terms
 * and the productivity filter cannot disagree about which by()s project a key.
 *
 * (`dedup().by()` had already reached the same conclusion independently — see the `productiveBy`
 * WHERE in prefix/filter.ts. This generalises that one line rather than adding a second idea.)
 */
export function orderProductivityFilter(
  clauses: readonly { readonly key: string | null }[],
  productiveBy: boolean,
  keyExpr: (key: string) => Expression,
): Expression | null {
  if (productiveBy) return null;
  // Only a KEY projection can be unproductive: a `T` token is always present, a bare by() is the
  // element itself, and a by(traversal) is the child seam's question, not this one. Deliberately
  // representation-neutral over `{key}` + a key-expression builder, because the two element-order
  // sites hold their order in different shapes (a folded `bys` list vs. the tail accumulator's
  // OrderClause[]) — so they share this ONE policy instead of each deciding which clauses can drop.
  const terms = clauses.filter((c) => c.key !== null).map((c) => q`${keyExpr(c.key!)} IS NOT NULL`);
  return terms.length ? list(terms, ' AND ') : null;
}

/** `orderProductivityFilter` for a site holding a folded `order()` PStep. */
export function elementOrderDrop(st: ElementStream, n: Relation, order?: PStep): Expression | null {
  if (!order) return null;
  const clauses = (order.bys ?? []).map(classifyBy)
    .map((by) => ({ key: by.kind === 'key' ? (by as { key: string }).key : null }));
  return orderProductivityFilter(clauses, (order as any).productiveBy === true,
    (key) => scalarPropSortKey(elemCtx(n, st.elem), key));
}

/** SQL ordering terms for an element order() host. A stable internal rowid tie-break
 * is appended by the caller because it knows the current relation alias. */
export function elementOrderSql(st: ElementStream, n: Relation, order?: PStep): Expression {
  if (!order) return n.c.id;
  const bys = order.bys ?? [];
  if (!bys.length) return q`${n.c.id} ASC`;
  const terms = bys.map((byArgs) => {
    const by = classifyBy(byArgs);
    if (by.kind === 'nested') throw new Error('order().by(traversal) not yet supported');
    if (by.kind === 'token') throw new Error(`order().by(T.${by.token}) not yet supported`);
    if (by.dir === 'shuffle') return q`RANDOM()`;
    // Sort key, not raw value: order().by(key) must sort a TEXT-stored big long /
    // bigdecimal / duration NUMERICALLY (compareKey), not lexically.
    const expr = by.kind === 'key' ? scalarPropSortKey(elemCtx(n, st.elem), by.key) : n.c.id;
    return q`${expr}${by.dir === 'desc' ? q` DESC` : q` ASC`}`;
  });
  return terms.length ? list(terms, ', ') : empty;
}
