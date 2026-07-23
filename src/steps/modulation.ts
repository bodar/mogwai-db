// ---------- shared element modulation keys ----------
//
// order(), dedup().by(), and map-style child-first policies all observe a scalar
// modulation of an element. Keep direct key/token resolution and direction parsing
// here so consumers differ only in cardinality/productivity policy, not in how a key
// is read. Traversal-valued modulators still go through child.ts.

import { empty, list, q, type Expression, type Relation } from '../sql/kernel/q.ts';
import { elemCtx, labelNameSub, scalarProp, scalarPropSortKey } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { type ElementStream } from './context.ts';

export function directElementModulation(
  st: ElementStream,
  n: Relation,
  args: readonly any[] | undefined,
): Expression | null {
  if (!args?.length) return n.c.id;
  const arg = args[0];
  if (typeof arg === 'string') return scalarProp(elemCtx(n, st.elem), arg);
  if (arg && typeof arg === 'object' && 'token' in arg) {
    if (arg.token === 'id') return elemCtx(n, st.elem).extIdExpr!;
    if (arg.token === 'label') return labelNameSub(n.c.label);
    throw new Error(`by(T.${arg.token}) element modulation not yet supported`);
  }
  if (arg && typeof arg === 'object' && 'nested' in arg) return null;
  throw new Error('unsupported element by() modulator');
}

/** SQL ordering terms for an element order() host. A stable internal rowid tie-break
 * is appended by the caller because it knows the current relation alias. */
export function elementOrderSql(st: ElementStream, n: Relation, order?: PStep): Expression {
  if (!order) return n.c.id;
  const bys = order.bys ?? [];
  if (!bys.length) return q`${n.c.id} ASC`;
  const terms = bys.map((by) => {
    const bad = by.find((a: any) => a && typeof a === 'object' && ('nested' in a || 'token' in a));
    if (bad) throw new Error('token' in bad ? `order().by(T.${bad.token}) not yet supported` : 'order().by(traversal) not yet supported');
    const key = by.find((a: any) => typeof a === 'string');
    const dir = by.find((a: any) => a && typeof a === 'object' && 'order' in a)?.order;
    if (dir === 'shuffle') return q`RANDOM()`;
    // Sort key, not raw value: order().by(key) must sort a TEXT-stored big long /
    // bigdecimal / duration NUMERICALLY (compareKey), not lexically.
    const expr = key ? scalarPropSortKey(elemCtx(n, st.elem), key) : n.c.id;
    return q`${expr}${dir === 'desc' ? q` DESC` : q` ASC`}`;
  });
  return terms.length ? list(terms, ', ') : empty;
}
