import { Kind, type ArgumentNode, type ValueNode, type ObjectValueNode } from 'graphql';
import { GraphQLTranslationError } from './translate.ts';

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
 * A GraphQL scalar literal → its Gremlin literal FORM, typed lexically so the parser infers the right
 * type (§5·2's concern): an Int is bare (`30`), a Float carries a decimal point (`30.0` — forced so an
 * integral float like `30` still parses as a double), a String is quoted, a Boolean is `true`/`false`.
 * A `null`, a variable, an enum, or a nested object/list is refused — none is a scalar filter value this
 * cut expresses.
 */
function gremlinScalar(v: ValueNode): string {
  switch (v.kind) {
    case Kind.INT: return v.value;
    case Kind.FLOAT: return v.value.includes('.') || v.value.includes('e') || v.value.includes('E') ? v.value : `${v.value}.0`;
    case Kind.STRING: return glit(v.value);
    case Kind.BOOLEAN: return v.value ? 'true' : 'false';
    default: throw new GraphQLTranslationError(`unsupported filter value (${v.kind}) — only Int/Float/String/Boolean scalars are supported`);
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
function predicate(key: string, opObj: ObjectValueNode): string[] {
  if (!opObj.fields.length) throw new GraphQLTranslationError(`empty filter object for field '${key}'`);
  return opObj.fields.map((f) => {
    const op = f.name.value;
    if (op === 'in') {
      if (f.value.kind !== Kind.LIST) throw new GraphQLTranslationError(`'in' on '${key}' needs a list`);
      return `within(${f.value.values.map(gremlinScalar).join(', ')})`;
    }
    if (COMPARISON[op]) return `P.${COMPARISON[op]}(${gremlinScalar(f.value)})`;
    if (TEXT[op]) return `TextP.${TEXT[op]}(${gremlinScalar(f.value)})`;
    throw new GraphQLTranslationError(`unknown filter operator '${op}' on '${key}' (expected ${[...Object.keys(COMPARISON), ...Object.keys(TEXT), 'in'].join('/')})`);
  });
}

/**
 * A field's `where` argument → the `.has(key, predicate)` Gremlin clauses it contributes, or `[]` when
 * there is no `where`. Every non-`where` argument RAISES: `sort`/`limit`/`offset` are the reserved
 * paging/order names a later increment claims, and an arbitrary argument is not part of the surface, so
 * accepting it silently would be the accept-and-ignore stub this project forbids.
 *
 * Each `where` entry is `field: { op: value }` — the field must be a known PROPERTY (the caller passes a
 * `has(key)` predicate — checking membership is the caller's, since it holds the type schema); this
 * module owns only the `{op:value}` → predicate translation. A bare `field: value` (no operator object)
 * is refused: the convention is explicit-operator, and a bare value would be an ambiguous shorthand the
 * research showed no graph provider uses.
 */
export function whereClauses(args: readonly ArgumentNode[], allowed: (key: string) => boolean): string {
  const clauses: string[] = [];
  for (const arg of args) {
    if (arg.name.value !== 'where')
      throw new GraphQLTranslationError(`unsupported argument '${arg.name.value}' (only 'where' is supported yet)`);
    if (arg.value.kind !== Kind.OBJECT)
      throw new GraphQLTranslationError(`'where' must be an object of { field: { op: value } }`);
    for (const field of arg.value.fields) {
      const key = field.name.value;
      if (!allowed(key)) throw new GraphQLTranslationError(`cannot filter on '${key}' — not a property of this type`);
      if (field.value.kind !== Kind.OBJECT)
        throw new GraphQLTranslationError(`filter on '${key}' must be an operator object { op: value }, not a bare value`);
      for (const pred of predicate(key, field.value)) clauses.push(`.has(${glit(key)}, ${pred})`);
    }
  }
  return clauses.join('');
}
