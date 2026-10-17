// THE FAIL-CLOSED CONTRACT, as a positive check: a traversal either answers, DECLINES with
// `UnsupportedTraversal`, or raises the REFERENCE's own error. Anything else that escapes is an internal
// error — a plan we built ill-formed, SQL we emitted wrong, a raw JS fault, a bare `Error` from a seam
// that forgot to decline — and no query may surface one.
//
// Positive on purpose. A list of KNOWN internal-error shapes (`INTERNAL_ERROR`, `L5-properties/oracle.ts`)
// passes every internal error nobody has seen yet: measured, a bare `Error: federate: could not rewrite
// select("e") …` sailed through such a sweep. So the accepted set is spelled out, and it is small:
//   - `UnsupportedTraversal` — the decline (`src/compiler/compiler.ts`);
//   - `RaisedByQuery` — a reference error the DATA decided, raised mid-statement (`src/rel/raise.ts`);
//   - a throw whose message carries a reference error message — every text the TinkerPop corpus (and
//     our L4 addendum) asserts with `the traversal will raise an error with message … text of "…"`,
//     read from the feature files themselves (`expectedErrorSubstrings`, the same set L3 classifies by).
import { join } from 'node:path';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { expectedErrorSubstrings } from '../L3-conformance/telemetry.ts';

const ROOT = join(import.meta.dir, '..', '..');

let referenceMessages: readonly string[] | undefined;
/** Every error message the reference corpus and the L4 addendum assert, read once. */
export function referenceErrorMessages(): readonly string[] {
  return referenceMessages ??= [
    ...expectedErrorSubstrings(join(ROOT, 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features')),
    ...expectedErrorSubstrings(join(ROOT, 'test/L4-addendum')),
  ];
}

/** Is `error` an allowed way for a traversal to fail? (See the header.) */
export function failsClosed(error: unknown): boolean {
  if (error instanceof UnsupportedTraversal || error instanceof RaisedByQuery) return true;
  const message = error instanceof Error ? error.message : String(error);
  return referenceErrorMessages().some((m) => message.includes(m));
}

/** A one-line description of a throw, for a failure report. */
export const describeThrow = (error: unknown): string =>
  error instanceof Error ? `${error.constructor.name}: ${error.message.slice(0, 240)}` : String(error);
