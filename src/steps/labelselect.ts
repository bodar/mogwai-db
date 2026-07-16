import { q, list, raw, type Expression } from '../q.ts';
import { type PStep } from '../strategies.ts';
import { aliasElem, aliasIsElement, carriedCols, carryFrag, withShape, type AliasEntry, type Carried, type ElementStream } from './context.ts';
import {
  aliasAppend, aliasEntry, aliasId, aliasPresent, aliasScalar, aliasSeed, elemEntry, shapeElem,
  type AliasShape,
} from './alias.ts';
import {
  assertStreamColumns, carryOf, streamColumns, toListStream, toScalarStream,
  type ListOf, type Stream,
} from './stream.ts';
import { type ValueType } from '../render.ts';

// ---------- as()/select() over path-history labels, any stream shape ----------
//
// as() APPENDS the current object (tagged) to each named label's JSONB history column,
// preserving the stream's shape. select(Pop, label) reads that history back. Element
// streams bind through the PREFIX `as` StepFn (filter.ts); every OTHER shape binds here.
// See docs/2026-07-16-labels-as-path-history.md.

/** Payload columns of a stream (everything before the carried schema). */
const payloadOf = (s: Exclude<Stream, { kind: 'result' }>): string[] => {
  const all = streamColumns(s) as string[];
  return all.slice(0, all.length - carriedCols(s.carried).length);
};

/** The tagged current-object entry for a non-element stream, its shape, and (for a
 *  value) its compile-time type tag. */
function currentEntry(s: Exclude<Stream, { kind: 'result' }>, p: any): { entry: Expression; shape: AliasShape; as?: ValueType } {
  switch (s.kind) {
    case 'scalar':
      return { entry: aliasEntry('value', p.c.v, s.as ?? null), shape: 'value', as: s.as };
    case 'list':
      return { entry: aliasEntry('list', p.c.list), shape: 'list' };
    case 'variant':
      // 0=null / 1=scalar / 2=element (its one possible table)
      return {
        entry: q`CASE ${p.c.vk} WHEN 2 THEN ${elemEntry(s.elem ?? 'node', p.c.rid)} ELSE ${aliasEntry('value', p.c.v, s.scalarAs ?? null)} END`,
        shape: 'value',
      };
    default:
      throw new Error(`as() on a ${s.kind} stream not yet supported`);
  }
}

/** as() on a non-element stream: append the current object to each label's history,
 *  preserving the stream's shape (a pass-through CTE that rebuilds only the alias cols). */
export function asOnStream(s: Exclude<Stream, { kind: 'result' | 'elements' }>, step: PStep): Stream {
  const labels = step.args.filter((a): a is string => typeof a === 'string');
  const p = s.rel.as('p');
  const { entry, shape, as } = currentEntry(s, p);
  const aliases = new Map<string, AliasEntry>(s.carried.aliases);
  const setExpr = new Map<string, Expression>();
  for (const lbl of labels) {
    const existing = aliases.get(lbl);
    const col = existing?.col ?? `a${aliases.size}`;
    aliases.set(lbl, {
      col,
      shapes: withShape(existing?.shapes, shape),
      as: existing && existing.as !== as ? undefined : as,
      binds: (existing?.binds ?? 0) + 1,
    });
    setExpr.set(col, existing ? aliasAppend(p.c[col], entry) : aliasSeed(entry));
  }
  const carried: Carried = { ...s.carried, aliases };
  const newCols = [...payloadOf(s), ...carriedCols(carried)];
  const proj = newCols.map((c) => {
    const e = setExpr.get(c);
    return e ? q`${e} AS ${raw(c)}` : q`${p.c[c]}`;
  });
  const rel = s.q.cte(q`SELECT ${list(proj, ', ')} FROM ${p}`, newCols);
  return assertStreamColumns({ ...s, carried, rel });
}

/** An empty element stream (zero rows). select() of a label bound NOWHERE on the
 *  traversal drops every traverser → an empty result (TinkerPop drops, never errors). */
export function emptyElementLike(s: Exclude<Stream, { kind: 'result' }>): ElementStream {
  const rel = s.q.cte(q`SELECT 1 AS id WHERE 0`, ['id']);
  return {
    q: s.q, params: s.params, fastPaths: s.fastPaths, sideEffects: s.sideEffects,
    carried: { aliases: new Map(), origins: [] }, kind: 'elements', rel, elem: 'node',
  };
}

// ---------- select(Pop, label) over a non-element stream ----------

/** Which end index a single-value Pop reads. */
export const popEnd = (pop: string): 'first' | 'last' => (pop === 'first' ? 'first' : 'last');

/** Does Pop over `entry` produce a List value (vs a single end element)? */
export function popIsListResult(entry: AliasEntry, pop: string): boolean {
  if (pop === 'all') return true;
  if (pop === 'first' || pop === 'last') return false;
  // mixed: singleton unwrapped, else list — decided by the compile-time binding count.
  if (entry.binds === 1) return false;
  if (entry.binds === undefined) throw new Error('select(Pop.mixed) over a dynamically-bound label (repeat/branch) not yet supported');
  return true;
}

/** A JSONB array of the raw `.v` of every history entry — the members of a Pop.all/
 *  mixed list (element rowids or scalar values). */
export const historyValues = (col: Expression): Expression =>
  q`(SELECT jsonb_group_array(je.value ->> '$.v') FROM json_each(${col}) je)`;

/** select(label) / select(Pop, label) with ONE label, over any stream shape. Reads the
 *  label's history column (dropping traversers where it is unbound) and re-emits it as a
 *  scalar / element / list stream per its shape and the Pop mode. */
export function selectOneFromAlias(s: Exclude<Stream, { kind: 'result' }>, step: PStep, label: string, pop: string): Stream {
  const entry = s.carried.aliases.get(label);
  if (!entry) return emptyElementLike(s); // label bound nowhere → drop every traverser
  const p = s.rel.as('p');
  const col = p.c[entry.col];
  const carried = s.carried;
  const carry = carryOf(s);
  const present = aliasPresent(col);
  const isList = popIsListResult(entry, pop);
  const end = pop === 'first' ? 'first' : 'last';

  if (isList) {
    // Pop.all (any label) / Pop.mixed with >1 binding → a List value.
    if (entry.shapes.size !== 1) throw new Error('select(Pop.all/mixed) over a mixed-shape label history not yet supported');
    const shape = [...entry.shapes][0] as AliasShape;
    const of: ListOf = shape === 'value' ? { kind: 'scalar', as: entry.as }
      : (shape === 'node' || shape === 'edge') ? { kind: 'elem', elem: shapeElem(shape) }
      : (() => { throw new Error(`select(Pop.all) over a ${shape} label not yet supported`); })();
    const rel = s.q.cte(
      q`SELECT ${historyValues(col)} AS list${carryFrag(carried, p)} FROM ${p} WHERE ${present}`,
      ['list', ...carriedCols(carried)],
    );
    return toListStream(carry, rel, of);
  }

  // A single end element of the history.
  if (aliasIsElement(entry)) {
    const rel = s.q.cte(
      q`SELECT ${aliasId(col, end)} AS id${carryFrag(carried, p)} FROM ${p} WHERE ${present}`,
      ['id', ...carriedCols(carried)],
    );
    return { ...(s as any), kind: 'elements', rel, elem: aliasElem(entry), carried } as ElementStream;
  }
  // A single scalar value.
  const rel = s.q.cte(
    q`SELECT ${aliasScalar(col, end)} AS v${carryFrag(carried, p)} FROM ${p} WHERE ${present}`,
    ['v', ...carriedCols(carried)],
  );
  return toScalarStream(carry, rel, entry.as);
}
