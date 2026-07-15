import { q } from '../q.ts';
import { scalarProp, predicateSql, jsonbGroupArray, elemCtx } from '../plan.ts';
import { elemRel, type ElementStream, type StepFn, type SideEffectDef } from './context.ts';

// ---------- named side-effect collections (aggregate) ----------
//
// aggregate('x') collects every traverser passing through into a named side-effect
// (a BulkSet in TinkerPop), read back later by cap('x'). It's a PASS-THROUGH barrier:
// it registers the collection on Carry.sideEffects and returns the stream unchanged,
// so the traversal continues (V().aggregate('x').out()… works). (TinkerPop 4 dropped
// the lazy store() step — aggregate(Scope.local) replaces it — so there is no store
// rule in the grammar; only aggregate('x') reaches here.)
//
// The bag is a materialized JSONB list CTE in the shared Query: element rowids (bare
// aggregate — cap rejoins nodes/edges) or a by()-projected scalar. cap('x') explodes
// it (steps/projection.ts compileCap → the list substrate). Deferred (clear throws):
// aggregate on a SCALAR stream (values(k).aggregate(x) — a tail-phase register),
// aggregate().by(<non-property>), local(aggregate(...)).

const aggregateName = (s: any): string => {
  const name = (s.args ?? []).find((a: any) => typeof a === 'string');
  if (typeof name !== 'string') throw new Error('aggregate() requires a string side-effect key');
  return name;
};

export const aggregate: StepFn = (s, st) => {
  const name = aggregateName(s);
  const bys = (s as any).bys ?? [];
  if (bys.length > 1) throw new Error('aggregate() with more than one by() modulator not yet supported');
  const by = bys[0];
  let def: SideEffectDef;
  if (!by || by.length === 0) {
    // Element bag: store the rowids; cap('x') rejoins nodes/edges when framing.
    const rel = st.q.cte(q`SELECT ${jsonbGroupArray(q`p.id`)} AS list FROM ${st.rel.as('p')}`, ['list']);
    def = { kind: 'list', rel, of: { kind: 'elem', elem: st.elem } };
  } else {
    const a = by[0];
    if (typeof a !== 'string')
      throw new Error('aggregate().by() only supports a property key (nested/token by() not yet supported)');
    const n = elemRel(st);
    const p = st.rel.as('p');
    const pe = scalarProp(elemCtx(n, st.elem), a); // first-under-multi for a node
    // A by() that yields nothing (a missing property) contributes no member — matching
    // values() semantics, the exact behaviour the suite's aggregate('x').by('age')
    // (software vertices have no age) expects.
    const rel = st.q.cte(
      q`SELECT ${jsonbGroupArray(pe)} AS list FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(pe, undefined)}`,
      ['list'],
    );
    def = { kind: 'list', rel, of: { kind: 'scalar' } };
  }
  // Pass-through: same id-relation, extended registry. carryOf/advance preserve it.
  return register(st, name, def);
};

const register = (st: ElementStream, name: string, def: SideEffectDef): ElementStream =>
  ({ ...st, sideEffects: new Map([...(st.sideEffects ?? []), [name, def]]) });

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
  const name = (s.args ?? []).find((a: any) => typeof a === 'string');
  if (typeof name !== 'string') throw new Error(`${isCount ? 'groupCount' : 'group'}() side-effect key must be a string`);
  if (st.carried.aliases.size || st.carried.path)
    throw new Error(`${isCount ? 'groupCount' : 'group'}('${name}') after as()/path() not yet supported`);
  const tbl = st.elem === 'edge' ? 'edges' : 'nodes';
  const def: SideEffectDef = {
    kind: 'group',
    from: `${tbl} n JOIN ${st.rel.name} p ON n.id=p.id`,
    ctx: elemCtx(elemRel(st), st.elem),
    elem: st.elem === 'edge' ? 'edge' : 'vertex',
    isCount,
    bys: (s as any).bys ?? [],
  };
  return register(st, name, def);
};

export const group: StepFn = groupSideEffect(false);
export const groupCount: StepFn = groupSideEffect(true);
