# src/compiler/steps — the lowering surface

_Scope: `src/compiler/steps/**`. The engine/passes/DI that dispatch here are in `src/compiler/CLAUDE.md`
(this seam reaches the engine via `engineOf(stream)`). SQL kernel: `src/sql/CLAUDE.md`._

The read prefix is a functional fold of `StepFn`s over an immutable typed **`Stream`** union
(element/scalar/variant/list/property/record/group/path). `lowerSteps` is the one shape
orchestrator; retypes flow it back through itself (`V().fold().unfold().out()` = elements→list→
elements). Emission-order and child-scope rationale: the dated design docs in `docs/`.

## Extend the generic seam, don't special-case the scenario

The goal is *generic lowering that composes the full nested Gremlin grammar at any valid depth or
combination* — every child body admitted at every position, every branch/loop/scope carrying every
shape (the "ceiling" — see `test/CLAUDE.md` for the L3-floor-vs-ceiling framing). So when a gap can
be closed two ways — a one-off "implement step X for exactly the scenario that's failing" or
extending the **generic seam** so a whole family of nested compositions lowers at once — close it
generically, even when the narrower fix would pass the failing scenario sooner. A `throw` that
fails closed is better than a special-case that entrenches the non-generic path.

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
