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
  /** A re-sourcing V()/E() body under a FIRST-row host (`map`/`by()`/a filter) whose steps after the re-source
   *  read the host traverser's state (`reSourcedBody`). Always ADVISORY. */
  | 'resource-reads-host'
  /** A re-sourcing V()/E() body on a traverser whose path is tracked, where the child's path would leave the shared
   *  read: under a host that forwards the child's traverser (`local`), or a body that reads the path itself
   *  (`reSourcedBody`). `flatMap` splits the HOST's traverser, so a path around it is not this. Always ADVISORY. */
  | 'resource-path'
  /** A merge `select(k)` over a stream of Maps that MAY hold `k`, colliding with a side effect `k`
   *  (`mergedFromMap`). */
  | 'merge-map-scope'
  /** A merge `select(k)` reading a Map's own `k` entry as the merge argument (`mergedFromMap`). */
  | 'merge-own-entry'
  /** A `select(k)` over Maps that MAY hold a key `k` while a side effect or path label `k` is also in scope
   *  (`mapKeyCollision`, `rel/lower.ts`). Always ADVISORY — a hint appended to the generic decline. */
  | 'map-key-collision'
  /** `inject(x)` with values inside a CHILD traversal (a `local`/`map`/`by`/branch-arm body), where the
   *  reference injects only for the FIRST host it runs for (`injectTail`, `rel/lower.ts`). Always ADVISORY. */
  | 'inject-in-child'
  /** A graph write inside a filter body (`where`/`filter`/`not`/`and`/`or`, found by `programWrites`,
   *  `rel/write.ts`): no route lowers an effect inside an existence test yet. */
  | 'write-in-filter'
  /** A graph write inside any OTHER child body (`local`/`union`/`coalesce`/`sideEffect`/a `by()`, … — found by
   *  `programWrites`): no lowering runs an effect inside a child yet. Always ADVISORY. */
  | 'write-in-child'
  /** A graph write on a traverser whose PATH is tracked (a `path()`/`simplePath()`/`cyclicPath()`/`tree()` in the
   *  traversal): no write lowering appends its element as a path position yet. Always ADVISORY. */
  | 'write-on-path'
  /** A random draw inside a `group()` value `by()` (`pooledGroup`, `lower/scoped.ts`). Always ADVISORY. */
  | 'draw-in-group-value'
  /** A side effect collected inside a child body (`aggregate`/`group`/`groupCount` with a label) that the
   *  connector could not key per traverser (`keyedBody`, `lower/scoped.ts`). Always ADVISORY. */
  | 'effect-in-child';

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
  'resource-reads-host': 'this traversal is not supported yet',
  'resource-path': 'this traversal is not supported yet',
  'merge-map-scope': 'this traversal is not supported yet',
  'merge-own-entry': 'this traversal is not supported yet',
  // Advisory only, so the generic prefix is what the user reads; listed because the table is total.
  'map-key-collision': 'this traversal is ambiguous',
  'inject-in-child': 'this traversal is not supported yet',
  'write-in-filter': 'this traversal is not supported yet',
  'write-in-child': 'this traversal is not supported yet',
  'write-on-path': 'this traversal is not supported yet',
  'draw-in-group-value': 'this traversal is not supported yet',
  'effect-in-child': 'this traversal is not supported yet',
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

/**
 * A GRAPH WRITE FOUND IN A CHILD BODY, classified ONCE where it is found (`programWrites`' walk over every
 * child, `rel/write.ts`), so the decline that names it never re-tests the host.
 *
 *  - `host`: the innermost host, as the user would name it (a step name, or `group().by` for a `by()`);
 *  - `write`: the write's own step name;
 *  - `filter`: the host is an existence test (`FILTER_HOSTS`);
 *  - `upsert`: the write has the UPSERT idiom's shape — an `addV`/`addE` in a branch body
 *    (`fold().coalesce(unfold(), addV(…))`), which `mergeV()`/`mergeE()` answer. A `property()`/`drop()`, or a
 *    merge (already an upsert), is told to move out instead;
 *  - `at`: the TOP-LEVEL step whose body holds the write — the position the fold must have declined AT for the
 *    write to be why the traversal declined (`lowerChain`); `null` where the host has no lowering of its own to
 *    decline at (a write as another write's argument).
 */
export interface ChildWrite {
  readonly host: string;
  readonly write: string;
  readonly filter: boolean;
  readonly upsert: boolean;
  readonly at: object | null;
}

/**
 * THE ONE BUILDER for the decline that names a graph write in a child body (`ChildWrite`), read by `lowerChain`.
 *
 *  - A FILTER host is `write-in-filter`, TERMINAL: no route runs an effect inside an existence test, and the
 *    write must never be silently skipped.
 *  - Any other host is ADVISORY — a hint appended to "no lowering covers …", so the day a child write lowers, a
 *    route that answers is never shadowed by it — given only where the fold declined at the write's host.
 *    `certain` says whether that is known: where it is not, the hint says the write MAY be why rather than
 *    blaming it for a decline it may not have caused.
 */
export const writeInChild = (child: ChildWrite, certain = true): DeclineReason =>
  child.filter
    ? {
      kind: 'write-in-filter', terminal: true,
      message: `a write (${child.write}()) inside ${child.host}() — a filter body that writes; to write and then filter, put the `
        + `write before or after ${child.host}()`,
    }
    : {
      kind: 'write-in-child', terminal: false,
      message: `a write (${child.write}()) inside ${child.host}() ${certain ? 'is not supported yet' : 'may not be supported here'}; `
        + (child.upsert
          ? 'for an upsert (fold().coalesce(unfold(), addV(…))) use mergeV()/mergeE()'
          : 'put the write in the outer traversal'),
    };

/** The `write-on-path` decline: the write step (`write`, its name) meets a traverser whose path is tracked. Noted
 *  where the write's own lowering declines on that framing fact, at any depth — so a write in a branch arm is not
 *  blamed on the branch (`writeInChild`) when the path is why: an advisory recorded first is the one kept. */
export const writeOnTrackedPath = (write: string): DeclineReason => ({
  kind: 'write-on-path', terminal: false,
  message: `a write (${write}()) on a traverser whose path is tracked (a path(), simplePath(), cyclicPath() or tree() `
    + 'in the traversal) is not supported yet',
});

/** The `draw-in-group-value` decline (`pooledGroup`, `lower/scoped.ts`). */
export const drawInGroupValue: DeclineReason = {
  kind: 'draw-in-group-value', terminal: false,
  message: 'a random draw (sample()/coin()/order().by(shuffle)) inside a group() value by() is not supported yet',
};

/** The `effect-in-child` decline (`keyedBody`, `lower/scoped.ts`): the collection(s) a child body of `host`
 *  filled, named as the user wrote them, and the one form that is known not to key — a read of the collection
 *  inside the body that fills it. */
export const effectInChild = (host: string, labels: readonly string[]): DeclineReason => ({
  kind: 'effect-in-child', terminal: false,
  message: `a side effect (${labels.map((label) => `'${label}'`).join(', ')}) collected inside ${host}() is not supported `
    + 'in this form yet (for example, read with cap()/select() inside the same child that fills it)',
});

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
  /** How far the fold got into each step list it continued (`continueAs`'s `from`): every step before that
   *  position LOWERED on some route. Shared with every `fork` — a speculative route that got past a step proves
   *  the step lowers, whatever the route's outcome. What a child write's decline asks (`lowerChain`), never a
   *  routing input. */
  readonly #furthest: WeakMap<readonly object[], number>;

  constructor(furthest: WeakMap<readonly object[], number> = new WeakMap()) { this.#furthest = furthest; }

  /** The fold has reached position `at` of `steps` — every step before it lowered. */
  reach(steps: readonly object[], at: number): void {
    if (at > (this.#furthest.get(steps) ?? -1)) this.#furthest.set(steps, at);
  }

  /** The furthest position of `steps` the fold reached, or `undefined` if it never continued that list. */
  furthest(steps: readonly object[]): number | undefined { return this.#furthest.get(steps); }

  /** Record a reason. The first terminal one and the first advisory one are kept. */
  note(reason: DeclineReason): void {
    if (reason.terminal) this.#terminal ??= reason;
    else this.#advisory ??= reason;
  }

  /** The terminal reason, if one was recorded. */
  terminal(): DeclineReason | null { return this.#terminal; }

  /**
   * A sink for a SPECULATIVE route — one of two lowerings of the same site, tried in turn
   * (`lower/scoped.ts`'s connector dispatch). What it records reaches this sink only through `adopt`: when
   * that route is the one that answered, or when no route did. A route that declined while its sibling
   * answered is not why the compile did anything, so its reasons are dropped — otherwise the order the
   * two routes are tried in (a fast-path switch) would decide whether the traversal compiles at all.
   */
  fork(): Declines { return new Declines(this.#furthest); }

  /** Take what a `fork` recorded, as if it had been recorded here — first-recorded still wins. */
  adopt(child: Declines): void {
    if (child.#terminal && !this.#terminal) { this.#terminal = child.#terminal; this.#hint ??= child.#hint; }
    if (child.#advisory) this.#advisory ??= child.#advisory;
  }

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
