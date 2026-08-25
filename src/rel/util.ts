/** Shared leaf helpers for the RelIR factories. The branded constructors in `factory.ts` and
 *  `stmt-factory.ts` both freeze their node literals and the arrays inside them, so the wrapper lives
 *  once here rather than as a copy in each. */

/** `Object.freeze` as an expression — returns its argument typed, so it composes inside a node literal
 *  (`freeze([...init.cols])`) without a cast. */
export const freeze = <T>(value: T): T => Object.freeze(value);
