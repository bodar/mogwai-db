import { compilerInt, compilerNull, compilerReal, compilerText, lit, param, type Expr } from '../../rel/expr.ts';
import { flatType, type TypeNode } from '../../gremlin/types.ts';
import type { Arg } from '../../gremlin/frontend.ts';

// ---------- the one seam for "a value the compiler already holds" ----------
//
// A COMPILER-HELD CONSTANT — a parsed literal, a slice count, a `has`/`by` key, a `V/E` id, a class
// name, a JSON path — is inlined as a TYPED SQL literal so it spends none of the Durable Object's 100
// bound parameters (docs/archive/2026-08-05-parameters-are-the-only-binds.md: the 100-bind cap is a PARAMETER
// budget). Every such site routes through here rather than calling `lit()` (a bind) directly, so the
// storage-class rule lives once and — when Phase B lands the `Param` concept — the single place that
// decides bind-vs-inline is this module, not N scattered `lit()` calls.
//
// It lives on the COMPILER side, not in `src/rel/expr.ts`, because it reads the Gremlin type
// vocabulary (`flatType`/`TypeNode`) and `src/rel/` is the clean-room the arch check keeps free of
// `src/gremlin` imports.

/** An `Arg` → its RelIR expression, deciding bind-vs-inline the ONE way the whole design turns on. It
 *  takes the whole `Arg` — the same value+type+name object the front-end carries end to end — rather
 *  than a loose (value, type, paramName) trio, so the seam reads the intent off the argument itself:
 *
 *  - `a.name != null` — the value is a USER PARAMETER (`$x` in the binding map). It BINDS (`?`),
 *    spending one of the 100 by intent — the only free-standing bind the design keeps, because a
 *    parameter is the user's signal that the value is variable.
 *  - `a.name == null` — the value is a CONSTANT the compiler holds (a parsed literal). It INLINES as
 *    a TYPED SQL literal, storage class following the declared canonical type (`a.type`), so an
 *    integer-valued double inlines as `2.0` not INTEGER `2`. Spends nothing.
 *
 *  Either way, a shape a scalar literal cannot spell — a collection, a map, a nested traversal, or a
 *  big-value carrier (bigint/BigDecimal/Duration, the `oversized` tail) — declines with `null` for the
 *  caller to route (a param of that shape is oversized, handled where collections already are). A
 *  non-finite number (`NaN`/±`Infinity`) has no literal form, so it stays a bound `lit`. */
export const constLit = (a: Arg): Expr | null => {
  const { value, type, name: paramName } = a;
  if (value === null) return paramName != null ? param(value, paramName) : compilerNull();
  if (typeof value === 'string') return paramName != null ? param(value, paramName, 'text') : compilerText(value);
  if (typeof value === 'boolean') return paramName != null ? param(value, paramName) : compilerInt(value ? 1 : 0);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return lit(value, 'real'); // NaN/±Infinity have no literal form
    if (paramName != null) return param(value, paramName);
    if (!Number.isInteger(value)) return compilerReal(value);
    const flat = flatType(type);
    return flat === 'float' || flat === 'double' || flat === 'bigdecimal'
      ? compilerReal(value) : compilerInt(value);
  }
  return null;
};

/** The element TypeNode a list/set container node declares at index `i`, or null — the per-member type
 *  a flattened collection arg still carries alongside its values (`literalItems`, `frontend.ts`). */
export const itemTypeAt = (type: TypeNode | null | undefined, i: number): TypeNode | null =>
  type != null && typeof type === 'object' && 'items' in type ? (type.items[i] ?? null) : null;

/** A COMPILE-TIME slice/count as an inlined integer literal — the sharpest constant of all: `sliceOf`
 *  and `countArg` already READ the value to shape the plan (reject `range(2,1)`, compute `lo + limit`),
 *  so it is definitionally known here and spending it as a runtime bind is a pure contradiction. A
 *  malformed non-integer (`limit(2.5)`) keeps a bound spelling rather than throwing from `compilerInt`,
 *  leaving the error to the path that owns it. */
export const countLit = (n: number): Expr => Number.isSafeInteger(n) ? compilerInt(n) : lit(n, 'int');

/** A SLICE bound — `limit`/`skip`'s single count — that BINDS its user parameter (`limit($x)`) or
 *  INLINES a compile-time constant (`limit(2)`), the same bind-vs-inline decision `constLit` makes for
 *  a scalar operand, applied to the one place a count can honestly stay a `?`.
 *
 *  It is NOT the general count seam: `range`'s `hi−lo` and the collapsed-relation band must be computed
 *  at compile time (and `range`'s `lo>hi` throws a validation SQL cannot carry — root `CLAUDE.md`
 *  "fail closed"), so those callers REDUCE the value (pass `paramName = null`, `countLit`) at the last
 *  responsible moment, exactly as `unrollFixedRepeat` reduces `times($x)`
 *  (docs/archive/2026-08-05-parameters-are-the-only-binds.md B3). A non-integer that somehow reached here has no
 *  int-bind form, so it reduces too. */
export const sliceBound = (n: number, paramName: string | null): Expr =>
  paramName != null && Number.isSafeInteger(n) ? param(n, paramName, 'int') : countLit(n);
