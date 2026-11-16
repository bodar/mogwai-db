// THE ATTRIBUTION — every decline the Phase 0 instruments see, shrunk to a minimal core, clustered by
// signature, and classified (cc1-shrink + cc1-classify, docs/2026-11-15-compositional-coverage-plan.md
// §3 Phase 1). An INSTRUMENT, not a gate: `mise run attribution` (`scripts/coverage-attribution.ts`)
// writes the ranked table to `.logs/coverage-attribution.md`; nothing here runs in `ci` beyond the
// shrinker's own unit test.
//
// INPUTS, weighted by REACH (how likely a real user writes the shape):
//   workload  ×8 — `test/L6-workload`, the app-shaped corpus with TinkerGraph goldens;
//   realistic ×4 — the `realistic` coverage profile (app idioms over `modern`);
//   host      ×2 — the host-closure sweep's declines (a body that runs inline, under a host);
//   lattice   ×1 — the `lattice` coverage profile (type-correct, semantically arbitrary).
//
// THE DECLINE PREDICATE IS COMPILE-ONLY. Measured on 141 declines across both profiles: every one is
// raised by `compile()`, before a statement runs — so a candidate is checked by compiling it, never by
// executing it. That is also what makes the shrink SAFE: a move can turn a terminating query into an
// unbounded `repeat(both())` (a candidate is not the query the user wrote), and an executed one would
// hang SQLite. The two decline sources that are NOT compile-time — a statement past a SQLite/DO limit
// (`src/storage.ts`) — are class (c) and are classified from the message without shrinking.
//
// CLASSES (cc1-classify):
//   (a) seam     — the core nests a child, and its innermost body HOISTED to the top level over the same
//                  input (every enclosing host replaced by the steps before it) compiles; decided
//                  MECHANICALLY by compiling (and, when it holds no `repeat`, executing) the hoisted form;
//   (b) step     — the core has no child (the step itself has no lowering), or the hoisted body itself
//                  declines;
//   (c) platform — a SQLite/DO statement limit, identified by its message;
//   (d) noise    — LATTICE cores only: a filter over an always-productive reducer (`isConstantFilter`, which
//                  cites why), or a hoisted body that is not a query in its own right (it does not parse,
//                  or the reference rejects it). The generator's type lattice admits such bodies; an app does
//                  not write them. From any other source the same outcome is filed as (b), never as noise.
import type { GraphStore } from '../../src/storage.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';
import { DEFAULT_FAST_PATHS } from '../../src/compiler/options/fast-paths.ts';
import { seeded, isWrite } from '../support/graph.ts';
import { failsClosed, describeThrow } from '../support/fail-closed.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { CORPUS, type GraphName } from '../L6-workload/corpus.ts';
import { MINT } from '../L6-workload/workload.ts';
import { outcomeOf } from './oracle.ts';
import { childDepth, PROFILES } from './coverage.ts';
import { sweep } from './host-closure.ts';
import { chainDepth, childrenOf, hoist, parses, readTree, renderStep, shrink, signature, type QChain, type QStep } from './shrink.ts';

export type Source = 'workload' | 'realistic' | 'host' | 'lattice';
export const WEIGHT: Readonly<Record<Source, number>> = { workload: 8, realistic: 4, host: 2, lattice: 1 };
export const SOURCES: readonly Source[] = ['workload', 'realistic', 'host', 'lattice'];

export type Klass = 'a' | 'b' | 'c' | 'd';
export const KLASS_NAME: Readonly<Record<Klass, string>> = { a: 'seam', b: 'step', c: 'platform', d: 'noise' };

/** One declining input query. */
export interface Decline { readonly source: Source; readonly query: string; readonly graph: GraphName; readonly depth: number; readonly message: string; readonly kind: string }

/** A throw that is not fail-closed, met anywhere in the sweep — a defect, never acceptable. */
export interface Internal { readonly query: string; readonly error: string; readonly where: string }

// ─────────────────────────── collect ───────────────────────────

const PLATFORM = /exceeds a SQLite statement limit|longer than this store accepts in one statement/;

export interface CollectOptions { readonly perSeed: number; readonly hostCases: number }

/** Run every input once (fully executed) and keep its declines. Internal errors go to `internal`. */
export function collect(opts: CollectOptions, internal: Internal[]): Decline[] {
  const out: Decline[] = [];
  const stores = new Map<GraphName, GraphStore>();
  const storeOf = (g: GraphName) => stores.get(g) ?? (stores.set(g, MINT[g]()), stores.get(g)!);
  const consider = (source: Source, query: string, graph: GraphName = 'modern') => {
    if (isWrite(query)) return;
    const o = outcomeOf(storeOf(graph), query, DEFAULT_FAST_PATHS);
    if (o.kind !== 'threw') return;
    if (o.error instanceof UnsupportedTraversal)
      out.push({ source, query, graph, depth: safeDepth(query), message: o.message, kind: o.error.kind });
    else if (!failsClosed(o.error)) internal.push({ query, error: describeThrow(o.error), where: `${source} input` });
  };
  for (const e of CORPUS) consider('workload', e.query, e.graph);
  for (const profile of ['realistic', 'lattice'] as const)
    for (const seed of PROFILES[profile].seeds)
      for (const q of PROFILES[profile].sample(seed, opts.perSeed)) consider(profile, q);
  // The host-closure ratchet sample (seed 42, as host-closure.test.ts draws it) — its declines are
  // already executed by the sweep, so take them as they are.
  const r = sweep(seeded(MODERN_SEED), 42, opts.hostCases);
  for (const q of new Set(r.declined)) {
    const o = outcomeOf(storeOf('modern'), q, DEFAULT_FAST_PATHS);
    if (o.kind === 'threw' && o.error instanceof UnsupportedTraversal)
      out.push({ source: 'host', query: q, graph: 'modern', depth: safeDepth(q), message: o.message, kind: o.error.kind });
  }
  for (const i of r.internal) internal.push({ query: i.split('\n')[0]!, error: i.split('\n')[1]?.trim() ?? '', where: 'host-closure sweep' });
  return out;
}

const safeDepth = (q: string): number => { try { return childDepth(q); } catch { return chainDepth(readTree(q).root); } };

// ─────────────────────────── shrink + classify ───────────────────────────

export type SItem = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | '—';

export interface Core {
  readonly core: string;
  readonly signature: string;
  readonly klass: Klass;
  /** Why the class, in a few words (the hoisted verdict). */
  readonly why: string;
  readonly sitem: SItem;
  /** The innermost host (S4's connector row), or '' for a depth-0 core. */
  readonly host: string;
  readonly coreDepth: number;
  readonly shrunk: boolean;
}

type CompileVerdict = { v: 'ok' } | { v: 'decline'; kind: string; message: string } | { v: 'error'; message: string } | { v: 'internal'; message: string };

export class Attributor {
  readonly #compiled = new Map<string, CompileVerdict>();
  readonly #cores = new Map<string, Core>();
  readonly #stores = new Map<GraphName, GraphStore>();
  tried = 0;
  constructor(readonly internal: Internal[]) {}

  /** Compile only — the decline predicate (see the header). A non-fail-closed throw is recorded. */
  compileVerdict(q: string, where: string): CompileVerdict {
    const hit = this.#compiled.get(q);
    if (hit) return hit;
    let v: CompileVerdict;
    try { compile(q, {}); v = { v: 'ok' }; } catch (e) {
      if (e instanceof UnsupportedTraversal) v = { v: 'decline', kind: e.kind, message: e.message };
      else if (failsClosed(e) || /segment plan that must be DRIVEN/.test(String(e))) v = { v: 'error', message: String(e) };
      else { v = { v: 'internal', message: describeThrow(e) }; this.internal.push({ query: q, error: v.message, where }); }
    }
    this.#compiled.set(q, v);
    return v;
  }

  #store(g: GraphName): GraphStore { return this.#stores.get(g) ?? (this.#stores.set(g, MINT[g]()), this.#stores.get(g)!); }

  /** Shrink and classify one decline (memoised by query text). */
  attribute(d: Decline): Core {
    const key = `${d.graph}\u0000${d.query}`;
    const hit = this.#cores.get(key);
    if (hit) return hit;
    const core = this.#attribute(d);
    this.#cores.set(key, core);
    return core;
  }

  #attribute(d: Decline): Core {
    const tree0 = readTree(d.query);
    if (PLATFORM.test(d.message))
      return { core: d.query, signature: signature(tree0.root), klass: 'c', why: 'statement limit', sitem: '—', host: '', coreDepth: chainDepth(tree0.root), shrunk: false };
    const first = this.compileVerdict(d.query, 'original');
    let core = d.query, shrunk = false;
    if (first.v === 'decline') {
      const r = shrink(d.query, (q) => {
        if (isWrite(q)) return false;
        const v = this.compileVerdict(q, `shrinking ${d.query}`);
        return v.v === 'decline' && v.kind === first.kind;
      });
      this.tried += r.tried;
      core = r.core; shrunk = true;
    }
    const tree = readTree(core);
    const sig = signature(tree.root);
    const h = hoist(tree);
    const base = { core, signature: sig, shrunk, coreDepth: chainDepth(tree.root) };
    if (!h) return { ...base, klass: 'b', why: 'no child: the step itself declines', sitem: '—', host: '' };
    const host = h.hosts[h.hosts.length - 1]!;
    // Every arm of the innermost host (one, for a single-child host) is hoisted and judged on its own.
    const armSteps: QChain = { anon: true, steps: h.arms.flatMap((a) => a.body.steps) };
    const sitem = sItemOf(h.prefix, h.hosts, armSteps);
    if (d.source === 'lattice' && isConstantFilter(host, h.body))
      return { ...base, klass: 'd', why: 'a filter over an always-productive reducer (constant filter)', sitem: '—', host };
    const verdicts = h.arms.map((a) => this.#hoistedVerdict(a.hoisted, core, d.graph));
    const declined = verdicts.find((v) => v.startsWith('declines'));
    if (declined) return { ...base, klass: 'b', why: `hoisted body ${declined}`, sitem: '—', host };
    // A hoisted body that does not parse or is rejected/raised on by the reference is not a query of its
    // own. From the lattice that is the generator's arbitrariness (noise); from an app-shaped source it is
    // filed as a step gap, never as noise — those sources are written to be meaningful.
    const broken = verdicts.find((v) => v !== 'executes');
    if (broken) return { ...base, klass: d.source === 'lattice' ? 'd' : 'b', why: `hoisted body ${broken}`, sitem: '—', host };
    return { ...base, klass: 'a', why: h.arms.length > 1 ? `every hoisted arm (${h.arms.length}) executes` : 'hoisted body executes', sitem, host };
  }

  /** `executes` | `declines too` | `does not parse` | `is rejected: …` | `raises: …`. */
  #hoistedVerdict(hoisted: string, core: string, graph: GraphName): string {
    if (!parses(hoisted)) return 'does not parse';
    const v = this.compileVerdict(hoisted, `hoisting ${core}`);
    if (v.v === 'decline') return 'declines too';
    if (v.v !== 'ok') return `is rejected: ${v.message.slice(0, 80)}`;
    // Executing it also catches a runtime reference error; skipped for a `repeat`, which a hoist can
    // leave unbounded (see the header).
    if (/\brepeat\(/.test(hoisted)) return 'executes';
    const o = outcomeOf(this.#store(graph), hoisted, DEFAULT_FAST_PATHS);
    if (o.kind === 'rows') return 'executes';
    if (!failsClosed(o.error)) this.internal.push({ query: hoisted, error: describeThrow(o.error), where: `hoisted from ${core}` });
    return o.error instanceof UnsupportedTraversal ? 'declines too' : `raises: ${o.message.slice(0, 80)}`;
  }
}

/**
 * THE NOISE RULE (class d — applied to LATTICE cores only). A filter host (`where`/`not`/`and`/`or`/
 * `filter`) whose body ENDS in a seeded reducer (`count()`/`fold()`/`group()`/`groupCount()`, global) is a
 * constant: a seeded reducer emits even over an empty stream (a seed supplier —
 * vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CountGlobalStep.java:41,
 * FoldStep.java:53 beside it),
 * so the body is always productive and `where(b)` keeps everything, `not(b)` nothing. An application asks
 * `count().is(gt(0))` instead — which the realistic profile draws. The lattice draws the bare form because its
 * type lattice admits any body; that is generator arbitrariness, not a gap a user meets. (Such a core is still
 * a real decline and still lands in the cluster table, filed as (d) rather than as evidence for (a) or (b).)
 */
const FILTER_HOSTS = new Set(['where', 'not', 'and', 'or', 'filter']);
function isConstantFilter(host: string, body: QChain): boolean {
  const last = body.steps[body.steps.length - 1];
  return FILTER_HOSTS.has(host) && !!last && SEEDED.has(last.name) && !isLocal(last);
}

// ─────────────────────────── the S-item heuristic ───────────────────────────
//
// Which of the plan's S1–S5 a seam core most likely needs, from step names alone (cheap, and stated as a
// heuristic in the report). Precedence: the HOST's input is a value (S1: a non-element framing needs a
// scope key) > the body yields or re-enters a STRUCTURED value (S5) > the body holds a barrier (S2 at
// depth ≥ 2 — the scope stack; S3 when it is a SEEDED barrier at depth 1 — the domain law) > S4, a
// missing connector row for the host.

const ELEMENT = new Set(['V', 'E', 'out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'otherV', 'bothV', 'addV', 'addE', 'mergeV', 'mergeE', 'properties']);
const VALUE = new Set(['values', 'value', 'key', 'id', 'label', 'count', 'sum', 'mean', 'min', 'max', 'fold', 'constant', 'project', 'path', 'valueMap', 'elementMap', 'propertyMap', 'math', 'group', 'groupCount', 'inject', 'sack', 'loops', 'index', 'concat', 'toUpper', 'toLower', 'length', 'asString', 'tree', 'cap', 'format', 'split', 'substring', 'trim', 'replace', 'reverse', 'dateAdd', 'dateDiff', 'asDate', 'asNumber', 'asBool', 'conjoin', 'combine', 'difference', 'disjunct', 'intersect', 'merge', 'product']);
/** A structured value crossing the seam (S5) — including the PATH channel a `simplePath()`/`cyclicPath()`
 *  body reads (the plan's "`path()` as a value is simply the path channel projected as a payload"). */
const STRUCT = new Set(['path', 'simplePath', 'cyclicPath', 'fold', 'project', 'valueMap', 'elementMap', 'propertyMap', 'group', 'groupCount', 'tree', 'unfold', 'cap']);
const BARRIER = new Set(['count', 'sum', 'min', 'max', 'mean', 'fold', 'dedup', 'order', 'group', 'groupCount', 'limit', 'range', 'tail', 'skip', 'aggregate', 'barrier', 'cap']);
const SEEDED = new Set(['count', 'fold', 'group', 'groupCount']);
const isLocal = (s: QStep) => /\blocal\b/.test(renderStep(s).slice(s.name.length));

/** 'element' | 'value' | 'unknown' after `steps` (a shape-preserving step keeps what came before). */
function shapeAfter(steps: readonly QStep[]): 'element' | 'value' | 'unknown' {
  let shape: 'element' | 'value' | 'unknown' = 'unknown';
  for (const s of steps) {
    if (ELEMENT.has(s.name)) shape = 'element';
    else if (VALUE.has(s.name) && !(isLocal(s) && shape === 'element')) shape = 'value';
    else if (['map', 'flatMap', 'local', 'coalesce', 'union', 'choose', 'unfold', 'select'].includes(s.name)) {
      const kids = childrenOf(s);
      shape = kids.length ? (shapeAfter(kids[0]!.steps) === 'unknown' ? shape : shapeAfter(kids[0]!.steps)) : 'unknown';
    }
  }
  return shape;
}

function sItemOf(prefix: readonly QStep[][], hosts: readonly string[], body: QChain): SItem {
  const input = shapeAfter(prefix.flat());
  if (input === 'value') return 'S1';
  const names = body.steps.map((s) => s.name);
  if (names.some((n) => STRUCT.has(n)) || body.steps.some((s) => isLocal(s) && ['count', 'range', 'limit', 'tail', 'skip', 'order', 'dedup', 'sum', 'min', 'max', 'mean'].includes(s.name))) return 'S5';
  const barriers = names.filter((n) => BARRIER.has(n));
  if (barriers.length) return hosts.length >= 2 ? 'S2' : barriers.some((b) => SEEDED.has(b)) ? 'S3' : 'S2';
  return 'S4';
}

// ─────────────────────────── cluster + report ───────────────────────────

export interface Cluster {
  readonly signature: string;
  readonly klass: Klass;
  readonly mixed: boolean;
  readonly sitem: SItem;
  readonly host: string;
  readonly reach: number;
  readonly bySource: Record<Source, number>;
  readonly depths: readonly number[];
  readonly example: string;
  readonly exampleFrom: string;
  readonly why: string;
}

export interface Attributed { readonly decline: Decline; readonly core: Core }

const mode = <T>(xs: readonly T[]): T => {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]![0];
};

export function cluster(rows: readonly Attributed[]): Cluster[] {
  const groups = new Map<string, Attributed[]>();
  for (const r of rows) (groups.get(r.core.signature) ?? groups.set(r.core.signature, []).get(r.core.signature)!).push(r);
  const out: Cluster[] = [];
  for (const [sig, rs] of groups) {
    const bySource = { workload: 0, realistic: 0, host: 0, lattice: 0 } as Record<Source, number>;
    for (const r of rs) bySource[r.decline.source]++;
    const klass = mode(rs.map((r) => r.core.klass));
    // The example: the shortest core of the majority class, from the highest-reach source.
    const ex = rs.filter((r) => r.core.klass === klass)
      .sort((a, b) => WEIGHT[b.decline.source] - WEIGHT[a.decline.source] || a.core.core.length - b.core.core.length)[0]!;
    out.push({
      signature: sig, klass, mixed: rs.some((r) => r.core.klass !== klass),
      sitem: mode(rs.map((r) => r.core.sitem)), host: mode(rs.map((r) => r.core.host)),
      reach: rs.reduce((a, r) => a + WEIGHT[r.decline.source], 0), bySource,
      depths: [...new Set(rs.map((r) => r.decline.depth))].sort(), example: ex.core.core, exampleFrom: ex.decline.query, why: ex.core.why,
    });
  }
  return out.sort((a, b) => b.reach - a.reach || a.signature.localeCompare(b.signature));
}

export interface Totals { readonly weighted: Record<Klass, number>; readonly count: Record<Klass, number> }

export function totals(rows: readonly Attributed[], where: (r: Attributed) => boolean = () => true): Totals {
  const weighted = { a: 0, b: 0, c: 0, d: 0 }, count = { a: 0, b: 0, c: 0, d: 0 };
  for (const r of rows) if (where(r)) { weighted[r.core.klass] += WEIGHT[r.decline.source]; count[r.core.klass]++; }
  return { weighted, count };
}

export const share = (t: Totals, k: Klass): number => {
  const all = Object.values(t.weighted).reduce((a, b) => a + b, 0);
  return all === 0 ? 0 : t.weighted[k] / all;
};

