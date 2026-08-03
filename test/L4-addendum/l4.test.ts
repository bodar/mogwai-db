// L4 — the mogwai ADDENDUM conformance suite. Our own scenarios, authored in TinkerPop's exact
// Gherkin `.feature` format (test/L4-addendum/*.feature), for VALID traversals the
// official corpus doesn't cover. Each is a combination we implemented for combinatorial
// completeness; @gap:<area> tags the family for a possible gremlin-test PR (the give-back).
//
// Unlike the official cucumber harness — which binds each scenario NAME to a pre-generated
// traversal in a vendored `gremlin.js` — L4 runs the scenario's OWN embedded Gremlin STRING
// straight through our native stack: parse → compile → SQLite → frame → GraphBinary, then
// decode the response with the real `gremlin` client `ioc` (so our extended serializers —
// BigDecimal/Char/Duration + vertex/edge props — are exercised end-to-end, both directions).
// The expected `| result |` table is parsed in TinkerPop's typed notation (d[32].i / d[1].l /
// l[…] / null). Every scenario must pass (these are OURS); a failure is named with its diff.
//
// Add a scenario: drop it into a *.feature — no code change here. Because they are
// real Gherkin, the @gap set harvests directly into an upstream PR.

import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { ZOO_SEED } from '../fixtures/seed-zoo.ts';
import { LabelCardinality } from '../../src/api.ts';
import { CREW_SEED } from '../fixtures/seed-crew.ts';
import { BigDecimal, Duration } from '../../src/gremlin/types.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import { decodeAll } from '../support/decode.ts';

// A vertex carrying one property of each type our extended GraphBinary serializers cover, so a
// `Given the typed graph` scenario can read each back and exercise serialize+decode end-to-end.
const TYPED_SEED = [
  'g.addV("typed")'
  + '.property("n", 9007199254740993L)'                          // long > 2^53 (lossless via CAST-as-text)
  + '.property("bd", 3.141592653589793238462643383279M)'          // BigDecimal beyond f64
  + '.property("du", Duration(90, 500000000))'                    // Duration (90.5s)
  + '.property("dt", datetime("2024-01-01T00:00:00Z"))'           // datetime
  + '.property("u", UUID("0263f28b-eff9-4c17-8e33-0b41c74b6d4c"))', // uuid
];

// A vertex carrying a stored MAP property (the official Map.feature @AllowMapPropertyValues
// graphs), so is(typeOf(GType.MAP)) → MapStream retype scenarios can read it back end-to-end.
const MAPDATA_SEED = [
  'g.addV("data").property("name", "test").property("m", ["a": 1, "b": 2, "c": 3])',
];

// A graph exercising tinker.search over collection + nested-JSON property values, so the
// ValueNode-aware write-path indexer (Step 6) is proven end-to-end: a list value matches via
// its toString AND via an element; a nested map value matches via a nested key/leaf.
const SEARCH_SEED = [
  'g.addV("doc").property("title", "chapter one").property("tags", ["brave", "bold"])',
  'g.addV("doc").property("title", "chapter two").property("addr", ["city": "london", "zone": "central"])',
];

const ADDENDUM = new URL('./', import.meta.url).pathname;

/** `assertion` mirrors TinkerPop's own Then-steps, because L4 features are REAL Gherkin in the
 *  official format — that is what lets a @gap family harvest straight into a gremlin-test PR, and
 *  it is why the reader grows to match upstream rather than the features being rewritten to match
 *  the reader.
 *    unordered/ordered — compare the whole multiset against the table
 *    empty             — no results
 *    count             — only the cardinality is pinned
 *    of                — every result must be ONE OF the table's rows (alternatives), which
 *                        upstream pairs with `count` when several answers are all correct
 *    error             — the traversal must THROW, optionally with a message the assertion
 *                        constrains. A refusal is a real answer here (a third of the write-path
 *                        messages belong to scenarios that pass BECAUSE they assert the throw), so
 *                        it needs to be pinnable without leaving the .feature format. */
type Assertion = 'unordered' | 'ordered' | 'empty' | 'count' | 'of' | 'error';

interface Scenario {
  feature: string; name: string; graph: string;
  /** `And the graph initializer of` — write traversals run before the scenario's own. */
  initializer: string | null;
  gremlin: string;
  assertion: Assertion;
  /** `Then the result should have a count of N`. */
  count: number | null;
  /** `Then the traversal will raise an error [with message <containing|starting|ending> text of "…"]`.
   *  Upstream compares case-INSENSITIVELY, and so do we. `null` text = any error will do. */
  error: { comparison: 'containing' | 'starting' | 'ending'; text: string } | null;
  /**
   * `@RelIR` — this scenario's ANSWER needs the RelIR spine, and the legacy one refuses it.
   *
   * Not a coverage marker and not a skip in disguise: it says the two routes DIVERGE and which way
   * round, which is the one thing `test:legacy-spine` (the differential with RelIR off) must be told
   * or it reads a deliberate improvement as a regression. Every tag here is a write shape the legacy
   * driver cannot re-enter, so the tag disappears with §8's `runWriteChainFull` rather than
   * accumulating. A scenario carrying it must never be a shape legacy answers DIFFERENTLY — that is
   * a defect, and the census is what sees it.
   */
  relirOnly: boolean;
  expected: string[];
  /** `And the graph should return N for count of "<traversal>"` — upstream's own Then-step for
   *  asserting GRAPH STATE after a write, which is the only thing that can catch a write that
   *  ran and left the graph wrong. Several per scenario; each runs against the post-traversal
   *  store. Without it a write scenario can only pin what the write RETURNED, and the returned
   *  element is a consequence of the mutation rather than the mutation itself (write-path plan,
   *  trap 4). */
  graphChecks: { gremlin: string; count: number }[];
}

// A minimal Gherkin reader for our own feature files: name + `Given the X graph` + the
// `the traversal of """…"""` docstring + the `| result |` table. Deliberately tiny — it only
// has to read the subset we author, not the full Gherkin grammar.
function parseFeature(featureName: string, text: string): Scenario[] {
  const lines = text.split('\n');
  const out: Scenario[] = [];
  // Tags accumulate onto the next Scenario (or onto the Feature, in which case they apply to all).
  let featureTags = '', pending = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.startsWith('@')) { pending += raw + ' '; continue; }
    if (raw.startsWith('Feature:')) { featureTags = pending; pending = ''; continue; }
    const m = raw.match(/^Scenario:\s*(.+)$/);
    if (!m) { if (raw) pending = ''; continue; }
    const tags = featureTags + pending; pending = '';
    const s: Scenario = {
      feature: featureName, name: m[1].trim(), graph: 'empty',
      initializer: null, gremlin: '', assertion: 'unordered', count: null, expected: [], graphChecks: [], error: null,
      relirOnly: /@RelIR\b/.test(tags),
    };
    // The routing the official runner does (`feature-steps.js`): a @MultiLabel scenario's EMPTY
    // graph is the multi-label source, not the plain one. Mirrored here so a scenario can be
    // copied in with its `Given the empty graph` intact.
    const multiLabel = /@MultiLabel\b/.test(tags);
    // Which docstring we are reading — a scenario may carry an initializer AND a traversal, so the
    // preceding step line decides, not the order of appearance.
    let docTarget: 'gremlin' | 'initializer' = 'gremlin';
    for (i++; i < lines.length && !/^\s*Scenario:/.test(lines[i]); i++) {
      const l = lines[i].trim();
      // A TAG here belongs to the NEXT scenario, and this loop is the only reader that reaches it —
      // so it has to hand it on. Without this every scenario-level tag but the FIRST file's-first
      // one was silently dropped: the outer loop never sees these lines, and `pending` arrived
      // empty. Nothing noticed because `@gap:` is documentation and `@MultiLabel` is a FEATURE tag,
      // read before any scenario; a tag that CHANGES behaviour is what made it visible.
      if (l.startsWith('@')) { pending += l + ' '; continue; }
      const g = l.match(/^(?:Given|And)\s+(?:the|an?)\s+(\w+)\s+graph$/);
      if (g) s.graph = multiLabel && g[1] === 'empty' ? 'multilabel' : g[1];
      if (/^(?:Given|And)\s+the\s+graph\s+initializer\s+of$/.test(l)) docTarget = 'initializer';
      else if (/^(?:Given|And)\s+the\s+traversal\s+of$/.test(l)) docTarget = 'gremlin';
      // Upstream writes the traversal as a double-quoted string with its own quotes backslash-
      // escaped, so unescaping is part of reading the step, not a courtesy.
      const gc = l.match(/^(?:Then|And)\s+the\s+graph\s+should\s+return\s+(\d+)\s+for\s+count\s+of\s+"(.*)"$/);
      if (gc) { s.graphChecks.push({ count: Number(gc[1]), gremlin: gc[2].replace(/\\"/g, '"') }); continue; }
      const err = l.match(/^(?:Then|And)\s+the\s+traversal\s+will\s+raise\s+an\s+error(?:\s+with\s+message\s+(containing|starting|ending)\s+text\s+of\s+"(.*)")?$/);
      if (err) {
        s.assertion = 'error';
        s.error = err[1] ? { comparison: err[1] as 'containing' | 'starting' | 'ending', text: err[2].replace(/\\"/g, '"') } : null;
        continue;
      }
      const cnt = l.match(/^(?:Then|And)\s+the\s+result\s+should\s+have\s+a\s+count\s+of\s+(\d+)$/);
      if (cnt) { s.assertion = 'count'; s.count = Number(cnt[1]); }
      else if (/^(?:Then|And)\s+the\s+result\s+should\s+be\s+unordered$/.test(l)) s.assertion = 'unordered';
      else if (/^(?:Then|And)\s+the\s+result\s+should\s+be\s+ordered$/.test(l)) s.assertion = 'ordered';
      else if (/^(?:Then|And)\s+the\s+result\s+should\s+be\s+empty$/.test(l)) s.assertion = 'empty';
      // `should be of` may FOLLOW a count (upstream pairs them), so it wins the assertion slot
      // while `count` survives as an extra check.
      else if (/^(?:Then|And)\s+the\s+result\s+should\s+be\s+of$/.test(l)) s.assertion = 'of';
      // Fail loudly on a Then we do not implement. Silently ignoring one used to mean an
      // unrecognized assertion compared against an EMPTY table — a test that cannot fail.
      else if (/^Then\s/.test(l)) throw new Error(`${featureName}: unsupported step "${l}" (extend parseFeature)`);
      if (l === '"""') {
        const body: string[] = [];
        for (i++; i < lines.length && lines[i].trim() !== '"""'; i++) body.push(lines[i].trim());
        if (docTarget === 'initializer') s.initializer = body.join(' '); else s.gremlin = body.join(' ');
      } else if (l.startsWith('|')) {
        const cell = l.replace(/^\|/, '').replace(/\|$/, '').trim();
        if (cell !== 'result') s.expected.push(cell);
      }
    }
    i--; // the inner loop stepped onto the next Scenario line; let the outer loop see it
    out.push(s);
  }
  return out;
}

// TinkerPop typed-result notation → the SAME canonical key `canon()` produces for the decoded
// value, so expected and actual compare directly. Numbers: d[n].i/.d/.f/.b/.s → number,
// d[n].l/.n → long/bigint (BigInt); bd[…] BigDecimal, dt[…] datetime, du[…] Duration (our
// nanos toString); l[…]/s[…] list/set (ordered within); null; anything else → a bare string.
// A parsed `m[…]` map (or nested leaf) → the SAME canonical key canon() yields for a decoded
// Map: string leaves reuse the typed notation (expectedCanon), arrays stay ordered, nested
// objects sort by entry. Mirrors the official parseMapValue recursion.
function canonMapExpected(v: unknown, refs?: ReadonlyMap<string, unknown>): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return expectedCanon(v, refs);
  if (Array.isArray(v)) return '[' + v.map((x) => canonMapExpected(x, refs)).join(',') + ']';
  if (typeof v === 'object')
    return 'm{' + Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => expectedCanon(k, refs) + '=' + canonMapExpected(x, refs)).sort().join(',') + '}';
  return 'N' + v;
}

function expectedCanon(tok: string, refs?: ReadonlyMap<string, unknown>): string {
  const t = tok.trim();
  if (t === 'null') return 'null';
  // v[marko].id — an element reference, resolved against the seeded store by the caller.
  if (refs?.has(t)) return canon(refs.get(t));
  // v[marko] — the ELEMENT itself, not its id. Canonicalizes to the same `E<id>` a decoded vertex
  // does, because upstream compares element results by identity. Vertices only: `elementRefs`
  // caches by the `name` property, which edges in these fixtures do not carry.
  const vref = t.match(/^v\[(.+)\]$/);
  if (vref && refs?.has(`v[${vref[1]}].id`)) return 'E' + String(refs.get(`v[${vref[1]}].id`));
  // Match the JS client's actual GraphBinary decode: a bigint (`.n`, BigInteger 0x23) is ALWAYS a
  // JS BigInt; a long (`.l`, Int64 0x02) decodes to a Number within ±2^53 and a BigInt beyond
  // (the client's Long deserializer is magnitude-dependent) — so count()/groupCount() longs, which
  // are small, compare as Numbers, exactly as TinkerPop's own harness (parseFloat) treats `.l`.
  // int/double/float/byte/short → number.
  const num = t.match(/^d\[(-?[\d.eE+]+)\]\.([bsilfnd])$/);
  if (num) {
    if (num[2] === 'n') return 'L' + BigInt(num[1]).toString();
    if (num[2] === 'l') {
      const b = BigInt(num[1]);
      return b >= -9007199254740991n && b <= 9007199254740991n ? 'N' + Number(b) : 'L' + b.toString();
    }
    return 'N' + Number(num[1]);
  }
  const bd = t.match(/^bd\[(.+)\]$/); if (bd) return 'BD' + bd[1];
  const dt = t.match(/^dt\[(.+)\]$/); if (dt) return 'DT' + new Date(dt[1]).toISOString();
  const du = t.match(/^du\[(.+)\]$/); if (du) return 'DU' + du[1];
  // A SET compares unordered (sorted); a LIST keeps its written order.
  if (t.startsWith('s[') && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return 's[' + (inner === '' ? '' : splitTopLevel(inner).map((x) => expectedCanon(x, refs)).sort().join(',')) + ']';
  }
  if (t.startsWith('l[') && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return '[' + (inner === '' ? '' : splitTopLevel(inner).map((x) => expectedCanon(x, refs)).join(',')) + ']';
  }
  // t[id] / t[label] — a T token in a map key position.
  const ttok = t.match(/^t\[(\w+)\]$/); if (ttok) return 'T' + ttok[1];
  // p[…] — a Path, framed by its ordered objects (each in typed notation).
  if (t.startsWith('p[') && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return 'p[' + (inner === '' ? '' : splitTopLevel(inner).map((x) => expectedCanon(x, refs)).join(',')) + ']';
  }
  // m[{…}] — a Map (JSON object; values in typed-string notation, mirrors the official
  // parseMapValue). Same canonical form as canon() of a decoded Map so the two compare.
  if (t.startsWith('m[') && t.endsWith(']')) return canonMapExpected(JSON.parse(t.slice(2, -1)), refs);
  return 'S' + t;
}

// Split a comma list, not descending into nested […] brackets.
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') depth--;
    else if (s[i] === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

// A canonical, type-aware key so results compare unordered while lists stay ordered within.
function canon(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return 'L' + v.toString();
  if (typeof v === 'number') return 'N' + v;
  if (typeof v === 'string') return 'S' + v;
  if (v instanceof BigDecimal) return 'BD' + v.toString();
  if (v instanceof Duration) return 'DU' + v.toString();
  if (v instanceof Date) return 'DT' + v.toISOString();
  if (v && typeof v === 'object' && Array.isArray((v as { objects?: unknown }).objects))
    return 'p[' + (v as { objects: unknown[] }).objects.map(canon).join(',') + ']';
  // A decoded Map (group()/project()/valueMap() etc.) — entries key-sorted so compare is
  // unordered by key, each key+value recursively canonicalized (lists stay ordered within).
  if (v instanceof Map)
    return 'm{' + [...v.entries()].map(([k, val]) => canon(k) + '=' + canon(val)).sort().join(',') + '}';
  // A SET is unordered, so it canonicalizes sorted — unlike a list, which keeps its order. This is
  // what `t[label]` frames as under the multi-label regime.
  if (v instanceof Set) return 's[' + [...v].map(canon).sort().join(',') + ']';
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  // A T token (`t[id]`/`t[label]` as a map KEY) decodes to the client's EnumValue; match the token
  // spelling the feature table uses rather than its JSON shape.
  if (v && typeof v === 'object' && (v as any).typeName === 'T' && typeof (v as any).elementName === 'string')
    return 'T' + (v as any).elementName;
  // A decoded ELEMENT compares BY ID, which is upstream's rule for `v[marko]`/`e[marko-knows->vadas]`
  // — its runner resolves the reference to a cached element and compares identity, so a label or
  // property difference is deliberately NOT part of the comparison (see outstanding-work 19, where
  // that is exactly why no corpus scenario could catch a wrong vertex label).
  const el = elementId(v);
  if (el !== null) return 'E' + String(el);
  return 'J' + JSON.stringify(v);
}

/** The id of a decoded Vertex/Edge/VertexProperty, or null for anything else. The client decodes
 *  an element to a plain object carrying `id` plus `label`; a Path carries `objects` and a Map is a
 *  real Map, so both are already claimed above and cannot be mistaken for one. */
function elementId(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { id?: unknown; label?: unknown };
  return o.id !== undefined && o.label !== undefined ? o.id : null;
}

/** A fixture is a seed AND the capability the graph declares — `multilabel`/`zoo` need
 *  ZERO_OR_MORE, everything else keeps TinkerGraph's ONE default. */
interface Fixture { seed: readonly string[]; labelCardinality?: LabelCardinality; }
const GRAPHS: Record<string, Fixture> = {
  modern: { seed: MODERN_SEED }, crew: { seed: CREW_SEED }, typed: { seed: TYPED_SEED },
  mapdata: { seed: MAPDATA_SEED }, search: { seed: SEARCH_SEED }, empty: { seed: [] },
  multilabel: { seed: [], labelCardinality: LabelCardinality.ZERO_OR_MORE },
  zoo: { seed: ZOO_SEED, labelCardinality: LabelCardinality.ZERO_OR_MORE },
};

/** Resolve upstream's element REFERENCES — `v[marko].id` is "the id of the vertex named marko".
 *  The official runner does this from a cache it builds with `g.V().group().by('name').by(tail())`;
 *  L4 reads the same thing straight off the store after seeding, so a scenario can be copied in
 *  verbatim instead of being rewritten around literal ids. */
function elementRefs(store: GraphStore): Map<string, unknown> {
  const refs = new Map<string, unknown>();
  for (const r of store.query<{ name: unknown; id: unknown }>(
    'SELECT vp.value AS name, vp.node AS id FROM vertex_properties vp WHERE vp.key = ?', ['name']))
    refs.set(`v[${String(r.name)}].id`, r.id);
  return refs;
}

function loadScenarios(): Scenario[] {
  return readdirSync(ADDENDUM)
    .filter((f) => f.endsWith('.feature'))
    .flatMap((f) => parseFeature(f, readFileSync(ADDENDUM + f, 'utf8')));
}

describe('L4 addendum — mogwai gap scenarios (real end-to-end over GraphBinary)', () => {
  const scenarios = loadScenarios();
  test('the addendum is non-empty', () => expect(scenarios.length).toBeGreaterThan(0));

  // The differential's OFF position runs the same suite through the legacy spine, so a scenario whose
  // answer only that spine's replacement can give is not a failure there — it is the divergence the
  // tag declares.
  const relirOff = process.env.MOGWAI_RELIR === '0';
  for (const s of scenarios) {
    const run = s.relirOnly && relirOff ? test.skip : test;
    run(`[${s.graph}] ${s.name}`, async () => {
      if (!(s.graph in GRAPHS)) throw new Error(`unknown graph '${s.graph}' (add its fixture to GRAPHS)`);
      const fixture = GRAPHS[s.graph];
      const store = new GraphStore(new BunSqlite(':memory:'), fixture.labelCardinality);
      for (const w of fixture.seed) executeQuery(store, w, {});
      // A scenario's own `graph initializer` runs after the fixture seed and before its traversal,
      // exactly as upstream orders them.
      if (s.initializer) executeQuery(store, s.initializer, {}, {}, standardRegistry);
      // An `error` scenario asserts the REFUSAL, so it runs the traversal expecting a throw and
      // nothing below it applies. Upstream compares the message case-insensitively; so do we.
      if (s.assertion === 'error') {
        let thrown: unknown;
        try { await decodeAll(executeQuery(store, s.gremlin, {}, {}, standardRegistry)); }
        catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(Error);
        if (s.error) {
          const msg = String((thrown as Error).message).toUpperCase();
          const want = s.error.text.toUpperCase();
          if (s.error.comparison === 'containing') expect(msg).toContain(want);
          else if (s.error.comparison === 'starting') expect(msg.startsWith(want)).toBe(true);
          else expect(msg.endsWith(want)).toBe(true);
        }
        return;
      }
      // The standard service registry is injected so call() scenarios (tinker.search / degree)
      // resolve; a non-call scenario is unaffected (it never looks a service up).
      const decoded = await decodeAll(executeQuery(store, s.gremlin, {}, {}, standardRegistry));
      const got = decoded.map(canon);
      // Element references (`v[marko].id`) resolve against the seeded store, so a scenario copied
      // in verbatim from gremlin-test needs no rewriting around literal ids.
      const refs = elementRefs(store);
      const want = s.expected.map((e) => expectedCanon(e, refs));

      if (s.count !== null) expect(got.length).toBe(s.count);
      switch (s.assertion) {
        case 'empty': expect(got).toEqual([]); break;
        // Ordered compares as written; unordered sorts BOTH sides. (`ordered` used to sort too —
        // it did not actually assert order — so this is a tightening, not just a move.)
        case 'ordered': expect(got).toEqual(want); break;
        case 'unordered': expect([...got].sort()).toEqual([...want].sort()); break;
        // `of` — every result must be one of the listed alternatives; the count (if given) is
        // already checked above, and that pair is how upstream pins a legitimately ambiguous answer.
        case 'of': for (const g of got) expect(want).toContain(g); break;
        case 'count': break; // the count above IS the assertion
        // 'error' returned above, before the traversal was run for results — TS narrows it out here.
      }
      // Graph-state checks last: they read the store the traversal just mutated.
      for (const g of s.graphChecks)
        expect(
          (await decodeAll(executeQuery(store, g.gremlin, {}, {}, standardRegistry))).length,
        ).toBe(g.count);
    });
  }
});
