# src/sql — the `q` kernel

_Scope: `src/sql/**`. Design: `docs/2026-07-12-q-kernel-sql-builder.md`._

The compiler builds all SQL through a template-first `q` kernel + typed `Relation` handles
(`kernel/q.ts` + `schema.ts`). Every step module builds through the kernel.

## Guardrails

- **Only `kernel/q.ts` may import raw lazyrecords `Text`/`Compound`.** Do not reintroduce the
  retired ansi builders (`select`/`from`/`join`/`cte`/…) — build through the kernel.
- **Prefer `q.derived` (non-CTE subquery) over a named CTE.** Reach for a named CTE only when the
  relation is shared/reused or the planner needs a deliberate materialization boundary.
- **The kernel owns BOTH rendering modes, and there are exactly two.** `Query` NAMES relations
  (`WITH c0, c1, …`); `DerivedQuery` NESTS them (`(…) x0`, `(…) x1`) and fails closed on
  `recursiveCte`/`render`, which have no meaning without a shared `WITH`. Whether a relation is
  named or nested is a property of the Query, so a subclass here — never a per-site choice, and
  never a `Query` subclass in a step module (that was `InlineQuery`).
  `DerivedQuery` is **not** inherently correlated: correlation is what the caller seeds it with. The
  correlated inline child (`compiler/steps/tail/correlated.ts`) is the two composed, and it draws
  its seed alias from `DerivedQuery.alias()` so the whole `x*` namespace has one owner.
- **A third mode ("flat accumulation") was measured unnecessary — don't add one.** SQLite's lateral
  rule is positional, not absent: a table-valued function and a correlated scalar subquery both see
  the outer row; only a FROM-clause derived table doesn't. So the only shape needing flat
  accumulation is a body that FANS OUT inside a recursive term, which `expandRepeatBody` handles as
  a fast path with a generic body relation behind it. Everything else provisions as a keyed relation
  + a join. Evidence: `docs/2026-07-27-hand-rolled-sql-audit.md` ("the one structural finding",
  retracted).
