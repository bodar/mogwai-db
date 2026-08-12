import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * THE PLATFORM GATE FOR THE WRITE CONSTRUCTS — P5 and P5b of the build plan's measured envelope,
 * re-run against DO SQLite instead of against the dev runtime.
 *
 * §1 recorded these as measured on SQLite 3.51.2 (Bun) and named the DO re-run as a PREREQUISITE for
 * the write wedge rather than an exit criterion — because the algebra already EMITS `RETURNING` and
 * `ON CONFLICT DO UPDATE` and `runProgram` already executes them, so the two write constructs whose
 * platform behaviour had never been measured were the two already shipping in code. A gate described
 * and not built cannot fail, so it blocked nothing.
 *
 * **`src/cf-limits.ts` cannot cover this and is not meant to.** That seam asserts the two limits a Bun
 * statement can be measured against (≤ 100 bound parameters, ≤ 100 KB of text). Whether a CONSTRUCT is
 * accepted at all is not countable from Bun — the only authority is workerd, so this boots a throwaway
 * `wrangler dev` worker with its own Durable Object (`test/cf-probe/`, the method recorded in §6·2)
 * and asks it. The two instruments are complementary: cf-limits sees a size wall, this sees a
 * vocabulary wall, and neither sees the other's.
 *
 * Every assertion below is a claim the write wedge will rest on. A failure here is not a flake: it is
 * the platform refusing something the algebra is built to emit, and the response is a node-set or
 * lowering change, never a retry.
 */

const ROOT = `${import.meta.dir}/..`;
const PORT = 8977;
const ORIGIN = `http://127.0.0.1:${PORT}`;

type Outcome =
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly error: string };

let proc: ReturnType<typeof Bun.spawn> | undefined;

/** Named so the `beforeAll` that wraps this can be given a strictly LARGER budget — see the hook. */
const READY_TIMEOUT_MS = 60_000;

async function waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(ORIGIN, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`cf-probe: wrangler dev did not become ready on ${ORIGIN} within ${timeoutMs}ms`);
}

/**
 * Run a batch in its own probe DO. The name carries a per-RUN token, because `wrangler dev` persists a
 * DO's storage on disk and a re-run would otherwise inherit the previous run's rows and id sequence.
 * A fresh DO rather than a wipe — see `test/cf-probe/worker.ts` for what the wipe ran into.
 */
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function probe(group: string, statements: readonly { sql: string; binds?: readonly unknown[] }[]): Promise<Outcome[]> {
  const response = await fetch(`${ORIGIN}/${group}-${RUN}`, {
    method: 'POST',
    body: JSON.stringify({ statements }),
  });
  expect(response.status).toBe(200);
  return await response.json() as Outcome[];
}

/** The outcome of the LAST statement in a batch, with every earlier one asserted to have succeeded —
 *  so a setup failure is reported as itself rather than as a confusing verdict on the probe. */
function last(outcomes: readonly Outcome[]): Outcome {
  for (const outcome of outcomes.slice(0, -1)) {
    if (!outcome.ok) throw new Error(`cf-probe setup failed: ${outcome.error}`);
  }
  return outcomes[outcomes.length - 1]!;
}

const SCHEMA = [
  { sql: 'CREATE TABLE n (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT, v INTEGER)' },
  { sql: 'CREATE TABLE src (k TEXT, v INTEGER)' },
  { sql: "INSERT INTO src (k, v) VALUES ('c', 3), ('a', 1), ('b', 2)" },
];

describe('the write constructs, measured on DO SQLite', () => {
  // THE HOOK'S BUDGET MUST EXCEED `waitForReady`'s, or the helper's deadline is unreachable and its
  // diagnostic is never the one you see. bun's default per-hook timeout is 5s while `waitForReady`
  // allows 60s, so the hook was being killed at 5s and reported as an unnamed timeout in this
  // describe — with no mention of wrangler. Standalone this never bites (the whole file runs in
  // ~1.2s); it bit only inside `mise run ci`, where `build` is invoking wrangler concurrently and
  // startup contends. A wrapper tighter than the thing it wraps turns a slow dependency into an
  // unattributable flake, which is what cost three red `ci` runs with three different victims.
  beforeAll(async () => {
    proc = Bun.spawn(
      ['./node_modules/.bin/wrangler', 'dev', '--config', 'test/cf-probe/wrangler.jsonc',
        '--port', String(PORT), '--ip', '127.0.0.1'],
      { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdout: 'ignore', stderr: 'ignore' },
    );
    await waitForReady();
  }, READY_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    proc?.kill();
    await proc?.exited;
  });

  // P5 — the write envelope. Each of these is a shape `Insert`/`Update`/`Delete` is built to emit, so
  // a refusal is a node-set problem rather than a lowering one.

  test('a CTE feeding an INSERT … SELECT … RETURNING is accepted', async () => {
    // The shape a write over a read PREFIX takes: the prefix is a named binding, the statement selects
    // from it, and RETURNING is how the inserted rows become a relation a later binding can reference.
    const outcome = last(await probe('cte-insert-returning', [...SCHEMA, {
      sql: 'WITH pick AS (SELECT k, v FROM src WHERE v >= ?) INSERT INTO n (k, v) SELECT k, v FROM pick RETURNING id, k',
      binds: [2],
    }]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.rows.map((row) => row.k).sort()).toEqual(['b', 'c']);
  });

  test('a multi-row INSERT … RETURNING is accepted and returns every row', async () => {
    const outcome = last(await probe('multi-insert-returning', [...SCHEMA, {
      sql: "INSERT INTO n (k, v) VALUES ('x', 10), ('y', 20), ('z', 30) RETURNING id, k, v",
    }]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toHaveLength(3);
  });

  test('INSERT … ON CONFLICT DO UPDATE … RETURNING is accepted — mergeV as ONE statement', async () => {
    // 2.5's whole shape: the upsert and its result in one statement, so there is no read-then-branch
    // in host language and no window where another writer could interleave.
    const outcome = last(await probe('upsert-returning', [
      { sql: 'CREATE TABLE u (k TEXT PRIMARY KEY, v INTEGER)' },
      { sql: "INSERT INTO u (k, v) VALUES ('a', 1)" },
      { sql: "INSERT INTO u (k, v) VALUES ('a', 9) ON CONFLICT(k) DO UPDATE SET v = excluded.v RETURNING k, v" },
    ]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toEqual([{ k: 'a', v: 9 }]);
  });

  test('UPDATE … FROM (subquery) is accepted', async () => {
    const outcome = last(await probe('update-from', [...SCHEMA,
      { sql: "INSERT INTO n (k, v) VALUES ('a', 0), ('b', 0)" },
      { sql: 'UPDATE n SET v = s.v FROM (SELECT k, v FROM src) AS s WHERE n.k = s.k RETURNING n.k, n.v' },
    ]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows.map((row) => [row.k, row.v]).sort()).toEqual([['a', 1], ['b', 2]]);
  });

  test('DELETE … WHERE id IN (SELECT …) is accepted — the membership predicate drop() lowers to', async () => {
    // §3.3: a Delete has no `using`; membership is an ordinary subquery predicate in `where`. This is
    // that shape, and it is the one a vertex-drop cascade depends on.
    const outcome = last(await probe('delete-in-query', [...SCHEMA,
      { sql: "INSERT INTO n (k, v) VALUES ('a', 1), ('b', 2), ('c', 3)" },
      { sql: 'DELETE FROM n WHERE k IN (SELECT k FROM src WHERE v >= ?) RETURNING k', binds: [2] },
    ]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows.map((row) => row.k).sort()).toEqual(['b', 'c']);
  });

  test('the POSTGRES-STYLE data-modifying CTE is REFUSED, on this runtime too', async () => {
    // The one prohibition in the envelope, and the reason a write chain is a SEQUENCE of statements
    // (`Plan.bindings`) rather than one nested expression. Confirming the refusal matters as much as
    // confirming the acceptances: if it were legal here and not on Bun, the algebra would be leaving a
    // simpler lowering on the table; if the reverse, a plan that compiles in dev would fail in
    // production.
    const outcome = last(await probe('modifying-cte', [...SCHEMA, {
      sql: "WITH ins AS (INSERT INTO n (k, v) VALUES ('q', 1) RETURNING id) SELECT id FROM ins",
    }]));
    expect(outcome.ok).toBe(false);
  });

  // P5b — RETURNING determinism, and the rule the write wedge's id correlation rests on.

  test('id assignment follows the source SELECT ORDER BY, and RETURNING may project an inserted column', async () => {
    // The row ORDER of a RETURNING result is undefined per the docs, so nothing may re-associate by
    // RETURNING position. What IS defined is that ids are handed out in the order the source SELECT
    // produced rows — so ordering the source and re-associating by a CARRIED KEY is sound, and that is
    // exactly what 2.4 does. Asserted by reading the ids back with an explicit ORDER BY rather than by
    // trusting the RETURNING order, which would be asserting the thing the docs say not to rely on.
    const outcomes = await probe('id-order', [...SCHEMA, {
      sql: 'INSERT INTO n (k, v) SELECT k, v FROM src ORDER BY k RETURNING id, k',
    }, {
      sql: 'SELECT id, k FROM n ORDER BY id',
    }]);
    const returning = outcomes[outcomes.length - 2]!;
    const readBack = last(outcomes);
    expect(returning.ok).toBe(true);
    expect(readBack.ok).toBe(true);
    if (!returning.ok || !readBack.ok) return;
    // RETURNING projected the inserted column (`k` came from the source, `id` was assigned).
    expect(returning.rows).toHaveLength(3);
    expect(returning.rows.every((row) => typeof row.id === 'number' && typeof row.k === 'string')).toBe(true);
    // …and the ids ascend in the source's ORDER BY, which is what makes a carried-key correlation work.
    expect(readBack.rows.map((row) => row.k)).toEqual(['a', 'b', 'c']);
  });

  test('the bind cap is the platform fact cf-limits counts against — refused past it', async () => {
    // The same wall `src/cf-limits.ts` asserts statically, confirmed dynamically on the runtime that
    // owns it, so the constant in that module has a measurement behind it rather than a comment.
    const placeholders = Array.from({ length: 120 }, () => '(?)').join(', ');
    const outcome = last(await probe('bind-cap', [...SCHEMA, {
      sql: `INSERT INTO n (v) VALUES ${placeholders}`,
      binds: Array.from({ length: 120 }, (_, i) => i),
    }]));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.toLowerCase()).toContain('too many');
  });
});
