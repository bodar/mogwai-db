import { compilerInt, compilerNull, compilerText, type BinaryOp, type Expr } from '../../rel/expr.ts';
import { exprHasSubquery } from '../../rel/walk.ts';
import { NULL_TAG, type ValueType } from '../../gremlin/types.ts';
import type { ScalarType } from '../../sql/kernel/render.ts';
import { jsonField } from './build.ts';
import { ALWAYS_PRODUCTIVE } from './child.ts';

/**
 * THE PER-ROW TYPE TAG — what is known of a value's Gremlin type, and the SQL that reads it.
 *
 * A value travels with a TAG: a compile-time static, a per-row column (a stored `vtype`, a reducer's `vt`,
 * the sack's tag, a `{t,v}` node's `t`), or nothing, in which case its SQLite storage class is what the
 * wire infers it as. Every inference over that — "this value's type name", "complete a partial tag",
 * "is this node a null" — lives HERE, once, rather than as a private copy beside each consumer (the sack,
 * the receiver checks and the reducers each held one).
 */

/** What is known about a value's Gremlin type. */
export type ValueEvidence =
  | { readonly kind: 'static'; readonly tag: ValueType }
  /** `nullOnlyForNull`: the tag is NULL exactly when the value is (a stored property row always carries
   *  its `vtype`), so the storage class need not be consulted as a fallback. */
  | { readonly kind: 'tag'; readonly tag: Expr; readonly nullOnlyForNull?: boolean }
  | { readonly kind: 'storage' };

const STORAGE: ValueEvidence = { kind: 'storage' };

/** The evidence a value's FRAMING type plus an optional per-row type expression give. A per-row tag
 *  that is a compiler literal (a host that carries its static tag as text) IS a static tag. */
export function evidenceOf(type: ScalarType | undefined, vtype?: Expr): ValueEvidence {
  if (vtype) {
    if (vtype.kind === 'lit' && vtype.source === 'compiler-text') return { kind: 'static', tag: vtype.value as ValueType };
    return { kind: 'tag', tag: vtype };
  }
  if (type?.kind === 'static') return { kind: 'static', tag: type.type };
  return STORAGE;
}

const call = (fn: string, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });
const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });

/**
 * An UNTAGGED value's canonical Gremlin type, inferred from its SQLite storage class — the same inference
 * the wire applies to an untagged value (an INTEGER is an Int inside 32 bits and a Long past them, a REAL a
 * Double, TEXT a String), so naming it here is not a second policy. A MIXED list hands every bare member a
 * type through it, and the number-class authority (`reducer.ts`) reads an untagged row's class through it.
 */
export const inferredVtype = (value: Expr): Expr => {
  // Spelled with the value TWICE, not once per arm: the value is routinely a fused arithmetic over a
  // correlated read, and a `CASE typeof(v) …` per class would repeat that subquery four times. `typeof` is
  // rewritten by `replace` (no class name contains another's), and the int32 test is the one-spelling
  // `abs(2v + 1) <= 2^32 - 1`. NULL for a NULL (and a BLOB, which nothing frames as a number).
  const int32 = bin('<=', call('abs', bin('+', bin('*', compilerInt(2), value), compilerInt(1))), compilerInt(4294967295));
  const integral: Expr = { kind: 'case', whens: [[int32, compilerText('int')]], else: compilerText('long') };
  const renamed = [['integer', integral], ['real', compilerText('double')], ['text', compilerText('string')]] as const;
  const named = renamed.reduce<Expr>((inner, [cls, tag]) => call('replace', inner, compilerText(cls), tag), call('typeof', value));
  return call('nullif', call('nullif', named, compilerText('null')), compilerText('blob'));
};

/**
 * A value's TOTAL tag — a Gremlin type name on every present row, NULL only for a NULL value. A static tag
 * is its literal; a per-row tag that is already total (`nullOnlyForNull`, or a literal) is itself; a
 * PARTIAL one — a reducer's `vt` (`REDUCED_TYPE`), a merged arm's — is completed from the value's storage
 * class (`inferredVtype`); and storage evidence is that inference alone. So the inference is spent only
 * where a tag can be NULL on a present row.
 */
export function totalTag(evidence: ValueEvidence, value: Expr): Expr {
  if (evidence.kind === 'static') return compilerText(evidence.tag);
  if (evidence.kind === 'storage') return inferredVtype(value);
  const { tag } = evidence;
  if (evidence.nullOnlyForNull || (tag.kind === 'lit' && tag.value !== null)) return tag;
  return tag.kind === 'lit' ? inferredVtype(value) : call('COALESCE', tag, inferredVtype(value));
}

/** The value's per-row TYPE NAME over non-static evidence: its tag, else its storage class (`'null'` for a
 *  NULL). One expression so the value is spelled once in the test, which matters because a receiver is
 *  often a correlated property read and every repetition is another subquery in the statement text. The
 *  storage-class names share no spelling with a `ValueType`, so a consumer lists both in one set. */
export const typeName = (value: Expr, evidence: ValueEvidence): Expr => {
  if (evidence.kind !== 'tag') return call('typeof', value);
  // A tag that is NULL only for a NULL value needs no second spelling of the value to say so.
  const fallback: Expr = evidence.nullOnlyForNull ? compilerText(NULL_TAG) : call('typeof', value);
  return call('COALESCE', evidence.tag, fallback);
};

/**
 * IS THIS `{t,v}` NODE A NULL — the one SQL spelling. A null member is tagged `'null'` (`NULL_TAG`,
 * `valueNodeOf`), and a node with NO tag is a null too where a producer left it untagged (a child body's
 * null, an empty reducer's absence), so the predicate is `coalesce(t, 'null') = 'null'`: one read of the
 * tag, true for both spellings. A reader that asked `t IS NOT NULL` instead took a tagged null for a value
 * (`group()`'s last-wins member, `map.ts`).
 */
export const nodeIsNull = (node: Expr): Expr =>
  bin('=', call('coalesce', jsonField(node, 't'), compilerText(NULL_TAG)), compilerText(NULL_TAG));

declare const presenceTagBrand: unique symbol;

/**
 * A PRESENCE TAG — a child body's TOTAL type tag, read by its host as "did the body produce": a Gremlin
 * type name on every row the body produced (`'null'` for a productive null), NULL only where it produced
 * nothing. So presence is `tag IS NOT NULL` (`presenceOf`'s `{ tag }` arm, `child.ts`), and a productive
 * null stays distinct from no row — TinkerPop's one productivity bit beside the value
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalProduct.java`),
 * Calcite's null indicator projected INSIDE the subquery
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/sql2rel/RelDecorrelator.java` ~:3157-3170).
 *
 * BRANDED, with the brand's symbol private to this module, so `tsc` (the `check` gate) rejects a
 * hand-built one: a presence tag comes only from a constructor below, each of which builds it where it
 * is TRUE —
 * - `staticTag` — a literal in the body's OWN select list (free: it exists exactly where the row does);
 * - `rowTag` — an inference over a ROW expression of the body, REFUSED over a subquery result, whose
 *   `typeof` answers `'null'` on NO row and so would read an unproductive body as a productive null;
 * - `gatedTag` — a tag over a MAY-BE-ABSENT arm, gated on the arm's presence (Calcite's `visitLiteral`,
 *   `RelDecorrelator.java` ~:2720-2726: a constant hoisted above the join reads NULL where the
 *   subquery's indicator does).
 *
 * Only the PRESENCE payload is branded. A FRAMING tag (`hostTag`, a branch's `armTag`, a merged
 * `vtype`, a write/collection/sack literal) stays a plain `Expr` and ungated, because nothing reads it
 * as presence; it becomes one only through a constructor here, which is where any gate is paid.
 */
export type PresenceTag = Expr & { readonly [presenceTagBrand]: true };

/** Each minted tag's PRESENCE, recorded by the constructor that knows it (see `tagPresent`). */
const presenceOfTag = new WeakMap<PresenceTag, Expr>();

const branded = (tag: Expr, present: Expr): PresenceTag => {
  const minted = tag as PresenceTag;
  presenceOfTag.set(minted, present);
  return minted;
};

/**
 * WHERE A PRESENCE TAG IS NON-NULL — `tag IS NOT NULL`, read off how the tag was BUILT rather than by
 * spelling the tag: a static or row tag is TOTAL (never NULL on a row that exists), so it is present
 * wherever its row is, and a gated one exactly where its gate holds and its inner tag is present. So a
 * filter that asks only "did the body produce" spends the GATE, never the type inference the tag carries
 * for a consumer that reads its value (`inject(null,1).map(is(neq(1)))` filters on the `neq` alone).
 */
export const tagPresent = (tag: PresenceTag): Expr =>
  presenceOfTag.get(tag) ?? bin('is not', tag, compilerNull());

/** A body's STATIC tag — a literal projected in its own row, present wherever that row is. */
export const staticTag = (type: ValueType): PresenceTag => branded(compilerText(type), ALWAYS_PRODUCTIVE);

/**
 * A body's TOTAL tag inferred over a ROW expression of the body — never NULL for a row that exists: the
 * value's own tag completed from its storage class (`totalTag`), and `'null'` for a null value.
 *
 * `null` — REFUSED — where the value or its per-row tag CONTAINS a subquery anywhere, at the top or
 * nested (`json_extract((SELECT …), '$.v')`): a correlated read answers NULL when it finds no row, so an
 * inference over it is made OUTSIDE the body and reads "nothing" as a null value. The caller keeps its
 * value-nullness presence, or declines.
 */
export function rowTag(value: Expr, evidence: ValueEvidence): PresenceTag | null {
  if (exprHasSubquery(value) || (evidence.kind === 'tag' && exprHasSubquery(evidence.tag))) return null;
  if (evidence.kind === 'static') return staticTag(evidence.tag);
  const total = totalTag(evidence, value);
  // A `COALESCE` the total tag already is takes the `'null'` fallback as one more argument.
  const args = total.kind === 'call' && total.fn === 'COALESCE' ? total.args : [total];
  return branded(call('COALESCE', ...args, compilerText(NULL_TAG)), ALWAYS_PRODUCTIVE);
}

/**
 * A tag READ OFF THE ROW that is already NULL exactly where the object is absent — a label history's
 * last entry's shape tag `k` (`alias.ts` `aliasEntryTag`), which every `as()` entry writes (`objectEntry`,
 * `history.ts`) and which is NULL only where the history is NULL or empty. Not a type name: no consumer
 * reads a presence tag's value, only `tagPresent`, which is `tag IS NOT NULL` here.
 *
 * `null` — REFUSED — over a subquery, for `rowTag`'s reason: a correlated read answers NULL on NO row, so
 * a NULL there would not mean "this row's object is absent".
 */
export const readTag = (tag: Expr): PresenceTag | null => (exprHasSubquery(tag) ? null : branded(tag, bin('is not', tag, compilerNull())));

/**
 * A presence tag over a MAY-BE-ABSENT arm — `CASE WHEN <present> THEN tag END`, so the tag is NULL
 * exactly where the arm produced nothing — and the bare tag, no per-row term, where `present` is the
 * constant `ALWAYS_PRODUCTIVE`. The one place a tag read outside an arm's row becomes a presence tag.
 */
export const gatedTag = (present: Expr, tag: PresenceTag): PresenceTag => {
  if (present === ALWAYS_PRODUCTIVE) return tag;
  const inner = tagPresent(tag);
  return branded({ kind: 'case', whens: [[present, tag]], else: compilerNull() }, inner === ALWAYS_PRODUCTIVE ? present : bin('and', present, inner));
};
