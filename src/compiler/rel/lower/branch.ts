import * as make from '../../../rel/factory.ts';
import { col, compilerInt, type Expr } from '../../../rel/expr.ts';
import { and, carriedCols, eq, meta, notProduced, payloadCols, renumber, typeOf, withMergedVtype, type Minter } from '../build.ts';
import { groupableChannels, mergeChannels, sameChannels, withChannel, type Channels } from '../../../channels.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { ColMeta } from '../../../rel/types.ts';
import { isStreamIdentity, type IRStep } from '../../ir/strategies.ts';
import { armBatches, isLocalScope } from '../../ir/step.ts';
import { alwaysProduces } from '../../ir/productivity.ts';
import { optionArms, type OptionArm } from '../../ir/option-map.ts';
import { meetScalarTypes, MERGED_VTYPE, PER_ROW, STATIC, UNKNOWN, type ScalarType } from '../../../sql/kernel/render.ts';
import { isNested, isPred, isTokenArg } from '../../../gremlin/frontend.ts';
import { ALWAYS_PRODUCTIVE } from '../child.ts';
import { CONSTANT, predicateExpr, SUBJECT_UNKNOWN, type SubjectType } from '../predicate.ts';
import type { FramedRel, RecordField, RelFraming } from '../framing.ts';
import type { GraphSource } from '../source.ts';
import type { AliasMap } from '../../alias.ts';
import { recordToMap } from '../record.ts';
import { variantArm, variantArmOf, variantHasList, type VariantArm } from '../variant.ts';
import { pathCarried } from '../path.ts';
import { BULK, ENCOUNTER, NO_ALIASES, bodyOf, encounterOf, inArmBody, type ChainCtx, type Tail } from './chain.ts';
import { bodyPredicate, branchSubject, childHostOf, childPredicate } from './filter.ts';
import { dedupOn, sliceOp } from './slice.ts';
import { childSeam, reductionArm, rootedRead, rootedSteps, selfCollapses } from './reduction.ts';
import { augmentParent, BORD_ARM, BORD_PARENT, branchResult, continueAs, countTail, dropEncounter, mintTraverserMajor, sliceableBranch, tagArm, tokenChoice, withoutEncounter } from '../lower.ts';

// BRANCH / MERGE — the arm-merging steps union/choose/coalesce/optional (branchArms dispatches),
// the arm builders (unionArms/mergeArms/chooseArms/coalesceMerge/optionalArms) and their variant/scalar
// meet helpers. Mutually recursive with the fold core (branchArms is called by the tails and calls
// continueAs back); the fan-out helpers it uses (withFanoutOrder/tagArm/…) stay in lower.ts.


/** The three steps that MERGE arms over the same input. One set and one dispatcher, so a tail gains all
 *  three at once — the asymmetry this replaces was `union` in the scalar fold and `union`+`choose` in the
 *  element one, with `coalesce` in neither. */
export const BRANCH_HOSTS: ReadonlySet<string> = new Set(['union', 'choose', 'coalesce', 'optional']);

/** Which arm-merging builder a step wants. Total over `BRANCH_HOSTS`, so a member added there without a
 *  builder is a compile error rather than a silent decline. */
export function branchArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  return step.name === 'union' ? unionArms(step, input, framing, bulked, ctx, fresh, labels)
    : step.name === 'choose' ? chooseArms(step, input, framing, bulked, ctx, fresh, labels)
      : step.name === 'coalesce' ? coalesceArms(step, input, framing, bulked, ctx, fresh, labels)
        : step.name === 'optional' ? optionalArms(step, input, framing, bulked, ctx, fresh, labels)
          : null;
}

/**
 * THE ARM-MAJOR MERGE — a `union`/`choose` whose EVERY arm holds a batched barrier (`armBatches`), so
 * `BranchStep.standardAlgorithm` runs each option over the WHOLE input and drains them in ARM ORDER
 * (`vendor/tinkerpop/gremlin-core/.../branch/BranchStep.java:143`). Each arm was already lowered by
 * `continueAs` as a GLOBAL reduction over the branch source (a `count`/`fold`/`sum` over the whole input,
 * not per-traverser), so the only work is to UNION them arm-major: tag each with its ordinal, merge, and
 * re-mint `encounter` over `[arm_idx, payload]` — the mirror of `mintTraverserMajor` with no parent key.
 *
 * The arms COLLAPSED (a barrier drops the per-row channels), so the merge base is the arms' OWN channels,
 * not the input's — which is exactly what made the per-row `mergeArms` refuse them (base `[bulk]` vs arm
 * `[]`). They must agree; a disagreement (e.g. one arm kept `bulk`, i.e. it did NOT actually collapse)
 * declines.
 */
export const mintArmMajor = (arms: readonly Tail[], base: Channels, labels: AliasMap, graph: GraphSource, fresh: Minter): FramedRel | null => {
  if (arms.some((arm) => !sameChannels(base, arm.rel.channels))) return null;
  const tagged = arms.map((arm, k) => ({ ...arm, rel: tagArm(arm.rel, k, fresh) }));
  const merged = mergeArms(tagged, withChannel(base, BORD_ARM), labels, graph, fresh);
  if (!merged) return null;
  const rel = merged.rel;
  if (!rel.channels.some((channel) => channel.col === BORD_ARM.col)) return null;
  const kept = rel.channels.filter((channel) => channel.col !== BORD_PARENT.col && channel.col !== BORD_ARM.col);
  const outChannels = withChannel(kept, ENCOUNTER);
  const payload = payloadCols(rel);
  const outCols = [...payload, ...carriedCols(outChannels)];
  const terms = [
    { expr: col(rel.id, BORD_ARM.col), dir: 'asc' as const },
    ...payload.map((column) => ({ expr: col(rel.id, column.name), dir: 'asc' as const })),
  ];
  return { ...merged, rel: renumber(rel, terms, outCols, outChannels, fresh) };
};

/**
 * A `union`/`choose` all of whose arms BATCH — the arm-major lowering, gated on the source being
 * non-empty. `mintArmMajor` unions the arms' global reductions in arm order; the EMPTY-INPUT GATE is the
 * reference's "an option no start was routed to emits nothing" (`element-branch-child.feature` —
 * `hasLabel('none').union(count, …)` is EMPTY, not `[0, …]`). `input` is the SHARED branch source (every
 * arm's subplan roots at it), so a second reference from an `Exists` makes `name` CTE it — no replication.
 */
export function batchedBranch(
  arms: readonly Tail[], input: Rel, graph: GraphSource, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  const merged = mintArmMajor(arms, arms[0]!.rel.channels, labels, graph, fresh);
  if (!merged) return null;
  const gated = make.filter({
    id: fresh('bg'), input: merged.rel, channels: merged.rel.channels, type: merged.rel.type,
    pred: { kind: 'exists', plan: input, negated: false },
  });
  // GUARANTEE the arm-major wire order with a real ORDER BY — the same mechanism `order()` uses. A
  // batched branch is often the WHOLE result (`union(count, out().count())` → an ordered `[6, 4]`), and a
  // top-level `ROW_NUMBER` window does not order the wire by itself; a downstream consumer (a `count`,
  // a `fold` collecting in encounter order) imposes its own, so the redundant sort is harmless there.
  const enc = encounterOf(gated.channels);
  const ordered = enc
    ? make.sort({ id: fresh('bs'), input: gated, channels: gated.channels, type: gated.type, terms: [{ expr: col(gated.id, enc.col), dir: 'asc' }] })
    : gated;
  return { ...merged, rel: ordered };
}

/** An arm whose body holds a COLLAPSING barrier (a reducer/count/fold — `selfCollapses`), so when a
 *  batching branch runs it over the whole input the arm is a global REDUCTION. Deliberately NARROWER
 *  than `armBatches` (any Barrier): a SLICE arm (`out().limit(1)`) batches too but does not collapse. */
export const isReductionArm = (body: readonly IRStep[]): boolean => body.some((step) => selfCollapses(step.name));

/** Add a `bulk = 1` channel so a COLLAPSED arm can UNION with a STREAMING one that carries its own — a
 *  batched arm is ONE traverser, so its multiplicity is 1. A no-op where a `bulk` channel already exists. */
export function ensureBulk(rel: Rel, fresh: Minter): Rel {
  if (rel.channels.some((channel) => channel.role === 'bulk')) return rel;
  const channels = withChannel(rel.channels, BULK[0]!);
  const payload = payloadCols(rel);
  return make.project({
    id: fresh('eb'), input: rel, channels, type: typeOf(...payload, ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      ...channels.map((channel) => [channel.col, channel.role === 'bulk' ? compilerInt(1) : col(rel.id, channel.col)] as const),
    ],
  });
}

/** Normalize a SCALAR arm — a batched `result`-marked reduction OR a streaming per-input arm — to a
 *  common `[v, vtype, bulk]` scalar, so a MIXED arm-major union can put a collapsed arm and a per-input
 *  arm in one stream. The vtype is the arm's own: a `number` reduction's `vt` column, a `count`'s
 *  `long`, a plain scalar's declared type (`withMergedVtype`). `null` for a non-scalar arm (a
 *  mixed-SHAPE branch is the variant arm-major, a later increment) or a `value`-marked one. */
export function toScalarArm(arm: Tail, fresh: Minter): Rel | null {
  if (arm.framing.kind !== 'scalar') return null;
  const result = arm.framing.result;
  const vtype: ScalarType | null =
    result === 'number' ? PER_ROW('vt')
      : result === 'count' ? STATIC('long')
        : result === undefined ? arm.framing.type
          : null;
  if (!vtype) return null;
  return ensureBulk(withMergedVtype(arm.rel, vtype, fresh), fresh);
}

/**
 * A `union` with SOME (not all) batched arms — a MIXED arm-major union: a collapsed reduction (`min`,
 * `count`, `fold` — one global row) beside a per-input arm (`constant`, `out()`), drained ARM-major.
 * Each arm is reconciled to a common CHANNEL set so the arm-major `Union` can carry it, then handed to
 * `batchedBranch` — the same mint + empty gate the all-batched case uses; the payload SHAPE differences
 * (`mergeArms`' scalar meet / variant merge) are the union's own.
 *
 * The reconciliation is per shape: a SCALAR arm normalizes to `[v, vtype, bulk]` (`toScalarArm` — which
 * also drops a `result` marker so a `count`/`number` reduction can meet a plain scalar OR join a
 * variant); an ELEMENT or LIST arm just gains `bulk = 1` if it collapsed (`ensureBulk`). So a same-shape
 * mix (`union(__.min(), __.constant(99))` → `[27,99,99,99,99]`) meets as scalars and a cross-shape one
 * (`union(__.count(), __.out())`, `union(__.fold(), __.out())`) becomes a VARIANT stream. A map/record/
 * path/property arm, or an arm carrying an alias the collapsed arm cannot (`union(min.as('x'),
 * …).select('x')`, the `mintArmMajor` channel check), declines.
 */
export function mixedBranch(arms: readonly Tail[], input: Rel, graph: GraphSource, fresh: Minter, labels: AliasMap): FramedRel | null {
  const normalized: Tail[] = [];
  for (const arm of arms) {
    const fr = arm.framing;
    if (fr.kind === 'scalar') {
      const rel = toScalarArm(arm, fresh);
      if (!rel) return null;
      normalized.push({ ...arm, rel, framing: { kind: 'scalar', type: PER_ROW(MERGED_VTYPE) } });
      continue;
    }
    // An ELEMENT or LIST arm joins the variant unchanged but for a `bulk = 1` if it collapsed;
    // `variantPayload` frames a list-of-elements member by the same `listPayloadExpr` expansion the
    // non-variant list uses. A map/record/path/property arm declines (no variant `vk`).
    if (fr.kind !== 'elements' && fr.kind !== 'list') return null;
    normalized.push({ ...arm, rel: ensureBulk(arm.rel, fresh) });
  }
  return batchedBranch(normalized, input, graph, fresh, labels);
}

export function unionArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  // A `union` is a fresh UNORDERED stream (`BranchStep` drains arm-by-arm and every scenario of
  // `Union.feature` asserts unordered), so a position the input carried OR an arm minted inside itself
  // does NOT survive the merge — dropping it is what lets an ordered/limited arm merge rather than
  // decline on a channel its sibling has not got. Where a downstream positional/collecting consumer
  // READS the fan-out's emission order (`ctx.ordered`, the chain-global demand), the merge MINTS one
  // deterministic order over the whole fan-out after the fact (`withFanoutOrder`, §10) rather than
  // declining — the positionless rows are the same either way.
  const args = step.args.map((a) => a.value);
  if (args.length < 1 || args.some((arg) => !isNested(arg))) return null;
  const bodies = args.map((arg) => bodyOf((arg as { readonly nested: unknown }).nested, ctx.params));
  if (bodies.some((body) => !body?.length)) return null;

  // A SINGLE-ARM `union(t)` IS `t`: `UnionStep extends BranchStep` with `Pick.any`, so the one branch
  // receives every traverser and its output is the whole result (`gremlin-core/.../branch/UnionStep`).
  // No merge, and — for a non-reduction arm — no arm-major empty gate: the arm emits per input, so an
  // empty input is an empty output. A single REDUCTION arm (`union(__.count())`) DOES need the batched
  // path's `Exists(input)` gate (an empty input emits nothing, not the seed), and an arm that binds a
  // label or a SLICE-demanded one carry merge questions the multi-arm path owns — all three decline here.
  if (args.length === 1) {
    if (isReductionArm(bodies[0]!) || sliceableBranch(ctx, input)) return null;
    const only = continueAs(input, framing, bodies[0]!, 0, bulked, inArmBody(ctx), fresh, labels);
    if (!only || only.aliases.size !== labels.size) return null;
    return branchResult({ rel: dropEncounter(only.rel, fresh), framing: only.framing }, ctx, fresh);
  }

  const slice = sliceableBranch(ctx, input);
  // A `union` is a `BranchStep`: barrier-free it is TRAVERSER-major (`applyCurrentTraverser` injects
  // one start), but an arm holding a BATCHED barrier sets `hasBarrier` and makes it ARM-major over the
  // whole input (`BranchStep.java:120-152`). The arm-major lowering — the batched arm running over the
  // whole input — is not built, so a SLICE-demanded union with a batched arm declines rather than
  // present a traverser-major subset the reference does not. (`armBatches`, `ir/step.ts`.)
  if (slice && bodies.some((body) => armBatches(body!))) return null;
  const source = slice ? augmentParent(input, fresh) : input;
  const arms: Tail[] = [];
  for (const body of bodies) {
    const arm = continueAs(source, framing, body!, 0, bulked, inArmBody(ctx), fresh, labels);
    if (!arm) return null;
    arms.push(slice ? arm : { ...arm, rel: dropEncounter(arm.rel, fresh) });
  }
  // A REDUCTION arm holds a COLLAPSING barrier (a reducer/count/fold — `selfCollapses`), so when the
  // branch batches it, the arm is a global reduction over the whole input. This is NARROWER than
  // `armBatches` (any Barrier): a SLICE arm (`out().limit(1)`) batches too but does NOT collapse, so it
  // stays the ordinary merge rather than an arm-major reduction (else `union(out().limit(1), in())`
  // would wrongly decline). Only reachable when `!slice` (a batched arm under a downstream slice already
  // declined above).
  if (!slice && bodies.every((body) => isReductionArm(body!))) return batchedBranch(arms, input, ctx.source, fresh, labels);
  // SOME (not all) reduce → a MIXED arm-major union of a collapsed arm and a per-input one (`mixedBranch`).
  if (!slice && bodies.some((body) => isReductionArm(body!))) return mixedBranch(arms, input, ctx.source, fresh, labels);
  return slice
    ? mintTraverserMajor(arms, source, labels, ctx.source, fresh)
    : branchResult(mergeArms(arms, withoutEncounter(input.channels), labels, ctx.source, fresh), ctx, fresh);
}

/**
 * THE MERGE ITSELF — n arms into one `Union`, with every agreement the algebra needs asserted.
 *
 * Split from `unionArms` because `choose()` produces its arms differently (each is guarded by the
 * condition or its negation) and merges them identically. The arm-shape rules are the merge's, not
 * `union`'s, so there is one place they are stated.
 */
/**
 * TWO SCALAR ARMS WHOSE TYPES DIFFER MEET AT A PER-ROW ONE — §6·7's lattice, at the arm merge.
 *
 * `sameFraming` compares the whole `ScalarType`, so `union(__.values('name'), __.constant(1))` used
 * to DECLINE for no reason but a tag disagreement: both arms are one value per row, the relation
 * merges perfectly, and the only thing missing was somewhere to record that the two halves are
 * typed differently. That somewhere is a COLUMN — the same `vtype` a stored-property read already
 * carries — and the whole cost is one projection per arm.
 *
 * The lattice, and one deliberate refinement of the plan's version. `static ∧ static(same)` stays
 * static, because agreement costs no column. `static ∧ static(differ)` goes per-row, each side
 * projecting its tag as a literal. `perRow ∧ anything` goes per-row. The plan says
 * `unknown ∧ x → unknown`; here an UNKNOWN arm instead contributes a NULL tag to the per-row column,
 * which is not a different answer — a null `vtype` IS "infer this member from its value", which is
 * exactly what `unknown` means — and it is strictly more capable, because it lets an arm that CAN
 * say keep its tag instead of the whole merge losing it to the one that cannot. Collapsing to
 * `unknown` would discard a `datetime` because its sibling was untagged, which is the discard §6·7
 * exists to end.
 *
 * `null` where the meet is not this module's to take: an arm carrying a `result` marker
 * (`count`/`number`) reads its type off a `vt` column the reducer computed, so padding it with a
 * second type column would leave two disagreeing authorities on one row.
 */
/**
 * THE SHAPE-AGNOSTIC TAIL OVER A VARIANT STREAM — a mixed-shape branch merge (`union`/`choose`/
 * `coalesce` whose arms disagree on shape) composes with the steps that read only the carried channels,
 * never the payload. A SLICE (`sliceOp` — `limit`/`range`/`skip`) reads the fan-out `encounter` the branch
 * minted (`mintTraverserMajor`/`withFanoutOrder`) and KEEPS the variant; `count()` is `countTail`
 * (`SUM(bulk)`), the same barrier every other tail uses.
 *
 * Anything that reads the payload DECLINES rather than mis-executing: a variant has NO uniform member
 * shape, so `unfold()`, a member transform, and a value `dedup` (an identity that is per-shape) are the
 * variant-MEMBER vocabulary, a later increment — the map/property tails' reasoning exactly.
 */
export function variantTail(
  rel: Rel, framing: RelFraming, steps: readonly IRStep[], from: number, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | null {
  let cur = rel;
  for (let at = from; at < steps.length; at++) {
    const step = steps[at]!;
    const sliced = sliceOp(step, cur, bulked, fresh);
    if (sliced) { cur = sliced; continue; }
    if (step.name === 'count' && !step.args.length && !isLocalScope(step)) {
      const counted = countTail(cur, fresh);
      return continueAs(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }
    // A BARE `dedup()` over a variant is a whole-PAYLOAD `Distinct` — the tuple `(vk, v, rid, list)` IS
    // the identity across every arm: a same-kind element by `(vk, rid)`, a scalar by `(vk, v)`, and two
    // arms of different shape never collide because `vk` differs (`ElementHelper` hashes by id+class; a
    // scalar by value). `dedupOn` keeps the first occurrence (`MIN(encounter)`) and resets `bulk`; it
    // declines through `groupableChannels` where an alias/path sits in the row, exactly as the row-shape
    // dedup does — a grouping may carry only the roles `CHANNEL_GROUP_POLICY` gives an N→1 answer.
    if (step.name === 'dedup' && !step.args.length && !isLocalScope(step) && !step.modulators?.length) {
      if (pathCarried(cur) || !groupableChannels(cur.channels)) return null;
      const deduped = dedupOn(payloadCols(cur).map((column) => col(cur.id, column.name)), cur, [], fresh);
      if (!deduped) return null;
      cur = deduped;
      continue;
    }
    return null;
  }
  return { rel: cur, framing, aliases: labels, bulked: false };
}

export function meetScalarArms(arms: readonly Tail[]): ScalarType | null {
  const types: ScalarType[] = [];
  for (const arm of arms) {
    if (arm.framing.kind !== 'scalar') return null;
    // A `result:'count'` arm carries a proper `STATIC('long')` type and NO `vt` column, so it meets like
    // any typed scalar — which is what lets `coalesce(__.out().count(), __.constant(0))` merge (count→long,
    // constant→int, a per-row tagged scalar). `result:'number'`/`'value'` are refused: their type rides on
    // a `vt` column the meet's own `vtype` column would then contradict — the two-authorities trap.
    if (arm.framing.result !== undefined && arm.framing.result !== 'count') return null;
    types.push(arm.framing.type);
  }
  // The MEET itself is `render.ts`'s — the same question a named collection asks of its sites. What
  // stays here is the framing-level decline above it, which is about `Tail`s and not about types.
  return meetScalarTypes(types);
}

/**
 * `g.union(a, b, …)` — a SOURCE union, or `null` to decline.
 *
 * Each argument is a whole traversal, so each one re-enters `lowerChain` through the seam's rooted
 * answer and the merge is the ordinary one. Three declines, each its own reason:
 *
 * - **fewer than two arms.** `union(t)` IS `t` — not a merge at all — and `union()` is the empty
 *   relation, which `Values` cannot express (§3.3). Both decline.
 * - **an arm with EFFECTS.** `union(__.addV(…), __.addV(…))` is plan composition (§3.0) and the
 *   arms' statements would have to be hoisted to bindings and ordered before the read that merges
 *   them. Expressible, unbuilt, and a write question rather than a branch one.
 * - anything `mergeArms` refuses — a shape disagreement, a label bound in one arm, an arm-local
 *   `order()` minting a second emission order.
 */
export function sourceUnion(
  step: IRStep, ctx: ChainCtx, fresh: Minter,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args.map((a) => a.value);
  if (args.length < 1 || args.some((arg) => !isNested(arg))) return null;
  const arms: Tail[] = [];
  for (const arg of args) {
    const body = rootedSteps((arg as { readonly nested: unknown }).nested, ctx.params, ctx.sideEffects);
    if (!body?.length) return null;
    const read = rootedRead(body, ctx, fresh);
    if (!read || read.effects?.length) return null;
    arms.push({ rel: read.rel, framing: read.framing, aliases: NO_ALIASES, bulked: ctx.collapse });
  }
  // `g.union(t)` IS `g.t` — the one branch is rooted and its rows are the whole answer, no merge (and a
  // `Union` needs two inputs anyway). Unlike a chain-position single arm there is no empty-input gate to
  // owe: a source union's arms each root their own read, which carries its own reducer semantics.
  if (arms.length === 1) return { rel: arms[0]!.rel, framing: arms[0]!.framing };
  return mergeArms(arms, arms[0]!.rel.channels, NO_ALIASES, ctx.source, fresh);
}

/**
 * ARMS OF DIFFERENT SHAPES, merged as a per-row tagged union — or `null` to decline.
 *
 * `mergeArms`' fallback, and structurally its twin: the scalar meet widens the schema by one column
 * so two tag-disagreeing arms become comparable, and this widens it by three so two SHAPE-disagreeing
 * arms do. Both then hand the arms to the same `Union`. Neither invents a node, and that is the test
 * §7 sets — the seam could already EXPRESS this; it had not been taught to.
 *
 * The declines are the arms' own: a shape with no `vk` (a map, a record, a path, a property, a
 * discard), a reducer-marked scalar (its type rides on a `vt` column the payload has no slot for),
 * and a SET, whose wire form differs from a list's while sharing its member substrate.
 *
 * The channel and label tests are NOT repeated here — the caller runs them for both routes, because
 * an arm that binds a label or mints its own order is refused for reasons that have nothing to do
 * with shape.
 */
export function variantMerge(
  arms: readonly Tail[], base: Channels, labels: AliasMap, fresh: Minter,
): FramedRel | null {
  const shapes: VariantArm[] = [];
  for (const arm of arms) {
    const shape = variantArmOf(arm.framing);
    if (!shape) return null;
    shapes.push(shape);
  }
  if (arms.some((arm) => arm.aliases.size !== labels.size)) return null;
  if (arms.some((arm) => !sameChannels(base, arm.rel.channels))) return null;
  const hasList = variantHasList(shapes);
  const tagged = arms.map((arm, at) => variantArm(arm.rel, shapes[at]!, hasList, fresh));
  const channels = mergeChannels(base, tagged.map((rel) => rel.channels), { rigid: 'peer' });
  return {
    rel: make.union({ id: fresh('vu'), inputs: tagged, all: true, channels, type: tagged[0]!.type }),
    // The DECLARED vocabulary is de-duplicated by shape, never by position: two arms of the same
    // shape share one tag, so the framer's arm list stays a description of what a row can BE.
    framing: { kind: 'variant', arms: dedupeArms(shapes) },
  };
}

/** The declared arms, one per distinct SHAPE. Two `{kind:'scalar'}` arms whose types differ collapse
 *  to one here and the payload then frames `UNKNOWN` — the wire carries a single static tag per
 *  variant, which is the one place its vocabulary is short of the algebra's (§6·7's extension point). */
export const dedupeArms = (arms: readonly VariantArm[]): readonly VariantArm[] => {
  const seen = new Map<string, VariantArm>();
  for (const arm of arms) {
    const key = arm.kind === 'elements' ? `e:${arm.elem}` : arm.kind;
    if (!seen.has(key)) seen.set(key, arm);
  }
  return [...seen.values()];
};

export function mergeArms(
  arms: readonly Tail[], base: Channels, labels: AliasMap, source: GraphSource, fresh: Minter,
): FramedRel | null {
  let [first, ...rest] = arms as [Tail, ...Tail[]];
  // SCALAR ARMS MEET BEFORE THEY ARE COMPARED, because a tag disagreement is not a shape
  // disagreement — see `meetScalarArms`. The re-projection is what makes the arms comparable at all,
  // so it has to happen before both the framing and the column tests below.
  if (first.framing.kind === 'scalar') {
    const met = meetScalarArms(arms);
    if (met && met.kind === 'perRow') {
      const framing = { kind: 'scalar', type: met } as const;
      // `meetScalarArms` returned non-null, so EVERY arm is a scalar without a `result` marker.
      const retyped = arms.map((arm) => ({
        ...arm, framing,
        rel: withMergedVtype(arm.rel, arm.framing.kind === 'scalar' ? arm.framing.type : UNKNOWN, fresh),
      }));
      [first, ...rest] = retyped as [Tail, ...Tail[]];
      arms = retyped;
    }
  }
  // RECORD ARMS THAT DISAGREE DEMOTE TO MAP VALUES — the third rung of the same ladder the two moves
  // above climb (a tag disagreement widens by one column, a shape disagreement by three), and the one
  // that needs no widening at all: a record's fields collapse into the single `map` column the map
  // vocabulary already reads, so the divergence moves INSIDE the value and the arms' row types agree
  // trivially. See `mapDemotedArms`.
  const demoted = mapDemotedArms(arms, source, fresh);
  if (demoted) [first, ...rest] = (arms = demoted) as unknown as [Tail, ...Tail[]];
  // ARMS THAT DISAGREE ON SHAPE MERGE TO A VARIANT — a per-row tagged union, and the same move the
  // scalar meet above makes one level down: re-project the arms onto a shared payload, then let the
  // ordinary `Union` merge them. It is tried only AFTER the meet, so two scalar arms never reach it.
  if (rest.some((arm) => !sameFraming(first.framing, arm.framing)))
    return variantMerge(arms, base, labels, fresh);
  // …and on their declared COLUMNS, name for name, because a Union is positional.
  if (rest.some((arm) => !sameColumns(first.rel.type.cols, arm.rel.type.cols))) return null;
  // An arm that bound a label would have to be remapped onto a canonical column (see above).
  if (arms.some((arm) => arm.aliases.size !== labels.size)) return null;
  // ARMS THAT DISAGREE ON RIGID STATE DECLINE, and this is the check the channel core would otherwise
  // make by THROWING — which is right inside the core and wrong here, where the contract is `null`.
  // The comparison is arm-TO-ARM, not arm-to-`base`: a channel EVERY arm mints uniformly (the `fromV`
  // an edge hop retains under an outer `otherV()`) is consistent — each row is a distinct traverser, so
  // a `UNION ALL` keeps its own value — and the merge carries it. What still declines is a PARTIAL mint:
  // an arm-local `order()` numbers one arm's emission from 1 while its sibling has no such column, so
  // the merged stream would have two positions claiming to be one (`rel-sweep`,
  // `union(out(…).order().by(k).limit(2), …)`). The merge base becomes the arms' common set, so an added
  // rigid channel rides out; for arms that agree with `base` (every case before `otherV`) it is `base`.
  const merged = arms[0]!.rel.channels;
  if (arms.some((arm) => !sameChannels(merged, arm.rel.channels))) return null;

  // The merged list, from the core rather than assembled here. Rooted at the arms' common channels so a
  // uniformly-minted rigid channel is emitted; when the arms agree with `base` this is `base` exactly.
  // It earns its keep for the FORKABLE alias role too — a label bound in one arm is what `union` merge
  // policy exists for.
  const channels = mergeChannels(merged, arms.map((arm) => arm.rel.channels), { rigid: 'peer' });
  return {
    rel: make.union({
      id: fresh('un'), inputs: arms.map((arm) => arm.rel), all: true,
      channels, type: first.rel.type,
    }),
    framing: first.framing,
  };
}

/**
 * `choose(<condition>, <then>[, <else>])` — a branch whose arms are GUARDED rather than unconditional.
 *
 * TinkerPop's `ChooseStep`: exactly one arm fires per traverser, decided by whether the condition
 * traversal produces output. So it is the SAME merge as `union` over arms filtered by the condition and
 * its negation — which is why this is twenty lines rather than a second branch implementation, and why
 * it inherits every one of the merge's agreement rules for free.
 *
 * **An absent `else` arm is `identity`, not "drop the traverser"** — `choose(pred, then)` passes a
 * non-matching traverser through unchanged. An empty body expresses that exactly: `continueAs` over
 * zero steps returns the relation it was handed, so the false arm is the filtered input and no special
 * case is needed for the two-argument form.
 *
 * The OPTION form (`choose(<key>).option(v, arm)…`) is a different question — a CASE over a projected
 * key rather than a boolean — and declines here; it is the family's next arm.
 */
/**
 * `choose(<key>).option(k, body)…` — the OPTION-MAP form, or `null` to decline.
 *
 * A different question from the boolean `choose`: an N-way lookup on a projected CHOICE rather than a
 * predicate, so the arms are gated by a comparison against each key rather than by a condition and its
 * negation. Everything after the gating is shared — each arm is the ordinary fold over its gated
 * input, and `mergeArms` merges them, including as a VARIANT where their shapes differ, which is what
 * makes the common `option(Pick.none, __.identity())` shape expressible at all.
 *
 * TWO ARMS ARE IMPLICIT and neither is written down (`optionArms`' note): a map with no `Pick.none`
 * emits the TRAVERSER for an unmatched input, and a `__.discard()` body contributes no arm at all.
 * The pass-through is `ChooseStep`'s own default — its private constructor installs identity
 * traversals for both `Pick` tokens — so it is the reference's rule rather than an inference.
 *
 * PRODUCTIVITY IS CARRIED, NOT GUESSED, and this is the piece the form was waiting on. `Pick.none`
 * claims a productive choice that matched no key and `Pick.unproductive` claims one that produced
 * nothing; `TraversalProduct` calls a productive null a value, so `choice IS NULL` answers a different
 * question. `ChildValue.present` is the signal, and a choice whose body cannot report it DECLINES
 * rather than conflating the two — which is why this reads `present` and never tests the value.
 */
export function chooseOptions(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length) return null;
  const subject = branchSubject(input, framing);
  if (!subject) return null;
  const seam = childSeam(ctx, fresh);
  const arms = optionArms(step, (nested) => seam.body(nested, 'child'));
  if (!arms) return null;
  const choiceArg = step.args?.[0]?.value;
  const host = childHostOf(subject, labels);
  // A `T` TOKEN CHOICE — `choose(T.label).option('person', …)`. It needs no child body at all: the token
  // is one projection off the host, which is `byExpr`'s own vocabulary, and a `T` token is ALWAYS present
  // (`orderProductivity` says the same thing for the same reason), so the `Pick.unproductive` arm is
  // provably dead and `canBeUnproductive` below reads that off the claim rather than being told.
  const produced = isTokenArg(choiceArg)
    ? tokenChoice(choiceArg.token, subject, ctx.source, fresh)
    : isNested(choiceArg)
      ? ((body) => (body?.length ? seam.scalar(body, host) : null))(seam.body(choiceArg.nested, 'child'))
      : null;
  // A choice that cannot report its own productivity cannot serve the two `Pick` arms, and cannot be
  // told apart from a productive NULL — decline rather than answer one of them for the other.
  if (!produced || !produced.present) return null;

  // THE CHOICE IS PROJECTED TO COLUMNS FIRST, and this is a plan-quality requirement rather than a
  // tidiness one — `groupBarrier` records the same rule for the same reason. The choice is a
  // CORRELATED SUBQUERY and every arm's gate mentions it: arm k tests its own key, negates every
  // earlier one, and the implicit pass-through negates them all. Inlined, that is O(n²) copies of the
  // subquery — measured at 1.5 KB of statement text before this projection and 18.7 KB after the
  // gating landed, for a three-option map. Naming it once makes every later reference a COLUMN.
  //
  // FENCED for the same reason the group key is: the emitter merges a plain `Project` back into the
  // block that reads it, so the naming would buy nothing without the boundary.
  const ARM = 'oarm';
  const CHOICE = 'ochoice';
  const PRESENT = 'opresent';
  const vtypeCol = produced.vtype ? [meta('ovtype', 'text', true)] : [];
  const projected = make.project({
    id: fresh('oc'), input, channels: input.channels,
    type: typeOf(...input.type.cols, meta(CHOICE, 'any', true), meta(PRESENT, 'int', true), ...vtypeCol),
    exprs: [
      ...input.type.cols.map((column) => [column.name, col(input.id, column.name)] as const),
      [CHOICE, produced.expr], [PRESENT, produced.present],
      ...(produced.vtype ? [['ovtype', produced.vtype] as const] : []),
    ],
  });
  const scoped = make.materialize({ id: fresh('om'), input: projected, channels: projected.channels, type: projected.type });
  const choice = { expr: col(scoped.id, CHOICE), present: col(scoped.id, PRESENT), vtype: produced.vtype && col(scoped.id, 'ovtype') };
  // THE CHOICE's own type, not the traverser's: the option KEYS are compared against the projected
  // choice, so this is the `SubjectType` of that column and is unrelated to `subject` above.
  const choiceType: SubjectType = choice.vtype ? { kind: 'perRow', vtype: choice.vtype }
    : produced.framing.kind === 'scalar' && produced.framing.type.kind === 'static'
      ? { kind: 'static', type: produced.framing.type.type, text: produced.framing.type.text }
      : SUBJECT_UNKNOWN;

  // WHICH ARM A ROW TAKES IS ONE COLUMN, computed once — not a predicate per arm.
  //
  // The naive gating is O(n²) in the EXPENSIVE term: arm k tests its own key, negates every earlier
  // key, and the implicit pass-through negates them all — and a key test is a vtype-aware ordering
  // compare, which is the big expression in the plan (`predicateExpr`, the same one `is(P.gt(…))`
  // spends). Measured on a three-option map: 18.7 KB of statement text with the choice inlined, 7.5 KB
  // with the choice projected but the tests still repeated, 1.9 KB with the tests projected too. Same
  // rule as the group key, one level up — name the expensive thing once and let every later reference
  // be a column.
  //
  // The ordinal also carries FIRST-MATCH-WINS for free, because a `CASE` takes its first true `WHEN`:
  // `BranchStep.pickBranches` collects every matching option and `ChooseStep` overrides it with
  // `branches.subList(0, 1)` (`gremlin-core/.../branch/ChooseStep.java:139-142`), which is exactly a
  // `CASE`'s own rule. Reading only the super-method makes overlapping keys look like a fan-out, and
  // this emitted six rows where `Choose.feature:244-256` pins four until the override was read.
  const NONE = -1;
  const UNPRODUCTIVE = -2;
  const keyed = arms.filter((arm) => arm.pick === 'key');
  /**
   * CAN THIS CHOICE BE UNPRODUCTIVE AT ALL — read off the seam's own claim, not assumed.
   *
   * `Pick.unproductive` is the choice producing NOTHING and `Pick.none` a value no option claims;
   * TinkerPop routes them differently, which is why the presence signal exists. But a choice that
   * ALWAYS produces — `count()` seeds 0 — can never reach the first, so its `WHEN` is dead and, more
   * importantly, the implicit PASS-THROUGH for an unclaimed `Pick.unproductive` is an arm that cannot
   * fire. Emitting it anyway declares a shape the traversal never has: `choose(__.out().count())
   * .option(1, __.values('name')).option(Pick.none, __.discard())` became a VARIANT of scalar and
   * element where the reference gives a plain value stream. Right arity, wrong shape.
   */
  const canBeUnproductive = produced.present !== ALWAYS_PRODUCTIVE;
  const whens: (readonly [Expr, Expr])[] = canBeUnproductive
    ? [[{ kind: 'unary', op: 'not', arg: choice.present }, compilerInt(UNPRODUCTIVE)]]
    : [];
  for (const [at, arm] of keyed.entries()) {
    const pred = predicateExpr(choice.expr, arm.key, choiceType, null, null, fresh);
    if (!pred) return null;
    whens.push([pred, compilerInt(at)]);
  }
  const armOf = make.project({
    id: fresh('oa'), input: scoped, channels: scoped.channels,
    type: typeOf(...scoped.type.cols, meta(ARM, 'int')),
    exprs: [...scoped.type.cols.map((column) => [column.name, col(scoped.id, column.name)] as const),
      [ARM, { kind: 'case', whens, else: compilerInt(NONE) }]],
  });
  const takes = (ordinal: number): Expr => eq(col(armOf.id, ARM), compilerInt(ordinal));

  // The ordinal each written arm claims. A `Pick` arm claims its sentinel; a keyed arm claims its
  // position, which is the order `whens` above assigned.
  const claimed: number[] = [];
  const gated: { readonly arm: OptionArm; readonly ordinal: number }[] = [];
  let next = 0;
  for (const arm of arms) {
    const ordinal = arm.pick === 'unproductive' ? UNPRODUCTIVE : arm.pick === 'none' ? NONE : next++;
    claimed.push(ordinal);
    if (!arm.discard) gated.push({ arm, ordinal });
  }
  // AN ARM RUNS OVER THE INPUT'S OWN COLUMNS, not the widened ones. The choice columns exist to be
  // TESTED and nothing downstream may see them: an arm body is the ordinary fold, and a `values()`
  // after one joins the property table against a relation whose declared width it computes from the
  // CHANNELS. Leaving the extra payload columns on it made that join declare six and emit nine — a
  // factory throw, i.e. a compile error where the traversal must answer. So the gate filters on the wide relation
  // and projects straight back to the narrow one, and the widening never escapes this step.
  const gate = (pred: Expr): Rel => {
    const kept = make.filter({ id: fresh('og'), input: armOf, channels: armOf.channels, type: armOf.type, pred });
    // Addressed through `kept`, not `armOf`: a node addresses its own INPUT, and `armOf` is the
    // GRANDchild here. Naming it is the "no relation in scope" the checker catches — and it caught it.
    return make.project({
      id: fresh('on'), input: kept, channels: input.channels, type: input.type,
      exprs: input.type.cols.map((column) => [column.name, col(kept.id, column.name)] as const),
    });
  };

  const built: Tail[] = [];
  for (const { arm, ordinal } of gated) {
    const body = seam.body(arm.nested, 'child');
    if (!body?.length) return null;
    const lowered = continueAs(gate(takes(ordinal)), framing, body, 0, bulked, inArmBody(ctx), fresh, labels);
    if (!lowered) return null;
    built.push(lowered);
  }
  // THE IMPLICIT PASS-THROUGH is every ordinal no written arm claimed — which is at most the two
  // sentinels, since every keyed ordinal is claimed by construction. Deriving it from the claims
  // rather than from which tokens were written is what keeps it right when both are, and what makes a
  // `discard` arm's rows disappear rather than fall through: its ordinal IS claimed.
  const unclaimed = [NONE, ...(canBeUnproductive ? [UNPRODUCTIVE] : [])]
    .filter((ordinal) => !claimed.includes(ordinal));
  if (unclaimed.length) {
    built.push({
      rel: gate(unclaimed.map(takes).reduce((left, right) => ({ kind: 'binary', op: 'or', left, right }))),
      framing,
      aliases: labels,
      // The pass-through arm IS the branch's input, unchanged, so it stands for exactly what the input
      // did — nothing here collapses and nothing resets a multiplicity.
      bulked,
    });
  }
  if (built.length < 2) return null;
  return mergeArms(built, input.channels, labels, ctx.source, fresh);
}

/**
 * `coalesce(a1, …, an)` — UNION with PRIORITY, and expressible as one because "priority" is a per-input
 * PREDICATE the child seam already builds.
 *
 * `CoalesceStep.flatMap` walks its arms in order and returns the FIRST whose `hasNext()` is true, with
 * all of that arm's results. So arm k contributes exactly the input rows for which arms 1…k−1 produced
 * NOTHING — which is `childPredicate(body, subject, …, negated)` per earlier arm, conjoined, applied to
 * arm k's INPUT rather than to its output. Filtering the input rather than the arm is what makes it a
 * composition instead of new machinery: each arm is then the ordinary fold over its own gated input and
 * `mergeArms` merges them, variant shapes included, exactly as `union` and `choose` already do.
 *
 * ⚠️ The guards go on the INPUT because that is where the row is: an arm's output has been reprojected
 * to the arm's shape, so the incoming id a correlated `NOT EXISTS` needs is no longer there to name.
 *
 * Cost is n(n−1)/2 correlated existence subqueries, which is the shape of the question and not an
 * artifact — "did the earlier arm produce anything" has to be asked once per earlier arm.
 */
export function coalesceArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args.map((a) => a.value);
  if (args.length < 2 || args.some((arg) => !isNested(arg))) return null;
  const bodies = args.map((arg) => bodyOf((arg as { readonly nested: unknown }).nested, ctx.params));
  if (bodies.some((body) => !body?.length)) return null;
  return coalesceMerge(bodies as readonly (readonly IRStep[])[], input, framing, bulked, ctx, fresh, labels);
}

/**
 * `optional(t)` ≡ `coalesce(t, __.identity())` — `OptionalStep` emits t's results where t produces and
 * the ORIGINAL traverser otherwise (`vendor/tinkerpop/gremlin-core/.../branch/OptionalStep.java`), which
 * is the coalesce priority over two arms: the body, then an EMPTY-body fallback that `continueAs` lowers
 * as the input unchanged. `OptionalStep extends AbstractStep` takes one start at a time, so it inherits
 * the same per-traverser reduction arm and traverser-major slice key `coalesce` uses.
 */
export function optionalArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  const nested = step.args[0]?.value, extra = step.args[1]?.value;
  if (extra !== undefined || !isNested(nested)) return null;
  const body = bodyOf(nested.nested, ctx.params);
  if (!body?.length) return null;
  return coalesceMerge([body, []], input, framing, bulked, ctx, fresh, labels);
}

/**
 * THE COALESCE MERGE over explicit arm bodies — shared by `coalesce` and `optional` (its identity
 * fallback is the one empty body this admits). `coalesce`/`optional` are `FlatMapStep`-family, so they
 * reset PER TRAVERSER and are always traverser-major, arm-minor — never batched. Under a SLICE demand
 * (`ctx.sliced`) that fixes the subset a downstream `limit`/`tail` takes (`branch-traverser-major.feature`),
 * so the arms lower from `augmentParent(input)` — freezing the parent position as the major sort key — and
 * merge through `mintTraverserMajor`. A COLLECT demand takes any deterministic order (`withFanoutOrder`); a
 * positionless one drops the order (`dropEncounter`). See `unionArms`.
 */
export function coalesceMerge(
  bodies: readonly (readonly IRStep[])[], input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  const slice = sliceableBranch(ctx, input);
  const source = slice ? augmentParent(input, fresh) : input;
  const subject = branchSubject(source, framing);
  if (!subject) return null;

  const arms: Tail[] = [];
  let exhausted: Expr | undefined;
  for (const [at, body] of bodies.entries()) {
    const domain = exhausted
      ? make.filter({ id: fresh('coa'), input: source, channels: source.channels, type: source.type, pred: exhausted })
      : source;
    // A per-traverser REDUCTION arm (`__.out().count()`, `__.values(k).fold()`) is CORRECT for `coalesce`
    // (a `FlatMapStep`, per-traverser) — routed through the child seam, one row per host carrying every
    // channel; a movement/transform arm returns null and stays the ordinary `continueAs`. See `reductionArm`.
    const arm = reductionArm(domain, framing, body!, ctx, fresh, labels, bulked)
      ?? continueAs(domain, framing, body!, 0, bulked, inArmBody(ctx), fresh, labels);
    if (!arm) return null;
    // The slice path keeps each arm's within-arm order for `mintTraverserMajor` to consume; every
    // other path drops it, as a fresh unordered stream carries none.
    arms.push(slice ? arm : { ...arm, rel: dropEncounter(arm.rel, fresh) });
    // The LAST arm owes no guard for anyone, so it is not asked for one — a body whose non-production
    // this route cannot express still coalesces when it is last, which is the common `constant(x)`
    // fallback.
    if (at === bodies.length - 1) continue;
    // A BODY THAT ALWAYS PRODUCES exhausts the coalesce, and saying so is not an optimization: the
    // common `coalesce(__.values('name'), __.constant('x'))` shape has a `constant()` FALLBACK, and a
    // `constant()` in a non-final position means no later arm can ever fire. `childPredicate` cannot
    // answer "this body produces nothing" for a body that ignores its input, so `alwaysProduces`
    // (`ir/productivity.ts`, the same authority the filter-no-op Pass reads) supplies the constant.
    // A body of ONLY STREAM-IDENTITY steps (a side-effect arm — `aggregate("a")`, a labelled
    // `groupCount("a")`, `sideEffect(…)`, `identity()`) emits exactly its input, so it too always
    // fires; `alwaysProduces` cannot see it because it reads the LAST step alone (`out().aggregate("a")`
    // must NOT qualify — `out()` can produce nothing), so the whole-body check is separate.
    const alwaysFires = alwaysProduces(body!) || body!.every((inner) => isStreamIdentity(inner, ctx.params));
    const empty = alwaysFires ? CONSTANT.false : childPredicate(body!, subject, fresh, ctx, true);
    if (!empty) return null;
    exhausted = and(exhausted, empty);
  }
  return slice
    ? mintTraverserMajor(arms, source, labels, ctx.source, fresh)
    : branchResult(mergeArms(arms, withoutEncounter(input.channels), labels, ctx.source, fresh), ctx, fresh);
}

export function chooseArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length) return null;
  if (step.optionArms) return chooseOptions(step, input, framing, bulked, ctx, fresh, labels);
  // A `choose` is a `BranchStep` like `union` — barrier-free it is TRAVERSER-major, a batched-barrier
  // arm makes it ARM-major (`BranchStep.java`). Only the ARM bodies decide `hasBarrier` (the condition
  // is a per-traverser predicate, not an option), so a SLICE with a batched then/else arm declines
  // (arm-major not built); otherwise the arms lower from `augmentParent(input)` and merge through
  // `mintTraverserMajor`, else the fan-out order is minted for a collect / dropped. See `unionArms`.
  const args = step.args.map((a) => a.value);
  if (args.length < 2 || args.length > 3) return null;
  // THE CONDITION MAY BE A BARE PREDICATE, not only a body: `choose(P.eq(29), __.constant('matched'))`
  // is `ChooseStep(new IsStep(P), …)` — TinkerPop's own `choose(Predicate, …)` overload wraps it — so
  // spelling it as a one-step `is` body reuses `bodyPredicate` rather than adding a second predicate
  // path. Declining it made the whole `choose(P, …)` overload look like a missing branch lowering.
  const [choice, ...rest] = step.args ?? [];
  if (!choice || rest.some((arg) => !isNested(arg.value))) return null;
  const condition = isNested(choice.value)
    ? bodyOf(choice.value.nested, ctx.params)
    : isPred(choice.value) ? [{ name: 'is', args: [choice] } as IRStep] : null;
  const bodies = rest.map((arg) => bodyOf((arg.value as { readonly nested: unknown }).nested, ctx.params));
  const [then, otherwise] = bodies;
  if (!condition?.length || !then?.length) return null;

  const slice = sliceableBranch(ctx, input);
  if (slice && [then, otherwise ?? []].some((body) => armBatches(body!))) return null;
  const source = slice ? augmentParent(input, fresh) : input;
  const subject = branchSubject(source, framing);
  if (!subject) return null;

  const pred = bodyPredicate(condition, subject, fresh, ctx);
  if (!pred) return null;
  // A `choose` routes on the condition's PRODUCTIVITY, not a two-valued boolean: `ChooseStep` takes the
  // TRUE arm iff the condition traversal PRODUCED for this traverser, and the FALSE arm otherwise
  // (`vendor/tinkerpop/gremlin-core/.../branch/ChooseStep.java`). So the else arm's negation must be
  // NULL-SAFE — an UNPRODUCTIVE condition is a NULL predicate (an absent value, an empty operand under
  // `is(P.eq(__.V(9999)…))`), and `NOT NULL` is NULL, which would drop the row from BOTH arms where the
  // reference routes it to the else. `notProduced` (`pred IS NOT 1`) sends a false-OR-null condition to
  // the else, which is the productivity split; it is identical to `NOT pred` wherever pred cannot be null.
  const guarded = (negated: boolean): Rel => make.filter({
    id: fresh('cg'), input: source, channels: source.channels, type: source.type,
    pred: negated ? notProduced(pred) : pred,
  });

  const armThen = continueAs(guarded(false), framing, then, 0, bulked, inArmBody(ctx), fresh, labels);
  // The else arm over ZERO steps is `identity` on the complement — see above.
  const armElse = continueAs(guarded(true), framing, otherwise ?? [], 0, bulked, inArmBody(ctx), fresh, labels);
  if (!armThen || !armElse) return null;
  const arms = [armThen, armElse];
  if (slice) return mintTraverserMajor(arms, source, labels, ctx.source, fresh);
  // Drop the spent position from each arm (an arm-local `order()`/`limit()`), as `union` does — a
  // `choose` is unordered, so the merged stream carries none.
  const dropped = arms.map((arm) => ({ ...arm, rel: dropEncounter(arm.rel, fresh) }));
  return branchResult(mergeArms(dropped, withoutEncounter(input.channels), labels, ctx.source, fresh), ctx, fresh);
}

/** Do two framings describe the same stream? A shape mismatch between arms is a variant stream, which
 *  is why this is an equality rather than a merge. */
export const sameFraming = (left: RelFraming, right: RelFraming): boolean =>
  left.kind === 'elements' ? right.kind === 'elements' && left.elem === right.elem
    : left.kind === 'list' ? right.kind === 'list' && JSON.stringify(left.of) === JSON.stringify(right.of)
      // A path arm compares `scalars` as well as the member encoding, and it has to: two arms whose positions
      // are elements in one and projected values in the other agree on `of` (both are typed trees) and
      // disagree about whether the merged path may re-enter the list vocabulary.
      : left.kind === 'path'
        ? right.kind === 'path' && left.scalars === right.scalars && JSON.stringify(left.of) === JSON.stringify(right.of)
      // A DISCARD is not a stream, so no arm can be one: `drop()` is terminal, and an arm body ending
      // in it would be a branch whose arms disagree about whether a traverser exists at all.
      : left.kind === 'discard' ? false
        // TWO MAP ARMS MERGE when the two SIDES agree, which is the list arm's rule with two member
        // encodings instead of one: each arm carries a single `map` column, so the union is positional
        // and needs nothing re-projected. It became reachable the moment a map stopped being terminal —
        // `choose(p, __.valueMap('name'), __.valueMap('age'))` is the shape, and an arm-local BARRIER
        // inside one (`__.groupCount()`) is the branch child's own scope exactly as a `fold()` arm is.
        : left.kind === 'map'
          ? right.kind === 'map' && JSON.stringify(left.keyOf) === JSON.stringify(right.keyOf)
            && JSON.stringify(left.valOf) === JSON.stringify(right.valOf)
        // A MAP.ENTRY arm is the same equality over the same two sides — two columns rather than one,
        // and the column test below is what checks that.
        : left.kind === 'mapEntry'
          ? right.kind === 'mapEntry' && JSON.stringify(left.keyOf) === JSON.stringify(right.keyOf)
            && JSON.stringify(left.valOf) === JSON.stringify(right.valOf)
          // Two PROPERTY arms could merge when they agree on the owner kind, but the columns differ
          // between vertex and edge (`vpid`/`meta`), so a blanket equality would union relations of
          // different widths. Nothing builds a property-valued branch yet; decline until one does.
          : left.kind === 'property' ? false
            // TWO RECORD ARMS MERGE when their fields agree in key, order AND shape — the map arm's
            // rule one level down, and the same move: a record's payload is its fields' PREFIXED
            // columns (`framingCols`), so once the fields agree the union is positional and needs
            // nothing re-projected. It is reachable because a branch arm may now END in a `project()`
            // — `union(__.hasLabel(A).project(k…), __.hasLabel(B).project(k…))`, the per-member type
            // dispatch a GraphQL interface/union field lowers to, and the same shape Neo4j's GraphQL
            // library emits as `CALL { … RETURN this0 {…} AS this UNION … }` (one branch per member,
            // each building its own row).
            : left.kind === 'record' ? right.kind === 'record' && sameRecordFields(left.fields, right.fields)
              // A VARIANT arm would be a branch nested inside a branch whose inner merge already went
              // mixed. `variantMerge` flattens no nesting today — an arm's tagged rows would have to
              // be re-tagged onto the outer payload, which is expressible and unbuilt — so declining
              // is the honest answer rather than double-tagging the rows.
              : left.kind === 'variant' ? false
                // A DETACHED arm would be a branch INSIDE a resumed chain, whose rows are a landed
                // constant relation rather than a stream this plan can re-read. Nothing produces one
                // (the detached tail admits three reads and no branch), so declining keeps the switch
                // total rather than merging two relations that are not the same width.
                : left.kind === 'detached' ? false
                  // A per-row TYPED NODE arm is a branch whose body is `cap(mixed).unfold()`. It is
                  // terminal (no uniform continuation), so a branch arm ending in one is not built;
                  // decline rather than union two heterogeneous node streams positionally.
                  : left.kind === 'typedNode' ? false
                    : right.kind === 'scalar' && JSON.stringify(left.type) === JSON.stringify(right.type);

/** A record collapsed to a map value carries SELF-DESCRIBING `{t,v}` pairs, which is the map
 *  vocabulary's one scalar encoding on both sides (`MapOf`, `render.ts`: "the scalar side of a map is
 *  ALWAYS a self-describing {t,v} ValueNode … heterogeneous maps round-trip"). Spelled once here
 *  because `scalarChild`'s record arm already claims exactly this framing for exactly this relation. */
export const MAP_OF_NODES = { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } } as const;

/**
 * ARMS WHOSE RECORDS DISAGREE, RE-PROJECTED AS MAP VALUES — or `null` where this route does not apply.
 *
 * Two record arms merge as records only when their fields AGREE (`sameRecordFields`), because a record's
 * payload is its fields' prefixed COLUMNS and a `Union` is positional. That is the common case and the
 * capable one — the fields stay addressable, so `union(…).select('a')` keeps working. It is also exactly
 * what a GraphQL interface/union field does NOT satisfy: each member selects its OWN fields, so the arms
 * disagree by construction.
 *
 * The fix is not a wider row — it is a NARROWER one. `recordToMap` collapses a record's fields into the
 * single `map` column the map vocabulary already reads, whose entries are self-describing `{t,v}` nodes,
 * so two arms with entirely different key sets become two rows of one column and the positional `Union`
 * has nothing left to disagree about. This is precisely the shape the Neo4j GraphQL library emits for the
 * same query — each `CALL` branch does `WITH this0 { .id, __resolveType: "Child1" } AS this0 RETURN this0
 * AS this`, i.e. builds a MAP inside the branch so the branches union over one column — and it is why
 * they never hit the same-named-field clash a flattened projection would.
 *
 * Three declines, each deliberate:
 *
 * - **no record arm at all** — nothing to demote; the ordinary paths own it.
 * - **records that already AGREE** — demoting would spend the fields' addressability as COLUMNS for no
 *   gain. A record stays a record wherever it can, which keeps the one-directional rule honest
 *   (`framing.ts`: a record becomes a map at the boundary that needs a VALUE, and nothing turns a map
 *   back into a record).
 * - **an arm that is neither a record nor an already-`{t,v}` map** — an `elem`- or `list`-valued map's
 *   entries are a different physical form, so merging it with record-derived nodes would union two
 *   encodings under one framing. Fail closed.
 *
 * What the demotion costs is the field's COLUMN, not its reachability: `select(k)` over the merged
 * stream still answers, through the map vocabulary's JSON member read rather than a prefixed column, and
 * it answers CORRECTLY on rows where `k` is absent — `SelectOneStep` tries the traverser's own map and a
 * missing key is a `KeyNotFoundException` → `EmptyTraverser`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectStep.java:65-90`),
 * so those rows DROP rather than reading a sibling arm's value. Measured on all three key-presence
 * arrangements (`record-branch-arms.exec.test.ts`).
 */
export function mapDemotedArms(arms: readonly Tail[], source: GraphSource, fresh: Minter): readonly Tail[] | null {
  const fieldsOf = (arm: Tail): readonly RecordField[] | null => (arm.framing.kind === 'record' ? arm.framing.fields : null);
  const records = arms.map(fieldsOf);
  if (!records.some((fields) => fields)) return null;
  const first = records[0];
  if (first && records.every((fields) => fields && sameRecordFields(first, fields))) return null;
  // A map arm is demotable whatever its VALUE shape (scalar or list — an `elem` key/value declines): a
  // demoted record contributes SCALAR-valued entries, so a merge with a list-valued `valueMap` arm
  // (`union(__.project('a').by(…), __.valueMap('lang'))`) has HETEROGENEOUS values and its merged
  // descriptor is the self-describing scalar (`MAP_OF_NODES`) — the map blob is unchanged, the value
  // nodes still self-describe (`{t:'list'}` frames as a list, a scalar node as a scalar), only the
  // consumer-facing `valOf` widens. So EVERY map arm is re-framed to `MAP_OF_NODES` here, not just the
  // record-demoted ones — a list `valOf` is precise for a STANDALONE `valueMap`, but a merge that also
  // carries scalar values cannot promise every value is a list.
  const demotable = (arm: Tail): boolean => arm.framing.kind === 'record'
    || (arm.framing.kind === 'map' && arm.framing.keyOf.kind === 'scalar' && arm.framing.valOf.kind !== 'elem');
  if (!arms.every(demotable)) return null;
  const out: Tail[] = [];
  for (const [at, arm] of arms.entries()) {
    const fields = records[at];
    if (!fields) { out.push({ ...arm, framing: MAP_OF_NODES }); continue; }
    const mapped = recordToMap(arm.rel, fields, source, fresh);
    if (!mapped) return null;
    out.push({ ...arm, rel: mapped, framing: MAP_OF_NODES });
  }
  return out;
}

/**
 * Do two records describe the same row? Field for field, IN ORDER — `RecordField.prefix` is positional
 * (`prefixAt`, `record.ts`), so position IS the column name and two records that agree here occupy the
 * same columns by construction.
 *
 * `optional` is compared rather than merged, and that is the deliberate narrowing: `mergeArms` adopts
 * the FIRST arm's framing for the merged stream, so admitting a disagreement would silently impose one
 * arm's productivity rule on the other's rows — TinkerPop omits an unproductive key
 * (`ProjectStep.map`'s `ifProductive`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:66`),
 * so getting that flag wrong is a key present where the reference has none. Merging it properly means
 * recomputing the merged framing, which is the caller's to do if a case ever needs it.
 */
export const sameRecordFields = (left: readonly RecordField[], right: readonly RecordField[]): boolean =>
  left.length === right.length && left.every((field, i) => {
    const other = right[i]!;
    return field.key === other.key && field.prefix === other.prefix
      && field.optional === other.optional && sameFraming(field.framing, other.framing);
  });

export const sameColumns = (left: readonly ColMeta[], right: readonly ColMeta[]): boolean =>
  left.length === right.length && left.every((column, i) => column.name === right[i]!.name);
