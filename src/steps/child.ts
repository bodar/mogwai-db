import { empty, list, q, type Expression, type Relation } from '../q.ts';
import { stepChain } from '../frontend.ts';
import { advance, carriedWith, carryFrag, carriedCols, withCarried, type ElementStream } from './context.ts';
import { type Stream } from './stream.ts';
import { foldBody } from './index.ts';

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

/** Compile an element-valued child through the SAME StepFns as the root prefix, then
 * apply the consumer's cardinality policy. `first` implements map(): zero child rows
 * are unproductive; otherwise exactly one row survives per multiset-distinct parent.
 * Returns null when the body needs a not-yet-generic tail/barrier so scalar fast paths
 * and clear existing deferrals remain authoritative. */
export function tryCompileElementChild(
  parent: ElementStream,
  nested: any,
  use: ChildUse,
  scope: CompileScope = ROOT_SCOPE,
): { stream: ElementStream; scope: CompileScope } | null {
  if (!nested || parent.carried.path || parent.carried.sack || parent.carried.fromV) return null;
  const body = stepChain(nested, parent.params);
  if (!body.length || body.some((s) => !ELEMENT_CHILD_STEPS.has(s.name))) return null;
  const pushed = pushChildScope(parent, scope);
  const { st: end, stop } = foldBody(body, pushed.seed, 0);
  if (stop !== body.length) return null;
  if (use === 'all') return { stream: popChildScope(end, pushed.frame), scope };

  const p = end.rel.as('p');
  const others = carriedCols(end.carried).filter((c) => c !== pushed.frame.ordinal);
  const extra = (rel: typeof p): Expression => others.length
    ? list(others.map((c) => q`, ${rel.c[c]}`), '')
    : empty;
  const ranked = parent.q.cte(
    q`SELECT ${p.c.id} AS id${extra(p)}, ROW_NUMBER() OVER (PARTITION BY ${p.c[pushed.frame.ordinal]} ORDER BY ${p.c.id}) AS rn FROM ${p}`,
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
