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
import { ioc } from '../../src/io.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { CREW_SEED } from '../fixtures/seed-crew.ts';
import { BigDecimal, Duration } from '../../src/gremlin/types.ts';
import { standardRegistry } from '../../src/services/standard.ts';

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

interface Scenario { feature: string; name: string; graph: string; gremlin: string; expected: string[]; }

// A minimal Gherkin reader for our own feature files: name + `Given the X graph` + the
// `the traversal of """…"""` docstring + the `| result |` table. Deliberately tiny — it only
// has to read the subset we author, not the full Gherkin grammar.
function parseFeature(featureName: string, text: string): Scenario[] {
  const lines = text.split('\n');
  const out: Scenario[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^Scenario:\s*(.+)$/);
    if (!m) continue;
    const s: Scenario = { feature: featureName, name: m[1].trim(), graph: 'empty', gremlin: '', expected: [] };
    for (i++; i < lines.length && !/^\s*Scenario:/.test(lines[i]); i++) {
      const l = lines[i].trim();
      const g = l.match(/^(?:Given|And)\s+(?:the|an?)\s+(\w+)\s+graph$/);
      if (g) s.graph = g[1];
      if (l === '"""') {
        const body: string[] = [];
        for (i++; i < lines.length && lines[i].trim() !== '"""'; i++) body.push(lines[i].trim());
        s.gremlin = body.join(' ');
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
function canonMapExpected(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return expectedCanon(v);
  if (Array.isArray(v)) return '[' + v.map(canonMapExpected).join(',') + ']';
  if (typeof v === 'object')
    return 'm{' + Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => expectedCanon(k) + '=' + canonMapExpected(x)).sort().join(',') + '}';
  return 'N' + v;
}

function expectedCanon(tok: string): string {
  const t = tok.trim();
  if (t === 'null') return 'null';
  // long (`.l`)/bigint (`.n`) → BigInt; int/double/float/byte/short → number. NB the JS decode
  // repr is the client's, path-dependent (a small Long may arrive as Number, a count via
  // BigInteger as BigInt); author each scenario's notation to match its actual decode. (A
  // type-precise variant keyed on the GraphBinary type byte is a possible upgrade.)
  const num = t.match(/^d\[(-?[\d.eE+]+)\]\.([bsilfnd])$/);
  if (num) return num[2] === 'l' || num[2] === 'n' ? 'L' + BigInt(num[1]).toString() : 'N' + Number(num[1]);
  const bd = t.match(/^bd\[(.+)\]$/); if (bd) return 'BD' + bd[1];
  const dt = t.match(/^dt\[(.+)\]$/); if (dt) return 'DT' + new Date(dt[1]).toISOString();
  const du = t.match(/^du\[(.+)\]$/); if (du) return 'DU' + du[1];
  if ((t.startsWith('l[') || t.startsWith('s[')) && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return '[' + (inner === '' ? '' : splitTopLevel(inner).map(expectedCanon).join(',')) + ']';
  }
  // p[…] — a Path, framed by its ordered objects (each in typed notation).
  if (t.startsWith('p[') && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return 'p[' + (inner === '' ? '' : splitTopLevel(inner).map(expectedCanon).join(',')) + ']';
  }
  // m[{…}] — a Map (JSON object; values in typed-string notation, mirrors the official
  // parseMapValue). Same canonical form as canon() of a decoded Map so the two compare.
  if (t.startsWith('m[') && t.endsWith(']')) return canonMapExpected(JSON.parse(t.slice(2, -1)));
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
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return 'J' + JSON.stringify(v);
}

const GRAPHS: Record<string, readonly string[]> = { modern: MODERN_SEED, crew: CREW_SEED, typed: TYPED_SEED, mapdata: MAPDATA_SEED, search: SEARCH_SEED, empty: [] };

function loadScenarios(): Scenario[] {
  return readdirSync(ADDENDUM)
    .filter((f) => f.endsWith('.feature'))
    .flatMap((f) => parseFeature(f, readFileSync(ADDENDUM + f, 'utf8')));
}

describe('L4 addendum — mogwai gap scenarios (real end-to-end over GraphBinary)', () => {
  const scenarios = loadScenarios();
  test('the addendum is non-empty', () => expect(scenarios.length).toBeGreaterThan(0));

  for (const s of scenarios) {
    test(`[${s.graph}] ${s.name}`, () => {
      if (!(s.graph in GRAPHS)) throw new Error(`unknown graph '${s.graph}' (add its seed to GRAPHS)`);
      const store = new GraphStore(new BunSqlite(':memory:'));
      for (const w of GRAPHS[s.graph]) executeQuery(store, w, {});
      // The standard service registry is injected so call() scenarios (tinker.search / degree)
      // resolve; a non-call scenario is unaffected (it never looks a service up).
      const decoded = executeQuery(store, s.gremlin, {}, {}, standardRegistry).map((b: Buffer) => ioc.anySerializer.deserialize(b, true).v);
      const got = decoded.map(canon).sort();
      const want = s.expected.map(expectedCanon).sort();
      expect(got).toEqual(want);
    });
  }
});
