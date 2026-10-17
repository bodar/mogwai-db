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
  constructor(readonly gremlin: string) {
    super(`this traversal is not supported yet: no lowering covers ${gremlin}`);
    this.name = 'UnsupportedTraversal';
  }
}
