// Read the addendum `.feature` files with the REAL Gherkin parser, and map each scenario onto what
// L4 needs to run it.
//
// This replaces a hand-rolled line-based reader. That reader was ~90 lines of regex that re-derived
// Gherkin badly: it tracked tags across two nested loops (and silently dropped every scenario-level
// tag but the first until that was found the hard way), it could not see `Background:` or
// `Scenario Outline:` at all, and its failure mode for a step it had not been taught was either a
// thrown "extend parseFeature" or — worse, before that throw was added — an unrecognized assertion
// compared against an EMPTY table, which is a test that cannot fail.
//
// ── Pickles, not the raw AST ──────────────────────────────────────────────────────────────────────
//
// `compile()` turns a GherkinDocument into PICKLES: one per executable scenario, with `Background`
// steps prepended, `Scenario Outline` examples expanded into concrete scenarios with placeholders
// substituted, and feature-level tags propagated down. So those constructs work here the moment
// someone writes one, rather than the reader being the thing that decides what Gherkin we may author.
// That matters because these features exist to be HARVESTED upstream — they have to be able to look
// like upstream's, and upstream uses outlines.
//
// Cucumber's own parser is used, from the submodule, for the reason in `test/support/cucumber.ts`:
// one instance, and no new dependency.
//
// A pickle step has no Given/When/Then keyword — cucumber matches on step TEXT, and so do we. Any
// step this file cannot map is a THROW naming the step, which is the property worth keeping from the
// old reader: an unmapped step must never read as a passing scenario.

import { readdirSync, readFileSync } from 'node:fs';
// Deep paths into the submodule's install, and they are deliberately the built entry points each
// package's own `main`/`exports` names: `@cucumber/gherkin` has no `exports` map (so `dist/src`) and
// `@cucumber/messages` publishes dual builds (so the ESM one).
import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from '../../vendor/tinkerpop/gremlin-js/node_modules/@cucumber/gherkin/dist/src/index.js';
import { IdGenerator } from '../../vendor/tinkerpop/gremlin-js/node_modules/@cucumber/messages/dist/esm/src/index.js';

const ADDENDUM = new URL('./', import.meta.url).pathname;

/** How the `| result |` table is compared against what the traversal produced. See the table in
 *  l4.test.ts for what each one asserts. */
export type Assertion = 'unordered' | 'ordered' | 'empty' | 'count' | 'of' | 'error';

export interface Scenario {
  feature: string;
  name: string;
  graph: string;
  /** `And the graph initializer of` — write traversals run before the scenario's own. */
  initializer: string | null;
  gremlin: string;
  assertion: Assertion;
  /** `Then the result should have a count of N`. */
  count: number | null;
  /** `Then the traversal will raise an error [with message <containing|starting|ending> text of "…"]`.
   *  Upstream compares case-INSENSITIVELY, and so do we. `null` text = any error will do. */
  error: { comparison: 'containing' | 'starting' | 'ending'; text: string } | null;
  /** `@Unsupported` — the compiler does not lower this traversal yet.
   *
   *  The scenario is KEPT, not deleted, and that is the whole point of the tag: each one encodes a
   *  reference-derived expectation that took work to establish, and deleting it would burn that to
   *  make a build green. What it asserts instead is the fail-closed contract — the traversal must
   *  REFUSE, never answer something plausible — and the day the shape lands the refusal stops and the
   *  tag comes off. The count is printed on every run so the population stays visible rather than
   *  becoming a quiet exclusion list. */
  unsupported: boolean;
  /** `@RelIR` — this scenario's ANSWER needs the RelIR spine and the legacy one refuses it. Not a
   *  skip: it says the two routes DIVERGE and which way round, so `test:legacy-spine` can assert the
   *  refusal instead of reading a deliberate improvement as a regression. */
  /** `@SpineRel` / `@SpineLegacy` — PIN this scenario's spine, ignoring the ambient switch.
   *
   *  A THIRD way for the two routes to diverge, and the one `@RelIR` cannot express: legacy neither
   *  refuses nor agrees, it ANSWERS DIFFERENTLY — and by §14's decision (legacy is what §8 deletes)
   *  that difference is accepted rather than fixed. `@RelIR` asserts a THROW under
   *  `test:legacy-spine`, which is simply false here, and a bare skip would stop asserting the
   *  scenario in one configuration for no reason: the answer under test is not a property of the
   *  ambient switch at all.
   *
   *  So pin it, which is `mise.toml`'s existing rule for an L2 test that pins a spine's SPELLING —
   *  "asserting BOTH forms rather than whichever the ambient switch produced" — applied to an
   *  end-to-end scenario. The assertion then runs identically in both configurations. Legacy's actual
   *  answer is not lost: the census records it per corpus traversal in its `lms` column.
   *
   *  Both directions exist because a legacy-pinned scenario costs nothing to support and the one-sided
   *  version would be a vocabulary that has to be widened the first time it is needed. */
  expected: string[];
  /** `And the graph should return N for count of "<traversal>"` — upstream's own Then-step for
   *  asserting GRAPH STATE after a write, the only thing that can catch a write that ran and left the
   *  graph wrong. Several per scenario; each runs against the post-traversal store. */
  graphChecks: { gremlin: string; count: number }[];
}

/** A docstring's body as the old reader produced it: every line trimmed, joined with one space. The
 *  traversals are authored across lines for readability and must reach the parser as one line. */
const oneLine = (content: string) => content.split('\n').map((l) => l.trim()).join(' ').trim();

/** Upstream writes an embedded traversal as a double-quoted step argument with its own quotes
 *  backslash-escaped, so unescaping is part of reading the step, not a courtesy. */
const unescape = (s: string) => s.replace(/\\"/g, '"');

interface PickleStep {
  text: string;
  argument?: {
    docString?: { content: string };
    dataTable?: { rows: { cells: { value: string }[] }[] };
  };
}

function toScenario(feature: string, name: string, tags: readonly string[], steps: readonly PickleStep[]): Scenario {
  const s: Scenario = {
    feature, name, graph: 'empty', initializer: null, gremlin: '',
    assertion: 'unordered', count: null, error: null, expected: [], graphChecks: [],
    unsupported: tags.includes('@Unsupported'),
  };
  // The routing the official runner does (`feature-steps.js`): a @MultiLabel scenario's EMPTY graph
  // is the multi-label source, not the plain one. Mirrored so a scenario can be copied in with its
  // `Given the empty graph` intact.
  const multiLabel = tags.includes('@MultiLabel');
  // Which docstring we are reading — a scenario may carry an initializer AND a traversal, so the
  // owning step decides, not the order of appearance.
  let docTarget: 'gremlin' | 'initializer' = 'gremlin';

  for (const step of steps) {
    const text = step.text.trim();
    const doc = step.argument?.docString?.content;
    const table = step.argument?.dataTable;

    const graph = text.match(/^(?:the|an?)\s+(\w+)\s+graph$/);
    if (graph) { s.graph = multiLabel && graph[1] === 'empty' ? 'multilabel' : graph[1]; continue; }

    if (text === 'the graph initializer of') { docTarget = 'initializer'; }
    else if (text === 'the traversal of') { docTarget = 'gremlin'; }
    else if (text === 'iterated to list' || text === 'iterated next') {
      // Upstream's When-steps. L4 executes the traversal itself and always reads every result, so
      // these carry no extra meaning here — but they must be ACCEPTED, because a harvested scenario
      // will have one and rejecting it would force our features to diverge from upstream's shape.
      continue;
    }
    else {
      const gc = text.match(/^the\s+graph\s+should\s+return\s+(\d+)\s+for\s+count\s+of\s+"(.*)"$/);
      if (gc) { s.graphChecks.push({ count: Number(gc[1]), gremlin: unescape(gc[2]) }); continue; }

      const err = text.match(/^the\s+traversal\s+will\s+raise\s+an\s+error(?:\s+with\s+message\s+(containing|starting|ending)\s+text\s+of\s+"(.*)")?$/);
      if (err) {
        s.assertion = 'error';
        s.error = err[1] ? { comparison: err[1] as 'containing' | 'starting' | 'ending', text: unescape(err[2]) } : null;
        continue;
      }

      const cnt = text.match(/^the\s+result\s+should\s+have\s+a\s+count\s+of\s+(\d+)$/);
      if (cnt) { s.assertion = 'count'; s.count = Number(cnt[1]); }
      else if (text === 'the result should be unordered') s.assertion = 'unordered';
      else if (text === 'the result should be ordered') s.assertion = 'ordered';
      else if (text === 'the result should be empty') s.assertion = 'empty';
      // `should be of` may FOLLOW a count (upstream pairs them to pin a legitimately ambiguous
      // answer), so it wins the assertion slot while `count` survives as an extra check.
      else if (text === 'the result should be of') s.assertion = 'of';
      else throw new Error(`${feature} / ${name}: unsupported step "${text}" (extend test/L4-addendum/read-features.ts)`);
    }

    if (doc !== undefined) {
      if (docTarget === 'initializer') s.initializer = oneLine(doc); else s.gremlin = oneLine(doc);
    }
    if (table) {
      for (const row of table.rows) {
        const cell = row.cells[0]?.value?.trim() ?? '';
        if (cell !== 'result') s.expected.push(cell);
      }
    }
  }
  return s;
}

/** Every scenario in `test/L4-addendum/*.feature`, in filename order. */
export function loadScenarios(): Scenario[] {
  const newId = IdGenerator.incrementing();
  const out: Scenario[] = [];
  for (const file of readdirSync(ADDENDUM).filter((f) => f.endsWith('.feature')).sort()) {
    const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher());
    const doc = parser.parse(readFileSync(ADDENDUM + file, 'utf8'));
    // `compile` wants a source envelope's uri + the document; it returns one pickle per executable
    // scenario with Background merged, outlines expanded and feature tags propagated.
    for (const pickle of compile(doc, file, newId)) {
      out.push(toScenario(
        file,
        pickle.name,
        pickle.tags.map((t: { name: string }) => t.name),
        pickle.steps as unknown as PickleStep[],
      ));
    }
  }
  return out;
}
