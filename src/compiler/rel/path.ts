import type { Channel } from '../../channels.ts';
import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ListOf, Shape } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/step.ts';
import { SHAPE_K } from '../steps/context/alias.ts';
import { byEncounter, carriedCols, jsonOf, meta, typeOf, type Minter } from './build.ts';
import { elementNode } from './element.ts';
import { historyAppend, historySeed, objectEntry, type TraverserObject } from './history.ts';
import { LIST_COL, TYPED_LIST } from './list.ts';
import { byNode, modulations, type ByChild, type Modulation } from './modulator.ts';

/**
 * THE PATH CHANNEL — where the traverser has BEEN, as one carried column.
 *
 * The ninth vocabulary module on `build.ts`, and the reap of §10·10: the seam that could declare no
 * translation for the `path` role is gone, so the channel core's oldest unbuilt role finally has a
 * producer. The core could always hold a path (`CHANNEL_MERGE_POLICY.path`, `CHANNEL_GROUP_POLICY.path`
 * were both declared and unreachable); what was missing was somewhere for it to go.
 *
 * ## ONE JSONB ARRAY, not a column per position
 *
 * Legacy carries a linear path as `p0…pN` — one column per position, statically known length — and a
 * recursive one as a JSONB array, and those are TWO regimes with two readers, two `by()` projectors and
 * a documented wall between them (`movement after recursive repeat().path() not yet supported`). This
 * route carries ONE array, and that collapses the regimes into each other:
 *
 * - **a branch arm's shorter path is DATA, not padding.** Legacy pads to the longest arm, so a position
 *   is nullable, an element position needs a LEFT JOIN, and a `by()` over one needs a sibling presence
 *   column (`_at`) to tell "this arm never got here" from "the property is missing". With an array, a
 *   two-hop arm's path simply has two entries and a three-hop arm's has three. None of that machinery
 *   has an analogue here, which is why `union`/`choose` needed no path-specific code at all.
 * - **`repeat()`'s dynamic length is the same shape as everything else**, so the recursive regime is
 *   nothing new when Phase 3 lands — the array is already what a `Recursive` step would append to.
 * - **`CHANNEL_COL` is keyed by ROLE** (`build.ts`), so a role gets ONE column type. Per-position rowids
 *   would need `int`, an array needs `json`, and the table cannot say both — the encoding was going to be
 *   single either way, and the array is the one that serves both regimes.
 *
 * ## The ENTRY encoding is the ALIAS channel's, and that is the point
 *
 * `as('a')` appends the current object to a LABEL's history; a tracked path appends it to THE traverser's
 * history. Same question, so `history.ts` answers it once and both channels write the identical tagged
 * entry (`{k,v[,t]}`, `SHAPE_K`). Two consequences worth having: a path position can hold anything a
 * label can — a vertex, an edge, a value, a folded list — so a heterogeneous path is not a special case;
 * and the tag makes the READ uniform, one `case` over `k` however long the path is, where a per-position
 * `elem` recorded at compile time would need one arm per position and could not survive a dynamic length.
 *
 * ## A PATH IS A LIST VALUE, plus a framing arm
 *
 * `path()` does not produce a fourth stream kind. It consumes the channel and produces the LIST shape —
 * one `list` column holding the positions as members of the typed tree — and the only thing that makes it
 * a Path rather than a List is which framer reads it (`jsonbPath` vs `jsonbList`, and `framePath` wraps
 * the same per-member buffers). That is not a shortcut, it is what the reference corpus says: TinkerPop's
 * `path().by('name').combine(['dave'])` answers `l[marko,josh,dave]`, so a Path re-enters the collection
 * vocabulary as an ordinary list and every set op, `reverse()`, `unfold()` and local reducer composes over
 * it with no path-specific lowering (§10·9 — a shape is a value plus a framing arm). It is exactly the
 * standing `set` already has on the list arm, one level up: same member substrate, different wire form.
 *
 * ## Fail closed: an unappended position is a WRONG path
 *
 * Every step that produces a NEW traverser object owes the path a position. A step that carries the
 * column through without appending would report a path that silently omits a hop — right arity, plausible
 * elements, and a census that structurally cannot see it. So the fold's rule is DENY: `movement` appends,
 * the position-preserving steps (filters, `as()`, `order()`, the slices) carry it, and every other branch
 * declines while `pathCarried` is true. What that costs today is `values()`-and-friends mid-path (a VALUE
 * position, which this encoding can already hold — the fold simply does not append one yet), `select`,
 * `dedup`, the writes and the barriers.
 *
 * Also absent and each its own increment: `by()` modulation per position, `from()`/`to()` scoping, and the
 * steps that follow a path (`is(typeOf(PATH))`, the retype into the list loop) — a path is TERMINAL here.
 */

/** The one carried column, and the channel that claims it. One name because the payload projection and
 *  the framing layer both read it — the standing `LIST_COL` and `MAP_COL` have. */
export const PATH_COL = 'path';
export const PATH_CHANNEL: Channel = { col: PATH_COL, role: 'path' };

/** Is this relation tracking a path? Asked of the RELATION, never of a chain-global flag: the channel set
 *  is a property of each relation (§3.5), and every reader here keys on its presence exactly as the
 *  emission-order readers key on `encounter`'s. */
export const pathCarried = (rel: Rel): boolean => rel.channels.some((channel) => channel.role === 'path');

/** Position 0 — the source element, seeded where the chain's own text says it tracks a path. */
export const seedPath = (object: TraverserObject): Expr => historySeed(objectEntry(object));

/** ONE MORE POSITION: the path column replaced, every other column and channel through untouched.
 *
 *  A movement appends ONCE over its whole fan-out rather than per arm, because the object being recorded
 *  is the NEW traverser's — two arms each appending their own would be the same expression twice and, at
 *  the fan-out's own `id`, the identical value. */
export function extendPath(rel: Rel, object: TraverserObject, fresh: Minter): Rel {
  return make.project({
    id: fresh('pa'), input: rel, channels: rel.channels, type: rel.type,
    exprs: rel.type.cols.map((column) => [
      column.name,
      column.name === PATH_COL
        ? historyAppend(col(rel.id, PATH_COL), objectEntry(object))
        : col(rel.id, column.name),
    ] as const),
  });
}

/**
 * `path()` — the channel CONSUMED, and the positions rebuilt as one list value.
 *
 * The member frame is the list vocabulary's, one level over: explode the history, expand each entry into
 * the node the wire needs, re-aggregate in position order. What each entry expands TO is the whole of the
 * work — an entry holds a ROWID, because appending a whole element payload at every hop would run three
 * correlated subqueries per row on the index-only movement path — so this is where the rowid becomes the
 * public element (`elementNode`, shared with the element payload and with a list's element members, so a
 * path position and a folded element frame identically by construction).
 *
 * `TYPED_LIST` is the honest member encoding: the positions are self-describing `{t,v}` nodes, and since an
 * element is a MEMBER of that tree a path holding a vertex, an edge and a value at once needs no descriptor
 * per position — the framer reads each member's own tag.
 *
 * THE FENCE IS LOAD-BEARING, and it is `list.ts`'s `fenced` rule one node earlier: `json_each` reads from
 * the FROM clause, where SQL cannot name a select alias, so fused into the block that COMPUTES the path
 * column it re-inlines the whole nested append chain. A `Materialize` makes the column a real CTE column,
 * which is also what keeps a five-hop path's statement text linear in the hop count rather than nested five
 * deep inside a table-valued function argument.
 */
export function pathPositions(
  rel: Rel, step: IRStep, params: Record<string, any>, child: ByChild, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf; readonly scalars: boolean } | null {
  if (!pathCarried(rel)) return null;
  const parsed = modulations(step, step.modulators?.length ?? 0, params);
  if (!parsed) return null;
  const fenced = rel.kind === 'materialize'
    ? rel
    : make.materialize({ id: fresh('pm'), input: rel, channels: rel.channels, type: rel.type });
  const members = make.explode({
    id: fresh('px'), expr: jsonOf(col(fenced.id, PATH_COL)), channels: [],
    as: { value: 'pv', ord: 'po' },
    type: typeOf(meta('pv', 'any', true), meta('po', 'int')),
  });
  const entry = col(members.id, 'pv');
  const rowid: Expr = {
    kind: 'cast',
    arg: { kind: 'call', fn: 'json_extract', args: [entry, lit('$.v', 'text')] },
    to: 'int',
  };
  const tag: Expr = { kind: 'call', fn: 'json_extract', args: [entry, lit('$.k', 'text')] };
  // ONE `case` over the entry's own tag, whatever the path's length — which is the whole reason the entry
  // carries a tag at all. Two arms because only element objects reach the append today; a VALUE position
  // is a third arm here and an append at the retype, not a different encoding.
  const element: Expr = {
    kind: 'case',
    whens: [[
      { kind: 'binary', op: '=', left: tag, right: lit(SHAPE_K.edge, 'int') },
      elementNode(rowid, 'edge', fresh),
    ]],
    else: elementNode(rowid, 'vertex', fresh),
  };
  const projectedNode = (modulation: Modulation): Expr | null => {
    if (modulation.key.kind === 'identity') return element;
    const edge = byNode(modulation, { kind: 'element', id: rowid, elem: 'edge' }, fresh, child);
    const vertex = byNode(modulation, { kind: 'element', id: rowid, elem: 'vertex' }, fresh, child);
    if (!edge || !vertex) return null;
    return {
      kind: 'case',
      whens: [[
        { kind: 'binary', op: '=', left: tag, right: lit(SHAPE_K.edge, 'int') },
        edge,
      ]],
      else: vertex,
    };
  };
  const projected = parsed.map(projectedNode);
  if (projected.some((node) => node === null)) return null;
  const nodes = projected as Expr[];
  const node: Expr = nodes.length === 0
    ? element
    : nodes.length === 1
      ? nodes[0]
      : {
          kind: 'case',
          whens: nodes.slice(0, -1).map((arm, j) => [{
            kind: 'binary', op: '=',
            left: { kind: 'binary', op: '%', left: col(members.id, 'po'), right: lit(nodes.length, 'int') },
            right: lit(j, 'int'),
          }, arm]),
          else: nodes[nodes.length - 1],
        };
  const positions: Expr = {
    kind: 'scalar',
    plan: make.aggregate({
      id: fresh('pg'), input: members, channels: [], type: typeOf(meta(LIST_COL, 'json')),
      groupBy: [],
      aggs: [[LIST_COL, {
        kind: 'call', fn: 'jsonb', args: [{
          kind: 'call', fn: 'COALESCE', args: [
            {
              kind: 'agg', fn: 'json_group_array',
              args: [{ kind: 'call', fn: 'json', args: [node] }],
              orderBy: [{ expr: col(members.id, 'po'), dir: 'asc' }],
            },
            { kind: 'call', fn: 'json', args: [lit('[]', 'text')] },
          ],
        }],
      }]],
    }),
  };
  // The path channel does NOT come out the other side: `path()` is what reads it, and a relation still
  // claiming the column after the positions became the value would be a channel nothing can honestly
  // append to. Every OTHER channel rides through — a linear path is row-preserving, so the label history
  // and the emission position are still this traverser's (which is what lets `select(label)` after
  // `path()` resolve, once that arm lands).
  const channels = fenced.channels.filter((channel) => channel.role !== 'path');
  const projection = make.project({
    id: fresh('pp'), input: fenced, channels,
    type: typeOf(meta(LIST_COL, 'json'), ...carriedCols(channels)),
    exprs: [[LIST_COL, positions], ...channels.map((channel) => [channel.col, col(fenced.id, channel.col)] as const)],
  });
  const hasNonIdentity = parsed.some((modulation) => modulation.key.kind !== 'identity');
  /**
   * IS EVERY POSITION A PROJECTED SCALAR? — the one thing a consumer of this path needs that the member
   * encoding cannot tell it, and the reason it is reported rather than re-derived.
   *
   * `TYPED_LIST` is the honest encoding for both an element position and a `by()`-projected one (both are
   * members of the self-describing tree, and `frameTypedNode` reads each member's own tag), so the framing
   * arm cannot distinguish them — which is exactly right for FRAMING a Path and exactly wrong for RE-ENTERING
   * one as a list. The list vocabulary's member ops decode a member's `$.v` into a SCALAR stream, and the
   * scalar tail has no element arm, so `path().unfold()` over element positions would frame a vertex's
   * payload object as a plain value: a WRONG ANSWER where legacy fails closed, which is the one failure the
   * routing switch cannot absorb.
   *
   * So this is legacy's own boundary, stated in this route's vocabulary — `linearScalarList` coerces a path
   * to a list only when `positions.every(p => p.render === 'value')`. A MIXED `by().by('name')` is false for
   * the same reason it is there: alternate positions are still elements. It goes away when a list can hold
   * an ELEMENT member (§10·10's remaining list arm), not before.
   */
  const scalars = parsed.length > 0 && !parsed.some((modulation) => modulation.key.kind === 'identity');
  if (!hasNonIdentity || step.productiveBy === true) return { rel: projection, of: TYPED_LIST, scalars };

  // Productivity reads the rebuilt list, so fence the projection before the correlated clause reader.
  const projectedPath = make.materialize({
    id: fresh('pm'), input: projection, channels: projection.channels, type: projection.type,
  });
  const projectedMembers = make.explode({
    id: fresh('px'), expr: jsonOf(col(projectedPath.id, LIST_COL)), channels: [],
    as: { value: 'pv', ord: 'po' },
    type: typeOf(meta('pv', 'any', true), meta('po', 'int')),
  });
  const missing = make.filter({
    id: fresh('f'), input: projectedMembers, channels: [], type: projectedMembers.type,
    pred: { kind: 'binary', op: 'is', left: col(projectedMembers.id, 'pv'), right: lit(null, 'any') },
  });
  const probe = make.project({
    id: fresh('pp'), input: missing, channels: [], type: typeOf(meta('pv', 'any', true)),
    exprs: [['pv', col(missing.id, 'pv')]],
  });
  return {
    rel: make.filter({
      id: fresh('f'), input: projectedPath, channels: projectedPath.channels, type: projectedPath.type,
      pred: { kind: 'exists', negated: true, plan: probe },
    }),
    of: TYPED_LIST,
    scalars,
  };
}

/** THE WIRE ROWS: one `list` column per Path, in emission order — `listPayload`'s twin, and deliberately
 *  only as different from it as the framer is. The `json()` is not cosmetic: a JSONB value crossing a
 *  subquery boundary loses SQLite's json subtype, which is the same reason every other payload arm spells
 *  it. `byEncounter` is shared with them too, because the wire's row order is one decision (`build.ts`). */
export function pathPayload(
  rel: Rel, of: ListOf, fresh: Minter,
): { readonly rel: Rel; readonly shape: Shape } {
  const ordered = byEncounter(rel, fresh);
  return {
    rel: make.project({
      id: fresh('pw'), input: ordered, channels: [], type: typeOf(meta(LIST_COL, 'json', true)),
      exprs: [[LIST_COL, jsonOf(col(ordered.id, LIST_COL))]],
    }),
    shape: { kind: 'jsonbPath', items: of },
  };
}
