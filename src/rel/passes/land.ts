import { DO_BIND_CAP } from '../check.ts';
import { compilerText, lit, type Expr } from '../expr.ts';
import { explode, project, values } from '../factory.ts';
import type { Rel } from '../rel.ts';
import { relId, type RelId } from '../types.ts';
import { rewrite } from '../walk.ts';

/**
 * Land a row set that is too big to be BINDS as ONE JSON bind, exploded by `json_each` (§3.6).
 *
 * The wall this exists for only appears in production: **Durable Objects SQLite caps a statement at
 * 100 bound parameters**, where Bun's cap is 65,535 — so a `Values` sized by row count passes every
 * test and fails only on the platform. `src/rowbatch.ts` is the answer for a WRITE, which can be
 * split into chunks; a compiled read plan is ONE statement with nowhere to put a preceding INSERT,
 * so the whole set has to arrive as a single value.
 *
 * It is a PASS and not an emitter behaviour, and that is the load-bearing part: `emit` never learns
 * about chunking, the rewritten plan is an ordinary plan that `check` verifies like any other, and
 * the bind budget stays a property of the plan rather than a rule inside the renderer.
 *
 * It declines what it cannot carry rather than guessing: a row holding anything but a `Lit` has no
 * JSON serialisation available at compile time, so that `Values` is left alone and the bind budget
 * fails closed on it — never silently mis-executed.
 */
export function land(plan: Rel, limit: number = DO_BIND_CAP): Rel {
  let n = 0;
  const fresh = (hint: string, id: RelId): RelId => relId(`${id}_${hint}${n++}`);
  return rewrite(plan, (r) => {
    if (r.kind !== 'values') return r;
    const width = r.type.cols.length;
    if (r.rows.length * width <= limit) return r;
    const literals = r.rows.map((row) => row.map((e) => (e.kind === 'lit' ? e.value : undefined)));
    if (r.rows.some((row) => row.some((e) => e.kind !== 'lit'))) return r;

    const json = values({
      id: fresh('json', r.id), channels: [], rows: [[lit(JSON.stringify(literals), 'json')]],
      type: { cols: [{ name: 'rows', type: 'json', nullable: false }] },
    });
    const members = explode({
      id: fresh('member', r.id), channels: [], input: json, expr: { kind: 'col', rel: json.id, name: 'rows' },
      as: { value: 'row' },
      type: { cols: [...json.type.cols, { name: 'row', type: 'json', nullable: false }] },
    });
    // Positional `$[i]`: the declared type is the authority for every column, exactly as it is for
    // a statement binding's retained rows, so there is nothing to infer from the payload.
    const at = (i: number): Expr => ({ kind: 'call', fn: 'json_extract', args: [{ kind: 'col', rel: members.id, name: 'row' }, compilerText(`$[${i}]`)] });
    return project({
      id: r.id, channels: r.channels, input: members, type: r.type,
      exprs: r.type.cols.map((column, i) => [column.name, at(i)] as const),
    });
  });
}
