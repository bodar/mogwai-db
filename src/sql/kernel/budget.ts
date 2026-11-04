import { UnsupportedTraversal } from '../../compiler/unsupported.ts';

/**
 * THE MOST SQL ONE STATEMENT OF A COMPILE MAY SPELL — 400 KB. A ceiling on COMPILE WORK, and a property
 * of the query text and the schema, never of the data, so a decline past it is one too.
 *
 * The compiler imports NO platform constant. How long a statement the store accepts is the store's call
 * (a Durable Object's 100 KB, enforced by the DO in production and by `CfLimitedSql` in tests, and
 * declined cleanly at `GraphStore.query`), so a raised Cloudflare cap is a free win with no change here.
 * What this bounds is what the compiler SPENDS, which is linear in the text it writes: the lowering, the
 * checker and the emitter each walk the plan as the TREE its text is.
 *
 * ## Sizing — it must NEVER refuse a plan whose SQL a Durable Object would accept
 *
 * So it sits well above the 100 KB statement cap (4×), and every charge against it is a LOWER BOUND on
 * one statement's text: a plan the store would take is under 100 KB, so under every charge. Measured
 * over the L1 corpus (`test/compiler/compile-budget.test.ts`, which pins it): the largest statement is
 * ~16 KB (the budget is ~24× that) and the largest `spelledSize` 1 165 nodes, against a worst case of
 * 1.6 bytes spelled per node.
 *
 * OWNER RULE: a slow compile is a reason to shrink what a node costs, never to raise this.
 */
export const COMPILE_BUDGET_BYTES = 400_000;

/**
 * ONE COMPILE'S WORK METER — created once per compile (`compilePlan`) and threaded with the lowering's
 * settled options like the decline sink (`Declines`), so every lowering a compile starts — the wire read,
 * a segment head, a resume, a ranked-order probe — charges the same one. Per-compile STATE, not DI.
 *
 * Every charge is ONE statement's (or one unit of it), never a running total over the compile: a
 * program's statements are each their own query, and a 108-statement `addV` seed is 47 KB in all with
 * no statement over 2 KB. Summing them would refuse, on a number no database ever asks, a long write
 * program every statement of which the store accepts.
 *
 * Four charges, in compile order, each a lower bound on the text of the statement it is charged for:
 *  - the UNROLL's estimate, before a phase is built (`ir/strategies.ts` `tryUnroll`): the steps a bounded
 *    repeat splices, at the cheapest step's bytes. It reads the same limit; it runs in the Pass tier,
 *    which no lowering state reaches, and it is a function of the query text alone.
 *  - every EXPRESSION's tree size, before any rel pass (`lowered`, `compiler/rel/lower.ts`): an `Expr` is
 *    spelled per use at every stage, and the passes walk and rewrite it as that tree, so a shared
 *    expression that would be spelled 2^k times is refused here, in milliseconds (`largestExpression`).
 *  - each binding's TREE SIZE, relations included, before `checkPlan` and the emitter walk it
 *    (`emitProgram`, `src/rel/emit.ts`) — after naming, when a shared relation left inline (a correlated
 *    subplan) is certain to be spelled per use (`spelledSize`).
 *  - the RENDERED BYTES, counted as the renderer writes them (`render`, `kernel/q.ts`) — exact.
 * The two tree sizes count NODES and are charged as bytes because every node spells at least one; both
 * are read off the DAG in O(DAG).
 *
 * NO NODE-COUNT CHARGE AT THE MINTER. A relation-id count was proposed beside the byte charges and is
 * deliberately absent: it is a per-COMPILE running total (a minter spans every statement of a program and
 * every lowering a compile attempts, declined routes included), so no per-node byte figure makes it a
 * lower bound on any one statement — it could refuse a long write program every statement of which the
 * store accepts. Even per statement the figure is thin: over the L1 corpus a finished plan carries as little
 * as 4.3 bytes of its largest statement per relation (`map(constant(null))`), before counting the relations
 * a declined route minted and dropped. The bytes charges already see what it would: lowering work is
 * linear in the plan the tree-size charges measure.
 */
export class CompileBudget {
  #peak = 0;

  constructor(readonly limit: number = COMPILE_BUDGET_BYTES) {}

  /** The largest charge so far — the instrument a compile-cost regression shows up in. */
  get peak(): number { return this.#peak; }

  /** Charge one statement's (lower-bound) bytes; past the limit, the compile declines. */
  charge(bytes: number): void {
    if (bytes > this.#peak) this.#peak = bytes;
    if (bytes > this.limit) throw new CompileBudgetExceeded(this.limit);
  }
}

/**
 * The decline: an ordinary query failure, returned to the client on the trailer like any other
 * `UnsupportedTraversal`. Its own class so the compile boundary can say WHICH part of the query
 * expanded (`compilePlan` names a large `times()`), which only the query text knows.
 */
export class CompileBudgetExceeded extends UnsupportedTraversal {
  constructor(readonly limit: number, hint?: string) {
    const sentence = `it expands to more than ${Math.round(limit / 1000)} KB of SQL in one statement${hint ? `; ${hint}` : ''}`;
    super(sentence);
    this.message = UnsupportedTraversal.because(sentence).message;
  }

  /** The same decline, naming the part of the query that expanded. */
  hinted(hint: string): CompileBudgetExceeded {
    return new CompileBudgetExceeded(this.limit, hint);
  }
}
