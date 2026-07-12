import type { GraphStore } from './storage.ts';
import { parseGremlin, stepChain, stepName, type Step, type Pred } from './frontend.ts';
import { render, compiled, readCompiled, withPrefixTree, type CteDef, type Compiled, type WritePlan, type Shape, type MapEntry, type ElemShape, type GroupKey, type GroupVal } from './render.ts';
// Re-export the compile-output contract so handler.ts / tests keep importing it here.
export type { Compiled, WritePlan, Shape, MapEntry, ElemShape, GroupKey, GroupVal } from './render.ts';
import { P_OPS, propExtract, labelIn, edgeLabelFilter, predicateSql, rangeToOffsetLimit, dirsFor, type Elem,
  propAt, labelNameSub, compileNestedScalar, compileFilterPredicate, combineBranchPreds, type ScalarCtx } from './plan.ts';

// lazyrecords typed SQL construction (bind-safe: params derive from the tree).
import { sql as lsql } from '@bodar/lazyrecords/sql/template/Sql.ts';
import { text as sqlText } from '@bodar/lazyrecords/sql/template/Text.ts';
import { expression, list } from '@bodar/lazyrecords/sql/template/Compound.ts';
import { value } from '@bodar/lazyrecords/sql/template/Value.ts';
import { cte } from '@bodar/lazyrecords/sql/ansi/CommonTableExpression.ts';
import { withClause } from '@bodar/lazyrecords/sql/ansi/WithClause.ts';
import { valuesClause } from '@bodar/lazyrecords/sql/ansi/ValuesClause.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';

// template-first kernel + typed relation handles (see src/q.ts, src/schema.ts)
import { q, relation, Relation } from './q.ts';
import { nodes, edges, labels } from './schema.ts';


// ---------- compilation ----------



/**
 * Fail closed on traversal-strategy application. `withStrategies`/`withoutStrategies`
 * parse and chain fine (so they count toward the L1 "we understand the language"
 * corpus metric), but the compiler does not yet APPLY them. A PartitionStrategy or
 * SubgraphStrategy — which a client relies on to FILTER reads/writes for logical
 * isolation — would otherwise be silently dropped and return unfiltered data with
 * no error. Reject at execution until the compiler honours them, rather than leak.
 */
function rejectUnsupportedStrategies(tree: any): void {
  const scan = (node: any) => {
    const m = stepName(node.constructor.name, 'TraversalSourceSelfMethod_');
    if (m === 'withStrategies' || m === 'withoutStrategies')
      throw new Error(`${m}(...) is not supported: traversal strategies (e.g. PartitionStrategy, SubgraphStrategy) are not yet applied by the compiler, so accepting them would silently ignore the filtering they imply and leak unfiltered data. Rejected to fail closed.`);
    for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) scan(node.getChild(i));
  };
  scan(tree);
}

export function compile(gremlin: string, params: Record<string, any>): Compiled | WritePlan {
  const tree = parseGremlin(gremlin);
  rejectUnsupportedStrategies(tree);
  const steps = stepChain(tree, params);
  if (steps.length === 0) throw new Error('empty traversal');

  // v4 iterate() appends discard(): execute, return nothing
  let discard = false;
  const last = steps[steps.length - 1];
  if (last.name === 'discard' || last.name === 'none') { steps.pop(); discard = true; }

  let plan: Compiled | WritePlan;
  if (steps.some((s) => s.name === 'addE')) plan = compileAddE(steps, params);
  else if (steps[0].name === 'addV') plan = compileAddV(steps);
  else if (steps.some((s) => s.name === 'mergeV')) plan = compileMergeV(steps, params);
  else if (steps.some((s) => s.name === 'mergeE')) plan = compileMergeE(steps, params);
  else if (steps[0].name === 'inject') plan = compileInject(steps);
  else if (steps[steps.length - 1].name === 'drop') plan = compileDrop(steps);
  else if (steps.some((s) => s.name === 'property')) plan = compileSetProperty(steps, params);
  else plan = compileRead(steps, params);

  if (discard) {
    if (plan.kind === 'write') { const inner = plan.run; return { kind: 'write', run: (s) => { inner(s); return []; } }; }
    return { ...plan, shape: { kind: 'discard' } };
  }
  return plan;
}

/**
 * Build the movement/filter CTE prefix (the id-relation). Consumes V + the
 * filter/traversal/cardinality steps that compose as pure CTEs; stops at the
 * first order()/projection/other step and returns where it stopped. Shared by
 * reads and drop().
 */

/** A union() branch (currently a single out/in/both movement) → a SELECT of the
 *  neighbour node ids from `seed`. Non-movement / multi-step branches defer. */
function branchMovementSelect(bs: Step[], seed: Relation): Expression {
  if (bs.length !== 1 || (bs[0].name !== 'out' && bs[0].name !== 'in' && bs[0].name !== 'both'))
    throw new Error(`union() branch __.${bs.map((s) => s.name + '()').join('.')} not yet supported (single out()/in()/both() only)`);
  const mv = bs[0];
  const e = edges.as('e');
  const sel = dirsFor(mv.name).map(([from, to]) =>
    q`SELECT ${e.c[to]} AS id FROM ${e} JOIN ${seed} ON ${e.c[from]}=${seed.c.id}${edgeLabelFilter(mv.args)}`);
  return list(sel, sqlText(' UNION ALL '));
}

/** Bound as() labels: label -> its carried column and the element kind it holds. */
type AliasMap = Map<string, { col: string; elem: Elem }>;

/** The SQL expr holding a labelled traverser's id (its carried alias column). */
function aliasIdExpr(label: string, aliases: AliasMap): string {
  const entry = aliases.get(label);
  if (!entry) throw new Error(`where("${label}"): no such label — as("${label}") was not seen`);
  return `p.${entry.col}`;
}

function traversalCtes(steps: Step[], params: Record<string, any> = {}): { ctes: CteDef[]; stop: number; indexKeys: Set<string>; aliases: AliasMap; elem: Elem } {
  const ctes: CteDef[] = [];
  const indexKeys = new Set<string>();
  // as('x') labels: label -> { synthetic column name (a0,a1,… — user strings
  // never enter SQL identifiers, injection-safe, and stable so a later
  // correlated subquery can reference them), element kind at bind time (so
  // select/project knows whether the label holds a vertex or an edge) }. Once
  // bound a label stays live to the end (Gremlin never unbinds one), so every
  // CTE after the bind carries every bound alias column forward from `p`.
  const aliases: AliasMap = new Map();
  const prev = () => ctes[ctes.length - 1].name;
  // The carried alias columns, in bind order (a0, a1, …).
  const aliasCols = () => [...aliases.values()].map((a) => a.col);
  // The previous CTE as a Relation: its columns are id + every carried alias
  // column, so `p.c.a0` resolves downstream. Optionally aliased (movement/filter
  // CTEs join it as `p`; the pass-through/dedup/repeat forms use it unaliased).
  const prevRel = (alias?: string) => {
    const r = relation(prev(), ['id', ...aliasCols()]);
    return alias ? r.as(alias) : r;
  };
  // `, p.a0, p.a1` — the carried alias columns, qualified by the given prev
  // relation; empty when no as() label is live.
  const carryFrag = (p: Relation): Expression => {
    const cols = aliasCols();
    return cols.length ? list(cols.map((c) => q`, ${p.c[c]}`), sqlText('')) : sqlText('');
  };
  // Each movement/filter step appends one CTE, named c0, c1, … by position.
  const push = (body: Expression, cols?: string[]) => ctes.push({ name: `c${ctes.length}`, body, cols });

  const first = steps[0];
  if (first.name !== 'V' && first.name !== 'E') throw new Error(`unsupported source step: ${first.name}`);
  let elem: Elem = first.name === 'E' ? 'edge' : 'node';
  const srcRel = elem === 'edge' ? edges : nodes;
  if (first.args.length > 0) {
    // V(...)/E(...) ids: numeric args match the rowid, string args match the
    // user id (uid). The id-relation carries rowids throughout, so a uid match
    // still projects `id` (the rowid).
    const nums = first.args.filter((a) => typeof a === 'number');
    const strs = first.args.filter((a) => typeof a === 'string');
    const clauses: Expression[] = [];
    if (nums.length) clauses.push(q`id IN (${list(nums.map(value), sqlText(','))})`);
    if (strs.length) clauses.push(q`uid IN (${list(strs.map(value), sqlText(','))})`);
    if (!clauses.length) throw new Error('V()/E() ids must be numbers or strings');
    push(q`SELECT id FROM ${srcRel} WHERE ${list(clauses, sqlText(' OR '))}`);
  } else {
    push(q`SELECT id FROM ${srcRel}`);
  }

  let i = 1;
  for (; i < steps.length; i++) {
    const s = steps[i];
    switch (s.name) {
      case 'as': {
        // Bind each label to the current traverser. Rebinds reuse the label's
        // column (default Pop = last). Emit a pass-through CTE that keeps id +
        // all carried alias columns, (re)setting the bound ones to the current id.
        const labels = s.args.filter((a): a is string => typeof a === 'string');
        const rebind: string[] = [];
        for (const lbl of labels) {
          let entry = aliases.get(lbl);
          if (!entry) { entry = { col: `a${aliases.size}`, elem }; aliases.set(lbl, entry); }
          else entry.elem = elem; // rebind: default Pop = last, and re-capture kind
          rebind.push(entry.col);
        }
        const cols = ['id', ...[...aliases.values()].map((a) => rebind.includes(a.col) ? `id AS ${a.col}` : a.col)];
        push(q`SELECT ${cols.join(', ')} FROM ${prevRel()}`);
        break;
      }
      case 'hasLabel': {
        const n = (elem === 'edge' ? edges : nodes).as('n');
        const p = prevRel('p');
        push(q`SELECT ${n.c.id}${carryFrag(p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${labelIn('n.label', s.args)}`);
        break;
      }
      case 'has': {
        const n = (elem === 'edge' ? edges : nodes).as('n');
        const p = prevRel('p');
        const conds: Expression[] = [];
        let a = s.args;
        // has(label, key, value) — the 3-arg overload folds in a label filter.
        if (a.length === 3 && typeof a[0] === 'string') {
          conds.push(q`n.label IN (SELECT id FROM labels WHERE name=${value(a[0])})`);
          a = a.slice(1);
        }
        const [key, val] = a;
        if (key && typeof key === 'object' && 'token' in key) {
          // has(T.label, v|P) / has(T.id, v|P): predicate over the label name or
          // the external id (COALESCE uid,id). Routing through predicateSql means
          // both a bare value AND a P/TextP predicate work (a bare value → equality).
          const expr: Expression = key.token === 'label' ? q`(SELECT name FROM labels WHERE id=${n.c.label})`
            : key.token === 'id' ? q`COALESCE(${n.c.uid}, ${n.c.id})`
            : (() => { throw new Error(`has(T.${key.token}) not supported`); })();
          conds.push(predicateSql(expr, val));
        } else {
          const pe = propExtract('n.props', key); // literal path for indexable keys
          // Only node property indexes are auto-built (ensureNodePropIndex); an
          // edge has() filters correctly but stays unindexed for now.
          if (pe.indexKey && elem === 'node') indexKeys.add(pe.indexKey);
          conds.push(predicateSql(pe.expr, val));
        }
        push(q`SELECT ${n.c.id}${carryFrag(p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${list(conds, sqlText(' AND '))}`);
        break;
      }
      case 'where': case 'filter': case 'not': {
        // A movement-phase filter CTE: join the current element (for property
        // predicates) and keep rows satisfying the nested traversal. `not()`
        // negates with COALESCE so a NULL predicate (missing prop) counts as
        // "no output" → kept, matching not(traversal) semantics.
        const arg0 = s.args[0];
        const n = (elem === 'edge' ? edges : nodes).as('n');
        const p = prevRel('p');
        const ctx: ScalarCtx = { elem, idExpr: 'n.id', propsExpr: 'n.props', labelIdExpr: 'n.label', srcExpr: 'n.src', tgtExpr: 'n.tgt' };
        let testNode: Expression;
        if (arg0 && typeof arg0 === 'object' && 'nested' in arg0) {
          const pred = compileFilterPredicate(stepChain(arg0.nested, params), ctx, params);
          for (const k of pred.indexKeys) indexKeys.add(k);
          testNode = s.name === 'not' ? lsql(sqlText('NOT COALESCE(('), pred.expr, sqlText('), 0)')) : pred.expr;
        } else {
          // Alias-compare: where("a", P.eq("b")) (label vs label) or
          // where(P.neq("a")) (current traverser vs label), optionally .by(key)
          // to compare a property instead of element identity.
          if (s.name === 'filter') throw new Error('filter(predicate) not supported; use filter(traversal)');
          const [left, pred, leftElem]: [string, Pred, Elem] = typeof arg0 === 'string'
            ? [aliasIdExpr(arg0, aliases), s.args[1] as Pred, aliases.get(arg0)!.elem]
            : ['n.id', arg0 as Pred, elem];
          if (!(pred?.op in P_OPS)) throw new Error(`where(P.${pred?.op}) alias comparison not yet supported`);
          const right = aliasIdExpr(pred.values[0], aliases);
          const rightElem = aliases.get(pred.values[0])!.elem;
          const byKey = steps[i + 1]?.name === 'by' ? steps[i + 1].args.find((a) => typeof a === 'string') as string | undefined : undefined;
          if (byKey !== undefined) {
            // propAt reads the nodes table; an edge-typed operand would silently
            // read a vertex's props (ids collide across spaces) → reject.
            if (leftElem === 'edge' || rightElem === 'edge') throw new Error('where().by(key) on an edge-typed label not yet supported');
            testNode = expression(propAt(left, null, byKey).expr, sqlText(P_OPS[pred.op]), propAt(right, null, byKey).expr);
            i++; // consume the by() modulator
          } else {
            testNode = sqlText(`${left} ${P_OPS[pred.op]} ${right}`);
          }
          if (s.name === 'not') testNode = lsql(sqlText('NOT COALESCE(('), testNode, sqlText('), 0)'));
        }
        push(q`SELECT ${n.c.id}${carryFrag(p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${testNode}`);
        break;
      }
      case 'and': case 'or': {
        // Filter: keep the traverser when ALL / ANY branch predicates hold.
        const n = (elem === 'edge' ? edges : nodes).as('n');
        const p = prevRel('p');
        const ctx: ScalarCtx = { elem, idExpr: 'n.id', propsExpr: 'n.props', labelIdExpr: 'n.label', srcExpr: 'n.src', tgtExpr: 'n.tgt' };
        const pred = combineBranchPreds(s, ctx, params, s.name === 'and' ? 'AND' : 'OR');
        for (const k of pred.indexKeys) indexKeys.add(k);
        push(q`SELECT ${n.c.id}${carryFrag(p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${pred.expr}`);
        break;
      }
      case 'union': {
        // UNION ALL of each branch, seeded from the current relation. Element
        // branches only (each a single movement step); the merged id-relation
        // continues downstream. Aliased/edge/scalar/multi-hop branches defer.
        if (elem !== 'node') throw new Error('union() on edges not yet supported');
        if (aliases.size > 0) throw new Error('union() after as() not yet supported');
        const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
        if (branches.length < 2) throw new Error('union() needs at least two branches');
        const parts = branches.map((b) => branchMovementSelect(stepChain(b.nested, params), prevRel('p')));
        push(list(parts, sqlText(' UNION ALL ')));
        break;
      }
      case 'optional': {
        // optional(t) = t if it yields output, else the traverser itself. A
        // single out()/in() → LEFT JOIN: matches emit the neighbour(s), a miss
        // COALESCEs back to self. both()/multi-hop/aliased defer.
        if (elem !== 'node') throw new Error('optional() on edges not yet supported');
        if (aliases.size > 0) throw new Error('optional() after as() not yet supported');
        const bs = stepChain(s.args[0]?.nested, params);
        if (bs.length !== 1 || (bs[0].name !== 'out' && bs[0].name !== 'in'))
          throw new Error(`optional(__.${bs[0]?.name}()) not yet supported (single out()/in() only)`);
        const [from, to] = dirsFor(bs[0].name)[0];
        const e = edges.as('e');
        const p = prevRel('p');
        push(q`SELECT COALESCE(${e.c[to]}, ${p.c.id}) AS id FROM ${p} LEFT JOIN ${e} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(bs[0].args)}`);
        break;
      }
      case 'repeat': case 'emit': case 'times': case 'until': {
        // A repeat cluster: gather the contiguous repeat/emit/times/until run
        // (the modulators can sit either side of repeat()). Compile to a
        // WITH RECURSIVE walk(id, depth) seeded from the current relation.
        if (elem !== 'node') throw new Error('repeat() on edges not yet supported');
        if (aliases.size > 0) throw new Error('repeat() after as() not yet supported');
        // Gather one repeat cluster: the contiguous repeat/emit/times/until run,
        // stopping at the first REPEATED step name so a second repeat-loop isn't
        // swallowed — it compiles as a fresh cluster next iteration, correctly
        // chained on this one's output (e.g. repeat(out).times(2).repeat(in).times(1)).
        let j = i;
        const cluster: Step[] = [], seen = new Set<string>();
        while (j < steps.length && ['repeat', 'emit', 'times', 'until'].includes(steps[j].name) && !seen.has(steps[j].name)) {
          seen.add(steps[j].name); cluster.push(steps[j]); j++;
        }
        const rep = cluster.find((s) => s.name === 'repeat');
        if (!rep) throw new Error(`${s.name}() without repeat() not yet supported`);
        if (cluster.some((s) => s.name === 'until')) throw new Error('repeat().until() not yet supported');
        const emitStep = cluster.find((s) => s.name === 'emit');
        if (emitStep?.args.length) throw new Error('emit(predicate) not yet supported');
        const timesStep = cluster.find((s) => s.name === 'times');
        if (timesStep && typeof timesStep.args[0] !== 'number') throw new Error('times(predicate) not yet supported');
        // Require times(): it bounds depth to a user-given n. Unbounded forms
        // (bare emit() with no times, until()) would let the recursive walk fan
        // out to branching-factor^depth rows — deferred rather than risk exhaustion.
        if (!timesStep) throw new Error('repeat() without times() not yet supported (unbounded emit()/until() deferred)');
        const emitBefore = !!emitStep && cluster.indexOf(emitStep) < cluster.indexOf(rep);

        const body = stepChain(rep.args[0]?.nested, params);
        if (body.length !== 1 || !['out', 'in', 'both'].includes(body[0].name))
          throw new Error(`repeat(__.${body.map((s) => s.name + '()').join('.')}) not yet supported (single out()/in()/both() only)`);
        const mv = body[0];
        const maxDepth = Number(timesStep.args[0]); // always present (checked above) → bounded depth
        const w = `w${ctes.length}`;
        const wRel = relation(w, ['id', 'depth']);
        const e = edges.as('e');
        const rec = dirsFor(mv.name).map(([from, to]) =>
          q`SELECT ${e.c[to]} AS id, ${wRel.c.depth} + 1 AS depth FROM ${wRel} JOIN ${e} ON ${e.c[from]}=${wRel.c.id} WHERE ${wRel.c.depth} < ${maxDepth}${edgeLabelFilter(mv.args)}`);
        ctes.push({ name: w, cols: ['id', 'depth'], body: q`SELECT id, 0 AS depth FROM ${prevRel()} UNION ALL ${list(rec, sqlText(' UNION ALL '))}` });
        // times() only → the final depth; emit after → every iteration (≥1);
        // emit before → also the starting traverser (≥0).
        const depthCond = !emitStep ? `depth = ${maxDepth}` : emitBefore ? 'depth >= 0' : 'depth >= 1';
        push(q`SELECT id FROM ${wRel} WHERE ${depthCond}`);
        i = j - 1; // consume the whole cluster (loop's i++ steps past it)
        break;
      }
      case 'out': case 'in': case 'both': {
        if (elem !== 'node') throw new Error(`${s.name}() expects a vertex, not an ${elem}`);
        // Movement carries the alias columns unchanged from p while id moves to
        // the neighbour — this is what recovers "the vertex before the hop".
        const e = edges.as('e');
        const p = prevRel('p');
        const cf = carryFrag(p);
        const selects = dirsFor(s.name).map(([from, to]) =>
          q`SELECT ${e.c[to]} AS id${cf} FROM ${e} JOIN ${p} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(s.args)}`);
        push(list(selects, sqlText(' UNION ALL ')));
        break;
      }
      case 'outE': case 'inE': case 'bothE': {
        // vertex → incident edges. The new id is the EDGE id; elem becomes edge.
        if (elem !== 'node') throw new Error(`${s.name}() expects a vertex, not an ${elem}`);
        const froms = s.name === 'outE' ? ['src'] : s.name === 'inE' ? ['tgt'] : ['src', 'tgt'];
        const e = edges.as('e');
        const p = prevRel('p');
        const cf = carryFrag(p);
        const selects = froms.map((from) =>
          q`SELECT ${e.c.id} AS id${cf} FROM ${e} JOIN ${p} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(s.args)}`);
        push(list(selects, sqlText(' UNION ALL ')));
        elem = 'edge';
        break;
      }
      case 'outV': case 'inV': case 'bothV': {
        // edge → endpoint vertices. The new id is the NODE id; elem becomes node.
        if (elem !== 'edge') throw new Error(`${s.name}() expects an edge, not a ${elem}`);
        const cols = s.name === 'outV' ? ['src'] : s.name === 'inV' ? ['tgt'] : ['src', 'tgt'];
        const e = edges.as('e');
        const p = prevRel('p');
        const cf = carryFrag(p);
        const selects = cols.map((col) =>
          q`SELECT ${e.c[col]} AS id${cf} FROM ${e} JOIN ${p} ON ${e.c.id}=${p.c.id}`);
        push(list(selects, sqlText(' UNION ALL ')));
        elem = 'node';
        break;
      }
      case 'dedup':
        // Bare dedup() dedups on the current object. Splicing carried alias
        // columns into the DISTINCT would make it path-distinct and silently
        // over-count (the count()-corruption trap). Defer both label-scoped
        // dedup("a") and dedup-with-active-labels rather than answer wrongly.
        if (s.args.length > 0) throw new Error('dedup(label) not yet supported');
        if (aliases.size > 0) throw new Error('dedup() after as() not yet supported (path-distinct semantics)');
        push(q`SELECT DISTINCT id FROM ${prevRel()}`);
        break;
      // limit/range/skip compose as CTEs while still on the id-relation (before
      // any order()); once order() is seen they fold into the final select as
      // tail modifiers so ORDER BY + LIMIT + OFFSET stay in one query.
      case 'limit': {
        const p = prevRel('p');
        push(q`SELECT ${p.c.id}${carryFrag(p)} FROM ${p} LIMIT ${Number(s.args[0])}`);
        break;
      }
      case 'range': {
        const { offset, limit } = rangeToOffsetLimit(s.args);
        const p = prevRel('p');
        push(q`SELECT ${p.c.id}${carryFrag(p)} FROM ${p} LIMIT ${limit} OFFSET ${offset}`);
        break;
      }
      case 'skip': {
        const p = prevRel('p');
        push(q`SELECT ${p.c.id}${carryFrag(p)} FROM ${p} LIMIT -1 OFFSET ${Number(s.args[0])}`);
        break;
      }
      default:
        return { ctes, stop: i, indexKeys, aliases, elem };
    }
  }
  return { ctes, stop: i, indexKeys, aliases, elem };
}

interface OrderClause { key: string | null; dir: 'asc' | 'desc' | 'shuffle'; }

function compileRead(steps: Step[], params: Record<string, any> = {}): Compiled {
  const { ctes, stop, indexKeys, aliases, elem } = traversalCtes(steps, params);
  const last = ctes[ctes.length - 1].name;

  // properties() turns the traverser into a property (owner+key+value) — a shape
  // the node/edge id-relation can't carry, so it and its follow-ons (key/value/
  // element/count) compile in their own tail fn rather than the movement phase.
  if (steps[stop]?.name === 'properties')
    return compileProperties(ctes, last, elem, steps.slice(stop), indexKeys, params);

  // group()/groupCount() is a barrier over the current element stream → one Map.
  if (steps[stop]?.name === 'group' || steps[stop]?.name === 'groupCount') {
    const { bys, end } = collectBys(steps, stop);
    if (end < steps.length) throw new Error(`step not implemented after ${steps[stop].name}(): ${steps[end].name}()`);
    const tbl = elem === 'edge' ? 'edges' : 'nodes';
    const ctx: ScalarCtx = { elem, idExpr: 'n.id', extIdExpr: 'COALESCE(n.uid, n.id)', propsExpr: 'n.props', labelIdExpr: 'n.label', srcExpr: 'n.src', tgtExpr: 'n.tgt' };
    const src: GroupSource = { from: `${tbl} n JOIN ${last} p ON n.id=p.id`, ctx, elem: elem === 'edge' ? 'edge' : 'vertex' };
    return compileGroup(steps[stop].name === 'groupCount', bys, src, ctes, indexKeys, params);
  }

  // Tail phase: an optional projection + order()/range()/skip()/limit() and dedup.
  let projStep: Step | null = null;
  const orders: OrderClause[] = [];
  const bys: any[][] = []; // by() modulator arg-lists attached to a select/project
  let offset = 0, limit: number | null = null, distinct = false;
  let reducer: 'fold' | 'sum' | null = null; // terminal stream reducer applied after the projection
  const isPreds: any[] = []; // is(P) filters on the projected scalar (AND'd)

  const PROJECTIONS = new Set(['values', 'id', 'label', 'count', 'valueMap', 'elementMap', 'select', 'project']);
  const isMapProj = () => projStep?.name === 'select' || projStep?.name === 'project';

  for (let i = stop; i < steps.length; i++) {
    const s = steps[i];
    if (PROJECTIONS.has(s.name)) {
      if (projStep) throw new Error('only one projection step is supported per traversal');
      projStep = s;
      continue;
    }
    switch (s.name) {
      case 'order':
        // by() modulators (next steps) attach to this order; a bare order() with
        // no by() orders by element identity.
        if (steps[i + 1]?.name !== 'by') orders.push({ key: null, dir: 'asc' });
        break;
      case 'by': {
        // A by() after select()/project() is a projection modulator; otherwise
        // it modulates a preceding order().
        if (isMapProj()) { bys.push(s.args); break; }
        if (orders.length === 0 && steps[i - 1]?.name !== 'order')
          throw new Error('by() is only supported as an order() or select()/project() modulator');
        // Reject deferred modulators (mirror byToEntry) rather than let a
        // {token}/{nested} arg fall through to key=null and silently sort by id.
        const bad = s.args.find((a) => a && typeof a === 'object' && ('token' in a || 'nested' in a));
        if (bad) throw new Error('token' in bad ? `by(T.${bad.token}) modulator not yet supported` : 'by(traversal) modulator not yet supported');
        const key = s.args.find((a) => typeof a === 'string') ?? null;
        const ord = s.args.find((a) => a && typeof a === 'object' && 'order' in a);
        orders.push({ key, dir: (ord?.order ?? 'asc') as OrderClause['dir'] });
        break;
      }
      case 'range': ({ offset, limit } = rangeToOffsetLimit(s.args)); break;
      case 'skip': offset = Number(s.args[0]); break;
      case 'limit': limit = Number(s.args[0]); break;
      case 'dedup': distinct = true; break;
      case 'is':
        // is() folds into the projection WHERE (before ORDER BY/LIMIT). That's
        // only correct if no limit/range/skip preceded it — filtering commutes
        // with order() but NOT with a limit that already truncated the stream.
        if (limit !== null || offset > 0) throw new Error('is() after limit()/range()/skip() not yet supported');
        isPreds.push(s.args[0]);
        break;
      // fold()/sum() are terminal barriers over the projected stream. They must
      // be last (nothing composes after them here yet).
      case 'fold': case 'sum':
        if (reducer) throw new Error(`${s.name}() after ${reducer}() not yet supported`);
        if (i !== steps.length - 1) throw new Error(`step not implemented after ${s.name}(): ${steps[i + 1].name}()`);
        reducer = s.name;
        break;
      default:
        throw new Error(`step not implemented: ${s.name}()`);
    }
  }

  if (isMapProj())
    return compileSelectProject(projStep!, bys, aliases, ctes, last, { orders, distinct, offset, limit }, indexKeys, elem);

  // Resolve the projection to a shape + a row source (cols/from/where).
  const projName = projStep?.name ?? 'vertex';
  let shape: Shape;

  if (reducer && projName === 'count') throw new Error(`${reducer}() after count() not yet supported`);

  // count folds any tail limit/offset/distinct into the counted id-relation.
  if (projName === 'count') {
    const inner = q`SELECT ${distinct ? 'DISTINCT ' : ''}id FROM ${relation(last, ['id'])}`;
    const innerLim = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : sqlText('');
    let countNode: Expression = q`SELECT COUNT(*) AS v FROM (${inner}${innerLim})`;
    // count().is(P): filter the single count value (0 or 1 result rows).
    if (isPreds.length)
      countNode = q`SELECT v FROM (${countNode}) WHERE ${list(isPreds.map((pr) => predicateSql(sqlText('v'), pr)), sqlText(' AND '))}`;
    return readCompiled(ctes, countNode, { kind: 'count' }, [...indexKeys]);
  }

  // The current element's table; `n` is the element row regardless of kind.
  const n = (elem === 'edge' ? edges : nodes).as('n');
  const p = relation(last, ['id']).as('p');
  const l = labels.as('l');
  const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const vlJoin = q`${vJoin} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
  let colsNode: Expression, fromNode: Expression;
  // The projected scalar expression, captured so a trailing is(P) can filter on
  // it. Non-scalar projections leave it null → is() throws. `baseWhere` is the
  // values() existence check (shares the same json_extract node as the select).
  let scalarExpr: Expression | null = null;
  let baseWhere: Expression | null = null;
  // An element reports its user id when it has one, else the rowid. Used only in
  // the outward-facing projection — the id-relation joins keep the raw rowid.
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  switch (projName) {
    case 'values': {
      shape = { kind: 'value' };
      const pe = propExtract('n.props', projStep!.args[0]);
      colsNode = q`${pe.expr} AS v`; fromNode = vJoin;
      baseWhere = predicateSql(pe.expr, undefined); // <pe> IS NOT NULL (same node → binds fall out per occurrence)
      scalarExpr = pe.expr;
      // values(k).is(P) is a filter-position use → auto-index the key (like has());
      // a bare values() projection is deliberately NOT indexed (bounds proliferation).
      if (isPreds.length && pe.indexKey && elem === 'node') indexKeys.add(pe.indexKey);
      break;
    }
    case 'id':
      // Join the element table even though the id lives in `last`, so a preceding
      // order().by(key) — which references n.props — has the alias in scope.
      shape = { kind: 'value' }; colsNode = q`${extId} AS v`; fromNode = vJoin; scalarExpr = extId; break;
    case 'label':
      shape = { kind: 'value' }; colsNode = q`${l.c.name} AS v`; fromNode = vlJoin; scalarExpr = l.c.name; break;
    case 'valueMap': {
      const keys = projStep!.args.filter((a) => typeof a === 'string') as string[];
      shape = { kind: 'valueMap', keys: keys.length ? keys : null, tokens: projStep!.args.includes(true) };
      colsNode = q`${extId} AS id, ${l.c.name} AS label, ${n.c.props}`; fromNode = vlJoin; break;
    }
    case 'elementMap': {
      if (elem === 'edge') throw new Error('elementMap() on edges not yet supported'); // needs IN/OUT direction tokens
      const keys = projStep!.args.filter((a) => typeof a === 'string') as string[];
      shape = { kind: 'elementMap', keys: keys.length ? keys : null };
      colsNode = q`${extId} AS id, ${l.c.name} AS label, ${n.c.props}`; fromNode = vlJoin; break;
    }
    default: // the element itself
      if (elem === 'edge') { shape = { kind: 'edge' }; colsNode = q`${extId} AS id, ${l.c.name} AS label, ${n.c.src}, ${n.c.tgt}, ${n.c.props}`; fromNode = vlJoin; }
      else { shape = { kind: 'vertex' }; colsNode = q`${extId} AS id, ${l.c.name} AS label, ${n.c.props}`; fromNode = vlJoin; }
  }

  // WHERE: the values() existence check + any is(P) on the projected scalar,
  // AND'd. is() on a non-scalar projection has no scalarExpr → reject.
  const whereParts: Expression[] = [];
  if (baseWhere) whereParts.push(baseWhere);
  if (isPreds.length) {
    if (!scalarExpr) throw new Error('is() requires a scalar stream (values/label/id/count)');
    for (const pr of isPreds) whereParts.push(predicateSql(scalarExpr, pr));
  }
  const whereNode: Expression = whereParts.length ? q` WHERE ${list(whereParts, sqlText(' AND '))}` : sqlText('');

  let orderNode: Expression = sqlText('');
  if (orders.length) {
    const keyNodes = orders.map((o) => {
      if (o.dir === 'shuffle') return sqlText('RANDOM()');
      const dir = o.dir === 'desc' ? ' DESC' : ' ASC';
      if (o.key !== null) {
        const pe = propExtract('n.props', o.key);
        if (pe.indexKey && elem === 'node') indexKeys.add(pe.indexKey); // order().by(key) sorts via the index (node-only auto-index)
        return q`${pe.expr}${dir}`;
      }
      return sqlText(`${shape.kind === 'value' ? 'v' : 'n.id'}${dir}`);
    });
    orderNode = q` ORDER BY ${list(keyNodes, sqlText(', '))}`;
  }
  const limitNode: Expression = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : sqlText('');

  let tailNode: Expression = q`SELECT ${distinct ? 'DISTINCT ' : ''}${colsNode} FROM ${fromNode}${whereNode}${orderNode}${limitNode}`;

  // Terminal reducers wrap the projected select. fold() → the whole stream as one
  // List (handler collapses rows); sum() → one numeric via SQL SUM.
  if (reducer === 'fold') {
    const fe: ElemShape | 'scalar' =
      shape.kind === 'vertex' ? 'vertex' : shape.kind === 'edge' ? 'edge' :
      shape.kind === 'value' ? 'scalar' : (() => { throw new Error(`fold() of ${shape.kind} not yet supported`); })();
    shape = { kind: 'list', elem: fe };
  } else if (reducer === 'sum') {
    if (shape.kind !== 'value') throw new Error(`sum() of ${shape.kind} not yet supported`);
    // typeof(SUM) is 'integer' or 'real' → the handler frames Int/Long vs Double
    // to match TinkerPop (sum of ints → Int/Long by magnitude; of doubles → Double).
    tailNode = q`SELECT SUM(v) AS v, typeof(SUM(v)) AS vt FROM (${tailNode})`;
    shape = { kind: 'scalar' };
  }

  return readCompiled(ctes, tailNode, shape, [...indexKeys]);
}

interface TailMods { orders: OrderClause[]; distinct: boolean; offset: number; limit: number | null; }

/** Interpret one by() modulator's args into a projected sub-value kind. */
function byToEntry(byArgs: any[] | undefined): { sub: 'vertex' | 'value'; key?: string } {
  if (!byArgs || byArgs.length === 0) return { sub: 'vertex' }; // no by() / bare by() → the element itself
  const a = byArgs[0];
  if (typeof a === 'string') return { sub: 'value', key: a };
  if (a && typeof a === 'object' && 'nested' in a) throw new Error('by(traversal) modulator not yet supported');
  if (a && typeof a === 'object' && 'token' in a) throw new Error(`by(T.${a.token}) modulator not yet supported`);
  throw new Error('unsupported by() modulator');
}

/**
 * select(labels…)/project(keys…). select reads previously-labelled traversers
 * from their alias columns; project applies its by() modulators to the current
 * traverser under freshly-named keys. by() modulators cycle across the keys
 * (`by('name')` alone → applied to all; `.by('age').by('name')` → key0/key1/…).
 * A single-key select reuses the scalar vertex/value shape; anything else is a
 * per-row Map ({kind:'map'}).
 */
function compileSelectProject(
  proj: Step, bys: any[][], aliases: AliasMap,
  ctes: CteDef[], last: string, tail: TailMods, indexKeys: Set<string>, curElem: Elem,
): Compiled {
  const { orders, distinct, offset, limit } = tail;
  if (orders.length) throw new Error('order() after select()/project() not yet supported');
  const isProject = proj.name === 'project';

  // Reject the deferred long-tail forms explicitly (tokens are now captured, not
  // silently dropped) so a Pop/Column arg can never mis-execute as a plain key.
  const pop = proj.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) not yet supported`);
  if (proj.args.some((a) => a && typeof a === 'object' && 'column' in a)) throw new Error('select(Column) not yet supported');

  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (!keys.length) throw new Error(`${proj.name}() requires at least one key`);

  // The `last`-CTE column holding each key's element id, and the element kind it
  // holds: project → current traverser (p.id); select → the label's alias column
  // (must have been bound). The joins below assume a vertex — an edge-typed
  // source would silently join the wrong table (nodes), so reject it clearly
  // (edge-valued select/project waits on the edge-shape map work).
  const sourceOf = (k: string): string => {
    if (isProject) {
      if (curElem === 'edge') throw new Error('project() of an edge is not yet supported');
      return 'p.id';
    }
    const entry = aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    if (entry.elem === 'edge') throw new Error(`select("${k}") of an edge-typed label is not yet supported`);
    return `p.${entry.col}`;
  };
  const entryKind = (i: number) => byToEntry(bys.length ? bys[i % bys.length] : undefined);

  const tailSql = (limit !== null || offset > 0) ? ` LIMIT ${limit ?? -1} OFFSET ${offset}` : '';
  const dist = distinct ? 'DISTINCT ' : '';

  const p = relation(last, ['id']).as('p');

  // Single-key select → the labelled element directly (not wrapped in a Map),
  // reusing the existing vertex/value shapes so the handler needs no new case.
  if (!isProject && keys.length === 1) {
    const src = sourceOf(keys[0]);
    const e = entryKind(0);
    const n = nodes.as('n');
    if (e.sub === 'vertex') {
      const l = labels.as('l');
      return readCompiled(ctes, q`SELECT ${dist}COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${n.c.props} FROM ${n} JOIN ${p} ON ${n.c.id}=${src} JOIN ${l} ON ${l.c.id}=${n.c.label}${tailSql}`, { kind: 'vertex' }, [...indexKeys]);
    }
    // A by(key) here is a projection, not a filter/order — deliberately NOT
    // reported as an indexKey (matches values(); bounds index proliferation).
    const pe = propExtract('n.props', e.key);
    return readCompiled(ctes, q`SELECT ${dist}${pe.expr} AS v FROM ${n} JOIN ${p} ON ${n.c.id}=${src}${tailSql}`, { kind: 'value' }, [...indexKeys]);
  }

  // Multi-key select / any project → a Map per row. Each entry joins nodes for
  // its source element under a distinct alias and emits prefixed columns.
  const cols: Expression[] = [];
  const joins: Expression[] = [];
  const entries: MapEntry[] = keys.map((k, i) => {
    const prefix = `e${i}`;
    const e = entryKind(i);
    const src = sourceOf(k);
    const en = nodes.as(`${prefix}n`);
    joins.push(q` JOIN ${en} ON ${en.c.id}=${src}`);
    if (e.sub === 'vertex') {
      const el = labels.as(`${prefix}l`);
      joins.push(q` JOIN ${el} ON ${el.c.id}=${en.c.label}`);
      cols.push(q`COALESCE(${en.c.uid}, ${en.c.id}) AS ${prefix}_id, ${el.c.name} AS ${prefix}_label, ${en.c.props} AS ${prefix}_props`);
    } else {
      cols.push(q`${propExtract(`${prefix}n.props`, e.key).expr} AS ${prefix}_v`); // projection, not indexed
    }
    return { key: k, prefix, sub: e.sub };
  });

  const node = q`SELECT ${dist}${list(cols, sqlText(', '))} FROM ${p}${list(joins, sqlText(''))}${tailSql}`;
  return readCompiled(ctes, node, { kind: 'map', entries }, [...indexKeys]);
}

// ---------- group()/groupCount() (barrier → one Map) ----------

/** Describes the row source a group() folds over: the FROM (rows aliased `n`),
 *  the scalar context for nested key/value sub-traversals, and the element kind
 *  a bare key / element value frames as. */
interface GroupSource { from: string; ctx: ScalarCtx; elem: ElemShape; }

/** Columns that frame one element (vertex/edge/property) under `prefix`, using
 *  base exprs from ctx. label rides as a subquery so the FROM needs no labels join. */
function elementSelect(elem: ElemShape, prefix: string, ctx: ScalarCtx): string {
  if (elem === 'edge')
    return `${ctx.extIdExpr ?? ctx.idExpr} AS ${prefix}_id, ${labelNameSub(ctx.labelIdExpr)} AS ${prefix}_label, ${ctx.srcExpr} AS ${prefix}_src, ${ctx.tgtExpr} AS ${prefix}_tgt, ${ctx.propsExpr} AS ${prefix}_props`;
  if (elem === 'property')
    return `${ctx.ownerExpr} AS ${prefix}_owner, ${ctx.pkExpr} AS ${prefix}_pk, ${ctx.pvExpr} AS ${prefix}_pv`;
  return `${ctx.extIdExpr ?? ctx.idExpr} AS ${prefix}_id, ${labelNameSub(ctx.labelIdExpr)} AS ${prefix}_label, ${ctx.propsExpr} AS ${prefix}_props`;
}

/** The SQL expr to GROUP BY / frame an element by identity. */
const elementIdExpr = (elem: ElemShape, ctx: ScalarCtx) =>
  elem === 'property' ? ctx.pkExpr! : ctx.idExpr;

/** Collect the by() modulator arg-lists immediately following step `i`; returns
 *  them plus the index of the first non-by step (for trailing-step rejection). */
function collectBys(steps: Step[], i: number): { bys: any[][]; end: number } {
  const bys: any[][] = [];
  let j = i + 1;
  for (; j < steps.length && steps[j].name === 'by'; j++) bys.push(steps[j].args);
  return { bys, end: j };
}

interface GroupKeyBuild { desc: GroupKey; cols: Expression; group: string }

/** Build the key columns for group(). `params` re-parses nested project()/by(). */
function buildGroupKey(keyArgs: any[] | undefined, src: GroupSource, indexKeys: Set<string>, params: Record<string, any>): GroupKeyBuild {
  // Bare by() (or no key by()) → the element itself is the key.
  if (!keyArgs || keyArgs.length === 0) {
    if (src.elem === 'property') throw new Error('group().by() on a property element is not yet supported');
    return { desc: { kind: 'element', elem: src.elem }, cols: sqlText(elementSelect(src.elem, 'k', src.ctx)), group: elementIdExpr(src.elem, src.ctx) };
  }
  const a = keyArgs[0];
  if (typeof a === 'string') { // by('name')
    const pe = propExtract(src.ctx.propsExpr, a); // property ctx sets propsExpr = ownerProps
    if (pe.indexKey && src.elem === 'vertex') indexKeys.add(pe.indexKey);
    return { desc: { kind: 'scalar' }, cols: lsql(pe.expr, sqlText(' AS gk')), group: 'gk' };
  }
  if (a && typeof a === 'object' && 'token' in a) { // by(T.label)/by(T.id)
    const expr = a.token === 'label' ? labelNameSub(src.ctx.labelIdExpr) : a.token === 'id' ? src.ctx.idExpr : null;
    if (!expr) throw new Error(`group().by(T.${a.token}) not yet supported`);
    return { desc: { kind: 'scalar' }, cols: sqlText(`${expr} AS gk`), group: 'gk' };
  }
  if (a && typeof a === 'object' && 'nested' in a) {
    const inner = stepChain(a.nested, params);
    if (inner[0]?.name === 'project') { // composite Map key
      const keys = inner[0].args.filter((x: any): x is string => typeof x === 'string');
      const partBys = inner.slice(1);
      if (partBys.some((s) => s.name !== 'by')) throw new Error(`step not implemented in group().by(project): ${partBys.find((s) => s.name !== 'by')!.name}()`);
      if (partBys.length !== keys.length) throw new Error('group().by(project) needs one by() per key');
      const cols: Expression[] = [], group: string[] = [];
      keys.forEach((k, idx) => {
        const nb = partBys[idx].args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
        if (!nb) throw new Error('group().by(project(...).by(x)) requires a traversal in each by()');
        const sc = compileNestedScalar(stepChain(nb.nested, params), src.ctx);
        cols.push(lsql(sc.expr, sqlText(` AS k${idx}_v`))); group.push(`k${idx}_v`);
      });
      return { desc: { kind: 'map', parts: keys.map((k) => ({ key: k })) }, cols: list(cols, sqlText(', ')), group: group.join(', ') };
    }
    const sc = compileNestedScalar(inner, src.ctx); // by(__.label()) etc → scalar
    return { desc: { kind: 'scalar' }, cols: lsql(sc.expr, sqlText(' AS gk')), group: 'gk' };
  }
  throw new Error('unsupported group().by() key modulator');
}

/**
 * group()/groupCount(): fold the whole stream into one Map. Dual-path (locked
 * decision #3): a scalar-reducing value (count/sum) or scalar list becomes a SQL
 * GROUP BY aggregate; an element value (default list / by(__.tail()) / fold of
 * elements) can't be aggregated in SQL (props must be framed), so we emit the
 * rows ORDER BY the key and the handler folds runs into the Map. Both shapes are
 * one Map buffer; the handler's assembler is one loop keyed on GroupVal.kind.
 */
function compileGroup(isCount: boolean, bys: any[][], src: GroupSource, ctes: CteDef[], indexKeys: Set<string>, params: Record<string, any>): Compiled {
  // Only key (bys[0]) and value (bys[1]) modulators are read; reject extras
  // rather than silently drop them (the file's no-silent-drop discipline).
  if (bys.length > 2) throw new Error('group() with more than two by() modulators not yet supported');
  const key = buildGroupKey(bys[0], src, indexKeys, params);

  // Resolve the value reducer.
  let val: GroupVal, valNode: Expression, groupBy = true;
  const valArgs = bys[1];
  if (isCount) { val = { kind: 'count' }; valNode = sqlText('COUNT(*) AS gv'); }
  else if (!valArgs || valArgs.length === 0) { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = sqlText(elementSelect(src.elem, 'v', src.ctx)); }
  else {
    const a = valArgs[0];
    if (typeof a === 'string') { // by('age') → list of scalars
      const pe = propExtract(src.ctx.propsExpr, a); // property ctx sets propsExpr = ownerProps
      val = { kind: 'scalarList' }; valNode = lsql(sqlText('json_group_array('), pe.expr, sqlText(') AS gv'));
    } else if (a && typeof a === 'object' && 'nested' in a) {
      const inner = stepChain(a.nested, params);
      const names = inner.map((s) => s.name);
      if (names.length === 1 && names[0] === 'tail') { val = { kind: 'elementLast', elem: src.elem }; groupBy = false; valNode = sqlText(elementSelect(src.elem, 'v', src.ctx)); }
      else if (names.length === 1 && names[0] === 'fold') { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = sqlText(elementSelect(src.elem, 'v', src.ctx)); }
      else if (names.length === 1 && names[0] === 'count') { val = { kind: 'count' }; valNode = sqlText('COUNT(*) AS gv'); }
      else if (names[names.length - 1] === 'sum') {
        const sc = compileNestedScalar(inner.slice(0, -1), src.ctx);
        val = { kind: 'sum' }; valNode = lsql(sqlText('SUM('), sc.expr, sqlText(') AS gv, typeof(SUM('), sc.expr, sqlText(')) AS gvt')); // gvt → Int/Long vs Double
      } else { // scalar projection folded to a list, e.g. by(__.label()) / by(__.values("name"))
        const sc = compileNestedScalar(inner, src.ctx);
        val = { kind: 'scalarList' }; valNode = lsql(sqlText('json_group_array('), sc.expr, sqlText(') AS gv'));
      }
    } else throw new Error('unsupported group().by() value modulator');
  }

  const node = lsql(sqlText('SELECT '), key.cols, sqlText(', '), valNode,
    sqlText(` FROM ${src.from} ${groupBy ? 'GROUP BY' : 'ORDER BY'} ${key.group}`));
  return readCompiled(ctes, node, { kind: 'group', key: key.desc, val }, [...indexKeys]);
}

/**
 * properties()/properties(keys) on the current element, plus an optional single
 * follow-on: key()/value()/count(), or element()[.values(k)/.id()/.label()/
 * .count()]. The traverser is a property — a json_each expansion over the
 * owner's props — carrying owner id/label/props + the property key(pk)/value(pv).
 * Chains that traverse on past element() (e.g. properties().element().out()) and
 * property predicates (hasKey/hasValue) are deferred to later work.
 */
function compileProperties(
  ctes: CteDef[], last: string, elem: Elem, tail: Step[], indexKeys: Set<string>,
  params: Record<string, any> = {},
): Compiled {
  const tbl = elem === 'edge' ? 'edges' : 'nodes';
  const keys = tail[0].args.filter((a): a is string => typeof a === 'string');
  const keyFilter: Expression = keys.length
    ? lsql(sqlText(' WHERE je.key IN ('), list(keys.map(value), sqlText(',')), sqlText(')'))
    : sqlText('');
  // Expand each element's JSON props into (owner, key, value) rows; keep the
  // owner's label/props too so a following element() projection has them.
  const pc = `c${ctes.length}`;
  const propBody = lsql(sqlText(`SELECT n.id AS owner, l.name AS ownerLabel, n.props AS ownerProps, je.key AS pk, je.value AS pv FROM ${tbl} n JOIN ${last} p ON n.id=p.id JOIN labels l ON l.id=n.label, json_each(n.props) je`), keyFilter);
  const allCtes: CteDef[] = [...ctes, { name: pc, body: propBody }];
  // `consumed` = how many tail steps this shape accounts for; reject any trailing
  // steps rather than silently dropping them (matches the file's discard-discipline).
  const done = (node: Expression, shape: Shape, consumed: number): Compiled => {
    if (tail.length > consumed)
      throw new Error(`step not implemented after properties(): ${tail[consumed].name}()`);
    return readCompiled(allCtes, node, shape, [...indexKeys]);
  };

  const next = tail[1]?.name;

  // properties().group()/.groupCount() — group over the property stream. The
  // gate's getVertexProperties() caching traversal lives here.
  if (next === 'group' || next === 'groupCount') {
    const { bys, end } = collectBys(tail, 1);
    if (end < tail.length) throw new Error(`step not implemented after properties().${next}(): ${tail[end].name}()`);
    const ctx: ScalarCtx = { elem: 'property', idExpr: 'owner', propsExpr: 'ownerProps', labelIdExpr: '(SELECT label FROM nodes WHERE id=owner)', ownerExpr: 'owner', ownerPropsExpr: 'ownerProps', pkExpr: 'pk', pvExpr: 'pv' };
    const src: GroupSource = { from: pc, ctx, elem: 'property' };
    return compileGroup(next === 'groupCount', bys, src, allCtes, indexKeys, params);
  }

  switch (next) {
    case undefined: // properties() terminal → VertexProperty elements
      return done(sqlText(`SELECT owner, pk, pv FROM ${pc}`), { kind: 'property' }, 1);
    case 'key':
      return done(sqlText(`SELECT pk AS v FROM ${pc}`), { kind: 'value' }, 2);
    case 'value':
      return done(sqlText(`SELECT pv AS v FROM ${pc}`), { kind: 'value' }, 2);
    case 'count':
      return done(sqlText(`SELECT COUNT(*) AS v FROM ${pc}`), { kind: 'count' }, 2);
    case 'element': {
      // Back to the owning element. Support a terminal projection off it.
      const after = tail[2]?.name;
      // Bare element() needs the full owner element; for an edge that means
      // src/tgt cols the property CTE doesn't carry, so defer just that case.
      // Scalar projections (.id/.label/.values/.count) need no such cols.
      if (elem === 'edge' && after === undefined)
        throw new Error('element() of an edge property not yet supported');
      switch (after) {
        case undefined:
          return done(sqlText(`SELECT owner AS id, ownerLabel AS label, ownerProps AS props FROM ${pc}`), { kind: 'vertex' }, 2);
        case 'id':
          return done(sqlText(`SELECT owner AS v FROM ${pc}`), { kind: 'value' }, 3);
        case 'label':
          return done(sqlText(`SELECT ownerLabel AS v FROM ${pc}`), { kind: 'value' }, 3);
        case 'values': {
          const pe = propExtract('ownerProps', tail[2].args[0]); // same node in SELECT + WHERE → binds fall out per occurrence
          return done(lsql(sqlText('SELECT '), pe.expr, sqlText(` AS v FROM ${pc} WHERE `), predicateSql(pe.expr, undefined)), { kind: 'value' }, 3);
        }
        case 'count':
          return done(sqlText(`SELECT COUNT(*) AS v FROM ${pc}`), { kind: 'count' }, 3);
        default:
          throw new Error(`step not implemented after element(): ${after}()`);
      }
    }
    default:
      throw new Error(`step not implemented after properties(): ${next}()`);
  }
}

// g.V(...).<filters>.drop() — delete the target vertices and their incident
// edges. (Edge-valued drop, e.g. g.V().outE().drop(), waits on edge traversal.)
function compileDrop(steps: Step[]): WritePlan {
  const { ctes, stop, elem } = traversalCtes(steps.slice(0, -1));
  if (stop !== steps.length - 1)
    throw new Error(`drop() after ${steps[stop].name}() not yet supported`);
  if (elem === 'edge') throw new Error('edge drop() (e.g. g.E().drop()) not yet supported');
  const target = render(withPrefixTree(ctes, sqlText(`SELECT id FROM ${ctes[ctes.length - 1].name}`)));
  return {
    kind: 'write',
    run: (store) => {
      // Materialize the target ids ONCE, before mutating. If the traversal
      // reads the edges table (out()/in()/both() before drop()), deleting the
      // incident edges first would empty a re-evaluated target CTE, silently
      // leaving the vertices behind. Snapshot the ids, then delete by value.
      const ids = store.query<{ id: number }>(target.sql, target.binds).map((r) => r.id);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        store.query(`DELETE FROM edges WHERE src IN (${ph}) OR tgt IN (${ph})`, [...ids, ...ids]);
        store.query(`DELETE FROM nodes WHERE id IN (${ph})`, ids);
      }
      return [];
    },
  };
}

// g.V(x).<filters>.property(k, v)[.property(...)] — set properties on the
// matched existing element(s), single cardinality (last write wins). Reuses the
// read movement engine to pick the targets, snapshots their ids (drop()'s
// mutate-after-snapshot discipline), then JS-merges the new keys into each props
// bag and writes it back whole (preserves value types exactly, like addV).
// Multi-property (Cardinality.list/set) waits on W4's schema rework.
function compileSetProperty(steps: Step[], params: Record<string, any>): WritePlan {
  const firstProp = steps.findIndex((s) => s.name === 'property');
  const prefix = steps.slice(0, firstProp);
  const { ctes, stop, elem } = traversalCtes(prefix, params);
  if (stop !== prefix.length)
    throw new Error(`property() after ${steps[stop].name}() not yet supported`);
  const setProps: Record<string, any> = {};
  for (const s of steps.slice(firstProp)) {
    if (s.name !== 'property')
      throw new Error(`step not implemented after property(): ${s.name}()`);
    const [key, val] = stripCardinality(s.args);
    if (key && typeof key === 'object' && 'token' in key)
      throw new Error(`property(T.${key.token}) on an existing element not yet supported`);
    setProps[key] = val;
  }
  const tbl = elem === 'edge' ? 'edges' : 'nodes';
  const labelSub = `(SELECT name FROM labels WHERE id=${tbl}.label) AS label`;
  const readCur = elem === 'edge'
    ? `SELECT uid, src, tgt, props, ${labelSub} FROM edges WHERE id=?`
    : `SELECT uid, props, ${labelSub} FROM nodes WHERE id=?`;
  const target = render(withPrefixTree(ctes, sqlText(`SELECT id FROM ${ctes[ctes.length - 1].name}`)));
  return {
    kind: 'write',
    run: (store) => {
      const ids = store.query<{ id: number }>(target.sql, target.binds).map((r) => r.id);
      return ids.map((id) => {
        const cur = store.query<any>(readCur, [id])[0];
        const props = { ...JSON.parse(cur.props), ...setProps };
        store.query(`UPDATE ${tbl} SET props=? WHERE id=?`, [JSON.stringify(props), id]);
        // Edge endpoints expose the external id (COALESCE uid,id), consistent
        // with the addE/mergeE write paths (nodeExtId).
        return elem === 'edge'
          ? { edge: { id: cur.uid ?? id, label: cur.label, src: nodeExtId(store, cur.src), tgt: nodeExtId(store, cur.tgt), props } }
          : { vertex: { id: cur.uid ?? id, label: cur.label, props } };
      });
    },
  };
}

// g.inject(v1, v2, ...) — seed a value stream from constants. The collection /
// mid-traversal forms (and inject as a barrier) belong to the P2 select() work.
function compileInject(steps: Step[]): Compiled {
  if (steps.length !== 1) throw new Error('inject() with subsequent steps not yet supported');
  const vals = steps[0].args;
  if (vals.length === 0)
    return { kind: 'read', sql: `SELECT NULL AS v WHERE 0`, binds: [], shape: { kind: 'value' } };
  // Built entirely from lazyrecords nodes: WITH c0(v) AS (VALUES …) SELECT v FROM c0.
  // The injected values are Value tokens, so binds derive from the tree.
  const tree = lsql(withClause(
    [cte('c0', valuesClause(vals.map((v) => [v])), ['v'])],
    lsql(sqlText('select v from c0')),
  ));
  return compiled(tree, { kind: 'value' });
}

interface VertexSpec { label: string; props: Record<string, any>; uid: string | number | null; }

// A leading Cardinality token on property() args: `single` is a no-op we drop;
// list/set (real multi-property) wait on W4's schema rework. One place so every
// property()-consuming site (addV/addE/set) rejects list/set identically.
function stripCardinality(args: any[]): any[] {
  if (args[0] && typeof args[0] === 'object' && 'cardinality' in args[0]) {
    if (args[0].cardinality !== 'single') throw new Error(`property(Cardinality.${args[0].cardinality}) (multi-property) deferred to W4`);
    return args.slice(1);
  }
  return args;
}

// An addV(...) step + its trailing property() steps → a vertex spec.
// property(T.id, …)/property(T.label, …) set the id/label; the rest are data props.
function parseVertexSpec(addV: Step, propSteps: Step[]): VertexSpec {
  let label = (typeof addV.args[0] === 'string' ? addV.args[0] : null) ?? 'vertex';
  const props: Record<string, any> = {};
  let uid: string | number | null = null;
  for (const s of propSteps) {
    const a = stripCardinality(s.args);
    const [key, val] = a;
    if (key && typeof key === 'object' && 'token' in key) {
      if (key.token === 'id') uid = val;
      else if (key.token === 'label') label = String(val);
      else throw new Error(`property(T.${key.token}) not supported`);
      continue;
    }
    props[key] = val;
  }
  return { label, props, uid };
}

// Insert a vertex from a spec; returns its rowid and external id (uid ?? rowid).
// A numeric T.id writes the rowid directly; a string T.id becomes the uid.
function insertVertex(store: GraphStore, spec: VertexSpec): { id: number; extId: string | number } {
  const lid = store.labelId(spec.label);
  const uidCol = typeof spec.uid === 'string' ? spec.uid : null;
  const idCol = typeof spec.uid === 'number' ? spec.uid : null;
  const cols = ['label', 'props', ...(uidCol !== null ? ['uid'] : []), ...(idCol !== null ? ['id'] : [])];
  const vals: any[] = [lid, JSON.stringify(spec.props), ...(uidCol !== null ? [uidCol] : []), ...(idCol !== null ? [idCol] : [])];
  const row = store.query<{ id: number; uid: string | null }>(
    `INSERT INTO nodes(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')}) RETURNING id, uid`, vals)[0];
  return { id: row.id, extId: row.uid ?? row.id };
}

// g.addV('label').property(k, v)...  — and multi-element chains (a graph
// initializer, e.g. g.addV(a).addV(b)): the linear write interpreter. Like
// Gremlin, the stream after the chain is just the last created element.
function compileAddV(steps: Step[]): WritePlan {
  if (steps.some((s, i) => i > 0 && s.name !== 'property'))
    return { kind: 'write', run: (store) => runWriteChainFull(store, steps, {}) };
  const spec = parseVertexSpec(steps[0], steps.slice(1));
  return { kind: 'write', run: (store) => [{ vertex: { id: insertVertex(store, spec).extId, label: spec.label, props: spec.props } }] };
}

// An addE(label) + its trailing from/to/property modulators, plus the index of
// the first step that is NOT part of the cluster (so chains of addE parse).
interface EdgeCluster { label: string; fromSpec: any; toSpec: any; edgeUid: string | number | null; props: Record<string, any>; next: number; }
function parseEdgeCluster(steps: Step[], addEIdx: number): EdgeCluster {
  const label = steps[addEIdx].args[0];
  if (typeof label !== 'string') throw new Error('addE(label): nested-traversal label not supported');
  let fromSpec: any, toSpec: any, edgeUid: string | number | null = null;
  const props: Record<string, any> = {};
  let i = addEIdx + 1;
  for (; i < steps.length && (steps[i].name === 'from' || steps[i].name === 'to' || steps[i].name === 'property'); i++) {
    const m = steps[i];
    if (m.name === 'from') fromSpec = m.args[0];
    else if (m.name === 'to') toSpec = m.args[0];
    else {
      const [k, v] = stripCardinality(m.args);
      if (k && typeof k === 'object' && 'token' in k) { if (k.token === 'id') edgeUid = v; else throw new Error(`property(T.${k.token}) on an edge not supported`); }
      else props[k] = v;
    }
  }
  return { label, fromSpec, toSpec, edgeUid, props, next: i };
}

function nodeExtId(store: GraphStore, rowid: number): any {
  return store.query<{ x: any }>('SELECT COALESCE(uid, id) AS x FROM nodes WHERE id=?', [rowid])[0]?.x ?? rowid;
}

// Insert one edge from a cluster + resolved endpoints; returns the framed result.
function insertEdge(store: GraphStore, c: EdgeCluster, src: number, tgt: number): any {
  const lid = store.labelId(c.label);
  const uidCol = typeof c.edgeUid === 'string' ? c.edgeUid : null;
  const idCol = typeof c.edgeUid === 'number' ? c.edgeUid : null;
  const cols = ['src', 'label', 'tgt', 'props', ...(uidCol !== null ? ['uid'] : []), ...(idCol !== null ? ['id'] : [])];
  const vals: any[] = [src, lid, tgt, JSON.stringify(c.props), ...(uidCol !== null ? [uidCol] : []), ...(idCol !== null ? [idCol] : [])];
  const row = store.query<{ id: number; uid: string | null }>(
    `INSERT INTO edges(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')}) RETURNING id, uid`, vals)[0];
  return { edge: { id: row.uid ?? row.id, label: c.label, src: nodeExtId(store, src), tgt: nodeExtId(store, tgt), props: c.props } };
}

// Resolve a cluster's from()/to() (each an alias / nested __.V / the fallback
// traverser) and insert the edge. Shared by the read-mode and write-chain paths.
function applyEdgeCluster(store: GraphStore, c: EdgeCluster, aliases: Map<string, number>, fallback: number | null, params: Record<string, any>): any {
  const src = c.fromSpec !== undefined ? resolveEndpoint(store, c.fromSpec, { aliases }, params) : fallback;
  const tgt = c.toSpec !== undefined ? resolveEndpoint(store, c.toSpec, { aliases }, params) : fallback;
  if (src == null || tgt == null) throw new Error('addE needs both endpoints — supply from()/to() or an incoming traverser');
  return insertEdge(store, c, src, tgt);
}

// addE — general form. A pure write chain (addV/as/addE/from/to/property — a
// graph initializer, possibly many addE) goes to the sequential interpreter;
// otherwise it's a single addE with a V()-rooted prefix (mid-traversal), one
// edge per resulting traverser (outV = from() else the incoming, inV = to()
// else the incoming). from()/to() take an as() alias or a nested __.V(...).
function compileAddE(steps: Step[], params: Record<string, any>): WritePlan {
  const CHAIN = new Set(['addV', 'as', 'addE', 'from', 'to', 'property']);
  if (steps.every((s) => CHAIN.has(s.name)))
    return { kind: 'write', run: (store) => runWriteChainFull(store, steps, params) };

  const addEIdx = steps.findIndex((s) => s.name === 'addE');
  const cluster = parseEdgeCluster(steps, addEIdx);
  if (cluster.next !== steps.length) throw new Error(`step not implemented after addE(): ${steps[cluster.next].name}()`);
  const prefix = steps.slice(0, addEIdx);
  const t = traversalCtes(prefix, params);
  if (t.stop !== prefix.length) throw new Error(`addE after ${prefix[t.stop].name}() not yet supported`);
  const aliasCols: [string, string][] = [...t.aliases].map(([lbl, a]) => [lbl, a.col]);
  const read = render(withPrefixTree(t.ctes, sqlText(`SELECT ${['id', ...aliasCols.map(([, c]) => c)].join(', ')} FROM ${t.ctes[t.ctes.length - 1].name}`)));
  return {
    kind: 'write',
    run: (store) => store.query<any>(read.sql, read.binds).map((r) =>
      applyEdgeCluster(store, cluster, new Map(aliasCols.map(([lbl, c]) => [lbl, r[c]])), r.id, params)),
  };
}

// Interpret a linear write chain (addV/property/as/addE/from/to): vertices thread
// into as() aliases; each addE creates an edge (from/to = alias / nested __.V /
// the current vertex). Returns the last created element (Gremlin's 1→1 stream).
function runWriteChainFull(store: GraphStore, steps: Step[], params: Record<string, any>): any[] {
  const aliases = new Map<string, number>();
  let currentV: number | null = null;
  let last: any = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.name === 'addV') {
      const propSteps: Step[] = [];
      while (i + 1 < steps.length && steps[i + 1].name === 'property') propSteps.push(steps[++i]);
      const spec = parseVertexSpec(s, propSteps);
      const v = insertVertex(store, spec);
      currentV = v.id; last = { vertex: { id: v.extId, label: spec.label, props: spec.props } };
    } else if (s.name === 'as') {
      if (currentV == null) throw new Error('as() before any vertex in write chain');
      for (const lbl of s.args) if (typeof lbl === 'string') aliases.set(lbl, currentV);
    } else if (s.name === 'addE') {
      const cluster = parseEdgeCluster(steps, i);
      i = cluster.next - 1;
      last = applyEdgeCluster(store, cluster, aliases, currentV, params);
    } else throw new Error(`write-chain step not supported: ${s.name}()`);
  }
  return last ? [last] : [];
}

// Resolve an addE from()/to() endpoint to a node rowid: a string names an as()
// alias; a nested traversal is run and its FIRST matched vertex used.
function resolveEndpoint(store: GraphStore, spec: any, d: { aliases: Map<string, number> }, params: Record<string, any>): number {
  if (typeof spec === 'string') {
    const id = d.aliases.get(spec);
    if (id === undefined) throw new Error(`addE from/to("${spec}"): unknown as() label`);
    return id;
  }
  if (spec && typeof spec === 'object' && spec.nested) {
    const inner = stepChain(spec.nested, params);
    const t = traversalCtes(inner, params);
    if (t.stop !== inner.length) throw new Error(`addE endpoint traversal not supported past ${inner[t.stop].name}()`);
    const q = render(withPrefixTree(t.ctes, sqlText(`SELECT id FROM ${t.ctes[t.ctes.length - 1].name}`)));
    const rows = store.query<{ id: number }>(q.sql, q.binds);
    if (!rows.length) throw new Error('addE endpoint traversal matched no vertex');
    return rows[0].id;
  }
  throw new Error('addE from()/to() must be an as() label or a nested __.V(...) traversal');
}

// ---------- mergeV / mergeE (upsert) ----------

// A merge search/apply map, normalised from either a bound Map parameter (keys
// arrive as GraphBinary EnumValues) or an inline [k: v] literal (keys arrive as
// {token}/{direction} tags). label/id/outV/inV are the reserved T./Direction./
// Merge. keys; everything else is a data property.
interface MergeSpec { label: string | null; id: string | number | null; outV: any; inV: any; props: Record<string, any>; }

/** The reserved role a merge-map key plays (or a plain data-property key). */
function classifyMergeKey(k: any): { kind: 'label' | 'id' | 'outV' | 'inV' | 'prop'; name?: string } {
  const enumName = (typeName: string) => k && typeof k === 'object' && k.typeName === typeName ? String(k.elementName).toLowerCase() : null;
  const t = enumName('T') ?? (k && typeof k === 'object' && 'token' in k ? k.token : null);
  if (t) { if (t === 'label') return { kind: 'label' }; if (t === 'id') return { kind: 'id' }; throw new Error(`merge map key T.${t} not supported`); }
  const d = enumName('Direction') ?? (k && typeof k === 'object' && 'direction' in k ? k.direction : null);
  if (d) {
    if (d === 'out' || d === 'from') return { kind: 'outV' };
    if (d === 'in' || d === 'to') return { kind: 'inV' };
    throw new Error(`merge map key Direction.${d} not supported`);
  }
  return { kind: 'prop', name: String(k) };
}

/** A merge-map endpoint VALUE: a Merge.outV/inV token means "the incoming
 *  traverser" (mergeE mid-chain); otherwise it's a concrete endpoint id. */
function classifyMergeVal(v: any): any {
  const m = v && typeof v === 'object' ? (v.typeName === 'Merge' ? String(v.elementName).toLowerCase() : ('merge' in v ? v.merge : null)) : null;
  return m ? { incoming: m } : v;
}

function normalizeMergeMap(raw: any): MergeSpec {
  const spec: MergeSpec = { label: null, id: null, outV: undefined, inV: undefined, props: {} };
  if (raw == null) return spec; // mergeV(null) — match anything
  if (!(raw instanceof Map)) {
    if (raw && typeof raw === 'object' && 'nested' in raw) throw new Error('merge with a traversal argument (e.g. __.select(...)) not yet supported');
    throw new Error('merge argument must be a map ([k:v] / bound Map), null, or empty ([:])');
  }
  for (const [k, v] of raw) {
    const c = classifyMergeKey(k);
    if (c.kind === 'label') spec.label = String(v);
    else if (c.kind === 'id') spec.id = v;
    else if (c.kind === 'outV') spec.outV = classifyMergeVal(v);
    else if (c.kind === 'inV') spec.inV = classifyMergeVal(v);
    else spec.props[c.name!] = v;
  }
  return spec;
}

/** SELECT of the vertices matching a merge spec (label + id/uid + prop equality;
 *  an empty spec matches every vertex). Returns the columns write-framing needs. */
function mergeMatchQuery(spec: MergeSpec): { sql: string; binds: any[] } {
  const conds: string[] = [];
  const binds: any[] = [];
  if (spec.label != null) { conds.push('label IN (SELECT id FROM labels WHERE name=?)'); binds.push(spec.label); }
  if (spec.id != null) { conds.push(typeof spec.id === 'number' ? 'id=?' : 'uid=?'); binds.push(spec.id); }
  for (const [k, v] of Object.entries(spec.props)) {
    const pe = render(propExtract('props', k).expr);
    conds.push(`${pe.sql} = ?`); binds.push(...pe.binds, v);
  }
  return {
    sql: `SELECT id, uid, (SELECT name FROM labels WHERE id=nodes.label) AS label, props FROM nodes WHERE ${conds.length ? conds.join(' AND ') : '1'}`,
    binds,
  };
}

// The option(Merge.onCreate|onMatch, map) modulators following a merge step.
function parseMergeOptions(mods: Step[], step: string): { onCreate: MergeSpec | null; onMatch: MergeSpec | null } {
  let onCreate: MergeSpec | null = null, onMatch: MergeSpec | null = null;
  for (const s of mods) {
    if (s.name !== 'option') throw new Error(`step not implemented after ${step}(): ${s.name}()`);
    const [sel, mapArg] = s.args;
    if (!sel || typeof sel !== 'object' || !('merge' in sel))
      throw new Error(`${step} option() selector must be Merge.onCreate/onMatch`);
    const spec = normalizeMergeMap(mapArg);
    if (sel.merge === 'oncreate') onCreate = spec;
    else if (sel.merge === 'onmatch') onMatch = spec;
    else throw new Error(`${step} option(Merge.${sel.merge}) not supported`);
  }
  return { onCreate, onMatch };
}

// The incoming traversers a merge runs once per, evaluated at run time. A start
// step → one null driver (no vertex identity). A bare inject(v1,…) prefix → one
// null driver per injected value (so g.inject(a,b).mergeV runs twice, per the
// multiset semantics). A V()-rooted prefix → the matched vertex rowids (which a
// mergeE endpoint token Merge.outV/inV binds to).
function mergeDrivers(prefix: Step[], params: Record<string, any>): (store: GraphStore) => (number | null)[] {
  if (prefix.length === 0) return () => [null];
  if (prefix.length === 1 && prefix[0].name === 'inject') { const nulls = prefix[0].args.map(() => null); return () => nulls; }
  const t = traversalCtes(prefix, params);
  if (t.stop !== prefix.length) throw new Error(`merge after ${prefix[t.stop].name}() not yet supported`);
  const q = render(withPrefixTree(t.ctes, sqlText(`SELECT id FROM ${t.ctes[t.ctes.length - 1].name}`)));
  return (store) => store.query<{ id: number }>(q.sql, q.binds).map((r) => r.id);
}

// g.mergeV(map) [.option(Merge.onCreate, map)] [.option(Merge.onMatch, map)]
// Upsert by the search map: matches → emitted (props patched by onMatch); no
// match → one vertex created from the search map merged with onCreate. As a
// start step it runs once; mid-chain (g.V()....mergeV) it runs once per incoming
// traverser, re-querying each time so an earlier create is visible to a later one.
function compileMergeV(steps: Step[], params: Record<string, any>): WritePlan {
  const mvIdx = steps.findIndex((s) => s.name === 'mergeV');
  if (steps[mvIdx].args.length === 0)
    throw new Error('mergeV() with no argument (uses the incoming traverser as the map) not yet supported');
  const matchSpec = normalizeMergeMap(steps[mvIdx].args[0]);
  const { onCreate, onMatch } = parseMergeOptions(steps.slice(mvIdx + 1), 'mergeV');
  const drivers = mergeDrivers(steps.slice(0, mvIdx), params);
  const match = mergeMatchQuery(matchSpec);
  return {
    kind: 'write',
    run: (store) => {
      const out: any[] = [];
      for (const _driver of drivers(store)) {
        const matches = store.query<any>(match.sql, match.binds);
        if (matches.length) {
          for (const m of matches) {
            let props = JSON.parse(m.props);
            if (onMatch) { props = { ...props, ...onMatch.props }; store.query('UPDATE nodes SET props=? WHERE id=?', [JSON.stringify(props), m.id]); }
            out.push({ vertex: { id: m.uid ?? m.id, label: m.label, props } });
          }
        } else {
          const label = onCreate?.label ?? matchSpec.label ?? 'vertex';
          const props = { ...matchSpec.props, ...(onCreate?.props ?? {}) };
          const v = insertVertex(store, { label, props, uid: matchSpec.id ?? onCreate?.id ?? null });
          out.push({ vertex: { id: v.extId, label, props } });
        }
      }
      return out;
    },
  };
}

// Resolve a mergeE endpoint spec to a node rowid, requiring the vertex to exist
// (mergeE cannot create endpoints — matches TinkerPop's error). A rowid comes in
// from an incoming traverser; a user id (number/string) resolves through id/uid.
function resolveMergeEndpoint(store: GraphStore, raw: any): number {
  const r = store.query<{ id: number }>(
    typeof raw === 'number' ? 'SELECT id FROM nodes WHERE id=?' : 'SELECT id FROM nodes WHERE uid=?', [raw])[0];
  if (!r) throw new Error('Vertex does not exist for mergeE');
  return r.id;
}

// SELECT of edges matching a merge spec between two resolved endpoints.
function edgeMatchQuery(spec: MergeSpec, outV: number, inV: number): { sql: string; binds: any[] } {
  const conds = ['src=?', 'tgt=?'];
  const binds: any[] = [outV, inV];
  if (spec.label != null) { conds.push('label IN (SELECT id FROM labels WHERE name=?)'); binds.push(spec.label); }
  if (spec.id != null) { conds.push(typeof spec.id === 'number' ? 'id=?' : 'uid=?'); binds.push(spec.id); }
  for (const [k, v] of Object.entries(spec.props)) {
    const pe = render(propExtract('props', k).expr);
    conds.push(`${pe.sql} = ?`); binds.push(...pe.binds, v);
  }
  return { sql: `SELECT id, uid, src, tgt, (SELECT name FROM labels WHERE id=edges.label) AS label, props FROM edges WHERE ${conds.join(' AND ')}`, binds };
}

// g.mergeE(map) [.option(Merge.onCreate, map)] [.option(Merge.onMatch, map)]
// Upsert an edge keyed on (outV, inV, label, props). Endpoints come from the
// map's Direction.OUT/IN keys (a Merge.outV/inV value means the incoming
// traverser); both must exist. Mid-chain it runs per incoming traverser.
function compileMergeE(steps: Step[], params: Record<string, any>): WritePlan {
  const meIdx = steps.findIndex((s) => s.name === 'mergeE');
  if (steps[meIdx].args.length === 0)
    throw new Error('mergeE() with no argument (uses the incoming traverser as the map) not yet supported');
  const matchSpec = normalizeMergeMap(steps[meIdx].args[0]);
  const { onCreate, onMatch } = parseMergeOptions(steps.slice(meIdx + 1), 'mergeE');
  const drivers = mergeDrivers(steps.slice(0, meIdx), params);
  return {
    kind: 'write',
    run: (store) => {
      // An endpoint spec: a Merge.outV/inV token → the incoming traverser; else a
      // concrete id. onCreate can also supply the endpoints if the search map omits them.
      const endpoint = (spec: any, oc: any, cur: number | null, role: string): number => {
        const raw = spec?.incoming !== undefined ? cur : spec ?? (oc?.incoming !== undefined ? cur : oc);
        if (raw == null) throw new Error(`mergeE: missing ${role} endpoint (need Direction.${role === 'outV' ? 'OUT' : 'IN'} or an incoming traverser)`);
        return resolveMergeEndpoint(store, raw);
      };
      const out: any[] = [];
      for (const cur of drivers(store)) {
        const outV = endpoint(matchSpec.outV, onCreate?.outV, cur, 'outV');
        const inV = endpoint(matchSpec.inV, onCreate?.inV, cur, 'inV');
        const match = edgeMatchQuery(matchSpec, outV, inV);
        const matches = store.query<any>(match.sql, match.binds);
        if (matches.length) {
          for (const m of matches) {
            let props = JSON.parse(m.props);
            if (onMatch) { props = { ...props, ...onMatch.props }; store.query('UPDATE edges SET props=? WHERE id=?', [JSON.stringify(props), m.id]); }
            out.push({ edge: { id: m.uid ?? m.id, label: m.label, src: nodeExtId(store, m.src), tgt: nodeExtId(store, m.tgt), props } });
          }
        } else {
          const label = matchSpec.label ?? onCreate?.label;
          if (!label) throw new Error('mergeE cannot create an edge without a label');
          const props = { ...matchSpec.props, ...(onCreate?.props ?? {}) };
          out.push(insertEdge(store, { label, fromSpec: undefined, toSpec: undefined, edgeUid: matchSpec.id ?? onCreate?.id ?? null, props, next: 0 }, outV, inV));
        }
      }
      return out;
    },
  };
}
