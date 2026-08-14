#!/usr/bin/env bun
/**
 * The bind-budget gate: no statement's bind list may be a function of ROW COUNT.
 *
 *   bun scripts/binds-check.ts [--verbose]
 *
 * A Durable Object rejects a query carrying more than 100 bound parameters (src/cf-limits.ts).
 * `bun:sqlite` accepts 65,535, so the whole suite is green on a statement that hard-fails on the one
 * runtime we ship to — which is how TWO shipped paths came to breach it
 * (docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md §1c/§1d). This is the gate that stops
 * the idiom coming back, and the root CLAUDE.md states it as a rule: *never write `ids.map(() => '?')`*.
 *
 * THE SANCTIONED FORM IS ONE JSON BIND. A row set whose size is a function of DATA crosses the seam as
 * a single value exploded by `json_each` — `… IN (SELECT value FROM json_each(?))` for a read, a
 * relational `Insert` over `json_each` for a write (`src/setwrite.ts`, `src/formats/drain.ts`). There
 * is no longer a chunked placeholder builder to route through: a data-sized `IN (…)` list is never
 * correct, so the gate is simply that no code SYNTHESISES a placeholder list at all.
 *
 * ONE check, at zero: **no hand-rolled placeholder repetition** anywhere in `src/` — an arrow
 * returning a `?` literal (a `map`/`Array.from` callback), `.fill('?')`, `'?,'.repeat(n)`. Each is the
 * row-count-sized `IN (…)` spelled a different way, and each is what a `json_each(?)` membership
 * replaces.
 *
 * What it deliberately does NOT try to decide: whether an arbitrary `binds` array is bounded. That
 * is a dataflow question over every `store.query` call — `store.query(plan.sql, plan.binds)` is
 * unbounded to any local analysis and perfectly correct — and answering it would need an allowlist,
 * which is only somewhere for a real violation to hide. What IS decidable is the idiom, and the
 * idiom is what produced both walls.
 *
 * Comment handling: a match inside a comment is not a violation, and this matters immediately —
 * several comments quote the forbidden idiom in prose. Lines whose code starts with `//`, `*` or `/*`
 * are skipped, as is any match falling after a `//` on its line. That is a line-level rule, not a
 * tokenizer: typescript@7's npm package ships no JS AST API (only the native binary), so an exact
 * one would mean a new dependency. The residual blind spot is a violation buried inside a block
 * comment — which is not code and cannot execute.
 *
 * Not a ratchet. It passes at zero, so the gate is zero; a deliberate exception goes here as ONE
 * named entry with a diagnosis, the way test/L5-properties/known.ts does.
 *
 * Exit codes: 0 clean, 1 a violation.
 */
import { ROOT } from './lsp.ts';

const verbose = process.argv.includes('--verbose');

/** A string literal that is nothing but placeholders: `'?'`, `'?,'`, `', ?'`. */
const PH = String.raw`(['"\x60])[?,\s]*\?[?,\s]*\1`;

const SYNTHESIS: Array<{ re: RegExp; why: string }> = [
  { re: new RegExp(String.raw`=>\s*${PH}`), why: `an arrow returning a placeholder literal (a map/Array.from callback)` },
  { re: new RegExp(String.raw`\.fill\(\s*${PH}`), why: `.fill() with a placeholder literal` },
  { re: new RegExp(String.raw`${PH}\s*\.repeat\(`), why: `.repeat() over a placeholder literal` },
];

type Violation = { rel: string; line: number; why: string; text: string };
const violations: Violation[] = [];

/** The code part of a line: '' when the line is a comment, else the text before any `//`. */
function codeOf(line: string): string {
  const t = line.trimStart();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  const slashes = line.indexOf('//');
  return slashes < 0 ? line : line.slice(0, slashes);
}

const files = [...new Bun.Glob('src/**/*.ts').scanSync(ROOT)].sort();
if (!files.length) {
  console.error('found no src/**/*.ts files — is this being run from the wrong directory?');
  process.exit(1);
}

for (const rel of files) {
  const lines = (await Bun.file(`${ROOT}/${rel}`).text()).split('\n');
  for (const [i, raw] of lines.entries()) {
    const code = codeOf(raw);
    if (!code) continue;
    for (const { re, why } of SYNTHESIS)
      if (re.test(code))
        violations.push({ rel, line: i + 1, why: `${why} — a data-sized set is ONE json_each(?) bind, never an IN (…) list`, text: code.trim() });
  }
}

if (verbose) console.log(`scanned ${files.length} file(s)`);

for (const v of violations) console.error(`${v.rel}:${v.line}: ${v.why}\n    ${v.text}`);

if (violations.length) {
  console.error(`\n${violations.length} bind-budget violation(s).`);
  console.error('A bind list sized by ROW COUNT fails on Cloudflare at 100 binds. Cross a data-sized set as one json_each(?) bind (src/setwrite.ts, src/formats/drain.ts).');
  process.exit(1);
}
console.log('binds: clean (no hand-rolled placeholder synthesis)');
