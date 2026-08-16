// ---------- the graphql-js differential oracle (Phase 3 · §7·2) ----------
//
// graphql-js is the reference implementation, so pointing it at a NAIVE resolver set over the same graph
// makes it an execution oracle: same document, same variables, two engines, compare — where they disagree
// graphql-js is right by definition (`docs/2026-08-07-graphql-front-end-plan.md` §7·2). It covers the long
// tail no hand-written corpus reaches: field ordering, alias collision, argument coercion, null handling.
//
// The oracle must be INDEPENDENT of the mogwai compiler, else it tests our path against itself. So the
// graph is read ONCE into a plain in-memory model (`GraphModel`) — that read is a trivial `elementMap`
// scan, not the thing under test — and the resolvers (filter → sort → slice → traverse) are pure JS over
// that model, mirroring the SAME semantics the translator lowers to Gremlin (`args.ts`): `where` an AND of
// per-field operator objects, `sort` a stable multi-key order, `limit`/`offset` a slice, an object field a
// to-many edge movement. Two engines, one intended meaning.

import type { Resolvers } from '../../src/graphql/sdl.ts';
import type { GraphSchema } from '../../src/graphql/schema.ts';
import type { GraphStore } from '../../src/storage.ts';
import { exec } from './executor.ts';
import { decodeAll } from './decode.ts';
import type { RegistryProvider } from '../../src/scopes.ts';

/** A vertex in the plain model: its label, its integer id, and its property map. */
export interface OracleVertex {
  readonly id: number;
  readonly label: string;
  readonly props: Readonly<Record<string, unknown>>;
}
/** An edge triple in the plain model. */
export interface OracleEdge {
  readonly label: string;
  readonly from: number;
  readonly to: number;
}
export interface GraphModel {
  readonly vertices: readonly OracleVertex[];
  readonly edges: readonly OracleEdge[];
}

/**
 * Read a store's whole graph into the plain `GraphModel`, independently of the compiler under test. The
 * two reads are trivial and flat — `elementMap()` for vertices (id/label/props), a `project()` for edge
 * triples — their correctness is asserted separately across L1–L4; the differential's value is comparing
 * NESTED, argument-bearing selections, which these reads do not exercise. `T.id`/`T.label` are the token
 * keys `elementMap` emits; everything else is a property.
 */
export async function readModel(store: GraphStore, registry?: RegistryProvider): Promise<GraphModel> {
  const e = exec(store, registry);
  const vmaps = await decodeAll(e.buffers('g.V().elementMap()', {}));
  const vertices: OracleVertex[] = vmaps.map((m: Map<unknown, unknown>) => {
    const entries = [...m].map(([k, v]) => [String(k), v] as const);
    const props: Record<string, unknown> = {};
    let id = -1, label = '';
    for (const [k, v] of entries) {
      if (k === 'T.id') id = v as number;
      else if (k === 'T.label') label = v as string;
      else props[k] = v;
    }
    return { id, label, props };
  });
  const emaps = await decodeAll(e.buffers(
    "g.E().project('label','from','to').by(label()).by(outV().id()).by(inV().id())", {}));
  const edges: OracleEdge[] = emaps.map((m: Map<unknown, unknown>) => {
    const o = Object.fromEntries([...m].map(([k, v]) => [String(k), v]));
    return { label: o.label as string, from: o.from as number, to: o.to as number };
  });
  return { vertices, edges };
}

/** Apply one `{ op: value }` operator object to a property value — the same vocabulary `args.ts` lowers to
 *  Gremlin predicates (`eq`/`neq`/`gt`/`lt`/`gte`/`lte`/`in`/`contains`/`startsWith`/`endsWith`), evaluated
 *  here in JS. A missing property fails every operator (a filter on an absent value matches nothing), which
 *  is Gremlin's `has(k, …)` behaviour too. */
function matchesOp(value: unknown, op: string, operand: unknown): boolean {
  if (value === undefined || value === null) return false;
  switch (op) {
    case 'eq': return value === operand;
    case 'neq': return value !== operand;
    case 'gt': return (value as any) > (operand as any);
    case 'lt': return (value as any) < (operand as any);
    case 'gte': return (value as any) >= (operand as any);
    case 'lte': return (value as any) <= (operand as any);
    case 'in': return Array.isArray(operand) && operand.includes(value);
    case 'contains': return String(value).includes(String(operand));
    case 'startsWith': return String(value).startsWith(String(operand));
    case 'endsWith': return String(value).endsWith(String(operand));
    default: throw new Error(`oracle: unknown filter operator '${op}'`);
  }
}

/** `where: { field: { op: value } }` as an AND over every field and every operator — the same implicit-AND
 *  the translator emits as a run of `has()` clauses. */
function passesWhere(v: OracleVertex, where: Record<string, Record<string, unknown>> | undefined): boolean {
  if (!where) return true;
  for (const [key, ops] of Object.entries(where)) {
    if (ops == null) continue;
    for (const [op, operand] of Object.entries(ops)) if (!matchesOp(v.props[key], op, operand)) return false;
  }
  return true;
}

/** `sort: [{ field: ASC|DESC }]` as a stable multi-key comparison — the tie-break order Gremlin's chained
 *  `order().by(k, dir)` gives. A single object is accepted for the one-key case, matching `args.ts`. */
function applySort(vs: OracleVertex[], sort: unknown): OracleVertex[] {
  if (!sort) return vs;
  const specs = (Array.isArray(sort) ? sort : [sort]) as Record<string, 'ASC' | 'DESC'>[];
  return [...vs].sort((a, b) => {
    for (const spec of specs) {
      for (const [key, dir] of Object.entries(spec)) {
        const av = a.props[key], bv = b.props[key];
        if (av === bv) continue;
        const cmp = (av as any) < (bv as any) ? -1 : 1;
        return dir === 'DESC' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

/** filter → sort → slice, the semantic order the translator emits (`args.ts`). */
function applyArgs(vs: OracleVertex[], args: Record<string, unknown>): OracleVertex[] {
  let out = vs.filter((v) => passesWhere(v, args.where as any));
  out = applySort(out, args.sort);
  const offset = typeof args.offset === 'number' ? args.offset : 0;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  return out.slice(offset, limit === undefined ? undefined : offset + limit);
}

/** The resolver value for a vertex — its property map plus its id/label carried through, so an edge
 *  resolver can navigate from it and a scalar field reads a property. graphql-js reads a scalar field off
 *  this object by the field name (which IS the property key), and an edge field's resolver receives it as
 *  the parent. */
type Node = Record<string, unknown> & { __id: number; __label: string };
const toNode = (v: OracleVertex): Node => ({ ...v.props, __id: v.id, __label: v.label });

/**
 * Build the graphql-js resolver set over the plain model. A ROOT resolver returns the label's vertices,
 * arg-processed; an EDGE resolver navigates the parent's edges by label + direction and returns the far
 * endpoints, arg-processed. `out` follows `from → to`; `in` follows `to → from` — the same edge triple
 * seen from each end (`schema.ts`'s in/out pair), so `created` and `created_in` both resolve from one
 * stored edge.
 */
export function oracleResolvers(model: GraphModel, schema: GraphSchema): Resolvers {
  const byId = new Map(model.vertices.map((v) => [v.id, v]));
  const verticesByLabel = new Map<string, OracleVertex[]>();
  for (const v of model.vertices) {
    let list = verticesByLabel.get(v.label);
    if (!list) { list = []; verticesByLabel.set(v.label, list); }
    list.push(v);
  }

  return {
    root: (typeName) => (_src, args) =>
      applyArgs(verticesByLabel.get(typeName) ?? [], args).map(toNode),
    edge: (typeName, fieldName) => {
      const edge = schema.types.get(typeName)?.edges.get(fieldName);
      if (!edge) throw new Error(`oracle: no edge field '${typeName}.${fieldName}'`);
      return (src, args) => {
        const parentId = (src as Node).__id;
        const neighbours: OracleVertex[] = [];
        for (const e of model.edges) {
          if (e.label !== edge.label) continue;
          const other = edge.direction === 'out' ? (e.from === parentId ? e.to : null) : (e.to === parentId ? e.from : null);
          if (other != null) { const v = byId.get(other); if (v) neighbours.push(v); }
        }
        return applyArgs(neighbours, args).map(toNode);
      };
    },
  };
}
