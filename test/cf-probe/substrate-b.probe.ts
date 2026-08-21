// SUBSTRATE B — cheap experiments against a REAL Durable Object, run standalone (NOT a gated test):
//   bun test/cf-probe/substrate-b.probe.ts
//
// Substrate B is "a data-sized RELATION with local identity/adjacency" (docs/2026-08-21-barrier-
// substrate-design.md §(B)) — the shape federate-subgraph and OLAP want. The design doc defers it on
// ONE unmeasured question: TEMP table (mutable, indexable, needs DDL) vs Ref/CTE (pure SQL over
// json_each). This probe settles it on the runtime we ship to, reusing test/cf-probe/worker.ts.
//
// The prior question the probe also asks: can we AVOID substrate B? Adjacency may be pure CTEs (B),
// and OLAP iteration may be substrate-A-iterated — each round crossing the score vector as ONE
// json_each bind (D). If B and D both work and perform, substrate B's temp table is unnecessary.

const ROOT = `${import.meta.dir}/../..`;
const PORT = 8988;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RUN = `${Date.now()}`;

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

async function probe(group: string, statements: readonly { sql: string; binds?: readonly unknown[] }[]): Promise<Outcome[]> {
  const response = await fetch(`${ORIGIN}/${group}-${RUN}`, { method: 'POST', body: JSON.stringify({ statements }) });
  if (response.status !== 200) throw new Error(`probe HTTP ${response.status}`);
  return await response.json() as Outcome[];
}

/** Build a ring-ish directed graph: N vertices, each with an edge to (i+1)%N and (i+7)%N — so a
 *  multi-hop walk actually fans. Returned as the two json blobs a landed subgraph would cross as. */
function subgraph(n: number): { vertices: string; edges: string } {
  const vertices = Array.from({ length: n }, (_, i) => ({ id: i, label: 'v' }));
  const edges: { src: number; tgt: number; label: string }[] = [];
  for (let i = 0; i < n; i++) { edges.push({ src: i, tgt: (i + 1) % n, label: 'e' }); edges.push({ src: i, tgt: (i + 7) % n, label: 'e' }); }
  return { vertices: JSON.stringify(vertices), edges: JSON.stringify(edges) };
}

const proc = Bun.spawn(
  ['./node_modules/.bin/wrangler', 'dev', '--config', 'test/cf-probe/wrangler.jsonc', '--port', String(PORT), '--ip', '127.0.0.1'],
  { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdout: 'ignore', stderr: 'ignore' },
);

const show = (label: string, o: Outcome) =>
  console.log(`  ${o.ok ? 'OK  ' : 'FAIL'}  ${label}${o.ok ? '' : `  ← ${o.error}`}`);

try {
  await waitForReady();
  console.log(`\n=== SUBSTRATE B PROBE (real DO SQLite via wrangler dev) ===\n`);

  // ── A. DDL availability: is the temp-table variant even possible on DO? ──────────────────────────
  console.log('A. DDL availability (the temp-table variant hinges on these):');
  for (const [label, stmts] of [
    ['CREATE TEMP TABLE + insert + select', [
      { sql: 'CREATE TEMP TABLE t (id INTEGER PRIMARY KEY, score REAL)' },
      { sql: 'INSERT INTO t (id, score) VALUES (1, 0.5), (2, 0.25)' },
      { sql: 'SELECT count(*) AS n FROM t' },
    ]],
    ['CREATE TABLE (normal) + DROP', [
      { sql: 'CREATE TABLE scratch (id INTEGER PRIMARY KEY, score REAL)' },
      { sql: 'DROP TABLE scratch' },
      { sql: 'SELECT 1 AS ok' },
    ]],
    ['CREATE INDEX on a temp table', [
      { sql: 'CREATE TEMP TABLE ti (src INTEGER, tgt INTEGER)' },
      { sql: 'CREATE INDEX ti_src ON ti (src)' },
      { sql: 'SELECT 1 AS ok' },
    ]],
  ] as const) {
    const out = await probe(`A-${label.slice(0, 12)}`, stmts);
    show(label, out[out.length - 1]!);
  }

  // ── A2. TEMP scope: does a temp table survive across .exec calls in ONE request? across REQUESTS? ──
  console.log('\nA2. TEMP table scope (each probe() = one request into the same DO):');
  const g = `A2-scope-${RUN}`;
  const mk = await probe(g, [{ sql: 'CREATE TEMP TABLE s (x INTEGER)' }, { sql: 'INSERT INTO s VALUES (1),(2)' }, { sql: 'SELECT count(*) AS n FROM s' }]);
  show('create+use within one request', mk[mk.length - 1]!);
  const across = await probe(g, [{ sql: 'SELECT count(*) AS n FROM s' }]);
  show('same temp table from a LATER request (leak? or gone?)', across[0]!);

  // ── A3. TEMP in a SINGLE multi-statement exec (the obvious objection to A/A2) ─────────────────────
  console.log('\nA3. TEMP table inside ONE multi-statement exec (semicolon-joined):');
  const oneExec = await probe('A3-oneexec', [{
    sql: 'CREATE TEMP TABLE t1 (x INTEGER); INSERT INTO t1 VALUES (1),(2),(3); SELECT count(*) AS n FROM t1',
  }]);
  show('CREATE TEMP + INSERT + SELECT as one exec string', oneExec[0]!);
  const oneExecNormal = await probe('A3-normal', [{
    sql: 'CREATE TABLE t2 (x INTEGER); INSERT INTO t2 VALUES (1),(2),(3); SELECT count(*) AS n FROM t2; DROP TABLE t2',
  }]);
  show('CREATE (normal) + INSERT + SELECT + DROP as one exec string', oneExecNormal[0]!);

  // ── B. Pure-CTE adjacency: does federate-subgraph traversal work with NO DDL? ────────────────────
  console.log('\nB. Pure-CTE adjacency over json_each-landed vertices+edges (the Ref variant):');
  const sg = subgraph(20);
  const landCTE = `WITH le AS (SELECT json_extract(value,'$.src') AS src, json_extract(value,'$.tgt') AS tgt FROM json_each(?))`;
  const twoHop = await probe('B-2hop', [{
    sql: `${landCTE} SELECT DISTINCT h2.tgt AS id FROM le h1 JOIN le h2 ON h2.src = h1.tgt WHERE h1.src = 0 ORDER BY id`,
    binds: [sg.edges],
  }]);
  const oh = twoHop[0]!;
  show('2-hop out().out() from vertex 0', oh);
  if (oh.ok) console.log(`       → landed ids: ${oh.rows.map((r) => r.id).join(', ')}`);

  // ── C. Perf: CTE adjacency vs temp-table+index, 3 hops on a bigger subgraph ──────────────────────
  console.log('\nC. Perf — 3-hop reachability, CTE vs temp+index (N=500 vertices, 1000 edges):');
  const big = subgraph(500);
  const t0 = performance.now();
  const cte3 = await probe('C-cte', [{
    sql: `WITH le AS (SELECT json_extract(value,'$.src') AS src, json_extract(value,'$.tgt') AS tgt FROM json_each(?))
          SELECT count(DISTINCT h3.tgt) AS reached
          FROM le h1 JOIN le h2 ON h2.src=h1.tgt JOIN le h3 ON h3.src=h2.tgt WHERE h1.src=0`,
    binds: [big.edges],
  }]);
  const cteMs = performance.now() - t0;
  show(`CTE 3-hop (${cteMs.toFixed(0)}ms round-trip)`, cte3[0]!);
  const t1 = performance.now();
  const tmp3 = await probe('C-temp', [
    { sql: 'CREATE TEMP TABLE e (src INTEGER, tgt INTEGER)' },
    { sql: `INSERT INTO e (src, tgt) SELECT json_extract(value,'$.src'), json_extract(value,'$.tgt') FROM json_each(?)`, binds: [big.edges] },
    { sql: 'CREATE INDEX e_src ON e (src)' },
    { sql: `SELECT count(DISTINCT h3.tgt) AS reached FROM e h1 JOIN e h2 ON h2.src=h1.tgt JOIN e h3 ON h3.src=h2.tgt WHERE h1.src=0` },
  ]);
  const tmpMs = performance.now() - t1;
  show(`temp+index 3-hop (${tmpMs.toFixed(0)}ms round-trip incl. build)`, tmp3[tmp3.length - 1]!);

  // ── D. OLAP-shaped: iteration state as a json_each bind per round (substrate A iterated) ──────────
  console.log('\nD. OLAP iteration as substrate-A-iterated (score vector crosses as one json_each bind):');
  // One pageRank-style relaxation: new_score[v] = sum(old_score[u] for u->v). Each round is ONE
  // statement reading the previous score vector as a json bind and returning the new vector.
  const N = 100;
  const g2 = subgraph(N);
  let scores = Array.from({ length: N }, (_, i) => ({ id: i, s: 1 / N }));
  const dRounds = 15;
  const tD = performance.now();
  let dOk = true;
  for (let r = 0; r < dRounds; r++) {
    const out = await probe(`D-round`, [{
      sql: `WITH sc AS (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.s') AS s FROM json_each(?)),
                 le AS (SELECT json_extract(value,'$.src') AS src, json_extract(value,'$.tgt') AS tgt FROM json_each(?))
            SELECT v.id AS id,
                   0.15/${N} + 0.85*COALESCE((SELECT sum(sc.s / (SELECT count(*) FROM le o WHERE o.src=sc.id))
                                              FROM le JOIN sc ON sc.id = le.src WHERE le.tgt = v.id), 0) AS s
            FROM (SELECT json_extract(value,'$.id') AS id FROM json_each(?)) v ORDER BY v.id`,
      binds: [JSON.stringify(scores), g2.edges, g2.vertices],
    }]);
    if (!out[0]!.ok) { dOk = false; show(`round ${r} FAILED`, out[0]!); break; }
    scores = (out[0] as any).rows.map((row: any) => ({ id: row.id, s: row.s }));
  }
  const dMs = performance.now() - tD;
  if (dOk) {
    const top = [...scores].sort((a, b) => b.s - a.s).slice(0, 3);
    console.log(`  OK    ${dRounds} rounds over ${N} nodes in ${dMs.toFixed(0)}ms (${(dMs / dRounds).toFixed(1)}ms/round)`);
    console.log(`       → top-3 by score: ${top.map((t) => `${t.id}=${t.s.toFixed(4)}`).join(', ')}`);
  }

  console.log('\n=== END PROBE ===\n');
} finally {
  proc.kill();
  await proc.exited;
}
