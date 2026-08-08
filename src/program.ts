import { emit, emitProgram, isRowsBind, type Emitted } from './rel/emit.ts';
import type { Binding, Plan } from './rel/plan.ts';

/** The one thing a program needs of a store: run a statement, get rows back. Deliberately not
 * `GraphStore` — a program is relational, and nothing here knows what a vertex is. */
export interface RowSource { query<T = any>(sql: string, binds?: readonly unknown[]): T[]; }

/**
 * RUN A RELIR PROGRAM — the binding executor (§3.0/§10·2 of the RelIR build plan).
 *
 * It walks `Plan.bindings` in order: a `Rel` binding is already a CTE in the SQL of every step
 * after it, and a `Stmt` binding is a step whose `RETURNING` rows are RETAINED, so that every later
 * `Ref` to it resolves to those rows. That retention is not an optimization — it is what preserves
 * the PRE-MUTATION snapshot a vertex-drop cascade requires. Re-evaluating the source relation after
 * an earlier delete would ask a different question of a graph that had already changed.
 *
 * It lives OUTSIDE `src/rel/`, and that placement is a decision rather than an accident: an
 * executor inside the algebra is what the three-entry-point emitter was drifting toward, and it
 * rebuilds write as a special case in a new layer. RelIR supplies `Ref`, the plan shape and the
 * passes; running is somebody else's job.
 *
 * Retained rows travel as ONE JSON bind exploded by `json_each` — never a row-count-sized
 * placeholder list, which is the Durable Objects 100-parameter wall. The emitter leaves a
 * `RowsBind` marker in its bind list saying which binding's rows belong there, so this never parses
 * SQL to find the slot and `emit` never learns about the transport.
 */
export function runProgram(store: RowSource, program: Plan, tail?: Emitted): readonly Record<string, unknown>[] {
  const declared = new Map(program.bindings.map((binding) => [binding.name, binding] as const));
  const retained = new Map<string, readonly Record<string, unknown>[]>();
  let result: readonly Record<string, unknown>[] = [];

  // A TAIL is the framing layer's own read over what the effects retained, and it replaces the
  // relational step this would otherwise render — same position, same transport, composed by
  // whoever owns Gremlin shape (§2). Its binds carry the same `RowsBind` markers, so nothing here
  // learns that a shape exists.
  const steps = tail
    ? [...emitProgram(program).effects, { result: true, emitted: tail }]
    : emit(program);

  for (const step of steps) {
    const binds = step.emitted.binds.map((bind) => (isRowsBind(bind) ? payload(bind.rowsOf, declared, retained) : bind));
    const rows = store.query<Record<string, unknown>>(step.emitted.sql, binds);
    if (step.binding) {
      retained.set(step.binding, rows);
      // A GUARD BINDING is the refusal only the graph can decide (§6·5): the plan CARRIES it, so a
      // traversal whose answer is an error stays a traversal this algebra expressed rather than one
      // it declined — which is the difference between a coverage counter that can reach 100% and one
      // that cannot. The rows are already in hand; the test is their count.
      const guard = declared.get(step.binding)?.guard;
      if (guard && (guard.raiseWhen === 'rows' ? rows.length > 0 : rows.length === 0))
        // `valueColumn` appends the OFFENDING VALUE, for the reference sentences that name it. Only a
        // `'rows'` guard can have one — an `'empty'` guard has no row to read it from — and the append
        // is the first row's, which is the row the message is about.
        throw new Error(guard.valueColumn !== undefined && rows.length
          ? `${guard.message}${(rows[0] as Record<string, unknown>)[guard.valueColumn]}`
          : guard.message);
    }
    if (step.result) result = rows;
  }
  return result;
}

/**
 * A retained result as one JSON value, POSITIONALLY — a row per member, a column per position, in
 * the binding's declared column order. The declared `type` is the authority for what each position
 * means; there is no inference here and no second type system, which is the same reason the SQL
 * side reads `$[i]` rather than a name.
 */
function payload(name: string, declared: ReadonlyMap<string, Binding>, retained: ReadonlyMap<string, readonly Record<string, unknown>[]>): string {
  const binding = declared.get(name);
  const rows = retained.get(name);
  if (!binding || !rows) throw new Error(`RelIR program: binding '${name}' has no retained rows — it must run before the step that references it`);
  const cols = binding.node.type.cols;
  return JSON.stringify(rows.map((row) => cols.map((column) => transportable(row[column.name], name, column.name))));
}

/** JSON carries null, numbers, strings and booleans losslessly and nothing else. A blob or a
 * runtime value outside that set FAILS CLOSED naming the column, rather than round-tripping as
 * something it is not — the wrong answer here would be silent, and a deferral is not. */
function transportable(value: unknown, binding: string, column: string): unknown {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === 'number' || kind === 'string' || kind === 'boolean') return value;
  throw new Error(`RelIR program: binding '${binding}' column '${column}' holds a ${kind} that JSON transport cannot carry losslessly`);
}
