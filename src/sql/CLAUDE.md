# src/sql — the `q` kernel

_Scope: `src/sql/**`. Design: `docs/2026-07-12-q-kernel-sql-builder.md`._

The compiler builds all SQL through a template-first `q` kernel + typed `Relation` handles
(`kernel/q.ts` + `schema.ts`). Every step module builds through the kernel.

## Guardrails

- **Only `kernel/q.ts` may import raw lazyrecords `Text`/`Compound`.** Do not reintroduce the
  retired ansi builders (`select`/`from`/`join`/`cte`/…) — build through the kernel.
- **Prefer `q.derived` (non-CTE subquery) over a named CTE.** Reach for a named CTE only when the
  relation is shared/reused or the planner needs a deliberate materialization boundary.
