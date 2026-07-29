// Metamorphic laws — L5's second oracle.
//
// The differential (oracle.ts) compares the two LOWERINGS against each other, so it can only ever
// see a disagreement. A defect present in BOTH is invisible to it by construction, and two such were
// found by hand while diagnosing it — one of them making an L3 scenario pass for entirely the wrong
// reason because two compensating bugs cancelled. Rationale:
// docs/2026-07-28-property-based-testing-l5.md.
//
// A metamorphic law closes that gap by comparing against a LAW rather than an implementation. Each
// law is a pair of traversals that Gremlin's semantics require to produce the same traverser
// multiset. Both sides run through the same lowering with the same config, so agreement is a
// statement about semantics, not about fast paths — exactly the axis the differential cannot test.
//
// WHAT MAKES THIS A PROPERTY TEST AND NOT A TABLE OF EXAMPLES: every law is instantiated over a
// GENERATED prefix (`generate.ts` `prefix`). `out(l) ≡ outE(l).inV()` as a fixed pair is one
// assertion; applied to a few hundred generated vertex-shaped contexts — behind filters, inside
// branches, after a repeat, under a slice — it is a claim about the step's composition.
//
// CHOOSING LAWS: every law here must be MULTISET-safe, because that is what the comparison checks.
// Two traps, both hit while writing this file:
//   • `order().by(key)` is NOT multiset-preserving — a non-productive by() DROPS traversers lacking
//     the key. Only bare `order()` is a permutation.
//   • `limit(n)`/`range` are order-sensitive, so no law may introduce one on only one side.
// A law that needs arithmetic rather than multiset equality (`count(where(b)) + count(where(¬b)) =
// count()`) is expressed as a union instead, which keeps the comparison uniform.

import type { Shape } from './shape.ts';

export interface Law {
  readonly name: string;
  /** The shape the generated prefix must land on. */
  readonly on: Shape;
  /** The spec fact being asserted — why the two sides MUST agree. Required: a law without a stated
   *  reason is an assumption, and a failing one would then be ambiguous between "bug" and "the law
   *  was wrong". */
  readonly why: string;
  readonly lhs: (prefix: string) => string;
  readonly rhs: (prefix: string) => string;
  /**
   * Contexts where this law is KNOWN to break, each with the defect diagnosed.
   *
   * Same discipline as `known.ts`: an entry is a BUG WE HAVE NOT FIXED, never an acceptable
   * exception — a law that is genuinely invalid in some context should be narrowed instead (as the
   * order() permutation law was narrowed to the bare form). Keyed on the PREFIX, because both
   * entries below are about the state the prefix leaves live, not about the law's own shape.
   */
  readonly knownBroken?: readonly { readonly prefix: RegExp; readonly diagnosis: string }[];
}

export const LAWS: readonly Law[] = [
  // ---- movement identities: the same walk expressed via the incident edge ----
  ...(['knows', 'created'] as const).flatMap((l): Law[] => [
    {
      name: `out(${l}) = outE(${l}).inV()`, on: 'vertex',
      why: 'out() IS the composition of the incident-edge hop and its head vertex — TinkerPop defines it that way, and SubgraphStrategy rewrites one into the other, so any difference is a movement-lowering defect.',
      lhs: (p) => `${p}.out('${l}')`, rhs: (p) => `${p}.outE('${l}').inV()`,
    },
    {
      name: `in(${l}) = inE(${l}).outV()`, on: 'vertex',
      why: 'The mirror of the out() identity, over the reverse-direction covering index.',
      lhs: (p) => `${p}.in('${l}')`, rhs: (p) => `${p}.inE('${l}').outV()`,
    },
    {
      name: `both(${l}) = union(out,in)`, on: 'vertex',
      why: 'both() is the multiset SUM of the two directions, not their set union — a self-loop must appear twice (CLAUDE.md). Comparing against an explicit union is what pins the multiset half.',
      lhs: (p) => `${p}.both('${l}')`, rhs: (p) => `${p}.union(__.out('${l}'),__.in('${l}'))`,
    },
    {
      name: `bothE(${l}).otherV() = both(${l})`, on: 'vertex',
      why: 'The edge-mediated form of both(), which routes through otherV() rather than a direct neighbour hop.',
      lhs: (p) => `${p}.bothE('${l}').otherV()`, rhs: (p) => `${p}.both('${l}')`,
    },
  ]),

  // ---- reducer identities ----
  {
    name: 'count() = fold().count(local)', on: 'vertex',
    why: 'A global count and the length of the folded list count the same traversers. These take entirely different lowering routes (a SUM over the relation vs. a JSONB array length), so agreement is a real cross-check — and it is the pair bulk arithmetic gets wrong first.',
    lhs: (p) => `${p}.count()`, rhs: (p) => `${p}.fold().count(local)`,
  },
  {
    name: 'count() = id().count()', on: 'vertex',
    why: 'id() is 1:1 on elements, so projecting before counting cannot change the count. Catches a projection that drops or duplicates rows.',
    lhs: (p) => `${p}.count()`, rhs: (p) => `${p}.id().count()`,
  },

  // ---- transparent wrappers (oracle 2's idea, folded in here: same comparison, same harness) ----
  {
    name: 'identity() is transparent', on: 'vertex',
    why: 'identity() emits its input unchanged, so appending it cannot alter the multiset. The weakest law here, and the baseline: if this one breaks, the prefix itself is not being lowered stably.',
    lhs: (p) => p, rhs: (p) => `${p}.identity()`,
  },
  {
    name: 'filter(identity()) is transparent', on: 'vertex',
    why: 'A filter whose body always produces admits every traverser — the fact isAlwaysProductiveFilterNoOp relies on, asserted independently of it.',
    lhs: (p) => p, rhs: (p) => `${p}.filter(__.identity())`,
  },
  {
    name: 'local(identity()) is transparent', on: 'vertex',
    why: 'local() over a one-element scope is the element itself. Targets the silent-[] class: a child scope that loses its parent rows.',
    lhs: (p) => p, rhs: (p) => `${p}.local(__.identity())`,
  },
  {
    name: 'union(q) = q', on: 'vertex',
    why: 'A one-arm union is that arm. This law is why the artificial `union() needs at least two branches` guard was found and removed.',
    lhs: (p) => p, rhs: (p) => `${p}.union(__.identity())`,
  },
  {
    name: 'fold().unfold() = q', on: 'vertex',
    why: 'The documented retype round-trip (steps/CLAUDE.md): collecting to a list and re-emitting restores the stream, so the whole fold/unfold substrate must be multiset-faithful.',
    lhs: (p) => p, rhs: (p) => `${p}.fold().unfold()`,
  },

  // ---- barrier identities ----
  {
    name: 'bare order() permutes only', on: 'vertex',
    why: 'order() re-sequences a stream; it never adds or drops a traverser. Bare only — order().by(key) legitimately DROPS traversers lacking the key (non-productive by()), so it is not a permutation and must not be asserted as one.',
    lhs: (p) => p, rhs: (p) => `${p}.order()`,
  },
  {
    name: 'dedup() is idempotent', on: 'vertex',
    why: 'dedup() yields a set, and de-duplicating a set changes nothing. A second dedup() that alters the answer means the first did not fully collapse.',
    lhs: (p) => `${p}.dedup()`, rhs: (p) => `${p}.dedup().dedup()`,
  },

  // ---- the partition law: the sharpest filter check ----
  {
    name: 'where(b) + where(not(b)) partitions', on: 'vertex',
    why: 'A predicate and its negation partition the stream exactly — every traverser lands in precisely one side. Expressed as a union so the check stays multiset equality rather than arithmetic. This is the law that catches a filter answering a THIRD thing (an always-false arm, a silently-dropped operand), because such a bug loses rows from both halves at once.',
    lhs: (p) => p,
    rhs: (p) => `${p}.union(__.where(__.out('knows')),__.where(__.not(__.out('knows'))))`,
  },
  {
    name: 'has(k) + hasNot(k) partitions', on: 'vertex',
    why: 'The property-existence form of the partition law, which exercises the has() leaf rather than a movement body.',
    lhs: (p) => p,
    rhs: (p) => `${p}.union(__.has('age'),__.not(__.has('age')))`,
  },
];
