import { ValueParseError } from './coerce.ts';

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
 * below AND by the compiler's name rules (`NameRules`, `compiler/rel/write.ts`) — a constant judged at
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

/** `ElementHelper.validateLabel`. Returns the label so a caller can validate inline. */
export function validateLabel(label: unknown): string {
  if (label === null || label === undefined) throw new ValueParseError(LABEL_SENTENCES.nullMessage);
  return validateIdentifier(String(label), LABEL_SENTENCES);
}
