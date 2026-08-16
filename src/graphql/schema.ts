// ---------- the reflected graph schema — the model a GraphQL document is translated against ----------
//
// The schema is REFLECTED, not declared (`docs/2026-08-07-graphql-front-end-plan.md` §4): a mogwai
// graph is schemaless (interned labels + typed properties), and this is the structured view the
// translator reads to decide how each GraphQL field lowers. It is the SAME facts `mogwai.schema`
// streams (`src/services/catalog/schema.ts`) — labels, per-label property→type, edge triples — gathered
// into one addressable object rather than a row stream, because a translator walks a document top-down
// and needs random access to "what edge does field X on type Y traverse", which a stream does not give.
//
// A GraphQL OBJECT TYPE is a vertex label; a SCALAR field is a property key; an OBJECT field is an edge
// (its name is the edge label, its return type the endpoint label). Reflection-first, so the mapping is
// mechanical — a later SDL-with-directives override (`Person.friends` → `out('knows')`) is out of scope
// (§9), which is why nothing here carries a user-supplied binding.

/** A property field: its graph key and the Gremlin vtype the reflection observed (`'unknown'` where a
 *  raw/legacy value's type is decided by storage class alone). The GraphQL scalar type is derived from
 *  this at SDL-print time; the translator only needs the KEY to emit `values(key)`. */
export interface PropertySchema {
  readonly key: string;
  readonly type: string;
}

/** An edge field on a vertex label: which edge label it traverses, in which direction, and the
 *  endpoint (return) label. `out` for a triple whose SRC is this label, `in` for its TGT — so the same
 *  edge triple gives the source label an `out` field and the target label an `in` field, which is how a
 *  GraphQL type gets both `created` and `createdBy`-shaped navigation from one stored edge. */
export interface EdgeSchema {
  readonly label: string;
  readonly direction: 'out' | 'in';
  readonly to: string;
  /** The edge's OWN properties (keyed by property name), reflected from `edge_properties`. They belong
   *  to the edge itself, so both the out and the in field of one stored edge carry the same set — a later
   *  increment exposes them as edge-field data/arguments (§4's `edge-field payload types`). */
  readonly properties: ReadonlyMap<string, PropertySchema>;
}

/** One vertex label as a GraphQL object type: its property fields and its edge fields. Field lookup is
 *  by NAME, so both are keyed maps rather than arrays — the translator asks "type Person, field name"
 *  and "type Person, field friends" directly. */
export interface TypeSchema {
  readonly name: string;
  readonly count: number;
  readonly properties: ReadonlyMap<string, PropertySchema>;
  /** Edge fields keyed by the name a GraphQL client uses. Reflection-first, the key IS the edge label
   *  (with the endpoint disambiguating an in/out pair — see `edgeFieldName`). */
  readonly edges: ReadonlyMap<string, EdgeSchema>;
}

export interface GraphSchema {
  readonly types: ReadonlyMap<string, TypeSchema>;
}

/** The GraphQL field name for an edge. Reflection has no user-given names, so the label IS the name —
 *  but a label can appear on a type in BOTH directions (a self-edge like `knows`: person→person gives
 *  person both an out and an in), so the incoming direction is suffixed to keep the two field names
 *  distinct. `out` keeps the bare label (the common read direction); `in` appends `_in`. */
export const edgeFieldName = (label: string, direction: 'out' | 'in'): string =>
  direction === 'out' ? label : `${label}_in`;

/** One `mogwai.schema` row, as the decoded map the service streams. The translator/consumer decodes the
 *  GraphBinary maps to these plain records; `buildSchema` folds them into the addressable model. */
export type SchemaRow =
  | { readonly kind: 'vertexLabel'; readonly name: string; readonly count: number }
  | { readonly kind: 'property'; readonly label: string; readonly key: string; readonly type: string }
  | { readonly kind: 'edge'; readonly label: string; readonly src: string; readonly tgt: string }
  | { readonly kind: 'edgeProperty'; readonly label: string; readonly key: string; readonly type: string };

/**
 * Fold the `mogwai.schema` row stream into the addressable `GraphSchema`.
 *
 * Order-independent (the UNION ALL row order is not guaranteed): an `edgeProperty` may arrive before its
 * `edge`, so edge properties are collected by edge-label FIRST, then attached when the edge fields are
 * built. A `vertexLabel` row mints a type, a `property` row adds a field, an `edge` row adds an OUT field
 * to its src type and an IN field to its tgt type — both carrying the edge's own property set. A row for
 * a label with no `vertexLabel` row still mints the type (folding order must not decide correctness).
 */
export function buildSchema(rows: Iterable<SchemaRow>): GraphSchema {
  const types = new Map<string, { name: string; count: number; properties: Map<string, PropertySchema>; edges: Map<string, EdgeSchema> }>();
  const typeOf = (name: string) => {
    let t = types.get(name);
    if (!t) { t = { name, count: 0, properties: new Map(), edges: new Map() }; types.set(name, t); }
    return t;
  };
  // Two passes over one array: edge properties by edge-label, then everything else — so an edge field
  // built in pass 2 sees the complete property set regardless of stream order.
  const all = [...rows];
  const edgeProps = new Map<string, Map<string, PropertySchema>>();
  for (const row of all) {
    if (row.kind === 'edgeProperty') {
      let m = edgeProps.get(row.label);
      if (!m) { m = new Map(); edgeProps.set(row.label, m); }
      m.set(row.key, { key: row.key, type: row.type });
    }
  }
  const propsOf = (label: string): ReadonlyMap<string, PropertySchema> => edgeProps.get(label) ?? new Map();
  for (const row of all) {
    if (row.kind === 'vertexLabel') typeOf(row.name).count = row.count;
    else if (row.kind === 'property') typeOf(row.label).properties.set(row.key, { key: row.key, type: row.type });
    else if (row.kind === 'edge') {
      const properties = propsOf(row.label);
      typeOf(row.src).edges.set(edgeFieldName(row.label, 'out'), { label: row.label, direction: 'out', to: row.tgt, properties });
      typeOf(row.tgt).edges.set(edgeFieldName(row.label, 'in'), { label: row.label, direction: 'in', to: row.src, properties });
    }
  }
  return { types };
}
