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
 *    repeat splices, at the cheapest step's bytes. It reads the same limit and throws the same decline
 *    (`kind: 'unroll'`); it runs in the Pass tier, which no lowering state reaches, and it is a function of
 *    the query text alone. What the unroll SPLICED reaches the meter later, from the host that lowers it
 *    (`noteUnroll`), so a decline past another limit can still name the count.
 *  - every EXPRESSION's tree size, before any rel pass (`lowered`, `compiler/rel/lower.ts`): an `Expr` is
 *    spelled per use at every stage, and the passes walk and rewrite it as that tree, so a shared
 *    expression that would be spelled 2^k times is refused here, in milliseconds (`largestExpression`).
 *  - each binding's TREE SIZE, relations included, before `checkPlan` and the emitter walk it
 *    (`emitProgram`, `src/rel/emit.ts`) — after naming, when a shared relation left inline (a correlated
 *    subplan) is certain to be spelled per use (`spelledSize`).
 *  - the RENDERED BYTES, counted as the renderer writes them (`render`, `kernel/q.ts`) — exact over the
 *    statement's STRUCTURE: a placeholder counts as its `?` and a string constant as its two quotes
 *    (`TextLiteral`), because a constant's payload is data the compile copies, not work it does. Counted in
 *    full it made this a function of a VALUE's size — a parameter that reaches the text as a constant (a
 *    `mergeV($m)` member) declined on the size of the data. A parameterised property's own value and its
 *    FTS text bind (`write.ts` `ftsTextExpr`), so their statements do not grow with the value at all.
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
  #unroll: UnrollNote | null = null;

  constructor(readonly limit: number = COMPILE_BUDGET_BYTES) {}

  /** The largest charge so far — the instrument a compile-cost regression shows up in. */
  get peak(): number { return this.#peak; }

  /** Charge one statement's (lower-bound) bytes; past the limit, the compile declines CARRYING which
   *  charge fired, so the decline says what grew from that fact rather than from a re-read of the query. */
  charge(bytes: number, what: BudgetCharge): void {
    if (bytes > this.#peak) this.#peak = bytes;
    if (bytes > this.limit) throw new CompileBudgetExceeded(this.limit, what, bytes);
  }

  /**
   * AN UNROLL THE LOWERING MET, with what its HOST allows. Recorded by the host that lowers a body holding
   * unrolled steps (`IRStep.unrolled`, stamped by `tryUnroll`), because only the host knows whether its body
   * is a per-traverser MAP (`local`/`map`/`flatMap`: the repeat could move to the top level) or a TEST
   * (`where`/`not`/…: it could not). The largest count is kept — the one a decline past a limit names.
   */
  noteUnroll(note: UnrollNote): void {
    if (!this.#unroll || note.times > this.#unroll.times) this.#unroll = note;
  }

  /** The largest unroll the lowering met, or `null` when none was noted. */
  get unroll(): UnrollNote | null { return this.#unroll; }
}

/**
 * WHICH charge a compile made — what a decline past the budget says grew, in the user's terms:
 *  - `unroll`: the unroll's early charge (`ir/strategies.ts` `tryUnroll`), decided from the count alone.
 *    `advice` is what the user can do instead, decided where the facts are: `loop` (a ROOT-chain body the
 *    walk takes, so `until(loops().is(n))` runs it as a loop), `barrier` (a body only phases run) or `count`
 *    (a body inside a child traversal, whose host's route the Pass tier cannot see — so nothing is offered
 *    that might decline in its turn).
 *  - `expression` / `plan`: a tree size read off a shared DAG — text that compounds per level of sharing.
 *  - `text`: the rendered bytes of the statement's STRUCTURE, with `literalBytes` of quoted constants (the
 *    payload `TextLiteral` keeps out of the charge, `kernel/q.ts`) counted beside them.
 */
export type BudgetCharge =
  | { readonly kind: 'unroll'; readonly times: number; readonly steps: number; readonly emit: boolean; readonly advice: 'loop' | 'barrier' | 'count' }
  | { readonly kind: 'expression' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'text'; readonly literalBytes: number };

/** An unroll the lowering met (`CompileBudget.noteUnroll`). `host` names the map-like host step its body
 *  sits in (`local`, `map`, `flatMap`) — where moving the repeat() to the top level is a choice the user
 *  has — else `null`; `loops` says `until(loops().is(n))` would run it as a loop instead, which is only
 *  claimed where the walk is known to take the body (the root chain, a body without a barrier). */
export interface UnrollNote { readonly times: number; readonly host: string | null; readonly loops: boolean }

/** WHAT THE UNROLL'S EARLY CHARGE PUTS ON ONE SPLICED STEP — the cheapest step that renders, so the charge
 *  stays a lower bound (the sizing argument is at `tryUnroll`, `ir/strategies.ts`). Here because the
 *  decline states the step count the budget stands for. */
export const UNROLLED_STEP_BYTES = 40;

/**
 * QUOTED CONSTANTS DOMINATE THE TEXT — the hint both text limits give (the compile's rendered-bytes charge,
 * and a store's statement cap at `GraphStore.query`), and only when at least half of what they measured is
 * literal values. Those are values the user wrote INTO the query (`inject([name:'a'], …)`, a `mergeV([…])`
 * map): each is spelled as SQL text, so a large literal batch is a long statement however few parameters it
 * binds. `null` otherwise, so no other cause is ever blamed on literals.
 */
export function literalTextHint(literalBytes: number, otherBytes: number): string | null {
  if (literalBytes === 0 || literalBytes < otherBytes) return null;
  return `most of it is literal values written into the query (${Math.max(1, Math.round(literalBytes / 1000))} KB of quoted constants), `
    + 'which are spelled into the SQL text itself, not bound as parameters — send the values in smaller batches';
}

/**
 * The decline: an ordinary query failure, returned to the client on the trailer like any other
 * `UnsupportedTraversal`. Its own class, carrying the charge that fired (`charged`), so the compile
 * boundary says WHICH part of the query expanded from that fact (`expansionNamed`, `compiler.ts`).
 */
export class CompileBudgetExceeded extends UnsupportedTraversal {
  constructor(readonly limit: number, readonly charged: BudgetCharge, readonly bytes: number = limit + 1, hint?: string) {
    const sentence = charged.kind === 'unroll' ? unrollSentence(limit, charged)
      : `it expands to more than ${Math.round(limit / 1000)} KB of SQL in one statement${hint ? `; ${hint}` : ''}`;
    super(sentence);
    this.message = UnsupportedTraversal.because(sentence).message;
  }

  /** The same decline, naming the part of the query that expanded. */
  hinted(hint: string): CompileBudgetExceeded {
    return new CompileBudgetExceeded(this.limit, this.charged, this.bytes, hint);
  }
}

/**
 * A child body whose normalization RAISED is a deferral (`bodyOf`, `rel/lower/chain.ts`, and the other
 * `null`-total body readers) — except one past this budget. That decline is a property of the query text and
 * the final answer for every route (each route that lowers the body unrolls it the same way), so it is
 * rethrown: swallowed, it read as "no lowering covers …" where the unroll's own decline names the count.
 */
export function pastBudget(error: unknown): null {
  if (error instanceof CompileBudgetExceeded) throw error;
  return null;
}

/** The unroll's early decline, said from the count — all the charge needed to decide it. */
function unrollSentence(limit: number, { times, steps, emit, advice }: Extract<BudgetCharge, { kind: 'unroll' }>): string {
  return `a repeat() bounded at ${times} iterations (times(${times}), or an until(loops().is(…)) that first holds there)${emit ? ' with emit()' : ''} `
    + `unrolls to about ${Math.round(steps)} steps, more than the ${Math.floor(limit / UNROLLED_STEP_BYTES)} the compiler spells into one statement (${Math.round(limit / 1000)} KB of SQL); `
    + (advice === 'loop' ? 'lower the count, or bound the loop with until(loops().is(n)), which a body without a barrier runs as a loop rather than unrolled'
      : advice === 'barrier' ? 'lower the count — a body holding a barrier (order/limit/range/dedup/aggregate/…) runs only as unrolled iterations'
      : 'lower the count');
}

/**
 * A statement whose one `SELECT` would join more tables than SQLite plans (`SQLITE_JOIN_TABLES`,
 * `src/rel/emit.ts`) — the decline the store gives that statement, raised by the assembler before it spells
 * the rest. A sibling of `CompileBudgetExceeded` with the same contract: the compile boundary names the
 * unroll the lowering noted (`CompileBudget.unroll`), if any.
 */
export class JoinWidthExceeded extends UnsupportedTraversal {
  constructor(readonly limit: number, hint?: string) {
    const sentence = `it joins more than ${limit} tables in one SQL SELECT, SQLite's limit${hint ? `; ${hint}` : ''}`;
    super(sentence);
    this.message = UnsupportedTraversal.because(sentence).message;
  }

  /** The same decline, naming the part of the query that expanded. */
  hinted(hint: string): JoinWidthExceeded {
    return new JoinWidthExceeded(this.limit, hint);
  }
}

/**
 * A random draw that a per-traverser body would read through two copies — the decline `name`
 * (`src/rel/passes/name.ts`) raises for a shared CORRELATED relation that DRAWS (`draws`,
 * `src/rel/copies.ts`). SQLite evaluates each spelling of an inline relation on its own (no LATERAL, and an
 * `AS MATERIALIZED` CTE inside a correlated subquery is re-evaluated per reference, measured), so two
 * branches over one `out().order().by(shuffle).limit(1)` would each pick a different vertex. A sibling of
 * `JoinWidthExceeded` with the same contract: a property of the query text, raised from the algebra, which
 * may not import the compiler.
 */
export class CopiedDraw extends UnsupportedTraversal {
  constructor() {
    const sentence = 'a random draw (order().by(shuffle), sample(), coin()) that more than one branch reads inside a '
      + 'per-traverser body (local(), map(), a by() or a branch arm) is not supported: each branch would draw again '
      + 'and see a different pick. Draw in the outer traversal instead, e.g. local(out().sample(1)).union(…)';
    super(sentence);
    this.message = UnsupportedTraversal.because(sentence).message;
  }
}
