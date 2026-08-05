import { derived, q, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { scalarProp, predicateSql, jsonbGroupArray, elemCtx } from '../../plan/plan.ts';
import { argValues, stepChain } from '../../../gremlin/frontend.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { normalize } from '../../ir/passes.ts';
import { elemRel, type ElementStream, type StepFn, type SideEffectDef } from '../context/context.ts';
import { type ScalarStream } from '../context/stream.ts';
import { staticTypeOf } from '../../../sql/kernel/render.ts';
import { foldMember } from '../tail/barrier.ts';
import { tryCompileFirstElementValueRows, tryCompileScalarValueRows } from '../tail/child.ts';
import { classifyBy } from '../tail/child-shape.ts';

// ---------- named side-effect collections (aggregate) ----------
//
// aggregate('x') collects every traverser passing through into a named side-effect
// (a BulkSet in TinkerPop), read back later by cap('x'). It's a PASS-THROUGH barrier:
// it registers the collection on LoweringState.sideEffects and returns the stream unchanged,
// so the traversal continues (V().aggregate('x').out()… works). (TinkerPop 4 dropped
// the lazy store() step — aggregate(Scope.local) replaces it — so there is no store
// rule in the grammar; only aggregate('x') reaches here.)
//
// The bag is a materialized JSONB list CTE in the shared Query: element rowids (bare
// aggregate — cap rejoins nodes/edges) or a by()-projected scalar; nullable element
// modulation uses a tagged variant relation. cap('x') emits one collection value and
// explicit unfold() explodes it. Deferred (clear throws):
// aggregate on a SCALAR stream (values(k).aggregate(x) — a tail-phase register),
// token/general ordered-element modulation.

const aggregateName = (s: any): string => {
  const name = argValues(s).find((a: any) => typeof a === 'string');
  if (typeof name !== 'string') throw new Error('aggregate() requires a string side-effect key');
  return name;
};

/** The column an aggregate's members must be ordered by, or undefined when the chain carries no
 *  emission order (`analyze.ts` seeds one for every collecting consumer, so undefined here means a
 *  relation that genuinely lost the channel — a repeat()/match() boundary). One reader, because
 *  every collection in this file has the same answer and they used to have none. */
const memberOrder = (s: { traverserLayout: { encounter?: string } }, rel: Relation): Expression | undefined =>
  s.traverserLayout.encounter ? rel.c[s.traverserLayout.encounter] : undefined;

export const aggregate: StepFn = (s, st) => {
  const name = aggregateName(s);
  // Arity (at most one by()) is asserted once, by the `byModulatorArity` verify Pass — see
  // BY_MODULATOR_ARITY in ir/strategies.ts. A second check here could only disagree with it.
  const modulators = (s as IRStep).modulators ?? [];
  const by = classifyBy(modulators[0]);
  let def: SideEffectDef;
  if (by.kind === 'none') {
    // Element bag: store the rowids; cap('x') rejoins nodes/edges when framing.
    const p = st.rel.as('p');
    const rel = st.q.cte(q`SELECT ${jsonbGroupArray(p.c.id, memberOrder(st, p))} AS list FROM ${p}`, ['list']);
    def = { kind: 'list', rel, of: { kind: 'elem', elem: st.elem } };
  } else {
    const productive = (s as IRStep).productiveBy === true;
    if (by.kind === 'key') {
      const n = elemRel(st);
      const p = st.rel.as('p');
      const pe = scalarProp(elemCtx(n, st.elem), by.key); // first-under-multi for a node
      // ProductiveBy makes a missing modulation one explicit NULL member. Ordinary
      // aggregate keeps values()-style productivity and drops that parent.
      const where = productive ? q`` : q` WHERE ${predicateSql(pe, undefined)}`;
      const rel = st.q.cte(
        q`SELECT ${jsonbGroupArray(pe, memberOrder(st, p))} AS list FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}${where}`,
        ['list'],
      );
      def = { kind: 'list', rel, of: { kind: 'scalar', productiveNull: productive } };
    } else if (by.kind === 'nested') {
      const rows = tryCompileScalarValueRows(st, by.nested);
      if (rows) {
        const r = rows.stream.rel.as('r');
        const encounter = rows.stream.traverserLayout.encounter;
        if (!encounter) throw new Error('aggregate().by(traversal) requires child encounter order');
        // by(traversal) is a map-style modulator: retain its FIRST productive result
        // per input. ProductiveBy then LEFT-restores parents whose child had no row.
        const first = derived(
          q`SELECT ${r.c.v} AS v, ${r.c[rows.frame.ordinal]} AS ${rows.frame.ordinal}, ROW_NUMBER() OVER (PARTITION BY ${r.c[rows.frame.ordinal]} ORDER BY ${r.c[encounter]}) AS rn FROM ${r}`,
          ['v', rows.frame.ordinal, 'rn'],
          'f',
        );
        // BOTH arms read from the parent DOMAIN, differing only in the join: productive LEFT-joins
        // so a childless parent contributes an explicit NULL member, ordinary INNER-joins so it
        // drops. Written as one source because the domain is also the only thing here carrying the
        // parent's emission `encounter` — `first` narrows to (v, ordinal, rn), and the ordinal is
        // NOT an order channel (`pushChildScope` mints it with `ROW_NUMBER() OVER ()`, an empty
        // window, so it numbers in scan order and reverses right along with the scan).
        const d = rows.frame.domain.as('d');
        const on = q`${first.c[rows.frame.ordinal]}=${d.c[rows.frame.ordinal]} AND ${first.c.rn}=1`;
        const source = productive ? q`${d} LEFT JOIN ${first} ON ${on}` : q`${d} JOIN ${first} ON ${on}`;
        // NB the `first` projection above narrows to (v, ordinal, rn) — it does not carry a
        // per-row vtype column, so this by()-modulated path can only offer the static tag.
        // Widening it to preserve the type channel is follow-on work, not a silent drop.
        const rel = st.q.cte(q`SELECT ${jsonbGroupArray(first.c.v, memberOrder(st, d))} AS list FROM ${source}`, ['list']);
        def = { kind: 'list', rel, of: { kind: 'scalar', as: staticTypeOf(rows.stream.type), productiveNull: productive } };
      } else {
        const elements = tryCompileFirstElementValueRows(st, by.nested);
        if (!elements)
          throw new Error('aggregate().by(traversal) child shape not yet supported by generic child lowering');
        const c = elements.stream.rel.as('c');
        // A collection's member order is fully observable (the members ride inside the collected
        // traverser's own GraphBinary buffer — `jsonbGroupArray` states the rule), and these rows
        // ARE the members. One row per parent here (`tryCompileFirstElementValueRows` keeps the
        // first), so the parent order IS the member order — and the child scope's ORDINAL is the
        // parent-order key, since `pushChildScope` mints it ordered by the parent's encounter.
        // Its SCALAR twin above bakes the same order in at build time via `memberOrder`; a variant
        // def is a relation rather than a collected list, so the order rides as a column that
        // `cap()` declares and the wire applies.
        const ord = elements.frame.ordinal;
        if (productive) {
          const d = elements.frame.domain.as('d');
          const rel = st.q.cte(
            q`SELECT CASE WHEN ${c.c.id} IS NULL THEN 0 ELSE 2 END AS vk, NULL AS v, ${c.c.id} AS rid, ROW_NUMBER() OVER (ORDER BY ${d.c[ord]}) AS encounter FROM ${d} LEFT JOIN ${c} ON ${c.c[ord]}=${d.c[ord]}`,
            ['vk', 'v', 'rid', 'encounter'],
          );
          def = { kind: 'variant', rel, elem: elements.stream.elem, order: 'encounter' };
        } else {
          const rel = st.q.cte(
            q`SELECT 2 AS vk, NULL AS v, ${c.c.id} AS rid, ROW_NUMBER() OVER (ORDER BY ${c.c[ord]}) AS encounter FROM ${c}`,
            ['vk', 'v', 'rid', 'encounter'],
          );
          def = { kind: 'variant', rel, elem: elements.stream.elem, order: 'encounter' };
        }
      }
    } else {
      throw new Error('aggregate().by() only supports a property key or a scalar/element traversal');
    }
  }
  // Pass-through: same id-relation, extended registry. loweringStateOf/advance preserve it.
  return register(st, name, def);
};

const register = (st: ElementStream, name: string, def: SideEffectDef): ElementStream =>
  ({ ...st, sideEffects: new Map([...(st.sideEffects ?? []), [name, def]]) });

/**
 * aggregate('x') over a SCALAR stream: collect the current values into the named side-effect
 * bag (a JSONB list of the scalar values), read back by cap('x'). Pass-through — the scalar
 * stream continues unchanged, so `values(k).aggregate('x').<more>…cap('x')` composes. A
 * by()-modulator over a scalar aggregate re-projects each value and defers here (return null →
 * the clear generic message) until wired through the modulation seam.
 */
export function lowerScalarAggregate(s: ScalarStream, step: IRStep): ScalarStream | null {
  const name = aggregateName(step);
  if (((step as IRStep).modulators ?? []).length) return null;
  const p = s.rel.as('p');
  // Same encoding decision as fold() — a per-row type channel becomes self-describing
  // members, so cap() frames each one by its own stored type.
  const { member, of } = foldMember(s, p);
  const rel = s.q.cte(q`SELECT ${jsonbGroupArray(member, memberOrder(s, p))} AS list FROM ${p}`, ['list']);
  const def: SideEffectDef = { kind: 'list', rel, of };
  return { ...s, sideEffects: new Map([...(s.sideEffects ?? []), [name, def]]) };
}

// ---------- side-effecting group('a') / groupCount('a') ----------
//
// The side-effecting overload of group/groupCount: it builds the Map into a named
// side-effect AND passes the incoming traversers through unchanged (so the traversal
// continues — groupCount('a').by('name').out().cap('a') works), read back by cap('a').
// Unlike the bare terminal group() (a compileTail barrier), this is a PASS-THROUGH:
// it stashes the group-spec (source relation + scalar ctx + by() modulators) so
// compileCap can re-run lowerGroup over it. The source CTE (st.rel) persists in
// the shared Query, so cap('a') — however much later — references it. The by()
// modulators fold onto the step (group/groupCount are BY_HOSTS).

const groupSideEffect = (isCount: boolean): StepFn => (s, st) => {
  const name = argValues(s).find((a: any) => typeof a === 'string');
  if (typeof name !== 'string') throw new Error(`${isCount ? 'groupCount' : 'group'}() side-effect key must be a string`);
  if (st.traverserLayout.aliases.size || st.traverserLayout.path)
    throw new Error(`${isCount ? 'groupCount' : 'group'}('${name}') after as()/path() not yet supported`);
  // The source shape (element table JOIN parent CTE + ctx + elem) is rebuilt from `parent`
  // by cap('a') via elementGroupSource — the SAME kernel builder the terminal group() tail
  // uses — so nothing here hand-builds a raw SQL string.
  const def: SideEffectDef = {
    kind: 'group',
    isCount,
    modulators: (s as IRStep).modulators ?? [],
    parent: st,
    productiveBy: (s as IRStep).productiveBy,
  };
  return register(st, name, def);
};

export const group: StepFn = groupSideEffect(false);
export const groupCount: StepFn = groupSideEffect(true);

/** local(aggregate(...)) has no value-producing body: local merely scopes the
 * side-effect to the current traverser and returns that traverser unchanged. Lower
 * the canonical one-step child through the same aggregate StepFn, so this syntax is
 * not a second side-effect compiler. */
export function tryLowerLocalAggregate(st: ElementStream, step: IRStep): ElementStream | null {
  const nested = step.args[0]?.value?.nested;
  if (!nested) return null;
  const normalized = normalize(stepChain(nested, st.params)).steps;
  if (normalized.length !== 1 || normalized[0].name !== 'aggregate') return null;
  return aggregate({ ...normalized[0], productiveBy: step.productiveBy }, st);
}
