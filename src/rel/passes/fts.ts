import { compilerText, col, type Expr } from '../expr.ts';
import * as make from '../factory.ts';
import { minter, type Minter } from '../mint.ts';
import type { Rel, Table } from '../rel.ts';
import type { RelId } from '../types.ts';
import { forEachExpr, mapRelExprs, rewrite, rewriteExpr } from '../walk.ts';

/** A physical TextP access path. The generic correlated EXISTS remains above the join and is the
 * semantic authority; this only drives a bare element scan from matching FTS owner ids. */
const PROPERTIES: Partial<Record<Table, { readonly owner: string; readonly ownerElem: 'node' | 'edge' }>> = {
  nodes: { owner: 'node', ownerElem: 'node' }, edges: { owner: 'edge', ownerElem: 'edge' },
};
const FTS_TYPE = { cols: [
  { name: 'owner_elem', type: 'text', nullable: false }, { name: 'pid', type: 'int', nullable: false },
  { name: 'owner', type: 'int', nullable: false }, { name: 'pk', type: 'text', nullable: false },
  { name: 'kind', type: 'text', nullable: false }, { name: 'text', type: 'text', nullable: false },
] } as const;

export function fts(plan: Rel): Rel {
  const mint = minter(plan);
  return rewrite(plan, (mapped) => mapped.kind === 'filter' ? ftsFilter(mapped, mint) : mapped);
}

function ftsFilter(node: Extract<Rel, { readonly kind: 'filter' }>, mint: Minter): Rel {
  if (node.input.kind !== 'scan') return node;
  const properties = PROPERTIES[node.input.table];
  if (!properties) return node;
  for (const term of conjuncts(node.pred)) {
    const ids = ftsOwners(term, node.input.id, properties, mint);
    if (!ids) continue;
    const joined = make.join({ id: mint.id('fj'), left: ids, right: node.input, join: 'inner', ordered: true, channels: [],
      type: { cols: [{ name: 'sid', type: 'int', nullable: false }, ...node.input.type.cols] },
      on: eq(col(node.input.id, 'id'), col(ids.id, 'sid')) });
    return make.filter({ id: node.id, input: joined, channels: node.channels, type: joined.type, pred: retarget(node.pred, node.input.id, joined.id) });
  }
  return node;
}

function ftsOwners(term: Expr, element: RelId, properties: { readonly owner: string; readonly ownerElem: 'node' | 'edge' }, mint: Minter): Rel | null {
  if (term.kind !== 'exists' || term.negated || term.plan.kind !== 'project' || term.plan.input.kind !== 'filter') return null;
  const matching = term.plan.input;
  if (matching.input.kind !== 'scan') return null;
  const props = matching.input;
  const all = conjuncts(matching.pred);
  const corr = all.filter((e) => correlation(e, props.id, properties.owner, element));
  if (corr.length !== 1) return null;
  const free = all.filter((e) => !corr.includes(e));
  const key = literalEq(free, props.id, 'key');
  const pattern = likePattern(free, props.id);
  // A negative TextP is `… LIKE … IS NOT 1`. The index can find matching rows, not the owners
  // that have *some non-matching value*, so it must stay on the generic EXISTS path.
  if (key == null || pattern == null || hasNegativeText(free) || literalTerm(pattern).length < 3) return null;
  const scan = make.scan({ id: mint.id('fs'), table: 'property_fts', alias: mint.alias('rfs'), channels: [], type: FTS_TYPE });
  const pred = andAll([
    eq(col(scan.id, 'owner_elem'), compilerText(properties.ownerElem)), eq(col(scan.id, 'pk'), compilerText(key)),
    eq(col(scan.id, 'kind'), compilerText('value')),
    { kind: 'call', fn: 'like', args: [pattern, col(scan.id, 'text'), compilerText('\\')] },
  ]);
  const filtered = make.filter({ id: mint.id('ff'), input: scan, channels: [], type: scan.type, pred });
  const owners = make.project({ id: mint.id('fp'), input: filtered, channels: [], type: { cols: [{ name: 'sid', type: 'int', nullable: false }] }, exprs: [['sid', col(filtered.id, 'owner')]] });
  return make.distinct({ id: mint.id('fd'), input: owners, channels: [], type: owners.type });
}

const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });
const andAll = (parts: readonly Expr[]): Expr => parts.reduce((left, right) => ({ kind: 'binary', op: 'and', left, right }));
const conjuncts = (e: Expr): readonly Expr[] => e.kind === 'binary' && e.op === 'and' ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e];
function correlation(e: Expr, props: RelId, owner: string, element: RelId): boolean {
  if (e.kind !== 'binary' || e.op !== '=') return false;
  const p = (x: Expr): boolean => x.kind === 'col' && x.rel === props && x.name === owner;
  const el = (x: Expr): boolean => x.kind === 'col' && x.rel === element && x.name === 'id';
  return (p(e.left) && el(e.right)) || (p(e.right) && el(e.left));
}
function literalEq(parts: readonly Expr[], rel: RelId, name: string): string | null {
  for (const e of parts) if (e.kind === 'binary' && e.op === '=') {
    const pair = [e.left, e.right];
    if (pair.some((x) => x.kind === 'col' && x.rel === rel && x.name === name)) {
      const lit = pair.find((x): x is Extract<Expr, { kind: 'lit' }> => x.kind === 'lit' && x.source === 'compiler-text');
      if (lit) return lit.value as string;
    }
  }
  return null;
}
function likePattern(parts: readonly Expr[], rel: RelId): Expr | null {
  let found: Expr | null = null;
  for (const part of parts) forEachExpr(part, (e) => {
    if (e.kind === 'call' && e.fn.toLowerCase() === 'like' && e.args[1]?.kind === 'col' && e.args[1].rel === rel && e.args[1].name === 'value') found = e.args[0];
  });
  return found;
}
function hasNegativeText(parts: readonly Expr[]): boolean {
  let found = false;
  for (const part of parts) forEachExpr(part, (e) => { found ||= e.kind === 'binary' && e.op === 'is not'; });
  return found;
}
/** Literal-only: parameters deliberately use the generic plan, preserving the old fast-path scope. */
function literalTerm(pattern: Expr): string {
  let raw: string | null = null;
  forEachExpr(pattern, (e) => {
    if (e.kind === 'call' && e.fn.toLowerCase() === 'replace' && e.args[0]?.kind === 'lit' && e.args[0].source === 'compiler-text' && raw == null) raw = e.args[0].value;
  });
  return raw ?? '';
}

/** The original generic predicate now sits over the join, so all of its correlations must name
 * the join's element columns. Keep this identical to the property-seek retargeting rule. */
function retarget(e: Expr, from: RelId, to: RelId): Expr {
  const swap = (node: Expr): Expr => node.kind === 'col' && node.rel === from ? col(to, node.name) : node;
  const go = (expression: Expr): Expr => rewriteExpr(expression, swap,
    (nested) => rewrite(nested, (mapped) => mapRelExprs(mapped, go)));
  return go(e);
}
