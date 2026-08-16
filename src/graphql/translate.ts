import { parse, Kind, type DocumentNode, type OperationDefinitionNode, type SelectionSetNode, type FieldNode } from 'graphql';
import { type GraphSchema, type TypeSchema, type EdgeSchema, EDGE_COMPANION_SUFFIX } from './schema.ts';
import { argClauses } from './args.ts';
import { Bindings } from './bindings.ts';

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
 *  (§5·4). `params` carries the GraphQL variables as bound parameters (§6) — empty when the query used
 *  none. */
export interface Translation {
  readonly gremlin: string;
  readonly params: Record<string, unknown>;
  /** The root field's alias-or-name — the key GraphQL's `{data}` envelope nests the result under. The
   *  translator rooted the traversal at this field, so it hands the key back rather than making the
   *  HTTP edge re-parse the document to recover it. */
  readonly rootKey: string;
}

/** The single query operation, or a clear refusal. A document with zero or several operations, or a
 *  mutation/subscription, is out of scope — fail closed rather than pick one. Variable DECLARATIONS
 *  (`query($x: Int)`) are allowed; each `$x` USE resolves against the request's `variables` map at its
 *  reference site (`Bindings`), binding rather than inlining (§6). */
function soleQuery(doc: DocumentNode): OperationDefinitionNode {
  const ops = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  if (ops.length !== 1) throw new GraphQLTranslationError(`expected exactly one operation, got ${ops.length}`);
  const op = ops[0]!;
  if (op.operation !== 'query') throw new GraphQLTranslationError(`only 'query' operations are supported yet, not '${op.operation}'`);
  return op;
}

/**
 * `@skip`/`@include` resolved at translation — GraphQL's rule (`@skip(if:true)` drops the field,
 * `@include(if:false)` drops it), so a KEPT field is one neither excludes. Returns whether to keep.
 *
 * ⚠️ This is a FAIL-OPEN trap if left unhandled: graphql-js parses the directive but the translator would
 * otherwise never read `field.directives`, so `name @skip(if:true)` would silently emit `name` anyway —
 * a wrong answer, the exact class this project forbids. The `if:` must be a boolean LITERAL in this cut
 * (a variable `@skip(if:$x)` is refused, since variables are — a directive over a dropped variable would
 * be the same silent-drop bug one level down). An unknown directive is refused, not ignored.
 */
function keepField(field: FieldNode): boolean {
  let keep = true;
  for (const dir of field.directives ?? []) {
    const name = dir.name.value;
    if (name !== 'skip' && name !== 'include')
      throw new GraphQLTranslationError(`unsupported directive @${name} on '${field.name.value}'`);
    const ifArg = (dir.arguments ?? []).find((a) => a.name.value === 'if');
    if (!ifArg || ifArg.value.kind !== Kind.BOOLEAN)
      throw new GraphQLTranslationError(`@${name} needs a boolean literal 'if:' argument (a variable is not supported yet)`);
    // @skip(if:true) drops; @include(if:false) drops. AND across several directives, GraphQL's rule.
    if (name === 'skip' ? ifArg.value.value : !ifArg.value.value) keep = false;
  }
  return keep;
}

/** The plain field selections of a set, with `@skip`/`@include` RESOLVED (a dropped field is gone from
 *  the result) and fragments refused rather than skipped silently. Field ARGUMENTS are validated later,
 *  where the type schema is in hand (`fieldBy`/root); an unsupported argument fails closed THERE. */
function fields(set: SelectionSetNode): readonly FieldNode[] {
  const kept: FieldNode[] = [];
  for (const sel of set.selections) {
    if (sel.kind !== Kind.FIELD) throw new GraphQLTranslationError(`fragments are not supported yet (${sel.kind})`);
    if (keepField(sel)) kept.push(sel);
  }
  return kept;
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
function projectBody(set: SelectionSetNode, type: TypeSchema, schema: GraphSchema, binds: Bindings): string {
  const fs = fields(set);
  if (!fs.length) throw new GraphQLTranslationError(`empty selection on type '${type.name}'`);
  const keys = fs.map((f) => glit(keyOf(f))).join(', ');
  const bys = fs.map((f) => `.by(${fieldBy(f, type, schema, binds)})`).join('');
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
function fieldBy(field: FieldNode, type: TypeSchema, schema: GraphSchema, binds: Bindings): string {
  const name = field.name.value;
  const args = field.arguments ?? [];
  // `__typename` is GraphQL's meta-field, valid on every object type and resolving to the type's name.
  // Reflection maps a GraphQL type to a vertex label, and the enclosing type is fixed at THIS point in
  // the walk, so the answer is a compile-time constant — `constant('person')` — not a `label()` read
  // (which would also be correct but spend a traversal for a value the translator already holds).
  if (name === '__typename') {
    if (field.selectionSet) throw new GraphQLTranslationError(`'__typename' cannot have a selection set`);
    if (args.length) throw new GraphQLTranslationError(`'__typename' takes no arguments`);
    return `__.constant(${glit(type.name)})`;
  }
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
    const move = `__.${edge.direction}(${glit(edge.label)})${argClauses(args, (k) => to.properties.has(k), binds)}`;
    return `${move}.${projectBody(field.selectionSet, to, schema, binds)}.fold()`;
  }
  // The edge COMPANION field (`created_edges`) surfaces the edge's OWN properties (§ edge-field data). It
  // strips the `_edges` suffix to find the base edge field, so `created_edges`→`created` and an incoming
  // `created_in_edges`→`created_in`. Only an edge WITH properties gets one (`sdl.ts` mints the field), so
  // a companion on a propertyless edge is a schema mismatch, refused here.
  if (name.endsWith(EDGE_COMPANION_SUFFIX)) {
    const baseEdge = type.edges.get(name.slice(0, -EDGE_COMPANION_SUFFIX.length));
    if (baseEdge && baseEdge.properties.size) return edgeCompanionBy(field, baseEdge, schema, binds);
  }
  throw new GraphQLTranslationError(`type '${type.name}' has no field '${name}'`);
}

/**
 * The `by()` body for an edge COMPANION field — the Neo4j-style edge wrapper (`schema.ts`
 * `edgeCompanionFieldName`). Where a plain edge field steps to the far VERTEX (`out(edge)`), the companion
 * steps to the EDGE (`outE(edge)`), so it can read the edge's own properties, and reaches the far vertex
 * through a `node` sub-field (`inV()` for an out edge, `outV()` for an in edge). Verified to compile and
 * run (out, in, and edge-property filtering) before writing.
 *
 * Each selected field is either the special `node` (→ the far-vertex projection) or an edge PROPERTY
 * (→ `values(key)` on the edge). `where`/`sort`/`limit` here filter/order/slice the EDGES on their own
 * properties, so they sit right after `outE`/`inE` — the same argument surface, applied one hop earlier.
 */
function edgeCompanionBy(field: FieldNode, edge: EdgeSchema, schema: GraphSchema, binds: Bindings): string {
  const to = schema.types.get(edge.to);
  if (!to) throw new GraphQLTranslationError(`edge companion points at unknown type '${edge.to}'`);
  const sels = fields(field.selectionSet!);
  if (!sels.length) throw new GraphQLTranslationError(`empty selection on edge '${edge.label}'`);
  const keys = sels.map((f) => glit(keyOf(f))).join(', ');
  const bys = sels.map((f) => {
    const fn = f.name.value;
    if (fn === 'node') {
      if (!f.selectionSet) throw new GraphQLTranslationError(`'node' on edge '${edge.label}' needs a selection set`);
      // The far vertex: an out edge's other end is `inV()`, an in edge's is `outV()`.
      const step = edge.direction === 'out' ? 'inV' : 'outV';
      return `.by(__.${step}().${projectBody(f.selectionSet, to, schema, binds)})`;
    }
    const prop = edge.properties.get(fn);
    if (!prop) throw new GraphQLTranslationError(`edge '${edge.label}' has no property '${fn}' (edge fields are 'node' or an edge property)`);
    if (f.selectionSet) throw new GraphQLTranslationError(`edge property '${edge.label}.${fn}' cannot have a selection set`);
    if ((f.arguments ?? []).length) throw new GraphQLTranslationError(`edge property '${edge.label}.${fn}' takes no arguments`);
    return `.by(__.values(${glit(prop.key)}))`;
  }).join('');
  // `where`/`sort`/`limit` filter the EDGES on their OWN properties (validated against the edge's props).
  const stepE = edge.direction === 'out' ? 'outE' : 'inE';
  const move = `__.${stepE}(${glit(edge.label)})${argClauses(field.arguments ?? [], (k) => edge.properties.has(k), binds)}`;
  return `${move}.project(${keys})${bys}.fold()`;
}

/**
 * Translate a whole GraphQL document into a Gremlin string.
 *
 * The document's root fields are separate top-level selections over the query root; this cut supports a
 * SINGLE root field (a query with several roots is several traversals, which needs the multi-result
 * shape — a later increment). The root field's NAME is the vertex label (reflection-first), so the
 * source is `g.V().hasLabel(Type)` and the rest is the ordinary nested projection.
 */
export function translate(source: string, schema: GraphSchema, variables: Record<string, unknown> = {}): Translation {
  const op = soleQuery(parse(source));
  const roots = fields(op.selectionSet);
  if (roots.length !== 1) throw new GraphQLTranslationError(`exactly one root field is supported yet, got ${roots.length}`);
  const root = roots[0]!;
  const type = schema.types.get(root.name.value);
  if (!type) throw new GraphQLTranslationError(`no type '${root.name.value}' in the reflected schema`);
  if (!root.selectionSet) throw new GraphQLTranslationError(`root field '${root.name.value}' needs a selection set`);
  // A GraphQL variable BINDS (§6): its value rides in `params`, referenced by a minted identifier in
  // the string, never inlined. `binds` accumulates them as the walk resolves each `$x` at its use.
  const binds = new Bindings(variables);
  // The root `where` filters the source vertices: `V().hasLabel(Type).has(k, …).project(…)`.
  const where = argClauses(root.arguments ?? [], (k) => type.properties.has(k), binds);
  const gremlin = `g.V().hasLabel(${glit(type.name)})${where}.${projectBody(root.selectionSet, type, schema, binds)}`;
  return { gremlin, params: binds.params(), rootKey: keyOf(root) };
}

/** Re-export so a caller builds the schema and translates from one module. */
export { buildSchema, edgeFieldName } from './schema.ts';
