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
// The indexer is therefore ValueNode-aware: it renders the IN-MEMORY {t,v} tree (a plain JS
// object at write time, before serialization — no json_tree, no tag noise) as ONE row per
// property: the value's LOGICAL toString() (faithful to p.value().toString(), so a collection
// ["a","brave"] matches search "brave" via its "[a, brave]" toString — exactly what
// tinker.search matches on). An empty text indexes as no row (nothing to match).
//
// The FTS5 ROWID is the property row's id, SIGNED by owner kind (`ftsRowid`): +vertex_properties.id,
// -edge_properties.id. One row per property is what makes that a key, and it turns every delete and
// probe into a rowid seek — every other column is UNINDEXED, so a predicate on one scans the table.
//
// See docs/archive/2026-07-20-call-service-registry-plan.md ("FTS5 + proper JSON handling").
import { valueNodeOf, type TypeNode, type ValueNode } from '../gremlin/types.ts';

/** Which normalized property table `pid` keys into — 'node' for vertex_properties,
 *  'edge' for edge_properties. Stored UNINDEXED so search can scope by element kind. */
export type OwnerElem = 'node' | 'edge';

/** The FTS5 rowid of a property's index row: its property id, negated for an edge property (a vertex
 *  property and an edge property may share an id; the sign keeps the two apart). */
export const ftsRowid = (ownerElem: OwnerElem, pid: number): number => (ownerElem === 'edge' ? -pid : pid);

/** A ValueNode leaf's logical string form — what p.value().toString() yields for that
 *  scalar. Numbers/booleans stringify directly; a stored datetime leaf is epoch-ms
 *  (leafStore) so it stringifies as the number, which is acceptable for substring search
 *  (search over a datetime property is not a corpus case). null → empty string. */
const leafText = (v: unknown): string => (v == null ? '' : String(v));

/** The LOGICAL toString() of a whole ValueNode, mirroring Java's collection toString:
 *  a scalar is its value; a list/set is `[a, b, c]`; a map is `{k=v, k2=v2}`. This is the
 *  text a `.*(term).*` search matches. */
function valueToString(node: ValueNode): string {
  if (node == null) return '';
  if (node.t === 'list' || node.t === 'set')
    return `[${(node.v as ValueNode[]).map(valueToString).join(', ')}]`;
  if (node.t === 'map')
    return `{${(node.v as [ValueNode, ValueNode][]).map(([k, v]) => `${valueToString(k)}=${valueToString(v)}`).join(', ')}}`;
  return leafText(node.v);
}

/** The text ONE property indexes as, or `null` when it is empty (nothing to match, so no row). */
function ftsTextOf(node: ValueNode): string | null {
  const text = valueToString(node);
  return text.length ? text : null;
}

/** `property_fts`'s columns, in the order `propertyFtsRows` emits cells. */
export const PROPERTY_FTS_COLUMNS = ['rowid', 'owner_elem', 'pid', 'owner', 'pk', 'text'] as const;

/**
 * The `property_fts` row for ONE property instance (none for an empty text), as cell arrays in
 * `PROPERTY_FTS_COLUMNS` order — row CONSTRUCTION, separated from row INSERTION.
 *
 * The separation is what lets the bulk loader (`src/bulk.ts`) land FTS rows through the same text
 * the per-element write path uses: **a bulk loader that writes its own FTS rows is a silent index
 * divergence** (plan doc §2, invariant 3), so there is exactly one rendering and every path calls it.
 *
 * `pid` is the property row's id (vertex_properties.id / edge_properties.id), `owner` the owning
 * nodes.id/edges.id. The value is tagged into a ValueNode via the SAME `valueNodeOf` the write path
 * stores, so the index sees exactly the logical tree the reader reconstructs.
 */
export function propertyFtsRows(
  ownerElem: OwnerElem, pid: number, owner: number, key: string, val: unknown, typeNode: TypeNode | null,
): unknown[][] {
  const text = propertyFtsText(val, typeNode);
  return text === null ? [] : [[ftsRowid(ownerElem, pid), ownerElem, pid, owner, key, text]];
}

/** The text ONE value indexes as (or `null`) — without the owner columns.
 *
 *  Split out for the caller that knows the TEXT at compile time and the PID only at run time: a
 *  RelIR `property(k, <literal>)` lands its FTS row as an `INSERT … SELECT` over the property
 *  insert's own `RETURNING`, so it needs the text as data rather than as a store call. */
export const propertyFtsText = (val: unknown, typeNode: TypeNode | null): string | null =>
  ftsTextOf(valueNodeOf(val, typeNode));

/** The text a STORED value indexes as — the SAME rendering as `propertyFtsText`, but from a
 *  `ValueNode` already reconstructed from storage (`valueNodeFromStored`). The post-write refresh
 *  (`src/refresh.ts`) indexes a `property(k, __.trav)` value this way: a runtime value's text is not
 *  known until it is stored, so it is not indexed in the compiled plan. */
export const propertyFtsTextOfNode = (node: ValueNode): string | null => ftsTextOf(node);
