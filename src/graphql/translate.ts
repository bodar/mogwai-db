import {
  parse, Kind, type DocumentNode, type OperationDefinitionNode, type SelectionSetNode, type FieldNode,
  type FragmentDefinitionNode, type DirectiveNode,
} from 'graphql';
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
// SCOPE (fail-closed): one query operation, one root field, scalar + object + edge-companion fields, the
// `where`/`sort`/`limit`/`offset` field arguments (`args.ts`), variables as BINDS, `@skip`/`@include`,
// `@recurse`, `__typename`, and FRAGMENTS — named and inline — inlined at translation (`fields`).
// Introspection is served from the schema directly rather than translated (`edge.ts`).
//
// Still out: INTERFACES AND UNIONS, which is one refusal rather than a list — a fragment whose type
// condition names a type other than the one being walked. The engine substrate for it is in (a
// `coalesce` of per-member `project()` arms lowers and answers, §8·2·1); what is missing is a schema
// that MINTS a polymorphic field, so until then such a document asks for something the schema does not
// offer and is refused rather than answered narrower.
//
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
  /** The RESPONSE KEYS this document asked for, per level (`ResponseShape`) — what the edge needs to
   *  complete a row into a spec-shaped object. Handed back for `rootKey`'s reason: the translator has
   *  just walked the document, so re-deriving it in the edge would be a second walk that can disagree. */
  readonly shape: ResponseShape;
}

/**
 * THE RESPONSE KEYS OF ONE SELECTION LEVEL — what GraphQL requires the response object to CONTAIN, which
 * is not the same as what the graph happened to produce.
 *
 * A Gremlin `project()` OMITS a key whose `by()` was unproductive (`ProjectStep.map`'s `ifProductive`), so
 * a selected property that this vertex does not carry simply is not in the row. GraphQL's `CompleteValue`
 * says the opposite: every selected field has an entry, and a nullable field that resolved to nothing is
 * `null`. Same absence, two contracts — so the edge completes each row against this.
 *
 * `keys` is in SELECTION ORDER, which is also the order the spec requires the response to preserve, so
 * completing a row by rebuilding it in this order satisfies both requirements at once. `children` carries
 * the nested shape of an object-valued key (applied to every member of its list).
 */
export interface ResponseShape {
  readonly keys: readonly string[];
  readonly children: ReadonlyMap<string, ResponseShape>;
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
function keepField(field: { readonly directives?: readonly DirectiveNode[] }, what: string): boolean {
  let keep = true;
  for (const dir of field.directives ?? []) {
    const name = dir.name.value;
    // `@recurse` is handled at the edge-field lowering (`recurseDepth`), not here — it is not a
    // keep/drop directive. Skip it in this pass; an unknown directive is still refused.
    if (name === 'recurse') continue;
    if (name !== 'skip' && name !== 'include')
      throw new GraphQLTranslationError(`unsupported directive @${name} on '${what}'`);
    const ifArg = (dir.arguments ?? []).find((a) => a.name.value === 'if');
    if (!ifArg || ifArg.value.kind !== Kind.BOOLEAN)
      throw new GraphQLTranslationError(`@${name} needs a boolean literal 'if:' argument (a variable is not supported yet)`);
    // @skip(if:true) drops; @include(if:false) drops. AND across several directives, GraphQL's rule.
    if (name === 'skip' ? ifArg.value.value : !ifArg.value.value) keep = false;
  }
  return keep;
}

/**
 * The `@recurse(depth: N)` directive on an edge field, or `null` if absent. It lowers the edge movement to
 * a bounded transitive walk that emits every level up to N — `repeat(<move>).emit().times(N)` — so a
 * client reads a whole reachability network from one field (`docs/2026-08-07-graphql-front-end-plan.md`
 * §1·2, Phase 4). This is the standard GraphQL-over-a-graph extension (Dgraph `@recurse`), and the
 * emit-all-levels-to-depth semantics match Dgraph's (the only prior art).
 *
 * `depth` must be a POSITIVE Int LITERAL — a variable is refused, like `@skip(if:)`, because the level
 * count shapes the plan (the unroll needs a compile-time N; §6). Fail closed on a missing/non-int/non-
 * positive depth rather than guessing one.
 */
function recurseDepth(field: FieldNode): number | null {
  const dir = (field.directives ?? []).find((d) => d.name.value === 'recurse');
  if (!dir) return null;
  const depthArg = (dir.arguments ?? []).find((a) => a.name.value === 'depth');
  if (!depthArg || depthArg.value.kind !== Kind.INT)
    throw new GraphQLTranslationError(`@recurse needs an integer literal 'depth:' argument`);
  const n = parseInt(depthArg.value.value, 10);
  if (n < 1) throw new GraphQLTranslationError(`@recurse 'depth:' must be >= 1`);
  return n;
}

/**
 * The WALK's ambient state — the reflected schema, the accumulating parameter binds, and the document's
 * named fragments.
 *
 * One record rather than three threaded arguments: `schema` and `binds` were already passed through every
 * function here, so adding fragments as a fourth would have made five-parameter signatures out of a walk
 * whose only real arguments are "which selection set" and "over which type". A caller cannot now forget
 * one of the three either.
 */
interface Ctx {
  readonly schema: GraphSchema;
  readonly binds: Bindings;
  /** The document's named fragments, by name — `FragmentSpreadNode` resolves through this. */
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>;
}

/**
 * A selection set FLATTENED to plain fields — fragments inlined, `@skip`/`@include` resolved.
 *
 * Fragments are how real GraphQL clients are written (every codegen tool emits them), and they carry no
 * execution semantics of their own: the spec's `CollectFields` inlines a spread whose type condition
 * applies and skips one whose condition does not, so a fragment is a purely SYNTACTIC grouping. That is
 * why this belongs here and not in the lowering — by the time a selection set reaches `projectBody` there
 * are only fields.
 *
 * Three kinds of selection, and each is inlined or refused for its own reason:
 *
 * - a FIELD is itself;
 * - an INLINE FRAGMENT (`... on T { … }`) and a NAMED SPREAD (`...F`) inline when their type condition
 *   names the type being walked, or is absent (an inline fragment may omit it — `... @include(if:) { … }`
 *   is a directive carrier over the same type);
 * - a condition naming a DIFFERENT type is the polymorphic case, and it is refused rather than inlined or
 *   dropped. Both wrong answers are available here and neither is taken: inlining would read the other
 *   type's fields off this one, and dropping would silently answer a smaller query. It becomes correct
 *   when a field can HAVE more than one possible type — an interface or union — which needs the schema to
 *   mint one (§8·2·1); until then the honest answer is that this document asks something the schema does
 *   not offer.
 *
 * `@skip`/`@include` are honoured on the SPREAD as well as on the fields inside it, which is GraphQL's own
 * rule (the directive is `FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT`) and a silent-wrong-answer if missed —
 * the same trap `keepField`'s header records one level down.
 */
function fields(set: SelectionSetNode, ctx: Ctx, seen: readonly string[] = []): readonly FieldNode[] {
  const kept: FieldNode[] = [];
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      if (keepField(sel, sel.name.value)) kept.push(sel);
      continue;
    }
    if (sel.kind === Kind.INLINE_FRAGMENT) {
      if (!keepField(sel, `... on ${sel.typeCondition?.name.value ?? '<no type>'}`)) continue;
      kept.push(...fields(sel.selectionSet, ctx, seen));
      continue;
    }
    // A NAMED SPREAD. graphql-js validation already rejects an unknown fragment and a spread CYCLE
    // (`KnownFragmentNames`, `NoFragmentCycles`), but `translate` is also called directly, so both are
    // refused here rather than trusted — an unresolvable name would otherwise read as an empty selection
    // and a cycle would not return at all.
    const name = sel.name.value;
    if (!keepField(sel, `...${name}`)) continue;
    if (seen.includes(name)) throw new GraphQLTranslationError(`fragment '${name}' spreads itself`);
    const def = ctx.fragments.get(name);
    if (!def) throw new GraphQLTranslationError(`no fragment named '${name}' in the document`);
    kept.push(...fields(def.selectionSet, ctx, [...seen, name]));
  }
  return kept;
}

/**
 * Does a fragment's type condition apply to the type being walked?
 *
 * Reflection maps a GraphQL object type to a vertex label one-for-one, and a type has no supertypes yet,
 * so "applies" is name equality — there is no interface to satisfy and no union to be a member of. An
 * ABSENT condition applies by definition (an inline fragment may omit it).
 *
 * Kept as its own function because it is exactly the predicate that grows when interfaces and unions land:
 * the answer becomes "equal, or `type` implements/is a member of the condition", and the polymorphic
 * refusal below turns into a per-member dispatch. One place to change, and it is named.
 */
const conditionApplies = (condition: string | undefined, type: TypeSchema): boolean =>
  condition === undefined || condition === type.name;

/** The fields of a set that apply to `type`, with a POLYMORPHIC condition refused rather than guessed.
 *  Separate from `fields` because the type is only known at the point a selection set is projected, while
 *  flattening is a document-shape question — so `fields` inlines and this one checks. */
function applicableFields(set: SelectionSetNode, type: TypeSchema, ctx: Ctx): readonly FieldNode[] {
  refuseForeignConditions(set, type, ctx, []);
  return fields(set, ctx);
}

/** Walk the set's fragment conditions and raise on the first that names another type. Recursive over
 *  nested spreads, because a condition three fragments deep is the same wrong answer as one at the top. */
function refuseForeignConditions(set: SelectionSetNode, type: TypeSchema, ctx: Ctx, seen: readonly string[]): void {
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) continue;
    const condition = sel.kind === Kind.INLINE_FRAGMENT
      ? sel.typeCondition?.name.value
      : ctx.fragments.get(sel.name.value)?.typeCondition.name.value;
    if (!conditionApplies(condition, type))
      throw new GraphQLTranslationError(
        `fragment on '${condition}' cannot be applied to '${type.name}' — a field with more than one `
        + `possible type needs an interface or union, which the reflected schema does not mint yet`);
    const inner = sel.kind === Kind.INLINE_FRAGMENT ? sel.selectionSet : ctx.fragments.get(sel.name.value)?.selectionSet;
    if (!inner) continue;
    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      if (seen.includes(sel.name.value)) continue; // the cycle is `fields`' refusal; do not loop here
      refuseForeignConditions(inner, type, ctx, [...seen, sel.name.value]);
    } else refuseForeignConditions(inner, type, ctx, seen);
  }
}

/** The projection key a field contributes — its alias where given, else its name (GraphQL's own rule,
 *  and exactly what a `project()` key is). */
const keyOf = (field: FieldNode): string => field.alias?.value ?? field.name.value;

/**
 * The `ResponseShape` of a selection set — the keys it asked for, and each object-valued key's own shape.
 *
 * Deliberately PURELY SYNTACTIC: a response key is the alias-or-name and a nested shape exists exactly
 * where the field has a selection set, so this needs no schema and makes no property-versus-edge decision.
 * That is what keeps it from being a second, disagreeing walk — it reads the SAME flattened field list
 * `projectBody` projects (`fields`, so fragments are inlined and `@skip` is resolved here too), and the
 * one thing it adds is nesting, which the document states directly.
 *
 * It runs after the projection has been built, so a type-condition refusal has already fired and
 * `fields` rather than `applicableFields` is sufficient — there is no foreign condition left to catch.
 */
function shapeOf(set: SelectionSetNode, ctx: Ctx): ResponseShape {
  const fs = fields(set, ctx);
  const children = new Map<string, ResponseShape>();
  for (const f of fs) if (f.selectionSet) children.set(keyOf(f), shapeOf(f.selectionSet, ctx));
  return { keys: fs.map(keyOf), children };
}

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
function projectBody(set: SelectionSetNode, type: TypeSchema, ctx: Ctx): string {
  const fs = applicableFields(set, type, ctx);
  if (!fs.length) throw new GraphQLTranslationError(`empty selection on type '${type.name}'`);
  const keys = fs.map((f) => glit(keyOf(f))).join(', ');
  const bys = fs.map((f) => `.by(${fieldBy(f, type, ctx)})`).join('');
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
function fieldBy(field: FieldNode, type: TypeSchema, ctx: Ctx): string {
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
    const to = ctx.schema.types.get(edge.to);
    if (!to) throw new GraphQLTranslationError(`edge field '${type.name}.${name}' points at unknown type '${edge.to}'`);
    // `where` filters the far endpoint, so its `has()` clauses sit AFTER the movement and BEFORE the
    // nested projection — `out(edge).has(k, …).project(…).fold()` — filtering the neighbour set that is
    // folded. The keys must be properties of the far type (`to`), which is what `argClauses` validates.
    const move = `__.${edge.direction}(${glit(edge.label)})${argClauses(args, (k) => to.properties.has(k), ctx.binds)}`;
    const depth = recurseDepth(field);
    if (depth !== null) {
      // `@recurse(depth:N)` — the edge is walked TRANSITIVELY, emitting every level up to N. It requires
      // the endpoint type to EQUAL the field's owner type (`knows`: person→person), because the same
      // nested selection is applied at every level and only a self-returning edge keeps it valid.
      // `repeat(<move>).emit().times(N)` is the emit-unrolled bounded walk (a union of level-prefixes);
      // the far-endpoint `where`/args apply INSIDE the repeat body (filtering each level's frontier).
      if (edge.to !== type.name)
        throw new GraphQLTranslationError(`@recurse on '${type.name}.${name}' needs a self-returning edge (it points at '${edge.to}', not '${type.name}')`);
      return `__.repeat(${move}).emit().times(${depth}).${projectBody(field.selectionSet, to, ctx)}.fold()`;
    }
    return `${move}.${projectBody(field.selectionSet, to, ctx)}.fold()`;
  }
  // The edge COMPANION field (`created_edges`) surfaces the edge's OWN properties (§ edge-field data). It
  // strips the `_edges` suffix to find the base edge field, so `created_edges`→`created` and an incoming
  // `created_in_edges`→`created_in`. Only an edge WITH properties gets one (`sdl.ts` mints the field), so
  // a companion on a propertyless edge is a schema mismatch, refused here.
  if (name.endsWith(EDGE_COMPANION_SUFFIX)) {
    const baseEdge = type.edges.get(name.slice(0, -EDGE_COMPANION_SUFFIX.length));
    if (baseEdge && baseEdge.properties.size) return edgeCompanionBy(field, baseEdge, ctx);
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
function edgeCompanionBy(field: FieldNode, edge: EdgeSchema, ctx: Ctx): string {
  const to = ctx.schema.types.get(edge.to);
  if (!to) throw new GraphQLTranslationError(`edge companion points at unknown type '${edge.to}'`);
  const sels = fields(field.selectionSet!, ctx);
  if (!sels.length) throw new GraphQLTranslationError(`empty selection on edge '${edge.label}'`);
  const keys = sels.map((f) => glit(keyOf(f))).join(', ');
  const bys = sels.map((f) => {
    const fn = f.name.value;
    if (fn === 'node') {
      if (!f.selectionSet) throw new GraphQLTranslationError(`'node' on edge '${edge.label}' needs a selection set`);
      // The far vertex: an out edge's other end is `inV()`, an in edge's is `outV()`.
      const step = edge.direction === 'out' ? 'inV' : 'outV';
      return `.by(__.${step}().${projectBody(f.selectionSet, to, ctx)})`;
    }
    const prop = edge.properties.get(fn);
    if (!prop) throw new GraphQLTranslationError(`edge '${edge.label}' has no property '${fn}' (edge fields are 'node' or an edge property)`);
    if (f.selectionSet) throw new GraphQLTranslationError(`edge property '${edge.label}.${fn}' cannot have a selection set`);
    if ((f.arguments ?? []).length) throw new GraphQLTranslationError(`edge property '${edge.label}.${fn}' takes no arguments`);
    return `.by(__.values(${glit(prop.key)}))`;
  }).join('');
  // `where`/`sort`/`limit` filter the EDGES on their OWN properties (validated against the edge's props).
  const stepE = edge.direction === 'out' ? 'outE' : 'inE';
  const move = `__.${stepE}(${glit(edge.label)})${argClauses(field.arguments ?? [], (k) => edge.properties.has(k), ctx.binds)}`;
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
  const doc = parse(source);
  const op = soleQuery(doc);
  // A GraphQL variable BINDS (§6): its value rides in `params`, referenced by a minted identifier in
  // the string, never inlined. `binds` accumulates them as the walk resolves each `$x` at its use.
  const ctx: Ctx = { schema, binds: new Bindings(variables), fragments: fragmentsOf(doc) };
  // The ROOT selection set carries no type condition of its own to check (the query root is not a
  // reflected vertex label), so it flattens through `fields` rather than `applicableFields`; a condition
  // on a root-level fragment is checked once the root's type is known, inside `projectBody`.
  const roots = fields(op.selectionSet, ctx);
  if (roots.length !== 1) throw new GraphQLTranslationError(`exactly one root field is supported yet, got ${roots.length}`);
  const root = roots[0]!;
  const type = ctx.schema.types.get(root.name.value);
  if (!type) throw new GraphQLTranslationError(`no type '${root.name.value}' in the reflected schema`);
  if (!root.selectionSet) throw new GraphQLTranslationError(`root field '${root.name.value}' needs a selection set`);
  // The root `where` filters the source vertices: `V().hasLabel(Type).has(k, …).project(…)`.
  const where = argClauses(root.arguments ?? [], (k) => type.properties.has(k), ctx.binds);
  const gremlin = `g.V().hasLabel(${glit(type.name)})${where}.${projectBody(root.selectionSet, type, ctx)}`;
  // The shape is taken AFTER the projection, so every refusal the walk owes has already fired.
  return { gremlin, params: ctx.binds.params(), rootKey: keyOf(root), shape: shapeOf(root.selectionSet, ctx) };
}

/** The document's named fragment definitions, by name. A duplicate name is a graphql-js validation error
 *  (`UniqueFragmentNames`) and last-one-wins here, which is the same shape as its own registry — this map
 *  never decides correctness for a document the edge has validated. */
const fragmentsOf = (doc: DocumentNode): ReadonlyMap<string, FragmentDefinitionNode> =>
  new Map(doc.definitions
    .filter((d): d is FragmentDefinitionNode => d.kind === Kind.FRAGMENT_DEFINITION)
    .map((d) => [d.name.value, d]));

/** Re-export so a caller builds the schema and translates from one module. */
export { buildSchema, edgeFieldName } from './schema.ts';
