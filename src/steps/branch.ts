import { q, list, Relation } from '../q.ts';
import { edges } from '../schema.ts';
import { stepChain, type Step } from '../frontend.ts';
import { dirsFor, edgeLabelFilter } from '../plan.ts';
import { advance, prevRel, type St, type StepFn } from './context.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';

// ---------- branch (union / optional / repeat) ----------

/** A union() branch (a single out/in/both movement) → a SELECT of the neighbour
 *  node ids from `seed`. Non-movement / multi-step branches defer. */
function branchMovementSelect(bs: Step[], seed: Relation): Expression {
  if (bs.length !== 1 || (bs[0].name !== 'out' && bs[0].name !== 'in' && bs[0].name !== 'both'))
    throw new Error(`union() branch __.${bs.map((s) => s.name + '()').join('.')} not yet supported (single out()/in()/both() only)`);
  const mv = bs[0];
  const e = edges.as('e');
  const sel = dirsFor(mv.name).map(([from, to]) =>
    q`SELECT ${e.c[to]} AS id FROM ${e} JOIN ${seed} ON ${e.c[from]}=${seed.c.id}${edgeLabelFilter(mv.args)}`);
  return list(sel, ' UNION ALL ');
}

/** union(): UNION ALL of each element branch, seeded from the current relation.
 *  Aliased/edge/scalar/multi-hop branches defer. */
export const union: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error('union() on edges not yet supported');
  if (st.aliases.size > 0) throw new Error('union() after as() not yet supported');
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) throw new Error('union() needs at least two branches');
  const parts = branches.map((b) => branchMovementSelect(stepChain(b.nested, st.params), prevRel(st, 'p')));
  return advance(st, list(parts, ' UNION ALL '));
};

/** optional(t) = t if it yields output, else the traverser itself. A single
 *  out()/in() → LEFT JOIN: matches emit the neighbour(s), a miss COALESCEs back
 *  to self. both()/multi-hop/aliased defer. */
export const optional: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error('optional() on edges not yet supported');
  if (st.aliases.size > 0) throw new Error('optional() after as() not yet supported');
  const bs = stepChain(s.args[0]?.nested, st.params);
  if (bs.length !== 1 || (bs[0].name !== 'out' && bs[0].name !== 'in'))
    throw new Error(`optional(__.${bs[0]?.name}()) not yet supported (single out()/in() only)`);
  const [from, to] = dirsFor(bs[0].name)[0];
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT COALESCE(${e.c[to]}, ${p.c.id}) AS id FROM ${p} LEFT JOIN ${e} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(bs[0].args)}`);
};

/** repeat(): the folded repeat/emit/times/until cluster (strategies.foldRepeat) →
 *  a WITH RECURSIVE walk(id, depth) seeded from the current relation. times()
 *  bounds the depth; emit before/after selects the depth band. Deferred forms
 *  (until, emit-pred, unbounded, complex body) throw here — the fold pass only
 *  gathered the cluster, it did not validate it. */
export const repeat: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error('repeat() on edges not yet supported');
  if (st.aliases.size > 0) throw new Error('repeat() after as() not yet supported');
  const cluster = s.cluster ?? [s];
  const rep = cluster.find((c) => c.name === 'repeat');
  if (!rep) throw new Error(`${s.name}() without repeat() not yet supported`);
  if (cluster.some((c) => c.name === 'until')) throw new Error('repeat().until() not yet supported');
  const emitStep = cluster.find((c) => c.name === 'emit');
  if (emitStep?.args.length) throw new Error('emit(predicate) not yet supported');
  const timesStep = cluster.find((c) => c.name === 'times');
  if (timesStep && typeof timesStep.args[0] !== 'number') throw new Error('times(predicate) not yet supported');
  // Require times(): it bounds depth to a user-given n. Unbounded forms (bare
  // emit() with no times, until()) would let the walk fan out to
  // branching-factor^depth rows — deferred rather than risk exhaustion.
  if (!timesStep) throw new Error('repeat() without times() not yet supported (unbounded emit()/until() deferred)');
  const emitBefore = !!emitStep && cluster.indexOf(emitStep) < cluster.indexOf(rep);

  const body = stepChain(rep.args[0]?.nested, st.params);
  if (body.length !== 1 || !['out', 'in', 'both'].includes(body[0].name))
    throw new Error(`repeat(__.${body.map((c) => c.name + '()').join('.')}) not yet supported (single out()/in()/both() only)`);
  const mv = body[0];
  const maxDepth = Number(timesStep.args[0]); // always present (checked above) → bounded depth

  const walk = st.q.recursiveCte(['id', 'depth'], (self: Relation) => {
    const e = edges.as('e');
    const rec = dirsFor(mv.name).map(([from, to]) =>
      q`SELECT ${e.c[to]} AS id, ${self.c.depth} + 1 AS depth FROM ${self} JOIN ${e} ON ${e.c[from]}=${self.c.id} WHERE ${self.c.depth} < ${maxDepth}${edgeLabelFilter(mv.args)}`);
    return q`SELECT id, 0 AS depth FROM ${st.last} UNION ALL ${list(rec, ' UNION ALL ')}`;
  });
  // times() only → final depth; emit after → every iteration (≥1); emit before →
  // also the starting traverser (≥0).
  const depthCond = !emitStep ? `depth = ${maxDepth}` : emitBefore ? 'depth >= 0' : 'depth >= 1';
  return advance(st, q`SELECT id FROM ${walk} WHERE ${depthCond}`);
};
