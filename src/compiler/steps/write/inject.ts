import { q, value, list } from '../../../sql/kernel/q.ts';
import { jsonbArrayOf } from '../../plan/plan.ts';
import { flattenListArgs, type SackSpec } from '../../../gremlin/frontend.ts';
import { flatType, CANONICAL_TO_VALUETYPE, type CanonicalType } from '../../../gremlin/types.ts';
import { type PStep } from '../../ir/strategies.ts';
import { type Carry } from '../context/context.ts';
import { toListStream, toScalarStream } from '../context/stream.ts';
import type { Engine } from '../../engine/deps.ts';
import { materializeFinal } from '../tail/materialize.ts';
import { type Compiled, type ValueType } from '../../../sql/kernel/render.ts';
import {
  numericSpec, asBoolConst, asNumberConst, asNumberBare, asDateConst,
  dtFactor, dateDiffOtherMs,
} from '../tail/coerce.ts';

const CONST_COERCIONS = new Set(['asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff']);

// Canonical types whose stored form does NOT determine their Gremlin type, so JS-value
// framing would infer the wrong one. Two reasons, both needing the declared type:
//   - it rides as decimal/char TEXT (do-sqlite-bind-precision): a long > 2^53 would frame
//     as a string, a bigdecimal/char/duration likewise;
//   - it is storage-ambiguous with another type: a datetime is epoch-millis (→ Long) and a
//     uuid is TEXT (→ String), so neither is recoverable from the value alone.
// NOTE this set is CanonicalType (the `flatType`/argTypes vocabulary), not render.ts's
// ValueType — they spell datetime/boolean differently, and comparing across the two is
// exactly the bug this replaced: 'datetime' never matched a Set<ValueType>, so a bare
// inject(datetime(…)) lost its type and a following is(typeOf(DATETIME)) filtered it out.
const DECLARED_TYPE_REQUIRED = new Set<CanonicalType>([
  'long', 'bigint', 'bigdecimal', 'char', 'duration', 'datetime', 'uuid',
]);

/** A bare inject(v1, v2, …) with no leading coercion carries no `as`, so a value whose stored
 *  form is ambiguous (a big long, a datetime, a uuid, …) would frame by JS inference — wrongly.
 *  Derive the framing tag from a UNIFORM declared arg type for exactly those types, translating
 *  the canonical name into the framing vocabulary. Mixed types keep per-value inference
 *  (undefined): inject has no per-row vtype column to carry a heterogeneous type on, and the
 *  client hands over plain JS values, so per-value inference is the honest floor there. */
function bareInjectTag(steps: PStep[], count: number): ValueType | undefined {
  const argTypes = steps[0].argTypes ?? [];
  if (!count) return undefined;
  const names = Array.from({ length: count }, (_, i) => flatType(argTypes[i]));
  const uniform = names.every((n) => n === names[0]) ? names[0] : undefined;
  return uniform && DECLARED_TYPE_REQUIRED.has(uniform) ? CANONICAL_TO_VALUETYPE[uniform] : undefined;
}

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
          const out = asNumberBare(vals[i], flatType(argTypes[i]));
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
      for (let i = 0; i < vals.length; i++) vals[i] = asDateConst(vals[i], flatType(argTypes[i]));
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
export function compileInject(engine: Engine, steps: PStep[], sackInit?: SackSpec): Compiled {
  // A fresh child engine (fresh Query, same app scope): inject() is a SOURCE constructor, so it
  // seeds its own relation on this Query and lowers the chain through the same engine — which the
  // seed stream reaches via `q.engine`.
  const eng = engine.subEngine({});
  const Q = eng.q;
  const carry: Carry = { q: Q, params: {}, carried: { aliases: new Map(), origins: [] } };

  // Each all-array argument is one list traverser, not scalar varargs.
  if (steps[0].args.length >= 1 && steps[0].args.every((a: any) => Array.isArray(a))) {
    if (sackInit) throw new Error('withSack() with a list-valued inject() not yet supported');
    const rows = steps[0].args.map((a: any[]) => q`(${jsonbArrayOf(a)})`);
    const rel = Q.cte(q`VALUES ${list(rows, ', ')}`, ['list']);
    return materializeFinal(eng.lowerStepsStrict(toListStream(carry, rel, { kind: 'scalar' }), steps, 1));
  }

  // Mixed list/scalar inject remains the historical flattened representation until
  // ScalarStream gains a per-row shape/type discriminant.
  const vals = flattenListArgs(steps[0].args);
  const folded = foldConstantCoercions(steps, vals);
  // withSack(init) seeds every inject traverser's carried sack column (`sk`), exactly
  // as seedSource does for V()/E() — so withSack(x).inject(v).sack(...) carries state.
  const sackCarry: Carry = sackInit
    ? { ...carry, carried: { ...carry.carried, sack: 'sk' } }
    : carry;
  const cols = sackInit ? ['v', 'sk'] : ['v'];
  const row = (v: any) => sackInit ? q`(${value(v)}, ${value(sackInit.init)})` : q`(${value(v)})`;
  const rel = vals.length
    ? Q.cte(q`VALUES ${list(vals.map(row), ', ')}`, cols)
    : Q.cte(sackInit ? q`SELECT NULL AS v, NULL AS sk WHERE 0` : q`SELECT NULL AS v WHERE 0`, cols);
  // A bare inject (no coercion consumed, folded.at===1) of a uniform TEXT-stored literal keeps
  // its declared type so it frames correctly (e.g. a long > 2^53 as a Long, not a string).
  const as = folded.as ?? (folded.at === 1 ? bareInjectTag(steps, vals.length) : undefined);
  // A bare inject(null) seeds a single compile-time-known null traverser. Flag it so a following
  // collection step raises TinkerPop's null-incoming message rather than the scalar-incoming one.
  const literalNull = vals.length === 1 && vals[0] === null;
  return materializeFinal(eng.lowerStepsStrict(toScalarStream(sackCarry, rel, as, { literalNull }), steps, folded.at));
}
