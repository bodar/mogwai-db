#!/usr/bin/env bun
/**
 * The DELETION ratchet — a countdown, not a report.
 *
 *   bun scripts/deletion-check.ts [--record] [--json]
 *
 * A migration has two counters and they fail differently. Coverage says the new thing works;
 * deletion says the old thing is GONE, and it is the second one that stalls while the first looks
 * finished (`docs/2026-08-01-relir-build-plan.md` §10·4: *"Coverage at 100% with a non-empty §8
 * list is a FAILED migration, not a finished one"*). A number that is merely printed drifts, so
 * this is a ratchet with a committed floor — `scripts/deletion-ratchet.tsv` — in the same mould as
 * L3's `l3-state.json`: it may only ever go DOWN.
 *
 * It is deliberately GENERIC. A row names one thing a plan has promised to delete, and the plan
 * that owns it; nothing about RelIR is hardcoded here. A future migration adds rows, not a script.
 *
 * Two measurement kinds, because §8's list is not uniformly a list of symbols:
 *
 *   symbol   an exported name. Measured as `textDocument/references` INCLUDING the declaration,
 *            across src/ scripts/ test/ — the compiler's own resolution, so a comment mentioning
 *            the name is not a use (the whole reason `refs.ts` exists). Reaches 0 only when the
 *            declaration itself is gone, which is what "deleted" means. A name that resolves to
 *            several declarations sums all of them.
 *   pattern  a regex over src/, for the §8 entries that name a SHAPE rather than a symbol — "the
 *            five-copy `count` adapter" is five copies of one expression, and the shared function
 *            it wraps is staying. Counted as matching lines.
 *
 * `--record` rewrites the floor DOWNWARD only, and is what a landing commit runs. That direction
 * is why auto-recording is safe here and is not for the census: a downward-only counter cannot
 * launder a regression, it can only bank an improvement — L3's argument exactly. An INCREASE is
 * always a failure and `--record` refuses it.
 *
 * Exit 0 when every row is at or below its floor; 1 otherwise. The migration is over when every
 * floor is 0 — which the summary line states rather than leaving to be inferred.
 */
import { ROOT, relOf, startSession, uriOf } from './lsp.ts';

const argv = process.argv.slice(2);
const record = argv.includes('--record');
const asJson = argv.includes('--json');

const RATCHET = `${ROOT}/scripts/deletion-ratchet.tsv`;

type Kind = 'symbol' | 'pattern';
interface Entry {
  readonly plan: string;
  readonly kind: Kind;
  readonly key: string;
  readonly floor: number;
  readonly note: string;
}

const COLS = 'plan\tkind\tkey\tfloor\tnote';
const HEADER = [
  '# The DELETION ratchet — every name a plan has promised to remove, and how much of it is left.',
  '# GENERATED FLOOR: `floor` is re-recorded DOWNWARD by `mise run deletion-record`. It may never',
  '# rise; a rise is the gate failing. The migration owning a plan is finished when every one of',
  '# its floors is 0 — coverage reaching 100% with a non-empty list here is a FAILED migration.',
  '# `kind=symbol` is measured by LSP references (declaration included) across src/ scripts/ test/;',
  '# `kind=pattern` is a regex counted over src/. See scripts/deletion-check.ts.',
].join('\n');

function parseRatchet(text: string): Entry[] {
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  if (lines[0] === COLS) lines.shift();
  return lines.map((line) => {
    const f = line.split('\t');
    return { plan: f[0], kind: f[1] as Kind, key: f[2], floor: Number(f[3]), note: f.slice(4).join('\t') };
  });
}

const serializeRatchet = (entries: readonly Entry[]): string =>
  [HEADER, COLS, ...entries.map((e) => [e.plan, e.kind, e.key, e.floor, e.note].join('\t'))].join('\n') + '\n';

// ---------- measurement ----------

/**
 * Lines in src/ matching a regex. A §8 "copy" is a LINE, so two hits on one line count once.
 *
 * Scanned in-process rather than shelled out to `rg`: the CI runner has no ripgrep, and a gate that
 * passes locally and dies on a missing binary is worse than no gate. `git grep` has the same
 * problem in reverse — it would work here but reads the INDEX, so an unstaged edit is invisible to
 * the very check that is meant to see it.
 */
const SRC = new Bun.Glob('**/*.ts');
let srcFiles: string[] | undefined;

async function patternCount(re: string): Promise<number> {
  if (!srcFiles) {
    srcFiles = [];
    for await (const rel of SRC.scan({ cwd: `${ROOT}/src`, onlyFiles: true })) srcFiles.push(`src/${rel}`);
    srcFiles.sort();
  }
  const rx = new RegExp(re);
  let n = 0;
  for (const rel of srcFiles) {
    for (const line of (await Bun.file(`${ROOT}/${rel}`).text()).split('\n')) if (rx.test(line)) n++;
  }
  return n;
}

const COUNTED = (rel: string) =>
  rel.startsWith('src/') || rel.startsWith('scripts/') || rel.startsWith('test/');

async function symbolCount(session: Awaited<ReturnType<typeof startSession>>, name: string): Promise<number> {
  const res = await session.request('workspace/symbol', { query: name });
  const decls = ((res.result ?? []) as any[])
    .filter((h) => h.name === name && h.location?.uri && COUNTED(relOf(h.location.uri)));
  // A name with no declaration is deleted — the terminal state, not an error.
  if (!decls.length) return 0;

  // Dedup across declarations: an interface method and its implementation resolve separately and
  // their reference sets overlap. Position-keyed, so one site is one hit however many ways it
  // was reached.
  const hits = new Set<string>();
  for (const d of decls) {
    const rel = relOf(d.location.uri);
    await session.open(rel);
    const refs = await session.request('textDocument/references', {
      textDocument: { uri: uriOf(rel) },
      position: d.location.range.start,
      context: { includeDeclaration: true },
    });
    for (const r of ((refs.result ?? []) as any[])) {
      const f = relOf(r.uri);
      if (COUNTED(f)) hits.add(`${f}:${r.range.start.line}:${r.range.start.character}`);
    }
  }
  return hits.size;
}

// ---------- run ----------

const entries = parseRatchet(await Bun.file(RATCHET).text());
const session = await startSession();
// workspace/symbol needs a built program; opening one file forces it.
await session.open('src/compiler/compiler.ts');

const measured: { entry: Entry; now: number }[] = [];
for (const entry of entries) {
  const now = entry.kind === 'symbol' ? await symbolCount(session, entry.key) : await patternCount(entry.key);
  measured.push({ entry, now });
}
session.close();

const risen = measured.filter((m) => m.now > m.entry.floor);
const fallen = measured.filter((m) => m.now < m.entry.floor);
const remaining = measured.reduce((n, m) => n + Math.min(m.now, m.entry.floor), 0);

if (asJson) {
  console.log(JSON.stringify(measured.map((m) => ({ ...m.entry, now: m.now })), null, 2));
} else {
  const plans = [...new Set(entries.map((e) => e.plan))];
  for (const plan of plans) {
    const rows = measured.filter((m) => m.entry.plan === plan);
    const live = rows.filter((m) => m.now > 0);
    console.log(`\n${plan}: ${rows.length - live.length}/${rows.length} deleted, ${live.length} remaining`);
    for (const { entry, now } of rows.filter((m) => m.now > 0).sort((a, b) => b.now - a.now)) {
      console.log(`  ${String(now).padStart(4)}  ${entry.kind === 'pattern' ? '/' + entry.key + '/' : entry.key}` +
        `${now > entry.floor ? `   ROSE from ${entry.floor}` : now < entry.floor ? `   (was ${entry.floor})` : ''}`);
      if (entry.note) console.log(`        ${entry.note}`);
    }
  }
  console.log(`\ntotal remaining references: ${remaining}`);
}

if (risen.length) {
  console.error(`\ndeletion: ${risen.length} row(s) ROSE above the committed floor — a deletion ratchet only goes down.`);
  for (const { entry, now } of risen) console.error(`  ${entry.key}: ${entry.floor} -> ${now}`);
  process.exit(1);
}

if (fallen.length) {
  if (record) {
    await Bun.write(RATCHET, serializeRatchet(measured.map((m) => ({ ...m.entry, floor: m.now }))));
    console.log(`\nrecorded: ${fallen.length} row(s) lowered. Commit scripts/deletion-ratchet.tsv.`);
  } else {
    console.log(`\n${fallen.length} row(s) are BELOW the floor — bank it with \`mise run deletion-record\`.`);
  }
}

if (measured.every((m) => m.now === 0)) console.log('\nEVERY floor is 0 — the deletion list is empty.');
