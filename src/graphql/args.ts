import { Kind, type ArgumentNode, type ValueNode, type ObjectValueNode } from 'graphql';
import { GraphQLTranslationError } from './translate.ts';
import type { Bindings } from './bindings.ts';

// ---------- field arguments — the `where` filter, and (later) sort/limit/offset ----------
//
// The convention is the industry-universal one (researched across Neo4j, Hasura, PostGraphile,
// Dgraph): a `where` argument holding a nested per-field operator object,
// `where: { field: { op: value } }`, combined implicitly with AND across fields. Operator names are
// UNPREFIXED (`eq`/`gt`/`contains`), matching the two GRAPH databases (Neo4j v6, Dgraph) — our closest
// analogues — and they map 1:1 onto Gremlin predicates, which is why a `where` lowers to a run of
// `has(key, <predicate>)` clauses the engine already handles at every nesting level.
//
// Fail closed, like the rest of the translator: an unknown operator, a bare value with no operator
// object, a `null` value, or an unrepresentable literal RAISES `GraphQLTranslationError` rather than
// emitting a filter that quietly means something else.

/** A Gremlin string literal — single-quoted, backslash/quote escaped. The one place a user VALUE (not a
 *  schema name) reaches the Gremlin text, so the escape is load-bearing, not defensive. */
const glit = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * A GraphQL filter value → its Gremlin form. A LITERAL is inlined, typed lexically so the parser infers
 * the right type (§5·2): an Int is bare (`30`), a Float carries a decimal (`30.0` — forced so an
 * integral float still parses as a double), a String is quoted, a Boolean is `true`/`false`. A VARIABLE
 * (`$x`) BINDS instead (§6): it emits a minted Gremlin identifier and records its value in `binds`,
 * never inlining — so `where: { age: { gt: $min } }` shares one cached plan across calls. An enum,
 * `null`, or a nested object/list is refused — none is a scalar filter value this cut expresses.
 */
function gremlinValue(v: ValueNode, binds: Bindings): string {
  switch (v.kind) {
    case Kind.INT: return v.value;
    case Kind.FLOAT: return v.value.includes('.') || v.value.includes('e') || v.value.includes('E') ? v.value : `${v.value}.0`;
    case Kind.STRING: return glit(v.value);
    case Kind.BOOLEAN: return v.value ? 'true' : 'false';
    case Kind.VARIABLE: return binds.reference(v.name.value);
    default: throw new GraphQLTranslationError(`unsupported filter value (${v.kind}) — only Int/Float/String/Boolean scalars or a variable are supported`);
  }
}

/** The operator vocabulary, each mapped to the Gremlin predicate that renders it. A comparison is a
 *  `P.*`; a substring op is a `TextP.*` (text search, which the engine serves via the trigram index or
 *  `LIKE`). `in` takes a LIST and renders `within(...)`. One authority, so a name the schema would
 *  advertise and a name this accepts cannot drift. */
const COMPARISON: Record<string, string> = { eq: 'eq', neq: 'neq', gt: 'gt', lt: 'lt', gte: 'gte', lte: 'lte' };
const TEXT: Record<string, string> = { contains: 'containing', startsWith: 'startingWith', endsWith: 'endingWith' };

/** One `{ op: value }` operator object for a property → the Gremlin predicate expression (the second
 *  argument of `has(key, …)`). Exactly one operator per object in this cut; several `has()` clauses
 *  express an AND over a field, which the caller emits by repeating the key. */
function predicate(key: string, opObj: ObjectValueNode, binds: Bindings): string[] {
  if (!opObj.fields.length) throw new GraphQLTranslationError(`empty filter object for field '${key}'`);
  return opObj.fields.map((f) => {
    const op = f.name.value;
    if (op === 'in') {
      // `in` takes a LIST literal (`within(a, b, c)`) or a single VARIABLE holding the whole list
      // (`within($xs)` — one bound param, the list). A scalar there is the error.
      if (f.value.kind === Kind.LIST) return `within(${f.value.values.map((x) => gremlinValue(x, binds)).join(', ')})`;
      if (f.value.kind === Kind.VARIABLE) return `within(${binds.reference(f.value.name.value)})`;
      throw new GraphQLTranslationError(`'in' on '${key}' needs a list or a list variable`);
    }
    if (COMPARISON[op]) return `P.${COMPARISON[op]}(${gremlinValue(f.value, binds)})`;
    if (TEXT[op]) return `TextP.${TEXT[op]}(${gremlinValue(f.value, binds)})`;
    throw new GraphQLTranslationError(`unknown filter operator '${op}' on '${key}' (expected ${[...Object.keys(COMPARISON), ...Object.keys(TEXT), 'in'].join('/')})`);
  });
}

/** `where: { field: { op: value } }` → the `.has(key, predicate)` clauses. Each field is a known
 *  PROPERTY (`allowed`), each value an operator object; a bare value is refused (the convention is
 *  explicit-operator, which the research showed every graph provider uses). */
function whereClauses(arg: ArgumentNode, allowed: (key: string) => boolean, binds: Bindings): string {
  if (arg.value.kind !== Kind.OBJECT)
    throw new GraphQLTranslationError(`'where' must be an object of { field: { op: value } }`);
  const clauses: string[] = [];
  for (const field of arg.value.fields) {
    const key = field.name.value;
    if (!allowed(key)) throw new GraphQLTranslationError(`cannot filter on '${key}' — not a property of this type`);
    if (field.value.kind !== Kind.OBJECT)
      throw new GraphQLTranslationError(`filter on '${key}' must be an operator object { op: value }, not a bare value`);
    for (const pred of predicate(key, field.value, binds)) clauses.push(`.has(${glit(key)}, ${pred})`);
  }
  return clauses.join('');
}

/** `sort: [{ field: ASC|DESC }]` → `.order().by(key, asc|desc)…` — a LIST so tie-breaks order (Neo4j's
 *  shape). A single object `sort: { field: ASC }` is accepted too (the common one-key case). Each field
 *  is a known property; the direction is the `ASC`/`DESC` enum (default `ASC` if omitted). */
function sortClause(arg: ArgumentNode, allowed: (key: string) => boolean): string {
  const specs = arg.value.kind === Kind.LIST ? arg.value.values : [arg.value];
  const bys: string[] = [];
  for (const spec of specs) {
    if (spec.kind !== Kind.OBJECT || spec.fields.length !== 1)
      throw new GraphQLTranslationError(`each 'sort' entry must be one { field: ASC|DESC }`);
    const f = spec.fields[0]!;
    const key = f.name.value;
    if (!allowed(key)) throw new GraphQLTranslationError(`cannot sort on '${key}' — not a property of this type`);
    if (f.value.kind !== Kind.ENUM || (f.value.value !== 'ASC' && f.value.value !== 'DESC'))
      throw new GraphQLTranslationError(`sort direction for '${key}' must be ASC or DESC`);
    bys.push(`.by(${glit(key)}, ${f.value.value === 'DESC' ? 'desc' : 'asc'})`);
  }
  return bys.length ? `.order()${bys.join('')}` : '';
}

/** A non-negative Int argument (`limit`/`offset`), or a refusal. */
function intArg(arg: ArgumentNode): number {
  if (arg.value.kind !== Kind.INT) throw new GraphQLTranslationError(`'${arg.name.value}' must be an integer`);
  const n = parseInt(arg.value.value, 10);
  if (n < 0) throw new GraphQLTranslationError(`'${arg.name.value}' must be >= 0`);
  return n;
}

/**
 * A field's arguments → the full Gremlin suffix, in the ORDER Gremlin needs: filter (`has`) → order
 * (`order().by`) → range (`skip`/`limit`). The order is semantic, not cosmetic — filtering after a slice
 * would slice the wrong set, ordering after it likewise — so this owns the whole suffix rather than
 * letting the caller concatenate pieces.
 *
 * The four reserved names are `where`/`sort`/`limit`/`offset`; anything else RAISES (an arbitrary
 * argument is not part of the surface, and accepting it silently is the accept-and-ignore stub this
 * project forbids). `limit`/`offset` become `skip(offset).limit(limit)`: `range(a,b)` would need the two
 * folded, and skip+limit reads the same and composes when only one is given.
 */
export function argClauses(args: readonly ArgumentNode[], allowed: (key: string) => boolean, binds: Bindings): string {
  const by = new Map<string, ArgumentNode>();
  for (const arg of args) {
    const name = arg.name.value;
    if (name !== 'where' && name !== 'sort' && name !== 'limit' && name !== 'offset')
      throw new GraphQLTranslationError(`unsupported argument '${name}' (expected where/sort/limit/offset)`);
    if (by.has(name)) throw new GraphQLTranslationError(`argument '${name}' given twice`);
    by.set(name, arg);
  }
  // `where` VALUES may be variables (they bind, §6); `sort`/`limit`/`offset` are structural in this cut —
  // a `limit: $n` is a value the PLAN shape depends on (a `limit` step's count is not a bind here), so it
  // stays a literal, and a variable there is refused by `intArg`. `sort` keys are property names, not
  // values, so never variable.
  const where = by.get('where') ? whereClauses(by.get('where')!, allowed, binds) : '';
  const sort = by.get('sort') ? sortClause(by.get('sort')!, allowed) : '';
  const offset = by.get('offset') ? `.skip(${intArg(by.get('offset')!)})` : '';
  const limit = by.get('limit') ? `.limit(${intArg(by.get('limit')!)})` : '';
  return `${where}${sort}${offset}${limit}`;
}
