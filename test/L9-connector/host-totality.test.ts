// L9 — HOST TOTALITY: every child-taking position is a CONNECTORS row or a written-down deferral.
//
// Root CLAUDE.md locked decision 6: nesting composes through ONE mechanism, the scoped-relation connector. The
// way that rule erodes is not a big decision but a small one — a new host gets a route of its own because it
// was quicker. This test makes that impossible to do quietly: it DERIVES every child-taking position the
// front end can produce, from three independent sources, and requires each to be either a connector host
// (`CONNECTOR_HOSTS`, `src/compiler/ir/analyze.ts` — checked equal to `CONNECTORS` in `rel/lower/scoped.ts`
// at load) or an entry in `DEFERRED_HOSTS` (`deferred-hosts.ts`) carrying its reason and blocker.
//
//   • the GRAMMAR — every `traversalMethod_<step>` rule of the vendored `Gremlin.g4` with a `nestedTraversal`
//     argument, and every `traversalPredicate_*` rule with one (`P(traversal)`). Total over the language.
//   • the L1 CORPUS — every step (and `by()`/`with()` modulator, keyed `<step>.by`) holding a nested traversal
//     at any depth. Catches what the grammar spells generically (`genericArgument` admits a traversal, so
//     `combine(__.x)` is not a grammar `nestedTraversal`) and the modulator positions the grammar cannot
//     attribute to a host.
//   • the L5 GENERATOR's host table (`test/L5-properties/hosts.ts`) — the hosts the closure ratchet measures.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONNECTOR_HOSTS } from '../../src/compiler/ir/analyze.ts';
import { parseGremlin, stepChain, isNested, type Step } from '../../src/gremlin/frontend.ts';
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import { valueNodes } from '../../src/compiler/ir/walk.ts';
import { HOSTS } from '../L5-properties/hosts.ts';
import { summary } from '../support/output.ts';
import { DEFERRED_HOSTS } from './deferred-hosts.ts';

const GRAMMAR = new URL('../../vendor/tinkerpop/gremlin-language/src/main/antlr4/Gremlin.g4', import.meta.url);
const CORPUS = new URL('../L1-corpus/corpus.txt', import.meta.url);
/** Modulators: a child here belongs to the step they modulate, keyed `<step>.<modulator>`. */
const MODULATORS = new Set(['by', 'with']);

/** Grammar positions: step methods and predicates whose alternatives take a `nestedTraversal`. */
function fromGrammar(): Set<string> {
  const found = new Set<string>();
  let rule = '';
  for (const line of readFileSync(GRAMMAR, 'utf8').split('\n')) {
    const header = line.match(/^([A-Za-z_]\w*)\s*(?::|$)/);
    if (header) rule = header[1]!;
    else if (/^\S/.test(line)) rule = '';
    if (!rule || !/\bnestedTraversal/.test(line)) continue;
    const step = rule.match(/^traversalMethod_(\w+)$/)?.[1];
    if (step && !MODULATORS.has(step)) found.add(step);
    if (/^traversalPredicate_\w+$/.test(rule)) found.add('P(traversal)');
  }
  return found;
}

/** Corpus positions, at every depth. A chain that does not parse is skipped — L1 owns parse coverage. */
function fromCorpus(): Set<string> {
  const found = new Set<string>();
  const walk = (chain: readonly Step[]): void => chain.forEach((s, i) => {
    for (const arg of s.args ?? []) for (const n of valueNodes(arg.value)) {
      if (!isNested(n)) continue;
      let key = s.name;
      if (MODULATORS.has(s.name)) {
        let j = i - 1;
        while (j >= 0 && MODULATORS.has(chain[j]!.name)) j--;
        if (j < 0) continue;
        key = `${chain[j]!.name}.${s.name}`;
      }
      found.add(key);
      try { walk(stepChain(n.nested, NO_PARAMS)); } catch { /* an unparameterized body — skip */ }
    }
  });
  for (const q of readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean)) {
    try { walk(stepChain(parseGremlin(q), NO_PARAMS)); } catch { /* an unparameterized traversal — skip */ }
  }
  return found;
}

/** A position's host step: `order.by` → `order`. */
const hostOf = (key: string) => (key === 'P(traversal)' ? key : key.split('.')[0]!);

describe('L9 — host totality', () => {
  const grammar = fromGrammar();
  const corpus = fromCorpus();
  const generator = new Set(HOSTS.map((h) => h.name));
  const positions = [...new Set([...grammar, ...corpus, ...generator])].sort();

  test('every child-taking position is a CONNECTORS row or a written-down deferral', () => {
    summary(`L9 host totality: ${positions.length} child-taking positions (grammar ${grammar.size}, corpus ${corpus.size}, generator ${generator.size});`
      + ` ${positions.filter((k) => CONNECTOR_HOSTS.has(hostOf(k))).length} connector-owned, ${positions.filter((k) => !CONNECTOR_HOSTS.has(hostOf(k)) && DEFERRED_HOSTS[k]).length} deferred`);
    const unowned = positions.filter((k) => !CONNECTOR_HOSTS.has(hostOf(k)) && !DEFERRED_HOSTS[k]);
    expect(
      unowned,
      'a child-taking position is neither a CONNECTORS row (src/compiler/rel/lower/scoped.ts) nor in test/L9-connector/deferred-hosts.ts. '
      + 'Make it a connector row (root CLAUDE.md decision 6), or defer it there with its reason and blocker — never a route of its own.',
    ).toEqual([]);
  });

  test('no deferral names a connector host (a landed host deletes its entry)', () => {
    expect(Object.keys(DEFERRED_HOSTS).filter((k) => CONNECTOR_HOSTS.has(hostOf(k)))).toEqual([]);
  });

  test('every deferral carries a reason and a blocker', () => {
    expect(Object.entries(DEFERRED_HOSTS).filter(([, d]) => !d.reason.trim() || !d.blocker.trim()).map(([k]) => k)).toEqual([]);
  });

  test('the discovery is live (each source finds positions, and the known connector hosts among them)', () => {
    // A discovery that silently found nothing would pass the totality test vacuously.
    expect(grammar.size).toBeGreaterThan(20);
    expect(corpus.size).toBeGreaterThan(20);
    for (const h of ['where', 'map', 'union', 'coalesce']) expect(grammar.has(h)).toBe(true);
    for (const h of ['order.by', 'project.by', 'repeat', 'sideEffect']) expect(corpus.has(h)).toBe(true);
  });
});
