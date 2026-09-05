// SLICE + ROW ALGEBRA — the positional/row operations of the fold: limit/skip/range/tail/sample
// (sliceOp/slice/bulkSlice), the barrier row ops order/dedup (rowOp), and the keyed-dedup builders
// (dedupBy/dedupOn/dedupByLabels). Each returns a `Rel`; extracted from lower.ts.
import * as make from '../../../rel/factory.ts';
import { col, compilerInt, type Expr } from '../../../rel/expr.ts';
import { and, carriedCols, eq, typeOf, meta, rowNumberWindow, type Minter } from '../build.ts';
import { type Channel } from '../../../channels.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { Elem } from '../../elem.ts';
import type { IRStep } from '../../ir/strategies.ts';
import { isLocalScope, sliceOf, sliceParamNames } from '../../ir/step.ts';
import { countLit, sliceBound } from '../const.ts';
import { byExpr, modulations, productivityFilter, type Modulation } from '../modulator.ts';
import type { AliasMap } from '../../alias.ts';
import { aliasIdAt, aliasListAt, aliasProjection, aliasValueAt } from '../alias.ts';
import { groupableChannels } from '../../../channels.ts';
import { payloadCols } from '../build.ts';
import { exprChildren } from '../../../rel/walk.ts';
import { ValueParseError } from '../../../gremlin/coerce.ts';
import { BY_HOSTS as BY_READERS } from '../../ir/strategies.ts';
import type { ChildHost } from '../child.ts';
import { elementHost } from '../map.ts';
import { propertyIdentityKey, propertyOrderTerms, propertyRowId } from '../property.ts';
import { pathCarried } from '../path.ts';
import { BULK, encounterOf, graphOf, originOf, type ChainCtx } from './chain.ts';
import { withChannel } from '../../../channels.ts';
import { dropPath, orderRows } from '../lower.ts';
import { childSeam, perOriginWindow, reverseCollation } from './reduction.ts';

export function sliceOp(step: IRStep, input: Rel, bulked: boolean, fresh: Minter): Rel | null {
  if (step.modulators?.length || step.optionArms || isLocalScope(step)) return null;
  if (!SLICE_STEPS.has(step.name)) return null;
  const encounter = encounterOf(input.channels);
  const bulk = input.channels.find((channel) => channel.role === 'bulk');

  // PER-ORIGIN when an `origin` channel is live: a DETERMINISTIC slice inside a per-parent body (a
  // `local`/`flatMap` body, or a `match` pattern body that minted a per-traverser origin) is scoped to
  // each parent — the fold-mode rule. Route `limit`/`range`/`skip`/`tail` to the ranked window
  // (`perOriginWindow`) partitioned by `origin`; at the top level there is no `origin`, so the global
  // `LIMIT`/sort below stands unchanged. `sample` is EXCLUDED and falls through to the RANDOM window
  // below (which keeps `origin` as a carried channel) — a per-origin reservoir is a separate question,
  // and intercepting it here regressed a working `by(__.…order().sample(n).fold())` reducer to a
  // deferral. A bulked relation or a DATA-sized param count (the window inlines its bound) fail closed.
  const origin = originOf(input.channels);
  if (origin && step.name !== 'sample') {
    if (bulked) return null;
    // A per-origin `tail(n)` is the last n per origin — the first n under the REVERSED collation.
    // `reverseCollation` falls back to the payload when the body minted no `encounter` (no `order()`),
    // so an unordered per-origin tail is a deterministic impl-defined pick rather than a decline — unlike
    // a GLOBAL tail, which has no position to read and declines below.
    if (step.name === 'tail') return perOriginWindow(input, col(input.id, origin.col), reverseCollation(input), { scope: 'global', offset: 0, limit: countArg(step) }, fresh);
    if (sliceParamNames(step).some((name) => name != null)) return null;
    let w; try { w = sliceOf(step); } catch (e) { if (e instanceof ValueParseError) throw e; return null; }
    return perOriginWindow(input, col(input.id, origin.col), [], w, fresh);
  }

  // `sample(n)` is n traversers chosen UNIFORMLY — `SampleGlobalStep` is a weighted reservoir sample
  // whose weights come from a `by()`, and with no modulator every weight is 1. Rank once in a window
  // over RANDOM(), then FILTER the chosen ranks: a Sort(RANDOM()) -> Limit(n) can be fused so SQLite
  // re-evaluates RANDOM() for each outer candidate and returns the wrong cardinality. Filtering also
  // preserves the INPUT order of the survivors, matching CollectingBarrierStep's insertion-order
  // drain; the old claim that the root restored a carried position was false because `sample` is not
  // a positional consumer. A `by()` declines through the blanket modulator gate above.
  //
  // Over a COLLAPSED relation it declines rather than sampling: a uniform sample of ROWS is not a
  // uniform sample of traversers when a row stands for N of them, and there is no trimming to do —
  // sample has no band, so `bulkSlice` has nothing to say about it.
  if (step.name === 'sample') {
    if (bulked) return null;
    const rank = 'sample_rank';
    const ranked = rowNumberWindow(input, rank, input.channels,
      { partitionBy: [], orderBy: [{ expr: { kind: 'call', fn: 'RANDOM', args: [] }, dir: 'asc' }] }, fresh);
    // The filter reads a column computed by the window's block, so fence it rather than letting the
    // assembler inline and re-evaluate the RANDOM() expression at the clause-reader boundary.
    const frame = make.materialize({
      id: fresh('sm'), input: ranked, channels: ranked.channels, type: ranked.type,
    });
    const sampled = make.filter({
      id: fresh('sf'), input: frame, channels: frame.channels, type: frame.type,
      pred: { kind: 'binary', op: '<=', left: col(frame.id, rank), right: countLit(countArg(step)) },
    });
    return make.project({
      id: fresh('sp'), input: sampled, channels: input.channels, type: input.type,
      exprs: input.type.cols.map((column) => [column.name, col(sampled.id, column.name)] as const),
    });
  }

  // `tail(n)` is `limit(n)` read from the FAR END, so it is the direction flag on the shared slice
  // rather than a fourth builder — and it is the one window `sliceOf` will not decode, because "the
  // last n" is an offset only once something supplies the member count. Nothing has to: read the
  // relation backwards and the count never appears.
  //
  // It NEEDS a carried position, and that is not a limitation to work around — "last" is a question
  // ABOUT emission order, so a relation carrying none has no last, and the traversal declines.
  if (step.name === 'tail') {
    if (!encounter) return null;
    const last = { offset: 0, limit: countArg(step) };
    if (bulked && bulk) return bulkSlice(input, last, encounter, bulk, 'desc', fresh);
    return slice(input, last, encounter, 'desc', fresh);
  }

  // `sliceOf` throws in two DIFFERENT senses (§6·5). An illegal range (`range(2,1)`) is a
  // `ValueParseError` — the traversal's ANSWER is that error, so it PROPAGATES rather than declining
  // (catching it would turn a required error into a generic `UnsupportedTraversal`, the wrong
  // classification). Any OTHER throw is the internal "not a slice step" routing signal, which this
  // module's `null`-only decline contract catches. Found by sweeping every prefix of every corpus
  // traversal under all four switch combinations, which is the only way a decline-contract violation
  // shows up at all.
  let window;
  try { window = sliceOf(step); } catch (e) { if (e instanceof ValueParseError) throw e; return null; }
  // A COLLAPSED relation's row stands for `bulk` traversers, so `LIMIT n` would take n ROWS and
  // answer a different question. `bulked` says the multiplicity is not provably 1, and then the
  // slice must count traversers — which needs a position to accumulate along, so a bulked relation
  // with no emission order declines rather than guessing one. The band arithmetic there computes on
  // the count, so a parameter REDUCES (bulkSlice reads the numbers, not `paramOf`), the same last
  // responsible moment `range` reduces at.
  if (bulked && bulk) return encounter ? bulkSlice(input, window, encounter, bulk, 'asc', fresh) : null;
  return slice(input, { ...window, ...paramOf(step) }, encounter, 'asc', fresh);
}

/** Which slice bound, if any, carries a user PARAMETER that binds untouched. Only `limit` (its count)
 *  and `skip` (its offset) qualify — a single value SQL takes as a plain `?`. `range` reduces (its
 *  count is `hi−lo` and its `lo>hi` throws), so it maps to nothing here and inlines via `sliceOf`. */
const paramOf = (step: IRStep): { limitParam?: string | null; offsetParam?: string | null } =>
  step.name === 'limit' ? { limitParam: sliceParamNames(step)[0] ?? null }
  : step.name === 'skip' ? { offsetParam: sliceParamNames(step)[0] ?? null }
  : {};

/** The row slice steps this fold serves. `tail` and `sample` are here as DIRECTIONS and a shuffle on
 *  the same op rather than as separate arms, which is what `globalRowOps` says with its own three
 *  handlers over one `reprojectRows`. */
const SLICE_STEPS = new Set(['limit', 'skip', 'range', 'tail', 'sample']);

/** THE STEPS `rowOp` SERVES — every one of them PRESERVES the shape, which is why a tail whose other
 *  arms are retypes must route them FIRST and then recurse. Declared rather than inferred so a new
 *  row-algebraic op reaches every shape at once instead of only the tail whose author remembered it. */
export const ROW_OPS: ReadonlySet<string> = new Set(['identity', 'barrier', 'order', 'dedup', ...SLICE_STEPS]);

/** The three steps that apply a CHILD BODY once per traverser. One set rather than three names at the
 *  dispatch, because what separates them is a policy inside the lowering and not which loop owns
 *  them — `perTraverserChild` is where that policy is written down. */
export const PER_TRAVERSER_HOSTS = new Set(['map', 'flatMap', 'local']);

/** `tail(n)`/`sample(n)`'s count. Both default to 1, and neither takes a range, so the numeric
 *  argument is the whole decode — `sliceOf` deliberately refuses `tail` (see `sliceOp`). */
const countArg = (step: IRStep): number =>
  Number(step.args.find((a) => typeof a.value === 'number')?.value ?? 1);

/** `ORDER BY <position> [DESC] LIMIT/OFFSET` — the plain slice, where a row IS one traverser. An
 *  unordered relation stays unordered rather than inventing a SQLite scan order: a slice with no
 *  position to take a window from only reaches here where the order cannot matter (after `count()`,
 *  whose one row makes `LIMIT 1` and `ORDER BY … LIMIT 1` the same question). */
function slice(
  input: Rel,
  window: { readonly offset: number; readonly limit: number | null; readonly offsetParam?: string | null; readonly limitParam?: string | null },
  encounter: Channel | undefined, dir: 'asc' | 'desc', fresh: Minter,
): Rel {
  // FENCE THE FILTER FROM THE OFFSET WHEN SQLITE WOULD DROP IT. `offsetDropsOverExists` decides; when
  // it holds, a `MATERIALIZED` CTE between the correlated `EXISTS` and the `OFFSET` is the fence, and it
  // goes UNDER the `order()` sort so the emission order is re-established over the materialized rows.
  const hasOffset = window.offset > 0 || window.offsetParam != null;
  const base = hasOffset && offsetDropsOverExists(input)
    ? make.materialize({ id: fresh('om'), input, channels: input.channels, type: input.type, fenced: true })
    : input;
  const source = encounter
    ? make.sort({
      id: fresh('so'), input: base, channels: base.channels, type: base.type,
      terms: [{ expr: col(base.id, encounter.col), dir }],
    })
    : base;
  // A `limit($x)`/`skip($x)` count is a user PARAMETER and binds untouched; a parsed literal inlines
  // (`sliceBound`). The offset is emitted for a nonzero literal OR any parameter (a `skip($x)` where
  // `$x` happens to resolve to 0 still binds, so the plan is one cached statement over every offset).
  return make.limit({
    id: fresh('li'), input: source, channels: input.channels, type: input.type,
    ...(window.limit === null ? {} : { count: sliceBound(window.limit, window.limitParam ?? null) }),
    ...(window.offset || window.offsetParam != null ? { offset: sliceBound(window.offset, window.offsetParam ?? null) } : {}),
  });
}

/**
 * SQLite (measured on bun:sqlite 3.51.x AND the DO runtime) SILENTLY DROPS an `OFFSET` when the
 * offset's own `SELECT` block has a SINGLE-TABLE `FROM` and a POSITIVE correlated `EXISTS` in its
 * `WHERE`:
 * ```
 * SELECT id FROM nodes n WHERE EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id) LIMIT -1 OFFSET 1
 * ```
 * returns EVERY surviving row — a wrong ANSWER, not a reorder. A `JOIN` in the `FROM` (any movement)
 * dodges it; `NOT EXISTS`, an uncorrelated `IN (SELECT …)` and a scalar `(SELECT …) > 0` do not
 * trigger it. That is why `propertySeek` — which lifts a `has()`'s `EXISTS` into a join — masked the
 * defect on the ONE traversal `known.ts` recorded, while the whole `where(…)`/`has(…)`-then-`skip`
 * family answered wrong in production under the DEFAULT config. A differential comparing two lowerings
 * could not have seen it — the bug would sit identically in both — which is the blind-spot class L5's
 * own header names. The fence is a `MATERIALIZED` CTE between the filter and the offset (`slice`).
 *
 * This decides when the fence is needed: does the offset's block FUSE a positive correlated `EXISTS`
 * onto a bare scan? It walks the block-fusing spine — `project`/`filter`/`sort`/`materialize` all fold
 * into one `SELECT`, and `sliceOf`'s own `order()` sort sits on top — down to the `FROM`-defining node.
 * A `scan` there IS the single-table `FROM` the bug needs; any block-closing node (`join`/`union`/
 * `distinct`/`aggregate`/`window`/…) means the offset does not sit over a bare scan, so it cannot bite.
 * A plain `materialize` is transparent here: an ordinary CTE is flattened, so an `EXISTS` beneath one
 * still fuses upward — the fence wraps the whole input, which the `MATERIALIZED` barrier then pins.
 */
function offsetDropsOverExists(input: Rel): boolean {
  let sawExists = false;
  for (let node: Rel = input; ; ) {
    switch (node.kind) {
      case 'scan': return sawExists;
      case 'filter': sawExists ||= hasPositiveExists(node.pred); node = node.input; break;
      case 'project': case 'sort': case 'materialize': node = node.input; break;
      default: return false;
    }
  }
}

/** Does this predicate place a POSITIVE `EXISTS` in the emitted `WHERE`? Parity-tracked, because a
 *  `hasNot(k)` (`NOT (EXISTS …)`) and a `not(__.out())` (a `negated` exists) both render as `NOT
 *  EXISTS`, which does not trigger the bug — so an exists under an ODD number of negations is not one
 *  the fence must cover. (A positive exists buried in `NOT (a AND …)` reads as negated and is left
 *  unfenced; that composition does not arise from ordinary Gremlin and a spurious fence would only cost
 *  a redundant barrier, never correctness.) */
function hasPositiveExists(pred: Expr): boolean {
  const walk = (e: Expr, negated: boolean): boolean =>
    e.kind === 'exists' ? e.negated === negated
    : e.kind === 'unary' && e.op === 'not' ? walk(e.arg, !negated)
    : exprChildren(e).some((child) => walk(child, negated));
  return walk(pred, false);
}

/**
 * A SLICE THAT COUNTS TRAVERSERS — the cumulative-bulk window, and the composition that makes
 * element `order()` safe to cover at all.
 *
 * Under `movementCollapse` a row is an (element, N) pair, so the traverser a slice's boundary falls
 * inside is a row whose multiplicity must be TRIMMED rather than taken or dropped whole. A running
 * `SUM(bulk)` over the emission order gives each row the index one past its last traverser (`cum`),
 * so the row covers the half-open band `[cum - bulk, cum)`; the slice keeps the rows whose band
 * intersects `[offset, offset + limit)` and re-projects `bulk` as the width of the intersection.
 *
 * Done as a one-off, this shape can only live in the element FRAMING projection (a bulk-aware
 * limit/range), where it happens once and only at the end. Here it is four ordinary nodes over any
 * relation carrying a multiplicity and a position — which is why it serves the element fold and the
 * scalar tail from one place, and why `order().limit()` composes rather than being a shape the
 * framing layer has to recognise.
 *
 * The frame is explicit (`ROWS UNBOUNDED PRECEDING … CURRENT ROW`) rather than left to SQLite's
 * default: over a total order the default `RANGE` form agrees, but the emission order is only total
 * because the mint tie-broke it, and a window whose correctness depends on a caller's tie-break
 * argument is the kind of thing that goes wrong silently when the caller changes.
 */
export function bulkSlice(
  input: Rel, window: { readonly offset: number; readonly limit: number | null },
  encounter: Channel, bulk: Channel, dir: 'asc' | 'desc', fresh: Minter,
): Rel {
  const lo = window.offset;
  const hi = window.limit === null ? null : lo + window.limit;
  const running = make.window({
    id: fresh('bw'), input, channels: input.channels,
    type: typeOf(...input.type.cols, meta('cum', 'int')),
    specs: [['cum', {
      kind: 'window-expr', fn: 'sum', args: [col(input.id, bulk.col)],
      spec: {
        // The direction is the whole of `tail(n)`: accumulate BACKWARDS and the band `[0, n)` is the
        // last n traversers instead of the first. The rows keep their positions either way, so the
        // root's `ORDER BY <position>` still reports them in emission order.
        partitionBy: [], orderBy: [{ expr: col(input.id, encounter.col), dir }],
        frame: { mode: 'rows', start: { kind: 'unbounded-preceding' }, end: { kind: 'current-row' } },
      },
    }]],
  });
  // Each node addresses its own INPUT's columns, so the band is spelled twice against two relations
  // rather than once against a relation that is out of scope where it is read.
  const band = (rel: Rel): { readonly first: Expr; readonly past: Expr } =>
    ({ first: { kind: 'binary', op: '-', left: col(rel.id, 'cum'), right: col(rel.id, bulk.col) }, past: col(rel.id, 'cum') });
  const inner = band(running);
  const kept = make.filter({
    id: fresh('bf'), input: running, channels: running.channels, type: running.type,
    pred: and(
      { kind: 'binary', op: '>', left: inner.past, right: countLit(lo) },
      hi === null ? undefined : { kind: 'binary', op: '<', left: inner.first, right: countLit(hi) },
    ),
  });
  const outer = band(kept);
  const from: Expr = lo ? { kind: 'call', fn: 'MAX', args: [outer.first, countLit(lo)] } : outer.first;
  const to: Expr = hi === null ? outer.past : { kind: 'call', fn: 'MIN', args: [outer.past, countLit(hi)] };
  return make.project({
    id: fresh('bs'), input: kept, channels: input.channels, type: input.type,
    exprs: input.type.cols.map((column) => [column.name, column.name === bulk.col
      ? { kind: 'binary', op: '-', left: to, right: from } as Expr
      : col(kept.id, column.name)] as const),
  });
}

/**
 * WHAT A PER-ROW SHAPE OWES the shape-agnostic row-algebraic ops — the whole of what `rowOp` needs to
 * know about the payload it is slicing, ordering and deduping.
 *
 * There are exactly three questions, and every one of them is a fact TinkerPop states per TYPE rather
 * than per step: which traverser a `by()` reads (`host`), what breaks a tie deterministically when
 * `order()` has to MINT a position (`tie`), and what makes two traversers THE SAME ONE (`identity`).
 * `natural` is the fourth only because two shapes answer their own order with a term LIST — see
 * `naturalSort`.
 *
 * Growing this record is how a shape becomes a first-class row participant. It is deliberately NOT the
 * union of its callers' needs: a shape that cannot answer one of these declines the op, it does not get
 * a special case inside `rowOp` (§6·6 — the seam must not become the union of its consumers).
 */
export type RowShape = {
  readonly host: ChildHost;
  readonly tie: (input: Rel) => readonly Expr[];
  readonly identity: (input: Rel) => readonly Expr[];
  /** True when `identity` NAMES THE WHOLE PAYLOAD, so a bare `dedup()` may use the cheap set forms
   *  (`Distinct` / a grouped aggregate) instead of a ranked window. An element relation's payload IS its
   *  id; a property relation's is six columns of which the identity is one or three. */
  readonly identifiedByPayload: boolean;
  readonly natural?: (input: Rel) => readonly Expr[];
};

/** The ELEMENT shape — `id` is at once the payload, the identity and the tie-break. */
export const elementRowShape = (input: Rel, elem: Elem, aliases: AliasMap): RowShape => ({
  host: elementHost(input, elem, aliases),
  tie: (rel) => [col(rel.id, 'id')],
  identity: (rel) => [col(rel.id, 'id')],
  identifiedByPayload: true,
});

/** The PROPERTY shape. Both its order and its identity split on the owner kind, and both citations live
 *  in `property.ts` — a `VertexProperty` IS an `Element` (compared and hashed by id) while an edge
 *  `Property` is compared and hashed by KEY and VALUE. */
export const propertyRowShape = (input: Rel, elem: Elem, aliases: AliasMap): RowShape => ({
  host: { kind: 'property', id: propertyRowId(input), ownerElem: elem, row: { rel: input, aliases } },
  // The property row's own rowid: deterministic for both owner kinds, even where it is not the identity.
  tie: (rel) => [propertyRowId(rel)],
  identity: (rel) => propertyIdentityKey(rel, elem),
  identifiedByPayload: false,
  natural: (rel) => propertyOrderTerms(rel, elem),
});

/** The SCALAR shape — a value stream. Identity IS the whole payload (the value, plus a `vtype` column
 *  where the type rides per row), so two rows are the same traverser iff they are the same value of the
 *  same type — which is exactly `S.equals()` for the scalar `S` a `DedupGlobalStep` collapses on. The
 *  tie is the value itself: the sort key of a value stream derives from the value, so a value tie-break
 *  falls only between EQUAL values (a no-op that changes no order) and is the deterministic survivor a
 *  dedup keeps. `natural` is absent — `order()` over a scalar sorts by the value expression the host
 *  already yields (`sortTerms`), so there is no term LIST only the host can state. */
export const scalarRowShape = (host: ChildHost): RowShape => ({
  host,
  tie: (rel) => [col(rel.id, 'v')],
  identity: (rel) => payloadCols(rel).map((column) => col(rel.id, column.name)),
  identifiedByPayload: true,
});

/** A shape whose IDENTITY IS ITS WHOLE PAYLOAD — a RECORD's fields, a LIST's JSON, a MAP's JSON. Two
 *  traversers are the same iff their payloads are equal, which for these shapes IS value equality: a
 *  record and a map compare by entries in a canonical key order (`LinkedHashMap`), a list by its ordered
 *  members, so byte-identity over the payload column(s) is exactly `S.equals()`. Both the dedup identity
 *  and the deterministic order tie are that whole payload — hence `tie` is a list, not one column.
 *  `natural` is absent: `order()` sorts by a `by()` projection off the host, and a bare `order()` with
 *  no comparator declines rather than inventing a total order the shape may not have (a Java `Map` is
 *  not `Comparable`; a list is, lexicographically, but SQL cannot state that element-wise compare). */
export const payloadRowShape = (host: ChildHost): RowShape => ({
  host,
  tie: (rel) => payloadCols(rel).map((column) => col(rel.id, column.name)),
  identity: (rel) => payloadCols(rel).map((column) => col(rel.id, column.name)),
  identifiedByPayload: true,
});

export function rowOp(step: IRStep, input: Rel, shape: RowShape, bulked: boolean, ctx: ChainCtx, fresh: Minter): Rel | null {
  if (step.optionArms) return null;
  if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
  if (step.name === 'identity' || step.name === 'barrier') return (step.args ?? []).length ? null : input;
  if (step.name === 'order') return orderRows(step, input, shape.host, ctx, fresh, shape);
  const sliced = sliceOp(step, input, bulked, fresh);
  if (sliced) return sliced;
  // `dedup()` collapses by traverser IDENTITY. A carried path would make every row distinct (two walks
  // to one vertex differ by route), defeating the collapse — but the path has already done its work
  // (a `simplePath()` filtered the stream) and nothing downstream observes it here, so DROP it and
  // dedup by id. `simplePath().dedup()` keeps one traverser per surviving element. A `dedup().path()`
  // that needs the survivor's route is the value-position increment; until then it fails closed.
  if (step.name === 'dedup' && pathCarried(input)) input = dropPath(input, fresh);

  if (step.name !== 'dedup' || (step.args ?? []).length || isLocalScope(step)) return null;

  const ordered = !!encounterOf(input.channels);
  const bys = modulations(step, 1, childSeam(ctx, fresh));
  if (!bys) return null;
  // A `dedup().by(k)` is a ranked WINDOW (`dedupBy` → `dedupOn`), which carries every channel whole, so
  // it serves a body with alias channels or an `origin` with no guard — the guard below is for the
  // COLLAPSING arms only.
  if (bys[0]) return dedupBy(step, bys[0], input, shape, ctx, fresh);

  // THE WINDOW ARMS — both `dedupOn`, which EXTENDS the row (a `row_number` window) and keeps every
  // member's whole payload and every carried channel, so they serve a body that carries alias channels
  // (a `match` binding table) or `origin` (a per-parent `local`/`match` body) with NO channel guard:
  //  - a SHAPE WHOSE IDENTITY IS NOT ITS PAYLOAD (a property row) — the set arms below project the group
  //    key and erase the rest, which is wrong where the payload is more than the key;
  //  - a PER-ORIGIN body (`origin` live) — `dedupOn` partitions by `(origin, id)`, DISTINCT within each
  //    parent, and the set arms cannot carry `origin` (its group policy is `undefined`).
  if (!shape.identifiedByPayload) return dedupOn(shape.identity(input), input, shape.tie(input), fresh);
  if (originOf(input.channels)) return dedupOn(shape.identity(input), input, shape.tie(input), fresh);

  // THE COLLAPSING ARMS (`Distinct`/`Aggregate`) reduce the row to `(payload, bulk[, encounter])`, so
  // they may carry ONLY the channels with a defined N→1 answer — `bulk`/`encounter`; an ALIAS/`sack`
  // binding belongs to ONE of the merged rows and a collapse has no answer for it. But that is a reason
  // to take the OTHER correct lowering, not to decline: `dedup()` keeps the FIRST occurrence's WHOLE
  // traverser (`DedupGlobalStep` retains the first `Traverser`, bindings and all), which is exactly what
  // the window arm emits — `ORDER BY (encounter, tie)`, `rn = 1`, every column and channel carried. So a
  // non-collapsible channel routes to `dedupOn`, keeping the survivor's own alias/sack, rather than
  // dropping it. This is the same honest lowering the `!identifiedByPayload`/`origin` cases already take;
  // the collapse below is the pure SQL optimization for the case with nothing but identity to keep.
  // `graph` (a multi-graph merge) is part of the identity KEY, not a passenger: it is spliced into the
  // partition (`dedupOn` via the keys, the `Distinct`/group-by below directly) so A's id 5 and B's id 5
  // stay distinct, and its `undefined` group policy must not veto the dedup.
  if (!groupableChannels(input.channels.filter((channel) => channel.role !== 'origin' && channel.role !== 'graph'))) {
    const g = graphOf(input.channels);
    const keys = g ? [...shape.identity(input), col(input.id, g.col)] : shape.identity(input);
    return dedupOn(keys, input, shape.tie(input), fresh);
  }

  // `dedup()` RESETS the multiplicity: the survivor stands for itself, not for the sum of the
  // duplicates it replaced.
  //
  // Under an emission order it stops being a `Distinct` at all, and the reason is semantic rather
  // than mechanical: the survivor must keep the FIRST occurrence's position, so the step is a
  // GROUPING by traverser identity that takes `MIN(encounter)`. That is the per-traverser reduction
  // the channel core's third policy table (`CHANNEL_GROUP_POLICY`) exists to permit — a grouping
  // may carry a role only where N-rows-into-one has a defined answer, which `bulk` and `encounter`
  // have and an alias, a path or a sack do not.
  if (!ordered) {
    // A `graph` channel (a multi-graph merge) is part of element IDENTITY: dedup on `(payload, graph)`,
    // not the payload alone, so A's id 5 and B's id 5 do not collapse. `bulk` stays the constant 1 (the
    // survivor stands for itself), so a `Distinct` over `(payload, graph, 1)` collapses exactly the
    // duplicate `(payload, graph)` rows. Absent a graph channel this is the ordinary `(payload, 1)`
    // dedup. **The payload is `payloadCols`, not a hard-coded `id`** — that is what makes this ONE arm
    // serve every shape whose identity IS its whole payload (an element's `id`, a scalar's `(v, vtype)`,
    // a list's `list` JSON, a record's fields); for an element `payloadCols` IS `[id]`, byte-unchanged.
    const graph = graphOf(input.channels);
    const chans = graph ? withChannel(BULK, graph) : BULK;
    const pcols = payloadCols(input);
    const projected = make.project({
      id: fresh('dd'), input, channels: chans, type: typeOf(...pcols, ...carriedCols(chans)),
      exprs: [...pcols.map((c) => [c.name, col(input.id, c.name)] as const),
        ...chans.map((c) => [c.col, c.role === 'graph' ? col(input.id, c.col) : compilerInt(1)] as const)],
    });
    return make.distinct({ id: fresh('d'), input: projected, channels: chans, type: projected.type });
  }
  // THE AGGREGATES ARE DERIVED FROM THE CHANNELS THE INPUT ACTUALLY CARRIES, never named — §12's rule,
  // and this line broke it. The pair `['bulk', 'encounter']` was hardcoded while every ordered element
  // relation carried both, and the first one that did not was a `fold().unfold()`: a fold collapses the
  // stream to ONE traverser, so the list relation has no multiplicity to carry and the unfolded members
  // arrive with an emission order and no `bulk`. The declared type then said two columns while the node
  // emitted three, which the factory catches — a THROW out of a lowering whose contract is `null`, i.e.
  // a compile error where the traversal must answer.
  //
  // `groupableChannels` above has already refused every role without a defined N→1 answer, so the two
  // arms below are total over what can reach here; anything else declines rather than being averaged
  // into a plausible value. `bulk` is the constant 1 because a dedup survivor stands for ITSELF
  // (`DedupGlobalStep.filter`'s unconditional `setBulk(1L)`), and `encounter` is the FIRST occurrence's
  // position, which is what makes the survivor the one TinkerPop keeps.
  // MATERIALISE the payload into named columns BEFORE grouping: an aggregate names its group keys once
  // in `GROUP BY` and again in `SELECT`, so grouping by a payload EXPRESSION re-evaluates it twice per
  // row — and a scalar's payload can be a correlated subquery (`label()`/`values(k)` read `v` as a
  // per-row `SELECT … LIMIT 1`). For an element the payload is the physical `id`, so this projection is
  // fused away and the SQL is byte-unchanged; for a subquery payload it becomes a derived table the
  // GROUP BY references by name, evaluating it once. (The `Distinct` arm above already projects first,
  // which is why the unordered dedup never had this cost.)
  const pcols = payloadCols(input);
  const carried = carriedCols(input.channels);
  // An aggregate names its group keys TWICE (in `GROUP BY` and in `SELECT`), so grouping directly by a
  // payload EXPRESSION re-evaluates it per row twice over. That is free for a PHYSICAL payload (an
  // element's `id` is a bare column) but pathological for a COMPUTED one — a scalar `label()`/`values(k)`
  // reads `v` as a correlated `SELECT … LIMIT 1`. So when the payload is computed, FENCE a projection of
  // it (`AS MATERIALIZED`) first, evaluating each value once and letting `GROUP BY` name a column; when
  // it is physical, group directly on the input exactly as the element dedup always has (byte-unchanged).
  const computed = input.kind === 'project'
    && pcols.some((column) => input.exprs.find(([name]) => name === column.name)?.[1]?.kind !== 'col');
  const grouped = computed
    ? make.materialize({
      id: fresh('df'), channels: input.channels, type: typeOf(...pcols, ...carried),
      input: make.project({
        id: fresh('dm'), input, channels: input.channels, type: typeOf(...pcols, ...carried),
        exprs: [...pcols, ...carried].map((column) => [column.name, col(input.id, column.name)] as const),
      }),
    })
    : input;
  const reductions: (readonly [string, Expr])[] = [];
  for (const channel of grouped.channels) {
    if (channel.role === 'bulk') reductions.push([channel.col, compilerInt(1)]);
    else if (channel.role === 'encounter') reductions.push([channel.col, { kind: 'agg', fn: 'min', args: [col(grouped.id, channel.col)] }]);
    else return null;
  }
  return make.aggregate({
    // The group keys are the whole payload (`payloadCols`, matching `shape.identity` for an
    // identity-IS-payload shape), then the aggregates — so this ordered dedup serves every such shape,
    // not just an element's `id`. The declared type names the keys positionally (`factory.aggregate`).
    id: fresh('dd'), input: grouped, channels: grouped.channels,
    type: typeOf(...pcols, ...carried),
    groupBy: computed ? pcols.map((column) => col(grouped.id, column.name)) : shape.identity(input),
    aggs: reductions,
  });
}

/**
 * `dedup().by(<projection>)` — the projection read off the shape's own host, then handed to `dedupOn`.
 *
 * PRODUCTIVITY is the vocabulary's, not this host's: TinkerPop drops a traverser whose `by()` yielded
 * nothing (`DedupGlobalStep.filter` → `product.isProductive()`), and `ProductiveByStrategy` turns that
 * off. `productivityFilter` returns the predicate or `undefined`, so the rule cannot be forgotten here.
 */
function dedupBy(
  step: IRStep, modulation: Modulation, input: Rel, shape: RowShape, ctx: ChainCtx, fresh: Minter,
): Rel | null {
  // A comparator on `dedup()` is not a form Gremlin has — `DedupGlobalStep` is not a comparator host —
  // so an `Order` in its `by()` is a chain `verifyByModulatorArity` never sees. Decline rather than
  // silently ignoring it.
  if (modulation.order !== undefined) return null;
  const key = byExpr(modulation, shape.host, ctx.source, fresh, false, childSeam(ctx, fresh));
  if (!key) return null;
  const productive = productivityFilter(step, key);
  const domain = productive
    ? make.filter({ id: fresh('f'), input, channels: input.channels, type: input.type, pred: productive })
    : input;
  return dedupOn([key], domain, shape.tie(domain), fresh);
}

/**
 * A DEDUP ON AN ARBITRARY KEY — `Window` + `Filter`, not a grouped aggregate, and the difference is the
 * reason: the survivor is ONE traverser and every other column must be ITS values — an `Aggregate` can
 * produce `MIN(id)` but not "the encounter belonging to the row that had it". That is what a ranked
 * window says and an aggregate cannot, so this is the shape emitted.
 *
 * It serves both callers a `by()` and a shape whose IDENTITY is not its payload can have (`rowOp`), and
 * that is not a convenience: the two differ only in which expressions partition, so a second copy would
 * be a second chance to get the survivor rule wrong.
 *
 * WHICH traverser survives is the EMISSION-ORDER question, not an id question. TinkerPop keeps the
 * FIRST occurrence, so the rank orders by the carried position where there is one and falls back to the
 * shape's own tie-break where there is not — which is the only order a positionless relation has
 * (`ORDER BY <orderSql>, p.id`). Ranking by id alone was right only while
 * nothing could mint a position: `g.V().order().by('name',desc).dedup().by('age')` then kept the
 * lowest-id member of each age instead of the first in the sorted stream — the same rows, a different
 * member, which the census's multiset digest DID see (it is a different set) but no assertion in the
 * ladder named. The tie-break is always the LAST term, so the rank is DETERMINISTIC rather than merely
 * ordered — the property `mise run test:perturbed` checks.
 *
 * **`bulk` RESETS to 1 — the reference's rule.** TinkerPop's `DedupGlobalStep.filter` calls
 * `traverser.setBulk(1L)` unconditionally — before it even looks at the `by()` — so a survivor stands
 * for itself whether or not a projection was given
 * (`vendor/tinkerpop/gremlin-core/.../DedupGlobalStep.java:75`). Carrying `p.bulk` through instead
 * would not be observably different: `analyzeChain`'s collapse-safety rule excludes a `dedup` that has
 * modulators, so `movementCollapse` never fires upstream of one and the multiplicity is provably 1
 * where it arrives. Checked, not assumed — `g.V().both().both().dedup().by('lang')` emits no
 * `GROUP BY`. So resetting is the form that stays correct if that safety rule is ever relaxed, at no
 * cost today.
 */
export function dedupOn(
  keys: readonly Expr[], domain: Rel, tie: readonly Expr[], fresh: Minter,
): Rel | null {
  // The PAYLOAD survives whole, which is what makes this form serve a traverser that is more than its
  // identity: only `bulk` is rewritten.
  const cols = [...payloadCols(domain), ...carriedCols(domain.channels)];
  const position = encounterOf(domain.channels);
  // PER-ORIGIN when an `origin` channel is live: a `dedup()` inside a per-parent body
  // (`local(__.out().dedup())`) is DISTINCT within each parent, not globally — so the parent is the
  // FIRST partition key. This is the fold-mode rule (a barrier consults the ambient `origin`): at the top
  // level there is no `origin`, so the dedup stays global exactly as before.
  const origin = originOf(domain.channels);
  const partitionBy = origin ? [col(domain.id, origin.col), ...keys] : keys;
  // A `Window` may only EXTEND its input (§3.5), so `rowNumberWindow` declares the INPUT's columns IN
  // THE INPUT'S ORDER plus the rank — NOT `cols`. The two differ for a property relation, whose join
  // declares the element side's channels BETWEEN the two payload halves; the projection below is where
  // the canonical payload-then-channels layout (`build.ts`) is restored.
  const ranked = rowNumberWindow(domain, 'rn', domain.channels, {
    partitionBy,
    orderBy: [...(position ? [{ expr: col(domain.id, position.col), dir: 'asc' as const }] : []),
      ...tie.map((expr) => ({ expr, dir: 'asc' as const }))],
  }, fresh);
  const survivors = make.filter({
    id: fresh('f'), input: ranked, channels: ranked.channels, type: ranked.type,
    pred: eq(col(ranked.id, 'rn'), compilerInt(1)),
  });
  return make.project({
    id: fresh('dk'), input: survivors, channels: domain.channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name,
      column.name === 'bulk' ? compilerInt(1) : col(survivors.id, column.name)] as const),
  });
}

/**
 * `dedup(k1, …, kn)[.by(proj)]` — a KEYED dedup on the tuple of ALREADY-BOUND alias values, TinkerPop's
 * `DedupGlobalStep` with `dedupLabels`: the survivor's key is the LIST of each label's `Pop.last` scope
 * value run through the shared `by()` projection (`DedupGlobalStep.filter`,
 * `vendor/tinkerpop/gremlin-core/.../DedupGlobalStep.java:80-88`). With no `by()`, an element alias keys
 * by rowid and a scalar alias by stored value; with a `by()`, each label's element is the host the
 * projection reads (`dedup('a','b').by(label)` keys on `(label(a), label(b))`). Every named label must
 * be LIVE, or TinkerPop drops the whole path (a null scope value fails the
 * `objects.size() == dedupLabels.size()` check) — modelled as a DECLINE, fail closed — and a
 * non-productive `by()` drops the row (`productivityFilter`, the same rule `dedup().by()` obeys). The
 * survivor keeps its WHOLE payload (a following `select('a')` reads a field the dropped duplicates
 * could differ on), so this is `dedupOn`'s ranked window — a fully deterministic tie over every column,
 * since a keyed dedup carries no emission order of its own.
 */
export function dedupByLabels(
  step: IRStep, rel: Rel, labels: AliasMap, keys: readonly string[],
  by: Modulation | undefined, ctx: ChainCtx, fresh: Minter,
): Rel | null {
  const seam = childSeam(ctx, fresh);
  const keyExprs: Expr[] = [];
  const productive: Expr[] = [];
  for (const k of keys) {
    const proj = aliasProjection(rel, labels, k, 'last', fresh);
    if (!proj) return null;
    const column = col(rel.id, proj.entry.col);
    if (by) {
      // A `by()` projection reads each label's ELEMENT as its host; a scalar/list alias under a `by()`
      // is a later phase.
      if (proj.read.kind !== 'element') return null;
      const host: ChildHost = { kind: 'element', id: aliasIdAt(column, 'last'), elem: proj.read.elem, row: { rel, aliases: labels } };
      const key = byExpr(by, host, ctx.source, fresh, false, seam);
      if (!key) return null;
      keyExprs.push(key);
      const prod = productivityFilter(step, key);
      if (prod) productive.push(prod);
    } else if (proj.read.kind === 'element') keyExprs.push(aliasIdAt(column, 'last'));
    else if (proj.read.kind === 'value') keyExprs.push(aliasValueAt(column, 'last'));
    // A LIST label keys on its canonical JSON (`json(v)`): `DedupGlobalStep` compares each label's
    // scope value with `java.util.List` content-equality (`DedupGlobalStep.java:80-88`), and SQLite's
    // canonical `json()` text of two identical arrays compares equal under `=`/GROUP BY — the faithful
    // lowering. A MAP label stays declined: `json()` object text is key-ORDER sensitive, but a Java
    // `LinkedHashMap` compares by ENTRY set regardless of order, so text equality is not faithful.
    else if (proj.read.kind === 'list') keyExprs.push(aliasListAt(column, 'last'));
    else return null; // a MAP-valued alias key — order-sensitive JSON text vs entry-equality, a later phase.
  }
  const domain = productive.length
    ? make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: productive.reduce((a, b) => and(a, b)) })
    : rel;
  return dedupOn(keyExprs, domain, domain.type.cols.map((c) => col(domain.id, c.name)), fresh);
}
