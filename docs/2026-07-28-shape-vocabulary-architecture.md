# Shape vocabulary boundaries

Only consolidate a shape vocabulary when it removes a demonstrated wrong-answer path. The compiler
may consult shape; only lowering constructs it. `Shape` remains the boundary between SQL payload
projection and GraphBinary framing: RelIR owns the former, the wire layer owns the latter.

The outstanding substrate work is deliberately narrow:

- Make carried traversal layout construction total and checked. Every rebuild must explicitly retain
  or drop each carried role; no ad-hoc spreads.
- Keep row-to-traverser cardinality explicit before sharing relational row operations. `COUNT(*)`
  and `COUNT(DISTINCT ...)` are not interchangeable across stream shapes.
- Replace optional-field encodings only when a single tagged union removes an observable ambiguity.
  Do not attempt a cross-layer shape algebra, merge `Stream` with `Shape`, or widen child maps to
  avoid a deferral.

The IR annotation experiment was run and rejected: its unknown rate was far above the predeclared
threshold. Keep shape classifiers in lowering. The feature-support matrix is the current evidence
for a step's valid positions; do not infer support from its name alone.
