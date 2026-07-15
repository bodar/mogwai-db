import { q, value, list, Query } from '../q.ts';
import { jsonbArrayOf } from '../plan.ts';
import { flattenListArgs } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { type Carry } from './context.ts';
import { toListStream, toScalarStream } from './stream.ts';
import { lowerSteps } from './index.ts';
import { materializeFinal } from './materialize.ts';
import { type Compiled, type ValueType } from '../render.ts';
import {
  numericSpec, asBoolConst, asNumberConst, asNumberBare, asDateConst,
  dtFactor, dateDiffOtherMs,
} from './coerce.ts';

const CONST_COERCIONS = new Set(['asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff']);

/** Apply the leading coercion prefix while the inject values are still JS constants.
 * These steps have TinkerPop parse/overflow errors SQL cannot reproduce faithfully.
 * The returned index is the first ordinary step, which enters the shared relational
 * dispatcher. Later coercions remain normal scalar transforms (or fail closed there). */
function foldConstantCoercions(steps: PStep[], vals: any[]): { at: number; as?: ValueType } {
  let at = 1;
  let as: ValueType | undefined;
  for (; at < steps.length && CONST_COERCIONS.has(steps[at].name); at++) {
    const step = steps[at];
    if (step.name === 'asBool') {
      for (let i = 0; i < vals.length; i++) vals[i] = asBoolConst(vals[i]);
      as = 'bool';
      continue;
    }
    if (step.name === 'asNumber') {
      const spec = numericSpec(step.args[0]);
      if (spec) {
        for (let i = 0; i < vals.length; i++) vals[i] = asNumberConst(vals[i], spec);
        as = spec.as;
      } else {
        if (as === 'date') {
          as = 'long';
          continue;
        }
        const argTypes = at === 1 ? (steps[0].argTypes ?? []) : [];
        let uniform: ValueType | undefined;
        for (let i = 0; i < vals.length; i++) {
          const out = asNumberBare(vals[i], argTypes[i] ?? null);
          vals[i] = out.val;
          if (uniform === undefined) uniform = out.as;
          else if (uniform !== out.as)
            throw new Error('asNumber() over a stream of mixed numeric subtypes not yet supported');
        }
        as = uniform;
      }
      continue;
    }
    if (step.name === 'asDate') {
      const argTypes = at === 1 ? (steps[0].argTypes ?? []) : [];
      for (let i = 0; i < vals.length; i++) vals[i] = asDateConst(vals[i], argTypes[i] ?? null);
      as = 'date';
      continue;
    }
    if (step.name === 'dateAdd') {
      const delta = Number(step.args[1]) * dtFactor(step.args[0]);
      for (let i = 0; i < vals.length; i++) vals[i] = Number(vals[i]) + delta;
      as = 'date';
      continue;
    }
    const other = dateDiffOtherMs(step.args[0], {});
    for (let i = 0; i < vals.length; i++) vals[i] = Number(vals[i]) - other;
    as = 'long';
  }
  return { at, as };
}

/** g.inject(v1, v2, …) is now only a shaped source constructor. List literals seed
 * ListStream rows; ordinary values seed ScalarStream rows. Every following step is
 * handled by lowerSteps, the same lowering engine used after values()/unfold(). */
export function compileInject(steps: PStep[]): Compiled {
  const Q = new Query();
  const carry: Carry = { q: Q, params: {}, carried: { aliases: new Map(), origins: [] } };

  // Each all-array argument is one list traverser, not scalar varargs.
  if (steps[0].args.length >= 1 && steps[0].args.every((a: any) => Array.isArray(a))) {
    const rows = steps[0].args.map((a: any[]) => q`(${jsonbArrayOf(a)})`);
    const rel = Q.cte(q`VALUES ${list(rows, ', ')}`, ['list']);
    return materializeFinal(lowerSteps(toListStream(carry, rel, { kind: 'scalar' }), steps, 1));
  }

  // Mixed list/scalar inject remains the historical flattened representation until
  // ScalarStream gains a per-row shape/type discriminant.
  const vals = flattenListArgs(steps[0].args);
  const folded = foldConstantCoercions(steps, vals);
  const rel = vals.length
    ? Q.cte(q`VALUES ${list(vals.map((v) => q`(${value(v)})`), ', ')}`, ['v'])
    : Q.cte(q`SELECT NULL AS v WHERE 0`, ['v']);
  return materializeFinal(lowerSteps(toScalarStream(carry, rel, folded.as), steps, folded.at));
}
