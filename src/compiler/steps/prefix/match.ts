import { q, list, empty, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { streamPayloadCols } from '../context/stream.ts';
import { where } from './filter.ts';
import { isNested, stepChain, type Step } from '../../../gremlin/frontend.ts';
import { MATCH_FILTER_HEADS, type PStep } from '../../ir/strategies.ts';
import { normalize } from '../../ir/passes.ts';
import { advance, aliasColsOf, aliasScalarTypeOf, prevRel, withLayout, type AliasEntry, type TraverserLayout, type ElementStream, type StepFn } from '../context/context.ts';
import { aliasEntry, aliasId, aliasScalar, aliasSeed, elemEntry, elemShape, isElementShape, nodeEntry, shapeElem, type AliasShape } from '../context/alias.ts';
import { engineOf } from '../../engine/deps.ts';
import { type Stream } from '../context/stream.ts';
import { isGlobalBarrier, labelsMentioned, ROOT_SCOPE } from '../tail/child-shape.ts';
import { tryCompileScalarValueChild } from '../tail/child.ts';
import { perRowColumnOf, staticTypeOf } from '../../../sql/kernel/render.ts';

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
// An argument is not always a BINDING pattern: `not(…)`/`where(…)` constrain the binding table and
// bind nothing (see Pattern/MATCH_FILTER_HEADS), and they are DELEGATED to the same `where` StepFn
// the engine routes them to rather than re-implemented here. Both kinds share one readiness rule —
// an argument runs once the variables it READS are bound — so argument order cannot change the
// answer. The ROOT is optional for the same reason: when every start is already bound before the
// match(), nothing needs seeding and `id` stays the incoming traverser.
//
// Deferred (clear errors): a bare match() as a TERMINAL — it must emit one binding MAP per row and
// we emit the traverser, so every supported form ends in select(); a GLOBAL barrier in a pattern
// body (count/fold/dedup — it would reduce over the whole binding table rather than once per
// binding, which needs the child seam's per-binding scoping); a pattern STARTING from a non-element
// var (no rowid to re-root on); a re-bind at a different shape (comparing a rowid to a value is
// meaningless, not merely narrower); an intra-pattern as() label; `and`/`or` pattern GROUPS (in
// match position they BIND their nested ends — the corpus asserts those variables come back — so
// lowering them as filters would answer a narrower question) and nested-match; TWO fresh root
// variables (the binding table has one id); and a true mutual a↔b cycle, where every start is also
// an end so no pattern can go first (SQL expresses it fine — a self-join — but this fold needs an
// anchor, and it reports as an unbound start rather than being silently mis-ordered).

/** A match() argument is one of two kinds, decided by its first step.
 *
 *  A BIND navigates from one variable to bind or constrain another (`as(a).out().as(b)`) — it is
 *  what extends the binding table. A FILTER (`not(…)`, `where(…)` — see MATCH_FILTER_HEADS for why the
 *  conjunctions are not among them) binds nothing and only removes rows; TinkerPop admits it as an
 *  ordinary argument alongside the binding patterns.
 *
 *  A filter needs no new machinery HERE because the binding table is already an ordinary element
 *  stream carrying every bound variable as an alias column — which is precisely the parent the
 *  registered `where` StepFn consumes (`labelScope`/`aliasIdExpr` read `carried.aliases`).
 *  So a filter argument is DELEGATED to them verbatim; the only thing match() adds is scheduling it
 *  after the variables it reads are bound. Building a private evaluator here would be a second
 *  implementation of a filter path that already exists. */
type Pattern =
  | { kind: 'bind'; start: string; body: PStep[]; end: string | null }
  | { kind: 'filter'; step: PStep; reads: readonly string[] };


/** How a fold step recovers the TRAVERSER's id after a pattern has re-rooted the stream onto some
 *  other variable's rowid. The binding table's `id` must always be what the traverser was when
 *  match() started, because that is what a downstream out()/count()/select() consumes.
 *
 *  It is ALWAYS read from an alias column, never from the body relation's `id`: a pattern body may
 *  end in a scalar (`as("a").out().count().as("c")` lowers to `(v, …varCols)` with no `id` at all),
 *  and an alias column is the one thing every body kind carries through unchanged. So when match()
 *  has no ROOT variable to read — every pattern start was already bound before it — the incoming id
 *  is bound to an INTERNAL label and rides the fold as an ordinary var column, then is dropped on
 *  the way out. Reading `f.c.id` instead renders as `SELECT  AS id` over a scalar body. */
type IdSource = (f: Relation) => Expression;

/** The internal label backing the traverser id when there is no root variable. Not a Gremlin label:
 *  an as() argument is a quoted identifier the grammar never yields with a leading space, so this
 *  cannot collide with a user's label, and it is stripped from the alias map before match() returns
 *  so a downstream select()/where() never sees it. */
const TRAVERSER_LABEL = ' traverser';

/** as(start).<body…>.[as(end)] → its parts, or a FILTER argument (see Pattern). The body is
 *  normalized so it crosses the same seam as a root/child chain before the StepFn fold. */
function parsePattern(chain: Step[], params: Record<string, any>): Pattern {
  if (chain.length === 1 && MATCH_FILTER_HEADS.has(chain[0].name)) {
    const [step] = normalize(chain).steps;
    return { kind: 'filter', step, reads: [...labelsMentioned([step], params)] };
  }
  if (!chain.length || chain[0].name !== 'as' || typeof chain[0].args[0] !== 'string')
    throw new Error('match() pattern must start with as("x") or be a where()/not() filter');
  const start = chain[0].args[0];
  let mid = chain.slice(1);
  let end: string | null = null;
  const last = mid[mid.length - 1];
  if (last?.name === 'as' && typeof last.args[0] === 'string') { end = last.args[0]; mid = mid.slice(0, -1); }
  return { kind: 'bind', start, body: normalize(mid).steps, end };
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
  readonly traverserLayout: TraverserLayout;
  /** The body's OWN columns (`streamPayloadCols` for its kind) — the ones `entry`/`same` read.
   *  Kept here for the same reason as `traverserLayout`: the Stream is un-narrowed by the time the
   *  private-state guard below runs, and this is what tells a payload column apart from one. */
  readonly payload: readonly string[];
  readonly shape: AliasShape;
  readonly scalarType?: AliasEntry['scalarType'];
  readonly entry: (f: Relation) => Expression;
  readonly same: (f: Relation, col: string) => Expression;
}

function endBindingOf(out: Stream): EndBinding | null {
  if (out.kind === 'elements') return {
    rel: out.rel, traverserLayout: out.traverserLayout, payload: streamPayloadCols(out), shape: elemShape(out.elem),
    entry: (f) => elemEntry(out.elem, f.c.id),
    same: (f, col) => q`${f.c.id}=${aliasId(f.c[col], 'last')}`,
  };
  if (out.kind === 'scalar') return {
    rel: out.rel, traverserLayout: out.traverserLayout, payload: streamPayloadCols(out), shape: 'value',
    // A per-row stored type crosses this relation boundary in the entry itself;
    // a later select() recreates a fresh vtype column from it.
    entry: (f) => aliasEntry('value', f.c.v, perRowColumnOf(out.type) ? f.c[perRowColumnOf(out.type)!] : staticTypeOf(out.type) ?? null),
    scalarType: aliasScalarTypeOf(out.type),
    same: (f, col) => q`${f.c.v}=${aliasScalar(f.c[col], 'last')}`,
  };
  return null;
}

/** Apply a FILTER argument: hand it to the very StepFn the engine routes its head to (`where`, which
 *  serves where/filter/not), run against the binding table as it stands.
 *
 *  No re-rooting and no id restoration, unlike a bind — `filterCte` projects `n.id` joined on the
 *  previous relation, so the traverser id and every var column ride through untouched; a filter only
 *  removes rows. And no new machinery: the binding table is an ordinary element stream whose carried
 *  aliases ARE the pattern variables, which is exactly what `labelScope`/`aliasIdExpr` read. */
function applyFilter(st: ElementStream, step: PStep): ElementStream {
  return where(step, st);
}

/** Apply one pattern: re-root a fresh stream at the start var, lower its body through the
 *  FULL shaped loop, then re-project the binding table with the end bound or constrained. */
function applyPattern(st: ElementStream, p: Extract<Pattern, { kind: 'bind' }>, aliases: Map<string, AliasEntry>, restoreId: IdSource, bind: (v: string, shape: AliasShape) => string): ElementStream {
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

  // Seed: id = the start var's rowid, carrying every bound var column so movement/filter
  // thread them through unchanged. The bound vars ARE the seed's carried aliases.
  const seedRel = st.q.cte(
    q`SELECT ${aliasId(prev.c[startCol], 'last')} AS id${list(varCols.map((c) => q`, ${prev.c[c]}`), '')} FROM ${prev}`,
    ['id', ...varCols]);
  const seed: ElementStream = { ...st, rel: seedRel, elem: startElem, traverserLayout: { aliases: new Map(aliases), origins: [] } };

  // TWO routes, and which one is right is decided by a real semantic fact, not a vocabulary.
  //
  //  • A ROW-LOCAL body (movement/filter, or a scalar projection like values()) is evaluated
  //    per binding by construction, and its fan-out is CORRECT — `a.out("knows").as("b")` should
  //    produce one row per (a,b) pair. So it lowers at this scope: prefix fold, then the shared
  //    shaped loop for whatever follows. That is `lowerRootedArm`'s shape, the difference being
  //    that a pattern is SEEDED from a bound var rather than rooted at a source.
  //  • A GLOBAL BARRIER body (count/fold/dedup/…) observes the whole stream — and here that
  //    stream IS the binding table, so lowering it at this scope would answer ONE count across
  //    ALL bindings where the pattern asks for one per binding. It needs per-binding scoping,
  //    which is exactly what the child seam does: push a scope over the binding rows, compile
  //    the body as a scalar child, and let the cardinality rejoin restore one row per binding.
  //
  // The child seam was already shape- and parent-generic enough for this; what kept match out of
  // it was that its scalar entry points required a `nested` PARSE TREE, and a pattern body is a
  // Step[] SLICE between the as() wrappers with no tree of its own. They now accept a pre-parsed
  // body, so this is reuse rather than a second reducer implementation.
  const eng = engineOf(seed);
  const out: Stream = ((): Stream => {
    if (p.body.some(isGlobalBarrier)) {
      const scoped = tryCompileScalarValueChild(seed, undefined, 'first', ROOT_SCOPE, p.body);
      if (!scoped)
        throw new Error(`match() pattern __.${p.body.map((b) => b.name + '()').join('.')} not yet supported: it reduces over the binding table and is not a scalar child the per-binding seam can compile`);
      return scoped;
    }
    const lowered = eng.lowerElementSteps(p.body, seed);
    return lowered.next >= p.body.length
      ? lowered.stream
      : eng.lowerStepsStrict(lowered.stream, p.body, lowered.next);
  })();
  const bound = endBindingOf(out);
  if (!bound) throw new Error(`match() pattern binding a ${out.kind} result not yet supported (the end var can hold an element or a scalar)`);
  if (bound.traverserLayout.aliases.size !== aliases.size || bound.traverserLayout.path || bound.traverserLayout.origins.length)
    throw new Error('match() pattern binding an intra-pattern label not yet supported');
  // A body may MINT carried state of its own that the binding table does not forward: `repeat()`
  // seeds a fresh `bulk` at its source (prefix/branch.ts, `1 AS bulk`), because any element source
  // does. Dropping it is semantically right — a pattern's fan-out is already row multiplicity, the
  // multiset invariant — but it must be dropped DELIBERATELY, naming the columns to keep rather
  // than letting the body's extra value ride into a projection that never mentions it (an arity
  // skew SQLite reports as "table cN has 3 values for 2 columns", and only at EXECUTION). What the
  // re-projection legitimately consumes is the body's PAYLOAD (`id`, or `v`/`vt` for a scalar end —
  // `streamPayloadCols` is the authority per kind) plus the var columns; anything else is private
  // state, and only a re-seeded `bulk` is safe to drop. Asking the authority rather than listing
  // `bulk` keeps this closed against the next carried field that rides out the same way.
  const consumed = new Set<string>([...bound.payload, ...aliasColsOf(bound.traverserLayout.aliases)]);
  const dropped = bound.rel.cols.filter((c) => !consumed.has(c));
  if (dropped.some((c) => c !== bound.traverserLayout.bulk))
    throw new Error(`match() pattern body carrying ${dropped.join('/')} not yet supported (the binding table forwards only the pattern variables)`);

  // Re-project: restore the traverser's id (`restoreId` — see IdSource), keep every var column,
  // and bind/constrain the end var.
  const f = bound.rel.as('f');
  const proj: Expression[] = [q`${restoreId(f)} AS id`, ...varCols.map((c) => q`${f.c[c]}`)];
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
      const col = bind(p.end, bound.shape); // bind() mutates `aliases`
      const added = aliases.get(p.end)!;
      aliases.set(p.end, { ...added, scalarType: bound.scalarType });
      proj.push(q`${aliasSeed(bound.entry(f))} AS ${col}`);
    }
  }
  const where = conds.length ? q` WHERE ${list(conds, ' AND ')}` : empty;
  return advance(st, q`SELECT ${list(proj, ', ')} FROM ${f}${where}`,
    { aliases: new Map(aliases), bulk: null, cols: ['id', ...aliasColsOf(aliases)] });
}

export const match: StepFn = (s, st) => {
  if (st.elem !== 'vertex') throw new Error('match() on edges not yet supported');
  if (st.traverserLayout.path) throw new Error('path tracking through match() not yet supported');
  const patArgs = s.args.filter(isNested);
  if (!patArgs.length) throw new Error('match() needs at least one pattern');
  const pats = patArgs.map((a) => parsePattern(stepChain(a.nested, st.params), st.params));

  // Root = a start var never used as an end, bound to the incoming traverser. ZERO roots is a
  // legitimate shape, not a failure: when every pattern start was already bound before the match()
  // (`.as("a").out().as("b").match(as("a")…, as("b")…)`), there is nothing to seed — each pattern
  // only constrains or extends columns that already exist, and `id` stays the incoming traverser.
  // What is still unsupported is TWO fresh roots (two disjoint pattern components — the binding
  // table has one `id`) and a true mutual cycle, where every start is also an end so no pattern can
  // go first; the latter reports as an unbound start below rather than being silently mis-ordered.
  // Only a BIND declares a start/end — a filter reads variables, so it can never supply a root.
  const bindPats = pats.filter((p): p is Extract<Pattern, { kind: 'bind' }> => p.kind === 'bind');
  const ends = new Set(bindPats.map((p) => p.end).filter((e): e is string => !!e));
  const roots = [...new Set(bindPats.map((p) => p.start))].filter((v) => !ends.has(v) && !st.traverserLayout.aliases.has(v));
  if (roots.length > 1)
    throw new Error(`match() with ${roots.length} root variables not yet supported (needs at most one start-only var)`);
  const root: string | undefined = roots[0];

  const aliases = new Map(st.traverserLayout.aliases);
  // `shape` is what the var actually holds — recorded rather than assumed 'vertex', so a later
  // pattern starting from it re-roots with the right elem and a re-bind can be shape-checked.
  const bind = (v: string, shape: AliasShape): string => {
    let e = aliases.get(v);
    if (!e) { e = { col: `a${aliases.size}`, shapes: new Set([shape]) }; aliases.set(v, e); }
    return e.col;
  };

  // Seed: carry the incoming id + any outer alias columns, and bind the traverser to a var column.
  // That column is the ROOT variable when the patterns declare one, and the internal
  // TRAVERSER_LABEL when they do not — either way `restoreId` reads an alias column, which is the
  // only thing a scalar-ending pattern body carries through (see IdSource).
  const prev0 = prevRel(st, 'p');
  const idCol = bind(root ?? TRAVERSER_LABEL, 'vertex');
  const restoreId: IdSource = (f) => aliasId(f.c[idCol], 'last');
  const seedProj: Expression[] = [q`${prev0.c.id}`, ...aliasColsOf(st.traverserLayout.aliases).map((c) => q`${prev0.c[c]}`),
    q`${aliasSeed(nodeEntry(prev0.c.id))} AS ${idCol}`];
  let cur: ElementStream = advance(st, q`SELECT ${list(seedProj, ', ')} FROM ${prev0}`, { aliases: new Map(aliases), cols: ['id', ...aliasColsOf(aliases)] });

  // Greedy dependency order, one readiness rule for both argument kinds: an argument may run once
  // the variables it READS are bound — the start var for a bind (its end is what it produces), every
  // mentioned var for a filter (it produces nothing, so all of them must already exist).
  const ready = (p: Pattern): boolean => p.kind === 'bind'
    ? aliases.has(p.start)
    : p.reads.every((v) => aliases.has(v));
  const pending = [...pats];
  let guard = pending.length * pending.length + 1;
  while (pending.length) {
    if (guard-- < 0) throw new Error('match() pattern dependency cycle not yet supported');
    const idx = pending.findIndex(ready);
    if (idx < 0) {
      const p = pending[0];
      throw new Error(p.kind === 'bind'
        ? `match() pattern with an unbound start variable ("${p.start}") not yet supported`
        : `match() filter reading ${p.reads.filter((v) => !aliases.has(v)).map((v) => `"${v}"`).join('/')}, which no pattern binds`);
    }
    const p = pending.splice(idx, 1)[0];
    cur = p.kind === 'bind' ? applyPattern(cur, p, aliases, restoreId, bind) : applyFilter(cur, p.step);
  }
  // The internal traverser binding is not a Gremlin label — drop it so a downstream select()/where()
  // sees exactly the variables the patterns declared. Its COLUMN stays (id was restored from it).
  if (root === undefined)
    cur = withLayout(cur, { aliases: new Map([...cur.traverserLayout.aliases].filter(([k]) => k !== TRAVERSER_LABEL)) });
  return cur;
};
