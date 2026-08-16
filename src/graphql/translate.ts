import { parse, Kind, type DocumentNode, type OperationDefinitionNode, type SelectionSetNode, type FieldNode } from 'graphql';
import { type GraphSchema, type TypeSchema } from './schema.ts';
import { argClauses } from './args.ts';

// ---------- the GraphQL translator — a document + reflected schema → a Gremlin string ----------
//
// A GraphQL query is a tree of field selections over a typed schema, and a Gremlin `project().by()` is
// "for each traverser produce a named tuple whose fields are computed by sub-traversals" — the same
// thing (`docs/2026-08-07-graphql-front-end-plan.md` §1·1, a structural identity). So this walks the
// document top-down against the REFLECTED schema (`schema.ts`) and emits Gremlin TEXT, the emission
// strategy the §5·2 spike settled: a string reaches the fully-tested compiler door
// (`parseGremlin`→L1-L5), where a hand-built `Step[]` would need untested extract-over-IR plumbing.
//
// The mapping, reflection-first:
//   - a ROOT field    → `g.V().hasLabel(Type)` (the type name is the vertex label);
//   - a SCALAR field   → `by(__.values(key))` (the field name is the property key);
//   - an OBJECT field  → `by(__.<out|in>(edgeLabel).project(…).by(…)….fold())` — a nested selection,
//     folded because a graph edge is to-MANY (every GraphQL object-over-an-edge field is a list;
//     single-valued fields are a later schema refinement).
//
// SCOPE (fail-closed): one query operation, named-type root fields, scalar + object fields, and the
// `where`/`sort`/`limit`/`offset` field arguments (`args.ts`). Still out: fragments, `__typename`,
// introspection (served from the schema directly, not translated), variables, interfaces/unions.
// Anything outside scope RAISES a clear `GraphQLTranslationError` — never emits a half-Gremlin string,
// the fail-closed rule (root CLAUDE.md: never silently answer a different question).

export class GraphQLTranslationError extends Error {
  constructor(message: string) { super(message); this.name = 'GraphQLTranslationError'; }
}

/** What a translated document hands the compiler seam — the same `{gremlin, params}` a Gremlin client
 *  sends (`src/router.ts`), so the translator needs zero changes to the manager/executor contract
 *  (§5·4). `params` is empty until variables land; it exists now so the seam shape is final. */
export interface Translation {
  readonly gremlin: string;
  readonly params: Record<string, unknown>;
  /** The root field's alias-or-name — the key GraphQL's `{data}` envelope nests the result under. The
   *  translator rooted the traversal at this field, so it hands the key back rather than making the
   *  HTTP edge re-parse the document to recover it. */
  readonly rootKey: string;
}

/** The single query operation, or a clear refusal. A document with zero or several operations, a
 *  mutation/subscription, or a query that DECLARES VARIABLES is out of this cut's scope — fail closed
 *  rather than pick one or silently drop what it cannot honour. The variable check is load-bearing: the
 *  edge accepts a `variables` map, and translating a `query($x)` while ignoring `$x` would answer a
 *  DIFFERENT question than the client asked (root CLAUDE.md's cardinal rule). Variables → the bind rule
 *  (§6) is the next increment; until then a declared variable is refused, never dropped. */
function soleQuery(doc: DocumentNode): OperationDefinitionNode {
  const ops = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  if (ops.length !== 1) throw new GraphQLTranslationError(`expected exactly one operation, got ${ops.length}`);
  const op = ops[0]!;
  if (op.operation !== 'query') throw new GraphQLTranslationError(`only 'query' operations are supported yet, not '${op.operation}'`);
  if (op.variableDefinitions && op.variableDefinitions.length)
    throw new GraphQLTranslationError('query variables are not supported yet (they would be silently dropped)');
  return op;
}

/** The plain field selections of a set, refusing anything this cut cannot express (fragments, inline
 *  fragments) rather than skipping it silently. Field ARGUMENTS are no longer refused here — a field's
 *  `where` is translated where the field is (`fieldBy`/root), which is the only place the type schema
 *  needed to validate a filter key is in hand; an unsupported argument fails closed THERE (`args.ts`). */
function fields(set: SelectionSetNode): readonly FieldNode[] {
  return set.selections.map((sel) => {
    if (sel.kind !== Kind.FIELD) throw new GraphQLTranslationError(`fragments are not supported yet (${sel.kind})`);
    return sel;
  });
}

/** The projection key a field contributes — its alias where given, else its name (GraphQL's own rule,
 *  and exactly what a `project()` key is). */
const keyOf = (field: FieldNode): string => field.alias?.value ?? field.name.value;

/** A Gremlin string literal — single-quoted, the form the grammar parses and the renderer the §5·2
 *  spike verified round-trips. A schema-derived name (a label, a property key) cannot contain a quote
 *  the reflection did not store, but escaping is stated so a future user-named field stays safe. */
const glit = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Translate ONE selection set over `type` into the body of a `project().by()…` — returned as the
 * Gremlin fragment that projects each field, WITHOUT the leading source. The caller prepends the
 * source (`g.V().hasLabel(...)` at the root, `__.out(edge)` in a nested `by()`).
 *
 * Empty selection sets are refused: a GraphQL object field must select at least one sub-field, and an
 * empty `project()` is not a thing — the parser already enforces this, so reaching it is a bug, not a
 * user error, and raising names it.
 */
function projectBody(set: SelectionSetNode, type: TypeSchema, schema: GraphSchema): string {
  const fs = fields(set);
  if (!fs.length) throw new GraphQLTranslationError(`empty selection on type '${type.name}'`);
  const keys = fs.map((f) => glit(keyOf(f))).join(', ');
  const bys = fs.map((f) => `.by(${fieldBy(f, type, schema)})`).join('');
  return `project(${keys})${bys}`;
}

/**
 * The `by()` body for ONE field — a scalar read or a nested object traversal.
 *
 * A field is a SCALAR (property) or an OBJECT (edge) by what the schema says it is; a name that is
 * neither is a clear refusal, not a guess. An object field is ALWAYS folded here: a graph edge is
 * to-many, so a GraphQL object-over-an-edge field is a list, and the nested selection is itself a
 * `project().by()…` rooted at the movement — the recursion that makes depth compose (verified to
 * depth-3 in the RelIR substrate work).
 */
function fieldBy(field: FieldNode, type: TypeSchema, schema: GraphSchema): string {
  const name = field.name.value;
  const args = field.arguments ?? [];
  const prop = type.properties.get(name);
  if (prop) {
    if (field.selectionSet) throw new GraphQLTranslationError(`scalar field '${type.name}.${name}' cannot have a selection set`);
    // A scalar field is a value read, not a collection, so a `where` on it has nothing to filter.
    if (args.length) throw new GraphQLTranslationError(`scalar field '${type.name}.${name}' takes no arguments`);
    return `__.values(${glit(prop.key)})`;
  }
  const edge = type.edges.get(name);
  if (edge) {
    if (!field.selectionSet) throw new GraphQLTranslationError(`object field '${type.name}.${name}' needs a selection set`);
    const to = schema.types.get(edge.to);
    if (!to) throw new GraphQLTranslationError(`edge field '${type.name}.${name}' points at unknown type '${edge.to}'`);
    // `where` filters the far endpoint, so its `has()` clauses sit AFTER the movement and BEFORE the
    // nested projection — `out(edge).has(k, …).project(…).fold()` — filtering the neighbour set that is
    // folded. The keys must be properties of the far type (`to`), which is what `argClauses` validates.
    const move = `__.${edge.direction}(${glit(edge.label)})${argClauses(args, (k) => to.properties.has(k))}`;
    return `${move}.${projectBody(field.selectionSet, to, schema)}.fold()`;
  }
  throw new GraphQLTranslationError(`type '${type.name}' has no field '${name}'`);
}

/**
 * Translate a whole GraphQL document into a Gremlin string.
 *
 * The document's root fields are separate top-level selections over the query root; this cut supports a
 * SINGLE root field (a query with several roots is several traversals, which needs the multi-result
 * shape — a later increment). The root field's NAME is the vertex label (reflection-first), so the
 * source is `g.V().hasLabel(Type)` and the rest is the ordinary nested projection.
 */
export function translate(source: string, schema: GraphSchema): Translation {
  const op = soleQuery(parse(source));
  const roots = fields(op.selectionSet);
  if (roots.length !== 1) throw new GraphQLTranslationError(`exactly one root field is supported yet, got ${roots.length}`);
  const root = roots[0]!;
  const type = schema.types.get(root.name.value);
  if (!type) throw new GraphQLTranslationError(`no type '${root.name.value}' in the reflected schema`);
  if (!root.selectionSet) throw new GraphQLTranslationError(`root field '${root.name.value}' needs a selection set`);
  // The root `where` filters the source vertices: `V().hasLabel(Type).has(k, …).project(…)`.
  const where = argClauses(root.arguments ?? [], (k) => type.properties.has(k));
  const gremlin = `g.V().hasLabel(${glit(type.name)})${where}.${projectBody(root.selectionSet, type, schema)}`;
  return { gremlin, params: {}, rootKey: keyOf(root) };
}

/** Re-export so a caller builds the schema and translates from one module. */
export { buildSchema, edgeFieldName } from './schema.ts';
