# Shape vocabulary boundaries

Several structures use `kind`; they are not one unfinished cross-layer algebra. Read this before a
shape refactor.

## The three questions

Every vocabulary answers one of these questions:

| Question | Owner |
|---|---|
| What Gremlin value does a traverser hold? | streams, payload shapes, aliases, child/arm classifiers |
| Which relational columns carry it? | lowering projections and layouts |
| How do rows frame on the wire? | `Shape` and `src/execute.ts` |

One logical value can have several physical encodings, and one physical encoding can serve several
logical uses. That mismatch is load-bearing: do not merge vocabulary merely because names overlap.
`Stream` is also a capability partition—making a foreign or property stream an element stream would
make invalid movement structurally reachable.

## Bright line

A compiler Pass may consult a shape only when the chain itself proves it (for example, a producer
whose step name fixes vertex or edge output). It may never construct shape, and it must not silently
decline because a shape guess is unknown. Shape propagation belongs to lowering, where its entry
shape and payload layout are explicit. This protects fail-closed behaviour: a bad lowering throws,
whereas a skipped Pass can silently change the query.

## What to consolidate

Consolidate only a demonstrated duplicate authority. A good pattern is a total discriminated union,
a named preserving rebuild, and a runtime contract at the boundary. `ScalarType` and the payload
column helpers are the model: preserve exact type/member information, derive coarse views, and make
omission a type or runtime failure.

The recurring information-loss bug is a coarse list description that omits its member shape. Retain
member shape in aliases, collection descriptors, and generated-test state; do not replace it with a
single generic `list` kind.

The useful anchors are `src/compiler/rel/` payload builders, `src/compiler/rel/child.ts` for child
classification, `src/channels.ts` for carried relational state, and `src/execute.ts` for byte
framing. Trace a value across those boundaries before naming any duplication accidental.

## Refused refactors

- A universal cross-layer shape algebra.
- Shape fields on RelIR nodes.
- A broad child/branch shape union that claims a form is mergeable before its merge exists.

Before proposing structure, measure a concrete defect class and prove the existing seam cannot
express the needed form. Most historical failures were dropped carried columns or route reachability,
not vocabulary duplication.

## Investigation method

For a proposed consolidation, write down the question each candidate type answers, list every
producer and reader, and identify the preserving rebuild and runtime assertion that make loss
visible. If the evidence is only similar spellings, leave it alone. If a new field would cause a
Pass to make a shape decision, stop: that belongs to lowering or to a proved, syntax-only anchor.
