# Wire and storage facts

Durable GraphBinary and payload-model facts. This is not a capability plan; see the feature
matrix for support.

## Map entries

A server-side `Map.Entry` has no GraphBinary v4 data type. It crosses a GLV as a normal
size-one `MAP`, indistinguishable from a genuine one-entry map. Frame map-entry rows with the
existing map helpers in `src/execute.ts`; never invent an entry wire tag. The pinned TinkerPop
reference confirms this through `MapEntrySerializer` and the GLV assertion harness.

This distinction matters: a terminal group map follows the ordinary map framing route, while an
entry produced by `unfold()` must frame one map per entry row.

## Map values

`MapStream` is one JSON map value per row, encoded as ordered `[[keyNode, valueNode], ...]`
pairs. It is not an entry relation. Keep that blob through the compiler; convert it to entry rows
only for `unfold()` or root materialization. Turning every map into rows earlier loses the value /
entry distinction and leaks a wire decision into lowering.

Scalar map sides are always self-describing `{t, v}` nodes. This is required for heterogeneous
map keys and values to round-trip through one reader. Elements and lists use their own payload
forms; do not force them into a scalar envelope. Every map producer must build this common form.

## Framing modes

The value framer has exactly two type authorities: a static type for a homogeneous column or a
per-row type column. Keep them mutually exclusive in code and preserve the per-row tag across a
barrier, merge, or re-entry. If this representation is touched, prefer a discriminated union over
optional flags; the invariant is more important than the spelling.
