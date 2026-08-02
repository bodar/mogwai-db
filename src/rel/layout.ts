import { barrierLayout, layoutCols, mergeLayouts, rigidCols, type TraverserLayout } from '../compiler/steps/context/context.ts';
import type { Rel, RelKind } from './rel.ts';
import { recursiveStep } from './walk.ts';

/**
 * What every node kind does to the carried traverser channels — §3.5 of the build plan, as the
 * table it asked for rather than the prose it became.
 *
 * `Record<RelKind, …>` is the enforcement, exactly as `LAYOUT_ROLE_POLICY` and `BARRIER_ROLE_POLICY`
 * are for roles: **a new node kind fails the build until its obligation is declared here.** Without
 * it a new kind inherits no rule at all, and the defect category this guards is the largest in the
 * repo's history — 33% of diagnosed defects are a carried field dropped at a barrier, merge or
 * rejoin, which is silent at every layer above.
 *
 * Declaring is not implementing, so each obligation below is executable and `check` runs it.
 */
export type LayoutObligation<K extends RelKind> = (node: Extract<Rel, { readonly kind: K }>) => void;

/** Order-insensitive: two layouts built by different routes can be equal, and the alias Map's
 * insertion order is not part of that equality. */
const snapshot = (layout: TraverserLayout): string => JSON.stringify({
  ...layout,
  aliases: [...layout.aliases]
    .map(([label, entry]) => [label, { ...entry, shapes: [...entry.shapes].sort() }] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
});
export const sameLayout = (left: TraverserLayout, right: TraverserLayout): boolean => snapshot(left) === snapshot(right);

const names = (node: Rel): readonly string[] => node.type.cols.map((column) => column.name);
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, i) => name === right[i]);

/** Every node: a carried channel it CLAIMS must be a column it actually emits. */
const declares = (node: Rel): void => {
  const emitted = new Set(names(node));
  for (const column of layoutCols(node.layout)) {
    if (!emitted.has(column)) throw new Error(`RelIR: ${node.kind} declares layout column '${column}' but does not emit it`);
  }
};

/** The unary chain: same layout in, same layout out. */
const preserving = (node: Rel & { readonly input: Rel }): void => {
  if (!sameLayout(node.input.layout, node.layout)) throw new Error(`RelIR: ${node.kind} changed its traverser layout`);
  declares(node);
};

/** The columns a node adds on top of its input's, in emission order. */
const extending = (node: Rel & { readonly input: Rel }, added: readonly string[]): void => {
  preserving(node);
  const expected = [...names(node.input), ...added];
  if (!sameNames(expected, names(node))) throw new Error(`RelIR: ${node.kind} output must be its input columns followed by ${added.join(', ') || 'nothing'}`);
};

export const explodeColumns = (as: { readonly key?: string; readonly value: string; readonly ord?: string }): readonly string[] =>
  [...(as.key ? [as.key] : []), as.value, ...(as.ord ? [as.ord] : [])];

export const LAYOUT_OBLIGATION: { readonly [K in RelKind]: LayoutObligation<K> } = {
  // Sources answer for themselves: nothing flows in, so the only rule is that they emit what they claim.
  scan: declares,
  values: declares,
  'self-ref': declares,
  'prior-result': (node) => {
    if (layoutCols(node.layout).length) throw new Error('RelIR: PriorResult carries no traverser layout — a statement result is rows, not traversers');
    declares(node);
  },

  // The only node that may DECLARE layout columns, so the rule is subset-of-output, not preservation.
  project: declares,

  filter: preserving,
  sort: preserving,
  limit: preserving,
  distinct: preserving,
  materialize: preserving,
  window: (node) => extending(node, node.specs.map(([name]) => name)),
  explode: (node) => extending(node, explodeColumns(node.as)),

  // Reducing: a barrier result is a NEW traverser and cannot claim per-row state from any one input
  // row. §3.5 says "groupBy: [], AND any reducing form" — a grouped aggregate reduces too.
  aggregate: (node) => {
    if (!sameLayout(barrierLayout(node.input.layout), node.layout))
      throw new Error('RelIR: Aggregate must apply the barrier layout contract to its input layout');
    declares(node);
  },

  union: (node) => {
    const [first, ...rest] = node.inputs;
    if (!first) throw new Error('RelIR: Union requires at least two inputs');
    if (!sameLayout(mergeLayouts(first.layout, rest.map((input) => input.layout), { rigid: 'peer' }), node.layout))
      throw new Error('RelIR: Union output layout must merge its inputs');
    declares(node);
  },

  join: (node) => {
    // The merge is computed only as a fallback: a peer merge of sides that disagree on a rigid
    // role fails closed itself, and that must not pre-empt the more specific rule below.
    if (!sameLayout(node.layout, node.left.layout) && !sameLayout(node.layout, node.right.layout)
      && !sameLayout(node.layout, mergeLayouts(node.left.layout, [node.right.layout], { rigid: 'peer' })))
      throw new Error("RelIR: a Join's layout must be one side's or the peer merge of both");
    // An unmatched left-join row has the right side entirely NULL. A rigid role is per-traverser
    // physical state (sack/bulk/origins/fromV/encounter) — arriving nullable it is not that state.
    if (node.join === 'left') {
      const fromLeft = new Set(rigidCols(node.left.layout));
      for (const column of rigidCols(node.right.layout)) {
        if (!fromLeft.has(column) && rigidCols(node.layout).includes(column))
          throw new Error(`RelIR: a left Join cannot carry rigid channel '${column}' from its nullable right side`);
      }
    }
    declares(node);
  },

  // The CTE header requirement, and the check that catches a body which forgot a carried column.
  recursive: (node) => {
    const step = recursiveStep(node);
    if (!sameLayout(node.seed.layout, step.layout)) throw new Error('RelIR: Recursive seed and step must carry the identical layout');
    if (!sameLayout(node.layout, node.seed.layout)) throw new Error("RelIR: a Recursive node's layout is its seed's");
    declares(node);
  },
};

/** The one cast: TypeScript cannot correlate `node.kind` with the table's per-kind parameter, and
 * the table's totality is what the correlation would have bought. */
export const checkLayout = (node: Rel): void => (LAYOUT_OBLIGATION[node.kind] as (n: Rel) => void)(node);
