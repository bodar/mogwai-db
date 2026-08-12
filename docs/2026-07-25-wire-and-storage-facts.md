# Wire and storage facts

These are durable protocol and representation constraints.

## Map entries

GraphBinary has no distinct `Map.Entry` type. An entry returned by `unfold()` frames as an ordinary
one-entry MAP; clients cannot distinguish it from a genuine map of size one. Preserve that rule at
the wire boundary, including typed numeric values inside the entry.

## Map values

A map stream is one whole-map value per relation row, represented as an ordered JSON pair array. It
is not an entry relation. Convert it to entry rows only for `unfold()` or root framing.

Scalar map members always use self-describing `{t,v}` nodes. Elements and lists retain their own
representations. This is the one encoding shared by every map producer and decoder; do not add a
bare-scalar variant merely to save a JSON wrapper at a barrier.
