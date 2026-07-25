import { q, list, raw, empty, value, type Expression } from '../../../sql/kernel/q.ts';
import { type PStep } from '../../ir/strategies.ts';
import { aliasElem, aliasIsElement, carriedCols, carryFrag, withShape, type AliasEntry, type Carried, type ElementStream } from '../context/context.ts';
import {
  aliasAppend, aliasEntry, aliasId, aliasPop, aliasPresent, aliasScalar, aliasSeed, elemEntry, shapeElem,
  type AliasShape,
} from '../context/alias.ts';
import {
  assertStreamColumns, carryOf, pathColumns, streamColumns, toListStream, toScalarStream, PROPERTY_PAYLOAD,
  type ListOf, type PropertyStream, type Stream,
} from '../context/stream.ts';
import { type ValueType } from '../../../sql/kernel/render.ts';

// ---------- as()/select() over path-history labels, any stream shape ----------
//
// as() APPENDS the current object (tagged) to each named label's JSONB history column,
// preserving the stream's shape. select(Pop, label) reads that history back. Element
// streams bind through the PREFIX `as` StepFn (filter.ts); every OTHER shape binds here.
// See docs/archive/2026-07-16-labels-as-path-history.md.

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
    case 'path': {
      // A Path binds as a LIST entry — it IS an ordered sequence of its positions, and that is
      // exactly what select(label) must yield (TinkerPop Select.feature
      // g_V_…_path_asXaX_unionXidentity_identityX_selectXaX_unfold expects unfold() over the
      // label to give back the path's elements). Encoding it as the existing 'list' shape rather
      // than a new AliasShape keeps the read-back path (historyValues → toListStream) unchanged.
      // Only the LINEAR layout reaches here: the grouped/recursive regime is not row-preserving,
      // so lowerPath drops its aliases and as() never sees it (guarded below).
      if (s.layout.kind !== 'linear')
        throw new Error('as() over a recursive-repeat path() value not yet supported (the grouped layout is one row per position, not per path)');
      const cols = (pathColumns(s.layout) as string[]).filter((c: string) => c.endsWith('_id') || c.endsWith('_v'));
      if (!cols.length) throw new Error('as() over a path() with no framed positions not yet supported');
      return { entry: aliasEntry('list', q`jsonb_array(${list(cols.map((c: string) => p.c[c]), ', ')})`), shape: 'list' };
    }
    case 'variant': {
      // 0=null / 1=scalar / 2=node / 3=edge / 4=list (per-row tag)
      const arms: Expression[] = [];
      if (s.node) arms.push(q`WHEN 2 THEN ${elemEntry('node', p.c.rid)}`);
      if (s.edge) arms.push(q`WHEN 3 THEN ${elemEntry('edge', p.c.rid)}`);
      if (s.listOf) arms.push(q`WHEN 4 THEN ${aliasEntry('list', p.c.list)}`);
      return {
        entry: q`CASE ${p.c.vk} ${list(arms, ' ')} ELSE ${aliasEntry('value', p.c.v, s.scalarAs ?? null)} END`,
        shape: 'value',
      };
    }
    case 'property': {
      // The alias JSON mirrors the property payload key-for-key (single-sourced from
      // PROPERTY_PAYLOAD) plus an 'elem' tag recording the owner element kind for rehydration.
      // Field names are a fixed vocabulary → splice as SQL literals (no bind, no injection).
      const pairs = list(PROPERTY_PAYLOAD.map((f) => q`'${f}', ${p.c[f]}`), ', ');
      return {
        entry: aliasEntry('property', q`json_object(${pairs}, 'elem', ${value(s.ownerElem)})`),
        shape: 'property',
      };
    }
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
      propertyElem: shape === 'property' && s.kind === 'property' ? s.ownerElem : existing?.propertyElem,
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
    q: s.q, params: s.params, sideEffects: s.sideEffects,
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

export const historyPropertyValues = (col: Expression): Expression =>
  q`json(COALESCE((SELECT json_group_array(json(je.value -> '$.v') ORDER BY je.key) FROM json_each(${col}) je), json('[]')))`;

const propertyAliasField = (entry: Expression, field: string): Expression =>
  q`json_extract(${entry}, ${value(`$.v.${field}`)})`;

/** Rehydrate a property alias into the ordinary PropertyStream shape. The alias history
 * stores one tagged JSON object, so direct select() keeps using the same property tail
 * (value/key/element/order/dedup) as an unaliased properties() traversal. */
function selectPropertyAlias(s: Exclude<Stream, { kind: 'result' }>, entry: AliasEntry, col: Expression, pop: string): PropertyStream {
  if (pop !== 'first' && pop !== 'last') throw new Error(`select(Pop.${pop}) over a property label not yet supported`);
  if (!entry.propertyElem) throw new Error('property alias has no owner element kind');
  const p = s.rel.as('p');
  const selected = pop === 'first' ? q`${col} -> '$[0]'` : q`${col} -> '$[#-1]'`;
  const fields = list(PROPERTY_PAYLOAD.map((f) => q`${propertyAliasField(selected, f)} AS ${f}`), ', ');
  const rel = s.q.cte(
    q`SELECT ${fields}${carryFrag(s.carried, p)} FROM ${p} WHERE ${aliasPresent(col)}`,
    [...PROPERTY_PAYLOAD, ...carriedCols(s.carried)],
  );
  return { ...carryOf(s), kind: 'property', rel, ownerElem: entry.propertyElem };
}

/** select(label) / select(Pop, label) with ONE label, over any stream shape. Reads the
 *  label's history column (dropping traversers where it is unbound) and re-emits it as a
 *  scalar / element / list stream per its shape and the Pop mode. */
export function selectOneFromAlias(s: Exclude<Stream, { kind: 'result' }>, step: PStep, label: string, pop: string): Stream {
  const entry = s.carried.aliases.get(label);
  // No live binding → drop every traverser (an EMPTY result, never an error). TinkerPop pins this
  // for both reachable cases, so the same answer is right for both:
  //   · never bound at all           — Select.feature `g_V_selectXaX` → "the result should be empty"
  //   · bound, then a REDUCING barrier (fold/count/sum/…) consumed the label: that barrier emits one
  //     fresh traverser with an empty path, so nothing is bound on it either.
  // `carried.consumedAliases` is what makes the second case PROVABLE rather than indistinguishable
  // from a typo'd label — without it this line is a coin-flip that happens to land right. Keep them
  // returning the same thing, but only because the spec says so, not because we can't tell.
  if (!entry) return emptyElementLike(s);
  const p = s.rel.as('p');
  const col = p.c[entry.col];
  const carried = s.carried;
  const carry = carryOf(s);
  const present = aliasPresent(col);
  const isList = popIsListResult(entry, pop);
  const end = pop === 'first' ? 'first' : 'last';

  if (entry.shapes.size === 1 && entry.shapes.has('property')) {
    if (isList) {
      const rel = s.q.cte(
        q`SELECT ${historyPropertyValues(col)} AS list${carryFrag(carried, p)} FROM ${p} WHERE ${present}`,
        ['list', ...carriedCols(carried)],
      );
      return toListStream(carry, rel, { kind: 'property', elem: entry.propertyElem! });
    }
    const by = step.bys?.[0]?.[0];
    if (by === undefined) return selectPropertyAlias(s, entry, col, end);
    if (!(by && typeof by === 'object' && 'token' in by && (by.token === 'key' || by.token === 'value' || by.token === 'id')))
      throw new Error('select(property).by() supports only T.key, T.value, or T.id');
    const selected = end === 'first' ? q`${col} -> '$[0]'` : q`${col} -> '$[#-1]'`;
    const field = by.token === 'key' ? 'pk' : by.token === 'value' ? 'pv' : 'vpid';
    const rel = s.q.cte(
      q`SELECT ${propertyAliasField(selected, field)} AS v${by.token === 'value' ? q`, ${propertyAliasField(selected, 'pvtype')} AS vtype` : empty}${carryFrag(carried, p)} FROM ${p} WHERE ${present}`,
      ['v', ...(by.token === 'value' ? ['vtype'] : []), ...carriedCols(carried)],
    );
    return toScalarStream(carry, rel, undefined, by.token === 'value' ? { vtype: 'vtype' } : {});
  }

  if (isList) {
    // Pop.all (any label) / Pop.mixed with >1 binding → a List value. A pure-property label
    // is fully handled by the property block above, so this path never sees 'property'.
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
  // A single LIST-shaped entry (a fold()ed list, or a path() bound whole) must come back OUT as a
  // ListStream, not as its JSON text: the entry's `v` already holds a json array, so unwrap it to
  // the `list` payload and let the list engine frame/unfold it. Falling through to the scalar
  // branch below would hand the caller the string "[1,2]" instead of a list of members — the
  // symptom that made `fold().as('b').select('b').unfold()` emit one text blob.
  if (entry.shapes.size === 1 && entry.shapes.has('list')) {
    const rel = s.q.cte(
      q`SELECT json(${aliasPop(col, end)} ->> '$.v') AS list${carryFrag(carried, p)} FROM ${p} WHERE ${present}`,
      ['list', ...carriedCols(carried)],
    );
    // The member shape is not recorded on the entry (a list entry stores the array verbatim), so
    // stay honest: an untyped scalar list. A path/element-list label that needs its members framed
    // AS elements needs the member shape carried on AliasEntry — a separate, wider change.
    return toListStream(carry, rel, { kind: 'scalar', as: undefined });
  }
  // A single scalar value.
  const rel = s.q.cte(
    q`SELECT ${aliasScalar(col, end)} AS v${carryFrag(carried, p)} FROM ${p} WHERE ${present}`,
    ['v', ...carriedCols(carried)],
  );
  return toScalarStream(carry, rel, entry.as);
}
