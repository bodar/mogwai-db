import {
  GraphQLSchema, GraphQLObjectType, GraphQLList, GraphQLNonNull,
  GraphQLString, GraphQLInt, GraphQLFloat, GraphQLBoolean,
  GraphQLInputObjectType, GraphQLEnumType, GraphQLDirective, DirectiveLocation, specifiedDirectives,
  type GraphQLFieldConfig, type GraphQLInputFieldConfig, type GraphQLInputType, type GraphQLScalarType,
} from 'graphql';
import type { GraphSchema, TypeSchema, PropertySchema, EdgeSchema } from './schema.ts';
import { edgeCompanionFieldName } from './schema.ts';

// ---------- the reflected schema, as a graphql-js GraphQLSchema ----------
//
// The reflected `GraphSchema` (`schema.ts`) is the mogwai-native model the translator walks. graphql-js
// needs its OWN `GraphQLSchema` object for the two things graphql-js owns and we do not reimplement
// (`docs/2026-08-07-graphql-front-end-plan.md` §7·4 — graphql-js IS the authoritative artefact):
//
//   - INTROSPECTION — `__schema`/`__type`/root `__typename` answered by graphql-js `execute`, in
//     GraphQL's own shape, so every client tool (codegen, GraphiQL, `buildClientSchema`) works (§7·3).
//   - PARSE + VALIDATE — a document checked against this schema, so a field/argument/type error is a
//     spec-shaped GraphQL validation error with the right status code (the §7·1 audit MUSTs).
//
// It is built ONCE from the reflected schema and is a pure function of it — the same fold `buildSchema`
// is, one layer up. The field SHAPE here must match what `translate.ts` accepts, because a document that
// validates against this schema is then translated: a scalar field ↔ a property, an object field ↔ an
// edge (`out`/`in`, in suffixed `_in`), the `where`/`sort`/`limit`/`offset` arguments (`args.ts`).
// Where the two could drift, THIS module derives from the same `TypeSchema`, so they cannot.

/** The GraphQL scalar a reflected property `vtype` (a `CanonicalType`, `gremlin/types.ts`) maps to.
 *  Gremlin's numeric ladder collapses onto GraphQL's two number scalars — the integral types to `Int`
 *  (GraphQL `Int` is 32-bit; a `long`/`bigint` that overflows is the caller's concern, as in the edge's
 *  `toJson`), the fractional ones to `Float` (a double). Everything else GraphQL cannot name natively is
 *  `String` — the lossless transport for a uuid/datetime/duration/char, which a custom scalar would only
 *  relabel. `'unknown'` (a legacy value typed by storage class alone) is `String` for the same reason. */
function scalarFor(type: string): GraphQLScalarType {
  switch (type) {
    case 'boolean': return GraphQLBoolean;
    case 'byte': case 'short': case 'int': case 'long': case 'bigint': return GraphQLInt;
    case 'float': case 'double': case 'bigdecimal': return GraphQLFloat;
    default: return GraphQLString; // string, datetime, uuid, char, duration, unknown, …
  }
}

/** The shared `sort` direction enum (`ASC`/`DESC`) — one instance so every field's `sort` argument
 *  refers to the same enum type (graphql-js requires type identity, not structural equality). */
const SortDir = new GraphQLEnumType({ name: 'SortDirection', values: { ASC: { value: 'ASC' }, DESC: { value: 'DESC' } } });

/**
 * Build the graphql-js `GraphQLSchema` from the reflected model.
 *
 * Two passes, because edge fields are cross-references: pass 1 mints an (empty) object type per vertex
 * label so a later edge field can point at an already-existing type; pass 2 fills each type's fields
 * (`thunk`ed, so graphql-js resolves the cross-references lazily and edge cycles — `knows`: person→person
 * — are legal). A synthetic `Query` root exposes one LIST field per type (a graph root is a set), keyed
 * by the type name, matching how `translate` roots at `V().hasLabel(Type)` and the edge keys `{data}`.
 *
 * Resolvers are OPTIONAL and only the differential oracle supplies them (`differential` in tests); the
 * introspection/validation path never executes a data field, so the default is a schema with no
 * resolvers, which introspects and validates identically.
 */
export function buildGraphQLSchema(schema: GraphSchema, resolvers?: Resolvers): GraphQLSchema {
  const objectTypes = new Map<string, GraphQLObjectType>();
  for (const t of schema.types.values())
    objectTypes.set(t.name, new GraphQLObjectType({ name: gqlTypeName(t.name), fields: () => fieldsFor(t) }));

  const scalarField = (prop: PropertySchema): GraphQLFieldConfig<unknown, unknown> => ({ type: scalarFor(prop.type) });

  // `argsFor`/`whereInput`/`sortInput` take a NAMESPACE (a name + a property map), not a `TypeSchema`, so
  // the SAME `where`/`sort`/`limit`/`offset` surface serves both a vertex type and an EDGE companion (whose
  // args filter/order/slice the edges on the edge's own properties). One code path, so the two cannot drift.
  type Namespace = { readonly name: string; readonly properties: ReadonlyMap<string, PropertySchema> };
  const argsFor = (ns: Namespace): Record<string, { type: GraphQLInputType }> => ({
    where: { type: whereInput(ns) },
    sort: { type: new GraphQLList(new GraphQLNonNull(sortInput(ns))) },
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
  });

  const whereInputs = new Map<string, GraphQLInputObjectType>();
  const sortInputs = new Map<string, GraphQLInputObjectType>();
  /** The per-namespace `where` input — one nested operator object per property (`{ eq, neq, gt, … }`).
   *  Cached per namespace name for graphql-js type identity, and empty-safe: a namespace with no properties
   *  gets a single placeholder field so graphql-js accepts the (never-usefully-populated) input object. */
  function whereInput(ns: Namespace): GraphQLInputObjectType {
    let w = whereInputs.get(ns.name);
    if (!w) {
      w = new GraphQLInputObjectType({
        name: `${ns.name}Where`,
        fields: () => {
          const fields: Record<string, GraphQLInputFieldConfig> = {};
          for (const prop of ns.properties.values()) fields[prop.key] = { type: opInput(prop) };
          return Object.keys(fields).length ? fields : { _noop: { type: GraphQLBoolean } };
        },
      });
      whereInputs.set(ns.name, w);
    }
    return w;
  }
  function sortInput(ns: Namespace): GraphQLInputObjectType {
    let s = sortInputs.get(ns.name);
    if (!s) {
      s = new GraphQLInputObjectType({
        name: `${ns.name}Sort`,
        fields: () => {
          const fields: Record<string, GraphQLInputFieldConfig> = {};
          for (const prop of ns.properties.values()) fields[prop.key] = { type: SortDir };
          return Object.keys(fields).length ? fields : { _noop: { type: SortDir } };
        },
      });
      sortInputs.set(ns.name, s);
    }
    return s;
  }

  // Edge COMPANION wrapper types (`<Type><Field>Edge`), minted lazily and cached for type identity. Each
  // carries a `node` (the far vertex) + the edge's own property fields — the Neo4j-style edge wrapper
  // (`schema.ts` `edgeCompanionFieldName`). Only edges WITH properties get one; a `node`-only wrapper is
  // pure noise. Named `<ownerType><capitalised field>Edge` so the two directions of one label
  // (`created`/`created_in`) and the same label on two owners never collide.
  const edgeWrapperTypes = new Map<string, GraphQLObjectType>();
  const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const edgeWrapperType = (ownerType: string, fieldName: string, edge: EdgeSchema, to: GraphQLObjectType): GraphQLObjectType => {
    const wrapperName = `${gqlTypeName(ownerType)}${capitalise(fieldName)}Edge`;
    let w = edgeWrapperTypes.get(wrapperName);
    if (!w) {
      w = new GraphQLObjectType({
        name: wrapperName,
        fields: () => {
          const fields: Record<string, GraphQLFieldConfig<unknown, unknown>> = { node: { type: new GraphQLNonNull(to) } };
          for (const prop of edge.properties.values()) fields[prop.key] = scalarField(prop);
          return fields;
        },
      });
      edgeWrapperTypes.set(wrapperName, w);
    }
    return w;
  };

  const fieldsFor = (t: TypeSchema): Record<string, GraphQLFieldConfig<unknown, unknown>> => {
    const fields: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};
    for (const prop of t.properties.values()) fields[prop.key] = scalarField(prop);
    for (const [fieldName, edge] of t.edges) {
      const to = objectTypes.get(edge.to);
      if (!to) continue; // an edge to an unminted type is not addressable; skip rather than crash
      fields[fieldName] = {
        type: new GraphQLList(new GraphQLNonNull(to)),
        args: argsFor(schema.types.get(edge.to)!),
        ...(resolvers ? { resolve: resolvers.edge(t.name, fieldName) } : {}),
      };
      // The companion `_edges` field, only for an edge that HAS properties. Its args filter/order/slice the
      // EDGES on the edge's own properties (the edge is the namespace), one hop earlier than the plain field.
      if (edge.properties.size) {
        const wrapper = edgeWrapperType(t.name, fieldName, edge, to);
        fields[edgeCompanionFieldName(fieldName)] = {
          type: new GraphQLList(new GraphQLNonNull(wrapper)),
          args: argsFor({ name: `${gqlTypeName(t.name)}${capitalise(fieldName)}EdgeProps`, properties: edge.properties }),
          ...(resolvers ? { resolve: resolvers.edgeCompanion(t.name, fieldName) } : {}),
        };
      }
    }
    return fields;
  };

  const query = new GraphQLObjectType({
    name: 'Query',
    fields: () => {
      const roots: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};
      for (const t of schema.types.values()) {
        roots[t.name] = {
          type: new GraphQLList(new GraphQLNonNull(objectTypes.get(t.name)!)),
          args: argsFor(t),
          ...(resolvers ? { resolve: resolvers.root(t.name) } : {}),
        };
      }
      // An EMPTY graph reflects to zero types, but graphql-js requires Query to have ≥1 field (and a valid
      // schema is what introspection and validation need). A `_empty` placeholder keeps the schema legal;
      // it resolves to nothing and, being a data-shaped field with no backing label, translation refuses it
      // — so an empty graph introspects cleanly and every real query still fails closed.
      if (!Object.keys(roots).length) roots._empty = { type: GraphQLBoolean };
      return roots;
    },
  });
  return new GraphQLSchema({ query, types: [...objectTypes.values()], directives: [...specifiedDirectives, RECURSE_DIRECTIVE] });
}

/** `@recurse(depth: Int!)` on an object field — the transitive-walk extension (`translate.ts`
 *  `recurseDepth`). Declared on the schema so graphql-js VALIDATES a document using it (an undeclared
 *  directive is a validation error), and so it appears in introspection like any other directive. The
 *  built-in `@skip`/`@include`/`@deprecated` are kept (`specifiedDirectives`) — omitting them would make
 *  those undefined. Standard GraphQL has no `@recurse`; this is the documented graph extension (§1·2). */
const RECURSE_DIRECTIVE = new GraphQLDirective({
  name: 'recurse',
  description: 'Walk this edge transitively, emitting every level up to `depth`. A graph-over-GraphQL extension.',
  locations: [DirectiveLocation.FIELD],
  args: { depth: { type: new GraphQLNonNull(GraphQLInt), description: 'Maximum number of hops (>= 1).' } },
});

// (the `GraphQLInputType` used by `argsFor`/`whereInput` is imported above)

/** The per-property operator input (`{ eq, neq, gt, lt, gte, lte, in, contains, startsWith, endsWith }`),
 *  matching `args.ts`'s vocabulary EXACTLY so a document that validates here also translates. Comparison
 *  and `in` are typed to the property's scalar (`in` a list of it); the text ops are `String` regardless,
 *  since substring matching is a string operation. One input type per property scalar shape, named for the
 *  owning field, so graphql-js keeps them distinct. */
const opInputs = new Map<string, GraphQLInputObjectType>();
function opInput(prop: PropertySchema): GraphQLInputObjectType {
  const scalar = scalarFor(prop.type);
  const cacheKey = scalar.name;
  let op = opInputs.get(cacheKey);
  if (!op) {
    op = new GraphQLInputObjectType({
      name: `${scalar.name}Filter`,
      fields: {
        eq: { type: scalar }, neq: { type: scalar },
        gt: { type: scalar }, lt: { type: scalar }, gte: { type: scalar }, lte: { type: scalar },
        in: { type: new GraphQLList(new GraphQLNonNull(scalar)) },
        contains: { type: GraphQLString }, startsWith: { type: GraphQLString }, endsWith: { type: GraphQLString },
      },
    });
    opInputs.set(cacheKey, op);
  }
  return op;
}

/** A vertex label → a GraphQL type name. Reflection has no user-given names, so the label IS the name;
 *  it is already a valid identifier in every graph we reflect (interned labels are identifiers), so this
 *  is identity today. Isolated here so a future label needing sanitisation (a leading digit, a hyphen) has
 *  one place to grow, and so the mapping is stated rather than assumed. */
const gqlTypeName = (label: string): string => label;

/** Resolver factories for the differential oracle only — the naive resolver set graphql-js executes as
 *  the execution ORACLE (§7·2). Kept as an interface so the introspection/validation build (the common
 *  case) passes nothing and graphql-js never touches a data field. */
export interface Resolvers {
  root(typeName: string): GraphQLFieldConfig<unknown, unknown>['resolve'];
  edge(typeName: string, fieldName: string): GraphQLFieldConfig<unknown, unknown>['resolve'];
  /** The edge COMPANION field (`created_edges`) — resolves to the edge wrappers (`{node, …edgeProps}`). */
  edgeCompanion(typeName: string, fieldName: string): GraphQLFieldConfig<unknown, unknown>['resolve'];
}
