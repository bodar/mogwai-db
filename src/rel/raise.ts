import { compilerText, type Expr } from './expr.ts';
import type { Rel } from './rel.ts';
import { exprRels, forEachExpr, forEachRel, relExprs } from './walk.ts';

/**
 * A ROW-LEVEL RAISE — an expression that aborts the statement with a message of our choosing, for the
 * answers that are an ERROR decided by a value only the data holds (`Math.addExact`'s `long overflow`
 * at the 64th bit, an integer `/ by zero`).
 *
 * SQLite has no `RAISE()` outside a trigger, and a guard statement (`Binding.guard`, `program.ts`) can
 * only probe a relation the PROGRAM can name — not a value computed inside a recursive term or a
 * subquery correlated to an outer row, which is exactly where a fold's accumulator lives. So the raise
 * borrows an error SQLite already throws on a value: `json_extract` refuses a malformed PATH, and quotes
 * the path back in its message (`bad JSON path: '…'` on current SQLite, `JSON path error near '…'` on
 * older ones). The path is never a valid one — it carries the message between two sentinels — so the
 * statement fails exactly when the arm holding it is EVALUATED, and `raisedMessage` reads the message
 * back out at the one seam every statement crosses (`GraphStore.query`, `src/storage.ts`).
 *
 * The document argument reads `dependsOn` (`json_quote` of any value is valid JSON, NULL included) so
 * the call is never a CONSTANT expression: SQLite may factor a constant out of a conditional and run it
 * once up front, which would raise on every row rather than on the one that took the arm.
 *
 * `message` must not contain the closing sentinel (`!$`); every caller passes a literal. A QUOTE is
 * representable: SQLite quotes the path back with `%Q`, doubling it, and `raisedMessage` undoes that —
 * which is what lets the reference's own `Can't parse null as String.` and exp4j's `Division by zero!`
 * travel verbatim.
 */
export function raiseExpr(message: string, dependsOn: Expr): Expr {
  return sentinelRaise(OPEN, message, dependsOn);
}

/**
 * A DEFERRAL raised mid-statement — `raiseExpr`'s mechanism for a value only the data decides that THIS
 * compiler cannot answer (a merge one barrier drain cannot hold), rather than an error the REFERENCE
 * answers. The difference is when it may fire: a reference error is the answer whether or not anything
 * reads the value (`mayRaise`'s consumers evaluate an unread site to reproduce it), while a deferral
 * belongs to the READ — an unread value was never a question this compiler failed to answer. So
 * `mayRaise` does not count one; `raisedMessage` reads both back.
 */
export function deferralExpr(message: string, dependsOn: Expr): Expr {
  return sentinelRaise(OPEN_DEFERRAL, message, dependsOn);
}

function sentinelRaise(open: string, message: string, dependsOn: Expr): Expr {
  if (message.includes(CLOSE)) throw new Error(`raiseExpr: unrepresentable message ${JSON.stringify(message)}`);
  return {
    kind: 'call', fn: 'json_extract',
    args: [{ kind: 'call', fn: 'json_quote', args: [dependsOn] }, compilerText(`${open}${message}${CLOSE}`)],
  };
}

/**
 * A raise that depends on NOTHING of the row's data — for a caller that already guards the arm with a
 * test of the value and would otherwise spell the value (often a correlated read) once more just to
 * satisfy `dependsOn`. `random()` is never a constant, so SQLite cannot hoist the arm out of its CASE.
 */
export const raiseInRow = (message: string): Expr => raiseExpr(message, { kind: 'call', fn: 'random', args: [] });

const OPEN = '$!raise:';
const CLOSE = '!$';
const OPEN_DEFERRAL = '$!defer:';
const RAISED = /\$!(?:raise|defer):(.*?)!\$/;

/** The message a `raiseExpr` arm aborted a statement with, or `null` for any other failure. */
export function raisedMessage(error: unknown): string | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  const match = text === null ? null : RAISED.exec(text);
  return match ? match[1]!.replaceAll("''", "'") : null;
}

/** The deferral an int64 overflow in SQLite's own arithmetic (`sum()`) becomes (`GraphStore.query`). */
export const INTEGER_OVERFLOW = 'integer arithmetic past 64 bits is not supported';

/** A query whose answer is an error the DATA decided — the reference's own message, raised mid-statement
 *  by a `raiseExpr` arm. A distinct class so a caller can tell an answer that IS an error from a failure. */
export class RaisedByQuery extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaisedByQuery';
  }
}

/** Is `e` a `raiseExpr` arm — the sentinel path is a compiler literal, so this is a syntactic test. */
const isRaise = (e: Expr): boolean =>
  e.kind === 'call' && e.fn === 'json_extract' && e.args[1]?.kind === 'lit'
  && typeof e.args[1].value === 'string' && e.args[1].value.startsWith(OPEN);

/** Is `e` ITSELF an arm that never yields a value — a `raiseExpr` or a `deferralExpr`? Syntactic, like
 *  `isRaise`: a physical rewrite that may drop a row taking this arm (it errors rather than answers) asks it. */
export const alwaysRaises = (e: Expr): boolean =>
  isRaise(e) || (e.kind === 'call' && e.fn === 'json_extract' && e.args[1]?.kind === 'lit'
    && typeof e.args[1].value === 'string' && e.args[1].value.startsWith(OPEN_DEFERRAL));

/**
 * CAN EVALUATING THIS RELATION RAISE — does any expression in it, correlated subplans included, hold a
 * `raiseExpr` arm. A consumer that might otherwise never EVALUATE the relation (an unread side-effect
 * collection) asks this to decide whether it owes the evaluation anyway: a reference `CollectingBarrier`
 * drains every traverser, so a raise its `by()` would hit is the answer whether or not the collection is
 * ever read.
 */
export function mayRaise(plan: Rel): boolean {
  let found = false;
  forEachRel(plan, (r) => {
    if (!found) relExprs(r).forEach((e) => forEachExpr(e, (node) => { if (isRaise(node)) found = true; }));
  });
  return found;
}

/** CAN EVALUATING THIS EXPRESSION RAISE — a `raiseExpr` arm in it, or in a correlated subplan it reads
 *  (`mayRaise`'s question asked of one value rather than of a relation). */
export function exprMayRaise(e: Expr): boolean {
  let found = false;
  forEachExpr(e, (node) => {
    if (!found && (isRaise(node) || exprRels(node).some(mayRaise))) found = true;
  });
  return found;
}
