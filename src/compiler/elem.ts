// The element-kind primitive shared across the compiler and the SQL kernel. This file is the
// surviving remnant of the pre-RelIR "plan" leaf-framing module: once the RelIR spine took over
// leaf framing (`src/compiler/rel/element.ts` + `GraphSource.leafPayload`), the whole q-template
// leaf/property/label/predicate builder body here went dead and was removed. Only the element-kind
// type and its one physical-name mapping had live consumers, so they are all that remains.

/** Whether the current traverser's `id` column is a node id or an edge id. The
 *  id-relation is typed but the type is *static* — known from the step chain, so
 *  no runtime tag is needed. V()/out()/…V() → node; E()/…E() → edge. */
export type Elem = 'vertex' | 'edge';

/** The persisted `property_fts.owner_elem` spelling. The ONE place a compiler ElemKind becomes
 *  the 'node' string, because that column holds real rows in a real Durable Object: renaming its
 *  VALUES is a silent data-compatibility break (pre-existing rows say 'node', new code would
 *  query 'vertex', and every TextP predicate would return [] with no error). Pinned by
 *  test/fts-index.test.ts. The `nodes` TABLE and `vertex_properties.node` COLUMN are the same
 *  rule at the schema level and likewise keep their names. */
export const sqlElem = (e: Elem): 'node' | 'edge' => (e === 'edge' ? 'edge' : 'node');
