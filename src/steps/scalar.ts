import { empty, list, q, type Expression } from '../q.ts';
import { predicateSql, rangeToOffsetLimit } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { carryFrag, carriedCols, withoutCarried } from './context.ts';
import { carryOf, toScalarStream, type ScalarStream } from './stream.ts';

const isLocal = (step: PStep): boolean =>
  (step.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local');

const payload = (s: ScalarStream, p: ReturnType<ScalarStream['rel']['as']>): Expression =>
  s.result === 'number' ? q`${p.c.v} AS v, ${p.c.vt} AS vt` : q`${p.c.v} AS v`;

const cols = (s: ScalarStream): string[] =>
  [...(s.result === 'number' ? ['v', 'vt'] : ['v']), ...carriedCols(s.carried)];

function rowPreserving(s: ScalarStream, suffix: Expression): ScalarStream {
  const p = s.rel.as('p');
  const rel = s.q.cte(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)} FROM ${p}${suffix}`, cols(s));
  return toScalarStream(carryOf(s), rel, s.as, s.result);
}

/** Lower the row operators common to every scalar payload one step at a time.
 * Sequential CTEs make order significant (limit().is() is not commuted), while
 * reducer result/type metadata and physically carried columns remain explicit. */
export function lowerScalarRows(
  input: ScalarStream,
  steps: readonly PStep[],
  from: number,
): { stream: ScalarStream; stop: number } {
  let stream = input;
  let i = from;
  for (; i < steps.length; i++) {
    const step = steps[i];
    if (isLocal(step)) break;
    if (step.name === 'is') {
      const p = stream.rel.as('p');
      stream = rowPreserving(stream, q` WHERE ${predicateSql(p.c.v, step.args[0])}`);
      continue;
    }
    if (step.name === 'limit' || step.name === 'skip' || step.name === 'range') {
      const { offset, limit } = step.name === 'limit'
        ? { offset: 0, limit: Number(step.args[0]) }
        : step.name === 'skip'
          ? { offset: Number(step.args[0]), limit: null }
          : rangeToOffsetLimit(step.args);
      stream = rowPreserving(stream, q` LIMIT ${limit ?? -1} OFFSET ${offset}`);
      continue;
    }
    if (step.name === 'order') {
      let order: Expression = q`p.v ASC`;
      const bys = step.bys ?? [];
      if (bys.length > 1) throw new Error('multiple order().by() modulators on a scalar stream not yet supported');
      if (bys.length === 1) {
        const by = bys[0];
        if (by.some((a: any) => typeof a === 'string' || (a && typeof a === 'object' && ('nested' in a || 'token' in a))))
          throw new Error('order().by(key/traversal) on a scalar stream not supported (no properties)');
        const dir = by.find((a: any) => a && typeof a === 'object' && 'order' in a)?.order;
        order = dir === 'shuffle' ? q`RANDOM()` : dir === 'desc' ? q`p.v DESC` : q`p.v ASC`;
      }
      stream = rowPreserving(stream, q` ORDER BY ${order}`);
      continue;
    }
    if (step.name === 'dedup') {
      if (stream.carried.origins.length)
        throw new Error('dedup() in a correlated scalar child requires origin-partitioned lowering');
      const clean = withoutCarried(carryOf(stream));
      const p = stream.rel.as('p');
      const typeCol = stream.result === 'number' ? q`, ${p.c.vt} AS vt` : empty;
      const rel = stream.q.cte(q`SELECT DISTINCT ${p.c.v} AS v${typeCol} FROM ${p}`,
        stream.result === 'number' ? ['v', 'vt'] : ['v']);
      stream = toScalarStream(clean, rel, stream.as, stream.result);
      continue;
    }
    break;
  }
  return { stream, stop: i };
}
