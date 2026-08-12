# L5 property testing

L5 protects compiler refactors that ordinary conformance cannot: a changed lowering must either
preserve the result or fail closed, never quietly return a different result.

It uses complementary, deliberately independent checks:

- Differential executions compare supported traversal families across equivalent lowerings.
- Metamorphic laws test semantic identities where no external expected result is practical.
- The capability ratchet generates shape/transition witnesses and accepts only compilation or an
  explicitly declared deferral.

The oracle is not a coverage target and cannot prove unsupported traversals correct. Fixed seeds are
not sufficient: use the project seed/witness mechanism so a discovered counterexample remains
reproducible. Keep shape validity hand-written rather than reflecting dispatch tables; deriving the
oracle from the implementation would turn a missing capability into a passing test.

For active work and exact commands, see `test/CLAUDE.md` and `docs/outstanding-work.md`.
