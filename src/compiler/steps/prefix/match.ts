import { q, list, empty, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { isNested, stepChain, type Step } from '../../../gremlin/frontend.ts';
import { type PStep } from '../../ir/strategies.ts';
import { normalize } from '../../ir/passes.ts';
import { advance, aliasColsOf, prevRel, type AliasEntry, type Carried, type ElementStream, type StepFn } from '../context/context.ts';
import { aliasEntry, aliasId, aliasScalar, aliasSeed, elemEntry, elemShape, isElementShape, nodeEntry, shapeElem, type AliasShape } from '../context/alias.ts';
import { engineOf } from '../../engine/deps.ts';
import { type Stream } from '../context/stream.ts';
import { isGlobalBarrier } from '../tail/child-shape.ts';
import { staticTypeOf } from '../../../sql/kernel/render.ts';

// ---------- match() — declarative conjunctive pattern join ----------
//
// match(p1, p2, …) finds all consistent bindings of its pattern variables. Each
// pattern is `as(start).<element traversal>.as(end)`: navigate from a bound var to bind
// (or constrain) another. We compile it as a prefix step that JOIN-extends the carried
// alias columns — bind the root var (the one start that is never an end) to the incoming
// id, then fold the patterns in dependency order. Each pattern re-roots a fresh stream at
// its start var's rowid (carrying every bound var column) and lowers its body through the
// SHARED lowering — NOT a private movement/filter compiler. It then re-projects: restore
// `id` to the root's rowid (an invariant of the binding table, recoverable as the root
// var's last-history id) and bind the end var (new col) or constrain it (WHERE equality
// when already bound). The result keeps `id` = the root's id and carries every bound var as
// an alias column, so a downstream select/count/dedup consumes it via the usual rails.
//
// A VARIABLE HOLDS ANY SHAPE, and it always could have: `aliasEntry` (context/alias.ts) has
// tagged node/edge/value/list/map since labels became path histories. What made this
// element-only was `applyPattern` folding just the ELEMENT prefix (lowerElementSteps), which
// stops at the first non-element step — so `values()`/`count()` read as "unsupported pattern
// step" and an edge end var as a hard wall, none of which were real boundaries. It now runs
// the full shaped loop (prefix fold, then lowerStepsStrict — exactly `lowerRootedArm`'s
// shape, the difference being that a pattern is SEEDED from a bound var rather than rooted)
// and binds on the resulting stream's KIND. A var's shape is RECORDED at bind time, because
// two things need it: re-rooting a later pattern on it (an edge rowid must not be read as a
// node id — both are integers, so getting this wrong is silent) and shape-checking a re-bind.
//
// Deferred (clear errors): a GLOBAL barrier in a pattern body (count/fold/dedup — it would
// reduce over the whole binding table rather than once per binding, which needs the child
// seam's per-binding scoping); a pattern STARTING from a non-element var (no rowid to
// re-root on); a re-bind at a different shape (comparing a rowid to a value is meaningless,
// not merely narrower); an intra-pattern as() label; or/not/nested-match patterns; and any
// shape with other than exactly one start-only root variable (e.g. mutual a↔b recursion).

interface Pattern { start: string; body: PStep[]; end: string | null; }

/** as(start).<body…>.[as(end)] → its parts. The body is normalized so it crosses the
 *  same seam as a root/child chain before the StepFn fold. */
function parsePattern(chain: Step[]): Pattern {
  if (!chain.length || chain[0].name !== 'as' || typeof chain[0].args[0] !== 'string')
    throw new Error('match() pattern must start with as("x")');
  const start = chain[0].args[0];
  let mid = chain.slice(1);
  let end: string | null = null;
  const last = mid[mid.length - 1];
  if (last?.name === 'as' && typeof last.args[0] === 'string') { end = last.args[0]; mid = mid.slice(0, -1); }
  return { start, body: normalize(mid).steps, end };
}

/** What a pattern's END holds, read off the lowered stream's KIND. The alias table has
 *  ALWAYS been shape-generic (`aliasEntry` tags node/edge/value/list/map), so the end var
 *  never needed to be a node — only `applyPattern` insisted on one. `entry` builds the
 *  history entry to BIND; `same` builds the equality that CONSTRAINS an already-bound var,
 *  and the two must agree on shape or a re-used var would compare a rowid against a value. */
interface EndBinding {
  readonly rel: Relation;
  /** The lowered body's carried state — read here rather than off the un-narrowed Stream, so
   *  the intra-pattern-label guard below works for every bindable kind. */
  readonly carried: Carried;
  readonly shape: AliasShape;
  readonly entry: (f: Relation) => Expression;
  readonly same: (f: Relation, col: string) => Expression;
}

function endBindingOf(out: Stream): EndBinding | null {
  if (out.kind === 'elements') return {
    rel: out.rel, carried: out.carried, shape: elemShape(out.elem),
    entry: (f) => elemEntry(out.elem, f.c.id),
    same: (f, col) => q`${f.c.id}=${aliasId(f.c[col], 'last')}`,
  };
  if (out.kind === 'scalar') return {
    rel: out.rel, carried: out.carried, shape: 'value',
    // Carry the static type tag so a numeric/date-valued var reframes correctly on the way
    // out, exactly as a value label bound by as() does.
    entry: (f) => aliasEntry('value', f.c.v, staticTypeOf(out.type) ?? null),
    same: (f, col) => q`${f.c.v}=${aliasScalar(f.c[col], 'last')}`,
  };
  return null;
}

/** Apply one pattern: re-root a fresh stream at the start var, lower its body through the
 *  FULL shaped loop, then re-project the binding table with the end bound or constrained. */
function applyPattern(st: ElementStream, p: Pattern, aliases: Map<string, AliasEntry>, rootCol: string, bind: (v: string, shape: AliasShape) => string): ElementStream {
  const prev = prevRel(st, 'p');
  const startEntry = aliases.get(p.start)!;
  const startCol = startEntry.col;
  const varCols = aliasColsOf(aliases);

  // The seed re-roots on the start var's ROWID, so the seed's `elem` must match what that var
  // actually holds — otherwise an edge rowid gets read as a node id (silently wrong, since both
  // are integers). A non-element start var has no rowid to re-root on at all.
  const startShapes = [...startEntry.shapes];
  if (startShapes.length !== 1 || !isElementShape(startShapes[0]))
    throw new Error(`match() pattern starting from a non-element variable ("${p.start}" holds ${startShapes.join('|') || 'nothing'}) not yet supported`);
  const startElem = shapeElem(startShapes[0]);

  // A GLOBAL barrier in a pattern body observes the whole stream, and here that stream IS the
  // binding table — so `count()` would answer one count over ALL bindings where the pattern
  // asks for one per binding. That needs per-binding scoping (the child seam), so defer rather
  // than mis-execute. Same fact `repeat()` defers on, same predicate.
  const barrier = p.body.find(isGlobalBarrier);
  if (barrier)
    throw new Error(`match() pattern with a ${barrier.name}() barrier not yet supported: it would reduce over the WHOLE binding table, not once per binding — that needs per-binding scoping`);

  // Seed: id = the start var's rowid, carrying every bound var column so movement/filter
  // thread them through unchanged. The bound vars ARE the seed's carried aliases.
  const seedRel = st.q.cte(
    q`SELECT ${aliasId(prev.c[startCol], 'last')} AS id${list(varCols.map((c) => q`, ${prev.c[c]}`), '')} FROM ${prev}`,
    ['id', ...varCols]);
  const seed: ElementStream = { ...st, rel: seedRel, elem: startElem, carried: { aliases: new Map(aliases), origins: [] } };

  // The whole body, not just its element prefix. Folding ONLY the prefix is what stopped at the
  // first non-element step and made "the end var must be a node" a vocabulary wall rather than a
  // real boundary. This is `lowerRootedArm`'s exact shape — prefix fold, then the shared shaped
  // loop for whatever follows, rejecting a terminal result — the difference being that a pattern
  // is SEEDED from a bound var rather than rooted at a source. A pattern body structurally cannot
  // host a barrier source, so the strict (non-suspending) loop is the right entry point.
  const eng = engineOf(seed);
  const lowered = eng.lowerElementSteps(p.body, seed);
  const out: Stream = lowered.next >= p.body.length
    ? lowered.stream
    : eng.lowerStepsStrict(lowered.stream, p.body, lowered.next);
  const bound = endBindingOf(out);
  if (!bound) throw new Error(`match() pattern binding a ${out.kind} result not yet supported (the end var can hold an element or a scalar)`);
  if (bound.carried.aliases.size !== aliases.size || bound.carried.path || bound.carried.origins.length)
    throw new Error('match() pattern binding an intra-pattern label not yet supported');

  // Re-project: restore id = the root's rowid (== aliasId(rootCol), the binding-table
  // invariant), keep every var column, and bind/constrain the end var.
  const f = bound.rel.as('f');
  const proj: Expression[] = [q`${aliasId(f.c[rootCol], 'last')} AS id`, ...varCols.map((c) => q`${f.c[c]}`)];
  const conds: Expression[] = [];
  if (p.end) {
    const prior = aliases.get(p.end);
    if (prior) {
      // Re-using a var CONSTRAINS it. Comparing across shapes is not a narrower answer, it is a
      // meaningless one (a rowid against a name), so require agreement instead of emitting SQL
      // that would silently never match.
      if (!prior.shapes.has(bound.shape))
        throw new Error(`match() re-binds "${p.end}" as ${bound.shape} but it already holds ${[...prior.shapes].join('|')} — a cross-shape constraint is not yet supported`);
      conds.push(bound.same(f, prior.col));
    } else {
      proj.push(q`${aliasSeed(bound.entry(f))} AS ${bind(p.end, bound.shape)}`); // bind() mutates `aliases`
    }
  }
  const where = conds.length ? q` WHERE ${list(conds, ' AND ')}` : empty;
  return advance(st, q`SELECT ${list(proj, ', ')} FROM ${f}${where}`,
    { aliases: new Map(aliases), bulk: null, cols: ['id', ...aliasColsOf(aliases)] });
}

export const match: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error('match() on edges not yet supported');
  if (st.carried.path) throw new Error('path tracking through match() not yet supported');
  const patArgs = s.args.filter(isNested);
  if (!patArgs.length) throw new Error('match() needs at least one pattern');
  const pats = patArgs.map((a) => parsePattern(stepChain(a.nested, st.params)));

  // Root = a start var never used as an end (bound to the incoming traverser).
  const ends = new Set(pats.map((p) => p.end).filter((e): e is string => !!e));
  const roots = [...new Set(pats.map((p) => p.start))].filter((v) => !ends.has(v) && !st.carried.aliases.has(v));
  if (roots.length !== 1)
    throw new Error(`match() with ${roots.length} root variables not yet supported (needs exactly one start-only var)`);
  const root = roots[0];

  const aliases = new Map(st.carried.aliases);
  // `shape` is what the var actually holds — recorded rather than assumed 'node', so a later
  // pattern starting from it re-roots with the right elem and a re-bind can be shape-checked.
  const bind = (v: string, shape: AliasShape): string => {
    let e = aliases.get(v);
    if (!e) { e = { col: `a${aliases.size}`, shapes: new Set([shape]) }; aliases.set(v, e); }
    return e.col;
  };

  // Seed: carry the incoming id + any outer alias columns, and bind the root = id.
  const prev0 = prevRel(st, 'p');
  const rootCol = bind(root, 'node');
  const seedProj: Expression[] = [q`${prev0.c.id}`, ...aliasColsOf(st.carried.aliases).map((c) => q`${prev0.c[c]}`), q`${aliasSeed(nodeEntry(prev0.c.id))} AS ${rootCol}`];
  let cur: ElementStream = advance(st, q`SELECT ${list(seedProj, ', ')} FROM ${prev0}`, { aliases: new Map(aliases), cols: ['id', ...aliasColsOf(aliases)] });

  // Greedy dependency order: process a pattern whose start is bound; bind/constrain end.
  const pending = [...pats];
  let guard = pending.length * pending.length + 1;
  while (pending.length) {
    if (guard-- < 0) throw new Error('match() pattern dependency cycle not yet supported');
    const idx = pending.findIndex((p) => aliases.has(p.start));
    if (idx < 0) throw new Error('match() pattern with an unbound start variable not yet supported');
    cur = applyPattern(cur, pending.splice(idx, 1)[0], aliases, rootCol, bind);
  }
  return cur;
};
