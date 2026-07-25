# src/compiler/steps — the lowering surface

_Scope: `src/compiler/steps/**`. The engine/passes/DI that dispatch here are in `src/compiler/CLAUDE.md`
(this seam reaches the engine via `engineOf(stream)`). SQL kernel: `src/sql/CLAUDE.md`._

The read prefix is a functional fold of `StepFn`s over an immutable typed **`Stream`** union
(element/scalar/variant/list/property/record/group/path). `lowerSteps` is the one shape
orchestrator; retypes flow it back through itself (`V().fold().unfold().out()` = elements→list→
elements). Emission-order and child-scope rationale: the dated design docs in `docs/`.

## Guardrails

- **`lowerSteps` is the single semantic authority for read traversals**, at root and child scope.
  To add a step: write a `StepFn`, register it in the right Map (never grow a switch); for a child,
  push a `ChildScope` and run the same engine; materialize only at the root.
- **Never build a second implementation.** No private child-traversal parser, no `compileNested*`
  mini-compiler, no sibling/index scanning inside a step compiler, no second movement/filter/
  projection path, no materializing from a read leaf. If a step needs one of these, the design is
  wrong — reuse the generic seam instead.
- **The child seam is parent-shape-polymorphic** (element/property/scalar parents share one
  dispatcher) and lives in three cohesive files — `tail/child-shape.ts` (pure classify leaf) ◂
  `tail/child.ts` (compilers) ◂ `tail/scalar-arm.ts` (scalar-parent arms). Extend by adding to the
  classifier + the compiler — never by reaching for a per-concern object (evaluated and rejected).
- **Fail closed, never mis-execute.** An unsupported shape throws a clear deferral or falls through
  to the generic path; it never silently answers a different question.
