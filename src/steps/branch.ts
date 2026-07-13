import { q, list, Relation, type Expression } from '../q.ts';
import { edges } from '../schema.ts';
import { stepChain, type Step } from '../frontend.ts';
import { dirsFor, edgeLabelFilter, compileFilterPredicate, predicateSql, elemCtx, type ScalarCtx } from '../plan.ts';
import { advance, elemRel, prevRel, type St, type StepFn } from './context.ts';
import { foldBody } from './index.ts';

/** A ScalarCtx correlating on a walk row's current vertex id — its props/label are
 *  read back from `nodes` by subquery (the walk row carries only the id). Lets
 *  until()'s predicate reuse the where()/filter() predicate engine over each hop. */
const walkNodeCtx = (idExpr: Expression): ScalarCtx => {
  const sub = (col: string) => q`(SELECT ${col} FROM nodes WHERE id=${idExpr})`;
  return { elem: 'node', idExpr, extIdExpr: sub('COALESCE(uid, id)'), propsExpr: sub('props'), labelIdExpr: sub('label') };
};

/** Compile an until(<traversal>) modulator into `(id, depth) → boolean SQL`. A
 *  `loops().is(P)` body tests the depth counter; every other body is an element
 *  predicate over the current vertex (has/hasLabel/values/out…count().is/and/or),
 *  reusing compileFilterPredicate on a correlated ctx. */
function untilPredicate(untilStep: Step, params: Record<string, any>): (id: Expression, depth: Expression) => Expression {
  const nested = stepChain(untilStep.args[0]?.nested, params);
  if (!nested.length) throw new Error('until() requires a traversal predicate');
  if (nested[0].name === 'loops') {
    if (nested.length === 2 && nested[1].name === 'is') return (_id, depth) => predicateSql(depth, nested[1].args[0]);
    throw new Error('until(__.loops()…) form not yet supported (only loops().is(P))');
  }
  return (id) => compileFilterPredicate(nested, walkNodeCtx(id), params).expr;
}

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
  if (st.path) throw new Error('path tracking through union() not yet supported');
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
  if (st.path) throw new Error('path tracking through optional() not yet supported');
  const bs = stepChain(s.args[0]?.nested, st.params);
  if (bs.length !== 1 || (bs[0].name !== 'out' && bs[0].name !== 'in'))
    throw new Error(`optional(__.${bs[0]?.name}()) not yet supported (single out()/in() only)`);
  const [from, to] = dirsFor(bs[0].name)[0];
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT COALESCE(${e.c[to]}, ${p.c.id}) AS id FROM ${p} LEFT JOIN ${e} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(bs[0].args)}`);
};

/** repeat(): the folded repeat/emit/times/until cluster (strategies.foldRepeat) →
 *  a WITH RECURSIVE walk. times() bounds the depth (emit before/after selects the
 *  band). until() is a per-row termination predicate compiled to a `done` column —
 *  expand only from not-done rows, output done rows (do-while when until is after
 *  repeat, while-do when before); a 32-hop cap bounds it. Path tracking (JSONB
 *  array) and simplePath()'s cycle guard compose in. Deferred forms (emit-pred,
 *  until+times/emit, complex body) throw — the fold gathered the cluster, not validated it. */
export const repeat: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error('repeat() on edges not yet supported');
  if (st.aliases.size > 0) throw new Error('repeat() after as() not yet supported');
  const cluster = s.cluster ?? [s];
  const rep = cluster.find((c) => c.name === 'repeat');
  if (!rep) throw new Error(`${s.name}() without repeat() not yet supported`);
  const emitStep = cluster.find((c) => c.name === 'emit');
  if (emitStep?.args.length) throw new Error('emit(predicate) not yet supported');
  const timesStep = cluster.find((c) => c.name === 'times');
  if (timesStep && typeof timesStep.args[0] !== 'number') throw new Error('times(predicate) not yet supported');
  const untilStep = cluster.find((c) => c.name === 'until');
  const hasUntil = !!untilStep;
  // Interactions not built yet — fail closed rather than silently mis-terminate.
  if (hasUntil && timesStep) throw new Error('until() together with times() not yet supported');
  if (hasUntil && emitStep) throw new Error('until() together with emit() not yet supported');
  // Require a bound: times() (fixed depth) or until() (stop predicate). Neither would
  // fan out to branching-factor^depth rows — deferred.
  if (!timesStep && !hasUntil) throw new Error('repeat() without times() or until() not yet supported (unbounded emit() deferred)');
  const emitBefore = !!emitStep && cluster.indexOf(emitStep) < cluster.indexOf(rep);

  // Body: a single out/in/both, optionally followed by simplePath() (cycle-free walk).
  const body = stepChain(rep.args[0]?.nested, st.params);
  const mv = body[0];
  const simplePathInBody = body.length === 2 && body[1].name === 'simplePath';
  if (!mv || !['out', 'in', 'both'].includes(mv.name) || (body.length > 1 && !simplePathInBody))
    throw new Error(`repeat(__.${body.map((c) => c.name + '()').join('.')}) not yet supported (single out()/in()/both(), optional .simplePath())`);
  // times() → its fixed depth; until() → the 32-hop safety cap (documented deviation).
  const maxDepth = timesStep ? Number(timesStep.args[0]) : 32;

  // Path tracking. `wantsPathOutput`: a downstream path() (chain seeded st.path at V).
  // simplePath() in the body needs the accumulated path for its cycle guard even
  // when nothing outputs it. Either → accumulate a JSONB array through the walk.
  const wantsPathOutput = !!st.path;
  // Fail closed on path() spanning more than one movement segment: either a linear
  // hop before repeat (`cols` length > 1) OR a path already accumulated by a PRIOR
  // repeat cluster (`array`). Both would need the walk seeded from the carried path,
  // not a fresh jsonb_array(id) — deferred rather than silently dropping the prefix.
  if (wantsPathOutput && (st.path!.kind === 'array' || st.path!.cols.length > 1))
    throw new Error('path() spanning more than one repeat()/movement is not yet supported');
  if (wantsPathOutput && emitStep) throw new Error('emit() with path() not yet supported');
  const trackArray = wantsPathOutput || simplePathInBody;

  // until(): `done` = does the stop predicate hold for this row? do-while (until
  // AFTER repeat) leaves the seed untested (body runs ≥1×); while-do (until BEFORE)
  // tests the seed too. Expansion continues only from done=0 rows; done=1 rows exit.
  const untilFn = hasUntil ? untilPredicate(untilStep!, st.params) : null;
  const untilFirst = hasUntil && cluster.indexOf(untilStep!) < cluster.indexOf(rep);
  const doneCol = (id: Expression, depth: Expression): Expression => q`, CASE WHEN ${untilFn!(id, depth)} THEN 1 ELSE 0 END AS done`;

  const walkCols = ['id', 'depth', ...(trackArray ? ['path'] : []), ...(hasUntil ? ['done'] : [])];
  const walk = st.q.recursiveCte(walkCols, (self: Relation) => {
    const e = edges.as('e');
    const rec = dirsFor(mv.name).map(([from, to]) => {
      // Accumulate the visited-id path (jsonb — no text reparse per hop). simplePath
      // rejects revisiting any element already in the path (the cycle guard).
      const pathAcc = trackArray ? q`, jsonb_insert(${self.c.path}, '$[#]', ${e.c[to]}) AS path` : q``;
      const doneAcc = hasUntil ? doneCol(e.c[to], q`${self.c.depth} + 1`) : q``;
      const cycleGuard = simplePathInBody ? q` AND NOT EXISTS (SELECT 1 FROM json_each(${self.c.path}) je WHERE je.value=${e.c[to]})` : q``;
      const stillLooping = hasUntil ? q` AND ${self.c.done}=0` : q``; // until() expands only from looping rows
      return q`SELECT ${e.c[to]} AS id, ${self.c.depth} + 1 AS depth${pathAcc}${doneAcc} FROM ${self} JOIN ${e} ON ${e.c[from]}=${self.c.id} WHERE ${self.c.depth} < ${maxDepth}${stillLooping}${cycleGuard}${edgeLabelFilter(mv.args)}`;
    });
    // Only while-do (untilFirst) tests the SEED against until()'s correlated
    // `(SELECT props FROM nodes WHERE id=<seed id>)`; a bare `id` there would bind
    // BOTH sides to nodes.id (always true → wrong row), so alias the source (`w.id`).
    // Every other seed uses bare `id` (no subquery) → byte-identical to before.
    const seedSrc = untilFirst ? st.last.as('w') : st.last;
    const seedId = untilFirst ? seedSrc.c.id : q`id`;
    const seedSel = untilFirst ? q`${seedId} AS id` : q`id`; // do-while keeps bare `id` → byte-identical
    const seedPath = trackArray ? q`, jsonb_array(${seedId}) AS path` : q``;
    const seedDone = hasUntil ? (untilFirst ? doneCol(seedId, q`0`) : q`, 0 AS done`) : q``;
    return q`SELECT ${seedSel}, 0 AS depth${seedPath}${seedDone} FROM ${seedSrc} UNION ALL ${list(rec, ' UNION ALL ')}`;
  });
  // Output: until() → the rows that satisfied the stop predicate; else the depth band
  // (times() final depth; emit after → ≥1 iteration; emit before → also the seed, ≥0).
  const outWhere = hasUntil ? 'done = 1' : !emitStep ? `depth = ${maxDepth}` : emitBefore ? 'depth >= 0' : 'depth >= 1';
  // Expose the path column iff a path() will frame it; else drop it (the array was
  // internal to the walk, only there for simplePath's guard).
  if (wantsPathOutput)
    return advance(st, q`SELECT id, path FROM ${walk} WHERE ${outWhere}`, { path: { kind: 'array', col: 'path', elem: 'node' } });
  return advance(st, q`SELECT id FROM ${walk} WHERE ${outWhere}`);
};

// ---------- choose (predicate form) ----------

/** `NOT COALESCE((<pred>), 0)` — a NULL (missing prop) counts as false, so the
 *  else arm gets exactly the traversers the then arm didn't (mirrors filter.ts). */
const notCoalesce = (e: Expression): Expression => q`NOT COALESCE((${e}), 0)`;

/** Gate the current traverser relation by a boolean test → a one-column (id) seed
 *  CTE. choose()'s then/else arms fold from their gated seed; aliases/path are
 *  refused by choose() up front, so the seed carries only id. */
function gate(st: St, test: Expression): St {
  const n = elemRel(st);
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT ${n.c.id} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${test}`);
}

/**
 * choose(pred, then[, else]) — the predicate form. The predicate traversal compiles
 * to a correlated boolean (reusing the where()/filter() engine); the current stream
 * splits into two gated seeds (pred / NOT pred); each arm folds from its seed through
 * the movement/filter dispatch (multi-hop arms work); the two element id-relations
 * merge UNION ALL. Same-shape arms only (both node or both edge). else absent →
 * identity passthrough (the gated NOT-pred seed itself).
 *
 * Deferred (clear errors): the option-map form choose(choiceFn).option(k, t)… (needs
 * a strategies pass), scalar/projection arm bodies (values/count/fold — the id-relation
 * can't carry them), and choose() after as()/with path tracking.
 */
export const choose: StepFn = (s, st) => {
  if (st.aliases.size > 0) throw new Error('choose() after as() not yet supported');
  if (st.path) throw new Error('path tracking through choose() not yet supported');
  const args = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (args.length < 2 || args.length > 3)
    throw new Error('choose(): only the predicate form choose(pred, then[, else]) is supported (option-map form not yet supported)');
  const [predArg, thenArg, elseArg] = args;
  const pred = compileFilterPredicate(stepChain(predArg.nested, st.params), elemCtx(elemRel(st), st.elem), st.params);

  const arm = (arg: any, seed: St): St => {
    const body = stepChain(arg.nested, st.params);
    const { st: end, stop } = foldBody(body, seed, 0);
    if (stop !== body.length)
      throw new Error(`choose() branch __.${body.map((c) => c.name + '()').join('.')} not yet supported (scalar/projection body)`);
    return end;
  };

  const thenEnd = arm(thenArg, gate(st, pred.expr));
  const elseSeed = gate(st, notCoalesce(pred.expr));
  const elseEnd = elseArg ? arm(elseArg, elseSeed) : elseSeed; // else absent → identity
  if (thenEnd.elem !== elseEnd.elem)
    throw new Error('choose() branches produce different element kinds (mixed-shape) not yet supported');

  const merged = list([q`SELECT id FROM ${thenEnd.last}`, q`SELECT id FROM ${elseEnd.last}`], ' UNION ALL ');
  return advance(st, merged, { elem: thenEnd.elem, indexKeys: [...pred.indexKeys, ...thenEnd.indexKeys, ...elseEnd.indexKeys] });
};
