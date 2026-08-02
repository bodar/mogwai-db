import type { Channels } from '../../channels.ts';
import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import type { Plan } from '../../rel/plan.ts';
import type { Rel } from '../../rel/rel.ts';
import { relId, type ColMeta, type RelType, type SqlType } from '../../rel/types.ts';
import type { Elem } from '../plan/plan.ts';
import { flattenListArgs } from '../../gremlin/frontend.ts';
import type { IRStep } from '../ir/strategies.ts';

/**
 * THE SECOND LOWERING — `Step[] -> RelIR` (§10·4 of `docs/2026-08-01-relir-build-plan.md`).
 *
 * The legacy spine (`LoweringEngine`) builds SQL into an append-only `Query`, so the query never
 * exists as data and every optimization has to happen before or during lowering. This module is the
 * replacement route, and it grows STEP BY STEP: a traversal whose every step is covered here lowers
 * to a `Plan` and takes the RelIR route end-to-end; anything else returns `null` and the legacy
 * spine handles it whole. **Never mixed inside one traversal** — that is what keeps RelIR a real
 * algebra rather than a wrapper, and it is why there is no opaque escape node and never will be
 * (§10·4: "not as a bridge, not temporarily, not behind a flag").
 *
 * `null` is therefore the ONLY decline, and it must stay cheap and total: a step this module has
 * not learned yet is not an error, it is coverage that has not been written. What it must never do
 * is answer a DIFFERENT question — a partial lowering that silently drops a filter would be
 * invisible to the differential, since both spines would be asked and only one asked correctly.
 *
 * ## What this module does NOT do
 *
 * **Framing.** Gremlin shape is resolved above RelIR and rides to the wire as `Compiled.shape`
 * (§2), so this returns a RELATION plus the channel/layout facts the framing layer needs, and
 * `spine.ts` hands that to the existing per-shape framing. Re-encoding the element payload
 * projection in RelIR would be §7's named risk ("re-encoding, not simplification") for no gain: the
 * shape-interpreting class stays per-shape forever and correctly so.
 */

/** A covered chain, lowered. `elem` and `layout*` are what the framing layer needs to build its
 *  projection over the result relation; everything else about shape stays above RelIR. */
export interface RelLowering {
  readonly plan: Plan;
  readonly elem: Elem;
  /** The result relation's output columns, in order — the framing layer's `Relation` header. */
  readonly cols: readonly string[];
  readonly channels: Channels;
}

const meta = (colName: string, type: SqlType, nullable = false): ColMeta => ({ name: colName, type, nullable });
const typeOf = (...cols: readonly ColMeta[]): RelType => ({ cols });

/** Physical columns of the two element tables, as `Scan` must declare them. `Scan` is the one node
 *  that names the physical schema (§3.3), so this list IS the algebra's view of storage. */
const NODE_COLS = [meta('id', 'int'), meta('uid', 'text', true)];
const EDGE_COLS = [meta('id', 'int'), meta('uid', 'text', true), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')];

/** The bulk channel every element source seeds: the RLE traverser count a reducer reads as
 *  `SUM(bulk)` and a movement collapse merges convergent walks on. One channel, one column, and the
 *  role vocabulary is the neutral core's — a RelIR node cannot know what a sack is. */
const BULK: Channels = [{ col: 'bulk', role: 'bulk' }];
const SOURCE_COLS = ['id', 'bulk'] as const;

/** Relation ids, minted PER LOWERING. A module-global counter would make the emitted SQL depend on
 *  how many traversals this process had already compiled — two compiles of one query producing two
 *  different strings, which breaks every snapshot and every cache keyed on the text. */
const minter = () => { let n = 0; return (hint: string) => relId(`${hint}${n++}`); };

/**
 * `V(...)` / `E(...)` — the element source, and the exact relation the legacy `seedSource` builds
 * for the same arguments: one row per element at bulk 1, narrowed by an id list bounded by the
 * QUERY TEXT (never by row count, so `InList` is right here and a JSON bind is not).
 *
 * Numeric args match the rowid and string args the user id, because the id-relation carries rowids
 * throughout and a `uid` match still projects the rowid. That asymmetry is the storage schema's,
 * which is why it lives at the one node that names a table.
 */
function elementSource(step: IRStep, fresh: ReturnType<typeof minter>): { rel: Rel; elem: Elem } | null {
  const elem: Elem = step.name === 'E' ? 'edge' : 'vertex';
  const table = elem === 'edge' ? 'edges' : 'nodes';
  // A `r`-prefixed alias, so a RelIR scan can never SHADOW one of the framing layer's (`n`/`e`/`p`/
  // `s`/`v`/`g`/`j`/`l`). The plan is spliced in as a derived table, so shadowing would be legal
  // SQL and silently resolve an outer correlation to the inner table.
  const scan = make.scan({
    id: fresh('src'), table, alias: elem === 'edge' ? 're' : 'rn', channels: [],
    type: typeOf(...(elem === 'edge' ? EDGE_COLS : NODE_COLS)),
  });

  const ids = flattenListArgs(step.args);
  const nums = ids.filter((a): a is number => typeof a === 'number');
  const strs = ids.filter((a): a is string => typeof a === 'string');
  // An id argument that is neither is a hard error in the legacy spine too, but this route must
  // not THROW on a shape it merely has not learned — declining routes it to the spine that owns
  // the message.
  if (ids.length !== nums.length + strs.length) return null;

  const clauses: Expr[] = [];
  if (nums.length) clauses.push({ kind: 'in-list', expr: col(scan.id, 'id'), values: nums.map((n) => lit(n, 'int')) });
  if (strs.length) clauses.push({ kind: 'in-list', expr: col(scan.id, 'uid'), values: strs.map((s) => lit(s, 'text')) });
  const pred = clauses.reduce<Expr | undefined>((left, right) =>
    left ? { kind: 'binary', op: 'or', left, right } : right, undefined);

  const source = pred ? make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred }) : scan;
  return {
    elem,
    rel: make.project({
      id: fresh('c'), input: source, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
      exprs: [['id', col(source.id, 'id')], ['bulk', lit(1, 'int')]],
    }),
  };
}

/**
 * Lower a whole rooted chain, or decline.
 *
 * Coverage today is the element SOURCE and nothing after it. That is deliberately the smallest
 * increment that is end-to-end real: the routing, the differential and the coverage ratchet all
 * exist and are measured, so every later step is a coverage delta against a working instrument
 * rather than a leap. The declines below are the growth list, in Phase 4.1's order.
 */
export function lowerToRel(steps: readonly IRStep[]): RelLowering | null {
  const first = steps[0];
  if (!first) return null;
  if (first.name !== 'V' && first.name !== 'E') return null;
  // Anything after the source is uncovered vocabulary. Phase 4.1 grows this: the row-algebraic
  // class first (`limit`/`skip`/`range`/`tail`/`order`/`dedup`/`sample`), then movement.
  if (steps.length > 1) return null;
  // A modulator or an option arm on the source is not a source argument; decline rather than
  // silently ignore it.
  if (first.modulators?.length || first.optionArms) return null;

  const fresh = minter();
  const source = elementSource(first, fresh);
  if (!source) return null;
  return { plan: nameBindings(source.rel), elem: source.elem, cols: [...SOURCE_COLS], channels: BULK };
}
