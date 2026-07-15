import { empty, list, q, value, type Expression, type Relation } from '../q.ts';
import { stepChain } from '../frontend.ts';
import { edges, labels, nodes, vertexProperties } from '../schema.ts';
import { advance, carriedWith, carryFrag, carriedCols, withCarried, type ElementStream } from './context.ts';
import { carryOf, toListStream, toScalarStream, type ListStream, type ScalarStream, type Stream } from './stream.ts';
import { foldBody } from './index.ts';
import { lowerScalarRows, SCALAR_TRANSFORMS } from './scalar.ts';
import { normalize } from '../strategies.ts';
import { lowerScopedElementFold, lowerScopedScalarFold, lowerScopedScalarReducer, type ScalarReducer } from './barrier.ts';
import { rangeToOffsetLimit } from '../plan.ts';

/** Root/child compilation context. A child frame retains the complete parent domain,
 * not merely an ordinal on productive child rows: reducers need that domain to
 * distinguish an empty child from a child which produced SQL NULL. */
export interface RootScope { readonly kind: 'root' }
export interface ChildFrame {
  readonly ordinal: string;
  readonly domain: Relation;
  readonly parent: Stream;
}
export interface ChildScope {
  readonly kind: 'child';
  readonly frames: readonly ChildFrame[];
}
export type CompileScope = RootScope | ChildScope;

export const ROOT_SCOPE: RootScope = { kind: 'root' };

export type ChildUse = 'all' | 'first';

/** Child chains cross the same normalization seam as the root. In particular,
 * order().by() must arrive as one PStep before shape-aware scalar lowering. */
const childSteps = (nested: any, params: Record<string, any>) => {
  const rawSteps = stepChain(nested, params);
  const normalized = normalize(rawSteps);
  return normalized.discard ? [...normalized.steps, rawSteps.at(-1)!] : normalized.steps;
};

/** Give every parent traverser a multiset-safe identity and seed a correlated child.
 * Equal element ids deliberately get different ordinals. The domain is preserved in
 * the returned frame even when later child lowering produces no rows. */
export function pushChildScope(
  parent: ElementStream,
  scope: CompileScope = ROOT_SCOPE,
): { scope: ChildScope; frame: ChildFrame; seed: ElementStream } {
  const p = parent.rel.as('p');
  const cols = carriedCols(parent.carried);
  const ordinal = `o${parent.carried.origins.length}`;
  const domain = parent.q.cte(
    q`SELECT ${p.c.id} AS id${carryFrag(parent.carried, p)}, ROW_NUMBER() OVER () AS ${ordinal} FROM ${p}`,
    ['id', ...cols, ordinal],
  );
  const seed = withCarried(
    { ...parent, rel: domain },
    { origins: [...parent.carried.origins, ordinal] },
  );
  const frame: ChildFrame = { ordinal, domain, parent };
  const frames = scope.kind === 'child' ? [...scope.frames, frame] : [frame];
  return { scope: { kind: 'child', frames }, frame, seed };
}

/** Remove exactly the innermost child identity after a child consumer has restored
 * parent cardinality. Outer origins remain live for nested children. */
export function popChildScope(child: ElementStream, frame: ChildFrame): ElementStream {
  const origins = child.carried.origins;
  if (origins[origins.length - 1] !== frame.ordinal)
    throw new Error(`child scope mismatch: expected innermost ${frame.ordinal}, got ${origins.at(-1) ?? 'none'}`);
  const nextOrigins = origins.slice(0, -1);
  const carried = carriedWith(child.carried, { origins: nextOrigins });
  const p = child.rel.as('p');
  return advance(child, q`SELECT ${p.c.id} AS id${carryFrag(carried, p)} FROM ${p}`, { origins: nextOrigins });
}

/** Prefix steps whose implementations physically preserve child origins. This first
 * generic-child slice is deliberately smaller than PREFIX: global barriers/windows,
 * forks, as(), repeat, sack and path-sensitive steps need their explicit child policy. */
const ELEMENT_CHILD_STEPS = new Set([
  'out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'bothV',
  'has', 'hasLabel', 'hasId', 'where', 'filter', 'not', 'and', 'or', 'identity',
]);
const CHILD_SCALAR_ROW_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'order', 'limit', 'skip', 'range', 'dedup',
  'count', 'sum', 'min', 'max', 'mean',
]);
const CHILD_SCALAR_REDUCERS = new Set(['count', 'sum', 'min', 'max', 'mean']);
const CHILD_ELEMENT_ROW_STEPS = new Set(['limit', 'skip', 'range', 'dedup']);

function elementRowParts(body: ReturnType<typeof stepChain>): { prefix: ReturnType<typeof stepChain>; suffix: ReturnType<typeof stepChain> } | null {
  const at = body.findIndex((s) => CHILD_ELEMENT_ROW_STEPS.has(s.name));
  const prefix = at < 0 ? body : body.slice(0, at);
  const suffix = at < 0 ? [] : body.slice(at);
  if (!prefix.length || prefix.some((s) => !ELEMENT_CHILD_STEPS.has(s.name))) return null;
  if (suffix.some((s) => !CHILD_ELEMENT_ROW_STEPS.has(s.name))) return null;
  return { prefix, suffix };
}

export function isElementChild(nested: any, params: Record<string, any>): boolean {
  return !!nested && elementRowParts(childSteps(nested, params)) !== null;
}

/** Syntax-only preflight for shape-aware dispatch. Unlike the tryCompile functions,
 * this never appends CTEs, so the prefix fold can stop before a homogeneous scalar
 * union without speculatively mutating the Query. */
function scalarRowParts(body: ReturnType<typeof stepChain>): { prefix: ReturnType<typeof stepChain>; projection: any; suffix: ReturnType<typeof stepChain> } | null {
  const at = body.findIndex((s) => ['values', 'id', 'label', 'constant'].includes(s.name));
  if (at < 0) return null;
  const prefix = body.slice(0, at);
  const projection = body[at];
  const suffix = body.slice(at + 1);
  if (prefix.some((s) => !ELEMENT_CHILD_STEPS.has(s.name))) return null;
  if (suffix.some((s) => !CHILD_SCALAR_ROW_STEPS.has(s.name))) return null;
  if (projection.name === 'values' && (projection.args.length !== 1 || typeof projection.args[0] !== 'string')) return null;
  if ((projection.name === 'id' || projection.name === 'label') && projection.args.length) return null;
  if (projection.name === 'constant' && projection.args.length !== 1) return null;
  return { prefix, projection, suffix };
}

export function isScalarChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  const body = childSteps(nested, params);
  const terminal = body.at(-1);
  if (!terminal) return false;
  if (terminal.name === 'count')
    return terminal.args.length === 0 && body.slice(0, -1).every((s) => ELEMENT_CHILD_STEPS.has(s.name));
  return scalarRowParts(body) !== null;
}

export function isListChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  const body = childSteps(nested, params);
  if (body.at(-1)?.name !== 'fold') return false;
  const before = body.slice(0, -1);
  return scalarRowParts(before) !== null || before.every((step) => ELEMENT_CHILD_STEPS.has(step.name));
}

/** Compile a terminal child count as a true scope-aware barrier. The preserved
 * parent domain is the left side of the aggregate, so an unproductive child still
 * emits one Long zero for that parent. Grouping by the child ordinal (rather than
 * element id) keeps equal/duplicate parent traversers multiset-distinct. */
export function tryCompileCountChild(
  parent: ElementStream,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
): ScalarStream | null {
  if (!nested) return null;
  const body = childSteps(nested, parent.params);
  const terminal = body.at(-1);
  if (!terminal || terminal.name !== 'count' || terminal.args.length) return null;
  const prefix = body.slice(0, -1);
  if (prefix.some((s) => !ELEMENT_CHILD_STEPS.has(s.name))) return null;

  const pushed = pushChildScope(parent, scope);
  const { st: end, stop } = foldBody(prefix, pushed.seed, 0);
  if (stop !== prefix.length) return null;

  const d = pushed.frame.domain.as('d');
  const c = end.rel.as('c');
  const rel = parent.q.cte(
    q`SELECT COUNT(${c.c.id}) AS v${carryFrag(parent.carried, d)} FROM ${d} LEFT JOIN ${c} ON ${c.c[pushed.frame.ordinal]}=${d.c[pushed.frame.ordinal]} GROUP BY ${d.c[pushed.frame.ordinal]}`,
    ['v', ...carriedCols(parent.carried)],
  );
  return toScalarStream(carryOf(parent), rel, 'long');
}

/** Compile a scalar-producing child as rows, so productivity is represented by row
 * existence rather than SQL NULL. Movement/filter uses the ordinary element fold;
 * projection adds an explicit provider encounter key; the shared scalar pipeline
 * applies transforms and origin-partitioned row operators; only then does the
 * consumer apply its `first` or `all` cardinality policy. */
function compileScalarChildRows(
  parent: ElementStream,
  nested: any,
  use: ChildUse = 'first',
  scope: CompileScope = ROOT_SCOPE,
  retainChildScope = false,
  beforeFold = false,
): { stream: ScalarStream; frame: ChildFrame } | null {
  if (!nested) return null;
  const fullBody = childSteps(nested, parent.params);
  if (beforeFold && fullBody.at(-1)?.name !== 'fold') return null;
  const body = beforeFold ? fullBody.slice(0, -1) : fullBody;
  const parts = scalarRowParts(body);
  if (!parts) return null;
  const { prefix, projection: terminal, suffix } = parts;

  const pushed = pushChildScope(parent, scope);
  const { st: end, stop } = foldBody(prefix, pushed.seed, 0);
  if (stop !== prefix.length) return null;

  const c = end.rel.as('c');
  let scalar: Expression;
  let from: Expression;
  let order: Expression;
  if (terminal.name === 'constant') {
    scalar = value(terminal.args[0]);
    from = q`${c}`;
    order = c.c.id;
  } else {
    const elem = (end.elem === 'edge' ? edges : nodes).as('e');
    if (terminal.name === 'values') {
      const key = terminal.args[0];
      if (end.elem === 'node') {
        const vp = vertexProperties.as('vp');
        scalar = vp.c.value;
        from = q`${c} JOIN ${vp} ON ${vp.c.node}=${c.c.id} AND ${vp.c.key}=${value(key)}`;
        order = q`${c.c.id}, ${vp.c.id}`;
      } else {
        scalar = q`j.value`;
        from = q`${c} JOIN ${elem} ON ${elem.c.id}=${c.c.id} JOIN json_each(json(${elem.c.props})) j ON j.key=${value(key)}`;
        order = c.c.id;
      }
    } else if (terminal.name === 'id') {
      scalar = q`COALESCE(${elem.c.uid}, ${elem.c.id})`;
      from = q`${c} JOIN ${elem} ON ${elem.c.id}=${c.c.id}`;
      order = c.c.id;
    } else {
      const l = labels.as('l');
      scalar = l.c.name;
      from = q`${c} JOIN ${elem} ON ${elem.c.id}=${c.c.id} JOIN ${l} ON ${l.c.id}=${elem.c.label}`;
      order = c.c.id;
    }
  }

  const childCols = carriedCols(end.carried);
  const encounter = 'encounter';
  const continueScalar = (base: ScalarStream): ScalarStream => {
    let stream = base;
    let at = 0;
    while (at < suffix.length) {
      const lowered = lowerScalarRows(stream, suffix, at);
      stream = lowered.stream;
      at = lowered.stop;
      if (at === suffix.length) break;
      const reducer = suffix[at].name;
      if (!CHILD_SCALAR_REDUCERS.has(reducer))
        throw new Error(`scalar child continuation ${reducer}() not yet supported`);

      stream = lowerScopedScalarReducer(stream, reducer as ScalarReducer, pushed.frame.domain, pushed.frame.ordinal);
      at++;
    }
    return stream;
  };
  const rows = parent.q.cte(
    q`SELECT ${scalar} AS v, ROW_NUMBER() OVER (PARTITION BY ${c.c[pushed.frame.ordinal]} ORDER BY ${order}) AS ${encounter}${carryFrag(end.carried, c)} FROM ${from}`,
    ['v', encounter, ...childCols],
  );
  const lowered = continueScalar(toScalarStream(carryOf(end), rows, undefined, 'value', encounter));
  if (retainChildScope) return { stream: lowered, frame: pushed.frame };
  const r = lowered.rel.as('r');
  const parentCols = carriedCols(parent.carried);
  const typeCol = lowered.result === 'number' ? q`, ${r.c.vt} AS vt` : empty;
  const resultCols = lowered.result === 'number' ? ['v', 'vt'] : ['v'];
  if (use === 'all') {
    const rel = parent.q.cte(q`SELECT ${r.c.v} AS v${typeCol}${carryFrag(parent.carried, r)} FROM ${r}`, [...resultCols, ...parentCols]);
    return { stream: toScalarStream(carryOf(parent), rel, lowered.as, lowered.result), frame: pushed.frame };
  }
  const ranked = parent.q.cte(
    q`SELECT ${r.c.v} AS v${typeCol}${carryFrag(parent.carried, r)}, ROW_NUMBER() OVER (PARTITION BY ${r.c[pushed.frame.ordinal]} ORDER BY ${r.c[encounter]}) AS rn FROM ${r}`,
    [...resultCols, ...parentCols, 'rn'],
  );
  const first = ranked.as('f');
  const firstTypeCol = lowered.result === 'number' ? q`, ${first.c.vt} AS vt` : empty;
  const rel = parent.q.cte(
    q`SELECT ${first.c.v} AS v${firstTypeCol}${carryFrag(parent.carried, first)} FROM ${first} WHERE ${first.c.rn}=1`,
    [...resultCols, ...parentCols],
  );
  return { stream: toScalarStream(carryOf(parent), rel, lowered.as, lowered.result), frame: pushed.frame };
}

export function tryCompileScalarChild(
  parent: ElementStream,
  nested: any,
  use: ChildUse = 'first',
  scope: CompileScope = ROOT_SCOPE,
): ScalarStream | null {
  return compileScalarChildRows(parent, nested, use, scope)?.stream ?? null;
}

/** Scalar rows followed by fold() become one ListStream per parent. This is a true
 * child barrier: empty children emit [], productive NULL remains [null], and only
 * the innermost origin is removed at the consumer boundary. */
export function tryCompileListChild(
  parent: ElementStream,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
): ListStream | null {
  const scoped = compileScalarChildRows(parent, nested, 'all', scope, true, true);
  if (scoped) {
    const folded = lowerScopedScalarFold(scoped.stream, scoped.frame.domain, scoped.frame.ordinal);
    const l = folded.rel.as('l');
    const rel = parent.q.cte(
      q`SELECT ${l.c.list} AS list${carryFrag(parent.carried, l)} FROM ${l}`,
      ['list', ...carriedCols(parent.carried)],
    );
    return toListStream(carryOf(parent), rel, folded.of);
  }

  const element = compileElementChildRows(parent, nested, scope, true);
  if (!element) return null;
  const folded = lowerScopedElementFold(element.stream, element.frame.domain, element.frame.ordinal);
  const l = folded.rel.as('l');
  const rel = parent.q.cte(
    q`SELECT ${l.c.list} AS list${carryFrag(parent.carried, l)} FROM ${l}`,
    ['list', ...carriedCols(parent.carried)],
  );
  return toListStream(carryOf(parent), rel, folded.of);
}

/** Compile an element-valued child through the SAME StepFns as the root prefix, then
 * apply the consumer's cardinality policy. `first` implements map(): zero child rows
 * are unproductive; otherwise exactly one row survives per multiset-distinct parent.
 * Returns null when the body needs a not-yet-generic tail/barrier so scalar fast paths
 * and clear existing deferrals remain authoritative. */
function compileElementChildRows(
  parent: ElementStream,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  beforeFold = false,
): { stream: ElementStream; frame: ChildFrame } | null {
  if (!nested || parent.carried.sack || parent.carried.fromV) return null;
  const fullBody = childSteps(nested, parent.params);
  if (beforeFold && fullBody.at(-1)?.name !== 'fold') return null;
  const body = beforeFold ? fullBody.slice(0, -1) : fullBody;
  const parts = body.length ? elementRowParts(body) : beforeFold ? { prefix: [], suffix: [] } : null;
  if (!parts) return null;
  const pushed = pushChildScope(parent, scope);
  const { st: prefixed, stop } = foldBody(parts.prefix, pushed.seed, 0);
  if (stop !== parts.prefix.length) return null;

  let end = prefixed;
  for (const step of parts.suffix) {
    const p = end.rel.as('p');
    if (step.name === 'dedup') {
      end = advance(end, q`SELECT DISTINCT ${p.c.id} AS id${carryFrag(end.carried, p)} FROM ${p}`);
      continue;
    }
    const slice = step.name === 'range' ? rangeToOffsetLimit(step.args)
      : step.name === 'skip' ? { offset: Number(step.args[0]), limit: -1 }
      : { offset: 0, limit: Number(step.args[0]) };
    const cols = carriedCols(end.carried);
    const ranked = parent.q.cte(
      q`SELECT ${p.c.id} AS id${carryFrag(end.carried, p)}, ROW_NUMBER() OVER (PARTITION BY ${p.c[pushed.frame.ordinal]} ORDER BY ${p.c.id}) AS rn FROM ${p}`,
      ['id', ...cols, 'rn'],
    );
    const r = ranked.as('r');
    const hi = slice.limit < 0 ? null : slice.offset + slice.limit;
    const upper = hi === null ? empty : q` AND ${r.c.rn} <= ${hi}`;
    end = advance(end, q`SELECT ${r.c.id} AS id${carryFrag(end.carried, r)} FROM ${r} WHERE ${r.c.rn} > ${slice.offset}${upper}`);
  }
  return { stream: end, frame: pushed.frame };
}

export function tryCompileElementChild(
  parent: ElementStream,
  nested: any,
  use: ChildUse,
  scope: CompileScope = ROOT_SCOPE,
): { stream: ElementStream; scope: CompileScope } | null {
  const lowered = compileElementChildRows(parent, nested, scope);
  if (!lowered) return null;
  const { stream: end, frame } = lowered;

  if (use === 'all') return { stream: popChildScope(end, frame), scope };

  const p = end.rel.as('p');
  const others = carriedCols(end.carried).filter((c) => c !== frame.ordinal);
  const extra = (rel: typeof p): Expression => others.length
    ? list(others.map((c) => q`, ${rel.c[c]}`), '')
    : empty;
  const ranked = parent.q.cte(
    q`SELECT ${p.c.id} AS id${extra(p)}, ROW_NUMBER() OVER (PARTITION BY ${p.c[frame.ordinal]} ORDER BY ${p.c.id}) AS rn FROM ${p}`,
    ['id', ...others, 'rn'],
  );
  const r = ranked.as('r');
  const stream = advance(
    end,
    q`SELECT ${r.c.id} AS id${extra(r)} FROM ${r} WHERE ${r.c.rn}=1`,
    { elem: end.elem, origins: parent.carried.origins, cols: ['id', ...others] },
  );
  return { stream, scope };
}
