#!/usr/bin/env bun
/**
 * Find exports nothing imports, via LSP `textDocument/references`.
 *
 *   bun scripts/orphans.ts [--verbose] [--json] [paths…]
 *
 * **An export with zero references is a QUESTION, not a verdict.** This reports; it never edits.
 * The whole point of using references rather than grep is that the answer is the compiler's, but
 * the compiler does not know about the reflective edges this codebase genuinely has — a DI-
 * registered leaf, a service reached by name through the registry, a symbol named only from a
 * `.feature` step definition, or the worker/server entry points the runtime imports and no source
 * file does. Each of those is a live export that looks dead here. So every finding carries a
 * TEXTUAL mention count across the whole repo (including .feature and .md) as a triage hint: a
 * name with zero references AND zero prose mentions is a very different candidate from one that
 * eleven Gherkin steps talk about.
 *
 * Three findings, in descending confidence — the distinction is the useful part, because the
 * middle one has a safe mechanical fix and the other two do not:
 *
 *   local-only  referenced ONLY inside its own file -> drop the `export` keyword. Safe.
 *   test-only   referenced ONLY from test/ -> product code kept alive by its own test. A real
 *               signal, and the one this sweep exists to surface; deleting it is a judgement call.
 *   orphan      referenced nowhere at all -> delete, unexport, or it is a reflective edge.
 *
 * Scans `src` and `scripts` by default, NOT `test`: a test helper is referenced by its own suite
 * and nothing else, so scanning tests would bury the signal under every fixture in the tree. That
 * is the "exclude test files from the is-it-referenced question" rule from the plan doc, applied
 * to the scan set rather than to the reference set — keeping test references VISIBLE is what makes
 * `test-only` a category instead of a false negative.
 *
 * Exit code is 0 whatever it finds. This is an instrument, not a gate: gating it would either
 * demand an allowlist (somewhere for a real orphan to hide) or force a deletion the tool is
 * explicitly not confident enough to make.
 */
import { ROOT, relOf, startSession, uriOf } from './lsp.ts';

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const asJson = argv.includes('--json');
const roots = argv.filter((a) => !a.startsWith('--'));

const SCAN = roots.length ? roots : ['src', 'scripts'];
const isTest = (rel: string) => rel.startsWith('test/');

/** `export <kind> <name>` declaration forms. `export {…}` and `export default` are handled below. */
const DECL = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const|let|var|function|class|type|interface|enum)\s+(\w+)/;

type Finding = {
  rel: string; line: number; name: string; kind: string;
  own: number; prod: number; test: number; mentions: number;
  verdict: 'orphan' | 'local-only' | 'test-only';
};

// ---------- collect candidate exports ----------
const glob = new Bun.Glob('**/*.ts');
const files: string[] = [];
for (const root of SCAN) {
  if (root.endsWith('.ts')) { files.push(root); continue; }
  for await (const rel of glob.scan({ cwd: `${ROOT}/${root}`, onlyFiles: true })) files.push(`${root}/${rel}`);
}
files.sort();

const session = await startSession();
const findings: Finding[] = [];
let scanned = 0;
let reexports = 0;

for (const rel of files) {
  const text = await session.open(rel);
  const lines = text.split('\n');

  for (const [i, line] of lines.entries()) {
    // `export { a, b as c }` re-export lists: counted and skipped. Resolving each name to its
    // ORIGINAL declaration is a different query, and a re-export is a routing decision anyway.
    if (/^export\s*\{/.test(line)) { reexports++; continue; }
    const m = DECL.exec(line);
    if (!m) continue;
    const [, kind, name] = m;
    const character = line.indexOf(name, line.indexOf(kind));
    scanned++;

    const res = await session.request('textDocument/references', {
      textDocument: { uri: uriOf(rel) },
      position: { line: i, character },
      context: { includeDeclaration: false },
    });
    const refs: Array<{ uri: string }> = res.result ?? [];

    let own = 0, prod = 0, test = 0;
    for (const r of refs) {
      const f = relOf(r.uri);
      if (f === rel) own++;
      else if (isTest(f)) test++;
      else prod++;
    }
    if (prod > 0) continue; // referenced by real product code — not a finding

    const verdict = own > 0 && test === 0 ? 'local-only' : test > 0 ? 'test-only' : 'orphan';
    findings.push({ rel, line: i + 1, name, kind, own, prod, test, mentions: 0, verdict });
  }
}
session.close();

// ---------- textual mention count (the reflective-edge triage hint) ----------
// Deliberately a whole-repo text search including .feature/.md/.json, precisely the edges the
// compiler cannot see. Counted per finding so the report can be read without a second tool.
for (const f of findings) {
  const proc = Bun.spawn(['git', 'grep', '-I', '--word-regexp', '-c', '-e', f.name, '--',
    ':!parser/', ':!vendor/', ':!node_modules/'], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  // `file:count` per line; subtract this symbol's own declaration file to leave OTHER mentions.
  let total = 0;
  for (const l of out.split('\n')) {
    const m = /^(.*):(\d+)$/.exec(l);
    if (m && m[1] !== f.rel) total += Number(m[2]);
  }
  f.mentions = total;
}

// ---------- report ----------
if (asJson) {
  console.log(JSON.stringify({ scanned, reexports, findings }, null, 2));
} else {
  console.log(`orphans: ${scanned} exported declaration(s) across ${files.length} file(s) in ${SCAN.join(', ')}`);
  if (reexports) console.log(`         ${reexports} \`export {…}\` list(s) skipped — a re-export is a routing decision`);

  for (const verdict of ['local-only', 'test-only', 'orphan'] as const) {
    const group = findings.filter((f) => f.verdict === verdict);
    if (!group.length) continue;
    const HEAD: Record<typeof verdict, string> = {
      'local-only': 'referenced only inside their own file — drop the `export` keyword (safe)',
      // Precise wording matters here: these MAY also be used inside their own file. What the
      // finding says is that no product file OUTSIDE the declaring one references them, so the
      // export exists for the test suite.
      'test-only': 'no product file outside their own references them; test/ does',
      orphan: 'no references at all — delete, unexport, or a reflective edge the compiler cannot see',
    };
    console.log(`\n${group.length} ${verdict}: ${HEAD[verdict]}`);
    for (const f of group.sort((a, b) => a.mentions - b.mentions || a.rel.localeCompare(b.rel))) {
      const hint = f.mentions === 0 ? '' : `  (${f.mentions} textual mention(s) elsewhere — check before deleting)`;
      console.log(`  ${f.rel}:${f.line}  ${f.kind} ${f.name}${hint}`);
      if (verbose) console.log(`      refs: own=${f.own} test=${f.test} prod=${f.prod}`);
    }
  }
  if (!findings.length) console.log('\nno findings: every export is referenced by product code.');
}
