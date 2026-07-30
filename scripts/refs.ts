#!/usr/bin/env bun
/**
 * Find every real USE of a symbol — the compiler's answer, not a text match.
 *
 *   bun scripts/refs.ts <name>              # resolve by name, then list references
 *   bun scripts/refs.ts <name> --fuzzy      # also accept prefix/substring symbol matches
 *   bun scripts/refs.ts <file>:<line>:<col> # skip resolution, query at an exact position
 *   bun scripts/refs.ts <name> --decl       # include the declaration in the results
 *
 * Why this exists: `grep` answers a different question. It matches the name in comments, in prose,
 * in unrelated identifiers that merely contain it, and in strings — and it misses nothing, so the
 * noise is indistinguishable from the signal without reading every hit. Three findings in the
 * orphan sweep (`compile`, `standardRegistry`, `PASSES`) looked like tool bugs precisely because
 * grep showed dozens of "uses" that were all comments. `textDocument/references` is the type
 * checker's own resolution, so a comment mentioning the name is not a reference and a same-named
 * symbol in another scope is not a reference.
 *
 * Resolution is `workspace/symbol`, which is FUZZY — a query for `compile` returns 75 hits
 * including `compileAddV`. So an exact name match is the default and `--fuzzy` opts out. A name
 * that resolves to several declarations (an interface method and its implementation, the ordinary
 * case in this codebase — `lowerSteps` is on `engine/deps.ts` and `engine/engine.ts`) is NOT an
 * error: each declaration is reported with its own references, because they are genuinely different
 * questions and picking one silently would answer the wrong one.
 *
 * Exit codes: 0 whatever it finds, 1 only if the name resolves to nothing (a typo should be loud).
 */
import { ROOT, relOf, startSession, uriOf } from './lsp.ts';

const argv = process.argv.slice(2);
const fuzzy = argv.includes('--fuzzy');
const withDecl = argv.includes('--decl');
const [target] = argv.filter((a) => !a.startsWith('--'));

if (!target) {
  console.error('usage: bun scripts/refs.ts <name|file:line:col> [--fuzzy] [--decl]');
  process.exit(1);
}

/** LSP SymbolKind -> a readable word. Only the kinds this codebase actually produces. */
const KIND: Record<number, string> = {
  2: 'module', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor',
  10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 26: 'type-param',
};

type Decl = { name: string; kind: number; rel: string; line: number; character: number };

const session = await startSession();

// ---------- resolve the target to one or more declarations ----------
const decls: Decl[] = [];
const posMatch = /^(.+\.ts):(\d+):(\d+)$/.exec(target);

if (posMatch) {
  const [, rel, line, col] = posMatch;
  await session.open(rel);
  decls.push({ name: target, kind: 0, rel, line: Number(line) - 1, character: Number(col) - 1 });
} else {
  // workspace/symbol needs a built program; opening one file is enough to force it.
  await session.open('src/compiler/compiler.ts');
  const res = await session.request('workspace/symbol', { query: target });
  for (const h of (res.result ?? []) as any[]) {
    if (!fuzzy && h.name !== target) continue;
    const loc = h.location;
    if (!loc?.uri) continue;
    decls.push({
      name: h.name, kind: h.kind, rel: relOf(loc.uri),
      line: loc.range.start.line, character: loc.range.start.character,
    });
  }
}

if (!decls.length) {
  console.error(`refs: no symbol named \`${target}\`${fuzzy ? '' : ' (exact match; try --fuzzy)'}`);
  session.close();
  process.exit(1);
}

// ---------- references per declaration ----------
const textOf = new Map<string, string[]>();
const lineAt = async (rel: string, line: number) => {
  if (!textOf.has(rel)) {
    const f = Bun.file(`${ROOT}/${rel}`);
    textOf.set(rel, await f.exists() ? (await f.text()).split('\n') : []);
  }
  return textOf.get(rel)![line] ?? '';
};

const bucketOf = (rel: string) =>
  rel.startsWith('test/') ? 'test' : rel.startsWith('scripts/') ? 'scripts'
  : rel.startsWith('parser/') ? 'parser' : 'src';

for (const d of decls) {
  await session.open(d.rel);
  const res = await session.request('textDocument/references', {
    textDocument: { uri: uriOf(d.rel) },
    position: { line: d.line, character: d.character },
    context: { includeDeclaration: withDecl },
  });
  const refs = ((res.result ?? []) as any[]).map((r) => ({ rel: relOf(r.uri), line: r.range.start.line }));

  const kind = KIND[d.kind] ?? (d.kind ? `kind${d.kind}` : 'position');
  console.log(`\n${d.name}  (${kind})  declared at ${d.rel}:${d.line + 1}`);

  if (!refs.length) { console.log('  no references'); continue; }

  const tally = new Map<string, number>();
  for (const r of refs) tally.set(bucketOf(r.rel), (tally.get(bucketOf(r.rel)) ?? 0) + 1);
  const summary = [...tally].sort().map(([b, n]) => `${b} ${n}`).join(', ');
  console.log(`  ${refs.length} reference(s) — ${summary}`);

  const byFile = new Map<string, number[]>();
  for (const r of refs) byFile.set(r.rel, [...(byFile.get(r.rel) ?? []), r.line]);
  for (const [rel, lines] of [...byFile].sort()) {
    console.log(`    ${rel}`);
    for (const l of lines.sort((a, b) => a - b)) {
      console.log(`      ${String(l + 1).padStart(5)}: ${(await lineAt(rel, l)).trim().slice(0, 110)}`);
    }
  }
}

session.close();
