import type { GraphStore } from '../../../storage.ts';
import { q, value, list, raw, render, type Expression, type Query, type Relation } from '../../../sql/kernel/q.ts';
import { labelIn, labelNameFor, propHasFor, sqlElem, elemTable, type Elem, vertexLabelIn } from '../../plan/plan.ts';
import { gremlinTypeOf, mapEntryType, propertyValueBind, valueNodeFromStored, type CanonicalType, type TypeNode, type ValueNode } from '../../../gremlin/types.ts';
import { stepChain, isNested, isTokenArg, isCardinalityArg, isCardinalityValueArg, isDirectionArg, isMergeArg, type Step, type SackSpec } from '../../../gremlin/frontend.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { isStreamBarrier } from '../../ir/step.ts';
import { normalize } from '../../ir/passes.ts';
import { staticTypeOf, renderFrom, type Compiled, type WritePlan, type WriteResult, type Shape } from '../../../sql/kernel/render.ts';
import type { Engine } from '../../engine/deps.ts';
import type { ElementReadDriver } from '../../engine/deps.ts';
import { compileInject } from './inject.ts';
import { indexProperty, deleteFtsFor, deleteFtsForOwners } from '../../../services/fts-index.ts';
import { bindChunks, deleteWhereIn, placeholders } from '../../../rowbatch.ts';
import { layoutCols, type ElementStream, type TraverserLayout } from '../context/context.ts';
import { DEFAULT_VERTEX_CARDINALITY, DEFAULT_VERTEX_LABEL, LABEL_MUTATION_UNSUPPORTED, type VertexCardinality } from '../../../api.ts';
import { validateLabel, validatePropertyKey } from './validate.ts';

/** The driver row set a write consumes, IN EMISSION ORDER when the chain carries one.
 *
 *  A write assigns ids as it walks its drivers, and those ids are observable, so which row it sees
 *  first is part of the answer — the same argument `fold`/`aggregate`/`cap` make about member order.
 *  `analyzeChain` seeds the encounter for a write chain (WRITE_STEPS, ir/analyze.ts); this is the
 *  one place that READS it back, so every write host orders identically or not at all.
 *
 *  Absent an encounter the render is byte-identical to the bare `renderFrom` it replaced — an
 *  order-free chain pays nothing.  */
function renderDriverRows(st: { q: Query; rel: Relation; traverserLayout: TraverserLayout }, cols = 'id'): { sql: string; binds: any[] } {
  const enc = st.traverserLayout.encounter;
  return enc ? st.q.render(q`SELECT ${raw(cols)} FROM ${st.rel} ORDER BY ${st.rel.c[enc]}`) : renderFrom(st.q, st.rel, cols);
}

// ---------- nested-traversal write arguments (read spine reuse) ----------
//
// A write-step argument can be a nested traversal — property(k, __.trav), a merge
// match/option map, an addE endpoint. We do NOT hand-parse it: we compile it with the
// ordinary read compiler and read the raw column from the resulting (relation, shape)
// via extractNestedValue — the inverse of execute.ts's framing switch (no GraphBinary).
// A CORRELATED arg (its value depends on the current element) is seeded at the driver
// element by prepending a V(<rowid>)/E(<rowid>) source (numeric arg → rowid match), then
// compiled + run + extracted per driver row. See docs/archive/2026-07-16-write-args-through-read-spine.md.

// A nested `__.select(k)` where k is a withSideEffect(k, const) key resolves to the
// constant at compile time (correct-by-construction — the value never changes). Returns
// {has:false} for any other nested shape so the caller falls through to its own handling.
function constFromSelect(nested: any, sideEffects: Map<string, any> | undefined, params: Record<string, any>): { has: boolean; value: any } {
  if (!isNested(nested)) return { has: false, value: undefined };
  const inner = stepChain(nested.nested, params);
  if (inner.length === 1 && inner[0].name === 'select' && typeof inner[0].args[0] === 'string' && sideEffects?.has(inner[0].args[0]))
    return { has: true, value: sideEffects.get(inner[0].args[0]) };
  return { has: false, value: undefined };
}

// A nested value that is a compile-time INVARIANT — no seed / no read spine needed:
//   __.select(k) of a withSideEffect(k, const)  (via constFromSelect), or
//   __.constant(v)  (source-less; the vtype comes from the constant's own parsed argType,
//                    so UUID(..)/datetime(..) keep their type, not a JS-inferred string/int).
// This is what lets a global mergeV (no driver to seed a V/E source at) resolve a nested
// value, and what resolves a nested property KEY. {has:false} → fall through to a seeded read.
function constFromNested(nested: any, sideEffects: Map<string, any> | undefined, params: Record<string, any>): { has: boolean; value: any; vtype: CanonicalType | null } {
  const c = constFromSelect(nested, sideEffects, params);
  if (c.has) return { has: true, value: c.value, vtype: gremlinTypeOf(c.value, null) };
  if (isNested(nested)) {
    const inner = stepChain(nested.nested, params);
    if (inner.length === 1 && inner[0].name === 'constant')
      return { has: true, value: inner[0].args[0], vtype: gremlinTypeOf(inner[0].args[0], (inner[0] as Step).argTypes?.[0] ?? null) };
  }
  return { has: false, value: undefined, vtype: null };
}

// Compile a nested traversal (optionally seeded at a driver element) and run it against
// the store, returning its raw result rows + the compiled shape. Seeding prepends a
// V/E source on the driver's internal rowid so the child is anchored at that element.
function runNested(
  engine: Engine,
  store: GraphStore,
  nestedNode: any,
  params: Record<string, any>,
  seed?: { id: number; elem: Elem },
  driver?: ElementReadDriver,
): { rows: any[]; shape: Shape } {
  let chain: IRStep[] = normalize(stepChain(nestedNode, params)).steps;
  // Seed at the driver element: a synthetic V/E source on the internal rowid (numeric
  // arg → rowid match). It borrows the nested node's parse ctx (no ctx of its own).
  if (seed && driver) throw new Error('nested write read cannot have both a seed and a driver');
  if (seed) chain = [{ name: seed.elem === 'edge' ? 'E' : 'V', args: [seed.id], ctx: nestedNode } as IRStep, ...chain];
  const compiled = driver
    ? engine.compileReadFromElementDriver(chain, params, driver)
    : engine.compileReadCompiled(chain, params);
  return { rows: store.query<any>(compiled.sql, compiled.binds), shape: compiled.shape };
}

// A compile-time scalar ValueType → the stored CanonicalType vocab (they overlap except
// bool/date). null = infer from the JS value. The correspondence lives in gremlin/types.ts —
// this local copy used to omit bigdecimal/char/duration, so those wrote an inferred vtype.

// EVERY value a nested property()-value traversal produces, in emission order, or an empty
// array for an empty traversal (→ no property at all: TinkerPop's `results.isEmpty()` skips the
// mutation rather than writing a null). This used to return only the FIRST row, which is right
// under `single` and silently lossy under list/set — `property(list, "friends", __.out("knows").
// values("name"))` stored one friend where the reference stores both. What the LIST means is
// decided downstream by the cardinality (applyVertexProperty), exactly as in
// `AddPropertyStep.handleTraversalValue`.
//
// The stored vtype comes from the read spine's own type (count→long, a typed value→its `as`),
// else null → inferred from the value; it is one type for the whole result set because the shape
// is one compiled read. Fails closed on a non-scalar result shape.
function nestedScalar(
  engine: Engine,
  store: GraphStore,
  nestedNode: any,
  params: Record<string, any>,
  seed?: { id: number; elem: Elem },
  driver?: ElementReadDriver,
): { values: any[]; vtype: CanonicalType | null } {
  const { rows, shape } = runNested(engine, store, nestedNode, params, seed, driver);
  if (shape.kind !== 'value' && shape.kind !== 'scalar')
    throw new Error(`property() traversal value producing a ${shape.kind} not yet supported`);
  // A leading NULL row is TinkerPop's "no value" (an unproductive by()/values()), not a value to
  // store — the pre-multi-value code keyed the whole decision off rows[0], and that stays the rule.
  if (!rows.length || rows[0].v == null) return { values: [], vtype: null };
  // Only a STATIC type can be written as the literal's vtype; a per-row/unknown type is
  // not a compile-time fact, so the write channel records nothing and storage class rules.
  const staticAs = shape.kind === 'value' ? staticTypeOf(shape.type) : undefined;
  return { values: rows.map((r) => r.v), vtype: staticAs ? staticAs : null };
}

// The nested-value authority: a compile-time invariant (constFromNested), else a scalar
// read seeded at `seed` (the correlated element, or undefined = global/source-less). An
// empty nested traversal → has:false. vtype from the read shape, else inferred from the
// produced value (the honest fallback for an untyped channel). Reused by property values
// (resolveSpecValue), addV labels (insertVertex), and merge map values (resolveMergeSpec).
function nestedScalarValue(
  engine: Engine,
  store: GraphStore,
  nested: any,
  params: Record<string, any>,
  seed?: { id: number; elem: Elem },
  sideEffects?: Map<string, any>,
  driver?: ElementReadDriver,
): { has: boolean; value: any; values: any[]; vtype: CanonicalType | null } {
  const c = constFromNested(nested, sideEffects, params);
  if (c.has) return { ...c, values: [c.value] };
  const r = nestedScalar(engine, store, nested.nested, params, seed, driver);
  // `value` is the first of `values` — the single-valued view every OTHER caller (an addV label,
  // a merge map value) wants, kept here rather than re-derived at each of them.
  return { has: r.values.length > 0, value: r.values[0], values: r.values, vtype: r.vtype ?? (r.values.length ? gremlinTypeOf(r.values[0], null) : null) };
}

// Resolve a PropSpec's value for one target element: a literal passes through with its
// captured vtype; a nested traversal is evaluated correlated at the element.
function resolveSpecValue(engine: Engine, store: GraphStore, sp: PropSpec, id: number, elem: Elem, params: Record<string, any>, sideEffects?: Map<string, any>, driver?: ElementReadDriver): { has: boolean; value: any; values: any[]; vtype: CanonicalType | null; typeNode: TypeNode | null } {
  // A literal keeps its full typeNode (collection element/key fidelity); a nested traversal
  // resolves to a SCALAR (nested collection values are deferred), so its scalar vtype IS a
  // valid TypeNode (a bare CanonicalType), used directly as typeNode.
  // A literal is always exactly ONE value — including a literal `null`, which is the removal
  // rule and must stay distinguishable from a traversal that produced nothing.
  if (!isNested(sp.value)) return { has: true, value: sp.value, values: [sp.value], vtype: sp.vtype, typeNode: sp.typeNode };
  const r = nestedScalarValue(engine, store, sp.value, params, driver ? undefined : { id, elem }, sideEffects, driver);
  return { ...r, typeNode: r.vtype };
}

/** Resolve a property key through the same TraversalUtil.apply-style authority as a
 * property value.  Keys are per-target inputs too: evaluating them at write-plan build time
 * would lose correlation (and would be a second child evaluator). */
function resolveSpecKey(engine: Engine, store: GraphStore, sp: PropSpec, id: number, elem: Elem, params: Record<string, any>, sideEffects?: Map<string, any>, driver?: ElementReadDriver): string {
  if (!isNested(sp.key)) return sp.key;
  const r = nestedScalarValue(engine, store, sp.key, params, driver ? undefined : { id, elem }, sideEffects, driver);
  if (!r.has) throw new Error('property() key traversal produced no value');
  if (typeof r.value !== 'string') throw new Error(`property() key traversal must produce a string, got ${typeof r.value}`);
  return r.value;
}

// ---------- write compilers ----------
//
// Writes are an imperative interpreter (sequential INSERT/UPDATE/DELETE threading
// store state + as() aliases) — not a functional CTE fold — so these stay closure
// builders over the store. They reuse the read prefix (buildPrefix) to materialize
// target ids, then mutate. The WRITE_RULES table (bottom) routes a step chain to
// the right compiler; routing is predicate/position based (addE can be mid-chain,
// drop must be last), so it's an ordered rule list rather than a name→fn Map.

// drop() — remove the target elements. Vertices (g.V()…drop()) take their
// incident edges with them; edges (g.E()…drop(), g.V().outE()…drop()) delete
// only the matched edge rows.
function compileDrop(engine: Engine, steps: IRStep[], params: Record<string, any> = {}): WritePlan {
  // A PROPERTY prefix drops property ROWS, not elements — `g.V().properties().drop()` leaves both
  // vertices standing and removes their properties. It routes separately because the two differ in
  // every respect that matters: the prefix is a property stream (so it is compiled as a read, not
  // through buildPrefixFresh, which types its result as an element), and the delete has no cascade.
  if (steps.slice(0, -1).some((s) => s.name === 'properties')) return compilePropertyDrop(engine, steps, params);
  const { st, stop } = engine.buildPrefixFresh(steps.slice(0, -1));
  if (stop !== steps.length - 1) throw new Error(`drop() after ${steps[stop].name}() not yet supported`);
  const isEdge = st.elem === 'edge';
  const target = renderDriverRows(st);
  return {
    kind: 'write',
    run: (store) => {
      // Materialize the target ids ONCE, before mutating. For vertices, deleting
      // incident edges first would empty a re-evaluated target CTE (if it reads
      // the edges table), silently leaving vertices behind. Snapshot, then delete.
      const ids = store.query<{ id: number }>(target.sql, target.binds).map((r) => r.id);
      if (!ids.length) return [];
      // Every statement below goes through RowBatch, so no bind list is a function of the
      // target count. `ids.map(() => '?')` here was a hard failure on Cloudflare past 50
      // vertices (a DO caps a statement at 100 bound parameters) — the very idiom
      // src/rowbatch.ts exists to replace. See the plan doc §1d.
      if (isEdge) {
        deleteFtsForOwners(store, 'edge', ids);
        deleteWhereIn(store, 'edge_properties', 'edge', ids);
        deleteWhereIn(store, 'edges', 'id', ids);
      } else {
        // Drop the incident edges' properties first (they reference the soon-deleted
        // edges), then the edges, then this vertex's own properties, then the vertex.
        // FTS rows for both the incident edges and this vertex's own props go with them.
        //
        // The incident edge ids are materialized once and then deleted BY ID, rather than
        // re-deriving `src IN (…) OR tgt IN (…)` in three statements: it is the same set (the
        // snapshot discipline above already requires taking it before mutating), it is one
        // splice per statement instead of two, and it drops the incidence predicate from the
        // edge_properties delete's subquery.
        const incidentEdges: number[] = [];
        for (const chunk of bindChunks(ids, { bindsPerItem: 2 })) {
          const ph = placeholders(chunk.length);
          for (const r of store.query<{ id: number }>(`SELECT id FROM edges WHERE src IN (${ph}) OR tgt IN (${ph})`, [...chunk, ...chunk]))
            incidentEdges.push(r.id);
        }
        deleteFtsForOwners(store, 'edge', incidentEdges);
        deleteFtsForOwners(store, sqlElem('vertex'), ids);
        deleteWhereIn(store, 'edge_properties', 'edge', incidentEdges);
        deleteWhereIn(store, 'edges', 'id', incidentEdges);
        deleteWhereIn(store, 'vertex_properties', 'node', ids);
        // The per-element cardinality declarations go with the element — that is the whole point of
        // scoping them to (node, key) rather than to the key: a dropped vertex leaves no schema
        // behind for a later vertex to inherit.
        deleteWhereIn(store, 'vertex_property_cardinality', 'node', ids);
        // vertex_labels references nodes(id), so the label set goes before the vertex.
        deleteWhereIn(store, 'vertex_labels', 'node', ids);
        deleteWhereIn(store, 'nodes', 'id', ids);
      }
      return [];
    },
  };
}

/** `g.V().properties().drop()` / `g.E().properties("weight").drop()` — delete the PROPERTY rows a
 *  property stream names, and the FTS text each owns. The prefix compiles through the ordinary read
 *  spine, so every filter a property stream admits (`hasKey`, `hasValue`, a key argument, a slice)
 *  narrows the drop for free rather than each becoming a case here.
 *
 *  Which physical rows those are is decided by the OWNER element kind, taken from the element prefix
 *  ahead of `properties()` — not from the projected `vpid` being NULL, which is how an edge property
 *  happens to be framed (TinkerPop's edge `Property` has no id) and is a framing fact, not an
 *  identity one. A vertex property is one row addressed by its own rowid; an edge property is one
 *  row per (edge, key), so it is addressed by that pair.
 *
 *  Both deletes go through `bindChunks`, because the row set is a function of ROW COUNT and a DO
 *  caps a statement at 100 bound parameters (`mise run binds` is the gate). */
function compilePropertyDrop(engine: Engine, steps: IRStep[], params: Record<string, any>): WritePlan {
  const prefix = steps.slice(0, -1);
  const propsAt = prefix.findIndex((s) => s.name === 'properties');
  // A META-property stream (`properties().properties(k)`) is a key inside the owning property's
  // JSONB bag, not a row — a different delete, deliberately not guessed at here.
  if (prefix.slice(propsAt + 1).some((s) => s.name === 'properties'))
    throw new Error('drop() after properties().properties() (a meta-property) not yet supported');
  const { st, stop } = engine.buildPrefixFresh(prefix.slice(0, propsAt), params);
  if (stop !== propsAt) throw new Error(`drop() after ${prefix[stop].name}() not yet supported`);
  const elem = st.elem;
  const target = engine.compileReadCompiled(prefix, params);
  if (target.shape.kind !== 'property')
    throw new Error(`drop() after a ${target.shape.kind} stream not yet supported`);
  return {
    kind: 'write',
    run: (store) => {
      // Snapshot before mutating, exactly as the element drop does.
      const rows = store.query<{ vpid: number | null; owner: number; pk: string }>(target.sql, target.binds);
      if (!rows.length) return [];
      if (elem === 'edge') {
        // One row per (edge, key): the pair IS the identity, so delete by it. `fixedBinds: 0`,
        // two binds per item.
        for (const chunk of bindChunks(rows, { bindsPerItem: 2 })) {
          const pairs = chunk.flatMap((r) => [r.owner, r.pk]);
          for (const r of store.query<{ id: number }>(
            `SELECT id FROM edge_properties WHERE (edge, key) IN (VALUES ${chunk.map(() => '(?, ?)').join(', ')})`, pairs))
            deleteFtsFor(store, 'edge', r.id);
          store.query(`DELETE FROM edge_properties WHERE (edge, key) IN (VALUES ${chunk.map(() => '(?, ?)').join(', ')})`, pairs);
        }
      } else {
        const ids = rows.map((r) => r.vpid!).filter((id) => id != null);
        for (const id of ids) deleteFtsFor(store, sqlElem('vertex'), id);
        deleteWhereIn(store, 'vertex_properties', 'id', ids);
      }
      // drop() produces no traversers, property rows or elements alike.
      return [];
    },
  };
}

// g.V(x).<filters>.property(k, v)[.property(...)][.<read tail>] — set properties on the matched
// existing element(s), then optionally keep traversing from them.
function compileSetProperty(engine: Engine, steps: IRStep[], params: Record<string, any>, sideEffects?: Map<string, any>): WritePlan {
  const firstProp = steps.findIndex((s) => s.name === 'property');
  const prefix = steps.slice(0, firstProp);
  const { st, stop } = engine.buildPrefixFresh(prefix, params);
  if (stop !== prefix.length) throw new Error(`property() after ${steps[stop].name}() not yet supported`);
  const elem = st.elem;
  // property() is element-PRESERVING — it mutates and passes the same traverser on — so anything
  // after the run of property() steps is an ordinary read tail over the mutated elements, exactly
  // as it is after addLabel(). The run ends at the first non-property step.
  let afterProps = firstProp;
  while (afterProps < steps.length && steps[afterProps].name === 'property') afterProps++;
  const suffix = steps.slice(afterProps);
  if (suffix.some((s) => MUTATING_TAIL.has(s.name)))
    throw new Error(`write continuation after property() not yet supported: ${suffix.find((s) => MUTATING_TAIL.has(s.name))!.name}()`);
  const specs = parsePropertyTail(steps.slice(firstProp, afterProps), 'property()', sideEffects, params);
  if (elem === 'edge') for (const sp of specs) assertEdgePropertySpec(sp);
  const tail = elementTailContinuation(engine, st, suffix, params);
  // Edge props are normalized rows with no cardinality/meta (TinkerPop Property): UPSERT each into
  // edge_properties. Vertex props apply with their cardinality (+ meta) through the storage waist.
  const readCur = elem === 'edge'
    ? 'SELECT uid, src, tgt, (SELECT name FROM labels WHERE id=edges.label) AS label FROM edges WHERE id=?'
    : 'SELECT uid FROM nodes WHERE id=?';
  let touched: ElementReadDriver[] = [];
  return {
    kind: 'write',
    run: (store) => {
      touched = materializeElementDrivers(store, st);
      tail.assertDrivers(touched);
      return touched.map(({ id }) => {
        for (const sp of specs) {
          const r = resolveSpecValue(engine, store, sp, id, elem, params, sideEffects);
          if (!r.has) continue;
          const key = resolveSpecKey(engine, store, sp, id, elem, params, sideEffects);
          // An EDGE takes the FIRST result: `handleTraversalValue`'s multi-result branch computes
          // `effectiveCard` as null for a non-Vertex, so neither the single-throw nor the
          // per-result loop fires and it falls through to `results.get(0)`.
          if (elem === 'edge') insertEdgeProperty(store, id, key, r.value, r.vtype, r.typeNode);
          else applyVertexProperty(store, id, key, r.values, r.vtype, sp.meta, sp.cardinality, r.typeNode);
        }
        const cur = store.query<any>(readCur, [id])[0];
        return elem === 'edge'
          ? { edge: { id: cur.uid ?? id, label: cur.label, src: nodeExtId(store, cur.src), tgt: nodeExtId(store, cur.tgt), props: readEdgeProps(store, id) } }
          : { vertex: { id: cur.uid ?? id, labels: store.vertexLabels(id), props: readVertexProps(store, id) } };
      });
    },
    ...tail.plan(() => touched),
  };
}

// g.inject(...) is a scalar-stream READ (not a write) — it compiles through the
// shared value tail in projection.ts (compileInject). WRITE_RULES routes it here
// only because it has no V/E source; see the import at the top of this file.

/** What the STEP declared. `null` is a real state, not a missing one: it means the traversal
 *  named no cardinality, so the graph's default applies — and only the storage waist may resolve
 *  it, because collapsing `null` to `'single'` here is exactly the bug that made a repeated
 *  `property(k, v)` overwrite. */
type Cardinality = VertexCardinality | null;
// `vtype` names the OUTER stored shape (the value column's sibling type); `typeNode` is
// the FULL recursive type tree, threaded so a collection value tags each element/entry/key
// losslessly (valueNodeOf). A scalar's typeNode is redundant with vtype; a nested-traversal
// value has no literal typeNode (its type is resolved at run time as a scalar).
export interface PropSpec { key: string | { nested: any }; value: any; vtype: CanonicalType | null; typeNode: TypeNode | null; meta: Record<string, any> | null; cardinality: Cardinality; }
/** `labels` is a LIST because a vertex carries a set: `addV("a","b")` is two labels, and
 *  `addV()` with no argument is the single default 'vertex'. Under LabelCardinality.ONE a spec
 *  with more than one is rejected at insert time rather than silently truncated. */
interface VertexSpec { labels: (string | string[] | { nested: any })[]; props: PropSpec[]; uid: string | number | null; }

// A leading Cardinality token on property() args, else null (= the graph's default, applied at
// the storage waist). Returns it plus the remaining [key, value, ...metaArgs], and `off` — how
// many leading args were consumed (0 or 1) so the caller can index the parallel argTypes.
function readCardinality(args: any[]): { cardinality: Cardinality; rest: any[]; off: number } {
  if (isCardinalityArg(args[0]))
    return { cardinality: args[0].cardinality as Cardinality, rest: args.slice(1), off: 1 };
  return { cardinality: null, rest: args, off: 0 };
}

/** The canonical stored type of a property()'s VALUE arg: the type its carrying
 *  channel declared (Step.argTypes at the value's position), else inferred from the
 *  JS value. `off`+1 is the value's index in the original arg list (key is at off). */
const propVtype = (step: Step, val: any, off: number): CanonicalType | null =>
  gremlinTypeOf(val, step.argTypes?.[off + 1] ?? null);

/** The property()'s VALUE arg's full recursive TypeNode (Step.argTypes at the value's
 *  position) — carried alongside vtype so a collection value's elements/keys are tagged
 *  losslessly by valueNodeOf. null for an untyped channel (infer per element at storage). */
const propTypeNode = (step: Step, off: number): TypeNode | null => step.argTypes?.[off + 1] ?? null;

/** One `property()` step, parsed. The three hosts differ ONLY in what they do with a T token —
 *  addV consumes `T.id`/`T.label` into the vertex it is about to create, a mutation on an existing
 *  element refuses (ids and labels are immutable there, which is TinkerPop's own rule), and a merge
 *  tail refuses for the same reason — so the token is REPORTED here rather than decided here. This
 *  loop existed twice before the merge tail needed it a third time; the copies had already drifted
 *  (only one of them collapsed a `__.select(sideEffectConst)` VALUE). */
export type ParsedProperty =
  | { kind: 'prop'; spec: PropSpec }
  | { kind: 'token'; token: string; value: any; meta: boolean }
  /** `property(null, …)` — a null KEY adds nothing, which is TinkerPop's null case. (The map form
   *  never reaches here: `desugarPropertyMap` expanded it before lowering ever saw the chain.) */
  | { kind: 'none' };

export function parseProperty(s: Step, sideEffects: Map<string, any> | undefined, params: Record<string, any>): ParsedProperty {
  const { cardinality, rest, off } = readCardinality(s.args);
  let [key, val] = rest; const metaArgs = rest.slice(2);
  { const ck = constFromNested(key, sideEffects, params); if (ck.has) key = ck.value; }
  { const cv = constFromSelect(val, sideEffects, params); if (cv.has) val = cv.value; }
  if (key == null || (typeof key === 'object' && !isNested(key) && !isTokenArg(key))) return { kind: 'none' };
  if (isTokenArg(key)) return { kind: 'token', token: key.token, value: val, meta: metaArgs.length > 0 };
  return { kind: 'prop', spec: { key, value: val, vtype: propVtype(s, val, off), typeNode: propTypeNode(s, off), meta: metaOf(metaArgs), cardinality } };
}

/** What an EDGE property may not carry. TinkerPop's edge `Property` has neither a cardinality nor
 *  meta-properties (it is single-valued by spec — the `UNIQUE(edge,key)` constraint is the same
 *  rule at the schema level), so both are refusals wherever an edge property is written. */
function assertEdgePropertySpec(sp: PropSpec): void {
  if (sp.cardinality !== null) throw new Error('Cardinality is not valid on an edge property');
  if (sp.meta) throw new Error('meta-properties are not valid on an edge property');
}

/** Apply a parsed `property()` tail to ONE element the enclosing step just emitted. Both merge
 *  compilers reach the SAME storage waists through this, so a meta-property or a declared
 *  cardinality in a merge tail behaves exactly as it does after `g.V(…)` — neither merge lowering
 *  learns that either exists. Values resolve per element (`resolveSpecValue`), so a correlated
 *  `property(k, __.trav)` in the tail is seeded at the merged element, not at the driver. */
function applyPropertyTail(engine: Engine, store: GraphStore, specs: readonly PropSpec[], id: number, elem: Elem, params: Record<string, any>, sideEffects?: Map<string, any>): void {
  for (const sp of specs) {
    const r = resolveSpecValue(engine, store, sp, id, elem, params, sideEffects);
    if (!r.has) continue;
    const key = resolveSpecKey(engine, store, sp, id, elem, params, sideEffects);
    if (elem === 'edge') insertEdgeProperty(store, id, key, r.value, r.vtype, r.typeNode);
    else applyVertexProperty(store, id, key, r.values, r.vtype, sp.meta, sp.cardinality, r.typeNode);
  }
}

/** A run of `property()` steps → their specs, for a host on an element that ALREADY EXISTS (a
 *  mutation tail, a merge tail). A T token is immutable on such an element, so it is the refusal. */
function parsePropertyTail(steps: readonly Step[], what: string, sideEffects: Map<string, any> | undefined, params: Record<string, any>): PropSpec[] {
  const specs: PropSpec[] = [];
  for (const s of steps) {
    if (s.name !== 'property') throw new Error(`step not implemented after ${what}: ${s.name}()`);
    const p = parseProperty(s, sideEffects, params);
    if (p.kind === 'token') throw new Error(`property(T.${p.token}) on an existing element not yet supported`);
    if (p.kind === 'prop') specs.push(p.spec);
  }
  return specs;
}

// Trailing property() args after (key, value) are meta-property key/value pairs
// (VertexProperty meta-properties). A meta value must be a scalar (no traversal / no
// meta-of-meta).
function metaOf(metaArgs: any[]): Record<string, any> | null {
  if (!metaArgs.length) return null;
  if (metaArgs.length % 2 !== 0) throw new Error('property() meta-properties must be key/value pairs');
  const m: Record<string, any> = {};
  for (let i = 0; i < metaArgs.length; i += 2) {
    const mk = metaArgs[i];
    if (typeof mk !== 'string') throw new Error('property() meta-property key must be a string');
    const mv = metaArgs[i + 1];
    if (isNested(mv)) throw new Error('property() meta-property value must be a scalar');
    m[mk] = mv;
  }
  return m;
}

// A single-cardinality prop bag (a merge map) → PropSpecs. The vtype comes from the
// captured propTypes (the map's TypeNode: a literal subtype or a typed client's wire
// DataType; a nested value's read-shape type), falling back to JS inference where the
// channel said nothing (a JS client that dropped the type / an untyped bound map).
const singleProps = (rec: Record<string, any>, types: Record<string, TypeNode | null> = {}, cardinalities: Record<string, Cardinality> = {}): PropSpec[] =>
  Object.entries(rec).map(([key, value]) => ({
    key, value, typeNode: types[key] ?? null,
    vtype: gremlinTypeOf(value, types[key] ?? null), meta: null, cardinality: cardinalities[key] ?? null,
  }));

// An addV(...) step + its trailing property() steps → a vertex spec. A property key or
// value that is __.select(k) of a withSideEffect constant resolves at parse time.
/** `addV(…)` plus its followers. An `addLabel(…)` follower on a JUST-CREATED vertex is simply more
 *  labels — `addV("person").addLabel("employee")` is the same vertex as `addV("person","employee")`
 *  — so it folds into the spec here rather than routing to the mutation compiler, whose prefix
 *  would be the addV itself and therefore not a readable element stream. */
function parseVertexSpec(addV: Step, propSteps: Step[], sideEffects?: Map<string, any>, params: Record<string, any> = {}): VertexSpec {
  // A nested-traversal label (addV(__.…)) stays UNRESOLVED here (it needs the store) —
  // insertVertex evaluates it at run time. A __.select(sideEffectConst) collapses now.
  // addV() takes N labels. Each stays UNRESOLVED if it is a traversal (insertVertex evaluates
  // it against the store); a __.select(sideEffectConst) collapses now. No argument at all is
  // the single default label 'vertex'.
  // A resolved constant keeps its SHAPE: `addV(constant(["a","b"]))` is two labels, and
  // String()-ing it here turned them into the single label "a,b".
  const asLabel = (a: any): string | string[] | { nested: any } =>
    typeof a === 'string' ? a
    : isNested(a) ? ((c) => c.has ? (Array.isArray(c.value) ? c.value.map(String) : String(c.value)) : a)(constFromNested(a, sideEffects, params))
    : String(a);
  // No argument means "whatever this graph's default is", which is NOT always 'vertex': under
  // LabelCardinality.ZERO_OR_MORE a bare addV() creates a vertex with NO labels (`g_addV_labels`
  // asserts labels() has a count of 0). insertVertex applies the default, because only it can see
  // the declared cardinality. An empty list here therefore means "unspecified", not "none".
  let labels: (string | string[] | { nested: any })[] = addV.args.map(asLabel);
  const props: PropSpec[] = [];
  let uid: string | number | null = null;
  for (const s of propSteps) {
    if (s.name === 'addLabel') { labels.push(...s.args.map(asLabel)); continue; }
    const p = parseProperty(s, sideEffects, params);
    // A T token on a vertex being CREATED is not immutable — it IS the id/label being supplied.
    if (p.kind === 'token') {
      if (p.meta) throw new Error(`property(T.${p.token}) does not take meta-properties`);
      if (p.token === 'id') uid = p.value;
      else if (p.token === 'label') labels = [String(p.value)];
      else throw new Error(`property(T.${p.token}) not supported`);
      continue;
    }
    if (p.kind === 'prop') props.push(p.spec);
  }
  return { labels, props, uid };
}

// INSERT one row into nodes/edges with the shared optional-uid/id column splice.
// A string uid writes the `uid` column; a numeric uid writes the rowid `id`
// directly. Returns the rowid + external id (uid ?? rowid).
type ElementTable = 'nodes' | 'edges';

/** Validate a caller-provided public element id before the shared INSERT boundary.
 * SQLite's rowid/UNIQUE errors are storage-engine implementation details; Gremlin's
 * observable contract is an element identity conflict. Keeping this next to the one
 * writer covers addV, addE, and merge-create uniformly (numeric ids occupy rowid,
 * string ids the uid namespace; vertex and edge namespaces remain distinct). */
function assertAvailableElementId(store: GraphStore, table: ElementTable, uid: string | number | null): void {
  if (uid == null) return;
  const col = typeof uid === 'number' ? 'id' : 'uid';
  if (store.query<{ found: number }>(`SELECT 1 AS found FROM ${table} WHERE ${col}=? LIMIT 1`, [uid]).length)
    throw new Error(`${table === 'nodes' ? 'vertex' : 'edge'} id already exists: ${uid}`);
}

function insertRow(store: GraphStore, table: ElementTable, baseCols: string[], baseVals: any[], uid: string | number | null, jsonbCol?: string): { id: number; extId: string | number } {
  assertAvailableElementId(store, table, uid);
  const uidCol = typeof uid === 'string' ? uid : null;
  const idCol = typeof uid === 'number' ? uid : null;
  const cols = [...baseCols, ...(uidCol !== null ? ['uid'] : []), ...(idCol !== null ? ['id'] : [])];
  const vals = [...baseVals, ...(uidCol !== null ? [uidCol] : []), ...(idCol !== null ? [idCol] : [])];
  // A JSONB column binds its JSON *text* and wraps jsonb(?) so SQLite builds the blob
  // (both runtimes accept a string bind; a raw Buffer bind would diverge — see storage.ts).
  const ph = (c: string) => c === jsonbCol ? 'jsonb(?)' : '?';
  // A vertex with no user-supplied id now has NOTHING to insert — its label moved to
  // vertex_labels — and `INSERT INTO nodes() VALUES()` is a syntax error. DEFAULT VALUES is
  // the spelling for "one row, all defaults", and the rowid is what we actually want back.
  const body = cols.length
    ? `(${cols.join(', ')}) VALUES(${cols.map(ph).join(', ')})`
    : 'DEFAULT VALUES';
  const row = store.query<{ id: number; uid: string | null }>(
    `INSERT INTO ${table} ${body} RETURNING id, uid`, vals)[0];
  return { id: row.id, extId: row.uid ?? row.id };
}

/** Remove EVERY property row under one key, and the FTS text each row owns. Both the
 *  `single`-cardinality replace (drop the key, then insert one) and the null-value rule
 *  below are exactly this delete, which is why they share it rather than spelling the two
 *  statements twice per element kind. */
function removeProperties(store: GraphStore, elem: Elem, owner: number, key: string): void {
  const table = elem === 'edge' ? 'edge_properties' : 'vertex_properties';
  const ownerCol = elem === 'edge' ? 'edge' : 'node';
  for (const r of store.query<{ id: number }>(`SELECT id FROM ${table} WHERE ${ownerCol}=? AND key=?`, [owner, key]))
    deleteFtsFor(store, sqlElem(elem), r.id);
  store.query(`DELETE FROM ${table} WHERE ${ownerCol}=? AND key=?`, [owner, key]);
}

/** TinkerPop's null-VALUE rule, the value-side twin of validate.ts's key rules: on a graph that
 *  does not declare `supportsNullPropertyValues` — ours does not — `property(k, null)` REMOVES
 *  every property under `k` instead of storing a null. `ElementHelper.attachProperties` is the
 *  authority and it spells it three times identically, once per overload
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/util/ElementHelper.java:326,352,378`):
 *  `!allowNullPropertyValues && null == value` → `element.properties(key).forEachRemaining(Property::remove)`.
 *  Note it removes regardless of the declared cardinality, and regardless of whether the element
 *  was just created — so this belongs at the storage waist, where every host (vertex/edge
 *  `property()`, addV/addE creation, a merge option map) reaches it and cannot answer differently.
 *  The corpus's `@AllowNullPropertyValues` scenarios describe the OTHER provider choice; the
 *  vendored runner skips them (test/L3-conformance/tags.ts), so they are not in L3's denominator. */
const isPropertyRemoval = (val: any): boolean => val === null;

/** The ONE place "the step declared no cardinality" becomes a cardinality — TinkerPop resolves it
 *  at the same point (`AddPropertyStep.applyPropertyMutation` and `MergeVertexStep` both consult
 *  `features().vertex().getCardinality(key)` only when their own is null).
 *
 *  We answer from `vertex_property_cardinality` rather than with a constant, because the corpus
 *  needs a schema-bearing provider — the DDL comment in storage.ts names the two scenarios that pin
 *  it in opposite directions, and why the scope is (node, key). An EXPLICIT cardinality both wins
 *  and RECORDS, which is what makes `property(single, "age", 50)` change how a later undeclared
 *  `property("age", …)` on that vertex behaves; an undeclared write only reads.
 *
 *  Fixed 2–3 binds either way, so the DO 100-parameter wall is out of reach by construction. */
function effectiveCardinality(store: GraphStore, node: number, key: string, declared: Cardinality): VertexCardinality {
  if (declared !== null) {
    store.query(
      `INSERT INTO vertex_property_cardinality(node, key, cardinality) VALUES(?, ?, ?)
       ON CONFLICT(node, key) DO UPDATE SET cardinality=excluded.cardinality`, [node, key, declared]);
    return declared;
  }
  return store.query<{ cardinality: VertexCardinality }>(
    'SELECT cardinality FROM vertex_property_cardinality WHERE node=? AND key=?', [node, key],
  )[0]?.cardinality ?? DEFAULT_VERTEX_CARDINALITY;
}

/** Write ONE key's values onto a vertex — the storage waist every host reaches. `values` is a
 *  LIST because a traversal-valued `property()` may produce several and the cardinality decides
 *  what that means, which is the whole of `AddPropertyStep.handleTraversalValue`: under list/set
 *  each result becomes its own VertexProperty; under `single` more than one is an error, not a
 *  last-one-wins. A literal is always exactly one value (possibly `null`, the removal rule); an
 *  empty list never reaches here — an unproductive traversal skips the mutation upstream. */
export function applyVertexProperty(
  store: GraphStore, node: number, key: string, values: readonly any[], vtype: CanonicalType | null,
  meta: Record<string, any> | null, declared: Cardinality, typeNode: TypeNode | null = null,
): void {
  validatePropertyKey(key); // the waist: every vertex property key reaches storage through here
  if (values.length === 1 && isPropertyRemoval(values[0])) return removeProperties(store, 'vertex', node, key);
  const cardinality = effectiveCardinality(store, node, key, declared);
  // Wording is TinkerPop's (`AddPropertyStep.handleTraversalValue`) — the corpus matches on it.
  if (values.length > 1 && cardinality === 'single')
    throw new Error(`Single-cardinality property requires exactly one value, but traversal produced ${values.length} results`);
  for (const val of values) writeVertexPropertyValue(store, node, key, val, vtype, meta, cardinality, typeNode);
}

// Set/append ONE vertex property VALUE (W4). single = replace all rows for the key then insert
// one; list = append; set = append unless an equal value already exists (then patch its
// meta). Meta is a {metaKey:scalar} object stored as a JSONB blob. A single SQL statement
// each (locked #3). A traversal-valued property defers to a later stage.
function writeVertexPropertyValue(
  store: GraphStore, node: number, key: string, val: any, vtype: CanonicalType | null,
  meta: Record<string, any> | null, cardinality: VertexCardinality, typeNode: TypeNode | null,
): void {
  if (isNested(val)) throw new Error('property() with a traversal value not yet supported');
  const metaJson = meta ? JSON.stringify(meta) : null;
  // A collection value (list/map/set) is stored as a self-describing typed-JSON tree in the
  // value column (bind the JSON text, wrap jsonb(?)) — a raw JS array/Map bind would throw at
  // the SQLite seam. A scalar binds through storedScalar so it keeps its storage class /
  // exact-tail TEXT (numeric order/range intact).
  // The value channel is propertyValueBind's (gremlin/types.ts) — shared with the bulk loader, so
  // the two paths cannot encode the same value two different ways.
  const { stored: storedVal, collection } = propertyValueBind(val, vtype, typeNode);
  const valPh = collection ? 'jsonb(?)' : '?';
  // single = replace all rows for the key: drop their FTS rows too, then the rows.
  if (cardinality === 'single') removeProperties(store, 'vertex', node, key);
  if (cardinality === 'set') {
    const existing = store.query<{ id: number }>(`SELECT id FROM vertex_properties WHERE node=? AND key=? AND value=${valPh}`, [node, key, storedVal]);
    if (existing.length) {
      // An equal value already exists: only meta may change (the FTS text is unchanged).
      if (metaJson !== null) store.query('UPDATE vertex_properties SET meta=jsonb(?) WHERE id=?', [metaJson, existing[0].id]);
      return;
    }
  }
  const { id } = store.query<{ id: number }>(
    `INSERT INTO vertex_properties(node, key, value, vtype, meta) VALUES(?, ?, ${valPh}, ?, ${metaJson === null ? 'NULL' : 'jsonb(?)'}) RETURNING id`,
    metaJson === null ? [node, key, storedVal, vtype] : [node, key, storedVal, vtype, metaJson],
  )[0];
  indexProperty(store, sqlElem('vertex'), id, node, key, val, typeNode);
}

// Set ONE edge property (single cardinality — edge Property has no meta/multi). One
// row per (edge,key): UPSERT on the UNIQUE(edge,key) constraint. Collections serialize
// to JSONB like vertex properties; scalars bind raw (storage class preserved).
export function insertEdgeProperty(store: GraphStore, edge: number, key: string, val: any, vtype: CanonicalType | null, typeNode: TypeNode | null = null): void {
  if (isNested(val)) throw new Error('property() with a traversal value not yet supported');
  validatePropertyKey(key); // the waist, edge side (see applyVertexProperty)
  if (isPropertyRemoval(val)) return removeProperties(store, 'edge', edge, key);
  const { stored: storedVal, collection } = propertyValueBind(val, vtype, typeNode);
  const valPh = collection ? 'jsonb(?)' : '?';
  // Was there already a row for (edge,key)? The UNIQUE(edge,key) index serves this cheaply.
  // We ONLY delete stale FTS rows on a genuine overwrite — an FTS5 delete-by-UNINDEXED-column
  // is an O(n) content scan (no index on UNINDEXED cols), so doing it on every fresh insert
  // makes a bulk write O(n²). A first insert has nothing to delete, so it skips the scan.
  const prior = store.query<{ id: number }>('SELECT id FROM edge_properties WHERE edge=? AND key=?', [edge, key]);
  // UPSERT on UNIQUE(edge,key): one row per (edge,key), so id is stable across an overwrite.
  const { id } = store.query<{ id: number }>(
    `INSERT INTO edge_properties(edge, key, value, vtype) VALUES(?, ?, ${valPh}, ?)
     ON CONFLICT(edge, key) DO UPDATE SET value=excluded.value, vtype=excluded.vtype RETURNING id`,
    [edge, key, storedVal, vtype],
  )[0];
  if (prior.length) deleteFtsFor(store, 'edge', id); // overwrite: drop the stale FTS text first
  indexProperty(store, 'edge', id, edge, key, val, typeNode);
}

// Read an edge's properties back as a flat {key:value} bag for a write response
// (single-valued per key), from the normalized edge_properties table.
function readEdgeProps(store: GraphStore, edge: number): Record<string, ValueNode> {
  const out: Record<string, ValueNode> = {};
  for (const r of store.query<{ key: string; value: any; vtype: string | null }>(
    "SELECT key, CASE WHEN vtype IN ('list','map','set') THEN json(value) ELSE value END AS value, vtype FROM edge_properties WHERE edge=? ORDER BY id", [edge]))
    out[r.key] = valueNodeFromStored(r.value, r.vtype);
  return out;
}

// Read a vertex's properties back as a flat {key:value} bag (first value under a key)
// for a write response. Multi-valued keys collapse to the first here — the write
// response shape is flat; full multi framing is on the read path.
function readVertexProps(store: GraphStore, node: number): Record<string, ValueNode[]> {
  const out: Record<string, ValueNode[]> = {};
  // EVERY value under a key, not the first: a vertex property is multi-valued (the graph's default
  // cardinality is `list`), and keeping only the first made a write RESPONSE disagree with a READ of
  // the same vertex — `g.addV("a").property("name","x").property("name","y")` returned one name and
  // `g.V()` returned two.
  // A collection value is a JSONB blob — return json() TEXT so valueNodeFromStored can JSON.parse it
  // to its {t,v} item tree (a raw blob would frame as a byte Map).
  for (const r of store.query<{ key: string; value: any; vtype: string | null }>(
    "SELECT key, CASE WHEN vtype IN ('list','map','set') THEN json(value) ELSE value END AS value, vtype FROM vertex_properties WHERE node=? ORDER BY id", [node]))
    (out[r.key] ??= []).push(valueNodeFromStored(r.value, r.vtype));
  return out;
}

// Insert a vertex from a spec; returns its rowid, external id (uid ?? rowid) and the
// resolved label (for response framing). A nested-traversal label is evaluated first
// (unseeded — it's a standalone read producing the label string). Each property VALUE
// routes through resolveSpecValue — the single value-resolution authority — so a nested
// value (__.constant/__.values/__.out().count()) is evaluated correlated at the NEW
// vertex (fresh + edge-less → __.out().count() = 0, per TinkerPop). An empty nested
// value writes no property (r.has=false).
function insertVertex(
  engine: Engine,
  store: GraphStore,
  spec: VertexSpec,
  params: Record<string, any> = {},
  sideEffects?: Map<string, any>,
  driver?: ElementReadDriver,
): { id: number; extId: string | number; labels: string[] } {
  // Unseeded: an addV label traversal is a standalone read / invariant (a source addV has no
  // incoming element). Routes through the same value authority so __.constant(x) and
  // __.select(const) labels resolve, not just seeded reads.
  const sole = spec.labels.length === 1;
  const resolved = spec.labels.flatMap((l) => {
    if (!isNested(l)) return labelNames(l, sole, 'addV');
    const r = nestedScalarValue(engine, store, l, params, undefined, sideEffects, driver);
    if (!r.has) throw new Error('addV(traversal) label produced no value');
    return labelNames(r.value, sole, 'addV');
  });
  // A SET, so duplicates collapse before the count is checked — addV('a','a') is one label.
  // An UNSPECIFIED label list (bare addV()) takes the graph's default: 'vertex' when the
  // cardinality requires at least one label, nothing at all when it permits zero.
  const labels = resolved.length || engine.labelCardinality.min === 0
    ? [...new Set(resolved)]
    : [DEFAULT_VERTEX_LABEL];
  assertLabelCount(engine, labels.length, 'addV');
  const row = insertRow(store, 'nodes', [], [], spec.uid);
  store.addVertexLabels(row.id, labels);
  // Read the labels BACK rather than reusing `labels`: the response must agree with what a
  // later read frames, and the reader orders by label id, not by argument order.
  for (const p of spec.props) {
    const r = resolveSpecValue(engine, store, p, row.id, 'vertex', params, sideEffects, driver);
    if (r.has) applyVertexProperty(store, row.id, resolveSpecKey(engine, store, p, row.id, 'vertex', params, sideEffects, driver), r.values, r.vtype, p.meta, p.cardinality, r.typeNode);
  }
  return { ...row, labels: store.vertexLabels(row.id) };
}

// g.addV('label').property(k, v)... — and multi-element chains (a graph initializer).
/** Materialize an element prefix as read drivers for a following imperative write. The driver
 * carries the layout's actual column values, so a nested write argument re-enters normal read
 * lowering with the same current object and aliases the prefix produced. */
function materializeElementDrivers(store: GraphStore, st: ElementStream): ElementReadDriver[] {
  const cols = layoutCols(st.traverserLayout);
  const read = renderDriverRows(st, ['id', ...cols].join(', '));
  return store.query<Record<string, unknown>>(read.sql, read.binds).map((row) => ({
    id: Number(row.id),
    elem: st.elem,
    traverserLayout: st.traverserLayout,
    carried: Object.fromEntries(cols.map((col) => [col, row[col]])),
  }));
}

/** A read TAIL after an element-preserving write — the steps that mutate an element and pass the
 *  SAME traverser on: `addLabel`/`dropLabel(s)` and `property()`. There is no new element to re-root
 *  on (unlike mid-traversal addV), so the tail is simply the suffix re-read per driver AFTER the
 *  mutation, through the ordinary read compiler.
 *
 *  It exists as one helper because the two hosts had no way to share it otherwise: `addLabel` grew
 *  the whole pattern and `property()` answered "step not implemented after property()" for every
 *  read tail, which is the "the seam cannot be HANDED this" tell in `steps/CLAUDE.md` — the
 *  substrate was there, the second site could not reach it.
 *
 *  `plan()` takes a THUNK for the drivers because they do not exist until `run` has executed; the
 *  probe compile that fixes the continuation's SHAPE happens now, against a zero-id driver carrying
 *  the same layout, so an unsupported tail still fails at compile time rather than mid-write.
 *
 *  **A GLOBAL barrier in the tail is refused once there is more than ONE driver, and that is a FIX,
 *  not a restriction.** The tail runs the suffix per driver and concatenates, which is only the right
 *  answer while every step is per-traverser. It was not checked, so
 *  `g.V().hasLabel("person").addLabel("emp").count()` answered `[1,1,1,1]` instead of `[4]`,
 *  `.fold()` gave one list per driver and `.limit(2)` gave four rows — silent wrong answers that had
 *  nothing to do with labels and everything to do with this shape.
 *
 *  The guard is on the DRIVER COUNT rather than on the step, because with exactly one driver
 *  per-driver IS global and the answer is right — which is not a technicality: every corpus scenario
 *  that reaches this shape (`g.V().addLabel("a","b").labels().count()` and nine siblings) builds a
 *  one-vertex graph, so a blanket refusal would have turned ten correct answers into errors to
 *  prevent an eleventh wrong one. A cross-driver barrier needs the drivers in ONE relation, which is
 *  the mid-chain-write question (write-path plan §4); until then this fails closed rather than
 *  approximating. It fires BEFORE any mutation — the drivers are materialized first — so a refused
 *  traversal leaves the graph untouched rather than half-written.
 *
 *  `isStreamBarrier` is the existing authority and already exempts `Scope.local`, which slices a
 *  VALUE's members rather than the stream's rows. */
function elementTailContinuation(engine: Engine, st: ElementStream, suffix: IRStep[], params: Record<string, any>) {
  const barrier = suffix.find(isStreamBarrier);
  const carried = Object.fromEntries(layoutCols(st.traverserLayout).map((col) => [col, null]));
  const probeDriver: ElementReadDriver = { id: 0, elem: st.elem, traverserLayout: st.traverserLayout, carried };
  const probe = suffix.length ? engine.compileReadFromElementDriver(suffix, params, probeDriver) : null;
  return {
    /** Call after materializing the drivers and BEFORE mutating. */
    assertDrivers: (drivers: readonly ElementReadDriver[]) => {
      if (barrier && drivers.length > 1)
        throw new Error(`${barrier.name}() after a write is not yet supported over more than one element: the continuation reads once per element, so it cannot observe the whole stream`);
    },
    plan: (drivers: () => readonly ElementReadDriver[]) => probe ? {
      continuation: {
        shape: probe.shape,
        run: (store: GraphStore) => drivers().flatMap((driver) => {
          const read = engine.compileReadFromElementDriver(suffix, params, driver);
          return store.query(read.sql, read.binds);
        }),
      },
    } : {},
  };
}

/** Mid-traversal addV is a write fan-out over a materialized element prefix. Its parameters use
 * the original traverser as their apply-contract input; the new vertex becomes the continuation's
 * current object while the original carried layout stays live. */
function compileMidAddV(engine: Engine, steps: IRStep[], addVAt: number, params: Record<string, any>, sideEffects?: Map<string, any>): WritePlan {
  const prefix = steps.slice(0, addVAt);
  const { st, stop } = engine.buildPrefixFresh(prefix, params);
  if (stop !== prefix.length) throw new Error(`addV() after ${prefix[stop].name}() not yet supported`);
  // A new vertex is a new path position. Until the write driver can append that position to the
  // carried path encoding, preserving the old path would be a wrong answer.
  if (st.traverserLayout.path) throw new Error('mid-traversal addV() under path() is not yet supported (write driver cannot append the new vertex path position)');

  let firstTail = addVAt + 1;
  while (firstTail < steps.length && ADDV_FOLLOWERS.has(steps[firstTail].name)) firstTail++;
  const spec = parseVertexSpec(steps[addVAt], steps.slice(addVAt + 1, firstTail), sideEffects, params);
  const suffix = steps.slice(firstTail);
  const writeSteps = new Set(['addV', 'addE', 'mergeV', 'mergeE', 'property', 'drop']);
  if (suffix.some((s) => writeSteps.has(s.name)))
    throw new Error(`write continuation after mid-traversal addV() not yet supported: ${suffix.find((s) => writeSteps.has(s.name))!.name}()`);

  const carried = Object.fromEntries(layoutCols(st.traverserLayout).map((col) => [col, null]));
  const probeDriver: ElementReadDriver = { id: 0, elem: 'vertex', traverserLayout: st.traverserLayout, carried };
  const probe = suffix.length ? engine.compileReadFromElementDriver(suffix, params, probeDriver) : null;
  let created: ElementReadDriver[] = [];
  return {
    kind: 'write',
    run: (store) => {
      created = materializeElementDrivers(store, st).map((driver) => {
        const v = insertVertex(engine, store, spec, params, sideEffects, driver);
        return { ...driver, id: v.id, elem: 'vertex' as const };
      });
      return created.map((driver) => {
        const row = store.query<any>('SELECT uid FROM nodes WHERE id=?', [driver.id])[0];
        return { vertex: { id: row.uid ?? driver.id, labels: store.vertexLabels(driver.id), props: readVertexProps(store, driver.id) } };
      });
    },
    ...(probe ? {
      continuation: {
        shape: probe.shape,
        run: (store: GraphStore) => created.flatMap((driver) => {
          const read = engine.compileReadFromElementDriver(suffix, params, driver);
          return store.query(read.sql, read.binds);
        }),
      },
    } : {}),
  };
}

function compileAddV(engine: Engine, steps: IRStep[], params: Record<string, any> = {}, sideEffects?: Map<string, any>): WritePlan {
  const addVAt = steps.findIndex((s) => s.name === 'addV');
  if (addVAt > 0) return compileMidAddV(engine, steps, addVAt, params, sideEffects);
  let firstFollower = 1;
  while (firstFollower < steps.length && ADDV_FOLLOWERS.has(steps[firstFollower].name)) firstFollower++;
  // A source addV has produced a real vertex before its follower runs. Preserve that
  // mutation boundary, then hand the remaining read chain back to the normal compiler using
  // the inserted internal rowid as its source. This is the generic write→read substrate;
  // label()/values()/path()/… therefore share SQL lowering and wire framing with g.V(...).
  const writeFollower = new Set(['addV', 'addE', 'mergeV', 'mergeE', 'property', 'drop']);
  if (firstFollower < steps.length && !steps.slice(firstFollower).some((s) => writeFollower.has(s.name))) {
    const suffix = steps.slice(firstFollower);
    const source = (id: number): IRStep => ({ name: 'V', args: [id], ctx: steps[0].ctx });
    const probe = engine.compileReadCompiled([source(0), ...suffix], params);
    let created: number | undefined;
    const spec = parseVertexSpec(steps[0], steps.slice(1, firstFollower), sideEffects, params);
    return {
      kind: 'write',
      run: (store) => {
        const v = insertVertex(engine, store, spec, params, sideEffects);
        created = v.id;
        return [{ vertex: { id: v.extId, labels: v.labels, props: readVertexProps(store, v.id) } }];
      },
      continuation: {
        shape: probe.shape,
        run: (store) => {
          const id = created;
          if (id === undefined) throw new Error('write continuation ran before addV()');
          const read = engine.compileReadCompiled([source(id), ...suffix], params);
          return store.query(read.sql, read.binds);
        },
      },
    };
  }
  if (steps.some((s, i) => i > 0 && s.name !== 'property'))
    return { kind: 'write', run: (store) => runWriteChainFull(engine, store, steps, params, sideEffects) };
  const spec = parseVertexSpec(steps[0], steps.slice(1), sideEffects, params);
  return { kind: 'write', run: (store) => { const v = insertVertex(engine, store, spec, params, sideEffects); return [{ vertex: { id: v.extId, labels: v.labels, props: readVertexProps(store, v.id) } }]; } };
}

interface EdgeCluster { label: string; fromSpec: any; toSpec: any; edgeUid: string | number | null; props: PropSpec[]; next: number; }
function parseEdgeCluster(steps: Step[], addEIdx: number): EdgeCluster {
  const label = steps[addEIdx].args[0];
  if (typeof label !== 'string') throw new Error('addE(label): nested-traversal label not supported');
  let fromSpec: any, toSpec: any, edgeUid: string | number | null = null;
  const props: PropSpec[] = [];
  let i = addEIdx + 1;
  for (; i < steps.length && (steps[i].name === 'from' || steps[i].name === 'to' || steps[i].name === 'property'); i++) {
    const m = steps[i];
    if (m.name === 'from') fromSpec = m.args[0];
    else if (m.name === 'to') toSpec = m.args[0];
    else {
      const { cardinality, rest, off } = readCardinality(m.args);
      const [k, v, ...metaArgs] = rest;
      if (cardinality !== null) throw new Error('Cardinality is not valid on an edge property');
      if (metaArgs.length) throw new Error('meta-properties are not valid on an edge property');
      if (isTokenArg(k)) { if (k.token === 'id') edgeUid = v; else throw new Error(`property(T.${k.token}) on an edge not supported`); }
      else if (typeof k === 'string' || isNested(k))
        props.push({ key: k, value: v, vtype: gremlinTypeOf(v, propTypeNode(m, off)), typeNode: propTypeNode(m, off), meta: null, cardinality: null });
      else throw new Error('addE property() key must be a string or traversal');
    }
  }
  return { label, fromSpec, toSpec, edgeUid, props, next: i };
}

function nodeExtId(store: GraphStore, rowid: number): any {
  return store.query<{ x: any }>('SELECT COALESCE(uid, id) AS x FROM nodes WHERE id=?', [rowid])[0]?.x ?? rowid;
}

// Insert one edge from a cluster + resolved endpoints; returns the framed result. The
// edge row carries no props (retired flat blob) — each property becomes an
// edge_properties row, typed via the cluster's captured argTypes (else JS-inferred).
function insertEdge(engine: Engine, store: GraphStore, c: EdgeCluster, src: number, tgt: number, params: Record<string, any> = {}, sideEffects?: Map<string, any>): any {
  // The edge-label waist. An edge carries exactly one label and so never reaches `labelNames`;
  // the rule is the same one (validate.ts).
  const { id, extId } = insertRow(store, 'edges', ['src', 'label', 'tgt'], [src, store.labelId(validateLabel(c.label)), tgt], c.edgeUid);
  // Each inline prop VALUE routes through resolveSpecValue (a nested value is evaluated
  // correlated at the new edge). The response echoes the RESOLVED values, never the raw
  // {nested} args.
  for (const sp of c.props) {
    const r = resolveSpecValue(engine, store, sp, id, 'edge', params, sideEffects);
    if (r.has) insertEdgeProperty(store, id, resolveSpecKey(engine, store, sp, id, 'edge', params, sideEffects), r.value, r.vtype ?? gremlinTypeOf(r.value, null), r.typeNode);
  }
  // Echo the RESOLVED props by reading them back typed (valueNodeFromStored {t,v}), so the response
  // frames with the same full fidelity as a read (execute.ts frameTypedNode).
  return { edge: { id: extId, label: c.label, src: nodeExtId(store, src), tgt: nodeExtId(store, tgt), props: readEdgeProps(store, id) } };
}

/** The refusal when an addE endpoint is missing or unresolvable, in TinkerPop's own wording
 *  (`AddEdgeStartStep` .../step/map/AddEdgeStartStep.java:134,142,154 and `AddEdgeStep`:124,134) —
 *  the corpus matches on "must resolve to a Vertex or the ID of a Vertex present in the graph".
 *  The reference splits the tail two ways and so do we: an endpoint nobody supplied is `null was
 *  specified instead`, while one that WAS supplied and resolved to nothing is `does not match any
 *  vertices in the graph`. Ours used to say "addE needs both endpoints — supply from()/to() or an
 *  incoming traverser", which named our implementation rather than the rule. */
const endpointRefusal = (label: string, side: 'from' | 'to', supplied: boolean): Error => new Error(
  `The value given to addE(${label}).${side}() must resolve to a Vertex or the ID of a Vertex present in the graph`
  + (supplied ? '. The provided value does not match any vertices in the graph' : ', but null was specified instead'));

// Resolve a cluster's from()/to() and insert the edge.
function applyEdgeCluster(engine: Engine, store: GraphStore, c: EdgeCluster, aliases: Map<string, number>, fallback: number | null, params: Record<string, any>, sideEffects?: Map<string, any>): any {
  // Resolve endpoints from-then-to, once per driver row, BEFORE inserting the edge —
  // a to(__.addV()) endpoint CREATES a vertex as a side effect (see nestedElementRowid).
  const src = c.fromSpec !== undefined ? resolveEndpoint(engine, store, c.fromSpec, { aliases }, params, sideEffects) : fallback;
  const tgt = c.toSpec !== undefined ? resolveEndpoint(engine, store, c.toSpec, { aliases }, params, sideEffects) : fallback;
  // TO is reported first, as the reference checks it first — which endpoint a user hears about for a
  // traversal missing both is observable, and the corpus's error scenarios are written against it.
  if (tgt == null) throw endpointRefusal(c.label, 'to', c.toSpec !== undefined);
  if (src == null) throw endpointRefusal(c.label, 'from', c.fromSpec !== undefined);
  return insertEdge(engine, store, c, src, tgt, params, sideEffects);
}

// addE — general form. A pure write chain goes to the sequential interpreter;
// otherwise a single addE with a V()-rooted prefix, one edge per resulting traverser.
function compileAddE(engine: Engine, steps: IRStep[], params: Record<string, any>, sideEffects?: Map<string, any>): WritePlan {
  const CHAIN = new Set(['addV', 'as', 'addE', 'from', 'to', 'property']);
  if (steps.every((s) => CHAIN.has(s.name)))
    return { kind: 'write', run: (store) => runWriteChainFull(engine, store, steps, params, sideEffects) };

  const addEIdx = steps.findIndex((s) => s.name === 'addE');
  const cluster = parseEdgeCluster(steps, addEIdx);
  if (cluster.next !== steps.length) throw new Error(`step not implemented after addE(): ${steps[cluster.next].name}()`);
  const prefix = steps.slice(0, addEIdx);
  const { st, stop } = engine.buildPrefixFresh(prefix, params);
  if (stop !== prefix.length) throw new Error(`addE after ${prefix[stop].name}() not yet supported`);
  // as() labels are JSONB history arrays; an addE endpoint is the label's last element
  // (a vertex). Extract its rowid in SQL so resolveEndpoint sees a plain id.
  const aliasCols: [string, string][] = [...st.traverserLayout.aliases].map(([lbl, a]) => [lbl, a.col]);
  const idExtract = (c: string) => `CAST(${c} ->> '$[#-1].v' AS INTEGER) AS ${c}`;
  const read = renderDriverRows(st, ['id', ...aliasCols.map(([, c]) => idExtract(c))].join(', '));
  return {
    kind: 'write',
    run: (store) => store.query<any>(read.sql, read.binds).map((r) =>
      applyEdgeCluster(engine, store, cluster, new Map(aliasCols.map(([lbl, c]) => [lbl, r[c]])), r.id, params, sideEffects)),
  };
}

// Interpret a linear write chain (addV/property/as/addE/from/to).
function runWriteChainFull(engine: Engine, store: GraphStore, steps: Step[], params: Record<string, any>, sideEffects?: Map<string, any>): any[] {
  const aliases = new Map<string, number>();
  let currentV: number | null = null;
  let last: any = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.name === 'addV') {
      const propSteps: Step[] = [];
      while (i + 1 < steps.length && ADDV_FOLLOWERS.has(steps[i + 1].name)) propSteps.push(steps[++i]);
      const spec = parseVertexSpec(s, propSteps, sideEffects, params);
      const v = insertVertex(engine, store, spec, params, sideEffects);
      currentV = v.id; last = { vertex: { id: v.extId, labels: v.labels, props: readVertexProps(store, v.id) } };
    } else if (s.name === 'as') {
      if (currentV == null) throw new Error('as() before any vertex in write chain');
      for (const lbl of s.args) if (typeof lbl === 'string') aliases.set(lbl, currentV);
    } else if (s.name === 'addE') {
      const cluster = parseEdgeCluster(steps, i);
      i = cluster.next - 1;
      last = applyEdgeCluster(engine, store, cluster, aliases, currentV, params, sideEffects);
    } else throw new Error(`write-chain step not supported: ${s.name}()`);
  }
  return last ? [last] : [];
}

// Resolve an addE from()/to() endpoint to a node INTERNAL rowid. The authority for
// every endpoint shape that appears:
//   "lbl" / __.select("lbl")  → an as()-label rowid   (to(__.select('a')) ≡ to('a'))
//   __.addV(...)              → a NEW vertex rowid     (nested write, correlated side effect)
//   __.V()/__.E() read prefix → buildPrefix's rowid    (movement/filter only)
// It returns rowids (NOT external ids) because edge src/tgt are internal — hence
// buildPrefix, never runNested (which frames COALESCE(uid,id)). Past-prefix read tails
// (order/limit) throw: no such endpoint appears in the corpus (fail-closed wall).
function resolveEndpoint(engine: Engine, store: GraphStore, spec: any, d: { aliases: Map<string, number> }, params: Record<string, any>, sideEffects?: Map<string, any>): number {
  const alias = (lbl: string, form: string): number => {
    const id = d.aliases.get(lbl);
    if (id === undefined) throw new Error(`addE from/to(${form}): unknown as() label`);
    return id;
  };
  if (typeof spec === 'string') return alias(spec, `"${spec}"`);
  if (isNested(spec)) {
    // normalize() folds repeat/emit/times/until clusters (and by() modulators) so an
    // endpoint like to(__.V().repeat(__.out()).times(2)) reaches buildPrefix as a
    // canonical chain — same normalization runNested does for every other nested arg.
    const inner = normalize(stepChain(spec.nested, params)).steps;
    // __.select("lbl") is exactly the bare as()-label string.
    if (inner.length === 1 && inner[0].name === 'select' && typeof inner[0].args[0] === 'string')
      return alias(inner[0].args[0], `select("${inner[0].args[0]}")`);
    // __.addV(...) CREATES the endpoint vertex as a side effect of resolving it (from
    // then to, once per driver, before insertEdge — see applyEdgeCluster). Reuses the
    // #2 value/label resolver via the same insertVertex.
    if (inner[0].name === 'addV') {
      const tail = inner.slice(1);
      if (tail.some((s) => s.name !== 'property')) throw new Error('addE endpoint __.addV(...) supports only trailing property() steps');
      return insertVertex(engine, store, parseVertexSpec(inner[0], tail, sideEffects, params), params, sideEffects).id;
    }
    // A V()/E()-rooted read: the movement/filter prefix's id-relation carries rowids.
    const { st, stop } = engine.buildPrefixFresh(inner, params);
    if (stop !== inner.length) throw new Error(`addE endpoint traversal not supported past ${inner[stop].name}()`);
    const sel = renderDriverRows(st);
    const rows = store.query<{ id: number }>(sel.sql, sel.binds);
    if (!rows.length) throw new Error('addE endpoint traversal matched no vertex');
    return rows[0].id;
  }
  throw new Error('addE from()/to() must be an as() label or a nested __.V(...)/__.addV()/__.select(...) traversal');
}

// ---------- mergeV / mergeE (upsert) ----------

// A MergeSpec's label/id/prop VALUES may each hold an unresolved nested traversal
// ({nested}) — the grammar allows a map value to be a traversal (mapEntry : mapKey COLON
// genericLiteral, and genericLiteral includes nestedTraversal). They are resolved per
// driver (correlated) by resolveMergeSpec, NOT at compile time.
// propTypes carries each prop VALUE's canonical type: from the map's TypeNode (a literal
// subtype or a typed client's wire DataType) for a literal value, or from the read shape
// for a nested value (filled by resolveMergeSpec). null = infer from the JS value.
/**
 * WHICH map this is. The spec-mandated validation differs per role and cannot be re-derived from
 * the spec's contents — `option(onMatch)` admits only String keys (plus `T.label`, for multi-label
 * replacement) where the merge argument and `option(onCreate)` admit the element's id/label (and,
 * for `mergeE`, its endpoint directions). Carrying it on the spec is what lets ONE validation run
 * at the ONE place every map becomes concrete, instead of three near-copies at three call sites.
 */
interface MergeRole {
  readonly op: 'mergeV' | 'mergeE';
  readonly kind: 'merge' | 'onCreate' | 'onMatch';
}

interface MergeSpec {
  readonly role: MergeRole;
  /** A LIST because a merge map's T.label may be `["a","b"]`; null = the key was absent. */
  label: string[] | null | { nested: any };
  id: any;
  outV: any;
  inV: any;
  /** Props are keyed by a stable internal slot until resolveMergeSpec turns a nested
   * map key into its actual string. Static keys use themselves as the slot. */
  props: Record<string, any>;
  propTypes: Record<string, TypeNode | null>;
  propKeys: Record<string, string | { nested: any }>;
  /** The per-key property cardinality. A map's CardinalityValueTraversal wins over
   * its enclosing option(..., Cardinality.x) default, matching TinkerPop. */
  propCardinalities: Record<string, Cardinality>;
}

function classifyMergeKey(k: any): { kind: 'label' | 'id' | 'outV' | 'inV' | 'prop'; name?: string } {
  const enumName = (typeName: string) => k && typeof k === 'object' && k.typeName === typeName ? String(k.elementName).toLowerCase() : null;
  const t = enumName('T') ?? (isTokenArg(k) ? k.token : null);
  if (t) { if (t === 'label') return { kind: 'label' }; if (t === 'id') return { kind: 'id' }; throw new Error(`merge map key T.${t} not supported`); }
  const d = enumName('Direction') ?? (isDirectionArg(k) ? k.direction : null);
  if (d) {
    if (d === 'out' || d === 'from') return { kind: 'outV' };
    if (d === 'in' || d === 'to') return { kind: 'inV' };
    throw new Error(`merge map key Direction.${d} not supported`);
  }
  return { kind: 'prop', name: String(k) };
}

function classifyMergeVal(v: any): any {
  const m = v && typeof v === 'object' ? (v.typeName === 'Merge' ? String(v.elementName).toLowerCase() : (isMergeArg(v) ? v.merge : null)) : null;
  return m ? { incoming: m } : v;
}

// Resolve a WHOLE-ARG merge traversal (mergeV(__.…) / option(Merge.x, __.…)) to a
// concrete map. A withSideEffect(key, map) constant read back by __.select(key) is a
// per-driver-invariant constant, so substitute it directly (correct-by-construction).
// The other legal whole-arg forms each need substrate this seam doesn't own — fail
// CLOSED naming exactly what's missing (never mis-execute):
//   - __.identity() / any traversal reading the incoming traverser AS the map needs a
//     map-VALUED driver model (merge drivers are element rowids today).
//   - a compound slice (__.select(k).limit(Scope.local,1).unfold()) needs local map
//     ops in the resolver.
//   - a side-effecting body (__.sideEffect(__.properties(k).drop()).select(m)) needs
//     nested-WRITE execution (runNested runs reads only).
// Per-VALUE nested traversals inside a map literal ([k: __.trav]) do NOT come here —
// they stay in the map and resolveMergeSpec resolves them correlated per driver.
function resolveMergeArg(raw: any, sideEffects: Map<string, any> | undefined, params: Record<string, any>): any {
  if (!isNested(raw)) return raw;
  const inner = stepChain(raw.nested, params);
  if (inner.length === 1 && inner[0].name === 'select' && typeof inner[0].args[0] === 'string') {
    const k = inner[0].args[0];
    if (sideEffects?.has(k)) return sideEffects.get(k);
    throw new Error(`merge with select('${k}') needs a withSideEffect('${k}', map) constant`);
  }
  const names = inner.map((s) => s.name).join('.');
  if (inner[0].name === 'identity' || inner.some((s) => s.name === 'select'))
    throw new Error(`merge whole-arg traversal __.${names} not yet supported (needs a map-valued driver / local-map / nested-write substrate; a map literal [k: __.trav] IS supported)`);
  throw new Error(`merge whole-arg traversal __.${names} not yet supported`);
}

/**
 * The spec-mandated shape of ONE merge map, checked against its role — `MergeElementStep.validate`
 * in gremlin-core, which we did not perform at all. Two rules, both about the KEY:
 *
 *  - a token key must be one this role admits (`getAllowedTokens`): `mergeV` takes `T.id`/`T.label`,
 *    `mergeE` adds `Direction.IN`/`OUT`, and `option(onMatch)` takes none of them except `T.label`,
 *    because onMatch writes properties onto an element whose identity is already settled;
 *  - a token key may not carry a null value, which would otherwise reach `labelNames(null)` and
 *    write the LABEL `"null"`.
 *
 * The rules about the identifier ITSELF (hidden namespace, empty) are `validate.ts`, and they run
 * on the RESOLVED spec instead — a nested map key produces its string per driver, so a compile-time
 * check would see a traversal, not `~id`.
 */
function validateMergeKey(role: MergeRole, k: any, v: any, kind: ReturnType<typeof classifyMergeKey>['kind']): void {
  if (kind === 'prop') return; // a String key; validate.ts checks it once resolved
  const token = kind === 'label' ? 'T.label' : kind === 'id' ? 'T.id' : kind === 'outV' ? 'Direction.OUT' : 'Direction.IN';
  if (role.kind === 'onMatch') {
    // T.label survives: onMatch replaces/extends an element's labels where the graph allows it.
    if (kind !== 'label')
      throw new Error(`option(onMatch) expects keys in Map to be of String - check: ${token}`);
  } else {
    const allowed = role.op === 'mergeV' ? kind === 'label' || kind === 'id' : true;
    if (!allowed)
      throw new Error(`${role.op}() and option(onCreate) args expect keys in Map to be either String or [id, label] - check: ${token}`);
  }
  if (v === null || v === undefined)
    throw new Error(`${role.op}() does not allow null Map values - check: ${String(k && typeof k === 'object' && 'elementName' in k ? k.elementName : token)}`);
}

/**
 * The element-identifier rules over a RESOLVED merge map's property keys.
 *
 * The two storage waists (`labelNames`, `applyVertexProperty`/`insertEdgeProperty`) already reject
 * a bad identifier on the way IN, and a merge map's labels go through `labelNames` — but a merge
 * map's property keys are SEARCH criteria first and only reach a writer if the branch happens to
 * create. `g.mergeV(['~id':1])` against a graph that matches would otherwise write nothing, find
 * something, and never be told the key was illegal. So the map is validated as a map, whichever
 * branch it takes.
 */
function validateResolvedMergeSpec(spec: MergeSpec): void {
  for (const k of Object.keys(spec.props)) validatePropertyKey(k);
}

/**
 * `MergeElementStep.validateNoOverrides`: `option(onCreate)` may RESTATE a key the merge argument
 * already bound, but not change it — the merge argument IS the existence criterion, so an onCreate
 * that contradicts it would create something the search could never have found.
 *
 * Compared over the normalized spec rather than the raw maps, which is why the four token slots are
 * named individually: `label`/`id`/`outV`/`inV` ARE the map's `T.label`/`T.id`/`Direction.*` keys
 * after classification. A slot still holding a nested traversal is skipped — two traversals are not
 * comparable, and the create-branch call sees them resolved.
 */
function validateNoOverrides(merge: MergeSpec, onCreate: MergeSpec): void {
  const clash = (token: string, a: any, b: any) => {
    if (a === undefined || a === null || b === undefined || b === null) return;
    if (isNested(a) || isNested(b)) return;
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`option(onCreate) cannot override values from merge() argument: (${token}, ${JSON.stringify(b)})`);
  };
  clash('label', merge.label, onCreate.label);
  clash('id', merge.id, onCreate.id);
  clash('OUT', merge.outV, onCreate.outV);
  clash('IN', merge.inV, onCreate.inV);
  for (const [k, v] of Object.entries(onCreate.props))
    if (k in merge.props) clash(k, merge.props[k], v);
}

function normalizeMergeMap(role: MergeRole, raw: any, typeNode: TypeNode | null, sideEffects?: Map<string, any>, params: Record<string, any> = {}, defaultCardinality: Cardinality = null): MergeSpec {
  raw = resolveMergeArg(raw, sideEffects, params);
  const spec: MergeSpec = { role, label: null, id: null, outV: undefined, inV: undefined, props: {}, propTypes: {}, propKeys: {}, propCardinalities: {} };
  if (raw == null) return spec; // mergeV(null) — match anything
  if (!(raw instanceof Map))
    throw new Error('merge argument must be a map ([k:v] / bound Map), null, or empty ([:])');
  for (const [k, v] of raw) {
    // Parameters resolves map KEYS with TraversalUtil.apply as well as values. A
    // traversal key cannot be classified until it has the incoming driver, so retain it
    // under an internal slot for resolveMergeSpec rather than coercing it to
    // "[object Object]" at parse time.
    if (isNested(k)) {
      const slot = `@nested-key:${Object.keys(spec.props).length}`;
      spec.props[slot] = v;
      spec.propTypes[slot] = null;
      spec.propKeys[slot] = k;
      spec.propCardinalities[slot] = defaultCardinality;
      continue;
    }
    const c = classifyMergeKey(k);
    validateMergeKey(role, k, v, c.kind);
    // label/id/prop VALUES may be nested traversals — keep them UNRESOLVED (deferred to
    // resolveMergeSpec, per driver). Only a non-nested label collapses to a string now.
    if (c.kind === 'label') spec.label = isNested(v) ? v : labelNames(v, true, 'mergeV');
    else if (c.kind === 'id') spec.id = v;
    else if (c.kind === 'outV') spec.outV = classifyMergeVal(v);
    else if (c.kind === 'inV') spec.inV = classifyMergeVal(v);
    else {
      const cardinalityValue = isCardinalityValueArg(v) ? v : null;
      const value = cardinalityValue ? cardinalityValue.value : v;
      const cardinality = cardinalityValue?.cardinality ?? defaultCardinality;
      if (cardinality !== null && cardinality !== 'single' && cardinality !== 'list' && cardinality !== 'set')
        throw new Error(`unsupported merge property cardinality '${cardinality}'`);
      spec.props[c.name!] = value;
      spec.propKeys[c.name!] = c.name!;
      // A literal value's FULL type tree comes from the map's TypeNode (the parser subtype /
      // the typed client's wire DataType) — kept whole so a collection value's elements/keys
      // stay typed; a nested value's type is filled per driver (a scalar, in resolveMergeSpec).
      spec.propTypes[c.name!] = isNested(value) ? null : mapEntryType(typeNode, String(k));
      spec.propCardinalities[c.name!] = cardinality;
    }
  }
  return spec;
}

// Produce a concrete MergeSpec for ONE driver: every nested label/id/prop value is
// resolved correlated at `seed` (the incoming traverser element, or undefined = global).
// A non-nested spec passes through unchanged (the constant case stays bit-identical, so
// mergeMatchQuery renders the same SQL+binds it did at compile time). Fails closed on a
// nested map value that produces nothing (a match/create value must exist).
function resolveMergeSpec(engine: Engine, store: GraphStore, spec: MergeSpec, seed: { id: number; elem: Elem } | undefined, params: Record<string, any>, sideEffects?: Map<string, any>): MergeSpec {
  // Resolve one value to {value, vtype}: a literal keeps its captured propType; a nested
  // traversal resolves correlated at the seed and carries the read shape's vtype.
  const rv = (v: any, propKey: string | null, what: string): { value: any; typeNode: TypeNode | null } => {
    if (!isNested(v)) return { value: v, typeNode: propKey != null ? (spec.propTypes[propKey] ?? null) : null };
    const r = nestedScalarValue(engine, store, v, params, seed, sideEffects);
    if (!r.has) throw new Error(`merge map ${what} traversal produced no value`);
    return { value: r.value, typeNode: r.vtype }; // a nested scalar's vtype IS a bare TypeNode
  };
  const props: Record<string, any> = {};
  const propTypes: Record<string, TypeNode | null> = {};
  const propCardinalities: Record<string, Cardinality> = {};
  for (const [slot, v] of Object.entries(spec.props)) {
    const rawKey = spec.propKeys[slot] ?? slot;
    const k = isNested(rawKey)
      ? (() => {
          const r = nestedScalarValue(engine, store, rawKey, params, seed, sideEffects);
          if (!r.has) throw new Error('merge map key traversal produced no value');
          if (typeof r.value !== 'string') throw new Error(`merge map key traversal must produce a string, got ${typeof r.value}`);
          return r.value;
        })()
      : rawKey;
    const r = rv(v, slot, `value for '${k}'`);
    // `?? null` preserves "the map declared none" — collapsing an absent slot to 'single' here
    // is the same mistake as defaulting in readCardinality, one layer further in.
    props[k] = r.value; propTypes[k] = r.typeNode; propCardinalities[k] = spec.propCardinalities[slot] ?? null;
  }
  const resolved: MergeSpec = {
    role: spec.role,
    label: isNested(spec.label) ? labelNames(rv(spec.label, null, 'label').value, true, 'mergeV') : spec.label,
    id: rv(spec.id, null, 'id').value,
    outV: spec.outV, inV: spec.inV,
    props, propTypes, propKeys: Object.fromEntries(Object.keys(props).map((k) => [k, k])), propCardinalities,
  };
  // THE place every merge map becomes concrete — match, onCreate and onMatch alike, literal keys
  // and per-driver nested ones alike. One call here is what item 22's whole family needed.
  validateResolvedMergeSpec(resolved);
  return resolved;
}

// The label / id-or-uid / per-prop equality conditions shared by the vertex and
// edge merge-match queries.
function commonMergeConds(spec: MergeSpec, elem: Elem): Expression[] {
  const conds: Expression[] = [];
  // ANY-label match: a vertex matches mergeV's label if it CARRIES that label. Under the
  // declared ONE cardinality that is the old `label = ?`; it is already the multi-label rule.
  // ANY-label match per name, and EVERY name must be carried: mergeV([(T.label): ["person",
  // "employee"]]) matches the vertex that has BOTH, which is what
  // `g.V().hasLabel("person").hasLabel("employee")` counts in the scenario.
  if (spec.label != null) {
    const names = spec.label as string[];
    if (elem === 'vertex') for (const n of names) conds.push(vertexLabelIn(raw('nodes.id'), [n]));
    else conds.push(labelIn('label', names));
  }
  if (spec.id != null) conds.push(typeof spec.id === 'number' ? q`id=${value(spec.id)}` : q`uid=${value(spec.id)}`);
  for (const [k, v] of Object.entries(spec.props))
    // An ANY-match EXISTS over the element's normalized properties table.
    conds.push(propHasFor(elemTable(elem).c.id, elem, k, v));
  return conds;
}

function mergeMatchQuery(spec: MergeSpec): { sql: string; binds: any[] } {
  const conds = commonMergeConds(spec, 'vertex');
  const where = conds.length ? list(conds, ' AND ') : q`1`;
  return render(q`SELECT id, uid FROM nodes WHERE ${where}`);
}

/** The `option()`s a merge carries, plus the `property()` TAIL that may follow them.
 *
 *  The tail is not a merge feature: `mergeV(map).property(k, v)` is an ordinary AddPropertyStep over
 *  whatever the merge emitted, matched or created alike, and TinkerPop compiles it as exactly that.
 *  So it parses through the same `parsePropertyTail` a mutation tail uses, and the merge compilers
 *  apply it through the same storage waist — which is what makes a meta-property or a declared
 *  cardinality in that position work without the merge lowering knowing either exists.
 *
 *  `option()` must come first: it modulates the merge, while the tail acts on its OUTPUT. */
function parseMergeOptions(mods: Step[], step: MergeRole['op'], sideEffects: Map<string, any> | undefined, params: Record<string, any>): { onCreate: MergeSpec | null; onMatch: MergeSpec | null; tail: PropSpec[] } {
  let onCreate: MergeSpec | null = null, onMatch: MergeSpec | null = null;
  const optionCount = mods.findIndex((s) => s.name !== 'option');
  const tail = optionCount < 0 ? [] : parsePropertyTail(mods.slice(optionCount), `${step}()`, sideEffects, params);
  for (const s of optionCount < 0 ? mods : mods.slice(0, optionCount)) {
    if (s.name !== 'option') throw new Error(`step not implemented after ${step}(): ${s.name}()`);
    const [sel, mapArg, cardinalityArg] = s.args;
    if (!isMergeArg(sel))
      throw new Error(`${step} option() selector must be Merge.onCreate/onMatch`);
    if (cardinalityArg != null && (!isCardinalityArg(cardinalityArg) || isCardinalityValueArg(cardinalityArg)))
      throw new Error(`${step} option() third argument must be Cardinality.single/list/set`);
    const defaultCardinality = cardinalityArg?.cardinality ?? null;
    if (defaultCardinality !== null && defaultCardinality !== 'single' && defaultCardinality !== 'list' && defaultCardinality !== 'set')
      throw new Error(`${step} option() has unsupported cardinality '${defaultCardinality}'`);
    const kind = sel.merge === 'oncreate' ? 'onCreate' : sel.merge === 'onmatch' ? 'onMatch' : null;
    if (!kind) throw new Error(`${step} option(Merge.${sel.merge}) not supported`);
    const spec = normalizeMergeMap({ op: step, kind }, mapArg, s.argTypes?.[1] ?? null, sideEffects, params, defaultCardinality);
    if (kind === 'onCreate') onCreate = spec; else onMatch = spec;
  }
  return { onCreate, onMatch, tail };
}

// The incoming traversers a merge runs once per, evaluated at run time.
function mergeDrivers(engine: Engine, prefix: IRStep[], params: Record<string, any>): (store: GraphStore) => (number | null)[] {
  if (prefix.length === 0) return () => [null];
  if (prefix.length === 1 && prefix[0].name === 'inject') { const nulls = prefix[0].args.map(() => null); return () => nulls; }
  const { st, stop } = engine.buildPrefixFresh(prefix, params);
  if (stop !== prefix.length) throw new Error(`merge after ${prefix[stop].name}() not yet supported`);
  const sel = renderDriverRows(st);
  return (store) => store.query<{ id: number }>(sel.sql, sel.binds).map((r) => r.id);
}

// g.mergeV(map) [.option(Merge.onCreate, map)] [.option(Merge.onMatch, map)]
function compileMergeV(engine: Engine, steps: IRStep[], params: Record<string, any>, sideEffects?: Map<string, any>): WritePlan {
  const mvIdx = steps.findIndex((s) => s.name === 'mergeV');
  if (steps[mvIdx].args.length === 0)
    throw new Error('mergeV() with no argument (uses the incoming traverser as the map) not yet supported');
  const matchSpecRaw = normalizeMergeMap({ op: 'mergeV', kind: 'merge' }, steps[mvIdx].args[0], steps[mvIdx].argTypes?.[0] ?? null, sideEffects, params);
  const { onCreate, onMatch, tail } = parseMergeOptions(steps.slice(mvIdx + 1), 'mergeV', sideEffects, params);
  // Statically, before anything runs — TinkerPop's `validateStaticNoOverrides`, which is why the
  // corpus expects a contradicting onCreate to raise even when the merge argument MATCHES and no
  // create would have happened. The create branch re-checks the RESOLVED specs, for the slots that
  // held a nested traversal here.
  if (onCreate) validateNoOverrides(matchSpecRaw, onCreate);
  const drivers = mergeDrivers(engine, steps.slice(0, mvIdx), params);
  return {
    kind: 'write',
    run: (store) => {
      const out: WriteResult[] = [];
      for (const driver of drivers(store)) {
        // The merge map (match + onCreate/onMatch) is completed per incoming traverser:
        // resolve nested values seeded at the driver, then build the match query from the
        // resolved spec. A constant spec resolves to itself → identical SQL each iteration.
        const seed = driver != null ? { id: driver, elem: 'vertex' as const } : undefined;
        const matchSpec = resolveMergeSpec(engine, store, matchSpecRaw, seed, params, sideEffects);
        const oc = onCreate ? resolveMergeSpec(engine, store, onCreate, seed, params, sideEffects) : null;
        const om = onMatch ? resolveMergeSpec(engine, store, onMatch, seed, params, sideEffects) : null;
        const match = mergeMatchQuery(matchSpec);
        const matches = store.query<any>(match.sql, match.binds);
        if (matches.length) {
          for (const m of matches) {
            // onMatch T.label ADDS to the existing set rather than replacing it: the scenario
            // asserts the vertex still carries `person` and `employee` after onMatch adds
            // `manager`. Under an immutable cardinality that is a refusal, same as addLabel().
            const omLabels = Array.isArray(om?.label) ? om.label : null;
            if (omLabels?.length) {
              if (!engine.labelCardinality.mutable)
                throw new Error(`${LABEL_MUTATION_UNSUPPORTED}: mergeV(onMatch) with a label`);
              store.addVertexLabels(m.id, omLabels);
              assertLabelCount(engine, store.vertexLabels(m.id).length, 'mergeV');
            }
            if (om) for (const [k, v] of Object.entries(om.props))
              // A merge map value is one value (a CardinalityValueTraversal carries exactly one),
              // and `?? null` keeps "the map declared no cardinality" reaching the waist intact.
              applyVertexProperty(store, m.id, k, [v], gremlinTypeOf(v, om.propTypes[k] ?? null), null, om.propCardinalities[k] ?? null, om.propTypes[k] ?? null);
            applyPropertyTail(engine, store, tail, m.id, 'vertex', params, sideEffects);
            // Read the labels back AFTER any onMatch addition, not off the match row.
            out.push({ vertex: { id: m.uid ?? m.id, labels: store.vertexLabels(m.id), props: readVertexProps(store, m.id) } });
          }
        } else {
          if (oc) validateNoOverrides(matchSpec, oc);
          const labels = (oc?.label as string[]) ?? (matchSpec.label as string[]) ?? [];
          const props = { ...matchSpec.props, ...(oc?.props ?? {}) };
          const propTypes = { ...matchSpec.propTypes, ...(oc?.propTypes ?? {}) };
          const propCardinalities = { ...matchSpec.propCardinalities, ...(oc?.propCardinalities ?? {}) };
          const v = insertVertex(engine, store, { labels, props: singleProps(props, propTypes, propCardinalities), uid: matchSpec.id ?? oc?.id ?? null }, params, sideEffects);
          // The tail runs on a CREATED vertex too — it acts on whatever the merge emitted, and the
          // merge emits one element either way.
          applyPropertyTail(engine, store, tail, v.id, 'vertex', params, sideEffects);
          // Echo typed props read back from storage ({t,v}), not the raw resolved values.
          out.push({ vertex: { id: v.extId, labels: v.labels, props: readVertexProps(store, v.id) } });
        }
      }
      return out;
    },
  };
}

// Resolve a mergeE endpoint spec to a node rowid, requiring the vertex to exist.
function resolveMergeEndpoint(store: GraphStore, raw: any): number {
  const r = store.query<{ id: number }>(
    typeof raw === 'number' ? 'SELECT id FROM nodes WHERE id=?' : 'SELECT id FROM nodes WHERE uid=?', [raw])[0];
  if (!r) throw new Error('Vertex does not exist for mergeE');
  return r.id;
}

function edgeMatchQuery(spec: MergeSpec, outV: number, inV: number): { sql: string; binds: any[] } {
  const conds: Expression[] = [q`src=${value(outV)}`, q`tgt=${value(inV)}`, ...commonMergeConds(spec, 'edge')];
  // The label name comes from the label seam (plan.ts), not a fourth hand-written spelling of
  // its correlated subquery — a scalar label position has exactly one authority.
  const e = elemTable('edge');
  return render(q`SELECT id, uid, src, tgt, ${labelNameFor(e, 'edge')} AS label FROM ${e} WHERE ${list(conds, ' AND ')}`);
}

// g.mergeE(map) [.option(Merge.onCreate, map)] [.option(Merge.onMatch, map)]
function compileMergeE(engine: Engine, steps: IRStep[], params: Record<string, any>, sideEffects?: Map<string, any>): WritePlan {
  const meIdx = steps.findIndex((s) => s.name === 'mergeE');
  if (steps[meIdx].args.length === 0)
    throw new Error('mergeE() with no argument (uses the incoming traverser as the map) not yet supported');
  const matchSpecRaw = normalizeMergeMap({ op: 'mergeE', kind: 'merge' }, steps[meIdx].args[0], steps[meIdx].argTypes?.[0] ?? null, sideEffects, params);
  const { onCreate, onMatch, tail } = parseMergeOptions(steps.slice(meIdx + 1), 'mergeE', sideEffects, params);
  for (const sp of tail) assertEdgePropertySpec(sp);
  if (onCreate) validateNoOverrides(matchSpecRaw, onCreate);
  const drivers = mergeDrivers(engine, steps.slice(0, meIdx), params);
  return {
    kind: 'write',
    run: (store) => {
      const endpoint = (spec: any, oc: any, cur: number | null, role: string): number => {
        const raw = spec?.incoming !== undefined ? cur : spec ?? (oc?.incoming !== undefined ? cur : oc);
        // MergeEdgeStep's own wording (gremlin-core .../step/map/MergeEdgeStep.java:314) for the
        // same refusal. Ours fires EARLIER than the reference's — it checks on the create path,
        // after the search found nothing, while we need both endpoints to build the match query at
        // all — so the message names onCreate, which is the branch that reaches it in the corpus.
        if (raw == null) throw new Error(`${role === 'outV' ? 'Out' : 'In'} Vertex not specified in onCreate - edge cannot be created`);
        return resolveMergeEndpoint(store, raw);
      };
      const out: any[] = [];
      for (const cur of drivers(store)) {
        // Complete the merge map per incoming traverser (nested values seeded at cur),
        // then build the match query from the resolved spec.
        const seed = cur != null ? { id: cur, elem: 'vertex' as const } : undefined;
        const matchSpec = resolveMergeSpec(engine, store, matchSpecRaw, seed, params, sideEffects);
        const oc = onCreate ? resolveMergeSpec(engine, store, onCreate, seed, params, sideEffects) : null;
        const om = onMatch ? resolveMergeSpec(engine, store, onMatch, seed, params, sideEffects) : null;
        // An EDGE property has no cardinality, so any DECLARED one is the refusal — `null` (the
        // map named none) is the only acceptable state, exactly as on the addE/property() path.
        if (Object.values(oc?.propCardinalities ?? {}).some((c) => c !== null) || Object.values(om?.propCardinalities ?? {}).some((c) => c !== null))
          throw new Error('mergeE option() does not support vertex-property cardinality');
        const outV = endpoint(matchSpec.outV, oc?.outV, cur, 'outV');
        const inV = endpoint(matchSpec.inV, oc?.inV, cur, 'inV');
        const match = edgeMatchQuery(matchSpec, outV, inV);
        const matches = store.query<any>(match.sql, match.binds);
        if (matches.length) {
          for (const m of matches) {
            if (om) for (const [k, v] of Object.entries(om.props)) insertEdgeProperty(store, m.id, k, v, gremlinTypeOf(v, om.propTypes[k] ?? null), om.propTypes[k] ?? null);
            applyPropertyTail(engine, store, tail, m.id, 'edge', params, sideEffects);
            out.push({ edge: { id: m.uid ?? m.id, label: m.label, src: nodeExtId(store, m.src), tgt: nodeExtId(store, m.tgt), props: readEdgeProps(store, m.id) } });
          }
        } else {
          if (oc) validateNoOverrides(matchSpec, oc);
          // An edge carries exactly ONE label, so a merge map's list must hold exactly one name.
          const edgeLabels = (matchSpec.label ?? oc?.label) as string[] | null | undefined;
          if (edgeLabels && edgeLabels.length > 1) throw new Error('mergeE: an edge takes exactly one label');
          const label = edgeLabels?.[0];
          if (!label) throw new Error('mergeE cannot create an edge without a label');
          const props = { ...matchSpec.props, ...(oc?.props ?? {}) };
          const propTypes = { ...matchSpec.propTypes, ...(oc?.propTypes ?? {}) };
          // On the CREATE branch the tail is simply more inline props: an edge property has no
          // cardinality and no meta (asserted above), so a tail spec and an addE-style inline spec
          // are the same thing, resolved correlated at the same new edge.
          out.push(insertEdge(engine, store, { label, fromSpec: undefined, toSpec: undefined, edgeUid: matchSpec.id ?? oc?.id ?? null, props: [...singleProps(props, propTypes), ...tail], next: 0 }, outV, inV, params, sideEffects));
        }
      }
      return out;
    },
  };
}

// ---------- write dispatch table ----------
//
// Ordered rules: the first whose `match` fires compiles the chain. Order matters
// (addE before addV; drop must be the terminal step) — hence a rule list, not a
// name→fn Map. Returns null when the chain is a read (compiler falls to compileRead).
interface WriteRule { match: (steps: IRStep[]) => boolean; compile: (engine: Engine, steps: IRStep[], params: Record<string, any>, sackInit?: SackSpec, sideEffects?: Map<string, any>) => WritePlan | Compiled; }

/** The label-mutation steps. They are WRITE steps, so they route here — and under a graph whose
 *  declared LabelCardinality is immutable that routing ends in a refusal, which is the SPECIFIED
 *  answer rather than a gap: `AddLabel.feature`/`DropLabel.feature` assert the message on a
 *  single-label graph. Edges refuse under every cardinality (edge label cardinality is fixed at
 *  ONE by spec), which is why the check reads the element kind rather than a global flag. */
/** A label value in a merge map / an addV() argument is a string OR a list of strings; a list is
 *  only legal as the sole argument (TinkerPop rejects mixing, with a message naming Collection).
 *  Returns the flattened names. `sole` says whether this value was the only argument. */
function labelNames(v: any, sole: boolean, step: string): string[] {
  // THE waist every label name passes through — addV, addLabel, mergeV and mergeE alike — so the
  // element-identifier rules (validate.ts) are enforced once here rather than at each caller.
  if (!Array.isArray(v)) return [validateLabel(v)];
  // Upstream words the two rejections differently and the scenarios match on the text, so this
  // is not one shared message: AddVertex asserts "must produce a scalar String when multiple
  // traversals are provided", AddLabel asserts "Collection".
  if (!sole) throw new Error(step === 'addV'
    ? `${step}(): a label traversal must produce a scalar String when multiple traversals are provided`
    : `${step}(): a Collection argument must be the only argument`);
  return v.map(validateLabel);
}

const LABEL_MUTATIONS = new Set(['addLabel', 'dropLabel', 'dropLabels']);
/** Steps that CONFIGURE the vertex addV() is creating, rather than reading from it. */
const ADDV_FOLLOWERS = new Set(['property', 'addLabel']);
/** Write steps that cannot follow a label mutation — the same set mid-addV refuses to continue past. */
const MUTATING_TAIL = new Set(['addV', 'addE', 'mergeV', 'mergeE', 'property', 'drop', ...LABEL_MUTATIONS]);

/** Reject a label count the declared cardinality forbids, naming the step so the error says which
 *  operation overstepped. `min` is checked by dropLabel/dropLabels, `max` by addV/addLabel.
 *  Wording is `LabelCardinality.validateCreation`'s (gremlin-core .../structure/util/
 *  LabelCardinalityValidator.java:96) — the same refusal for the same reason, so it says so in the
 *  same words. The step prefix is ours and is kept: the reference's message cannot say WHICH
 *  operation overstepped, and that is the first thing you want to know. */
function assertLabelCount(engine: Engine, n: number, step: string): void {
  const c = engine.labelCardinality;
  if (n > c.max) throw new Error(`${step}(): Element creation allows at most ${c.max} label(s), got ${n}`);
  if (n < c.min) throw new Error(`${step}(): Element creation requires at least ${c.min} label(s), got ${n}`);
}

/** addLabel/dropLabel/dropLabels over the elements a read prefix selects.
 *
 *  An EDGE always refuses: edge label cardinality is fixed at ONE by spec, so this is the
 *  specified answer and not a gap. A VERTEX refuses when the graph declares an immutable
 *  cardinality, with the message the conformance suite matches on. */
function compileLabelMutation(engine: Engine, steps: IRStep[], params: Record<string, any>, sideEffects?: Map<string, any>): WritePlan {
  const at = steps.findIndex((s) => LABEL_MUTATIONS.has(s.name));
  const step = steps[at];
  const { st } = engine.buildPrefix(steps.slice(0, at), params);
  // The REFUSAL comes first, before any question about what follows: a graph that cannot mutate
  // labels must say so whatever the tail is. `g.E().addLabel("friend").labels().fold()` asserts
  // exactly that, and checking the tail first answered "step not implemented after addLabel()".
  if (st.elem === 'edge') throw new Error(`${LABEL_MUTATION_UNSUPPORTED}: ${step.name}() on an edge`);
  if (!engine.labelCardinality.mutable) throw new Error(`${LABEL_MUTATION_UNSUPPORTED}: ${step.name}()`);

  // These are SIDE-EFFECT steps: they mutate and pass the SAME traverser on, so a read tail is
  // the norm rather than the exception (`addLabel("employee").labels().fold()`). The element is
  // unchanged, so unlike mid-traversal addV there is no new vertex to re-root on — the suffix
  // simply re-reads each driver after the mutation, through the ordinary read compiler.
  const suffix = steps.slice(at + 1);
  if (suffix.some((s) => MUTATING_TAIL.has(s.name)))
    throw new Error(`write continuation after ${step.name}() not yet supported: ${suffix.find((s) => MUTATING_TAIL.has(s.name))!.name}()`);

  // The arguments are label NAMES, and each may be a traversal yielding a string OR a list of
  // strings — `addLabel(constant(["a","b"]))`. A collection is only legal as the SOLE argument
  // (TinkerPop rejects mixing), which the expansion enforces.
  const argNames = (store: GraphStore): string[] => {
    const out: string[] = [];
    for (const a of step.args) {
      const v = isNested(a) ? nestedScalarValue(engine, store, a, params, undefined, sideEffects).value : a;
      if (Array.isArray(v)) {
        if (step.args.length > 1) throw new Error(`${step.name}(): a Collection argument must be the only argument`);
        out.push(...v.map(String));
      } else out.push(String(v));
    }
    return out;
  };

  const tail = elementTailContinuation(engine, st, suffix, params);
  let touched: ElementReadDriver[] = [];
  return {
    kind: 'write',
    run: (store) => {
      touched = materializeElementDrivers(store, st);
      tail.assertDrivers(touched);
      const names = step.name === 'dropLabels' ? null : argNames(store);
      for (const d of touched) {
        if (step.name === 'addLabel') store.addVertexLabels(d.id, names!);
        // dropLabel(x) on a label the vertex does not carry is a NO-OP, not an error.
        else store.dropVertexLabels(d.id, names);
        assertLabelCount(engine, store.vertexLabels(d.id).length, step.name);
      }
      // With no read tail these steps are terminal side effects and yield nothing, matching
      // `g.V().hasLabel("person").addLabel("employee")` iterating to an empty list.
      return [];
    },
    ...tail.plan(() => touched),
  };
}

const WRITE_RULES: WriteRule[] = [
  // The element-CREATING rules come first, so `addV("person").addLabel("employee")` is one
  // creation with two labels rather than a mutation whose prefix is an addV.
  { match: (s) => s.some((x) => x.name === 'addE'), compile: (e, s, p, _sk, se) => compileAddE(e, s, p, se) },
  { match: (s) => s.some((x) => x.name === 'addV'), compile: (e, s, p, _sk, se) => compileAddV(e, s, p, se) },
  { match: (s) => s.some((x) => LABEL_MUTATIONS.has(x.name)), compile: (e, s, p, _sk, se) => compileLabelMutation(e, s, p, se) },
  { match: (s) => s.some((x) => x.name === 'mergeV'), compile: (e, s, p, _sk, se) => compileMergeV(e, s, p, se) },
  { match: (s) => s.some((x) => x.name === 'mergeE'), compile: (e, s, p, _sk, se) => compileMergeE(e, s, p, se) },
  // inject is a scalar-stream READ, not a write — it lives here only because it's a
  // source constructor. It threads withSack() so a sack-carrying value stream
  // (withSack(x).inject(v).sack(...)) seeds its `sk` column like the V()/E() path.
  { match: (s) => s[0].name === 'inject', compile: (e, s, _p, sackInit) => compileInject(e, s, sackInit) },
  { match: (s) => s[s.length - 1].name === 'drop', compile: (e, s, p) => compileDrop(e, s, p) },
  { match: (s) => s.some((x) => x.name === 'property'), compile: (e, s, p, _sk, se) => compileSetProperty(e, s, p, se) },
];

/** Route a step chain to its write compiler, or null if it's a read. The lowering Engine (built by
 *  the compiler for this compilation) is threaded so write compilers reach the read spine (a nested
 *  value/endpoint read, a target-id prefix) through it — each such sub-compile mints its own fresh
 *  child engine (buildPrefixFresh / compileReadCompiled). */
export function routeWrite(engine: Engine, steps: IRStep[], params: Record<string, any>, sackInit?: SackSpec, sideEffects?: Map<string, any>): WritePlan | Compiled | null {
  for (const rule of WRITE_RULES) if (rule.match(steps)) return rule.compile(engine, steps, params, sackInit, sideEffects);
  return null;
}
