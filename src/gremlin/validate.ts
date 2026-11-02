import { ValueParseError } from './coerce.ts';
import type { CanonicalType, TypeNode } from './types.ts';

// ---------- the element-identifier rules every write must satisfy ----------
//
// TinkerPop enforces these in `ElementHelper.validateProperty`/`validateLabel` and
// `Graph.Hidden` (gremlin-core), and every write step reaches them: `TinkerGraph.property()`,
// `addV`, `addE`, and — explicitly, per map — `MergeElementStep.validate`. We enforced NONE of
// them, so `g.addV('~vertex')`, `g.V(1).property('~id','y')` and `g.mergeV(['~label':'vertex'])`
// all wrote happily. `~` is not decoration: it is TinkerPop's HIDDEN namespace, the one a graph
// uses for its own bookkeeping, and a graph that lets a user write there has no way left to tell
// its own keys from theirs.
//
// The messages are TinkerPop's verbatim because the corpus asserts on their text
// (`MergeVertex.feature`, `MergeEdge.feature` — "containing text of").
//
// This module holds ONLY the rules that are about the identifier itself. Whether a given map may
// carry a T token at all, and whether an `option(onCreate)` may restate a key, are questions about
// the STEP, and live with the merge lowering that asks them.

/** TinkerPop's hidden namespace (`Graph.Hidden`): a key a graph reserves for its own bookkeeping.
 *  User writes to it are rejected everywhere — a property key, a label, in a map or as an argument. */
export const isHiddenKey = (key: string): boolean => key.startsWith('~');

/**
 * The sentences an identifier refusal raises — `ElementHelper.validateProperty`'s key half and
 * `ElementHelper.validateLabel` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/util/ElementHelper.java`;
 * the text is `Property.Exceptions` / `Element.Exceptions`). ONE table per identifier, read by the checks
 * below AND by the name rules (`NameRules` below, and `compiler/rel/write.ts`' per-traverser resolver) — a constant judged at
 * compile time and a name a body resolves per traverser — so the two cannot refuse in two spellings.
 * `hidden` ends on the offending name.
 */
export interface IdentifierSentences {
  readonly nullMessage: string;
  readonly empty: string;
  readonly hidden: string;
}

export const PROPERTY_KEY_SENTENCES: IdentifierSentences = {
  nullMessage: 'Property key can not be null',
  empty: 'Property key can not be the empty string',
  hidden: 'Property key can not be a hidden key: ',
};

export const LABEL_SENTENCES: IdentifierSentences = {
  nullMessage: 'Label can not be null',
  empty: 'Label can not be empty',
  hidden: 'Label can not be a hidden key: ',
};

/** The empty/hidden half of an identifier check, on a name already known to be a present String. */
export function validateIdentifier(name: string, sentences: Pick<IdentifierSentences, 'empty' | 'hidden'>): string {
  if (name === '') throw new ValueParseError(sentences.empty);
  if (isHiddenKey(name)) throw new ValueParseError(`${sentences.hidden}${name}`);
  return name;
}

/** `ElementHelper.validateProperty`'s key half. Returns the key so a caller can validate inline. */
export function validatePropertyKey(key: unknown): string {
  if (key === null || key === undefined) throw new ValueParseError(PROPERTY_KEY_SENTENCES.nullMessage);
  return validateIdentifier(String(key), PROPERTY_KEY_SENTENCES);
}

/** `ElementHelper.validateLabel` — on a value that must already BE a String. A non-String is REFUSED
 *  under `LABEL_NAME`'s sentence, never coerced: `String(5)` once wrote a merge map's `T.label: 5` as
 *  the label `'5'`. Returns the label so a caller can validate inline. */
export function validateLabel(label: unknown): string {
  return constantName(label, null, LABEL_NAME);
}

// ---------- what a COLLECTION is ----------

/**
 * A value's members when it is a Gremlin COLLECTION — a List (a JS array) or a Set (a JS `Set`, what a
 * `{…}` literal parses to) — each with the item TypeNode its text stated (`type`'s `items`, by
 * position), or `null` for anything else (a Map is not a Collection, as `java.util.Map` is not).
 *
 * THE one spelling of the question, because the reference asks `instanceof Collection` and
 * `Array.isArray` answers it only for a List: a label host that read `Array.isArray` refused
 * `{'person'}` as a non-String where `resolveStringArguments`' Collection arm
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:211-236`),
 * `ElementHelper.getLabelsValue` (`.../structure/util/ElementHelper.java:267-275`) and
 * `MergeElementStep.validate` (`.../process/traversal/step/map/MergeElementStep.java:258-300`) all take
 * it. A Set's members come in its insertion order — the order the text wrote them.
 */
export function collectionMembers(value: unknown, type: TypeNode | null): { readonly members: readonly unknown[]; readonly types: readonly (TypeNode | null)[] } | null {
  if (!Array.isArray(value) && !(value instanceof Set)) return null;
  const items = type !== null && typeof type === 'object' && type.t !== 'map' ? type.items : [];
  const members = [...value];
  return { members, types: members.map((_, i) => items[i] ?? null) };
}

// ---------- names judged at compile time — the ONE constant-name judge ----------

/**
 * The reference's checks on a NAME — a property key or a label — as the message each one raises. ONE
 * table per host, read by the compile-time judge below (`constantName`, a value the query TEXT holds) AND
 * by the compiler's per-traverser resolver (`runtimeNameRows`, `compiler/rel/write.ts`, whose rules extend
 * these with an output column), so a constant and a resolved name refuse in one spelling, only earlier
 * (matrix §17 "Error timing").
 *
 *  - a KEY is `ElementHelper.validateProperty` (`structure/util/ElementHelper.java:80-90`,
 *    `Property.Exceptions` `structure/Property.java:134-143`). Its NON-STRING case the reference refuses
 *    by a cast — a `ClassCastException` on the step path, `legalPropertyKeyValueArray`'s sentence on the
 *    folded one (`structure/util/ElementHelper.java:98-105`); the second has portable text, so it is raised.
 *  - a LABEL is `ElementHelper.validateLabel` (`Element.Exceptions`, `structure/Element.java:212-222`).
 *    Its non-String case is a `(String)` cast on the single-label path, which has no portable text, so
 *    it raises the sibling COLLECTION path's sentence (`AddVertexStep.resolveLabelCollection`,
 *    `step/map/AddVertexStep.java:165-181`), naming the value rather than its Java class (matrix §17
 *    "A non-String text receiver"). A member of a label COLLECTION (`addV(t1, t2)`) owns that path's
 *    null sentence too, and refuses a member that is itself a collection.
 *
 * (All paths under `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/`.)
 */
export interface NameRules extends IdentifierSentences {
  readonly notString: string;
  /** Does `notString` end on the offending value? */
  readonly notStringNames: boolean;
  /** The refusal for a name that is itself a COLLECTION — a body framed as a list, or a list constant —
   *  where the host refuses one rather than declining. */
  readonly collection?: string;
  /** `false` for a name that is only COMPARED against stored ones (`dropLabel`): the reference resolves
   *  it (`resolveStringArguments`) but never runs `validateLabel` on it, so an empty or hidden name
   *  simply matches nothing. */
  readonly identifier?: false;
}

// The empty/hidden sentences (and the plain null one) are the tables above; only what a NAME SITE adds,
// its own null and non-String sentences, is here.
export const KEY_NAME: NameRules = {
  ...PROPERTY_KEY_SENTENCES,
  notString: 'The provided key/value array must have a String or T on even array indices', notStringNames: false,
};
export const LABEL_NAME: NameRules = {
  ...LABEL_SENTENCES, notString: 'Label traversal must produce a String, but got ', notStringNames: true,
};
/** `resolveLabelCollection`'s own two sentences, for a member of `addV(t1, t2, …)`. */
export const LABEL_MEMBER_NAME: NameRules = {
  ...LABEL_NAME, nullMessage: 'Label traversal must not produce null',
  collection: 'Label traversal must produce a scalar String when multiple traversals are provided, but got a Collection',
};
/** An item of a SOLE label list (`addV(__.constant(['a','b']))`), which reaches the graph as a `T.label`
 *  collection — `ElementHelper.getLabelsValue` (`structure/util/ElementHelper.java:267-275`). */
const T_LABEL_ITEMS = 'T.label collection must contain only Strings';
export const LABEL_ITEM_NAME: NameRules = { ...LABEL_NAME, nullMessage: T_LABEL_ITEMS, notString: T_LABEL_ITEMS, notStringNames: false };
/** `addLabel(<traversal>…)` — `TraversalUtil.resolveStringArguments`' sentences
 *  (`process/traversal/util/TraversalUtil.java:211-236`), then `validateLabel`'s (`AddLabelStep.java:86-95`). */
export const ADD_LABEL_NAME: NameRules = {
  ...LABEL_NAME, nullMessage: 'Traversal argument must not produce null',
  notString: 'Traversal argument must produce a String or Collection<String>, but got: ',
};
export const ADD_LABEL_MEMBER_NAME: NameRules = {
  ...ADD_LABEL_NAME, collection: 'Traversal argument must produce a scalar String when multiple traversals are provided, but got a Collection',
};
/** An item of `addLabel`'s SOLE collection — `resolveStringArguments`' Collection arm, naming the value where
 *  the reference names its class (matrix §17 "A non-String text receiver"); a null names `null`, as there. */
const ADD_LABEL_ITEMS = 'Traversal argument Collection must contain only Strings, but got: ';
export const ADD_LABEL_ITEM_NAME: NameRules = { ...ADD_LABEL_NAME, nullMessage: `${ADD_LABEL_ITEMS}null`, notString: ADD_LABEL_ITEMS };
/** `dropLabel(<traversal>…)` — the SAME `resolveStringArguments` (`step/sideEffect/DropLabelsStep.java:98-103`)
 *  and nothing after it: a removed name is only compared, never `validateLabel`led. */
export const DROP_LABEL_NAME: NameRules = { ...ADD_LABEL_NAME, identifier: false };
export const DROP_LABEL_MEMBER_NAME: NameRules = { ...ADD_LABEL_MEMBER_NAME, identifier: false };
export const DROP_LABEL_ITEM_NAME: NameRules = { ...ADD_LABEL_ITEM_NAME, identifier: false };

/**
 * A merge map's `T.label` — `MergeElementStep.validate`'s own sentences
 * (`process/traversal/step/map/MergeElementStep.java:258-300`): a scalar that is neither a String nor a
 * Collection, and a collection member that is not a String, each worded per role — `option(onMatch)` has
 * its own pair, the merge argument and `option(onCreate)` share the other. Then `validateLabel` on each
 * name. Each sentence ends on the VALUE where the reference names its simple class (matrix §17
 * "A non-String text receiver"); a null MEMBER — a `NullPointerException` there, with no text to keep —
 * names `null`. (A null SCALAR never reaches here: `validateMergeKey` answers it first.)
 */
export function mergeLabelRules(op: 'mergeV' | 'mergeE', onMatch: boolean): { readonly scalar: NameRules; readonly member: NameRules } {
  const scalar = onMatch
    ? 'option(onMatch) expects T.label value to be String or Collection<String> - found: '
    : `${op}() and option(onCreate) args expect T.label value to be String or Collection<String> - found: `;
  const member = onMatch
    ? 'option(onMatch) expects T.label collection to contain only Strings - found: '
    : `${op}() expects T.label collection to contain only Strings - found: `;
  return {
    scalar: { ...LABEL_SENTENCES, notString: scalar, notStringNames: true },
    member: { ...LABEL_SENTENCES, nullMessage: `${member}null`, notString: member, notStringNames: true },
  };
}

/**
 * A COMPILE-TIME NAME — a value the query TEXT holds (a literal, `constant(…)`, a `withSideEffect`
 * constant, a merge map's `T.label`) judged under `rules`, the same rules a body's resolved name is
 * guarded by at run time. `vtype` is the type the text STATES for it, which is what tells a uuid, a
 * datetime, a char or a big decimal — all carried as JS strings or numbers — from a String: anything but
 * `string` is the reference's non-String name. A `null` vtype states nothing, and the JS type decides.
 */
export function constantName(value: unknown, vtype: CanonicalType | null, rules: NameRules): string {
  if (value === null || value === undefined) throw new ValueParseError(rules.nullMessage);
  if (rules.collection && collectionMembers(value, null)) throw new ValueParseError(rules.collection);
  if (typeof value !== 'string' || (vtype !== null && vtype !== 'string'))
    throw new ValueParseError(rules.notStringNames ? `${rules.notString}${shownValue(value, vtype)}` : rules.notString);
  return rules.identifier === false ? value : validateIdentifier(value, rules);
}

/**
 * The offending value as a refusal NAMES it, where the reference names its Java class (matrix §17
 * "A non-String text receiver"; `process/traversal/util/TraversalUtil.java:225`). Readable rather than
 * JS's `String(v)`, which printed `a` for `[['a']]`, `[object Map]` for a map and epoch millis for a
 * datetime: a list, set or map is its JSON, a datetime its ISO text, anything else its own text.
 */
function shownValue(value: unknown, vtype: CanonicalType | null): string {
  if (vtype === 'datetime' && typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (value instanceof Map || collectionMembers(value, null)) return JSON.stringify(jsonOf(value));
  return String(value);
}

/** A collection's members as JSON can spell them: a map key that is not a String by its text, a bigint
 *  and any other carrier object (a big decimal) by their own text. */
const jsonOf = (value: unknown): unknown => {
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [typeof k === 'string' ? k : shownValue(k, null), jsonOf(v)]));
  const collection = collectionMembers(value, null);
  if (collection) return collection.members.map(jsonOf);
  if (typeof value === 'bigint') return String(value);
  if (value !== null && typeof value === 'object' && value.constructor !== Object) return String(value);
  return value;
};
