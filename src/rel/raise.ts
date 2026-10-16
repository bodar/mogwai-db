import { compilerText, type Expr } from './expr.ts';

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
 * `message` must not contain the closing sentinel or a quote; every caller passes a literal.
 */
export function raiseExpr(message: string, dependsOn: Expr): Expr {
  if (message.includes(CLOSE) || message.includes("'")) throw new Error(`raiseExpr: unrepresentable message ${JSON.stringify(message)}`);
  return {
    kind: 'call', fn: 'json_extract',
    args: [{ kind: 'call', fn: 'json_quote', args: [dependsOn] }, compilerText(`${OPEN}${message}${CLOSE}`)],
  };
}

const OPEN = '$!raise:';
const CLOSE = '!';
const RAISED = /\$!raise:([^!']*)!/;

/** The message a `raiseExpr` arm aborted a statement with, or `null` for any other failure. */
export function raisedMessage(error: unknown): string | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  const match = text === null ? null : RAISED.exec(text);
  return match ? match[1]! : null;
}

/** A query whose answer is an error the DATA decided — the reference's own message, raised mid-statement
 *  by a `raiseExpr` arm. A distinct class so a caller can tell an answer that IS an error from a failure. */
export class RaisedByQuery extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaisedByQuery';
  }
}
