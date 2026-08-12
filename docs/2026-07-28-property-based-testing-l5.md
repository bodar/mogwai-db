# L5 property testing

L5 measures composition that no fixed corpus can enumerate. Current commands and mechanics live in
`test/L5-properties/README.md`; this document records the test architecture.

## Independent generators and oracles

The generator is a hand-written Gremlin shape lattice, not a reflection of compiler dispatch. The
grammar admits syntactically valid nonsense; compiler dispatch would define validity as current
support and hide valid-but-unsupported traversals. The lattice must retain distinctions such as
vertex versus edge and a collection's member shape. `table.test.ts` guards every generated chain by
parsing and chaining it.

The generator lives in `test/L5-properties/shape.ts`; fast-path declarations live in
`src/compiler/options/fast-paths.ts`; laws and capability signatures live beside the generator.
Keep these authorities independent: the generator states legal Gremlin composition, while the
compiler states what it currently lowers.

Three complementary oracles are required:

- **Fast-path differential:** enabled and disabled fast paths must produce the same result. The
  generic path is the semantic authority, so disagreement is a defect.
- **Metamorphic laws:** equivalent traversals, such as movement expansions or filter partitions,
  must agree in generated contexts. These detect defects shared by both differential sides.
- **Capability discipline:** generated work may return rows or a declared deferral, but never a raw
  compiler or SQLite failure. This is the fail-closed contract exercised compositionally.

No one oracle subsumes the others. A differential cannot see a defect both implementations share;
a metamorphic law cannot establish every concrete value; a capability test cannot establish a result.

## Ratchets and reproduction

The gate has no acceptance list of known failures. Known signatures carry a diagnosis and stale
entries fail once they stop reproducing. Record one root cause rather than every generated spelling.

The normal test derives its seed from `HEAD`, prints it, and accepts `L5_SEED` for reproduction.
Thus a commit has the same generated corpus locally and in CI, while successive commits explore
new inputs. Deeper random sweeps may vary independently, but must print a replayable seed.

## Use

When adding a fast path, a route gate, or shape-sensitive lowering, add or strengthen the relevant
property first. Treat a new signature as a diagnosis task, not an exclusion to normalize away.

When extending the lattice, first trace the corresponding TinkerPop step's input/output contract in
the vendored core. Add a parse-and-chain witness for the new transition and at least one law or
capability expectation that could fail if the compiler silently accepts the wrong shape.
