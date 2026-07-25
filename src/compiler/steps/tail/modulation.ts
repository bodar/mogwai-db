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
