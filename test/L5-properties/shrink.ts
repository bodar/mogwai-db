// THE SHRINKER — delta-debug a declining query down to a MINIMAL declining core (cc1-shrink,
// docs/2026-11-15-compositional-coverage-plan.md §3 Phase 1).
//
// It works on a CONCRETE step tree read off the ANTLR parse tree, not on the IR. The IR (`stepChain`) is
// lossy for this purpose — an `Arg` holds a resolved value, a predicate object, a nested parse context —
// so rendering it back to Gremlin would need a printer for the whole argument vocabulary, and every gap
// in that printer would silently change the query being shrunk. A step here is instead its OWN SOURCE
// TEXT with its child traversals cut out as holes (`QStep.segs`), so rendering is concatenation and a
// step nobody edited renders byte-for-byte as written. The renderer's one normalisation is the
// separator between steps (always `.`, so `g.V() .out()` loses its space); `renderTree(readTree(q))`
// re-parses to the same step chain, which `shrink.test.ts` holds over the L1 corpus.
//
// Reduction moves, tried most-reducing first, each kept only if the caller's predicate still holds
// (`shrink`: the query still parses, is not a write, and still declines the same way):
//   1. HOIST     — replace a host step by its child's body, inline (`where(__.out().count())` → `out().count()`);
//   2. DROP      — remove one step (a `by()` modulator is a step, so this drops a `by()` too);
//   3. IDENTITY  — replace a child traversal with `__.identity()`;
//   4. DROP-ARG  — remove one top-level argument (an arm of `union`/`coalesce`, a key of `project`, a
//                  literal of `has`), which is also the literal simplification: literals are what the
//                  signature normalises away, so the shrink only needs FEWER of them, not smaller ones.
// Greedy and first-improvement, restarting after every accepted move, so the result is 1-minimal under
// these moves and fully deterministic (no randomness anywhere).
//
// `times`/`until`/`emit` are never dropped: dropping a `repeat`'s bound turns a terminating query into
// one that is infinite per the spec (root CLAUDE.md, "repeat() has no artificial depth cap") and the
// shrinker would hang in SQLite.
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { anyParams } from '../support/any-params.ts';

export interface QStep { readonly name: string; readonly segs: readonly (string | QChain)[] }
export interface QChain { readonly anon: boolean; readonly steps: readonly QStep[] }
/** `head` is the source text before the spawn step (`g.` plus any source configuration), `root` the
 *  spawn step and its chain, `tail` whatever follows the chain (a terminal method). */
export interface QTree { readonly head: string; readonly root: QChain; readonly tail: string }

// ─────────────────────────── read ───────────────────────────

type Ctx = { constructor: { name: string }; start: { start: number; text: string }; stop: { stop: number } | null; getChildCount(): number; getChild(i: number): any };
const cls = (n: any): string => n?.constructor?.name ?? '';
const kids = (n: any): any[] => Array.from({ length: n.getChildCount?.() ?? 0 }, (_, i) => n.getChild(i));

/** Read a query into its concrete step tree. Throws when the query has no root traversal. */
export function readTree(query: string): QTree {
  const list = parseGremlin(query) as any;
  const root = findFirst(list, 'RootTraversalContext');
  if (!root) throw new Error(`readTree: no root traversal in ${query}`);
  const spawn = kids(root).find((c) => cls(c) === 'TraversalSourceSpawnMethodContext') as Ctx;
  const chained = kids(root).find((c) => cls(c) === 'ChainedTraversalContext');
  const methods = [spawn, ...(chained ? flatten(chained) : [])];
  const last = methods[methods.length - 1]!;
  return {
    head: query.slice(0, spawn.start.start),
    root: { anon: false, steps: methods.map((m) => readStep(query, m)) },
    tail: query.slice(last.stop!.stop + 1),
  };
}

function findFirst(n: any, name: string): any {
  if (cls(n) === name) return n;
  for (const c of kids(n)) { const f = findFirst(c, name); if (f) return f; }
  return null;
}

/** A left-recursive `chainedTraversal` as its `traversalMethod`s, in order. */
function flatten(chained: any): Ctx[] {
  const out: Ctx[] = [];
  const go = (n: any) => {
    for (const c of kids(n)) {
      if (cls(c) === 'ChainedTraversalContext') go(c);
      else if (cls(c) === 'TraversalMethodContext') out.push(c);
    }
  };
  go(chained);
  return out;
}

function readStep(query: string, ctx: Ctx): QStep {
  const from = ctx.start.start, to = ctx.stop!.stop + 1;
  const holes: any[] = [];
  const collect = (n: any) => {
    for (const c of kids(n)) {
      if (cls(c) === 'NestedTraversalContext') holes.push(c);
      else collect(c);
    }
  };
  collect(ctx);
  const segs: (string | QChain)[] = [];
  let at = from;
  for (const h of holes) {
    segs.push(query.slice(at, h.start.start));
    segs.push(readChain(query, h));
    at = h.stop.stop + 1;
  }
  segs.push(query.slice(at, to));
  return { name: ctx.start.text, segs: segs.filter((s) => s !== '') };
}

function readChain(query: string, nested: any): QChain {
  const anon = cls(nested.getChild(0)) !== 'ChainedTraversalContext';
  const chained = kids(nested).find((c) => cls(c) === 'ChainedTraversalContext');
  return { anon, steps: flatten(chained).map((m) => readStep(query, m)) };
}

// ─────────────────────────── render ───────────────────────────

export const renderStep = (s: QStep): string => s.segs.map((x) => (typeof x === 'string' ? x : renderChain(x))).join('');
export const renderChain = (c: QChain): string => (c.anon ? '__.' : '') + c.steps.map(renderStep).join('.');
export const renderTree = (t: QTree): string => t.head + renderChain(t.root) + t.tail;

/** Does `query` parse and chain? (The shrinker's first acceptance condition.) */
export function parses(query: string): boolean {
  try { stepChain(parseGremlin(query), anyParams()); return true; } catch { return false; }
}

// ─────────────────────────── structure helpers ───────────────────────────

export const childrenOf = (s: QStep): QChain[] => s.segs.filter((x): x is QChain => typeof x !== 'string');
export const IDENTITY: QChain = { anon: true, steps: [{ name: 'identity', segs: ['identity()'] }] };
const isIdentity = (c: QChain) => c.steps.length === 1 && c.steps[0]!.name === 'identity' && renderStep(c.steps[0]!) === 'identity()';

/** Child-traversal nesting depth of a chain (0 = no child). */
export const chainDepth = (c: QChain): number =>
  Math.max(0, ...c.steps.flatMap((s) => childrenOf(s).map((k) => 1 + chainDepth(k))));

/** A path to a chain: pairs of (step index, seg index) from the root. */
type Path = readonly (readonly [number, number])[];

function* chainsOf(c: QChain, path: Path = []): Generator<{ chain: QChain; path: Path }> {
  yield { chain: c, path };
  for (let k = 0; k < c.steps.length; k++) {
    const segs = c.steps[k]!.segs;
    for (let j = 0; j < segs.length; j++) {
      const x = segs[j]!;
      if (typeof x !== 'string') yield* chainsOf(x, [...path, [k, j]]);
    }
  }
}

/** Rebuild `c` with the chain at `path` replaced by `f(chain)`. */
function updateAt(c: QChain, path: Path, f: (c: QChain) => QChain): QChain {
  if (path.length === 0) return f(c);
  const [[k, j], ...rest] = path as [readonly [number, number], ...Path];
  const steps = c.steps.slice();
  const step = steps[k]!;
  const segs = step.segs.slice();
  segs[j] = updateAt(segs[j] as QChain, rest, f);
  steps[k] = { name: step.name, segs };
  return { anon: c.anon, steps };
}

/** Split a step's argument list at its top-level commas: `name(` + args + `)`. A child chain is opaque.
 *  Returns null when the step text is not a plain `name(...)` call. */
function splitArgs(s: QStep): { open: string; args: (string | QChain)[][]; close: string } | null {
  const first = s.segs[0], last = s.segs[s.segs.length - 1];
  if (typeof first !== 'string' || typeof last !== 'string') return null;
  const lp = first.indexOf('(');
  if (lp < 0 || !last.endsWith(')')) return null;
  const segs: (string | QChain)[] = s.segs.slice();
  segs[0] = first.slice(lp + 1);
  const end = segs.length - 1;
  segs[end] = (segs[end] as string).slice(0, -1);
  const args: (string | QChain)[][] = [[]];
  let depth = 0;
  let quote: string | null = null;
  for (const seg of segs) {
    if (typeof seg !== 'string') { args[args.length - 1]!.push(seg); continue; }
    let cur = '';
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i]!;
      if (quote) { cur += ch; if (ch === '\\') { cur += seg[++i] ?? ''; } else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { if (cur) args[args.length - 1]!.push(cur); args.push([]); cur = ''; continue; }
      cur += ch;
    }
    if (cur) args[args.length - 1]!.push(cur);
  }
  if (depth !== 0 || quote) return null;
  return { open: first.slice(0, lp + 1), args: args.filter((a) => a.some((x) => typeof x !== 'string' || x.trim() !== '')), close: ')' };
}

const NEVER_DROP = new Set(['times', 'until', 'emit']);
const BRANCHES = new Set(['coalesce', 'union', 'choose', 'and', 'or', 'branch']);

/** How many modulators (`by`/`option`/`with`/…) follow step `k` — they belong to it, so a move that
 *  removes the step removes them too (an orphan `by()` is not a query, and the shrink would slip to it). */
const modulatorsAfter = (steps: readonly QStep[], k: number): number => {
  let n = 0;
  while (k + 1 + n < steps.length && MODULATORS.has(steps[k + 1 + n]!.name)) n++;
  return n;
};

/** Steps that name a path label or side-effect key another step may read back. */
const LABELLING = new Set(['as', 'aggregate', 'store', 'group', 'groupCount', 'tree', 'subgraph', 'sideEffect']);

/** An `as('x')` (or `aggregate('x')`, …) is droppable only when nothing else mentions `'x'` — else the
 *  drop slips to a different query (a `select`/`where`/`within` over a name that no longer exists). */
const labelInUse = (s: QStep, whole: string): boolean => {
  if (!LABELLING.has(s.name)) return false;
  const own = renderStep(s);
  for (const m of own.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
    const label = m[1] ?? m[2] ?? '';
    const uses = whole.split(new RegExp(`['"]${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`)).length - 1;
    if (uses > 1) return true;
  }
  return false;
};

/** Every one-move reduction of `t`, most-reducing kind first. */
export function* reductions(t: QTree): Generator<QTree> {
  const all = [...chainsOf(t.root)];
  const whole = renderTree(t);
  const at = (path: Path, f: (c: QChain) => QChain): QTree => ({ ...t, root: updateAt(t.root, path, f) });
  const inputs = chainInputs(t);
  // 1. HOIST: a host step (with its modulators) replaced by one of its children's bodies, inline, so the
  //    body runs over the input the host received. A child inside a MODULATOR (`project(…).by(b)`) hoists
  //    over the modulated step and all its modulators — `project('p').b` would run `b` over a Map.
  //    The steps AFTER the host are kept only when the body leaves the stream in the shape the host would
  //    have (`where(b)` passes its input on; `b` inline passes on what `b` ends at): otherwise they would
  //    run over a different shape — `where(__.out().count()).simplePath()` is not `out().count().simplePath()`
  //    — so they go with it.
  for (const { chain, path } of all) {
    const shapes = stepShapes(chain, inputs.get(chain) ?? 'unknown');
    for (let k = 0; k < chain.steps.length; k++) {
      let host = k;
      while (host > 0 && MODULATORS.has(chain.steps[host]!.name)) host--;
      if (path.length === 0 && host === 0) continue; // the spawn step stays the spawn step
      const span = 1 + modulatorsAfter(chain.steps, host);
      const after = shapes[host + span]!;
      for (const child of childrenOf(chain.steps[k]!)) {
        const keepTail = host + span >= chain.steps.length || (after !== 'unknown' && flow(child, shapes[host]!, { n: 0 }) === after);
        yield at(path, (c) => ({ anon: c.anon, steps: [...c.steps.slice(0, host), ...child.steps, ...(keepTail ? c.steps.slice(host + span) : [])] }));
      }
    }
  }
  // 2. DROP a step with its modulators (from the end first: a suffix drop is the commonest win). Mid-chain,
  //    only a step that leaves the stream's shape as it found it — dropping `path()` from
  //    `path().count(local)` is a different question (`count(local)` of a vertex), not a smaller one.
  for (const { chain, path } of all) {
    const min = path.length === 0 ? 1 : 0;
    const shapes = stepShapes(chain, inputs.get(chain) ?? 'unknown');
    for (let k = chain.steps.length - 1; k >= min; k--) {
      const s = chain.steps[k]!;
      if (NEVER_DROP.has(s.name) || labelInUse(s, whole)) continue;
      // `by()`s are POSITIONAL (`group().by(k).by(v)`: dropping the first makes `v` the key), so only
      // the last of a run may go.
      if (s.name === 'by' && chain.steps[k + 1]?.name === 'by') continue;
      const span = MODULATORS.has(s.name) ? 1 : 1 + modulatorsAfter(chain.steps, k);
      const last = k + span >= chain.steps.length;
      if (!last && !PRESERVE.has(s.name) && !(shapes[k] !== 'unknown' && shapes[k] === shapes[k + span])) continue;
      if (chain.steps.length - span < 1) continue;
      yield at(path, (c) => ({ anon: c.anon, steps: c.steps.filter((_, i) => i < k || i >= k + span) }));
    }
  }
  // 3. IDENTITY: a child traversal replaced by `__.identity()`.
  for (const { chain, path } of all.slice(1)) if (!isIdentity(chain)) yield at(path, () => IDENTITY);
  // 4. DROP-ARG: one top-level argument removed — never a bare token (`local`, `desc`, `T.label`: dropping
  //    `local` from `range(local,0,2)` asks a different question), and never on a step its `by()`s
  //    modulate POSITIONALLY (`project('a','b').by(x).by(y)` minus an argument re-pairs keys and `by()`s;
  //    DROP takes the last `by()` instead).
  for (const { chain, path } of all) {
    for (let k = 0; k < chain.steps.length; k++) {
      const split = splitArgs(chain.steps[k]!);
      if (!split || split.args.length < 2 || chain.steps[k + 1]?.name === 'by') continue;
      // A branch keeps two arms: a one-arm `coalesce(b)` is a degenerate form no one writes, and measured,
      // shrinking every coalesce to it made it the top cluster (548 reach) while hiding why each declined.
      if (BRANCHES.has(chain.steps[k]!.name) && split.args.length <= 2) continue;
      for (let a = split.args.length - 1; a >= 0; a--) {
        const arg = split.args[a]!;
        if (arg.length === 1 && typeof arg[0] === 'string' && /^\s*[A-Za-z_][\w.]*\s*$/.test(arg[0])) continue;
        const keep = split.args.filter((_, i) => i !== a);
        const segs: (string | QChain)[] = [split.open];
        keep.forEach((arg, i) => { if (i) segs.push(','); segs.push(...arg); });
        segs.push(split.close);
        const merged = mergeText(segs);
        yield at(path, (c) => ({ anon: c.anon, steps: c.steps.map((s, i) => (i === k ? { name: s.name, segs: merged } : s)) }));
      }
    }
  }
}

const mergeText = (segs: readonly (string | QChain)[]): (string | QChain)[] => {
  const out: (string | QChain)[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (typeof s === 'string' && typeof prev === 'string') out[out.length - 1] = prev + s;
    else out.push(s);
  }
  return out;
};

/** A size measure the shrink strictly decreases (so it terminates): total steps, then rendered length. */
const size = (t: QTree): number => {
  let n = 0;
  for (const { chain } of chainsOf(t.root)) n += chain.steps.length;
  return n * 100_000 + renderTree(t).length;
};

// ─────────────────────────── slippage guard: a coarse type check ───────────────────────────
//
// Delta debugging SLIPS: a move can turn the query into a different, broken one that also declines —
// `g.V().project('p').by(…).select('p').out()` minus its `select` is `project('p').out()`, a Map walked as
// a vertex, which declines for a reason unrelated to the original's. Declines of that kind are an
// attractor (every type error is one), so measured without this guard a third of the top clusters were
// such artefacts. The guard: a candidate may not have MORE type violations than the query it came from.
// It is deliberately coarse — a stream shape per step name (`vertex` / `edge` / `vprop` / `number` /
// `scalar` / `map` / `list` / `path` / `unknown`), with `unknown` never a violation — because it only has
// to catch the slips a single move makes, not type-check Gremlin.

type Shape = 'vertex' | 'edge' | 'vprop' | 'number' | 'scalar' | 'map' | 'list' | 'path' | 'unknown';
const PRESERVE = new Set(['has', 'hasLabel', 'hasId', 'hasNot', 'hasKey', 'hasValue', 'where', 'filter', 'not', 'and', 'or', 'is', 'dedup', 'order', 'limit', 'range', 'skip', 'tail', 'coin', 'sample', 'simplePath', 'cyclicPath', 'as', 'identity', 'aggregate', 'store', 'sideEffect', 'barrier', 'emit', 'until', 'times', 'by', 'option', 'with', 'subgraph', 'timeLimit', 'none', 'discard', 'profile', 'fail']);
const TO: Readonly<Record<string, Shape>> = {
  V: 'vertex', E: 'edge', out: 'vertex', in: 'vertex', both: 'vertex', outE: 'edge', inE: 'edge', bothE: 'edge',
  outV: 'vertex', inV: 'vertex', otherV: 'vertex', bothV: 'vertex', properties: 'vprop',
  count: 'number', sum: 'number', mean: 'number', math: 'number', loops: 'number',
  values: 'scalar', value: 'scalar', key: 'scalar', id: 'scalar', label: 'scalar', min: 'scalar', max: 'scalar',
  fold: 'list', path: 'path', project: 'map', valueMap: 'map', elementMap: 'map', propertyMap: 'map', group: 'map', groupCount: 'map', tree: 'map',
};
/** Steps whose input must be an element (vertex/edge; a vertex property for the `vprop` ones). */
const NEEDS_VERTEX = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);
const NEEDS_EDGE = new Set(['outV', 'inV', 'otherV', 'bothV']);
const NEEDS_ELEMENT = new Set(['values', 'properties', 'valueMap', 'elementMap', 'propertyMap', 'hasLabel', 'hasId', 'label', 'id', 'has', 'hasNot']);
const NEEDS_VPROP = new Set(['key', 'value', 'hasKey', 'hasValue']);
const NEEDS_NUMBER = new Set(['sum', 'mean']);
/** Steps a `by()` can modulate (a `by()` after anything else is an orphan). */
const BY_HOSTS = new Set(['project', 'order', 'group', 'groupCount', 'dedup', 'path', 'select', 'tree', 'valueMap', 'propertyMap', 'elementMap', 'math', 'where', 'sample', 'simplePath', 'cyclicPath', 'sack', 'aggregate', 'format', 'addE', 'from', 'to', 'cap', 'index', 'by']);
const OPTION_HOSTS = new Set(['choose', 'branch', 'mergeV', 'mergeE', 'option']);

const isLocalStep = (s: QStep) => /\b(?:local|Scope\.local)\b/.test(renderStep(s).slice(s.name.length));

/** Shape after a chain from `input`, counting violations into `v`. `rec` collects every child chain's
 *  input shape; `before` (this chain only) the shape in front of each step, plus the final shape. */
function flow(c: QChain, input: Shape, v: { n: number }, rec?: Map<QChain, Shape>, before?: Shape[]): Shape {
  rec?.set(c, input);
  let shape = input;
  let hostInput = input; // the shape a modulator's child sees: what its host step received
  for (let k = 0; k < c.steps.length; k++) {
    const s = c.steps[k]!;
    before?.push(shape);
    const kids = childrenOf(s);
    const bad = (need: readonly Shape[]) => { if (shape !== 'unknown' && !need.includes(shape)) v.n++; };
    if (!MODULATORS.has(s.name)) hostInput = shape;
    if (NEEDS_ELEMENT.has(s.name) && !(['has', 'id', 'label', 'values'].includes(s.name) && shape === 'vprop')) bad(['vertex', 'edge']);
    if (NEEDS_VERTEX.has(s.name)) bad(['vertex']);
    if (NEEDS_EDGE.has(s.name)) bad(['edge']);
    if (NEEDS_VPROP.has(s.name)) bad(['vprop']);
    if (NEEDS_NUMBER.has(s.name) && !isLocalStep(s)) bad(['number', 'scalar']);
    if (['min', 'max'].includes(s.name) && !isLocalStep(s)) bad(['number', 'scalar']);
    if (s.name === 'is') bad(['number', 'scalar']);
    if (s.name === 'by') {
      let j = k - 1;
      while (j >= 0 && c.steps[j]!.name === 'by') j--;
      if (j < 0 || !BY_HOSTS.has(c.steps[j]!.name)) v.n++;
    }
    if (s.name === 'option' && (k === 0 || !OPTION_HOSTS.has(c.steps[k - 1]!.name))) v.n++;
    // Children: a child of a modulator sees what its host sees; every child is walked for its own slips.
    const kidInput = MODULATORS.has(s.name) ? hostInput
      : s.name === 'repeat' || PRESERVE.has(s.name) || ['map', 'flatMap', 'local', 'coalesce', 'union', 'optional', 'choose'].includes(s.name) ? shape : 'unknown';
    for (const kid of kids) flow(kid, kidInput, v, rec);
    if (PRESERVE.has(s.name)) continue;
    if (s.name === 'map' || s.name === 'flatMap' || s.name === 'local') { shape = kids[0] ? flow(kids[0], shape, { n: 0 }) : 'unknown'; continue; }
    if (['union', 'coalesce', 'optional'].includes(s.name) && kids.length) {
      // The arms' common end shape (an optional's input is an implicit arm), else unknown.
      const ends = new Set(kids.map((kid) => flow(kid, shape, { n: 0 })));
      if (s.name === 'optional') ends.add(shape);
      shape = ends.size === 1 ? [...ends][0]! : 'unknown';
      continue;
    }
    if (s.name === 'repeat') { const end = kids[0] ? flow(kids[0], shape, { n: 0 }) : 'unknown'; shape = end === shape ? shape : 'unknown'; continue; }
    if (isLocalStep(s) && ['count', 'sum', 'mean', 'min', 'max'].includes(s.name)) { shape = s.name === 'count' ? 'number' : 'unknown'; continue; }
    shape = TO[s.name] ?? 'unknown';
  }
  before?.push(shape);
  return shape;
}

/** Every chain's input shape (the root's is `unknown`: its spawn step decides). */
function chainInputs(t: QTree): Map<QChain, Shape> {
  const rec = new Map<QChain, Shape>();
  flow(t.root, 'unknown', { n: 0 }, rec);
  return rec;
}

/** The shape in front of each step of `c`, and after the last. */
function stepShapes(c: QChain, input: Shape): Shape[] {
  const before: Shape[] = [];
  flow(c, input, { n: 0 }, undefined, before);
  return before;
}

/** The number of coarse type violations in a query (see above). */
export function violations(t: QTree): number {
  const v = { n: 0 };
  flow(t.root, 'unknown', v);
  return v.n;
}

export interface ShrinkResult { readonly core: string; readonly tree: QTree; readonly moves: number; readonly tried: number }

/**
 * Shrink `query` to a 1-minimal query for which `keep` still holds. `keep` is called only on candidates
 * that parse and add no coarse type violation (`violations`); it decides "still interesting" (the
 * attribution's: not a write, same decline kind).
 */
export function shrink(query: string, keep: (q: string) => boolean): ShrinkResult {
  let tree = readTree(query);
  let moves = 0, tried = 0;
  const seen = new Set<string>([renderTree(tree)]);
  const allowed = violations(tree);
  for (let improved = true; improved;) {
    improved = false;
    const here = size(tree);
    for (const cand of reductions(tree)) {
      const q = renderTree(cand);
      if (seen.has(q) || size(cand) >= here) continue;
      seen.add(q);
      if (violations(cand) > allowed || !parses(q)) continue;
      tried++;
      if (!keep(q)) continue;
      tree = readTree(q); // re-read: keeps every QStep a faithful slice of the CURRENT text
      moves++;
      improved = true;
      break;
    }
  }
  return { core: renderTree(tree), tree, moves, tried };
}

// ─────────────────────────── hoisting (for classification) ───────────────────────────

/** The host path to the deepest child (the step names of each enclosing host, outermost first), the
 *  innermost body, and the HOISTED query: at every level the steps before the host followed by the
 *  body, so the innermost body runs at the top level over the same input it had under its hosts.
 *  `arms` hoists each SIBLING child of the innermost host the same way (`coalesce(a, b)` → `…a`, `…b`):
 *  a seam is a host every one of whose arms lowers on its own. */
export interface Hoist {
  readonly hosts: readonly string[]; readonly body: QChain; readonly prefix: readonly QStep[][];
  readonly hoisted: string; readonly arms: readonly { readonly body: QChain; readonly hoisted: string }[];
}

export function hoist(t: QTree): Hoist | null {
  const hosts: string[] = [];
  const prefix: QStep[][] = [];
  const steps: QStep[] = [];
  let chain = t.root;
  let siblings: QChain[] = [];
  for (;;) {
    let best: { k: number; child: QChain } | null = null;
    for (let k = 0; k < chain.steps.length; k++)
      for (const child of childrenOf(chain.steps[k]!))
        if (!best || chainDepth(child) > chainDepth(best.child)) best = { k, child };
    if (!best) break;
    hosts.push(hostName(chain.steps, best.k));
    // The body's input is what the HOST received: for a modulator (`project(…).by(b)`), the steps before
    // the modulated step, not before the `by()` — `project('p').b` would walk a Map.
    let at = best.k;
    while (at > 0 && MODULATORS.has(chain.steps[at]!.name)) at--;
    prefix.push(chain.steps.slice(0, at) as QStep[]);
    steps.push(...chain.steps.slice(0, at));
    siblings = childrenOf(chain.steps[best.k]!);
    chain = best.child;
  }
  if (hosts.length === 0) return null;
  // A body whose first step is a spawn-only form (`__.V()`) still renders as a mid-traversal V().
  const render = (body: QChain) => t.head + [...steps, ...body.steps].map(renderStep).join('.') + t.tail;
  return { hosts, body: chain, prefix, hoisted: render(chain), arms: siblings.map((body) => ({ body, hoisted: render(body) })) };
}

/** A modulator is named with what it modulates: `project.by`, `choose.option`, `repeat.until`. */
const MODULATORS: ReadonlySet<string> = new Set(['by', 'option', 'until', 'emit', 'times', 'with']);
function hostName(steps: readonly QStep[], k: number): string {
  const name = steps[k]!.name;
  if (!MODULATORS.has(name)) return name;
  for (let i = k - 1; i >= 0; i--) if (!MODULATORS.has(steps[i]!.name)) return `${steps[i]!.name}.${name}`;
  return name;
}

// ─────────────────────────── signature ───────────────────────────

/** Bare enum-like tokens that change a step's meaning (kept in a signature); all literals are dropped. */
const MEANINGFUL = /\b(?:local|global|keys|values|label|id|key|value|first|last|all|mixed|desc|asc|shuffle|incr|decr|in|out|both|tail|limit|assign)\b/g;

const stripLiterals = (text: string): string => text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '');

/** The SIGNATURE of a core: step names with child traversals in parens, every literal (labels, keys,
 *  numbers, strings, predicates' operands) normalised away, scope/column/token words kept —
 *  `V.where(out.count)`, `V.map(path).count(local)`. */
export function signature(c: QChain): string {
  return c.steps.map((s) => {
    const kidsSig = childrenOf(s).map(signature);
    const text = stripLiterals(s.segs.filter((x): x is string => typeof x === 'string').join(' ').slice(s.name.length));
    const words = [...new Set(text.match(MEANINGFUL) ?? [])].filter((w) => w !== s.name);
    const inner = [...words, ...kidsSig];
    return inner.length ? `${s.name}(${inner.join(',')})` : s.name;
  }).join('.');
}
