// Re-extract conformance corpus.txt — the L1 parse corpus — from the tinkerpop
// submodule's Gherkin features. Each scenario carries its traversal in a `"""`
// docstring; we pull every docstring whose body is a `g.…` expression, dedupe,
// and sort.
//
// SOURCE = the submodule's `origin/master` ref, NOT the pinned beta.2 checkout.
// mogwai's parser tracks tinkerpop master (it implements not-yet-released grammar
// — Char/Duration/Binary/PDT literals, match(String), child-traversal args — for
// forward-compatibility; the grammar is a strict superset, so beta.2 clients are
// unaffected, proven by L3=204). The corpus must exercise that same master
// grammar, so it is sourced from master too. L3 conformance separately tracks the
// pinned beta.2 checkout (the published npm). Run `mise run regen-corpus`; commit
// the diff. corpus.txt stays committed so the L1 test needs no submodule at test
// time.
import { readdirSync, readFileSync, writeFileSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('../../', import.meta.url).pathname;
const SUBMODULE = join(ROOT, 'vendor/tinkerpop');
const FEATURES_PATH = 'gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features';
const REF = 'origin/master';
const OUT = new URL('./corpus.txt', import.meta.url).pathname;
// The SECOND artifact: which SCENARIO each traversal came from. corpus.txt is deduped and sorted, so
// it cannot answer "does any route ANSWER this one" — that question is settled by `l3-state.json`,
// which is keyed on the scenario NAME. Emitting the join here rather than re-deriving it keeps every
// consumer submodule-free (corpus.txt's own reason for being committed) and keeps the two artifacts
// from drifting: they come out of one extraction pass over one ref.
const OUT_SCENARIOS = new URL('./scenarios.tsv', import.meta.url).pathname;

// The submodule's origin/master ref is only fetched at clone time and never
// refreshed by `git submodule update` (which fetches the pinned SHA), so refresh
// it here or we'd extract from a stale clone-time snapshot of master.
const fetch = Bun.spawnSync(['git', '-C', SUBMODULE, 'fetch', '--filter=blob:none', '--quiet', 'origin', 'master']);
if (!fetch.success) throw new Error(`git fetch origin master failed: ${fetch.stderr}`);

// Export master's feature tree (it is not in the pinned checkout) into a temp dir.
const work = mkdtempSync(join(tmpdir(), 'mogwai-corpus-'));
const archive = Bun.spawnSync(['git', '-C', SUBMODULE, 'archive', REF, FEATURES_PATH]);
if (!archive.success) throw new Error(`git archive ${REF} failed: ${archive.stderr}`);
const untar = Bun.spawnSync(['tar', '-x', '-C', work], { stdin: archive.stdout });
if (!untar.success) throw new Error(`tar extract failed: ${untar.stderr}`);

function* featureFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* featureFiles(p);
    else if (name.endsWith('.feature')) yield p;
  }
}

const traversals = new Set<string>();
// `scenario<TAB>traversal`, one line per PAIR — the relation is many-to-many in both directions and
// flattening either way would lose a real edge. One scenario can carry several docstrings, and one
// traversal is routinely shared by scenarios over different graph fixtures.
const pairs = new Set<string>();
for (const file of featureFiles(join(work, FEATURES_PATH))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  // The nearest preceding `Scenario:`/`Scenario Outline:` OWNS the docstring — Gherkin has no other
  // way to attach one, and the extraction is a line scan rather than a parse for the same reason the
  // traversal half is (see the header: this file must run against a bare `git archive` of the ref).
  let scenario = '';
  for (let i = 0; i < lines.length; i++) {
    const heading = /^Scenario(?: Outline)?:\s*(.+)$/.exec(lines[i].trim());
    if (heading) { scenario = heading[1].trim(); continue; }
    if (!lines[i].trim().startsWith('"""')) continue;
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i].trim().startsWith('"""'); i++) body.push(lines[i].trim());
    const q = body.join(' ').trim();
    if (!q.startsWith('g.')) continue;
    traversals.add(q);
    if (scenario) pairs.add(`${scenario}\t${q}`);
  }
}

const sorted = [...traversals].sort();
writeFileSync(OUT, sorted.join('\n') + '\n');
const sortedPairs = [...pairs].sort();
writeFileSync(OUT_SCENARIOS, sortedPairs.join('\n') + '\n');
console.log(`corpus.txt: ${sorted.length} unique traversals extracted from tinkerpop ${REF}`);
console.log(`scenarios.tsv: ${sortedPairs.length} scenario→traversal pairs`);
