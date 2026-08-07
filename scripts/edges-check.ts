#!/usr/bin/env bun
/**
 * The EDGE ratchet — how much of `src/compiler/steps/` the rest of the codebase still reaches into.
 *
 *   bun scripts/edges-check.ts [--record] [--json]
 *
 * **Coverage gates the ROUTE; the import graph gates the CODE.**
 * (`docs/2026-08-01-relir-build-plan.md` §8, and §10 Phase 0, which this gate measures.) Measured
 * when the plan's exit criterion was rewritten: all 39 files in `src/compiler/steps/` are
 * transitively reachable from non-legacy code, so deleting the legacy ROUTE frees 14% of it and the
 * other ~15k lines stay pinned — not by any coverage number, but by a dozen direct import edges.
 * Phase 0 cuts those edges, and this is its countdown.
 *
 * **A RATCHET, not a zero-gate**, unlike `arch`/`lint`/`binds` where zero IS the gate. Zero is the
 * wrong target here: `engine/engine.ts` and `compiler.ts` ARE the legacy routers and keep their
 * edges until Phase 4 deletes them outright. They are declared EXEMPT in the TSV, and **Phase 0 is
 * over when they are the only rows left.**
 *
 * **DIRECT edges only, deliberately — not the transitive closure.** The closure is what §8 measures
 * to size the prize, and it is the wrong thing to gate on: it moves when an unrelated file three
 * hops away changes an import, so it would fire on work that severed nothing. A direct edge is what
 * a commit actually cuts.
 *
 * The floor is the count of distinct SYMBOLS a file imports from `steps/`, because that is the unit
 * of the work: an edge is cut symbol by symbol (move `PATH_LIST_OPS` out, then `dtFactor`, …) and a
 * file-level yes/no would sit at 1 through all of it and then drop, showing no progress until the
 * end. `--record` rewrites floors DOWNWARD only; a rise, or a NEW importing file, fails.
 *
 * SCOPE is `src/` — production code. `test/` and `scripts/` are REPORTED, never gated: a test that
 * imports legacy is testing legacy and is deleted with it, so it pins nothing that outlives Phase 4.
 *
 * Exit 0 when every file is at or below its floor and no new importer appeared; 1 otherwise.
 */
import { dirname, resolve, relative } from 'node:path';
import { ROOT } from './lsp.ts';

const argv = process.argv.slice(2);
const record = argv.includes('--record');
const asJson = argv.includes('--json');

const RATCHET = `${ROOT}/scripts/steps-edges.tsv`;
const LEGACY = `${ROOT}/src/compiler/steps/`;

interface Entry {
  readonly file: string;
  readonly floor: number;
  readonly exempt: boolean;
  readonly note: string;
}

const COLS = 'file\tfloor\texempt\tnote';
const HEADER = [
  '# The EDGE ratchet — every DIRECT import of src/compiler/steps/ from outside it, and how many',
  '# distinct symbols it still takes. GENERATED FLOOR: re-recorded DOWNWARD by `mise run',
  '# edges-record`. It may never rise, and a NEW importing file is always a failure.',
  '# `exempt=yes` marks the two legacy ROUTERS, which keep their edges until Phase 4 deletes them.',
  '# Phase 0 (docs/2026-08-01-relir-build-plan.md §10) is OVER when the exempt rows are the only',
  '# rows left. See scripts/edges-check.ts.',
].join('\n');

const parse = (text: string): Entry[] =>
  text.split('\n').filter((l) => l && !l.startsWith('#') && l !== COLS).map((line) => {
    const f = line.split('\t');
    return { file: f[0], floor: Number(f[1]), exempt: f[2] === 'yes', note: f.slice(3).join('\t') };
  });

const serialize = (entries: readonly Entry[]): string =>
  [HEADER, COLS, ...[...entries].sort((a, b) => b.floor - a.floor || a.file.localeCompare(b.file))
    .map((e) => [e.file, e.floor, e.exempt ? 'yes' : 'no', e.note].join('\t'))].join('\n') + '\n';

// ---------- measurement ----------

/** Static `import …/`export … from` specifiers plus their import clause. A re-export is an edge like
 *  any other: it hands the symbol on without cutting anything. */
const SPEC = /(?:^|\n)\s*(?:import|export)\s*(?:(type\s+)?([\s\S]*?)\s*from\s*)?['"]([^'"]+)['"]/g;

/** Names a clause takes, with `type` markers and `as` aliases stripped. A default or namespace
 *  import counts as one symbol — it reaches the whole module, which is the worst kind of edge. */
function symbolsOf(clause: string | undefined): string[] {
  if (!clause) return ['<side-effect>'];
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (braced) {
    return braced[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
  }
  const ns = clause.match(/\*\s*as\s*(\w+)/);
  if (ns) return [`* as ${ns[1]}`];
  const dflt = clause.trim().replace(/^type\s+/, '').split(',')[0].trim();
  return dflt ? [dflt] : ['<side-effect>'];
}

async function scan(dir: string): Promise<Map<string, Set<string>>> {
  const glob = new Bun.Glob('**/*.ts');
  const found = new Map<string, Set<string>>();
  for await (const rel of glob.scan({ cwd: `${ROOT}/${dir}`, onlyFiles: true })) {
    const abs = `${ROOT}/${dir}/${rel}`;
    if (abs.startsWith(LEGACY)) continue; // inside legacy: not an edge INTO it
    const text = await Bun.file(abs).text();
    for (const m of text.matchAll(SPEC)) {
      const spec = m[3];
      if (!spec.startsWith('.')) continue;
      if (!resolve(dirname(abs), spec).startsWith(LEGACY)) continue;
      const key = relative(ROOT, abs);
      const set = found.get(key) ?? new Set<string>();
      for (const s of symbolsOf(m[1] ? `type ${m[2] ?? ''}` : m[2])) set.add(s);
      found.set(key, set);
    }
  }
  return found;
}

// ---------- run ----------

const src = await scan('src');
const informational = new Map([...await scan('test'), ...await scan('scripts')]);

const entries = parse(await Bun.file(RATCHET).text());
const byFile = new Map(entries.map((e) => [e.file, e]));

const measured = [...src].map(([file, syms]) => ({
  file, now: syms.size, symbols: [...syms].sort(), entry: byFile.get(file),
})).sort((a, b) => b.now - a.now || a.file.localeCompare(b.file));

const untracked = measured.filter((m) => !m.entry);
const risen = measured.filter((m) => m.entry && m.now > m.entry.floor);
const fallen = measured.filter((m) => m.entry && m.now < m.entry.floor);
const gone = entries.filter((e) => !src.has(e.file));
const live = measured.filter((m) => !m.entry?.exempt);

if (asJson) {
  console.log(JSON.stringify({ src: measured, informational: [...informational].map(([f, s]) => ({ file: f, symbols: [...s] })) }, null, 2));
} else {
  console.log(`edges: ${measured.length} file(s) in src/ import src/compiler/steps/ directly ` +
    `(${live.length} to cut, ${measured.length - live.length} exempt router(s))`);
  for (const { file, now, symbols, entry } of measured) {
    const delta = !entry ? '  NEW — untracked' : now > entry.floor ? `  ROSE from ${entry.floor}` : now < entry.floor ? `  (was ${entry.floor})` : '';
    console.log(`  ${String(now).padStart(3)}  ${file}${entry?.exempt ? '  [exempt: legacy router]' : ''}${delta}`);
    console.log(`       ${symbols.join(', ')}`);
  }
  if (informational.size) {
    console.log(`\ninformational — test/ + scripts/ (${informational.size} file(s), never gated: deleted with legacy)`);
    for (const [file, syms] of [...informational].sort()) console.log(`  ${String(syms.size).padStart(3)}  ${file}`);
  }
}

if (untracked.length) {
  console.error(`\nedges: ${untracked.length} NEW importer(s) of src/compiler/steps/ — Phase 0 only ever cuts edges.`);
  for (const m of untracked) console.error(`  ${m.file}: ${m.symbols.join(', ')}`);
  process.exit(1);
}

if (risen.length) {
  console.error(`\nedges: ${risen.length} file(s) ROSE above the committed floor — an edge ratchet only goes down.`);
  for (const m of risen) console.error(`  ${m.file}: ${m.entry!.floor} -> ${m.now}`);
  process.exit(1);
}

if (fallen.length || gone.length) {
  if (record) {
    const kept = measured.map((m) => ({ file: m.file, floor: m.now, exempt: m.entry!.exempt, note: m.entry!.note }));
    await Bun.write(RATCHET, serialize(kept));
    console.log(`\nrecorded: ${fallen.length} lowered, ${gone.length} edge(s) CUT. Commit scripts/steps-edges.tsv.`);
  } else {
    console.log(`\n${fallen.length} file(s) below the floor, ${gone.length} edge(s) fully cut — bank it with \`mise run edges-record\`.`);
  }
}

if (!live.length) console.log('\nPHASE 0 IS OVER — only the exempt routers reach into src/compiler/steps/.');
