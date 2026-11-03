/**
 * WHY a decline is raised — a CLOSED vocabulary, one name per explained decline the lowering records.
 *
 * `'uncovered'` is the default: no lowering covers the traversal, and nothing more specific is known.
 * Every other kind is a decline the lowering DECIDED on a fact it holds (a framing, a host's presence),
 * and it is recorded into the compile's `Declines` sink rather than thrown, because `lowerToRel` must
 * return `null`, never throw (`scripts/rel-sweep.ts`).
 */
export type DeclineKind =
  | 'uncovered'
  /** A random draw in an uncorrelated V()/E() body evaluated for several hosts (`rootedRead`). */
  | 'shared-draw'
  /** A re-sourcing V()/E() body under a host value that MAY be absent (`reSourcedUnder`). */
  | 'resource-under-absent'
  /** A merge `select(k)` over a stream of Maps that MAY hold `k`, colliding with a side effect `k`
   *  (`mergedFromMap`). */
  | 'merge-map-scope'
  /** A merge `select(k)` reading a Map's own `k` entry as the merge argument (`mergedFromMap`). */
  | 'merge-own-entry'
  /** A `select(k)` over Maps that MAY hold a key `k` while a side effect or path label `k` is also in scope
   *  (`mapKeyCollision`, `rel/lower.ts`). Always ADVISORY — a hint appended to the generic decline. */
  | 'map-key-collision';

/**
 * THE PREFIX IS A PROPERTY OF THE KIND, kept in this one table. Most declines say the traversal is
 * outside what we compile ("not supported yet"). A kind whose shape almost certainly signals a CONFUSED
 * query, where the faithful answer would silently depend on which rows matched, says "ambiguous"
 * instead. That decline is an explanation, not a missing feature.
 */
const PREFIX: Readonly<Record<DeclineKind, string>> = {
  'uncovered': 'this traversal is not supported yet',
  'shared-draw': 'this traversal is not supported yet',
  'resource-under-absent': 'this traversal is ambiguous',
  'merge-map-scope': 'this traversal is not supported yet',
  'merge-own-entry': 'this traversal is not supported yet',
  // Advisory only, so the generic prefix is what the user reads; listed because the table is total.
  'map-key-collision': 'this traversal is ambiguous',
};

/**
 * A traversal the compiler cannot lower to SQL — a step, or a COMBINATION of steps, that has no
 * lowering yet.
 *
 * Its own class rather than a bare `Error` so a caller can tell an unsupported query from a broken
 * one: this is the user's traversal being outside what we compile, which is a deferral, while
 * anything else escaping a compile is a defect. Same distinction the Pass tier draws with `Deferral`.
 *
 * A LEAF module (re-exported by `compiler.ts`) so a Pass or a service can raise it without importing the
 * compiler entry point — an import that closes a module cycle and reorders initialisation.
 */
export class UnsupportedTraversal extends Error {
  constructor(readonly gremlin: string, readonly kind: DeclineKind = 'uncovered') {
    super(`${PREFIX[kind]}: no lowering covers ${gremlin}`);
    this.name = 'UnsupportedTraversal';
  }

  /** A decline whose reason is a whole SENTENCE rather than the traversal (or a noun phrase naming what
   *  is uncovered) — `no lowering covers withStrategies(...) is not supported: …` read as garbled. */
  static because(sentence: string, kind: DeclineKind = 'uncovered'): UnsupportedTraversal {
    const declined = new UnsupportedTraversal(sentence, kind);
    declined.message = `${PREFIX[kind]}: ${sentence}`;
    return declined;
  }
}

/** One reason the lowering recorded. `terminal` is a decline that holds whatever else the compile
 *  finds (today's throw). Otherwise it is ADVISORY: a hint about why a probe declined, which may be a
 *  speculative route that is not why the whole compile declined. */
export interface DeclineReason {
  readonly kind: Exclude<DeclineKind, 'uncovered'>;
  readonly message: string;
  readonly terminal: boolean;
}

/**
 * THE PER-COMPILE DECLINE-REASON CHANNEL — the one sink a compile's lowerings record into, created once
 * in `compilePlan` and carried in the `Lowering` options (so every segment, barrier and resume route
 * inherits it) and on `ChainCtx`.
 *
 * It exists because a lowering DECLINES by returning `null` and never throws (`scripts/rel-sweep.ts`),
 * so a decline it decided on a FRAMING fact (not on the query text alone) could otherwise only say "no
 * lowering covers …". The lowering records the reason here and returns `null`. `compilePlan` reads it:
 *
 *   - a TERMINAL reason replaces the message and wins over everything else the compile finds, a covered
 *     sibling route included. The first one recorded is kept, exactly the throw it replaces.
 *   - an ADVISORY reason is only a HINT, appended to `no lowering covers …` when the whole compile
 *     declines. It never substitutes for that message, and a compile that answers never reports it.
 *
 * Mutable per-compile STATE threaded explicitly, like the relation-id minter (`src/compiler/CLAUDE.md`).
 */
export class Declines {
  #terminal: DeclineReason | null = null;
  #hint: string | null = null;
  #advisory: DeclineReason | null = null;

  /** Record a reason. The first terminal one and the first advisory one are kept. */
  note(reason: DeclineReason): void {
    if (reason.terminal) this.#terminal ??= reason;
    else this.#advisory ??= reason;
  }

  /** The terminal reason, if one was recorded. */
  terminal(): DeclineReason | null { return this.#terminal; }

  /** Add a host's suggestion to the terminal reason of `kind`, once. A nested host of the same kind has
   *  already said it, so its outer host does not repeat it. */
  hint(kind: DeclineReason['kind'], hint: string): void {
    if (this.#terminal?.kind === kind) this.#hint ??= hint;
  }

  /** The terminal decline as the error the user reads, or `null`. */
  terminalError(): UnsupportedTraversal | null {
    const t = this.#terminal;
    return t && UnsupportedTraversal.because(this.#hint ? `${t.message}; ${this.#hint}` : t.message, t.kind);
  }

  /** Throw the terminal decline, if one was recorded. */
  raiseTerminal(): void {
    const error = this.terminalError();
    if (error) throw error;
  }

  /** The decline for a compile that found no lowering. A terminal reason is the whole message. An
   *  advisory one is appended to `no lowering covers <gremlin>` as a hint, never put in its place. */
  uncovered(gremlin: string): UnsupportedTraversal {
    const terminal = this.terminalError();
    if (terminal) return terminal;
    const declined = new UnsupportedTraversal(gremlin);
    if (this.#advisory) declined.message = `${declined.message} — ${this.#advisory.message}`;
    return declined;
  }
}
