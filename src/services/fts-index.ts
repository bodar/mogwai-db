// ---------- property_fts write-path indexer (Step 6) ----------
//
// A single FTS5 trigram virtual table, `property_fts`, is the shared index behind BOTH
// `tinker.search` (Step 7) and the TextP substring predicates (Step 8). It is maintained
// in the write path (applyVertexProperty / insertEdgeProperty / drop) — NOT via triggers:
// DO trigger support is unconfirmed, and (more fundamentally) the stored value is our
// self-describing {t,v} ValueNode tree, so indexing needs application-level awareness of
// that encoding. A SQL trigger over the raw JSONB blob would index tag noise
// ("t"/"v"/"map"/"str") and an indirected shape.
//
// The indexer is therefore ValueNode-aware: it walks the IN-MEMORY {t,v} tree (a plain JS
// object at write time, before serialization — no json_tree, no tag noise) and emits:
//   - one kind='value' row  = the value's LOGICAL toString() (faithful to
//     p.value().toString(), so a collection ["a","brave"] matches search "brave" via its
//     "[a, brave]" toString — this is exactly what tinker.search matches on), plus
//   - kind='jsonkey' / kind='jsonleaf' rows from walking the logical tree, so nested map
//     keys and typed leaves inside a collection are INDIVIDUALLY searchable (the "handle
//     JSON properly" capability, beyond bare tinker.search).
//
// See docs/archive/2026-07-20-call-service-registry-plan.md ("FTS5 + proper JSON handling").
import type { GraphStore } from '../storage.ts';
import { valueNodeOf, type TypeNode, type ValueNode } from '../gremlin/types.ts';

/** Which normalized property table `pid` keys into — 'node' for vertex_properties,
 *  'edge' for edge_properties. Stored UNINDEXED so search can scope by element kind and
 *  so delete-by-column can target one property's rows. */
export type OwnerElem = 'node' | 'edge';

/** A row to write into property_fts. `text` is the only indexed (searchable) column;
 *  everything else is UNINDEXED (stored + filterable, not tokenized). */
interface FtsRow {
  kind: 'value' | 'jsonkey' | 'jsonleaf';
  text: string;
}

/** A ValueNode leaf's logical string form — what p.value().toString() yields for that
 *  scalar. Numbers/booleans stringify directly; a stored datetime leaf is epoch-ms
 *  (leafStore) so it stringifies as the number, which is acceptable for substring search
 *  (search over a datetime property is not a corpus case). null → empty string. */
const leafText = (v: unknown): string => (v == null ? '' : String(v));

/** The LOGICAL toString() of a whole ValueNode, mirroring Java's collection toString:
 *  a scalar is its value; a list/set is `[a, b, c]`; a map is `{k=v, k2=v2}`. This is the
 *  kind='value' text — the faithful `p.value().toString()` a `.*(term).*` search matches. */
function valueToString(node: ValueNode): string {
  if (node == null) return '';
  if (node.t === 'list' || node.t === 'set')
    return `[${(node.v as ValueNode[]).map(valueToString).join(', ')}]`;
  if (node.t === 'map')
    return `{${(node.v as [ValueNode, ValueNode][]).map(([k, v]) => `${valueToString(k)}=${valueToString(v)}`).join(', ')}}`;
  return leafText(node.v);
}

/** Walk a ValueNode tree, emitting jsonkey rows for every map key and jsonleaf rows for
 *  every scalar leaf reached inside a collection. Scalars at the TOP level produce no
 *  jsonleaf (the kind='value' row already covers them); only nested content is walked, so
 *  a plain string property yields exactly one (value) row. */
function walkTree(node: ValueNode, rows: FtsRow[], nested: boolean): void {
  if (node == null) return;
  if (node.t === 'list' || node.t === 'set') {
    for (const el of node.v as ValueNode[]) walkTree(el, rows, true);
    return;
  }
  if (node.t === 'map') {
    for (const [k, v] of node.v as [ValueNode, ValueNode][]) {
      rows.push({ kind: 'jsonkey', text: valueToString(k) });
      walkTree(v, rows, true);
    }
    return;
  }
  // A scalar leaf: only index it as a jsonleaf when it sits INSIDE a collection (nested);
  // a top-level scalar is already the kind='value' row.
  if (nested) rows.push({ kind: 'jsonleaf', text: leafText(node.v) });
}

/** The full set of FTS rows for one property instance: the kind='value' toString plus the
 *  nested jsonkey/jsonleaf rows. Empty-text rows are dropped (nothing to match). */
function ftsRowsFor(node: ValueNode): FtsRow[] {
  const rows: FtsRow[] = [{ kind: 'value', text: valueToString(node) }];
  walkTree(node, rows, false);
  return rows.filter((r) => r.text.length > 0);
}

/** Remove every property_fts row for one property instance (owner_elem, pid). Called before
 *  a re-index (single-cardinality replace) and on drop(). UNINDEXED columns are filterable,
 *  so a DELETE … WHERE owner_elem=? AND pid=? is a normal delete on an FTS5 table. */
export function deleteFtsFor(store: GraphStore, ownerElem: OwnerElem, pid: number): void {
  store.query('DELETE FROM property_fts WHERE owner_elem=? AND pid=?', [ownerElem, pid]);
}

/** Remove every property_fts row owned by a set of owner elements (their vertex/edge ids) —
 *  the drop() cascade, where the property rows are deleted wholesale by owner. */
export function deleteFtsForOwners(store: GraphStore, ownerElem: OwnerElem, ownerIds: readonly number[]): void {
  if (!ownerIds.length) return;
  const ph = ownerIds.map(() => '?').join(',');
  store.query(`DELETE FROM property_fts WHERE owner_elem=? AND owner IN (${ph})`, [ownerElem, ...ownerIds]);
}

/** Index ONE property instance into property_fts. `pid` is the property row's id
 *  (vertex_properties.id / edge_properties.id), `owner` the owning nodes.id/edges.id. The
 *  value is tagged into a ValueNode via the SAME valueNodeOf the write path stores, so the
 *  index sees exactly the logical tree the reader reconstructs. Caller deletes stale rows
 *  first (single-cardinality replace) — this only inserts. */
export function indexProperty(
  store: GraphStore, ownerElem: OwnerElem, pid: number, owner: number,
  key: string, val: unknown, typeNode: TypeNode | null,
): void {
  const node = valueNodeOf(val, typeNode);
  for (const r of ftsRowsFor(node))
    store.query(
      'INSERT INTO property_fts(owner_elem, pid, owner, pk, kind, text) VALUES(?, ?, ?, ?, ?, ?)',
      [ownerElem, pid, owner, key, r.kind, r.text],
    );
}
