// The host table for the host-closure law (`host-closure.test.ts`).
//
// A HOST is a step that takes a child traversal and runs it relative to each incoming traverser (or, for
// `union`, to the incoming stream). The compositional-coverage plan's thesis
// (`docs/2026-11-15-compositional-coverage-plan.md` §2 S4) is that a host is a CONNECTOR — scope the
// input, lower the body the way the root is lowered, reconnect by a policy — so a body that lowers at the
// top level should lower under every host. This table is the set of hosts that claim is measured over.
//
// Each row states WHEN the host is well-typed for a body (by the shape lattice, `shape.ts`), how it is
// written, and the shape it leaves the stream in (so a host can itself be a body: `H1(H2(b))`). Typing
// follows Java's generics, not what the compiler happens to admit — the latter would make the closure
// rate a tautology:
//   • `optional`/`coalesce(b, identity())`/`union(b, identity())` merge the body's output with the host's
//     INPUT, so they are well-typed only where the body ends at the shape it started from
//     (`optional(Traversal<?, E>)`, `coalesce(Traversal<?, E2>...)` with `identity()` an arm).
//   • `order().by(b)` needs a comparable by-value: a scalar.
//   • `group().by(label)` keys on an element's label: an element input.
import type { Shape } from './shape.ts';

export interface Host {
  readonly name: string;
  /** Is the host well-typed over input shape `from` with a body ending at `to`? */
  readonly applies: (from: Shape, to: Shape) => boolean;
  /** The host step, given the body as an anonymous traversal (`__.…`). */
  readonly render: (anon: string) => string;
  /** The shape the host leaves the stream in. */
  readonly out: (from: Shape, to: Shape) => Shape;
}

const always = () => true;
const sameShape = (from: Shape, to: Shape) => from === to;
const element = (from: Shape) => from === 'vertex' || from === 'edge';

export const HOSTS: readonly Host[] = [
  { name: 'map', applies: always, render: (b) => `map(${b})`, out: (_f, t) => t },
  { name: 'flatMap', applies: always, render: (b) => `flatMap(${b})`, out: (_f, t) => t },
  { name: 'local', applies: always, render: (b) => `local(${b})`, out: (_f, t) => t },
  { name: 'where', applies: always, render: (b) => `where(${b})`, out: (f) => f },
  { name: 'filter', applies: always, render: (b) => `filter(${b})`, out: (f) => f },
  { name: 'not', applies: always, render: (b) => `not(${b})`, out: (f) => f },
  { name: 'optional', applies: sameShape, render: (b) => `optional(${b})`, out: (f) => f },
  { name: 'coalesce', applies: sameShape, render: (b) => `coalesce(${b}, __.identity())`, out: (f) => f },
  { name: 'union', applies: sameShape, render: (b) => `union(${b}, __.identity())`, out: (f) => f },
  { name: 'project', applies: always, render: (b) => `project('x').by(${b})`, out: () => 'record' },
  { name: 'group', applies: (f) => element(f), render: (b) => `group().by(label).by(${b}.fold())`, out: () => 'group' },
  { name: 'order', applies: (_f, t) => t === 'scalar', render: (b) => `order().by(${b})`, out: (f) => f },
  { name: 'dedup', applies: always, render: (b) => `dedup().by(${b})`, out: (f) => f },
];

