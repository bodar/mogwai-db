import { emit, emitProgram, isRowsBind, type Emitted } from './rel/emit.ts';
import type { Guard, Plan } from './rel/plan.ts';

/** The one thing a program needs of a store: run a statement, get rows back. Deliberately not
 * `GraphStore` — a program is relational, and nothing here knows what a vertex is. */
export interface RowSource { query<T = any>(sql: string, binds?: readonly unknown[]): T[]; }

/**
 * A program RENDERED to plain, transport-safe data — the form that CROSSES an RPC (edge-compilation
 * Phase 2). The live `Plan` cannot cross: a `recursive` Rel carries a `step: (self)=>Rel` closure, and
 * `Rel`/`Stmt` nodes are branded with `unique symbol`s — structured clone drops both. `emit` consumes
 * all of that, leaving only SQL text + plain binds. So we render on the ELASTIC edge (where compile
 * already runs) and ship this; the DO neither re-emits nor holds the algebra. It is the write-side
 * twin of a read's `Compiled {sql,binds}` — the reason a write "ships exactly as a read does".
 *
 * `columns` is the declared column ORDER per binding, the one fact `payload` needs to turn a retained
 * result into its positional JSON bind — carried here so `runSteps` needs nothing but this object.
 */
export interface RunStep { readonly binding?: string; readonly result: boolean; readonly guard?: Guard; readonly emitted: Emitted; }
export interface RenderedProgram { readonly steps: readonly RunStep[]; readonly columns: Readonly<Record<string, readonly string[]>>; }

/**
 * RENDER a program to transport-safe steps — the compile-time half, run on the edge. Emits the plan
 * (`emit`, or `emitProgram` + the framing `tail` as a final result step), inlines each binding's
 * `guard` onto its step, and records every binding's declared column order. Pure: no store, and the
 * algebra (closures, symbol brands) does not survive into the output.
 */
export function renderProgram(program: Plan, tail?: Emitted): RenderedProgram {
  const declared = new Map(program.bindings.map((binding) => [binding.name, binding] as const));
  const raw = tail
    ? [...emitProgram(program).effects, { result: true, emitted: tail }]
    : emit(program);
  const steps: RunStep[] = raw.map((step) => ({ ...step, guard: step.binding ? declared.get(step.binding)?.guard : undefined }));
  const columns: Record<string, readonly string[]> = {};
  for (const binding of program.bindings) columns[binding.name] = binding.node.type.cols.map((column) => column.name);
  return { steps, columns };
}

/**
 * RUN A RELIR PROGRAM — the binding executor (§3.0/§9 of the RelIR build plan).
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
  return runSteps(store, renderProgram(program, tail));
}

/**
 * RUN a rendered program — the execution-time half, run where the store is (the DO, or Bun
 * in-process). Walks the pre-rendered steps in order; a `RowsBind` in a step's binds is filled from
 * an earlier step's RETAINED rows (the pre-mutation snapshot a cascade requires), and a guard step
 * raises when its row count is the wrong one. Needs no algebra and no `emit` — everything it reads is
 * the plain `RenderedProgram`, which is why this is the ONLY half that has to run on the DO.
 */
export function runSteps(store: RowSource, { steps, columns }: RenderedProgram): readonly Record<string, unknown>[] {
  const retained = new Map<string, readonly Record<string, unknown>[]>();
  let result: readonly Record<string, unknown>[] = [];

  for (const step of steps) {
    const binds = step.emitted.binds.map((bind) => (isRowsBind(bind) ? payload(bind.rowsOf, columns, retained) : bind));
    const rows = store.query<Record<string, unknown>>(step.emitted.sql, binds);
    if (step.binding) {
      retained.set(step.binding, rows);
      // A GUARD BINDING is the refusal only the graph can decide (§6·5): the plan CARRIES it, so a
      // traversal whose answer is an error stays a traversal this algebra expressed rather than one
      // it declined — which is the difference between a coverage counter that can reach 100% and one
      // that cannot. The rows are already in hand; the test is their count.
      const guard = step.guard;
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
 * the binding's declared column order. The declared column order is the authority for what each
 * position means; there is no inference here and no second type system, which is the same reason the
 * SQL side reads `$[i]` rather than a name.
 */
function payload(name: string, columns: Readonly<Record<string, readonly string[]>>, retained: ReadonlyMap<string, readonly Record<string, unknown>[]>): string {
  const cols = columns[name];
  const rows = retained.get(name);
  if (!cols || !rows) throw new Error(`RelIR program: binding '${name}' has no retained rows — it must run before the step that references it`);
  return JSON.stringify(rows.map((row) => cols.map((column) => transportable(row[column], name, column))));
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
