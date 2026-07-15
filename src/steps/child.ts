import { q, type Relation } from '../q.ts';
import { advance, carriedWith, carryFrag, carriedCols, withCarried, type ElementStream } from './context.ts';
import { type Stream } from './stream.ts';

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
