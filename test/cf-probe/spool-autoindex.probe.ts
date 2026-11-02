// SPOOL AUTO-INDEX — does DO SQLite build an AUTOMATIC INDEX on a MATERIALIZED CTE, as bun:sqlite does?
// Run standalone (NOT a gated test):   bun test/cf-probe/spool-autoindex.probe.ts
//
// `spools` (`src/rel/emit.ts`) turns a taken snapshot read as an inner loop into
// `WITH x AS MATERIALIZED (SELECT json_extract(value,'$[i]') … FROM json_each(?))`, on the claim that
// the planner then SEARCHes it through an automatic covering index rather than re-decoding the
// `json_each` per outer row. That claim was measured on bun:sqlite; the runtime it matters on is a
// Durable Object, so it is asked of one here — the plan (EXPLAIN QUERY PLAN) and the wall at a
// production-ish size, for the three shapes the write programs emit: a snapshot streamed against two
// spooled ones (the label pairing), an anti join (the absent guard), and the same pairing UNSPOOLED.
//
// Recorded result (2026-11-02, wrangler dev / workerd): see the `RESULT` comment at the bottom.

const ROOT = `${import.meta.dir}/../..`;
const PORT = 8989;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RUN = `${Date.now()}`;
const N = 6000;

type Outcome =
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly error: string };

async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(ORIGIN, { signal: AbortSignal.timeout(1_000) }); return; }
    catch { await Bun.sleep(200); }
  }
  throw new Error(`cf-probe: wrangler dev not ready on ${ORIGIN}`);
}

async function probe(statements: readonly { sql: string; binds?: readonly unknown[] }[]): Promise<Outcome[]> {
  const response = await fetch(`${ORIGIN}/spool-${RUN}`, { method: 'POST', body: JSON.stringify({ statements }) });
  if (response.status !== 200) throw new Error(`probe HTTP ${response.status}`);
  return await response.json() as Outcome[];
}

const ids = JSON.stringify(Array.from({ length: N }, (_, i) => [i + 1]));
const names = JSON.stringify(Array.from({ length: N }, (_, i) => [i + 1, `n${i + 1}`]));
const interned = JSON.stringify(Array.from({ length: N }, (_, i) => [i + 1, `n${i + 1}`]));
const spool = (name: string, cols: readonly string[]) =>
  `${name} AS MATERIALIZED (SELECT ${cols.map((column, i) => `json_extract(j.value, '$[${i}]') AS ${column}`).join(', ')} FROM json_each(?) j)`;

const shapes: Record<string, { sql: string; binds: readonly unknown[] }> = {
  'pairing, spooled': {
    sql: `WITH ${spool('nm', ['o', 'name'])}, ${spool('lb', ['id', 'name'])} SELECT count(*) AS n FROM (SELECT json_extract(c.value, '$[0]') AS id, row_number() OVER (ORDER BY json_extract(c.value, '$[0]')) AS ord FROM json_each(?) c) p CROSS JOIN nm ON p.ord = nm.o CROSS JOIN lb ON nm.name = lb.name`,
    binds: [names, interned, ids],
  },
  'absent guard, spooled': {
    sql: `WITH ${spool('h', ['ord'])}, ${spool('nm', ['o', 'name'])} SELECT count(*) AS n FROM h WHERE NOT EXISTS (SELECT 1 FROM nm WHERE nm.o = h.ord)`,
    binds: [ids, names],
  },
  'pairing, UNSPOOLED (trunk)': {
    sql: `SELECT count(*) AS n FROM (SELECT json_extract(c.value, '$[0]') AS id, row_number() OVER (ORDER BY json_extract(c.value, '$[0]')) AS ord FROM json_each(?) c) p CROSS JOIN json_each(?) nm ON p.ord = json_extract(nm.value, '$[0]') CROSS JOIN json_each(?) lb ON json_extract(nm.value, '$[1]') = json_extract(lb.value, '$[1]')`,
    binds: [ids, names, interned],
  },
};

const proc = Bun.spawn(
  ['./node_modules/.bin/wrangler', 'dev', '--config', 'test/cf-probe/wrangler.jsonc', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'error'],
  { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdout: 'ignore', stderr: 'ignore' },
);
try {
  await waitForReady();
  console.log(`\n=== SPOOL AUTO-INDEX PROBE (real DO SQLite via wrangler dev), N=${N} ===\n`);
  for (const [label, { sql, binds }] of Object.entries(shapes)) {
    const [plan] = await probe([{ sql: `EXPLAIN QUERY PLAN ${sql}`, binds }]);
    const start = performance.now();
    const [result] = await probe([{ sql, binds }]);
    const ms = Math.round(performance.now() - start);
    console.log(`${label}: ${result!.ok ? `${JSON.stringify(result!.rows[0])} in ${ms} ms (round trip)` : `FAIL ${result!.error}`}`);
    console.log(plan!.ok ? plan!.rows.map((row) => `    ${String(row.detail)}`).join('\n') : `    EXPLAIN refused: ${plan!.error}`);
  }
} finally {
  proc.kill();
  await proc.exited;
}

// RESULT (2026-11-02, workerd via wrangler dev, N=6000) — DO SQLite auto-indexes a spooled CTE exactly as
// bun:sqlite does (`sqlite_version()` itself is refused by the DO authorizer, so the version is not printed):
//   pairing, spooled           6000 rows in    15 ms — `SEARCH nm USING AUTOMATIC COVERING INDEX (o=?)`,
//                                                     `SEARCH lb USING AUTOMATIC COVERING INDEX (name=?)`
//   absent guard, spooled         0 rows in     6 ms — `CORRELATED SCALAR SUBQUERY` → `SEARCH nm USING
//                                                     AUTOMATIC COVERING INDEX (o=?)`
//   pairing, UNSPOOLED (trunk) 6000 rows in 15 698 ms — `SCAN nm VIRTUAL TABLE` / `SCAN lb VIRTUAL TABLE` nested
// One caveat the plan states and this probe does not hide: a correlated subquery over a spooled CTE whose
// OUTER loop is a BASE TABLE gets no automatic index (bun:sqlite, measured) — which is why the stale-slot
// delete is driven from the snapshot (`slotRows`) rather than correlated against the property table.
