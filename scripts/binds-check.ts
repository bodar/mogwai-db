#!/usr/bin/env bun
/**
 * The bind-budget gate: no statement's bind list may be a function of ROW COUNT.
 *
 *   bun scripts/binds-check.ts [--verbose]
 *
 * A Durable Object rejects a query carrying more than 100 bound parameters (src/cf-limits.ts).
 * `bun:sqlite` accepts 65,535, so the whole suite is green on a statement that hard-fails on the one
 * runtime we ship to — which is how TWO shipped paths came to breach it
 * (docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md §1c/§1d). The fix was `src/rowbatch.ts`;
 * this is the gate that stops the idiom coming back, and the root CLAUDE.md states it as a rule:
 * *never write `ids.map(() => '?')`*.
 *
 * Two checks, both at zero:
 *
 *   1. **No hand-rolled placeholder repetition** outside `src/rowbatch.ts` — an arrow returning a
 *      `?` literal (a `map`/`Array.from` callback), `.fill('?')`, `'?,'.repeat(n)`. `placeholders(n)`
 *      is the one sanctioned builder.
 *   2. **Every `placeholders(…)` call sits in a function that also chunks** — i.e. calls
 *      `bindChunks`. A placeholder list built without chunking is the defect restated, just spelled
 *      with our own helper. Function extents come from the LSP's `documentSymbol`, so this is the
 *      real enclosing declaration and not a brace-matching guess.
 *
 * What it deliberately does NOT try to decide: whether an arbitrary `binds` array is bounded. That
 * is a dataflow question over every `store.query` call — `store.query(plan.sql, plan.binds)` is
 * unbounded to any local analysis and perfectly correct — and answering it would need an allowlist,
 * which is only somewhere for a real violation to hide. What IS decidable is the idiom, and the
 * idiom is what produced both walls.
 *
 * Comment handling: a match inside a comment is not a violation, and this matters immediately —
 * several comments (including in `src/rowbatch.ts`'s own header and in `write.ts`, where the fix
 * landed) quote the forbidden idiom in prose. Lines whose code starts with `//`, `*` or `/*` are
 * skipped, as is any match falling after a `//` on its line. That is a line-level rule, not a
 * tokenizer: typescript@7's npm package ships no JS AST API (only the native binary), so an exact
 * one would mean a new dependency. The residual blind spot is a violation buried inside a block
 * comment — which is not code and cannot execute.
 *
 * Not a ratchet. It passes at zero, so the gate is zero; a deliberate exception goes here as ONE
 * named entry with a diagnosis, the way test/L5-properties/known.ts does.
 *
 * Exit codes: 0 clean, 1 a violation (or an analysis failure — a `placeholders(…)` call whose
 * enclosing function cannot be resolved is reported, never silently skipped).
 */
import { ROOT, startSession, uriOf } from './lsp.ts';

const verbose = process.argv.includes('--verbose');

/** The one file allowed to build a placeholder list from scratch — RowBatch itself. */
const BUILDER = 'src/rowbatch.ts';

/** A string literal that is nothing but placeholders: `'?'`, `'?,'`, `', ?'`. */
const PH = String.raw`(['"\x60])[?,\s]*\?[?,\s]*\1`;

const SYNTHESIS: Array<{ re: RegExp; why: string }> = [
  { re: new RegExp(String.raw`=>\s*${PH}`), why: `an arrow returning a placeholder literal (a map/Array.from callback)` },
  { re: new RegExp(String.raw`\.fill\(\s*${PH}`), why: `.fill() with a placeholder literal` },
  { re: new RegExp(String.raw`${PH}\s*\.repeat\(`), why: `.repeat() over a placeholder literal` },
];

type Violation = { rel: string; line: number; why: string; text: string };
const violations: Violation[] = [];
const unresolved: string[] = [];

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

// ---------- check 1: hand-rolled placeholder repetition ----------
type Call = { rel: string; line: number; character: number };
const placeholderCalls: Call[] = [];

for (const rel of files) {
  const lines = (await Bun.file(`${ROOT}/${rel}`).text()).split('\n');
  for (const [i, raw] of lines.entries()) {
    const code = codeOf(raw);
    if (!code) continue;
    if (rel !== BUILDER)
      for (const { re, why } of SYNTHESIS)
        if (re.test(code)) violations.push({ rel, line: i + 1, why: `${why} — build it with placeholders() from ${BUILDER}`, text: code.trim() });
    // `placeholders(` as a CALL, not the import or the declaration.
    const at = /(?<![\w.])placeholders\(/.exec(code);
    if (at && !/^\s*(export|import)\b/.test(code)) placeholderCalls.push({ rel, line: i, character: at.index });
  }
}

// ---------- check 2: every placeholders() call is inside a function that chunks ----------
type SymbolInfo = { name: string; kind: number; location: { range: { start: { line: number }; end: { line: number } } } };

/** LSP `SymbolKind` Variable(13) / Constant(14). A WRAPPED declaration statement whose initializer
 *  happens to contain the call — `const clash = store.query(\`… IN (${placeholders(n)})\`, chunk)` —
 *  is the innermost symbol containing that line, and it is never the chunking SCOPE. Excluded when
 *  short; a multi-line arrow assigned to a const IS a real function scope, and a chunking one always
 *  spans at least a loop plus its body, so the cut is at 3 lines. (Measured kinds at the real call
 *  sites: a method(6), a function(12) and an object-literal property(7) — none of them 13/14.) */
const DECLARATION_KINDS = new Set([13, 14]);
const MIN_SCOPE_LINES = 3;

if (placeholderCalls.length) {
  const session = await startSession();
  const byFile = new Map<string, Call[]>();
  for (const c of placeholderCalls) byFile.set(c.rel, [...(byFile.get(c.rel) ?? []), c]);

  for (const [rel, calls] of byFile) {
    const text = await session.open(rel);
    const lines = text.split('\n');
    const res = await session.request('textDocument/documentSymbol', { textDocument: { uri: uriOf(rel) } });
    const symbols: SymbolInfo[] = (res.result ?? []).filter((s: any) => s?.location?.range);

    for (const call of calls) {
      // The INNERMOST declaration containing the call — a nested arrow beats its host function.
      // A symbol STARTING on the call's own line is skipped: that is the declaration the call
      // initializes (`const ph = placeholders(chunk.length)`), whose scope is not the loop the call
      // has to sit in. (So a whole function written on one line resolves to nothing and is reported
      // as unresolved rather than passed — fail closed.)
      const enclosing = symbols
        .filter((s) => s.location.range.start.line < call.line && call.line <= s.location.range.end.line)
        .filter((s) => !DECLARATION_KINDS.has(s.kind)
          || s.location.range.end.line - s.location.range.start.line + 1 >= MIN_SCOPE_LINES)
        .sort((a, b) => (a.location.range.end.line - a.location.range.start.line) - (b.location.range.end.line - b.location.range.start.line))[0];
      if (!enclosing) {
        unresolved.push(`${rel}:${call.line + 1} — placeholders() call has no enclosing declaration in documentSymbol`);
        continue;
      }
      const { start, end } = enclosing.location.range;
      const body = lines.slice(start.line, end.line + 1).map(codeOf).join('\n');
      if (!/\bbindChunks\(/.test(body))
        violations.push({
          rel, line: call.line + 1,
          why: `placeholders() in \`${enclosing.name}\`, which never calls bindChunks — the list's length is then whatever the caller passed`,
          text: lines[call.line].trim(),
        });
      else if (verbose) console.log(`  ${rel}:${call.line + 1} placeholders() in ${enclosing.name} — chunked`);
    }
  }
  session.close();
}

// ---------- report ----------
if (verbose) console.log(`scanned ${files.length} file(s), ${placeholderCalls.length} placeholders() call(s)`);

for (const u of unresolved) console.error(`ANALYSIS FAILURE ${u}`);
for (const v of violations) console.error(`${v.rel}:${v.line}: ${v.why}\n    ${v.text}`);

if (violations.length || unresolved.length) {
  console.error(`\n${violations.length} bind-budget violation(s), ${unresolved.length} unresolved.`);
  console.error('A bind list sized by ROW COUNT fails on Cloudflare at 100 binds. See src/rowbatch.ts.');
  process.exit(1);
}
console.log(`binds: clean (${placeholderCalls.length} placeholders() call(s), all chunked)`);
